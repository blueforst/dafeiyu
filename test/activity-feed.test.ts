import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';
import { TaskScheduler } from '../src/scheduler.js';
import { ActivityFeed,FeedError } from '../src/activity-feed.js';
import { registerFeedRoutes } from '../src/feed-routes.js';
import { ReplyTriage } from '../src/reply-triage.js';
import type { Channel,Draft,Event } from '../src/types.js';

function fixture(withTriage=false){
 const dir=mkdtempSync(tmpdir()+'/role-feed-'),store=new Store(dir+'/workflow.sqlite'),outbox=new Outbox(store);let account='a';
 new TaskScheduler(store,{account:()=>account,control:()=> 'paused',execute:async()=>{}});
 const now=Date.now(),triage=withTriage?new ReplyTriage(store,undefined,()=>now):undefined;
 const feed=new ActivityFeed(store,()=>account,()=>6,undefined,triage);
 const message=(id:string,channel:Channel='public',status='draft',timestamp=now,accountId='a',draft:Draft={action:'reply',text:'等待确认的正文',reason:'可回复'})=>{
  const e:Event={id,platformId:'platform-'+id,channel,userId:'user-'+id,handle:'handle_'+id,text:'用户原话 '+id,url:'https://x.com/example/status/'+id,conversationId:'thread-'+id,timestamp,timestampReliable:true};
  store.ingest(e,accountId);const row=store.getMessage(id,accountId);store.update(row.id,status,{draft},accountId);return store.getMessage(row.id,accountId);
 };
 const post=(id:string,createdAt=now,status='confirmed',accountId='a')=>{
  const row=outbox.prepare({id,accountId,kind:'post',sourceId:'post-source-'+id,text:'帖子正文 '+id});
  store.db.prepare('UPDATE outbox SET created_at=?,updated_at=?,status=? WHERE id=?').run(createdAt,createdAt,status,row.id);return outbox.get(row.id)!;
 };
 return {store,outbox,feed,triage,message,post,now,setAccount(value:string){account=value;},close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}
function assertConflict(fn:()=>unknown){assert.throws(fn,(e:unknown)=>e instanceof FeedError&&e.statusCode===409);}

test('动态五筛选与待处理数字按工作账号隔离，其他账号和无账号不可读写',()=>{
 const f=fixture();try{
  const reply=f.message('public'),dm=f.message('private','private','confirmed');f.post('greeting');
  const foreign=f.message('other','public','draft',f.now,'b');f.post('other-post',f.now,'unknown','b');
  assert.equal(f.feed.list().items.length,3);assert.equal(f.feed.summary().pending,1);
  assert.deepEqual(f.feed.list({filter:'reply'}).items.map(r=>r.messageId),[reply.id]);
  assert.deepEqual(f.feed.list({filter:'dm'}).items.map(r=>r.messageId),[dm.id]);
  assert.deepEqual(f.feed.list({filter:'post'}).items.map(r=>r.id),['post:greeting']);
  assert.deepEqual(f.feed.list({filter:'pending'}).items.map(r=>r.messageId),[reply.id]);
  const item=f.feed.list({filter:'reply'}).items[0];assert.equal(item.original,'用户原话 public');assert.equal(item.memory.account,'a');assert.equal(item.memory.channel,'public');
  assert.throws(()=>f.feed.mutate(foreign.id,'approve',{text:'不可跨账号',revision:foreign.updated_at}),(e:unknown)=>e instanceof FeedError&&e.statusCode===404);
  f.setAccount('');assert.deepEqual(f.feed.list(),{items:[],nextCursor:null,pending:0});assert.deepEqual(f.feed.summary(),{latest:0,pending:0});
 }finally{f.close();}
});

test('双表稳定游标正确处理相同时间，翻页期间新条目不导致遗漏或重复',()=>{
 const f=fixture();try{
  for(const [id,offset] of [['m-a',0],['m-z',0],['m-old',-1]] as const)f.message(id,'public','confirmed',f.now+offset);
  f.post('p-a',f.now);f.post('p-z',f.now);f.post('p-old',f.now-2);
  const expected=f.feed.list({limit:100}).items.map(r=>r.id),first=f.feed.list({limit:2}),seen=first.items.map(r=>r.id);
  f.message('arrived-later','public','draft',f.now+1000);f.post('arrived-post',f.now+1000);
  let cursor=first.nextCursor;let pages=1;
  while(cursor){assert.ok(++pages<10);const page=f.feed.list({limit:2,cursor});seen.push(...page.items.map(r=>r.id));cursor=page.nextCursor;}
  assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,expected.length);
  assert.equal(f.feed.list({limit:2}).items.every(r=>r.at===f.now+1000),true);
 }finally{f.close();}
});

test('帖子只关联最新一条任务历史，多个运行引用同一出站不会复制动态',()=>{
 const f=fixture();try{
  const post=f.post('one-post');
  for(let i=0;i<2;i++)f.store.db.prepare("INSERT INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at,outbox_id) VALUES(?,'morning-post','a',?,'automatic','completed',?,?)").run('run-'+i,f.now+i,f.now+i,post.id);
  const page=f.feed.list({filter:'post',limit:1});assert.equal(page.items.length,1);assert.equal(page.items[0].runId,'run-1');assert.equal(page.items[0].taskId,'morning-post');assert.equal(page.nextCursor,null);
 }finally{f.close();}
});

test('待处理排除过期草稿/批准/失败/重写，unknown 永久保留且平台时间优先',()=>{
 const f=fixture();try{
  const old=f.now-7*3600000;
  for(const status of ['draft','approved','failed'])f.message('old-'+status,'public',status,old);
  f.message('old-review','public','queued',old,'a',{action:'reply',text:'旧草稿',reason:'',review:true});
  const live=f.message('live-review','public','queued',f.now,'a',{action:'reply',text:'待重写',reason:'',review:true});
  f.message('live-draft');f.message('ordinary-queued','public','queued');f.message('unknown','private','unknown',old);f.post('unknown-post',old,'unknown');
  // created_at 用于时间线排序；草稿过期依据可靠正文里的平台时间。
  f.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(old,live.id);
  const all=f.feed.list({limit:100}),pending=f.feed.list({filter:'pending'});
  assert.equal(pending.items.length,4);assert.equal(f.feed.summary().pending,4);assert.ok(pending.items.some(r=>r.messageId===live.id));
  assert.equal(all.items.find(r=>r.messageId===f.store.getMessage('old-draft','a').id)?.expired,true);
  assert.equal(all.items.find(r=>r.messageId===f.store.getMessage('unknown','a').id)?.expired,false);
  const expired=f.store.getMessage('old-draft','a');assertConflict(()=>f.feed.mutate(expired.id,'approve',{text:'不能发送',revision:expired.updated_at}));
  assertConflict(()=>f.feed.mutate(expired.id,'regenerate',{revision:expired.updated_at}));
 }finally{f.close();}
});

test('批准CAS、取消无修订、重写保留原稿，日志仅含关联元数据',()=>{
 const f=fixture();try{
  let row=f.message('review-me');const original=JSON.parse(row.draft),secret='这是一段不会出现在日志的独特正文';
  assertConflict(()=>f.feed.mutate(row.id,'approve',{text:secret,revision:row.updated_at-1}));
  const approved=f.feed.mutate(row.id,'approve',{text:secret,revision:row.updated_at});assert.equal(approved.status,'approved');assert.ok(approved.revision>row.updated_at);
  row=f.store.getMessage(row.id,'a');const draft=JSON.parse(row.draft);assert.equal(draft.text,secret);assert.equal(draft.edited,true);assert.equal(draft.validation.allowed,true);
  assertConflict(()=>f.feed.mutate(row.id,'approve',{text:'重复批准',revision:approved.revision}));
  // 主循环写入等待原因会推进修订；取消仍只能在 approved 状态原子取回。
  f.store.db.prepare('UPDATE messages SET updated_at=updated_at+1 WHERE id=?').run(row.id);
  assert.equal(f.feed.mutate(row.id,'cancel',{revision:approved.revision}).status,'draft');
  row=f.store.getMessage(row.id,'a');assert.equal(JSON.parse(row.draft).text,secret);
  assertConflict(()=>f.feed.mutate(row.id,'cancel'));
  const regenerated=f.feed.mutate(row.id,'regenerate',{revision:row.updated_at});assert.equal(regenerated.status,'queued');
  row=f.store.getMessage(row.id,'a');const review=JSON.parse(row.draft);assert.equal(review.review,true);assert.equal(review.previous.text,secret);assert.equal(review.previous.previous,undefined);
  assertConflict(()=>f.feed.mutate(row.id,'regenerate',{revision:regenerated.revision}));
  const logs=JSON.stringify(f.store.logs());assert.ok(logs.includes('draft-approve'));assert.ok(logs.includes('draft-cancel'));assert.ok(logs.includes('draft-regenerate'));assert.ok(!logs.includes(secret));assert.ok(!logs.includes(original.text));
 }finally{f.close();}
});

test('正文校验与prepared正文替换在同一事务中完成，未提交出站不触发嵌套事务',()=>{
 const f=fixture();try{
  const row=f.message('prepared');const out=f.outbox.prepare({accountId:'a',kind:'reply',sourceId:row.id,targetId:'target',text:'原草稿'});
  const result=f.feed.mutate(row.id,'approve',{text:'已经批准的新正文',revision:row.updated_at});
  assert.equal(result.status,'approved');assert.equal(f.outbox.get(out.id)?.status,'prepared');assert.equal(f.outbox.get(out.id)?.text,'已经批准的新正文');assert.equal(JSON.parse(f.outbox.get(out.id)!.validation_json!).allowed,true);
  f.feed.mutate(row.id,'cancel');const current=f.store.getMessage(row.id,'a');
  for(const text of ['',null,'x'.repeat(281),'这是链接 https://example.com'])assert.throws(()=>f.feed.mutate(row.id,'approve',{text,revision:current.updated_at}),(e:unknown)=>e instanceof FeedError&&e.statusCode===400);
  assert.equal(f.store.getMessage(row.id,'a').status,'draft');assert.equal(f.outbox.get(out.id)?.text,'已经批准的新正文');
  const dm=f.message('dm-limit','private');assert.equal(f.feed.mutate(dm.id,'approve',{text:'x'.repeat(4000),revision:dm.updated_at}).status,'approved');
  const dmTooLong=f.message('dm-too-long','private');assert.throws(()=>f.feed.mutate(dmTooLong.id,'approve',{text:'x'.repeat(4001),revision:dmTooLong.updated_at}),(e:unknown)=>e instanceof FeedError&&e.statusCode===400);
 }finally{f.close();}
});

test('已进入提交或终态的出站不能再次批准、取消或重写',()=>{
 const f=fixture();try{
  for(const status of ['submitting','confirmed','unknown','rejected','cancelled']){
   const row=f.message('out-'+status),out=f.outbox.prepare({accountId:'a',kind:'reply',sourceId:row.id,targetId:'target',text:'已冻结正文'});
   f.store.db.prepare('UPDATE outbox SET status=? WHERE id=?').run(status,out.id);
   assertConflict(()=>f.feed.mutate(row.id,'approve',{text:'新正文',revision:row.updated_at}));assertConflict(()=>f.feed.mutate(row.id,'regenerate',{revision:row.updated_at}));
   f.store.update(row.id,'approved');assertConflict(()=>f.feed.mutate(row.id,'cancel'));
   assert.equal(f.outbox.get(out.id)?.text,'已冻结正文');assert.equal(f.outbox.get(out.id)?.status,status);
  }
 }finally{f.close();}
});

test('动态路由沿用鉴权与控制标记，冲突可读且只有成功操作唤醒工作流',async()=>{
 const f=fixture(),app=Fastify();let wakes=0;try{
  app.addHook('onRequest',async(req,reply)=>{
   if(req.headers['x-ingress-key']!=='fixture-only-key')return reply.code(401).send({error:'未授权'});
   if(req.method!=='GET'&&req.headers['x-workflow-control']!=='1')return reply.code(403).send({error:'缺少控制标记'});
  });
  registerFeedRoutes(app,{feed:f.feed,wake:()=>{wakes++;}});
  const row=f.message('route'),url='/api/messages/'+encodeURIComponent(row.id)+'/approve',headers={'x-ingress-key':'fixture-only-key','x-workflow-control':'1'};
  assert.equal((await app.inject('/api/feed')).statusCode,401);assert.equal((await app.inject({method:'POST',url,headers:{'x-ingress-key':'fixture-only-key'},payload:{}})).statusCode,403);
  const read=await app.inject({url:'/api/feed?filter=pending',headers});assert.equal(read.statusCode,200);assert.equal(read.json().items.length,1);assert.equal(wakes,0);
  const stale=await app.inject({method:'POST',url,headers,payload:{text:'批准内容',revision:row.updated_at-1}});assert.equal(stale.statusCode,409);assert.equal(stale.json().current,'draft');assert.equal(wakes,0);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{text:'批准内容',revision:row.updated_at}})).statusCode,200);assert.equal(wakes,1);
  assert.equal((await app.inject({url:'/api/feed?filter=bad',headers})).statusCode,400);assert.equal((await app.inject({url:'/api/feed?cursor=bad',headers})).statusCode,400);assert.equal((await app.inject({url:'/api/feed?limit=NaN',headers})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url,headers,payload:[]})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/messages/missing/approve',headers,payload:{text:'不执行',revision:1}})).statusCode,404);assert.equal(wakes,1);
 }finally{await app.close();f.close();}
});

test('接入分级后动态待处理复用优先/普通资格，排除各级过期、忽略、遗忘与外账号且纯只读',()=>{
 const f=fixture(true);try{
  const priority=f.message('priority-four-hours','public','queued',f.now-4*3600000),normal=f.message('normal-two-hours','private','queued',f.now-2*3600000);
  f.message('normal-expired','public','queued',f.now-4*3600000);
  const priorityExpired=f.message('priority-expired','public','queued',f.now-7*3600000),ignored=f.message('ignored-fresh','public','queued'),forgotten=f.message('forgotten-fresh','private','queued');
  const globalForgotten=f.message('global-forgotten','public','queued'),foreign=f.message('foreign-priority','public','queued',f.now,'b');
  for(const row of [priority,priorityExpired,foreign])f.store.db.prepare("UPDATE messages SET tier='priority' WHERE id=?").run(row.id);
  for(const row of [normal,ignored,forgotten,globalForgotten])f.store.db.prepare("UPDATE messages SET tier='normal' WHERE id=?").run(row.id);
  f.store.db.prepare("INSERT INTO triage_ignores VALUES('a',?,'public',?,'骚扰冷却','[]')").run(ignored.user_id,f.now+3600000);
  f.store.db.prepare("UPDATE account_users SET forgot=1 WHERE account_id='a' AND id=?").run(forgotten.user_id);
  f.store.db.prepare('INSERT INTO users(id,forgot,epoch) VALUES(?,1,1)').run(globalForgotten.user_id);
  const snapshot=()=>JSON.stringify({messages:f.store.db.prepare('SELECT * FROM messages ORDER BY id').all(),runtime:f.store.db.prepare('SELECT * FROM runtime ORDER BY key').all(),logs:f.store.logs()});
  const before=snapshot(),pending=f.feed.list({filter:'pending'}),summary=f.feed.summary();
  assert.deepEqual(new Set(pending.items.map(r=>r.messageId)),new Set([priority.id,normal.id]));assert.equal(pending.pending,2);assert.equal(summary.pending,pending.items.length);
  assert.equal(f.triage!.healthQueue('a',6).public?.count,1);assert.equal(f.triage!.healthQueue('a',6).private?.count,1);assert.equal(snapshot(),before);
  // 未接入分级的旧独立 feed 仍只把复核 queued 计入待处理。
  const independent=new ActivityFeed(f.store,()=> 'a',()=>6);assert.equal(independent.summary().pending,0);
 }finally{f.close();}
});

test('分级待处理的双表游标与计数一致，新排队消息只出现在新的第一页',()=>{
 const f=fixture(true);try{
  const a=f.message('queued-a','public','queued',f.now-1000),b=f.message('queued-b','private','queued',f.now-1000),old=f.message('queued-old','public','queued',f.now-2000);
  f.store.db.prepare("UPDATE messages SET tier='priority' WHERE id IN (?,?)").run(a.id,old.id);f.store.db.prepare("UPDATE messages SET tier='normal' WHERE id=?").run(b.id);
  f.post('pending-post',f.now-1000,'unknown');f.message('excluded-stale','public','queued',f.now-4*3600000);f.message('excluded-other','private','queued',f.now,'b');
  const expected=f.feed.list({filter:'pending',limit:100}).items.map(r=>r.id),first=f.feed.list({filter:'pending',limit:2}),seen=first.items.map(r=>r.id);
  assert.equal(first.pending,expected.length);assert.equal(expected.length,4);
  const arrival=f.message('queued-arrival','public','queued',f.now);f.store.db.prepare("UPDATE messages SET tier='normal' WHERE id=?").run(arrival.id);
  let cursor=first.nextCursor,rounds=0;while(cursor){assert.ok(rounds++<10);const page=f.feed.list({filter:'pending',limit:2,cursor});seen.push(...page.items.map(r=>r.id));assert.equal(page.pending,5);cursor=page.nextCursor;}
  assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,expected.length);assert.equal(f.feed.summary().pending,5);assert.equal(f.feed.list({filter:'pending',limit:100}).items.length,5);assert.equal(f.feed.list({filter:'pending',limit:1}).items[0].messageId,arrival.id);
 }finally{f.close();}
});
