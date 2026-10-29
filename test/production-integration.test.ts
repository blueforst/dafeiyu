import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Program } from '../src/program.js';
import { Outbox } from '../src/outbox.js';
import { PersonaService } from '../src/persona.js';
import { MemoryService } from '../src/memory.js';
import { DailyStateService,shanghaiDate } from '../src/daily-state.js';
import { TaskScheduler } from '../src/scheduler.js';
import { productionTaskHandlers } from '../src/production-tasks.js';
import { exampleConfig } from './config-fixture.js';
import type { Config,Event,Receipt } from '../src/types.js';
import type { Transport } from '../src/transport.js';

function fixture(){
 const root=mkdtempSync(tmpdir()+'/production-integration-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=root;
 const store=new Store(root+'/workflow.sqlite'),c=structuredClone(exampleConfig) as Config;c.mode='auto';
 const event:Event={id:'x:100',platformId:'100',targetId:'100',channel:'public',userId:'x:alice',handle:'alice',text:'你好',url:'https://x.com/alice/status/100',conversationId:'100',timestamp:Date.now(),timestampReliable:true};
 let events=[event],sends=0,posts=0,generations=0,postReceipt:Receipt={status:'unknown'},lookupReceipt:Receipt={status:'unknown'};
 const transport:Transport={identity:async()=>({loggedIn:true,needsHuman:false,handle:'staging_bot'}),control:async()=>{},collect:async()=>({events,warnings:[]}),context:async()=>'',send:async()=>{sends++;return {status:'confirmed',id:'200'};},lookup:async()=>lookupReceipt,post:async()=>{posts++;return postReceipt;},lookupPost:async()=>lookupReceipt};
 const generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async()=>{generations++;return {text:JSON.stringify({action:'reply',text:'你好，今天愉快。',reason:''}),input:8,output:8,cache:0};}};
 const workflow=new Workflow(store,transport,generator,()=>c),program=new Program(store),outbox=new Outbox(store),persona=new PersonaService(store,generator,()=>c),memory=new MemoryService(store,generator,()=>c),daily=new DailyStateService(store,generator,()=>c);
 daily.edit('staging_bot',shanghaiDate(),{date:shanghaiDate(),fictional:true,periods:[{start:'08:00',end:'09:00',activity:'虚构阅读'}],meals:{breakfast:'面包',lunch:'米饭',dinner:'蔬菜'},activities:['阅读'],mood:'平静'},0);
 workflow.services={program,outbox,persona,memory,daily};
 const scheduler=new TaskScheduler(store,{account:()=>workflow.accountId(),control:()=>workflow.control(),mode:()=>c.mode,...productionTaskHandlers(workflow)});workflow.services.scheduler=scheduler;
 return {store,c,event,transport,workflow,program,outbox,scheduler,counts:()=>({sends,posts,generations}),events:(value:Event[])=>events=value,receipts:(post:Receipt,lookup:Receipt)=>{postReceipt=post;lookupReceipt=lookup;},close:()=>{workflow.stop();store.db.close();rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}};
}
test('完整工作流按账号生成、先记出站、确认一次并收束所有阶段',async()=>{
 const f=fixture();try{
  f.store.ingest({...f.event,id:'x:legacy'});await f.workflow.resume();await f.workflow.tick();await f.workflow.tick();
  assert.equal(f.counts().sends,1);assert.equal(f.store.getMessage('x:100','staging_bot').status,'confirmed');assert.equal(f.store.getMessage('x:legacy').status,'queued');
  const row=f.outbox.source('staging_bot','reply',f.store.getMessage('x:100','staging_bot').id)!;assert.equal(row.status,'confirmed');assert.ok(row.submitted_at);
  assert.ok(f.program.list().some(s=>s.name==='generation'));assert.ok(f.program.list().every(s=>s.status!=='running'));
  assert.ok(!JSON.stringify(f.store.logs()).includes(f.event.text));assert.equal(f.workflow.busy,false);
 }finally{f.close();}
});
test('真实出站缺平台标识时仅保留草稿，控制失败可重新尝试',async()=>{
 const f=fixture();try{
  f.events([{...f.event,platformId:undefined}]);await f.workflow.resume();await f.workflow.tick();assert.equal(f.counts().sends,0);assert.equal(f.store.getMessage('x:100','staging_bot').status,'draft');
  f.transport.control=async()=>{throw new Error('模拟浏览器不可达');};await assert.rejects(f.workflow.takeover());assert.equal(f.workflow.control(),'paused');assert.equal(f.workflow.busy,false);
  f.transport.control=async()=>{};await f.workflow.takeover();assert.equal(f.workflow.control(),'manual');await f.workflow.release();assert.equal(f.workflow.control(),'paused');
 }finally{f.close();}
});
test('问候unknown关闭后仍从同一出站回查，任务与消息共用公开额度',async()=>{
 const f=fixture();try{
  f.events([]);await f.workflow.resume();const time=new Date(Date.now()+8*3600000).toISOString().slice(11,16);
  f.scheduler.configure('morning-post',{enabled:true,time});const first=await f.scheduler.runNow('morning-post');assert.equal(first.status,'unknown');assert.equal(f.counts().posts,1);
  f.scheduler.configure('morning-post',{enabled:false});f.receipts({status:'unknown'},{status:'confirmed',id:'post-300'});
  await f.workflow.tick();assert.equal(f.scheduler.getRun(first.id)?.status,'completed');assert.equal(f.counts().posts,1);
  const used=f.counts().generations;f.c.publicPerHour=1;f.events([f.event]);await f.workflow.tick();assert.equal(f.counts().sends,0);assert.equal(f.counts().generations,used);assert.equal(f.workflow.sentCount('public'),1);
 }finally{f.close();}
});
test('接管中止生成后阶段收束，进程重启将遗留阶段标为中断',async()=>{
 const f=fixture();let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 f.workflow.generator.complete=async(_c,_system,_user,signal)=>{started();await new Promise((resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('取消')),{once:true}));throw new Error('unreachable');};
 try{
  await f.workflow.resume();const running=f.workflow.tick();await ready;await f.workflow.takeover();await running;
  assert.equal(f.counts().sends,0);assert.equal(f.workflow.control(),'manual');assert.ok(f.program.list().some(s=>s.name==='generation'&&s.status==='aborted'));assert.ok(f.program.list().every(s=>s.status!=='running'));
  const old=f.program.begin('generation',{roundId:'interrupted-round'});new Program(f.store).recover();assert.equal(f.program.list().find(s=>s.id===old)?.status,'interrupted');assert.equal(f.workflow.busy,false);
 }finally{f.close();}
});
