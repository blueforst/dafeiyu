import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const helper = resolve('deploy/maintenance-helper.py');
function fixture() {
  const root = mkdtempSync(tmpdir() + '/role-host-helper-');
  mkdirSync(root + '/app');
  mkdirSync(root + '/maintenance/requests', { recursive: true });
  const db = new DatabaseSync(root + '/app/workflow.sqlite');
  db.exec('CREATE TABLE evidence(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO evidence VALUES(1,\'数据保留\')');
  db.close();
  return {
    root,
    run(now = Date.parse('2026-10-28T04:00:00Z') / 1000, healthSource = false) {
      const code = 'import importlib.util,pathlib,sys; s=importlib.util.spec_from_file_location("maintenance",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); h=m.Maintenance(pathlib.Path(sys.argv[2]),float(sys.argv[3])); ' + (healthSource ? 'h.health_source()' : 'h.consume(); h.due(); h.save_plans()');
      const result = spawnSync('python3', ['-c', code, helper, root, String(now)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    },
    request(task: string, action: string, extra: Record<string, unknown> = {}, id = randomUUID()) {
      writeFileSync(root + '/maintenance/requests/' + id + '.json', JSON.stringify({ id, task, action, ...extra }));
      return id;
    },
    result(id: string) { return JSON.parse(readFileSync(root + '/maintenance/results/' + id + '.json', 'utf8')); },
    backups() { try { return readdirSync(root + '/backups').filter(f => f.endsWith('.sqlite')); } catch { return []; } },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('宿主默认关闭备份、健康每五分钟独立记录，输出不含配置正文', () => {
  const f = fixture();
  try {
    writeFileSync(f.root + '/monitor-latest.json', JSON.stringify({ time: '2026-10-28T04:00:00Z', certificate_hours_remaining: 96, status: { secret: 'private-do-not-copy' }, containers: [{ Service: 'app', State: 'running', Health: 'healthy', Image: 'private-image' }] }));
    f.run();
    assert.equal(f.backups().length, 0);
    const result = readFileSync(f.root + '/maintenance/results/health-latest.json', 'utf8');
    assert.ok(!result.includes('private-do-not-copy'));
    assert.ok(!result.includes('private-image'));
    const h = JSON.parse(result);
    assert.equal(h.result.appReachable, false);
    assert.equal(h.result.certificateHoursRemaining, 96);
    assert.ok(h.result.issues.includes('面板服务不可达'));
    const healthFiles = readdirSync(f.root + '/maintenance/results').filter(x => /^[a-f0-9-]{36}\.json$/.test(x));
    f.run();
    assert.equal(readdirSync(f.root + '/maintenance/results').filter(x => /^[a-f0-9-]{36}\.json$/.test(x)).length, healthFiles.length);
    f.run(Date.parse('2026-10-28T04:05:00Z') / 1000);
    assert.equal(readdirSync(f.root + '/maintenance/results').filter(x => /^[a-f0-9-]{36}\.json$/.test(x)).length, healthFiles.length + 1);
  } finally { f.close(); }
});

test('宿主请求拒绝任意命令、路径、任务和符号链接', () => {
  const f = fixture();
  try {
    const invalid = [f.request('shell', 'run'), f.request('backup', 'run', { command: 'touch /tmp/should-not-run' }), f.request('backup', 'run', { path: '/etc/passwd' }), f.request('backup', 'configure', { enabled: 'yes' }), f.request('health', 'configure', { enabled: true, service: 'role-cert-renew.timer' }), f.request('health', 'configure', { enabled: 'false' })];
    const linked = randomUUID();
    const external = f.root + '/external.json';
    writeFileSync(external, JSON.stringify({ id: linked, task: 'backup', action: 'run' }));
    symlinkSync(external, f.root + '/maintenance/requests/' + linked + '.json');
    f.run();
    for (const id of [...invalid, linked]) assert.equal(f.result(id).status, 'rejected');
    assert.equal(f.backups().length, 0);
    assert.ok(readFileSync(external, 'utf8').includes(linked));
  } finally { f.close(); }
});

test('宿主数据库备份通过完整性校验、UUID去重且只保留七份', () => {
  const f = fixture();
  try {
    const id = f.request('backup', 'run');
    f.run();
    assert.equal(f.result(id).status, 'completed');
    assert.equal(f.result(id).result.integrity, 'ok');
    const copy = new DatabaseSync(f.root + '/backups/' + f.backups()[0], { readOnly: true });
    assert.equal((copy.prepare('SELECT body FROM evidence').get() as any).body, '数据保留');
    copy.close();
    f.request('backup', 'run', {}, id);
    f.run();
    assert.equal(f.backups().length, 1);
    const second = f.request('backup', 'run');
    f.run();
    assert.equal(f.backups().length, 1);
    assert.equal(f.result(second).instanceId, f.result(id).instanceId);
    assert.notEqual(f.result(second).id, f.result(id).id);
    for (let i = 1; i <= 8; i++) {
      f.request('backup', 'run');
      f.run(Date.parse('2026-10-28T04:00:00Z') / 1000 + i * 86400);
    }
    assert.equal(f.backups().length, 7);
  } finally { f.close(); }
});

test('宿主开启备份只补当天一次，停机多日不回放历史', () => {
  const f = fixture();
  try {
    const id = f.request('backup', 'configure', { enabled: true, time: '02:30' });
    f.run();
    assert.equal(f.result(id).status, 'completed');
    assert.equal(f.backups().length, 1);
    f.run();
    assert.equal(f.backups().length, 1);
    f.run(Date.parse('2026-11-02T04:00:00Z') / 1000);
    assert.equal(f.backups().length, 2);
    const off = f.request('backup', 'configure', { enabled: false });
    f.run(Date.parse('2026-11-03T04:00:00Z') / 1000);
    assert.equal(f.result(off).status, 'completed');
    assert.equal(f.backups().length, 2);
  } finally { f.close(); }
});

test('宿主手动备份与自动备份共享当天实例和冻结回执', () => {
  const f = fixture();
  try {
    const manual = f.request('backup', 'run');
    f.run();
    const before = f.result(manual);
    f.request('backup', 'configure', { enabled: true, time: '02:30' });
    const other = f.request('backup', 'run');
    f.run();
    assert.equal(f.backups().length, 1);
    assert.equal(f.result(other).instanceId, before.instanceId);
    const latest = JSON.parse(readFileSync(f.root + '/maintenance/results/backup-latest.json', 'utf8'));
    assert.equal(latest.id, before.instanceId);
    assert.equal(latest.instanceId, before.instanceId);
    assert.deepEqual(f.result(other).result, before.result);
    assert.equal(f.result(other).startedAt, before.startedAt);
  } finally { f.close(); }
});

test('生产健康 adapter 只控制固定 timer，隔离环境禁止使用生产 adapter', () => {
  const f = fixture();
  try {
    const code = [
      'import importlib.util,pathlib,sys,json',
      's=importlib.util.spec_from_file_location("maintenance",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'calls=[]',
      'a=m.SystemdHealthAdapter(m.DEFAULT_ROOT,runner=lambda args,**kwargs:calls.append(args))',
      'disabled=a.set_enabled(False); enabled=a.set_enabled(True)',
      'blocked=[]',
      'try: a.set_enabled("false")',
      'except ValueError: blocked.append("string")',
      'try: m.SystemdHealthAdapter(pathlib.Path(sys.argv[2]))',
      'except ValueError: blocked.append("root")',
      'try: m.Maintenance(pathlib.Path(sys.argv[2]),health_adapter=a)',
      'except ValueError: blocked.append("adapter")',
      'h=m.Maintenance(pathlib.Path(sys.argv[2])); h.production=True; source_calls=[]; h.health_source=lambda:source_calls.append(True); h.due()',
      'print(json.dumps({"calls":calls,"blocked":blocked,"disabled":disabled,"enabled":enabled,"dueSourceCalls":source_calls}))',
    ].join('\n');
    const process = spawnSync('python3', ['-c', code, helper, f.root], { encoding: 'utf8' });
    assert.equal(process.status, 0, process.stderr);
    const result = JSON.parse(process.stdout);
    assert.deepEqual(result.calls, [['systemctl', 'disable', '--now', 'role-monitor.timer'], ['systemctl', 'enable', '--now', 'role-monitor.timer']]);
    assert.deepEqual(result.blocked, ['string', 'root', 'adapter']);
    assert.equal(result.disabled.enabled, false);
    assert.equal(result.enabled.enabled, true);
    assert.equal(result.enabled.source, 'role-monitor.timer');
    assert.deepEqual(result.dueSourceCalls, []);
    assert.ok(!JSON.stringify(result.calls).includes('role-cert'));
  } finally { f.close(); }
});

test('外部健康 source 与手动调用共享实例，关闭后不自动执行且展示模拟源', () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-28T04:00:00Z') / 1000;
    f.run(now, true);
    const source = JSON.parse(readFileSync(f.root + '/maintenance/results/health-latest.json', 'utf8'));
    const manual = f.request('health', 'run');
    f.run(now);
    assert.equal(f.result(manual).instanceId, source.instanceId);
    assert.equal(f.result(manual).startedAt, source.startedAt);
    const disabled = f.request('health', 'configure', { enabled: false });
    f.run(now);
    assert.equal(f.result(disabled).adapter.source, 'simulation');
    assert.equal(f.result(disabled).adapter.enabled, false);
    const plans = JSON.parse(readFileSync(f.root + '/maintenance/results/plans.json', 'utf8'));
    assert.equal(plans.health.source, 'simulation');
    assert.equal(plans.health.enabled, false);
    assert.equal(plans.health.adapterState, 'simulated');
    f.run(now + 300, true);
    const latest = JSON.parse(readFileSync(f.root + '/maintenance/results/health-latest.json', 'utf8'));
    assert.equal(latest.instanceId, source.instanceId);
  } finally { f.close(); }
});

test('外部健康 source 与手动请求并发时依靠实例文件锁只执行一次', async () => {
  const f = fixture();
  try {
    const code = [
      'import importlib.util,pathlib,sys,time,uuid',
      's=importlib.util.spec_from_file_location("maintenance",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'root=pathlib.Path(sys.argv[2]); h=m.Maintenance(root,1793160000)',
      'def probe():',
      '    with (root/"probe.txt").open("a") as output: output.write("executed\\n")',
      '    time.sleep(0.2)',
      '    return {"issues":[]}',
      'h.health=probe',
      'h.health_source() if sys.argv[3]=="source" else h.execute({"id":str(uuid.uuid4()),"task":"health","action":"run"})',
    ].join('\n');
    const run = (mode: string) => new Promise<void>((resolve, reject) => {
      const child = spawn('python3', ['-c', code, helper, f.root, mode]);
      let stderr = '';
      child.stderr.on('data', value => { stderr += String(value); });
      child.on('error', reject);
      child.on('close', status => status === 0 ? resolve() : reject(new Error(stderr)));
    });
    await Promise.all([run('source'), run('manual')]);
    assert.equal(readFileSync(f.root + '/probe.txt', 'utf8'), 'executed\n');
  } finally { f.close(); }
});

test('宿主回执结束时间叠加单调耗时，冻结日期夹具仍有真实持续时间',()=>{
  const f=fixture();
  try{
    const code=[
      'import importlib.util,pathlib,sys,json,time',
      's=importlib.util.spec_from_file_location("maintenance",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'h=m.Maintenance(pathlib.Path(sys.argv[2]),1793128998.0)',
      'def slow_health():',
      ' time.sleep(0.02)',
      ' return {"appReachable":False}',
      'h.health=slow_health',
      'result=h.health_source()',
      'print(json.dumps(result))',
    ].join('\n');
    const process=spawnSync('python3',['-c',code,helper,f.root],{encoding:'utf8'});
    assert.equal(process.status,0,process.stderr);
    const result=JSON.parse(process.stdout);
    assert.equal(result.status,'completed');
    assert.equal(result.startedAt,1793128998000);
    assert.ok(result.latencyMs>=15);
    assert.equal(result.endedAt,result.startedAt+result.latencyMs);
    assert.ok(result.endedAt>result.startedAt);
  }finally{f.close();}
});
