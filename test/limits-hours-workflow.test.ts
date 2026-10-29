import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Outbox} from '../src/outbox.js';
import {Workflow} from '../src/workflow.js';
import {ReplyTriage} from '../src/reply-triage.js';
import {ActivityFeed} from '../src/activity-feed.js';
import {LlmStore} from '../src/llm-store.js';
import {PersonaService} from '../src/persona.js';
import {MemoryService} from '../src/memory.js';
import {DailyStateService,shanghaiDate} from '../src/daily-state.js';
import {TaskScheduler} from '../src/scheduler.js';
import {productionTaskHandlers} from '../src/production-tasks.js';
import {exampleConfig} from './config-fixture.js';
import type {Config,Event} from '../src/types.js';
import type {Transport} from '../src/transport.js';
import type {Generator} from '../src/model.js';

const hour=3600000,account='hours_bot';
function fixture(){
 const root=mkdtempSync(tmpdir()+'/limits-hours-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=root;
 const store=new Store(root+'/workflow.sqlite'),outbox=new Outbox(store),ledger=new LlmStore(store);
 const config={...structuredClone(exampleConfig),mode:'auto',privatePerDay:400,replyHours:{enabled:false,closeDelayMinutes:30}} as Config;
 let events:Event[]=[],calls=0,sends=0,lookups=0,posts=0;
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async(c,_s,_u,_a,_session,meta={})=>{calls++;const callId=ledger.start(c.model,meta);ledger.finish(callId,'completed',{usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2},pricingStatus:'unknown'});return {text:JSON.stringify({action:'reply',text:'收到，我们可以接着聊。',reason:''}),input:1,output:1,cache:0,callId};}};
 const transport:Transport={identity:async()=>({handle:account,loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>({events,warnings:[]}),context:async()=>({messages:[]}),send:async e=>{sends++;return {status:'confirmed',id:'sent-'+e.platformId};},lookup:async e=>{lookups++;return {status:'confirmed',id:'looked-up-'+e.platformId};},post:async()=>{posts++;return {status:'confirmed',id:'post-'+posts};},lookupPost:async()=>({status:'unknown'})};
 const triage=new ReplyTriage(store,undefined,()=>Date.now()),workflow=new Workflow(store,transport,generator,()=>config);
 workflow.services={outbox,triage};store.set('activeAccount',account);
 const feed=new ActivityFeed(store,()=>account,()=>config.maxAgeHours);
 const event=(id:string,patch:Partial<Event>={}):Event=>({id:'x:'+id,platformId:id,targetId:id,channel:'public',userId:'x:visitor_'+id,handle:'visitor',text:'接下来的计划应该怎么安排？',url:'https://x.com/visitor/status/'+id,conversationId:id,timestamp:Date.now(),timestampReliable:true,...patch});
 const row=(id:string)=>store.getMessage('x:'+id,account);
 const approved=(e:Event)=>{triage.ingest(e,account);const r=store.getMessage(e.id,account);store.update(r.id,'draft',{draft:{action:'reply',text:'经过管理员批准的回复。',reason:''}});const current=store.getMessage(r.id,account);feed.mutate(current.id,'approve',{text:JSON.parse(current.draft).text,revision:current.updated_at});return current.id;};
 const seed=(count:number,at:number,channel:'public'|'private'='private')=>{const insert=store.db.prepare("INSERT INTO outbox(id,account_id,channel,kind,source_id,target_id,text,status,receipt,created_at,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,'confirmed',?,?,?,?)");for(let i=0;i<count;i++){const id='historical-'+channel+'-'+i;insert.run(id,account,channel,channel==='private'?'dm':'reply',id,'target','历史回复',JSON.stringify({status:'confirmed',id}),at,at,at);}};
 return {root,store,outbox,triage,workflow,config,feed,event,row,approved,seed,generator,events:(value:Event[])=>events=value,counts:()=>({calls,sends,lookups,posts}),close(){workflow.stop();store.db.close();rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}};
}

test('私信满400条时不占轮次名额、公开继续、无拒绝退避',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-28T12:00:00Z'));
 const f=fixture();try{f.config.maxPerRound=1;f.seed(400,Date.now()-2*hour);f.events([f.event('100',{channel:'private',conversationId:'dm-100'}),f.event('101',{timestamp:Date.now()-1000})]);await f.workflow.resume();await f.workflow.tick();assert.equal(f.row('100').status,'queued');assert.equal(f.row('101').status,'confirmed');assert.equal(f.counts().calls,1);assert.equal(f.counts().sends,1);assert.equal(f.store.get('cooldown:private:'+account),'');}finally{f.close();}
});

test('私信滚动窗口跨北京时间零点不清零，满二十四小时后释放',async t=>{
 let now=Date.parse('2026-10-28T15:59:00Z');t.mock.method(Date,'now',()=>now);
 const f=fixture();try{f.config.privatePerDay=1;const submitted=now-2*hour;f.seed(1,submitted);f.events([f.event('102',{channel:'private',conversationId:'dm-102'})]);await f.workflow.resume();await f.workflow.tick();assert.equal(f.row('102').status,'queued');now+=2*60000;await f.workflow.tick();assert.equal(f.row('102').status,'queued');now=submitted+24*hour+1;f.events([f.event('103',{channel:'private',conversationId:'dm-103'})]);await f.workflow.tick();assert.equal(f.row('103').status,'confirmed');assert.equal(f.counts().sends,1);}finally{f.close();}
});

test('草稿生成豁免私信日额度，已批准私信保留等待原因',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-28T12:00:00Z'));
 const f=fixture();try{f.config.mode='draft';f.seed(400,Date.now()-2*hour);f.events([f.event('104',{channel:'private',conversationId:'dm-104'})]);await f.workflow.resume();await f.workflow.tick();assert.equal(f.row('104').status,'draft');const r=f.row('104');f.feed.mutate(r.id,'approve',{text:JSON.parse(r.draft).text,revision:r.updated_at});await f.workflow.tick();const waiting=f.row('104');assert.equal(waiting.status,'approved');assert.equal(JSON.parse(waiting.draft).waitReason,'private-daily-quota');assert.equal(f.counts().sends,0);}finally{f.close();}
});

test('回复关闭期间采集公开和私信但不生成、不提交',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-28T16:30:00Z'));
 const f=fixture();try{f.config.replyHours={enabled:true,closeDelayMinutes:30};f.events([f.event('105'),f.event('106',{channel:'private',conversationId:'dm-106'})]);await f.workflow.resume();await f.workflow.tick();assert.equal(f.row('105').status,'queued');assert.equal(f.row('106').status,'queued');assert.equal(f.counts().calls,0);assert.equal(f.counts().sends,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM llm_calls').get()!.n,0);}finally{f.close();}
});

test('回复关闭同样阻止草稿生成，已批准草稿开放后提交',async t=>{
 let now=Date.parse('2026-10-28T16:30:00Z');t.mock.method(Date,'now',()=>now);
 const f=fixture();try{f.config.mode='draft';f.config.replyHours={enabled:true,closeDelayMinutes:30};const id=f.approved(f.event('107'));f.events([f.event('108')]);await f.workflow.resume();await f.workflow.tick();assert.equal(f.row('107').status,'approved');assert.equal(JSON.parse(f.row('107').draft).waitReason,'reply-hours-closed');assert.equal(f.row('108').status,'queued');assert.equal(f.counts().calls,0);assert.equal(f.counts().sends,0);now=Date.parse('2026-10-29T00:00:00Z');f.events([]);await f.workflow.tick();assert.equal(f.store.getMessage(id,account).status,'confirmed');assert.equal(f.counts().sends,1);assert.equal(f.row('108').status,'draft');}finally{f.close();}
});

test('夜间unknown照常回查而不提交新回复',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-28T16:30:00Z'));
 const f=fixture();try{f.config.replyHours={enabled:true,closeDelayMinutes:30};const e=f.event('109');f.triage.ingest(e,account);const r=f.row('109');f.store.update(r.id,'unknown',{draft:{action:'reply',text:'历史不确定回复',reason:''}});f.events([f.event('110')]);await f.workflow.resume();await f.workflow.tick();assert.equal(f.row('109').status,'confirmed');assert.equal(f.row('110').status,'queued');assert.equal(f.counts().lookups,1);assert.equal(f.counts().calls,0);assert.equal(f.counts().sends,0);}finally{f.close();}
});

test('凌晨普通消息和关闭前排队消息在开放后扣除夜间时长',async t=>{
 let now=Date.parse('2026-10-28T15:10:00Z');t.mock.method(Date,'now',()=>now);
 const f=fixture();try{f.config.replyHours={enabled:true,closeDelayMinutes:30};const before=f.event('111',{text:'hi'});f.triage.ingest(before,account);now=Date.parse('2026-10-28T18:00:00Z');f.events([f.event('112',{text:'hi'})]);await f.workflow.resume();await f.workflow.tick();assert.equal(f.row('111').status,'queued');assert.equal(f.row('112').status,'queued');now=Date.parse('2026-10-29T00:00:00Z');f.events([]);await f.workflow.tick();assert.equal(f.row('111').status,'confirmed');assert.equal(f.row('112').status,'confirmed');assert.equal(f.counts().sends,2);}finally{f.close();}
});

test('早安任务在等待早安的关闭状态下照常生成发帖，下一轮才回复',async t=>{
 let now=Date.parse('2026-10-29T00:00:00Z');t.mock.method(Date,'now',()=>now);
 const f=fixture();try{
  f.config.replyHours={enabled:true,closeDelayMinutes:30};const persona=new PersonaService(f.store,f.generator,()=>f.config),daily=new DailyStateService(f.store,f.generator,()=>f.config),memory=new MemoryService(f.store,f.generator,()=>f.config),date=shanghaiDate();
  daily.edit(account,date,{date,fictional:true,periods:[{start:'08:00',end:'09:00',activity:'阅读'}],meals:{breakfast:'面包',lunch:'米饭',dinner:'蔬菜'},activities:['阅读'],mood:'平静'},0);f.workflow.services.persona=persona;f.workflow.services.daily=daily;f.workflow.services.memory=memory;
  const scheduler=new TaskScheduler(f.store,{account:()=>account,control:()=>f.workflow.control(),mode:()=>f.config.mode,...productionTaskHandlers(f.workflow)});f.workflow.services.scheduler=scheduler;scheduler.configure('morning-post',{enabled:true,time:'08:00'});scheduler.configure('daily-state',{enabled:false});scheduler.configure('memory-summary',{enabled:false});
  f.events([f.event('113')]);await f.workflow.resume();assert.equal(f.workflow.replyHours().reason,'waiting-morning-post');await f.workflow.tick();assert.equal(f.row('113').status,'queued');assert.equal(f.counts().sends,0);const morning=scheduler.history({taskId:'morning-post'}).items[0];assert.equal(morning?.status,'completed',morning?.error||morning?.detail);assert.equal(f.counts().posts,1);assert.equal(f.workflow.replyHours().open,true);
  now+=1000;f.events([]);await f.workflow.tick();assert.equal(f.row('113').status,'confirmed');assert.equal(f.counts().sends,1);
 }finally{f.close();}
});
