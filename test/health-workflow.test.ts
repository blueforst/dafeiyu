import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {Store} from '../src/store.js';
import {Workflow} from '../src/workflow.js';
import {Outbox} from '../src/outbox.js';
import {RuntimeHealth} from '../src/unattended-health.js';
import {TaskScheduler} from '../src/scheduler.js';
import {BrowserTransport,type Transport} from '../src/transport.js';
import {exampleConfig} from './config-fixture.js';
import type {Config,Identity,Event} from '../src/types.js';

function fixture(){
 const directory=mkdtempSync(tmpdir()+'/role-health-workflow-'),store=new Store(directory+'/workflow.sqlite'),health=new RuntimeHealth(store),outbox=new Outbox(store),config={...structuredClone(exampleConfig),mode:'auto'} as Config;
 let identity:Identity={handle:'worker',loggedIn:true,needsHuman:false},identityReads=0,collections=0,sends=0,generations=0;
 const event:Event={id:'x:101',platformId:'101',targetId:'101',channel:'public',userId:'x:alice',handle:'alice',text:'合成工作流入站',url:'https://x.com/alice/status/101',conversationId:'101',timestamp:Date.now(),timestampReliable:true};
 let events:Event[]=[];
 const transport:Transport={identity:async()=>{identityReads++;return identity;},control:async()=>{},collect:async()=>{collections++;return {events,warnings:[]};},context:async()=>'',send:async()=>{sends++;return {status:'confirmed',id:'receipt-1'};},lookup:async()=>({status:'unknown'})};
 const generator={complete:async()=>{generations++;return {text:JSON.stringify({action:'reply',text:'隔离生成的简短回复',reason:''}),input:0,output:0,cache:0};}};
 const workflow=new Workflow(store,transport,generator,()=>config);workflow.services={health,outbox};
 return {store,health,outbox,config,event,transport,workflow,identity:(value:Identity)=>{identity=value;},events:(value:Event[])=>{events=value;},counts:()=>({identityReads,collections,sends,generations}),close(){workflow.stop();store.db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('真实轮次历史连续三failed产生唯一告警，成功下一轮后恢复',()=>{
 const f=fixture();try{
  let now=Date.now();const scheduler=new TaskScheduler(f.store,{account:()=> 'worker',control:()=> 'paused',clock:()=>now,execute:async()=>{throw Error('本测试不得执行业务');}});
  for(let i=0;i<3;i++){const id='failed-'+i;scheduler.recordMainStart(id,'worker',now);now+=1000;scheduler.recordMainEnd(id,'failed');}
  const health=new RuntimeHealth(f.store,()=>now),input={accountId:'worker',control:'paused',mode:'auto'};
  let snapshot=health.evaluate(input);assert.equal(snapshot.metrics.find(metric=>metric.key==='round-failures')?.value,3);assert.equal(snapshot.metrics.find(metric=>metric.key==='round-failures')?.level,'error');const alert=snapshot.activeAlerts.find(row=>row.key==='round-failures')!;assert.ok(alert);
  now+=1000;snapshot=health.evaluate(input);assert.equal(snapshot.activeAlerts.find(row=>row.key==='round-failures')?.id,alert.id);
  scheduler.recordMainStart('recovered','worker',now);now+=1000;scheduler.recordMainEnd('recovered','completed');snapshot=health.evaluate(input);assert.equal(snapshot.metrics.find(metric=>metric.key==='round-failures')?.level,'normal');assert.ok(!snapshot.activeAlerts.some(row=>row.key==='round-failures'));assert.ok(health.alerts('worker').items.find(row=>row.id===alert.id)?.resolvedAt);
 }finally{f.close();}
});

test('受限身份立即暂停且不采集不生成不发送，显式恢复重新读取身份',async()=>{
 const f=fixture();try{
  await f.workflow.resume();f.events([f.event]);f.identity({handle:'worker',loggedIn:true,needsHuman:false,restricted:'suspended'});
  await f.workflow.tick();assert.equal(f.workflow.control(),'paused');assert.deepEqual({...f.counts(),identityReads:0},{identityReads:0,collections:0,sends:0,generations:0});assert.equal(f.health.get('worker').metrics.find(row=>row.key==='account-restricted')?.level,'error');
  const reads=f.counts().identityReads;await assert.rejects(f.workflow.resume(),/登录|验证/);assert.equal(f.counts().identityReads,reads+1);assert.equal(f.workflow.control(),'paused');assert.equal(f.counts().collections,0);
  f.identity({handle:'worker',loggedIn:true,needsHuman:false});f.events([]);await f.workflow.resume();assert.equal(f.counts().identityReads,reads+2);await f.workflow.tick();assert.equal(f.workflow.control(),'running');assert.equal(f.counts().collections,1);assert.equal(f.counts().sends,0);assert.equal(f.health.get('worker').metrics.find(row=>row.key==='account-restricted')?.level,'normal');
 }finally{f.close();}
});

test('真实Workflow硬超时中止在途提交，持久出站unknown下轮只回查',async context=>{
 context.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-28T11:00:00+08:00')});
 const f=fixture();let entered:()=>void=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;});let sends=0,lookups=0;
 try{
  f.events([f.event]);f.transport.send=async(_event,_text,_handle,options)=>{sends++;entered();await new Promise<never>((_,reject)=>{const aborted=()=>reject(options?.signal?.reason??new Error('aborted'));if(options?.signal?.aborted)aborted();else options?.signal?.addEventListener('abort',aborted,{once:true});});return {status:'unknown'};};
  f.transport.lookup=async()=>{lookups++;return {status:'unknown'};};
  await f.workflow.resume();const tick=f.workflow.tick();await started;
  const submitting=f.store.db.prepare("SELECT * FROM outbox WHERE status='submitting'").get();assert.ok(submitting);context.mock.timers.tick(12*60000);await tick;
  assert.equal(f.store.getMessage('x:101','worker')?.status,'unknown');assert.equal(f.outbox.get(String(submitting!.id))?.status,'unknown');assert.equal(f.workflow.busy,false);assert.equal(sends,1);
  await f.workflow.tick();assert.equal(sends,1);assert.equal(lookups,1);assert.equal(f.store.getMessage('x:101','worker')?.status,'unknown');
 }finally{f.close();context.mock.timers.reset();}
});

test('BrowserTransport的调用方中止信号终止卡住HTTP读取，不自行发起重试',async()=>{
 let requests=0,notify:()=>void=()=>{};const entered=new Promise<void>(resolve=>{notify=resolve;});
 const server=createServer(request=>{requests++;request.resume();notify();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const port=(server.address() as {port:number}).port,transport=new BrowserTransport('http://127.0.0.1:'+port,'synthetic-key'),abort=new AbortController(),pending=transport.collectPublic('worker',{signal:abort.signal});await entered;abort.abort();await assert.rejects(pending);assert.equal(requests,1);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
