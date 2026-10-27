import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { TaskScheduler,plannedAt,shanghaiDate,type SchedulerDeps,type TaskContext,type TaskOutcome } from '../src/scheduler.js';
import { HostMaintenance } from '../src/host-maintenance.js';
import { mergePanelSettings,readPanelSettings } from '../src/settings.js';
import { LlmStore } from '../src/llm-store.js';

function fixture(execute?:SchedulerDeps['execute']){
 const root=mkdtempSync(tmpdir()+'/role-scheduler-'),previous=process.env.DATA_DIR;
 process.env.DATA_DIR=root;const store=new Store(root+'/workflow.sqlite');
 let at=Date.parse('2026-10-28T08:01:00+08:00'),control='running',account='test-account',mode='auto';
 const calls:string[]=[];
 const hostRoot=root+'/maintenance';mkdirSync(hostRoot+'/requests',{recursive:true});mkdirSync(hostRoot+'/results',{recursive:true});
 const deps:SchedulerDeps={account:()=>account,control:()=>control,mode:()=>mode,clock:()=>at,host:new HostMaintenance(hostRoot),execute:execute??(async id=>{calls.push(id);return {status:'completed'};})};
 const scheduler=new TaskScheduler(store,deps);
 return {root,store,scheduler,deps,calls,at:(value:number)=>{at=value;},control:(value:string)=>{control=value;},account:(value:string)=>{account=value;},mode:(value:string)=>{mode=value;},close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(root,{recursive:true,force:true});}};
}

test('默认计划按北京时间，问候和备份关闭，业务暂停不发起自动调用',async()=>{
 const f=fixture();try{
  const data=f.scheduler.list();assert.equal(data.timezone,'Asia/Shanghai');
  for(const id of ['morning-post','evening-post','backup'])assert.equal(data.tasks.find(t=>t.id===id)?.enabled,false);
  assert.equal(data.tasks.find(t=>t.id==='daily-state')?.time,'06:00');
  assert.equal(data.tasks.find(t=>t.id==='memory-summary')?.time,'03:00');
  assert.equal(data.tasks.find(t=>t.id==='health')?.intervalSeconds,300);
  f.control('paused');await f.scheduler.tick();assert.deepEqual(f.calls,[]);
  f.control('manual');await f.scheduler.tick();assert.deepEqual(f.calls,[]);
  f.control('running');await f.scheduler.tick();assert.deepEqual(f.calls,['daily-state','memory-summary']);
  await f.scheduler.tick();assert.equal(f.calls.length,2);
  assert.equal(shanghaiDate(Date.parse('2026-10-27T17:00:00Z')),'2026-10-28');
  assert.equal(plannedAt('06:00',Date.parse('2026-10-27T17:00:00Z')),Date.parse('2026-10-28T06:00:00+08:00'));
 }finally{f.close();}
});

test('手动和自动争用同一个实例，完成后重复手动不重复调用',async()=>{
 let release:()=>void=()=>{};let count=0;
 const f=fixture(async()=>{count++;await new Promise<void>(r=>{release=r;});return {status:'completed'};});
 try{
  const automatic=f.scheduler.tick();await new Promise(r=>setTimeout(r,0));
  const manual=await f.scheduler.runNow('daily-state');assert.equal(manual.status,'running');assert.equal(count,1);
  f.control('paused');release();await automatic;
  const again=await f.scheduler.runNow('daily-state');assert.equal(again.status,'completed');assert.equal(count,1);
 }finally{f.close();}
});

test('关闭任务取消未提交实例，并且修改设置不恢复暂停或覆盖别域',async()=>{
 let allow:()=>void=()=>{};let context:TaskContext|undefined;
 const f=fixture(async(_id,ctx)=>{context=ctx;await new Promise<void>(r=>{allow=r;});return {status:ctx.ensureEnabled()?'completed':'cancelled'};});
 try{
  mergePanelSettings('persona',{legacy:'原文'});
  f.control('paused');
  const run=f.scheduler.runNow('daily-state');await new Promise(r=>setTimeout(r,0));
  const saved=f.scheduler.configure('daily-state',{enabled:false},0);
  assert.equal(saved.control,'paused');assert.equal(context?.signal.aborted,true);allow();
  assert.equal((await run).status,'cancelled');
  assert.equal(readPanelSettings().persona?.legacy,'原文');
  assert.throws(()=>f.scheduler.configure('memory-summary',{time:'04:00'},0),/重新读取|其他操作/);
  assert.throws(()=>f.scheduler.configure('daily-state',{time:'25:01'}),/时间无效/);
  assert.throws(()=>f.scheduler.configure('health',{intervalSeconds:60}),/主循环间隔/);
 }finally{f.close();}
});

test('早晚安只有五分钟窗口且手动不能绕过暂停或草稿模式',async()=>{
 const f=fixture();try{
  f.scheduler.configure('morning-post',{enabled:true});
  f.at(Date.parse('2026-10-28T20:00:00+08:00'));
  const missed=await f.scheduler.runNow('morning-post');assert.equal(missed.status,'missed');assert.deepEqual(f.calls,[]);
  f.at(Date.parse('2026-10-29T08:01:00+08:00'));f.control('paused');
  await assert.rejects(f.scheduler.runNow('morning-post'),/恢复处理/);
  f.control('running');f.mode('draft');await assert.rejects(f.scheduler.runNow('morning-post'),/自动模式/);
  f.mode('auto');assert.equal((await f.scheduler.runNow('morning-post')).status,'completed');assert.deepEqual(f.calls,['morning-post']);
 }finally{f.close();}
});

test('unknown只能回查，不重生成或重发送，费用引用原流水',async()=>{
 let generated=0,lookups=0;
 const f=fixture(async()=>{generated++;return {status:'unknown',outboxId:'outbox-one',callIds:['call-one']};});
 try{
  const ledger=new LlmStore(f.store),callId=ledger.start({provider:'custom',id:'mock'},{purpose:'morning-post'});
  ledger.finish(callId,'completed',{usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3},pricingStatus:'unpriced'});
  f.deps.execute=async()=>{generated++;return {status:'unknown',outboxId:'outbox-one',callIds:[callId]};};
  f.deps.lookup=async()=>{lookups++;return {status:'completed',receipt:{id:'platform-one'}};};
  const first=await f.scheduler.runNow('morning-post');assert.equal(first.status,'unknown');
  const second=await f.scheduler.runNow('morning-post');assert.equal(second.status,'completed');assert.equal(generated,1);assert.equal(lookups,1);
  assert.equal(second.cost?.unpriced,1);assert.equal(second.cost?.costUSD,null);
  assert.equal(ledger.calls().items.length,1);
 }finally{f.close();}
});

test('重启收束旧运行，账号隔离且历史有限分页',async()=>{
 const f=fixture();try{
  await f.scheduler.runNow('daily-state');f.account('another-account');await f.scheduler.runNow('daily-state');
  const page=f.scheduler.history({taskId:'daily-state',limit:1});assert.equal(page.items.length,1);assert.ok(page.nextCursor);
  const next=f.scheduler.history({taskId:'daily-state',cursor:page.nextCursor!,limit:1});assert.equal(next.items.length,1);assert.notEqual(page.items[0].accountId,next.items[0].accountId);
  f.store.db.prepare("INSERT INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at,outbox_id) VALUES('old-send','morning-post','test-account',1,'automatic','running',1,'already-submitted')").run();
  f.store.db.prepare("INSERT INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at) VALUES('old-model','daily-state','test-account',2,'automatic','running',1)").run();
  const restarted=new TaskScheduler(f.store,f.deps);assert.equal(restarted.getRun('old-send')?.status,'unknown');assert.equal(restarted.getRun('old-model')?.status,'interrupted');
 }finally{f.close();}
});

test('宿主请求只写限定桥接，独立执行结果可在暂停时回收',async()=>{
 const f=fixture();try{
  f.control('paused');const run=await f.scheduler.runNow('backup');assert.equal(run.status,'running');
  const requestFile=readdirSync(f.root+'/maintenance/requests').find(name=>name.endsWith('.json'))!;
  const request=JSON.parse(readFileSync(f.root+'/maintenance/requests/'+requestFile,'utf8'));assert.equal(request.task,'backup');assert.equal(request.action,'run');
  assert.deepEqual(Object.keys(request).sort(),['action','id','task']);
  writeFileSync(f.root+'/maintenance/results/'+request.id+'.json',JSON.stringify({id:request.id,task:'backup',status:'completed',startedAt:100,endedAt:200,result:{integrity:'ok'}}));
  await f.scheduler.tick();assert.equal(f.scheduler.getRun(run.id)?.status,'completed');
  assert.deepEqual(f.calls,[]);
  f.scheduler.configure('backup',{enabled:true,time:'04:30'});
  assert.equal(f.scheduler.list().control,'paused');
 }finally{f.close();}
});

test('日程失败同实例等待三十分钟重试，当日最多三次自动尝试',async()=>{
 let attempts=0;
 const f=fixture(async id=>{if(id==='daily-state'){attempts++;throw new Error('模型暂不可用');}return {status:'completed'};});
 try{
  await f.scheduler.tick();const first=f.scheduler.history({taskId:'daily-state'}).items[0];assert.equal(first.status,'failed');assert.equal(attempts,1);
  f.at(Date.parse('2026-10-28T08:30:59+08:00'));await f.scheduler.tick();assert.equal(attempts,1);
  f.at(Date.parse('2026-10-28T08:31:00+08:00'));await f.scheduler.tick();assert.equal(attempts,2);
  f.at(Date.parse('2026-10-28T09:01:00+08:00'));await f.scheduler.tick();assert.equal(attempts,3);
  f.at(Date.parse('2026-10-28T10:01:00+08:00'));await f.scheduler.tick();assert.equal(attempts,3);
  const rows=f.scheduler.history({taskId:'daily-state'}).items;assert.equal(rows.length,1);assert.equal(rows[0].id,first.id);assert.equal(rows[0].attempts,3);
  f.at(Date.parse('2026-10-29T06:00:00+08:00'));await f.scheduler.tick();assert.equal(attempts,4);
 }finally{f.close();}
});

test('关闭或错过窗口的unknown任务仍回查原实例，不重新生成',async()=>{
 let generated=0,lookups=0,sourceSeen='';
 const f=fixture(async()=>{generated++;return {status:'unknown',outboxId:'frozen-outbox'};});
 try{
  f.scheduler.configure('morning-post',{enabled:true});
  const first=await f.scheduler.runNow('morning-post');assert.equal(first.status,'unknown');
  f.scheduler.configure('morning-post',{enabled:false});f.scheduler.configure('daily-state',{enabled:false});f.scheduler.configure('memory-summary',{enabled:false});
  f.at(Date.parse('2026-10-28T20:00:00+08:00'));
  f.deps.lookup=async(_run,source)=>{lookups++;sourceSeen=source??'';return {status:'completed',outboxId:'frozen-outbox',receipt:{id:'receipt-one'}};};
  f.control('paused');await f.scheduler.tick();assert.equal(lookups,0);
  f.control('running');await f.scheduler.tick();assert.equal(lookups,1);assert.equal(sourceSeen,'automatic');assert.equal(generated,1);
  assert.equal(f.scheduler.getRun(first.id)?.status,'completed');
 }finally{f.close();}
});

test('上一自动任务等待期间关闭下一任务，不使用旧计划触发模型',async()=>{
 let release:()=>void=()=>{};const calls:string[]=[];
 const f=fixture(async(id,ctx)=>{
  calls.push(id);
  if(id==='daily-state')await new Promise<void>(resolve=>{release=resolve;});
  return {status:ctx.ensureEnabled()?'completed':'cancelled'};
 });
 try{
  const tick=f.scheduler.tick();await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls,['daily-state']);
  f.scheduler.configure('memory-summary',{enabled:false});release();await tick;
  assert.deepEqual(calls,['daily-state']);assert.equal(f.scheduler.history({taskId:'memory-summary'}).items.length,0);
  const explicit=await f.scheduler.runNow('memory-summary');
  assert.equal(explicit.status,'completed');assert.deepEqual(calls,['daily-state','memory-summary']);
 }finally{f.close();}
});

test('暂停取消未提交维护后恢复可补当天，复用同一实例',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {status:calls===1?'cancelled':'completed'};});
 try{
  f.scheduler.configure('memory-summary',{enabled:false});
  await f.scheduler.tick();const first=f.scheduler.history({taskId:'daily-state'}).items[0];assert.equal(first.status,'cancelled');
  f.control('paused');await f.scheduler.tick();assert.equal(calls,1);
  f.control('running');await f.scheduler.tick();const second=f.scheduler.history({taskId:'daily-state'}).items[0];
  assert.equal(calls,2);assert.equal(second.id,first.id);assert.equal(second.status,'completed');
 }finally{f.close();}
});

test('主循环仅记录真实轮次和调用费用，下次执行使用实际nextTick不随读取漂移',async()=>{
 const f=fixture();try{
  const at=Date.parse('2026-10-28T08:01:00+08:00'),next=at+90000;
  f.deps.nextTick=()=>next;
  const run=f.scheduler.recordMainStart('round-one','test-account',at);
  assert.equal(run.status,'running');assert.equal(run.taskId,'main');assert.deepEqual(f.calls,[]);
  const ledger=new LlmStore(f.store),callId=ledger.start({provider:'custom',id:'mock'},{purpose:'reply'});
  ledger.finish(callId,'completed',{usage:{input:3,output:4,cacheRead:0,cacheWrite:0,totalTokens:7},pricingStatus:'unpriced'});
  f.at(at+1000);const ended=f.scheduler.recordMainEnd('round-one','completed',[callId]);
  assert.equal(ended?.durationMs,1000);assert.equal(ended?.cost?.unpriced,1);assert.deepEqual(ended?.callIds,[callId]);
  assert.equal(f.scheduler.list().tasks.find(t=>t.id==='main')?.lastRun?.id,'round-one');
  assert.equal(f.scheduler.list().tasks.find(t=>t.id==='main')?.nextRunAt,next);
  f.at(at+2000);assert.equal(f.scheduler.list().tasks.find(t=>t.id==='main')?.nextRunAt,next);
  assert.equal(f.scheduler.recordMainEnd('round-one','failed')?.status,'completed');
  assert.equal(f.scheduler.history({taskId:'main'}).items.length,1);assert.deepEqual(f.calls,[]);
  f.deps.nextTick=()=>0;assert.equal(f.scheduler.list().tasks.find(t=>t.id==='main')?.nextRunAt,null);
  f.control('paused');f.deps.nextTick=()=>next;assert.equal(f.scheduler.list().tasks.find(t=>t.id==='main')?.nextRunAt,null);
 }finally{f.close();}
});

test('主循环失败和重启中断均保留真实历史且不执行第二个主循环',()=>{
 const f=fixture();try{
  const at=Date.parse('2026-10-28T08:01:00+08:00');
  f.scheduler.recordMainStart('failed-round','test-account',at);f.at(at+1000);
  const failure=f.scheduler.recordMainEnd('failed-round','failed');assert.equal(failure?.status,'failed');assert.ok(failure?.error?.includes('程序日志'));
  f.scheduler.recordMainStart('interrupted-round','test-account',at+1000);
  f.at(at+2000);const restarted=new TaskScheduler(f.store,f.deps);
  assert.equal(restarted.getRun('interrupted-round')?.status,'interrupted');
  assert.equal(restarted.history({taskId:'main'}).items.length,2);assert.deepEqual(f.calls,[]);
 }finally{f.close();}
});
