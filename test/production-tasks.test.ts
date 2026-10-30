import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Outbox } from '../src/outbox.js';
import {UnknownReviews} from '../src/unknown-reviews.js';
import { MemoryService } from '../src/memory.js';
import { PersonaService,legacyPersona } from '../src/persona.js';
import { RoleExperienceService } from '../src/role-experiences.js';
import { TaskScheduler } from '../src/scheduler.js';
import { productionTaskHandlers } from '../src/production-tasks.js';
import { ActivityFeed } from '../src/activity-feed.js';
import type { Config } from '../src/types.js';
import type { Transport } from '../src/transport.js';
import { exampleConfig } from './config-fixture.js';

function fixture(){
 const dir=mkdtempSync(tmpdir()+'/style-production-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(dir+'/workflow.sqlite'),config={...structuredClone(exampleConfig),mode:'auto'} as Config;
 const calls:Array<{system:string;user:string;meta:any}>=[],posts:string[]=[];
 const generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async(_c:any,system:string,user:string,_signal?:AbortSignal,_session?:string,meta?:any)=>{calls.push({system,user,meta});return {text:JSON.stringify({action:'reply',text:'## 早上好\n**一起出门走走吧**',reason:''}),input:1,output:1,cache:0};}};
 const transport:Transport={identity:async()=>({handle:'worker',loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>({events:[],warnings:[]}),context:async()=>'',send:async()=>({status:'confirmed',id:'unused'}),lookup:async()=>({status:'unknown'}),post:async text=>{posts.push(text);return {status:'confirmed',id:'generated-post'};},lookupPost:async()=>({status:'unknown'})};
 const workflow=new Workflow(store,transport,generator,()=>config),outbox=new Outbox(store),memory=new MemoryService(store,generator,()=>config),persona=new PersonaService(store,generator,()=>config),experiences=new RoleExperienceService(store,()=> 'worker');
 persona.get=()=>({persona:legacyPersona('问候帖隔离角色'),revision:0,fixedRules:''});
 workflow.services={outbox,memory,persona,experiences,daily:{ensure:async()=>({status:'existing',state:{content:{fictional:true,activity:'今天去散步'}}})} as any};store.set('activeAccount','worker');
 const scheduler=new TaskScheduler(store,{account:()=>workflow.accountId(),control:()=>workflow.control(),mode:()=>config.mode,...productionTaskHandlers(workflow)}),feed=new ActivityFeed(store,()=>workflow.accountId(),()=>config.maxAgeHours);
 return {store,workflow,outbox,memory,persona,experiences,scheduler,feed,calls,posts,close(){workflow.stop();store.db.close();rmSync(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}};
}

test('早晚安帖召回确认帖子与人工经历、排除隐藏项，只加帖子提醒并照常发送格式正文',async()=>{
 for(const taskId of ['morning-post','evening-post'] as const){const f=fixture();try{
  f.memory.recordExperience({accountId:'worker',userId:'role',channel:'public',kind:'post',text:'前两天发过的独特开头',receipt:{status:'confirmed',id:'old-visible'}});
  const hidden=f.memory.recordExperience({accountId:'worker',userId:'role',channel:'public',kind:'post',text:'已经隐藏的帖子原文',receipt:{status:'confirmed',id:'old-hidden'}});
  const hiddenItem=f.experiences.list().items.find(item=>item.id===hidden.id)!;f.experiences.setHidden(hiddenItem.id,true,hiddenItem.revision);
  f.memory.recordExperience({accountId:'other',userId:'role',channel:'public',kind:'post',text:'其他账号的帖子原文',receipt:{status:'confirmed',id:'other-post'}});
  f.experiences.create({text:'管理员登记的散步经历',occurredAt:'2026-10-27',revision:f.experiences.list().revision});
  await f.workflow.resume();const time=new Date(Date.now()+8*3600000).toISOString().slice(11,16);f.scheduler.configure(taskId,{enabled:true,time});
  const run=await f.scheduler.runNow(taskId);assert.equal(run.status,'completed');assert.equal(run.error,null);assert.deepEqual(run.result?.format,{issues:['markdown']});assert.equal(f.calls.length,1);assert.equal(f.calls[0].meta.jsonObject,false);assert.equal(f.posts.length,1);assert.equal(f.posts[0],'## 早上好\n**一起出门走走吧**');
  assert.ok(f.calls[0].user.includes('前两天发过的独特开头'));assert.ok(f.calls[0].user.includes('管理员登记的散步经历'));assert.ok(!f.calls[0].user.includes('已经隐藏的帖子原文'));assert.ok(!f.calls[0].user.includes('其他账号的帖子原文'));assert.ok(f.calls[0].user.includes('这条帖子不要重复它们的开头、句式和切入点'));assert.ok(f.calls[0].user.includes('今天去散步'));
  assert.deepEqual(JSON.parse(f.store.get('task-result:'+run.id)),{format:{issues:['markdown']}});assert.ok(!JSON.stringify(run.result).includes('早上好'));assert.deepEqual((f.feed.list({filter:'post'}).items[0] as any).format,{issues:['markdown']});
  const ordinary=await f.persona.assemble({accountId:'worker',channel:'public',message:'普通回复'});assert.ok(!ordinary.hints.some(h=>h.kind==='post-variety'));assert.ok(!ordinary.user.includes('这条帖子不要重复它们的开头、句式和切入点'));assert.equal(f.calls.length,1);
 }finally{f.close();}}
});

test('任务重试不能覆盖prepared冻结正文，格式元数据继续对应冻结正文',async()=>{
 const f=fixture();try{
  await f.workflow.resume();const now=Date.now(),runId='frozen-format';f.scheduler.recordMainStart(runId,'worker',now);
  const frozen='1. 原冻结正文\n2. 不用新生成正文';f.outbox.prepare({accountId:'worker',kind:'post',sourceId:runId,text:frozen});
  await assert.rejects(productionTaskHandlers(f.workflow).execute('morning-post',{runId,taskId:'morning-post',accountId:'worker',scheduledAt:now,source:'manual',signal:new AbortController().signal,ensureEnabled:()=>true}),/出站正文和目标已冻结/);
  assert.deepEqual(f.posts,[]);assert.deepEqual(JSON.parse(f.store.get('task-result:'+runId)),{format:{issues:['list-or-steps']}});assert.equal(f.outbox.source('worker','post',runId)?.text,frozen);assert.equal(f.calls.length,1);
 }finally{f.close();}
});

test('主动帖子共享精确封存门禁，旧unknown保留而任何新unknown继续阻止发帖',async()=>{
 const f=fixture();try{
  const event={id:'old-public',platformId:'9981',targetId:'9981',accountId:'worker',channel:'public' as const,userId:'x:visitor',handle:'visitor',text:'原测试评论',url:'https://x.com/visitor/status/9981',conversationId:'9981',timestamp:Date.now()-1000,timestampReliable:true};
  f.store.ingest(event,'worker');const message=f.store.findByPlatformId('worker','public','9981')!;f.store.update(message.id,'unknown',{draft:{action:'reply',text:'原冻结回复',reason:''}},'worker');
  const old=f.outbox.prepare({accountId:'worker',kind:'reply',sourceId:message.id,targetId:'9981',event:JSON.parse(f.store.getMessage(message.id,'worker').body),text:'原冻结回复'});f.outbox.begin(old.id);f.outbox.settle(old.id,{status:'unknown'});
  const reviews=new UnknownReviews(f.store,()=>({accountId:'worker',control:f.workflow.control(),busy:f.workflow.busy}));reviews.approve(old.id,{revision:reviews.preview(old.id).revision,confirmed:true,action:'allow-other-public-items'});
  await f.workflow.resume();const handlers=productionTaskHandlers(f.workflow),context={runId:'reviewed-post',taskId:'morning-post' as const,accountId:'worker',scheduledAt:Date.now(),source:'manual' as const,signal:new AbortController().signal,ensureEnabled:()=>true};
  const result=await handlers.execute('morning-post',context);assert.equal(result.status,'completed');assert.equal(f.posts.length,1);assert.equal(f.outbox.get(old.id)?.status,'unknown');assert.equal(f.store.getMessage(message.id,'worker').status,'unknown');
  f.store.ingest({...event,id:'new-unknown',platformId:'9982',targetId:'9982',url:'https://x.com/visitor/status/9982',conversationId:'9982'},'worker');const next=f.store.findByPlatformId('worker','public','9982')!;f.store.update(next.id,'unknown',{draft:{action:'reply',text:'新未知回复',reason:''}},'worker');
  const blocked=await handlers.execute('morning-post',{...context,runId:'new-blocked-post'});assert.equal(blocked.status,'skipped');assert.equal(f.posts.length,1);assert.equal(f.calls.length,1);
 }finally{f.close();}
});
