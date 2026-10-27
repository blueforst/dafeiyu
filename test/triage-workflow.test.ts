import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Outbox } from '../src/outbox.js';
import { LlmStore,type CallMetadata } from '../src/llm-store.js';
import { ReplyTriage,DEFAULT_TRIAGE_SETTINGS } from '../src/reply-triage.js';
import { registerTriageRoutes } from '../src/triage-routes.js';
import { MemoryService } from '../src/memory.js';
import { PersonaService } from '../src/persona.js';
import { DailyStateService,shanghaiDate } from '../src/daily-state.js';
import { TaskScheduler } from '../src/scheduler.js';
import { productionTaskHandlers } from '../src/production-tasks.js';
import { exampleConfig } from './config-fixture.js';
import type { Event,Config,Draft,Receipt } from '../src/types.js';
import type { Transport } from '../src/transport.js';
import type { Generator } from '../src/model.js';

const account='triage_bot';
const event=(id:string,patch:Partial<Event>={}):Event=>({id,platformId:'platform-'+id,targetId:'platform-'+id,channel:'public',userId:'user-'+id,handle:'visitor',text:'我想了解今天的阅读计划，应该如何开始？ '+id,url:'https://x.com/visitor/status/'+id,conversationId:'thread-'+id,timestamp:Date.now(),timestampReliable:true,...patch});
function fixture(){
 const root=mkdtempSync(tmpdir()+'/triage-workflow-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=root;
 const store=new Store(root+'/workflow.sqlite'),config={...structuredClone(exampleConfig),mode:'auto',publicPerDay:180,triage:structuredClone(DEFAULT_TRIAGE_SETTINGS)} as Config;
 const outbox=new Outbox(store),ledger=new LlmStore(store),triage=new ReplyTriage(store,()=>config.triage!);
 let events:Event[]=[],response:(meta:CallMetadata)=>Draft=()=>({action:'reply',text:'可以先读一小段，再聊聊你的感受。',reason:''});
 const calls:Array<{system:string;user:string;meta:CallMetadata}>=[],sends:Array<{event:Event;text:string}>=[],posts:string[]=[],contexts:string[]=[];
 const generator:Generator={complete:async(c,system,user,_signal,_session,meta={})=>{
  calls.push({system,user,meta});const callId=ledger.start(c.model,meta);
  const text=meta.purpose==='memory-summary'?JSON.stringify({items:[]}):JSON.stringify(response(meta));
  ledger.finish(callId,'completed',{usage:{input:5,output:5,cacheRead:0,cacheWrite:0,totalTokens:10},pricingStatus:'unknown'});
  return {text,input:5,output:5,cache:0,callId};
 }};
 const transport:Transport={identity:async()=>({loggedIn:true,needsHuman:false,handle:account}),control:async()=>{},collect:async()=>({events,warnings:[]}),context:async e=>{contexts.push(e.id);return '仅有明确标记的隔离对话资料';},send:async(e,text)=>{sends.push({event:e,text});return {status:'confirmed',id:'receipt-'+e.platformId};},lookup:async()=>({status:'unknown'}),post:async(text)=>{posts.push(text);return {status:'confirmed',id:'post-receipt-'+posts.length};},lookupPost:async()=>({status:'unknown'})};
 const workflow=new Workflow(store,transport,generator,()=>config),memory=new MemoryService(store,generator,()=>config);
 workflow.services={outbox,triage,memory};
 const seed=(count:number,status:'confirmed'|'unknown'='confirmed',channel:'public'|'private'='public',at=Date.now())=>{const insert=store.db.prepare('INSERT INTO outbox(id,account_id,channel,kind,source_id,target_id,text,status,receipt,created_at,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');for(let i=0;i<count;i++){const id='seed-'+channel+'-'+status+'-'+i;insert.run(id,account,channel,channel==='public'?'post':'dm',id,'target','隔离历史正文',status,status==='confirmed'?JSON.stringify({status:'confirmed',id:'historical-'+i}):null,at,at,at);}};
 return {root,store,config,outbox,ledger,triage,workflow,memory,generator,calls,sends,posts,contexts,seed,events:(value:Event[])=>{events=value;},response:(value:(meta:CallMetadata)=>Draft)=>{response=value;},row:(id:string)=>store.getMessage(id,account),replyCalls:()=>calls.filter(c=>c.meta.purpose==='reply'),close(){workflow.stop();store.db.close();rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}};
}

test('实际工作流在入队过滤广告与三账号刷量，不产生调用流水或出站',async()=>{
 const f=fixture();try{
  f.events([event('ad',{text:'领取空投 https://example.invalid'}),...['one','two','three'].map(id=>event(id,{text:'这是三个不同账号复制粘贴的完全相同内容'}))]);
  await f.workflow.resume();await f.workflow.tick();
  assert.equal(f.calls.length,0);assert.equal(f.contexts.length,0);assert.equal(f.sends.length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM llm_calls').get()!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n,0);
  for(const id of ['ad','one','two','three'])assert.equal(f.row(id).status,'filtered');
 }finally{f.close();}
});

test('实际工作流公开小时额度、unknown、平台退避与每日额度分别受限时私信仍占实际名额',async t=>{
 for(const reason of ['hour','unknown','cooldown','day'] as const)await t.test(reason,async()=>{
  const f=fixture();try{
   f.config.maxPerRound=1;
   if(reason==='hour'){f.config.publicPerHour=1;f.seed(1);}
   if(reason==='unknown')f.seed(1,'unknown');
   if(reason==='cooldown')f.store.set('cooldown:public:'+account,String(Date.now()+3600000));
   if(reason==='day'){f.config.publicPerDay=1;f.seed(1);}
   f.events([event('public-one'),event('public-two'),event('private',{channel:'private',conversationId:'private-conversation',timestamp:Date.now()-60000})]);
   await f.workflow.resume();await f.workflow.tick();
   assert.equal(f.replyCalls().length,1);assert.equal(f.replyCalls()[0].meta.channel,'private');assert.equal(f.sends.length,1);assert.equal(f.sends[0].event.channel,'private');
   assert.equal(f.row('private').status,'confirmed');for(const id of ['public-one','public-two'])assert.equal(f.row(id).status,'queued');
   if(reason!=='cooldown')assert.equal(f.store.get('cooldown:public:'+account),'');
  }finally{f.close();}
 });
});

test('两个通道都不可用时队列保持排队，既不生成也不置失败',async()=>{
 const f=fixture();try{
  f.store.set('cooldown:public:'+account,String(Date.now()+3600000));f.seed(1,'unknown','private');f.events([event('public'),event('private',{channel:'private',conversationId:'dm'})]);
  await f.workflow.resume();await f.workflow.tick();
  assert.equal(f.replyCalls().length,0);assert.equal(f.sends.length,0);assert.equal(f.row('public').status,'queued');assert.equal(f.row('private').status,'queued');
 }finally{f.close();}
});

test('实际工作流大量过期优先消息及三小时普通消息不挤占有效候选',async()=>{
 const f=fixture();try{
  f.config.maxPerRound=1;const now=Date.now();
  f.events([...Array.from({length:25},(_,i)=>event('expired-'+i,{text:'超过六小时的优先提问应该如何处理 '+i,timestamp:now-7*3600000-i})),event('old-normal',{text:'hi',timestamp:now-3.5*3600000}),event('fresh-normal',{text:'hi',timestamp:now-1000})]);
  await f.workflow.resume();await f.workflow.tick();
  assert.equal(f.replyCalls().length,1);assert.equal(f.sends.length,1);assert.equal(f.sends[0].event.platformId,'platform-fresh-normal');assert.equal(f.row('fresh-normal').status,'confirmed');
  assert.ok(f.replyCalls()[0].user.includes('hi'));assert.ok(!f.replyCalls()[0].user.includes('超过六小时'));
 }finally{f.close();}
});

test('实际工作流同会话三条消息只生成并提交一次，合并正文进入当前上下文',async()=>{
 const f=fixture();try{
  const now=Date.now(),same={userId:'same-person',handle:'same_person',conversationId:'one-thread'};
  f.events([event('first',{...same,text:'第一条：我读完了第一章。',timestamp:now-120000}),event('second',{...same,text:'第二条：其中的人物让我疑惑。',timestamp:now-60000}),event('latest',{...same,text:'最后一条：请帮我理解人物的选择。',timestamp:now})]);
  await f.workflow.resume();await f.workflow.tick();
  assert.equal(f.replyCalls().length,1);assert.equal(f.sends.length,1);assert.equal(f.row('latest').status,'confirmed');for(const id of ['first','second']){assert.equal(f.row(id).status,'merged');assert.equal(f.row(id).merged_into,f.row('latest').id);}
  const user=f.replyCalls()[0].user;for(const part of ['第一条','第二条','最后一条'])assert.ok(user.includes(part),part+' 应进入生成上下文');
 }finally{f.close();}
});

test('三次真实生成的harassment类别进入冷却，忽略原文和调度标签不进入记忆模型输入',async()=>{
 const f=fixture();try{
  const userId='repeat-person';f.response(()=>({action:'skip',text:'',reason:'仅用于调度的骚扰判定原因',category:'harassment'}));
  await f.workflow.resume();
  for(let i=0;i<3;i++){f.events([event('skip-'+i,{userId,handle:'repeat_person',text:'第'+i+'次有内容的消息应该如何处理？'})]);await f.workflow.tick();assert.equal(f.row('skip-'+i).status,'skipped');}
  assert.equal(f.replyCalls().length,3);assert.ok(f.triage.ignored(userId,'public',account));
  f.events([event('ignored',{userId,handle:'repeat_person',text:'IGNORED_SOURCE_MUST_STAY_OUT_OF_MEMORY'})]);await f.workflow.tick();assert.equal(f.row('ignored').status,'ignored');assert.equal(f.replyCalls().length,3);assert.equal(f.sends.length,0);
  await f.memory.summarize(userId,'public',account,{force:true,config:f.config});
  const summary=f.calls.find(call=>call.meta.purpose==='memory-summary');assert.ok(summary);
  for(const forbidden of ['IGNORED_SOURCE_MUST_STAY_OUT_OF_MEMORY','仅用于调度的骚扰判定原因','harassment','"category"'])assert.ok(!summary.user.includes(forbidden),forbidden+' 不应进入记忆输入');
  assert.ok(!JSON.stringify(f.memory.context(userId,'public',account)).includes('IGNORED_SOURCE_MUST_STAY_OUT_OF_MEMORY'));assert.deepEqual(f.memory.items(userId,'public',account),[]);
  f.triage.clearIgnore(userId,'public',account);f.response(()=>({action:'reply',text:'已经恢复正常交流。',reason:''}));f.events([event('after-clear',{userId,handle:'repeat_person',text:'现在可以正常聊聊接下来的阅读计划吗？'})]);await f.workflow.tick();assert.equal(f.row('after-clear').status,'confirmed');assert.equal(f.replyCalls().length,4);
 }finally{f.close();}
});

test('179条公开提交后同轮只再生成并提交一条公开回复，私信仍处理且不写拒绝退避',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-28T12:00:00Z'));
 const f=fixture();try{
  f.config.maxPerRound=4;f.seed(179,'confirmed','public',Date.now()-2*3600000);const now=Date.now();f.events([event('public-first',{timestamp:now}),event('public-waits',{timestamp:now-1000}),event('private',{channel:'private',conversationId:'dm',timestamp:now-2000})]);
  await f.workflow.resume();await f.workflow.tick();
  assert.equal(f.triage.dailyCount(account),180);assert.equal(f.replyCalls().filter(call=>call.meta.channel==='public').length,1);assert.equal(f.replyCalls().filter(call=>call.meta.channel==='private').length,1);assert.equal(f.sends.filter(send=>send.event.channel==='public').length,1);assert.equal(f.row('public-first').status,'confirmed');assert.equal(f.row('public-waits').status,'queued');assert.equal(f.row('private').status,'confirmed');assert.equal(f.store.get('cooldown:public:'+account),'');
 }finally{f.close();}
});

test('真实问候任务与入站公开回复共享180条每日额度，满额任务不调用模型或平台',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-28T12:00:00Z'));
 const f=fixture();let scheduler:TaskScheduler|undefined;try{
  f.seed(179,'confirmed','public',Date.now()-2*3600000);
  const persona=new PersonaService(f.store,f.generator,()=>f.config),daily=new DailyStateService(f.store,f.generator,()=>f.config),date=shanghaiDate();
  daily.edit(account,date,{date,fictional:true,periods:[{start:'08:00',end:'09:00',activity:'虚构阅读'}],meals:{breakfast:'面包',lunch:'米饭',dinner:'蔬菜'},activities:['阅读'],mood:'平静'},0);f.workflow.services.persona=persona;f.workflow.services.daily=daily;
  scheduler=new TaskScheduler(f.store,{account:()=>f.workflow.accountId(),control:()=>f.workflow.control(),mode:()=>f.config.mode,...productionTaskHandlers(f.workflow)});
  await f.workflow.resume();const time=new Date(Date.now()+8*3600000).toISOString().slice(11,16);scheduler.configure('morning-post',{enabled:true,time});
  const morning=await scheduler.runNow('morning-post');assert.equal(morning.status,'completed');assert.equal(f.posts.length,1);assert.equal(f.calls.filter(call=>call.meta.purpose==='morning-post').length,1);assert.equal(f.triage.dailyCount(account),180);
  const before=f.calls.length;f.events([event('incoming-after-greeting')]);await f.workflow.tick();assert.equal(f.calls.length,before);assert.equal(f.row('incoming-after-greeting').status,'queued');assert.equal(f.sends.length,0);
  scheduler.configure('evening-post',{enabled:true,time});const evening=await scheduler.runNow('evening-post');assert.equal(evening.status,'skipped');assert.equal(f.calls.length,before);assert.equal(f.posts.length,1);assert.equal(f.store.get('cooldown:public:'+account),'');
 }finally{scheduler?.cancelBusiness();f.close();}
});

test('实际分级接口展示摘要、解除忽略与重新排队，unknown返回409',async()=>{
 const f=fixture(),app=Fastify();try{
  registerTriageRoutes(app,{triage:f.triage,accountId:()=>account});
  f.triage.ingest(event('ad',{text:'领取空投 https://example.invalid'}),account);const person=event('person',{userId:'ignored-person'});for(let i=0;i<3;i++)f.triage.recordSkip(person,account,'harassment');
  const summary=await app.inject({url:'/api/triage/summary'});assert.equal(summary.statusCode,200);assert.ok(summary.json().today.some((row:any)=>row.status==='filtered'&&row.count===1));
  const ignores=await app.inject({url:'/api/triage/ignores'});assert.equal(ignores.json().items.length,1);
  const cleared=await app.inject({method:'DELETE',url:'/api/triage/ignores',payload:{userId:'ignored-person',channel:'public'}});assert.equal(cleared.statusCode,200);assert.equal(f.triage.ignored('ignored-person','public',account),null);
  const requeued=await app.inject({method:'POST',url:'/api/messages/'+encodeURIComponent(f.row('ad').id)+'/requeue'});assert.equal(requeued.statusCode,200);assert.equal(f.row('ad').status,'queued');
  f.store.update(f.row('ad').id,'unknown');const denied=await app.inject({method:'POST',url:'/api/messages/'+encodeURIComponent(f.row('ad').id)+'/requeue'});assert.equal(denied.statusCode,409);assert.equal(f.row('ad').status,'unknown');assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);
 }finally{await app.close();f.close();}
});

test('实际CLI子进程重排filtered/merged/ignored，拒绝unknown且不发起模型或浏览器操作',()=>{
 const f=fixture();try{
  const configPath=f.root+'/config.json';writeFileSync(configPath,JSON.stringify(f.config));
  const run=(id:string)=>spawnSync(process.execPath,['--import','tsx',resolve('src/cli.ts'),'retry',id],{encoding:'utf8',timeout:30000,env:{...process.env,DATA_DIR:f.root,CONFIG_PATH:configPath,SECRETS_DIR:f.root+'/no-secrets',BROWSER_ENDPOINT:'http://127.0.0.1:1'}});
  for(const status of ['filtered','merged','ignored'] as const){f.triage.ingest(event(status),account);f.store.update(f.row(status).id,status);const result=run(f.row(status).id);assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.equal(f.row(status).status,'queued');assert.equal(f.store.get('triage:manual:'+f.row(status).id),'1');}
  f.triage.ingest(event('unknown'),account);f.store.update(f.row('unknown').id,'unknown');const result=run(f.row('unknown').id);assert.notEqual(result.status,0);assert.equal(f.row('unknown').status,'unknown');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM llm_calls').get()!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n,0);
 }finally{f.close();}
});
