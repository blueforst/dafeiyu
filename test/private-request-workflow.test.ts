import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Workflow} from '../src/workflow.js';
import {Outbox} from '../src/outbox.js';
import {RuntimeHealth} from '../src/unattended-health.js';
import {ActivityFeed} from '../src/activity-feed.js';
import {ReplyTriage} from '../src/reply-triage.js';
import {privateRequestState,recordPrivateRequestState,privateRequestsSummary,type PrivateRequestCandidate,type PrivateRequestResult} from '../src/private-requests.js';
import {fakeConverse} from './tool-fixture.js';
import {exampleConfig} from './config-fixture.js';
import type {Transport} from '../src/transport.js';
import type {Config} from '../src/types.js';

function fixture(){
 const dir=mkdtempSync(tmpdir()+'/request-workflow-'),store=new Store(dir+'/workflow.sqlite'),outbox=new Outbox(store),triage=new ReplyTriage(store),config={...structuredClone(exampleConfig),mode:'auto'} as Config;
 const id='11111111-1111-4111-8111-111111111111',candidate:PrivateRequestCandidate={source:'other',url:'https://x.com/i/chat/requests/other/111-222',event:{id:'dm:111-222:'+id,platformId:id,targetId:'111-222',channel:'private',userId:'dm:111-222',accountId:'worker',handle:'',conversationId:'111-222',url:'https://x.com/i/chat/111-222',text:'你好，我有个问题想和你聊聊。',timestamp:Date.now()-1000,timestampReliable:true,privateContract:'xchat-native-v2',senderId:'111',nativeSequence:'1234'}};
 const prompts:string[]=[];let accepts=0,calls=0,sends=0,lookupOnly:boolean|undefined,accepted:PrivateRequestResult={status:'accepted',reason:'合成接受完成',events:[candidate.event]};
 const transport:Transport={identity:async()=>({handle:'worker',userId:'222',loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>({events:[],warnings:[]}),collectPublic:async()=>({events:[],warnings:[],diagnostics:[{channel:'public',status:'empty',code:'public-confirmed-empty',eventCount:0}]}),collectPrivate:async()=>({events:[],requests:[candidate],warnings:['有私信请求等待规则核对与接受。'],diagnostics:[{channel:'private',status:'partial',code:'private-request-observed',source:'other',eventCount:0}]}),acceptPrivateRequest:async(_c,_h,options)=>{accepts++;lookupOnly=options?.lookupOnly;return accepted;},context:async()=>({messages:[]}),send:async()=>{sends++;return {status:'confirmed',id:'receipt'};},lookup:async()=>({status:'unknown'})};
 const workflow=new Workflow(store,transport,{async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async(_c,_system,user)=>{prompts.push(user);calls++;return {text:JSON.stringify({action:'reply',text:'合成回复',reason:''}),input:0,output:0,cache:0};}},()=>config);
 workflow.services={outbox,triage,health:new RuntimeHealth(store)};store.set('activeAccount','worker');
 return {store,workflow,config,candidate,transport,prompts,feed:new ActivityFeed(store,()=> 'worker',()=>6),result:(value:PrivateRequestResult)=>accepted=value,counts:()=>({accepts,calls,sends,lookupOnly}),close(){workflow.stop();store.db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('Other正常请求接受后进入原工作流，重复轮次只生成和发送一次',async()=>{
 const f=fixture();try{await f.workflow.resume();await f.workflow.tick();assert.equal(f.store.getMessage(f.candidate.event.id,'worker')?.status,'confirmed');assert.equal(f.counts().calls,1);assert.equal(f.counts().sends,1);assert.equal(privateRequestState(f.store,'worker','111-222')?.status,'accepted');await f.workflow.tick();assert.equal(f.counts().calls,1);assert.equal(f.counts().sends,1);assert.ok(f.store.logs().some((row:any)=>row.event==='collection-result'&&row.detail.includes('private-request-accepted')));}finally{f.close();}
});
test('草稿仅记录等待，广告与遗忘请求不接受且动态状态不泄漏正文',async()=>{
 for(const mode of ['draft','ad','forgotten'] as const){const f=fixture();try{
  if(mode==='draft')f.config.mode='draft';if(mode==='ad')f.candidate.event.text='空投 https://example.test';if(mode==='forgotten')f.store.forget(f.candidate.event.userId,'worker');
  await f.workflow.resume();await f.workflow.tick();assert.equal(f.counts().accepts,0,mode);assert.equal(f.counts().calls,0);assert.equal(f.counts().sends,0);const state=privateRequestState(f.store,'worker','111-222');assert.equal(state?.status,mode==='ad'?'filtered':mode==='forgotten'?'ignored':'waiting');assert.ok(!JSON.stringify(f.feed.summary()).includes(f.candidate.event.text));assert.equal(f.store.getMessage(f.candidate.event.id,'worker'),undefined);
 }finally{f.close();}}
});
test('接受断线保留unknown，下轮只回查；另一账号状态不互串',async()=>{
 const f=fixture();try{f.result({status:'unknown',reason:'模拟断线'});await f.workflow.resume();await f.workflow.tick();assert.equal(privateRequestState(f.store,'worker','111-222')?.status,'unknown');assert.equal(f.feed.summary().pending,1);await f.workflow.tick();assert.equal(f.counts().lookupOnly,true);assert.equal(f.counts().calls,0);assert.equal(f.counts().sends,0);assert.equal(privateRequestsSummary(f.store,'other').total,0);
  f.result({status:'accepted',reason:'回查完成',events:[{...f.candidate.event,accountId:'other'}]});await f.workflow.tick();assert.equal(f.counts().calls,0);assert.equal(f.counts().sends,0);assert.equal(f.store.getMessage(f.candidate.event.id,'worker'),undefined);assert.equal(f.feed.summary().pending,0);
 }finally{f.close();}
});
test('未知接受意图不因消息变新或夜间而重发，状态日志只在变化时新增',async()=>{
 const f=fixture();try{recordPrivateRequestState(f.store,f.candidate,'unknown','原未知意图');const count=()=>f.store.logs().filter((row:any)=>row.event==='private-request-state').length;const n=count();recordPrivateRequestState(f.store,f.candidate,'unknown','原未知意图');assert.equal(count(),n);f.config.mode='draft';f.result({status:'unknown',reason:'原未知意图'});await f.workflow.resume();await f.workflow.tick();assert.equal(f.counts().lookupOnly,true);assert.equal(f.counts().sends,0);}finally{f.close();}
});
test('夜间接受和采集历史照常入动态，开放后只对最新消息生成发送一次',async()=>{
 const f=fixture();let open=false;try{
  (f.workflow as any).replyHours=()=>({open});
  const latest=f.candidate.event,history=['22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'].map((id,index)=>({...latest,id:'dm:111-222:'+id,platformId:id,text:'历史入站 '+index,timestamp:latest.timestamp-600000+index,privateHistoryOf:latest.platformId}));
  f.transport.context=async()=>JSON.stringify([...history,latest].map(e=>({id:e.platformId,direction:'in',text:e.text,timestamp:e.timestamp})));f.result({status:'accepted',reason:'正常收件',events:[...history,latest]});await f.workflow.resume();await f.workflow.tick();
  assert.equal(f.counts().accepts,1);assert.equal(f.counts().calls,0);assert.equal(f.counts().sends,0);assert.equal(f.feed.conversations().items.length,1);assert.equal(f.feed.conversationItems('dm:111-222').items.length,5);
  for(const e of history)assert.equal(f.store.getMessage(e.id,'worker')?.status,'merged');assert.equal(f.store.getMessage(latest.id,'worker')?.status,'queued');
  open=true;await f.workflow.tick();assert.equal(f.counts().calls,1);assert.equal(f.counts().sends,1);for(const e of history)assert.ok(f.prompts[0].includes(e.text),'模型输入须包含全部前文');const target=JSON.parse(f.prompts[0].split('【本次消息】\n')[1].split('\n\n【现在】')[0]);assert.equal(target.message,latest.text);await f.workflow.tick();assert.equal(f.counts().sends,1);
 }finally{f.close();}
});
test('回复通道额度或unknown受限仍正常接受入库，生成发送继续受限',async()=>{
 const f=fixture();try{(f.workflow as any).channelWaitReason=()=> 'quota';await f.workflow.resume();await f.workflow.tick();assert.equal(f.counts().accepts,1);assert.equal(f.store.getMessage(f.candidate.event.id,'worker')?.status,'queued');assert.equal(f.counts().calls,0);assert.equal(f.counts().sends,0);}finally{f.close();}
});
test('跨轮间隔超过半小时仍只回复同会话最新入站，前文留在模型输入',async()=>{
 const f=fixture();let open=false;try{(f.workflow as any).replyHours=()=>({open});
  const first={...f.candidate.event,timestamp:Date.now()-2*3600000,text:'前一轮尚未回答的问题'};f.candidate.event=first;f.result({status:'accepted',reason:'已接受',events:[first]});await f.workflow.resume();await f.workflow.tick();
  const id='66666666-6666-4666-8666-666666666666',latest={...first,id:'dm:111-222:'+id,platformId:id,timestamp:Date.now()-1000,text:'现在只需要回答这条最新问题'};f.candidate.event=latest;f.result({status:'accepted',reason:'正常收件',events:[{...first,privateHistoryOf:id},latest]});f.transport.context=async()=>JSON.stringify([{text:first.text,direction:'in'},{text:latest.text,direction:'in'}]);await f.workflow.tick();
  assert.equal(f.store.getMessage(first.id,'worker')?.status,'merged');assert.equal(f.store.getMessage(latest.id,'worker')?.status,'queued');open=true;await f.workflow.tick();assert.equal(f.counts().calls,1);assert.equal(f.counts().sends,1);assert.ok(f.prompts[0].includes(first.text));assert.ok(f.prompts[0].includes(latest.text));
 }finally{f.close();}
});
