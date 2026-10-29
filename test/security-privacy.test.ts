import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import {Outbox,type OutboxStatus} from '../src/outbox.js';
import {Workflow} from '../src/workflow.js';
import {memoryPrivacyRevision} from '../src/persona-replay.js';
import {submissionAllowed} from '../src/submission-authority.js';
import {exampleConfig} from './config-fixture.js';
import {fakeConverse} from './tool-fixture.js';

const event=()=>({id:'x:701',platformId:'701',targetId:'701',channel:'public' as const,userId:'x:alice',handle:'alice',text:'合成公开询问',url:'https://x.com/alice/status/701',conversationId:'701',timestamp:Date.now(),timestampReliable:true});
function fixture(){const dir=mkdtempSync(tmpdir()+'/security-privacy-'),store=new Store(dir+'/workflow.sqlite');return {dir,store,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
for(const mutation of ['unlink','replace','forget','remove','edit'] as const)test('生成等待期间'+mutation+'使旧私信背景失效，随后按新范围生成',async()=>{
 const f=fixture(),sent:string[]=[];let workflow:Workflow|undefined;
 try{
  const c=structuredClone(exampleConfig);c.mode='auto';c.replyHours={enabled:false,closeDelayMinutes:30};
  let ready!:()=>void,finish!:(value:any)=>void,first=true,prompt='';const started=new Promise<void>(resolve=>ready=resolve);
  const generator:any={async converse(...args:any[]){return (fakeConverse as any)(this,...args);},async complete(_c:any,_s:string,user:string){if(first){first=false;prompt=user;ready();return new Promise(resolve=>finish=resolve);}return {text:JSON.stringify({action:'reply',text:'新的公开回复',reason:''}),input:0,output:0,cache:0};}};
  const e=event(),transport:any={identity:async()=>({handle:'worker',loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>({events:[e],warnings:[]}),context:async()=>'',lookup:async()=>({status:'unknown'}),send:async(_e:any,text:string)=>{sent.push(text);return {status:'confirmed',id:'fake-receipt'};}};
  workflow=new Workflow(f.store,transport,generator,()=>c);const memory=new MemoryService(f.store,generator,()=>c);workflow.services={memory,outbox:new Outbox(f.store)};
  f.store.db.prepare('INSERT INTO memory_items(id,account_id,user_id,channel,kind,text,source_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('item','worker','dm:111-333','private','fact','代号ABC123','complete',Date.now(),Date.now());
  memory.links.link('worker','dm:111-333','x:alice','admin');await workflow.resume();const tick=workflow.tick();await started;assert.ok(prompt.includes('ABC123'));
  if(mutation==='unlink')memory.links.unlink('worker','dm:111-333');
  if(mutation==='replace')memory.links.link('worker','dm:111-333','x:bob','admin');
  if(mutation==='forget')memory.forget('dm:111-333','worker');
  if(mutation==='remove')memory.remove('item','worker',1);
  if(mutation==='edit')memory.edit('item','worker','新的背景',1);
  finish({text:JSON.stringify({action:'reply',text:'ABC123',reason:'旧背景'}),input:0,output:0,cache:0});await tick;
  assert.deepEqual(sent,[]);const row=f.store.getMessage(e.id,'worker');assert.equal(row.status,'queued');assert.ok(!row.draft?.includes('ABC123'));
  await workflow.tick();assert.deepEqual(sent,['新的公开回复']);
 }finally{workflow?.stop();f.close();}
});

test('最终提交授权重新核对修订、账号、状态及正文，未知意图不能借授权重发',()=>{
 const f=fixture();try{
  const memory=new MemoryService(f.store,{} as any),outbox=new Outbox(f.store),e=event();memory.links.link('worker','dm:111-333','x:alice','admin');f.store.ingest(e,'worker');const row=f.store.getMessage(e.id,'worker'),revision=memoryPrivacyRevision(f.store,'worker',e.userId,e.channel),text='合成回复';
  const frozen={...e,id:row.id,accountId:'worker',privacyRevision:revision};const intent=outbox.prepare({accountId:'worker',kind:'reply',sourceId:row.id,targetId:'701',event:frozen,text});assert.ok(outbox.begin(intent.id));f.store.update(row.id,'sending');
  const input={requestId:intent.id,handle:'worker',sourceId:row.id,targetId:'701',channel:'public',textHash:createHash('sha256').update(text).digest('hex'),privacyRevision:revision};
  assert.ok(submissionAllowed(f.store,'running','worker',input));assert.equal(submissionAllowed(f.store,'paused','worker',input),false);assert.equal(submissionAllowed(f.store,'running','other',input),false);assert.equal(submissionAllowed(f.store,'running','worker',{...input,textHash:'wrong'}),false);assert.equal(submissionAllowed(f.store,'running','worker',{...input,targetId:'other'}),false);assert.equal(submissionAllowed(f.store,'running','worker',{...input,sourceId:'other'}),false);
  memory.links.unlink('worker','dm:111-333');assert.equal(submissionAllowed(f.store,'running','worker',input),false);outbox.settle(intent.id,{status:'unknown'});assert.equal(submissionAllowed(f.store,'running','worker',input),false);
 }finally{f.close();}
});

test('最终浏览器守卫阻止旧结果后仅以持久未提交证明换新ID，未知出站不允许替换',()=>{
 const f=fixture();try{
  const memory=new MemoryService(f.store,{} as any),outbox=new Outbox(f.store),e=event();memory.links.link('worker','dm:111-333','x:alice','admin');f.store.ingest(e,'worker');const message=f.store.getMessage(e.id,'worker');
  const oldEvent={...e,id:message.id,accountId:'worker',privacyRevision:memoryPrivacyRevision(f.store,'worker',e.userId,e.channel)},old=outbox.prepare({accountId:'worker',kind:'reply',sourceId:message.id,event:oldEvent,text:'旧草稿'});assert.ok(outbox.begin(old.id));memory.links.unlink('worker','dm:111-333');outbox.settle(old.id,{status:'not_submitted',reason:'最终守卫阻止'});
  const fresh={...oldEvent,privacyRevision:memoryPrivacyRevision(f.store,'worker',e.userId,e.channel)},next=outbox.prepare({accountId:'worker',kind:'reply',sourceId:message.id,event:fresh,text:'重新生成'});assert.notEqual(next.id,old.id);assert.ok(f.store.get('outbox:retired:'+old.id));assert.throws(()=>outbox.prepare({id:old.id,accountId:'worker',kind:'reply',sourceId:message.id,event:fresh,text:'重新生成'}));assert.ok(outbox.begin(next.id));outbox.settle(next.id,{status:'unknown'});assert.throws(()=>outbox.prepare({accountId:'worker',kind:'reply',sourceId:message.id,event:{...fresh,privacyRevision:'newer'},text:'第三条'}));assert.equal(outbox.get(next.id)!.status,'unknown');
 }finally{f.close();}
});

test('浏览器等待期间撤销后不提交旧结果，下一轮以新ID按当前范围完成',async()=>{
 const f=fixture();let workflow:Workflow|undefined;try{
  const c=structuredClone(exampleConfig);c.mode='auto';c.replyHours={enabled:false,closeDelayMinutes:30};let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);let calls=0;const sent:string[]=[],ids:string[]=[];
  const generator:any={async converse(...args:any[]){return (fakeConverse as any)(this,...args);},async complete(){return {text:JSON.stringify({action:'reply',text:calls?'新的范围':'ABC123',reason:''}),input:0,output:0,cache:0};}};
  const e=event(),transport:any={identity:async()=>({handle:'worker',loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>({events:[e],warnings:[]}),context:async()=>'',lookup:async()=>({status:'unknown'}),send:async(target:any,text:string)=>{ids.push(target.outboxId);if(calls++===0){entered();await barrier;}const allowed=submissionAllowed(f.store,workflow!.control(),'worker',{handle:'worker',requestId:target.outboxId,sourceId:target.id,targetId:target.platformId,channel:target.channel,privacyRevision:target.privacyRevision,textHash:createHash('sha256').update(text).digest('hex')});if(!allowed)return {status:'not_submitted',reason:'最终守卫阻止'};sent.push(text);return {status:'confirmed',id:'receipt'};}};
  workflow=new Workflow(f.store,transport,generator,()=>c);const memory=new MemoryService(f.store,generator,()=>c);workflow.services={memory,outbox:new Outbox(f.store)};memory.links.link('worker','dm:111-333','x:alice','admin');await workflow.resume();const tick=workflow.tick();await started;memory.links.unlink('worker','dm:111-333');release();await tick;assert.deepEqual(sent,[]);assert.equal(f.store.getMessage(e.id,'worker').status,'queued');assert.equal(f.store.getMessage(e.id,'worker').draft,null);await workflow.tick();assert.deepEqual(sent,['新的范围']);assert.notEqual(ids[0],ids[1]);
 }finally{workflow?.stop();f.close();}
});

for(const state of ['prepared','confirmed','cancelled','rejected','submitting','unknown'] as OutboxStatus[])test('遗忘清理出站副本 '+state+' 并在重启及旧库恢复后保持防重发',()=>{
 const f=fixture();let current=f.store;
 try{
  const outbox=new Outbox(current),memory=new MemoryService(current,{} as any),e={...event(),id:'dm:111-222:privacy',channel:'private' as const,userId:'dm:111-222',text:'合成私信原文',url:'https://x.com/messages/111-222',conversationId:'111-222'};current.ingest(e,'worker');const message=current.getMessage(e.id,'worker');
  const row=outbox.prepare({accountId:'worker',kind:'dm',sourceId:message.id,targetId:e.platformId,event:{...e,id:message.id,accountId:'worker'},text:'合成私信回复'});
  if(state==='cancelled')outbox.cancel(row.id);else if(state!=='prepared'){outbox.begin(row.id);if(state!=='submitting')outbox.settle(row.id,state==='confirmed'?{status:state,id:'receipt'}:{status:state});}
  current.db.exec("VACUUM INTO '"+f.dir+"/old.sqlite'");memory.forget(e.userId,'worker');const redacted=outbox.get(row.id)!;assert.equal(current.getMessage(message.id,'worker'),undefined);assert.equal(JSON.parse(redacted.event!).text,'');assert.ok(!JSON.stringify(redacted).includes(e.text));assert.equal(redacted.status,state==='prepared'?'cancelled':state);
  if(['submitting','unknown'].includes(state)){assert.equal(redacted.text,'合成私信回复');const now=Date.now;Date.now=()=>now()+86400001;try{current.prune(30);}finally{Date.now=now;}assert.equal(outbox.get(row.id)!.text,'');assert.equal(outbox.get(row.id)!.status,state);}else assert.equal(redacted.text,'');
  assert.throws(()=>outbox.prepare({accountId:'worker',kind:'dm',sourceId:message.id,targetId:e.platformId,event:e,text:'合成私信回复'}));
  current.db.close();copyFileSync(f.dir+'/old.sqlite',f.dir+'/workflow.sqlite');current=new Store(f.dir+'/workflow.sqlite');const restored=new Outbox(current).get(row.id)!;assert.equal(JSON.parse(restored.event!).text,'');assert.ok(!JSON.stringify(restored).includes(e.text));if(!['submitting','unknown'].includes(state))assert.equal(restored.text,'');assert.equal(restored.status,state==='prepared'?'cancelled':state);
 }finally{current.db.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('到期出站保留唯一标识但清除完成正文与未知核对材料',()=>{
 const f=fixture();try{const outbox=new Outbox(f.store);for(const status of ['confirmed','unknown'] as const){const e=event();e.id+='-'+status;f.store.ingest(e,'worker');const row=outbox.prepare({accountId:'worker',kind:'reply',sourceId:e.id,targetId:'701',event:e,text:'合成到期正文'});outbox.begin(row.id);outbox.settle(row.id,status==='confirmed'?{status,id:'receipt'}:{status});f.store.db.prepare('UPDATE outbox SET created_at=1 WHERE id=?').run(row.id);f.store.prune(30);assert.equal(outbox.get(row.id)!.text,'');assert.equal(outbox.get(row.id)!.status,status);assert.ok(outbox.source('worker','reply',e.id));}}finally{f.close();}
});

test('恢复记录后的新出站不会被旧遗忘边界重放误清理',()=>{
 const f=fixture();try{const outbox=new Outbox(f.store),memory=new MemoryService(f.store,{} as any),e={...event(),id:'new-private',channel:'private' as const,userId:'dm:111-222'};memory.forget(e.userId,'worker');memory.remember(e.userId,'worker');const at=f.store.nextTimestamp();e.timestamp=at+1;f.store.ingest(e,'worker');const message=f.store.getMessage(e.id,'worker');assert.ok(message);const row=outbox.prepare({accountId:'worker',kind:'dm',sourceId:message.id,event:{...e,id:message.id},text:'允许的新回复'});f.store.replayForgetLedger();assert.equal(outbox.get(row.id)!.text,'允许的新回复');assert.equal(outbox.get(row.id)!.status,'prepared');}finally{f.close();}
});

test('恢复旧库中缺少event的完成出站仍按独立遗忘来源账本清理',()=>{
 const f=fixture();let store=f.store;try{
  const outbox=new Outbox(store),memory=new MemoryService(store,{} as any),e=event();store.ingest(e,'worker');const message=store.getMessage(e.id,'worker'),row=outbox.prepare({accountId:'worker',kind:'reply',sourceId:message.id,targetId:e.platformId,text:'旧库残留回复'});outbox.begin(row.id);outbox.settle(row.id,{status:'confirmed',id:'receipt'});store.db.exec("VACUUM INTO '"+f.dir+"/missing-event.sqlite'");memory.forget(e.userId,'worker');store.db.close();copyFileSync(f.dir+'/missing-event.sqlite',f.dir+'/workflow.sqlite');store=new Store(f.dir+'/workflow.sqlite');assert.equal(store.getMessage(message.id,'worker'),undefined);const restored=new Outbox(store).get(row.id)!;assert.equal(restored.status,'confirmed');assert.equal(restored.text,'');assert.ok(store.forgottenSource('worker','public',message.id,'701'));
 }finally{store.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
