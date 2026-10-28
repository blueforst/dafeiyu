import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';
import { TaskScheduler } from '../src/scheduler.js';
import { ReplyTriage } from '../src/reply-triage.js';
import { ActivityFeed } from '../src/activity-feed.js';
import { registerFeedRoutes } from '../src/feed-routes.js';
import type { Event } from '../src/types.js';

function fixture(){
 const dir=mkdtempSync(tmpdir()+'/feed-conversations-'),store=new Store(dir+'/workflow.sqlite'),outbox=new Outbox(store),now=Date.now();let account='worker',sequence=100000;
 new TaskScheduler(store,{account:()=>account,control:()=> 'paused',execute:async()=>{}});
 const triage=new ReplyTriage(store,undefined,()=>now),imports={pending:1,latest:now-10};
 const feed=new ActivityFeed(store,()=>account,()=>6,undefined,triage,()=>imports);
 const message=(user='x:alice',status='confirmed',sortAt=now,options:{account?:string;created?:number;tier?:string;review?:boolean;text?:string}={})=>{
  const id=String(++sequence),channel=user.startsWith('dm:')?'private':'public',created=options.created??now;
  const event:Event={id:'x:'+id,platformId:id,userId:user,channel,handle:channel==='public'?user.slice(2):'',text:options.text??'用户原话 '+id,timestamp:created,timestampReliable:true,conversationId:channel==='private'?user.slice(3):id};
  store.ingest(event,options.account??account);const row=store.getMessage(event.id,options.account??account);assert.ok(row);
  store.db.prepare('UPDATE messages SET status=?,draft=?,created_at=?,ingested_at=?,updated_at=?,tier=?,tier_reason=? WHERE id=?').run(status,JSON.stringify({action:'reply',text:'回复 '+id,reason:'',...(options.review?{review:true}:{})}),created,sortAt,sortAt,options.tier??'normal','分级原因',row.id);
  return store.getMessage(row.id);
 };
 const post=(id:string,at=now,status='confirmed',acct=account)=>{const row=outbox.prepare({id,accountId:acct,kind:'post',sourceId:id,text:'角色帖子 '+id});store.db.prepare('UPDATE outbox SET created_at=?,updated_at=?,status=? WHERE id=?').run(at,at,status,id);return row;};
 const task=(id:string,status='skipped',at=now,acct=account,outboxId:string|null=null)=>store.db.prepare("INSERT INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at,finished_at,detail,outbox_id) VALUES(?,'morning-post',?,?,'automatic',?,?,?,?,?)").run(id,acct,at,status,at,at+1,'早安任务说明',outboxId);
 const snapshot=()=>{const tables=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(r=>r.name);return JSON.stringify(tables.map(name=>[name,store.db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));};
 return {store,feed,triage,imports,message,post,task,snapshot,now,setAccount(value:string){account=value;},close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('身份会话与角色帖隔离、入库时间排序、私信占位名和外部文字按原样返回',()=>{
 const f=fixture();try{
  f.message('x:alice','confirmed',f.now-1000,{created:f.now-99999,text:'<script>外部文字</script>'});f.message('dm:alice-session','confirmed',f.now-500);f.message('x:alice','draft',f.now-100,{created:f.now-10000});
  f.message('x:foreign','unknown',f.now+1000,{account:'other'});f.post('foreign-post',f.now+2000,'unknown','other');
  f.post('morning',f.now-200);f.task('linked','completed',f.now-199,'worker','morning');f.task('missed','missed',f.now-50);f.task('foreign-task','failed',f.now+3000,'other');
  const all=f.feed.conversations();assert.deepEqual(all.items.map(r=>r.key),['posts','x:alice','dm:alice-session']);
  assert.equal(all.items[1].total,2);assert.equal(all.items[2].title,'私信 · sion');assert.equal(all.items[1].latestAt,f.now-100);
  const alice=f.feed.conversationItems('x:alice');assert.equal(alice.items[0].original,'<script>外部文字</script>');assert.equal(alice.items[0].sortAt,f.now-1000);assert.equal(alice.items[0].tier,'normal');assert.equal(alice.items[0].tierReason,'分级原因');assert.equal(alice.total,2);
  const posts=f.feed.conversationItems('posts');assert.equal(posts.items.length,2);assert.equal(posts.items[0].runId,'linked');assert.equal(posts.items[1].taskOnly,true);assert.equal(posts.items[1].status,'missed');
  f.setAccount('');assert.equal(f.feed.conversations().items.length,0);assert.equal(f.feed.conversationItems('x:alice').items.length,0);
 }finally{f.close();}
});

test('会话状态按待回查、有效失败、草稿重写、批准、排队优先且状态更新不改变排序',()=>{
 const f=fixture();try{
  const list=[['unknown',1],['failed',2],['draft',3],['approved',4],['queued',5],['confirmed',6]] as const;
  for(const [status,i] of list)f.message('x:alice',status,f.now-i);
  let row=f.feed.conversations().items[0];assert.equal(row.status,'unknown');const latestAt=row.latestAt;
  const unknown=f.store.db.prepare("SELECT id FROM messages WHERE status='unknown'").get() as any;f.store.db.prepare("UPDATE messages SET status='confirmed',updated_at=? WHERE id=?").run(f.now+100,unknown.id);
  row=f.feed.conversations().items[0];assert.equal(row.status,'failed');assert.equal(row.latestAt,latestAt);
  f.store.db.prepare("UPDATE messages SET status='confirmed' WHERE status='failed'").run();assert.equal(f.feed.conversations().items[0].status,'draft');
  f.store.db.prepare("UPDATE messages SET status='confirmed' WHERE status='draft'").run();assert.equal(f.feed.conversations().items[0].status,'approved');
  f.store.db.prepare("UPDATE messages SET status='confirmed' WHERE status='approved'").run();assert.equal(f.feed.conversations().items[0].status,'queued');
  f.message('x:expired','draft',f.now-10,{created:f.now-7*3600000});assert.equal(f.feed.conversations({filter:'pending'}).items.some(r=>r.key==='x:expired'),false);
 }finally{f.close();}
});

test('五种筛选复用待处理口径，总数包含待补录且角色任务不增加待处理',()=>{
 const f=fixture();try{
  f.message('x:alice','draft',f.now-3);f.message('dm:1234','unknown',f.now-2);f.message('x:bob','queued',f.now-1);f.post('pending',f.now,'unknown');f.task('no-post','failed',f.now+1);
  assert.equal(f.feed.conversations({filter:'public'}).items.length,2);assert.equal(f.feed.conversations({filter:'private'}).items.length,1);assert.equal(f.feed.conversations({filter:'posts'}).items.length,1);
  const pending=f.feed.conversations({filter:'pending'});assert.equal(pending.items.length,4);assert.equal(pending.pending,5);assert.equal(pending.importsPending,1);assert.equal(pending.pending,f.feed.summary().pending);
 }finally{f.close();}
});

test('会话键集分页在新会话插入后不重复遗漏，同时间按身份键稳定排序',()=>{
 const f=fixture();try{
  for(const [key,at] of [['x:alice',f.now],['x:bob',f.now],['x:ceyi',f.now-1],['dm:4444',f.now-2]] as const)f.message(key,'confirmed',at);
  const expected=f.feed.conversations({limit:100}).items.map(r=>r.key),first=f.feed.conversations({limit:2}),seen=first.items.map(r=>r.key);let cursor=first.nextCursor;
  f.message('x:newuser','draft',f.now+1000);
  // 未浏览的旧会话收到新消息也不能从后续分页消失；新位置由增量读取合并。
  f.message('dm:4444','draft',f.now+2000);
  while(cursor){const page=f.feed.conversations({limit:2,cursor});seen.push(...page.items.map(r=>r.key));cursor=page.nextCursor;}
  assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,seen.length);
 }finally{f.close();}
});

test('往来分页按正序返回，旧数据入库时间为零时回退平台时间，含新变化可增量读取',()=>{
 const f=fixture();try{
  const rows=Array.from({length:7},(_,i)=>f.message('x:alice','confirmed',f.now-100+i));
  f.store.db.prepare('UPDATE messages SET ingested_at=0,created_at=? WHERE id=?').run(f.now-200,rows[0].id);
  const first=f.feed.conversationItems('x:alice',{limit:3});assert.deepEqual(first.items.map(r=>r.messageId),rows.slice(4).map(r=>r.id));assert.equal(first.firstAt,f.now-200);
  const second=f.feed.conversationItems('x:alice',{limit:3,before:first.nextBefore!}),third=f.feed.conversationItems('x:alice',{limit:3,before:second.nextBefore!});
  assert.deepEqual([...third.items,...second.items,...first.items].map(r=>r.messageId),rows.map(r=>r.id));
  f.store.db.prepare('UPDATE messages SET updated_at=?,status=? WHERE id=?').run(f.now+1,'unknown',rows[1].id);
  const updated=f.feed.conversationItems('x:alice',{changedSince:f.now,before:first.nextBefore!});assert.equal(updated.items.length,1);assert.equal(updated.items[0].messageId,rows[1].id);assert.equal(updated.items[0].status,'unknown');assert.equal(updated.nextBefore,null);
 }finally{f.close();}
});

test('changedSince覆盖已翻页会话、待处理消失标识且增量不受limit截断',()=>{
 const f=fixture();try{
  const rows=Array.from({length:5},(_,i)=>f.message('x:user'+i,'draft',f.now-100-i));
  const first=f.feed.conversations({filter:'pending',limit:2});assert.ok(first.nextCursor);
  for(const row of rows)f.store.db.prepare("UPDATE messages SET status='confirmed',updated_at=? WHERE id=?").run(f.now+10,row.id);
  const changed=f.feed.conversations({filter:'pending',changedSince:f.now,limit:1,cursor:first.nextCursor!});assert.equal(changed.items.length,0);assert.equal(changed.removedKeys.length,5);assert.equal(changed.pending,1);
  const all=f.feed.conversations({changedSince:f.now,limit:1});assert.equal(all.items.length,5);assert.equal(all.nextCursor,null);
 }finally{f.close();}
});

test('仅时效流逝也能在待处理增量中移除会话，不要求消息有写入',t=>{
 const f=fixture();try{
  f.message('x:almostold','draft',f.now-100,{created:f.now-6*3600000+1000});
  assert.equal(f.feed.conversations({filter:'pending'}).items.length,1);
  t.mock.method(Date,'now',()=>f.now+2000);
  const changed=f.feed.conversations({filter:'pending',changedSince:f.now+1000});
  assert.equal(changed.items.length,0);assert.deepEqual(changed.removedKeys,['x:almostold']);assert.equal(changed.pending,1);
  const items=f.feed.conversationItems('x:almostold',{changedSince:f.now+1000});assert.equal(items.items.length,1);assert.equal(items.items[0].expired,true);
 }finally{t.mock.restoreAll();f.close();}
});

test('只读会话路由沿用鉴权，无写入、唤醒、模型或浏览器副作用，非法参数400',async()=>{
 const f=fixture(),app=Fastify();let wakes=0;try{
  f.message('x:alice','draft');f.task('empty-greeting','skipped');const before=f.snapshot();
  app.addHook('onRequest',async(req,reply)=>{if(req.headers.authorization!=='fixture')return reply.code(401).send({error:'未授权'});});
  registerFeedRoutes(app,{feed:f.feed,wake:()=>{wakes++;}});const headers={authorization:'fixture'};
  assert.equal((await app.inject('/api/feed/conversations')).statusCode,401);
  for(const url of ['/api/feed/conversations','/api/feed/conversations/x%3Aalice/items','/api/feed/conversations/posts/items'])assert.equal((await app.inject({url,headers})).statusCode,200);
  for(const url of ['/api/feed/conversations?filter=bad','/api/feed/conversations?cursor=bad','/api/feed/conversations?limit=NaN','/api/feed/conversations?changedSince=-1','/api/feed/conversations/bad/items','/api/feed/conversations/x%3Aalice/items?before=bad','/api/feed/conversations/x%3Aalice/items?changedSince=NaN'])assert.equal((await app.inject({url,headers})).statusCode,400,url);
  assert.equal(wakes,0);assert.equal(f.snapshot(),before);
 }finally{await app.close();f.close();}
});

test('没有出站的任务会触发动态latest更新，但不改变待处理口径',()=>{
 const f=fixture();try{
  const old=f.feed.summary();f.task('new-task','missed',f.now+1000);const summary=f.feed.summary();assert.ok(summary.latest>old.latest);assert.equal(summary.pending,old.pending);
 }finally{f.close();}
});
