import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const monitor=resolve('deploy/monitor.py');
function run(probe:string,previous?:unknown){
 const root=mkdtempSync(tmpdir()+'/role-health-monitor-');
 try{
  mkdirSync(root+'/secrets/app',{recursive:true});writeFileSync(root+'/secrets/app/ingress_key','test-ingress');
  if(previous)writeFileSync(root+'/monitor-latest.json',JSON.stringify(previous));
  const code=[
   'import importlib.util,pathlib,sys,json,datetime',
   's=importlib.util.spec_from_file_location("monitor",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
   'now=datetime.datetime(2026,10,28,4,0,tzinfo=datetime.timezone.utc)',
   'calls=[]',
   probe,
   'result=m.collect_monitor(pathlib.Path(sys.argv[2]),read_json=probe,containers=containers,certificate=certificate,now=now)',
   'print(json.dumps({"result":result,"calls":calls}))',
  ].join('\n');
  const child=spawnSync('python3',['-c',code,monitor,root],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
 }finally{rmSync(root,{recursive:true,force:true});}
}

test('宿主监控读取健康指标和活动告警，固定探针继续独立执行',()=>{
 const {result,calls}=run([
  'def probe(url,key):',
  ' calls.append(url)',
  ' assert key=="test-ingress"',
  ' return {"control":"paused","now":1793160000000,"cooldown":{}} if url.endswith("/status") else {"at":1793160000000,"metrics":[{"key":"failures","level":"error"}],"activeAlerts":[{"summary":"连续三轮失败","resolvedAt":None},{"summary":"已经恢复","resolvedAt":1}]}',
  'def containers(root):',
  ' calls.append("containers");return [{"Service":"app","State":"running","Health":"healthy"}]',
  'def certificate():',
  ' calls.append("certificate");return now.timestamp()+48*3600',
 ].join('\n'));
 assert.equal(result.healthStale,false);assert.equal(result.healthFetchedAt,'2026-10-28T04:00:00+00:00');
 assert.deepEqual(result.issues,['运行健康：连续三轮失败']);assert.equal(result.health.metrics[0].key,'failures');
 assert.deepEqual(calls,['http://127.0.0.1:8080/api/status','http://127.0.0.1:8080/api/health','containers','certificate']);
});

test('app 不可达时保留原健康快照和获取时间，仍检查容器与证书',()=>{
 const old={metrics:[{key:'stalled'}],activeAlerts:[{summary:'旧告警'}]};
 const {result,calls}=run([
  'def probe(url,key):',
  ' calls.append(url);raise TimeoutError("do-not-expose-secret")',
  'def containers(root):',
  ' calls.append("containers");return [{"Service":"browser","State":"exited","Health":""}]',
  'def certificate():',
  ' calls.append("certificate");return now.timestamp()+3*3600',
 ].join('\n'),{time:'2026-10-28T03:55:00Z',health:old,healthFetchedAt:'2026-10-28T03:50:00Z'});
 assert.equal(result.healthStale,true);assert.equal(result.healthFetchedAt,'2026-10-28T03:50:00Z');assert.deepEqual(result.health,old);
 assert.ok(result.issues.includes('面板服务不可达'));assert.ok(result.issues.includes('browser 容器未就绪'));assert.ok(result.issues.includes('证书有效期不足24小时'));
 assert.ok(calls.includes('containers'));assert.ok(calls.includes('certificate'));assert.ok(!JSON.stringify(result).includes('do-not-expose-secret'));
});

test('健康接口暂时不可达保留快照且不阻断独立停滞和退避检查',()=>{
 const {result}=run([
  'def probe(url,key):',
  ' if url.endswith("/health"): raise ValueError("not-ready")',
  ' return {"control":"running","now":1793160000000,"lastTick":1793157000000,"cooldown":{"public":1793163600000}}',
  'def containers(root): return [{"Service":"app","State":"running","Health":"healthy"}]',
  'def certificate(): return now.timestamp()+48*3600',
 ].join('\n'),{time:'2026-10-28T03:55:00Z',health:{activeAlerts:[]}});
 assert.equal(result.healthStale,true);assert.equal(result.healthFetchedAt,'2026-10-28T03:55:00Z');
 assert.ok(result.issues.includes('运行轮次超过20分钟未完成'));assert.ok(result.issues.includes('public 通道退避中'));
});

test('容器探针异常时证书仍被检查，没有旧快照时明确 stale',()=>{
 const {result,calls}=run([
  'def probe(url,key): raise TimeoutError()',
  'def containers(root): raise RuntimeError()',
  'def certificate():',
  ' calls.append("certificate");return now.timestamp()+48*3600',
 ].join('\n'));
 assert.equal(result.healthStale,true);assert.equal(result.health,undefined);assert.ok(result.issues.includes('容器状态检查失败'));
 assert.equal(result.certificate_hours_remaining,48);assert.deepEqual(calls,['certificate']);
});
