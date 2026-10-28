import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';
import { TaskScheduler } from '../src/scheduler.js';
import { ReplyTriage } from '../src/reply-triage.js';
import { ActivityFeed,FeedError } from '../src/activity-feed.js';
import {replyWindow} from '../src/reply-hours.js';
import type { Event } from '../src/types.js';

const initial=Date.parse('2026-10-28T12:00:00+08:00');
function fixture(){
 const dir=mkdtempSync(tmpdir()+'/feed-robustness-'),store=new Store(dir+'/workflow.sqlite');let clock=initial,account='alpha',sequence=800000;
 new Outbox(store);new TaskScheduler(store,{account:()=>account,control:()=> 'paused',execute:async()=>{}});
 const triage=new ReplyTriage(store,undefined,()=>clock),feed=new ActivityFeed(store,()=>account,()=>6,undefined,triage);
 const message=(userId='x:alice',status='confirmed',receivedAt=clock,sortAt=clock,acct=account)=>{
  const platformId=String(++sequence),channel=userId.startsWith('dm:')?'private':'public';
  const event:Event={id:'x:'+platformId,platformId,userId,channel,handle:channel==='public'?userId.slice(2):'',text:acct+' 原话 '+platformId,timestamp:receivedAt,timestampReliable:true,conversationId:channel==='private'?userId.slice(3):platformId};
  store.ingest(event,acct);const row=store.getMessage(event.id,acct);assert.ok(row);
  store.db.prepare('UPDATE messages SET status=?,draft=?,created_at=?,ingested_at=?,updated_at=?,tier=? WHERE id=?').run(status,JSON.stringify({action:'reply',text:acct+' 回复 '+platformId,reason:''}),receivedAt,sortAt,sortAt,'normal',row.id);
  return store.getMessage(row.id);
 };
 const changes=()=>Number((store.db.prepare('SELECT total_changes() value').get() as any).value);
 return {store,feed,triage,message,changes,now:()=>clock,setTime(value:number){clock=value;},setAccount(value:string){account=value;},close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('普通筛选的会话增量包含自然过期的草稿徽标与优先状态变化',t=>{
 const f=fixture();t.mock.method(Date,'now',f.now);try{
  f.message('x:alice','draft',initial-6*3600000+1000,initial-100);f.message('x:alice','confirmed',initial,initial-10);
  const first=f.feed.conversations();assert.equal(first.items[0].status,'draft');assert.equal(first.items[0].pending,1);const changes=f.changes();
  f.setTime(initial+2000);const delta=f.feed.conversations({filter:'all',changedSince:first.serverTime});
  assert.equal(delta.items.length,1,'没有写入updated_at，刚过期的会话也必须增量更新');assert.equal(delta.items[0].key,'x:alice');assert.equal(delta.items[0].status,'confirmed');assert.equal(delta.items[0].pending,0);assert.equal(f.changes(),changes);
 }finally{t.mock.restoreAll();f.close();}
});

test('普通消息跨三小时时效时左栏增量与待处理总数同时更新',t=>{
 const f=fixture();t.mock.method(Date,'now',f.now);try{
  f.message('x:alice','queued',initial-3*3600000+1000,initial-100);f.message('x:alice','confirmed',initial,initial-10);
  const first=f.feed.conversations();assert.equal(first.items[0].status,'queued');assert.equal(first.pending,1);
  f.setTime(initial+2000);const delta=f.feed.conversations({filter:'public',changedSince:first.serverTime});
  assert.equal(delta.pending,0);assert.equal(delta.items.length,1,'普通队列资格变化需要更新已加载的公开会话');assert.equal(delta.items[0].pending,0);assert.equal(delta.items[0].status,'confirmed');
 }finally{t.mock.restoreAll();f.close();}
});

test('损坏的旧消息正文以未知和过期显示，不使只读列表或往来查询崩溃',t=>{
 const f=fixture();t.mock.method(Date,'now',f.now);try{
  const row=f.message('x:alice','draft');f.store.db.prepare('UPDATE messages SET body=? WHERE id=?').run('{',row.id);
  const before=f.changes();assert.doesNotThrow(()=>f.feed.conversations());const detail=f.feed.conversationItems('x:alice');assert.equal(detail.items.length,1);assert.equal(detail.items[0].expired,true);assert.equal(detail.items[0].original,undefined);assert.equal(f.changes(),before);
 }finally{t.mock.restoreAll();f.close();}
});

test('夜间关闭暂停队列时效，次日开放越界一毫秒才更新会话增量',t=>{
 const f=fixture();t.mock.method(Date,'now',f.now);try{
  const start=Date.parse('2026-10-28T23:29:00+08:00'),opened=Date.parse('2026-10-29T08:00:00+08:00');f.setTime(start);
  f.triage.closures=()=>{const window=replyWindow({now:f.now(),morning:{enabled:false,time:'08:00'},eveningTime:'23:00'});return window.agePolicy??window.closures;};
  f.message('x:alice','queued',Date.parse('2026-10-28T20:30:00+08:00'),start-100);f.message('x:alice','confirmed',start,start-10);
  const first=f.feed.conversations();assert.equal(first.pending,1);const writes=f.changes();
  f.setTime(opened-1);const overnight=f.feed.conversations({changedSince:first.serverTime});assert.equal(overnight.pending,1);assert.equal(overnight.items.length,0,'夜间墙钟时间不能使队列过期');
  f.setTime(opened);assert.equal(f.feed.conversations({changedSince:overnight.serverTime}).pending,1,'恰好三小时仍可处理');
  f.setTime(opened+1);const delta=f.feed.conversations({changedSince:overnight.serverTime});assert.equal(delta.pending,0);assert.equal(delta.items.length,1);assert.equal(delta.items[0].status,'confirmed');assert.equal(f.changes(),writes);
 }finally{t.mock.restoreAll();f.close();}
});

test('同毫秒往来游标与大小写身份键分页保持确定顺序，非法游标始终400',t=>{
 const f=fixture();t.mock.method(Date,'now',f.now);try{
  for(const key of ['x:a','x:A','x:z','dm:0001'])for(let i=0;i<3;i++)f.message(key,'confirmed',initial,initial);
  const expected=f.feed.conversations({limit:100}).items.map(r=>r.key),seen:string[]=[];let cursor:string|null|undefined;
  do{const page=f.feed.conversations({limit:1,...(cursor?{cursor}:{})});seen.push(...page.items.map(r=>r.key));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,4);
  const full=f.feed.conversationItems('x:a',{limit:100}).items.map(r=>r.id),all:string[]=[];let before:string|null|undefined;
  do{const page=f.feed.conversationItems('x:a',{limit:1,...(before?{before}:{})});all.unshift(...page.items.map(r=>r.id));before=page.nextBefore;}while(before);
  assert.deepEqual(all,full);
  const bad=[null,[],{},-1,1.5,Number.MAX_SAFE_INTEGER+1,'',Buffer.from(JSON.stringify({at:initial,key:'x:a',snapshotAt:initial-1})).toString('base64url')];
  for(const value of bad)assert.throws(()=>f.feed.conversations({cursor:value as any}),(error:unknown)=>error instanceof FeedError&&error.statusCode===400);
 }finally{t.mock.restoreAll();f.close();}
});

test('1000次受控状态更新与账号切换不丢增量、不重复身份、读取不写库',t=>{
 const f=fixture();t.mock.method(Date,'now',f.now);try{
  const rows=new Map<string,any[]>();for(const account of ['alpha','beta'])rows.set(account,Array.from({length:8},(_,i)=>f.message(i%2?'dm:conv'+i:'x:user'+i,'confirmed',initial,initial-100+i,account)));
  const statuses=['draft','approved','unknown','confirmed'] as const,views=new Map<string,Map<string,any>>(),watermarks=new Map<string,number>();
  for(let i=0;i<1000;i++){
   const account=i%2?'beta':'alpha',row=rows.get(account)![Math.floor(i/2)%8];f.setAccount(account);f.setTime(initial+i+1);
   f.store.db.prepare('UPDATE messages SET status=?,updated_at=? WHERE id=?').run(statuses[Math.floor(i/2)%statuses.length],f.now(),row.id);
   const readChanges=f.changes(),result=f.feed.conversations({changedSince:watermarks.get(account)??0,limit:1}),view=views.get(account)??new Map<string,any>();
   for(const item of result.items){view.set(item.key,item);assert.ok(item.preview.startsWith(account));}for(const key of result.removedKeys)view.delete(key);
   const delta=f.feed.conversationItems(row.user_id,{changedSince:watermarks.get(account)??0});assert.ok(delta.items.some(item=>item.messageId===row.id));assert.ok(delta.items.every(item=>item.memory.account===account));
   const authoritative=f.feed.conversations({limit:100});assert.equal(authoritative.pending,result.pending);assert.equal(view.size,8);for(const item of authoritative.items)assert.deepEqual(view.get(item.key),item);
   assert.equal(f.changes(),readChanges,'只读查询不得改变日志、运行时键或业务数据');views.set(account,view);watermarks.set(account,result.serverTime);
  }
 }finally{t.mock.restoreAll();f.close();}
});
