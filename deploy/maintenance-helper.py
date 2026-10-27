#!/usr/bin/python3
"""宿主固定任务桥接。请求内容不作为命令、路径或 shell 输入。"""
import argparse
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import time
import uuid
from zoneinfo import ZoneInfo

DEFAULT_ROOT = Path('/var/lib/role-workflow')
MONITOR = Path('/srv/role-workflow/deploy/monitor.py')
TZ = ZoneInfo('Asia/Shanghai')
LIMIT = 4096


class SimulationHealthAdapter:
    """隔离环境不操作宿主生产 unit。"""
    source = 'simulation'

    def set_enabled(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError('enabled 必须为布尔值')
        return {'enabled': enabled, 'source': self.source, 'state': 'simulated'}


class SystemdHealthAdapter:
    """仅生产根目录可用；unit 名与命令参数均固定。"""
    source = 'role-monitor.timer'

    def __init__(self, root, runner=None):
        if Path(root) != DEFAULT_ROOT:
            raise ValueError('隔离环境禁止操作生产健康 timer')
        self.runner = subprocess.run if runner is None else runner

    def set_enabled(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError('enabled 必须为布尔值')
        command = ['systemctl', 'enable', '--now', 'role-monitor.timer'] if enabled else ['systemctl', 'disable', '--now', 'role-monitor.timer']
        self.runner(command, check=True, capture_output=True, text=True, timeout=30)
        return {'enabled': enabled, 'source': self.source, 'state': 'applied'}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    descriptor = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o640)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(value, output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def read_json(path, fallback):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 131072:
            return fallback
        with path.open() as source:
            value = json.load(source)
        return value
    except (OSError, ValueError):
        return fallback


def identifier(value):
    if not isinstance(value, str):
        raise ValueError('请求 ID 必须为 UUID')
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        raise ValueError('请求 ID 必须为 UUID') from None
    if str(parsed) != value:
        raise ValueError('请求 ID 必须为规范 UUID')
    return value


def validate(request, filename):
    if not isinstance(request, dict):
        raise ValueError('请求必须为对象')
    if set(request) - {'id', 'task', 'action', 'enabled', 'time'}:
        raise ValueError('请求包含不支持的字段')
    identifier(request.get('id'))
    if request['id'] != filename:
        raise ValueError('请求 ID 与文件名不符')
    if request.get('task') not in ('backup', 'health'):
        raise ValueError('任务不在允许范围')
    if request.get('action') not in ('run', 'configure'):
        raise ValueError('操作不在允许范围')
    if request['action'] == 'run' and set(request) != {'id', 'task', 'action'}:
        raise ValueError('单次执行不接受计划字段')
    if request['action'] == 'configure':
        if 'enabled' not in request and 'time' not in request:
            raise ValueError('缺少计划字段')
        if 'enabled' in request and not isinstance(request['enabled'], bool):
            raise ValueError('enabled 必须为布尔值')
        if 'time' in request:
            value = request['time']
            if request['task'] != 'backup' or not isinstance(value, str) or len(value) != 5:
                raise ValueError('只有备份支持 HH:mm 时间')
            try:
                parsed = dt.datetime.strptime(value, '%H:%M').strftime('%H:%M')
            except ValueError:
                raise ValueError('备份时间无效') from None
            if parsed != value:
                raise ValueError('备份时间无效')
    return request


class Maintenance:
    def __init__(self, root, now=None, health_adapter=None):
        self.root = root
        self.bridge = root / 'maintenance'
        self.requests = self.bridge / 'requests'
        self.results = self.bridge / 'results'
        self.now = time.time() if now is None else now
        self.date = dt.datetime.fromtimestamp(self.now, TZ)
        self.production = root == DEFAULT_ROOT
        if health_adapter is None:
            health_adapter = SystemdHealthAdapter(root) if self.production else SimulationHealthAdapter()
        if self.production and not isinstance(health_adapter, SystemdHealthAdapter):
            raise ValueError('生产健康任务必须使用固定 systemd adapter')
        if not self.production and not isinstance(health_adapter, SimulationHealthAdapter):
            raise ValueError('隔离环境强制使用模拟健康 adapter')
        self.health_adapter = health_adapter
        self.instances = self.bridge / 'instances'
        for directory in (self.bridge, self.requests, self.results, self.instances):
            directory.mkdir(parents=True, exist_ok=True)
        self.plans_path = self.bridge / 'plans.json'
        saved = read_json(self.plans_path, {})
        self.plans = {
            'backup': {'enabled': False, 'time': '02:30'},
            'health': {'enabled': True, 'intervalMinutes': 5, 'source': self.health_adapter.source,
                       'adapterState': 'unverified' if self.production else 'simulated'},
        }
        for task in ('backup', 'health'):
            if isinstance(saved, dict) and isinstance(saved.get(task), dict):
                candidate = saved[task]
                if isinstance(candidate.get('enabled'), bool):
                    self.plans[task]['enabled'] = candidate['enabled']
                if task == 'health' and isinstance(candidate.get('adapterState'), str) and candidate['adapterState'] in ('applied', 'simulated'):
                    self.plans[task]['adapterState'] = candidate['adapterState']
                if task == 'backup':
                    # 独立校验保存的计划时间，不从文件导入未知字段。
                    value = candidate.get('time', '')
                    try:
                        if isinstance(value, str) and dt.datetime.strptime(value, '%H:%M').strftime('%H:%M') == value:
                            self.plans[task]['time'] = value
                    except ValueError:
                        pass

    def save_plans(self):
        write_json(self.plans_path, self.plans)
        write_json(self.results / 'plans.json', self.plans)

    def backup(self, request_id):
        database = self.root / 'app/workflow.sqlite'
        if database.is_symlink() or not database.is_file():
            raise ValueError('业务数据库不存在或路径无效')
        backups = self.root / 'backups'
        backups.mkdir(parents=True, exist_ok=True)
        destination = backups / ('workflow-' + request_id + '.sqlite')
        # 相同 UUID 重启恢复只核验已存在的备份，不再产生另一份。
        if not destination.exists():
            temporary = destination.with_suffix('.pending')
            if temporary.is_symlink():
                raise ValueError('备份临时路径无效')
            temporary.unlink(missing_ok=True)
            source = sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True)
            target = sqlite3.connect(temporary)
            try:
                source.backup(target)
                if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('数据库备份完整性检查失败')
            finally:
                target.close()
                source.close()
            temporary.chmod(0o600)
            os.replace(temporary, destination)
        if destination.is_symlink():
            raise ValueError('备份路径无效')
        with sqlite3.connect('file:' + str(destination) + '?mode=ro', uri=True) as checked:
            if checked.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('已有备份完整性检查失败')
        existing = sorted((p for p in backups.glob('workflow-*.sqlite') if p.is_file() and not p.is_symlink()), key=lambda p: (p.stat().st_mtime_ns, p.name))
        for old in existing[:-7]:
            old.unlink()
        return {'file': destination.name, 'integrity': 'ok', 'retention': 7,
                'scope': '仅业务数据库；不含面板配置、密钥、源码、浏览器 profile 和独立遗忘账本'}

    def health(self):
        # 唯一生产五分钟来源是 role-monitor.timer -> --health-source。
        # 手工调用共享同一规范实例锁，每个新实例只执行一次既有 monitor。
        latest = self.root / 'monitor-latest.json'
        if self.production:
            subprocess.run(['/usr/bin/python3', str(MONITOR)], check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=60, cwd='/srv/role-workflow')
        monitor = read_json(latest, {})
        if not isinstance(monitor, dict):
            monitor = {}
        reachable = self.production and isinstance(monitor.get('status'), dict)
        # 原 monitor 可能带状态和配置，此处仅投影固定非敏感字段。
        certificate = monitor.get('certificate_hours_remaining')
        if not isinstance(certificate, (float, int)) or not math.isfinite(certificate):
            certificate = None
        issues = []
        if not reachable:
            issues.append('面板服务不可达')
        if certificate is None:
            issues.append('证书检查结果暂无')
        elif certificate < 24:
            issues.append('证书有效期不足24小时')
        containers = []
        for value in monitor.get('containers', []) if isinstance(monitor.get('containers'), list) else []:
            if isinstance(value, dict) and value.get('Service') in ('app', 'browser'):
                containers.append({name: str(value.get(name, ''))[:40] for name in ('Service', 'State', 'Health')})
                if value.get('State') != 'running' or value.get('Health') != 'healthy':
                    issues.append(value['Service'] + ' 容器未就绪')
        return {'appReachable': reachable, 'issues': issues, 'containers': containers,
                'certificateHoursRemaining': certificate, 'certificateRenewal': '沿用独立 role-cert-renew.timer',
                'monitorAt': monitor.get('time') if isinstance(monitor.get('time'), str) else None}

    def instance_id(self, task):
        # 手动和自动使用相同实例键；请求 UUID 只标识一次桥接请求。
        key = ('backup:' + self.date.strftime('%Y-%m-%d')) if task == 'backup' else ('health:' + str(int(self.now // 300)))
        return str(uuid.uuid5(uuid.NAMESPACE_URL, 'role-workflow:' + key))

    def execute(self, request):
        request_id = request['id']
        result_file = self.results / (request_id + '.json')
        if result_file.exists():
            return read_json(result_file, {})
        if request['action'] == 'run':
            instance_id = self.instance_id(request['task'])
            if request_id != instance_id:
                canonical = self.execute({'id': instance_id, 'task': request['task'], 'action': 'run'})
                result = {**canonical, 'id': request_id, 'instanceId': instance_id}
                write_json(result_file, result)
                return result
            descriptor = os.open(self.instances / (instance_id + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o640)
            with os.fdopen(descriptor, 'a') as instance_lock:
                fcntl.flock(instance_lock, fcntl.LOCK_EX)
                # 手动请求与 timer 不共享全局锁，必须在实例锁内重新查回执。
                if result_file.exists():
                    return read_json(result_file, {})
                return self.perform(request)
        return self.perform(request)

    def perform(self, request):
        request_id = request['id']
        result_file = self.results / (request_id + '.json')
        started = time.monotonic()
        result = {'id': request_id, 'task': request['task'], 'action': request['action'],
                  'startedAt': int(self.now * 1000)}
        if request['action'] == 'run':
            result['instanceId'] = request_id
        try:
            if request['action'] == 'configure':
                if request['task'] == 'health':
                    applied = self.health_adapter.set_enabled(request['enabled'])
                    result['adapter'] = applied
                    self.plans['health']['adapterState'] = applied['state']
                for name in ('enabled', 'time'):
                    if name in request:
                        self.plans[request['task']][name] = request[name]
                self.save_plans()
                result['plan'] = self.plans[request['task']]
            else:
                result['result'] = self.backup(request_id) if request['task'] == 'backup' else self.health()
            result['status'] = 'completed'
        except Exception:
            # 不把系统路径、请求正文或异常内可能带出的凭据写回 app。
            result['status'] = 'failed'
            result['error'] = '宿主固定任务执行失败，请检查宿主日志与数据库完整性'
        result['latencyMs'] = max(0, int((time.monotonic() - started) * 1000))
        # 以可控起点叠加真实单调耗时；不能把冻结的 self.now 当作结束时间。
        result['endedAt'] = result['startedAt'] + result['latencyMs']
        write_json(result_file, result)
        if request['action'] == 'run':
            write_json(self.results / (request['task'] + '-latest.json'), result)
        return result

    def consume(self):
        # 请求数量、单文件尺寸和本轮处理量都有界；符号链接不被跟随。
        for path in sorted(self.requests.glob('*.json'))[:100]:
            request_id = path.stem
            try:
                identifier(request_id)
            except ValueError:
                continue
            if (self.results / (request_id + '.json')).exists():
                if not path.is_symlink():
                    path.unlink(missing_ok=True)
                continue
            try:
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor) as source:
                    info = os.fstat(source.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
                        raise ValueError('请求文件无效')
                    request = validate(json.load(source), request_id)
                self.execute(request)
            except (OSError, ValueError, TypeError):
                write_json(self.results / (request_id + '.json'), {'id': request_id, 'status': 'rejected',
                           'endedAt': int(self.now * 1000), 'error': '请求格式、任务或字段不在允许范围'})
            if not path.is_symlink():
                path.unlink(missing_ok=True)

    def due(self):
        # 隔离夹具模拟外部 timer；生产此入口绝不另起健康调度源。
        if not self.production:
            self.health_source()
        if self.plans['backup']['enabled'] and self.date.strftime('%H:%M') >= self.plans['backup']['time']:
            # 只补当天；不回放停机期间的历史日期。
            self.execute({'id': self.instance_id('backup'), 'task': 'backup', 'action': 'run'})

    def health_source(self):
        if self.plans['health']['enabled']:
            return self.execute({'id': self.instance_id('health'), 'task': 'health', 'action': 'run'})
        return None


def main():
    parser = argparse.ArgumentParser(description='角色工作流宿主固定任务桥接')
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT, help='仅供独立验收夹具指定数据根目录')
    parser.add_argument('--health-source', action='store_true', help='role-monitor.timer 固定健康任务入口')
    args = parser.parse_args()
    root = args.root.resolve()
    helper = Maintenance(root)
    if args.health_source:
        # 不持有全局维护锁；与手工请求依靠规范实例文件锁去重。
        helper.health_source()
        return
    with (helper.bridge / 'helper.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        helper.consume()
        helper.due()
        helper.save_plans()


if __name__ == '__main__':
    main()
