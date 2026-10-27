#!/usr/bin/python3
"""宿主独立只读监控；app 健康数据不可用时保留带时间的旧快照。"""
import datetime
import json
import pathlib
import socket
import ssl
import subprocess
import urllib.request


DEFAULT_ROOT = pathlib.Path('/var/lib/role-workflow')
DEFAULT_SERVICE_ROOT = pathlib.Path('/srv/role-workflow')
DEFAULT_APP_URL = 'http://127.0.0.1:8080'
CERTIFICATE_HOST = '43.133.80.237'


def read_object(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def fetch_json(url, key):
    request = urllib.request.Request(url, headers={'X-Ingress-Key': key})
    with urllib.request.urlopen(request, timeout=15) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise ValueError('监控接口未返回对象')
    return value


def container_probe(service_root):
    # 固定命令，不接收来自 app、配置或健康接口的命令参数。
    process = subprocess.run(['docker', 'compose', 'ps', '--format', 'json'], cwd=service_root,
                             capture_output=True, text=True, timeout=30)
    if process.returncode:
        raise RuntimeError('无法读取 Docker Compose 容器状态')
    values = []
    for line in process.stdout.splitlines():
        if not line.strip():
            continue
        value = json.loads(line)
        values.extend(value if isinstance(value, list) else [value])
    if any(not isinstance(item, dict) for item in values):
        raise ValueError('容器状态解析失败')
    return values


def certificate_probe():
    with socket.create_connection((CERTIFICATE_HOST, 443), timeout=10) as sock:
        with ssl.create_default_context().wrap_socket(sock, server_hostname=CERTIFICATE_HOST) as connection:
            return ssl.cert_time_to_seconds(connection.getpeercert()['notAfter'])


def active_alerts(health):
    alerts = health.get('activeAlerts', health.get('alerts', []))
    if not isinstance(alerts, list):
        return []
    return [alert for alert in alerts if isinstance(alert, dict) and
            not alert.get('resolvedAt') and not alert.get('resolved_at')]


def collect_monitor(root=DEFAULT_ROOT, service_root=DEFAULT_SERVICE_ROOT, app_url=DEFAULT_APP_URL,
                    now=None, read_json=fetch_json, containers=container_probe, certificate=certificate_probe):
    """所有探针独立失败；参数注入仅供隔离测试，生产入口使用固定默认值。"""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    previous = read_object(root / 'monitor-latest.json')
    result = {'time': now.isoformat(), 'issues': [], 'containers': []}
    previous_health = previous.get('health')
    if isinstance(previous_health, dict):
        result['health'] = previous_health
        result['healthFetchedAt'] = previous.get('healthFetchedAt', previous.get('time'))
        result['healthStale'] = True
    else:
        result['healthStale'] = True
    try:
        key = (root / 'secrets/app/ingress_key').read_text().strip()
    except OSError:
        key = None
    try:
        if key is None:
            raise RuntimeError('监控认证文件不可用')
        status = read_json(app_url + '/api/status', key)
        result['status'] = status
        status_now = status.get('now', int(now.timestamp() * 1000))
        if (status.get('control') == 'running' and status.get('lastTick') and
                status_now - status['lastTick'] > 20 * 60 * 1000):
            result['issues'].append('运行轮次超过20分钟未完成')
        for channel, until in status.get('cooldown', {}).items():
            if isinstance(until, (int, float)) and until > status_now:
                result['issues'].append(str(channel)[:20] + ' 通道退避中')
    except Exception:
        # 不将异常里的 URL、认证信息或远端响应正文写进监控文件。
        result['issues'].append('面板服务不可达')
    try:
        if key is None:
            raise RuntimeError('监控认证文件不可用')
        health = read_json(app_url + '/api/health', key)
        result['health'] = health
        result['healthFetchedAt'] = result['time']
        result['healthStale'] = False
        for alert in active_alerts(health):
            summary = alert.get('summary')
            if isinstance(summary, str) and summary:
                result['issues'].append('运行健康：' + summary[:200])
    except Exception:
        result['issues'].append('运行健康接口不可达，保留上次快照')
    try:
        for item in containers(service_root):
            row = {key: item.get(key) for key in ['Service', 'Image', 'State', 'Health']}
            result['containers'].append(row)
            if row['State'] != 'running' or row['Health'] != 'healthy':
                result['issues'].append(str(row['Service'] or '未知')[:50] + ' 容器未就绪')
        if not result['containers']:
            result['issues'].append('未发现本项目容器')
    except Exception:
        result['issues'].append('容器状态检查失败')
    try:
        result['certificate_hours_remaining'] = round((certificate() - now.timestamp()) / 3600, 1)
        if result['certificate_hours_remaining'] < 24:
            result['issues'].append('证书有效期不足24小时')
    except Exception:
        result['issues'].append('证书检查失败')
    observation_path = root / 'infrastructure-observation.json'
    if observation_path.exists():
        try:
            observation = read_object(observation_path)
            started = datetime.datetime.fromisoformat(observation['startedAt'])
            observation['elapsedHours'] = round((now - started).total_seconds() / 3600, 3)
            observation['samples'] = observation.get('samples', 0) + 1
            observation['unhealthySamples'] = observation.get('unhealthySamples', 0) + bool(result['issues'])
            observation['lastCheckedAt'] = result['time']
            observation['completed'] = (observation['elapsedHours'] >= 12 and
                                        observation['samples'] >= 144 and observation['unhealthySamples'] == 0)
            observation['businessObservationStarted'] = bool(result.get('status', {}).get('observationStartedAt'))
            observation_path.write_text(json.dumps(observation, ensure_ascii=False, indent=2))
            result['observation'] = observation
        except Exception:
            result['issues'].append('基础设施观察记录更新失败')
    return result


def main():
    result = collect_monitor()
    output = DEFAULT_ROOT / 'monitor-latest.json'
    temporary = output.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    temporary.replace(output)
    if result['issues']:
        print(json.dumps(result['issues'], ensure_ascii=False))


if __name__ == '__main__':
    main()
