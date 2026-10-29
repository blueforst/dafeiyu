import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { DEFAULT_TRIAGE_SETTINGS,ReplyTriage,classify,normalizeTriageSettings } from '../src/reply-triage.js';
import { Workflow } from '../src/workflow.js';
import { Outbox } from '../src/outbox.js';
import { exampleConfig } from './config-fixture.js';
import type { Event,Channel } from '../src/types.js';
import type { Config } from '../src/types.js';
import type { Transport } from '../src/transport.js';

const NOW=Date.parse('2026-10-28T10:00:00.000Z');
const history=(patch:Record<string,unknown>={})=>({totalCount:0,processedCount:0,recentOtherConversation:false,...patch});
function event(id:string,text='这是一个有内容的普通消息',patch:Partial<Event>={}):Event {
 return {id,platformId:id,channel:'public',userId:'user-'+id,handle:'handle_'+id,text,url:'https://x.com/u/status/'+id,conversationId:'thread-1',timestamp:NOW,timestampReliable:true,...patch};
}
function fixture(raw:Record<string,unknown>={}) {
 const dir=mkdtempSync(tmpdir()+'/role-triage-'),store=new Store(dir+'/workflow.sqlite');
 // 数据库迁移在独立样本上执行，绝不引用生产配置或浏览器。
 store.db.exec(`CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,channel TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL DEFAULT '',event TEXT,text TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,created_at INTEGER NOT NULL,submitted_at INTEGER,updated_at INTEGER NOT NULL,UNIQUE(account_id,kind,source_id));`);
 let clock=NOW,settings=normalizeTriageSettings({...DEFAULT_TRIAGE_SETTINGS,...raw});
 const triage=new ReplyTriage(store,()=>settings,()=>clock);
 return {store,triage,now:(at:number)=>{clock=at;},settings:(patch:Record<string,unknown>)=>{settings=normalizeTriageSettings({...settings,...patch});},row:(id:string,account='worker')=>store.getMessage(id,account),close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('私信二十四小时窗口使用开区间下界、闭区间上界，拒绝与重复不计',()=>{
 const f=fixture();try{
  const add=(id:string,status:string,at:number,account='worker')=>f.store.db.prepare('INSERT INTO outbox(id,account_id,channel,kind,source_id,target_id,text,status,created_at,submitted_at,updated_at) VALUES(?,?,\'private\',\'dm\',?,?,\'历史私信\',?,?,?,?)').run(id,account,id,'target',status,at,at,at);
  add('boundary','confirmed',NOW-24*3600000);add('within','confirmed',NOW-24*3600000+1);add('submitting','submitting',NOW-1000);add('unknown','unknown',NOW);add('future','confirmed',NOW+1);add('rejected','rejected',NOW);add('foreign','confirmed',NOW,'other');
  assert.equal(f.triage.privateRecentCount('worker'),3);
  const legacy=event('legacy-private','旧私信',{channel:'private'});f.store.ingest(legacy,'worker');const row=f.row('legacy-private');f.store.update(row.id,'confirmed');f.store.db.prepare('UPDATE messages SET updated_at=? WHERE id=?').run(NOW,row.id);assert.equal(f.triage.privateRecentCount('worker'),4);
  f.store.db.prepare('UPDATE outbox SET source_id=? WHERE id=\'within\'').run(row.id);assert.equal(f.triage.privateRecentCount('worker'),3);
  assert.equal(f.triage.summary('worker').privateRecent,3);assert.equal(f.triage.summary('worker').privatePerDay,400);
  const base={accountId:'worker',mode:'auto' as const,publicPerHour:10,privatePerHour:30,publicPerDay:180,privatePerDay:3,cooldown:()=>0,hourlyCount:()=>0,unknown:()=>false};
  assert.deepEqual(f.triage.allowedChannels(base),['public']);assert.deepEqual(f.triage.allowedChannels({...base,mode:'draft'}),['public','private']);
 }finally{f.close();}
});

test('分级有效时效扣除关闭区间，开放后积压满三小时才过期',()=>{
 const f=fixture();try{
  const at=(s:string)=>Date.parse(s+'+08:00'),opened=at('2026-10-29T08:00:00');f.now(opened+30*60000);f.triage.closures=()=>[{start:at('2026-10-28T23:30:00'),end:opened}];
  for(const [id,time] of [['before','2026-10-28T23:10:00'],['overnight','2026-10-29T02:00:00'],['expired','2026-10-28T20:00:00']] as const)f.triage.ingest(event(id,'hi',{timestamp:at(time)}),'worker');
  f.triage.refreshQueued('worker');assert.deepEqual(f.triage.pending(10,'worker',['public']).map(row=>JSON.parse(row.body).platformId),['overnight','before']);assert.equal(f.row('expired').status,'skipped');assert.equal(f.triage.healthQueue('worker').public?.count,2);
  f.now(opened+3*3600000+1);assert.deepEqual(f.triage.pending(10,'worker',['public']),[]);assert.equal(f.row('before').status,'skipped');assert.equal(f.row('overnight').status,'skipped');
 }finally{f.close();}
});

test('ignoreAge 为试聊显式豁免，默认生产资格仍排除过期消息',()=>{
 const f=fixture();try{
  f.triage.ingest(event('old-chat','这是超过时效的试聊消息',{timestamp:NOW-24*3600000}),'worker');f.triage.refreshQueued('worker',6,{ignoreAge:true});
  const ignored=f.triage.queuedEligibility(6,{ignoreAge:true}),normal=f.triage.queuedEligibility(6);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages m WHERE '+normal.sql).get(...normal.params)!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages m WHERE '+ignored.sql).get(...ignored.params)!.n,1);
  assert.equal(f.triage.pending(10,'worker',['public'],6,{ignoreAge:true}).length,1);assert.equal(f.row('old-chat').status,'queued');assert.equal(f.triage.pending(10,'worker',['public']).length,0);assert.equal(f.row('old-chat').status,'skipped');
 }finally{f.close();}
});

test('新人招呼、老面孔招呼和正常来访按确定性规则分级',()=>{
 assert.equal(classify(event('1','hi'),history(),DEFAULT_TRIAGE_SETTINGS).tier,'normal');
 assert.equal(classify(event('2','在吗？'),history({totalCount:4,processedCount:3}),DEFAULT_TRIAGE_SETTINGS).tier,'skip');
 assert.equal(classify(event('3','我今天完成了一幅画'),history(),DEFAULT_TRIAGE_SETTINGS).tier,'priority');
 assert.equal(classify(event('4','这幅画用了蓝色'),history({totalCount:5,processedCount:3}),DEFAULT_TRIAGE_SETTINGS).tier,'priority');
 assert.equal(classify(event('5','你觉得应该怎么选择颜色？'),history({totalCount:1,processedCount:1}),DEFAULT_TRIAGE_SETTINGS).tier,'priority');
 assert.equal(classify(event('6','蓝色很好看'),history({totalCount:1,processedCount:1}),DEFAULT_TRIAGE_SETTINGS).tier,'normal');
 assert.equal(classify(event('7','蓝色很好看'),history({totalCount:4,processedCount:3,recentOtherConversation:true}),DEFAULT_TRIAGE_SETTINGS).tier,'normal');
});

test('广告过滤要求关键词与广告结构，不能只因有链接而过滤',()=>{
 assert.equal(classify(event('1','快来领取空投 https://example.com'),history(),DEFAULT_TRIAGE_SETTINGS).tier,'filtered');
 assert.equal(classify(event('2','这张画的参考资料 https://example.com'),history(),DEFAULT_TRIAGE_SETTINGS).tier,'priority');
 assert.equal(classify(event('3','https://example.com'),history(),DEFAULT_TRIAGE_SETTINGS).tier,'priority');
 assert.equal(classify(event('4','@someone #今日推荐 空投'),history(),DEFAULT_TRIAGE_SETTINGS).tier,'filtered');
 assert.notEqual(classify(event('5','我不喜欢空投广告'),history(),DEFAULT_TRIAGE_SETTINGS).tier,'filtered');
});

test('重点账号使用完整 handle 与私信会话精确匹配，设置变化能重排仍在等待的消息',()=>{
 const settings=normalizeTriageSettings({...DEFAULT_TRIAGE_SETTINGS,priorityPublicHandles:['@Alice'],priorityPrivateConversations:['private-A']});
 assert.equal(classify(event('1','在吗',{handle:'ALICE'}),history({totalCount:2}),settings).tier,'priority');
 assert.equal(classify(event('2','在吗',{handle:'alice_other'}),history({totalCount:2}),settings).tier,'skip');
 assert.equal(classify(event('3','在吗',{channel:'private',handle:'Alice',conversationId:'other'}),history({totalCount:2}),settings).tier,'skip');
 assert.equal(classify(event('4','在吗',{channel:'private',conversationId:'private-A'}),history({totalCount:2}),settings).tier,'priority');
 const f=fixture();try{
  f.triage.ingest(event('wait','hi',{handle:'alice'}),'worker');assert.equal(f.row('wait').tier,'normal');
  f.settings({priorityPublicHandles:['alice']});f.triage.refreshQueued('worker');assert.equal(f.row('wait').tier,'priority');
 }finally{f.close();}
});

test('第三个不同用户的同文消息只降普通优先级，其他账号与短招呼不误伤',()=>{
 const f=fixture();try{
  f.triage.ingest(event('1','@worker 这是同一个批量复制的消息！'),'worker');
  f.triage.ingest(event('2','这是同一个批量复制的消息'),'worker');
  assert.equal(f.row('1').status,'queued');
  f.triage.ingest(event('other','这是同一个批量复制的消息'),'another');
  f.triage.ingest(event('3','这是同一个批量复制的消息。'),'worker');
  for(const id of ['1','2','3']){assert.equal(f.row(id).status,'queued');assert.equal(f.row(id).tier,'normal');assert.equal(f.row(id).tier_reason,'同文重复，降低优先级');}
  assert.equal(f.row('other','another').status,'queued');
  for(const id of ['4','5','6']){f.triage.ingest(event(id,'早安'),'worker');assert.notEqual(f.row(id).status,'filtered');}
  assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM messages WHERE status='filtered'").get() as any).n,0);
 }finally{f.close();}
});

test('同一用户反复发送不能满足不同用户刷量阈值，窗口一小时后重新计数',()=>{
 const f=fixture();try{
  for(const id of ['1','2','3'])f.triage.ingest(event(id,'今天是非常晴朗的一天',{userId:'same-user',handle:'same_user'}),'worker');
  assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM messages WHERE status='filtered'").get() as any).n,0);
  f.now(NOW+3600001);
  f.triage.ingest(event('4','今天是非常晴朗的一天',{timestamp:NOW+3600001}),'worker');
  f.triage.ingest(event('5','今天是非常晴朗的一天',{timestamp:NOW+3600001}),'worker');
  assert.equal(f.row('4').status,'queued');assert.equal(f.row('5').status,'queued');
 }finally{f.close();}
});

test('重复初始化保留旧排队消息，首次轮次补分级；刷新不能续期过时刷量命中',()=>{
 const f=fixture();try{
  f.store.ingest(event('legacy','这是旧版本保留的排队消息'),'worker');assert.equal(f.row('legacy').tier,null);
  new ReplyTriage(f.store,()=>DEFAULT_TRIAGE_SETTINGS,()=>NOW);
  assert.equal(f.row('legacy').status,'queued');f.triage.refreshQueued('worker');assert.equal(f.row('legacy').tier,'priority');
  f.triage.ingest(event('one','这两条同文应在一小时之后失效'),'worker');f.triage.ingest(event('two','这两条同文应在一小时之后失效'),'worker');
  f.now(NOW+3600001);f.triage.refreshQueued('worker');
  f.triage.ingest(event('three','这两条同文应在一小时之后失效',{timestamp:NOW+3600001}),'worker');
  assert.equal(f.row('three').status,'queued');assert.notEqual(f.row('one').status,'filtered');assert.notEqual(f.row('two').status,'filtered');
 }finally{f.close();}
});

test('出队按优先级与时间排序，且只从可用通道取消息',()=>{
 const f=fixture();try{
  for(const e of [event('p1','有内容',{timestamp:NOW-10000}),event('p2','有内容',{timestamp:NOW-5000}),event('n1','hi',{timestamp:NOW}),event('dm','我有一个问题',{channel:'private',conversationId:'dm-user',timestamp:NOW-20000})])f.triage.ingest(e,'worker');
  assert.deepEqual(f.triage.pending(3,'worker',['public']).map((row:any)=>JSON.parse(row.body).platformId),['p2','p1','n1']);
  assert.deepEqual(f.triage.pending(2,'worker',['private']).map((row:any)=>JSON.parse(row.body).platformId),['dm']);
  const base={accountId:'worker',mode:'auto' as const,publicPerHour:10,privatePerHour:30,publicPerDay:180,cooldown:()=>0,hourlyCount:(channel:Channel)=>channel==='public'?10:0,unknown:()=>false};
  assert.deepEqual(f.triage.allowedChannels(base),['private']);
  assert.deepEqual(f.triage.allowedChannels({...base,cooldown:(channel:Channel)=>channel==='private'?NOW+1000:0}),[]);
  assert.deepEqual(f.triage.allowedChannels({...base,hourlyCount:()=>0,unknown:(channel:Channel)=>channel==='public'}),['private']);
  assert.deepEqual(f.triage.allowedChannels({...base,mode:'draft'}),['public','private']);
 }finally{f.close();}
});

test('普通消息与优先消息共用统一 maxAgeHours（默认三小时），超时不占实际候选名额',()=>{
 const f=fixture();try{
  f.triage.ingest(event('normal-expired','hi',{timestamp:NOW-3.5*3600000}),'worker');
  f.triage.ingest(event('priority-expired','重要但超过三小时的消息',{timestamp:NOW-3.5*3600000}),'worker');
  f.triage.ingest(event('priority-valid','我有一个问题',{timestamp:NOW-2.5*3600000}),'worker');
  f.triage.ingest(event('normal-valid','hi',{timestamp:NOW-2*3600000}),'worker');
  assert.deepEqual(f.triage.pending(2,'worker',['public']).map((row:any)=>JSON.parse(row.body).platformId),['priority-valid','normal-valid']);
  assert.equal(f.row('normal-expired').status,'skipped');assert.equal(f.row('priority-expired').status,'skipped');
 }finally{f.close();}
});

test('超过检查批量的过期优先消息不能遮住后面的新鲜普通消息',()=>{
 const f=fixture();try{
  const limit=2;
  for(let index=0;index<limit*10+10;index++)f.triage.ingest(event('expired-'+index,'这是一条已过期的优先消息 '+index,{timestamp:NOW-7*3600000-index}),'worker');
  f.triage.ingest(event('normal-after-expired','hi',{timestamp:NOW-1000}),'worker');
  const rows=f.triage.pending(limit,'worker',['public']);
  assert.deepEqual(rows.map((row:any)=>JSON.parse(row.body).platformId),['normal-after-expired']);
  assert.equal(f.row('normal-after-expired').status,'queued');
 }finally{f.close();}
});

test('人工重写的排队消息优先于分级队列，刷新不会重新吞掉已批准重写的广告或忽略消息',()=>{
 const f=fixture();try{
  const ad=event('review-ad','领取空投 https://example.com',{userId:'ignored-person',timestamp:NOW-60000});
  for(let index=0;index<3;index++)f.triage.recordSkip(ad,'worker','harassment');
  f.store.ingest(ad,'worker');f.store.update('review-ad','queued',{draft:{action:'reply',text:'保留的原草稿',reason:'',review:true,previous:{action:'reply',text:'保留的原草稿',reason:''}}},'worker');
  f.triage.ingest(event('priority-newer','这是一条普通的首次来访',{timestamp:NOW}),'worker');
  f.triage.refreshQueued('worker');
  assert.equal(f.row('review-ad').status,'queued');
  assert.equal(JSON.parse(f.triage.pending(1,'worker',['public'])[0].body).platformId,'review-ad');
  const paired={userId:'pair-user',handle:'pair_user',conversationId:'pair-thread'};
  f.store.ingest(event('review-pair','准备人工重写的消息',{...paired,timestamp:NOW-3000}),'worker');f.store.update('review-pair','queued',{draft:{action:'reply',text:'原草稿',reason:'',review:true}},'worker');
  f.triage.ingest(event('normal-pair','同一串里后来的消息',{...paired,timestamp:NOW-1000}),'worker');
  f.triage.refreshQueued('worker');
  assert.deepEqual(f.triage.merge(f.row('normal-pair'),'worker').context,[]);
  assert.equal(f.row('review-pair').status,'queued');assert.equal(f.row('normal-pair').status,'queued');
  assert.deepEqual(f.triage.merge(f.row('review-pair'),'worker').context,[]);
 }finally{f.close();}
});

test('同会话三十分钟只保留最新公开消息并返回有序上下文，其他会话及私信不合并',()=>{
 const f=fixture();try{
  const user={userId:'person',handle:'person'};
  for(const e of [event('1','第一条消息',{...user,timestamp:NOW-600000}),event('2','第二条消息',{...user,timestamp:NOW-300000}),event('3','第三条消息',{...user,timestamp:NOW}),event('old','窗口之外',{...user,timestamp:NOW-1800001}),event('other','其他帖子',{...user,conversationId:'thread-2',timestamp:NOW-1000}),event('dm','私信',{...user,channel:'private',conversationId:'thread-1'})])f.triage.ingest(e,'worker');
  const result=f.triage.merge(f.row('1'),'worker');
  assert.equal(JSON.parse(result.row.body).platformId,'3');
  assert.deepEqual(result.context.map(e=>e.platformId),['1','2']);
  assert.equal(f.row('1').merged_into,f.row('3').id);assert.equal(f.row('2').status,'merged');
  assert.equal(f.row('old').status,'queued');assert.equal(f.row('other').status,'queued');assert.equal(f.row('dm').status,'queued');
 }finally{f.close();}
});

test('合并后已消费的候选快照不能再次返回 queued 目标',()=>{
 const f=fixture();try{
  const user={userId:'same',handle:'same'};
  f.triage.ingest(event('older','第一条',{...user,timestamp:NOW-1000}),'worker');f.triage.ingest(event('newer','第二条',{...user,timestamp:NOW}),'worker');
  const cached=f.triage.pending(2,'worker',['public']),first=f.triage.merge(cached[0],'worker');
  f.store.update(first.row.id,'draft',{draft:{action:'reply',text:'一次回复',reason:''}},'worker');
  for(const row of cached){const again=f.triage.merge(row,'worker');assert.notEqual(again.row.status,'queued');}
  assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM messages WHERE account_id='worker' AND status='merged'").get() as any).n,1);
 }finally{f.close();}
});

test('缺少明确会话或可靠时间的公开消息不能被误合并',()=>{
 const f=fixture();try{
  const user={userId:'same',handle:'same',conversationId:''};
  f.triage.ingest(event('one','第一条',{...user,timestamp:NOW-1000}),'worker');f.triage.ingest(event('two','第二条',{...user,timestamp:NOW}),'worker');
  assert.equal(f.triage.merge(f.row('one'),'worker').context.length,0);assert.equal(f.row('one').status,'queued');assert.equal(f.row('two').status,'queued');
  const named={userId:'other',handle:'other',conversationId:'known-thread'};
  f.triage.ingest(event('reliable','可靠时间',{...named,timestamp:NOW-1000}),'worker');f.triage.ingest(event('unreliable','不可靠时间',{...named,timestampReliable:false,timestamp:NOW}),'worker');
  assert.equal(f.triage.merge(f.row('reliable'),'worker').context.length,0);assert.equal(f.row('reliable').status,'queued');assert.equal(f.row('unreliable').status,'queued');
 }finally{f.close();}
});

test('三次骚扰触发同账号同渠道忽略，期满及手动解除后恢复',()=>{
 const f=fixture();try{
  const e=event('1','消息',{userId:'person'});
  assert.equal(f.triage.recordSkip(e,'worker','no_reply').strikes,0);
  assert.equal(f.triage.recordSkip(e,'worker','harassment').strikes,1);
  f.now(NOW+1000);assert.equal(f.triage.recordSkip(e,'worker','harassment').strikes,2);
  f.now(NOW+2000);const third=f.triage.recordSkip(e,'worker','harassment');assert.equal(third.strikes,3);assert.equal(third.ignoredUntil,NOW+2000+86400000);
  f.triage.ingest(event('2','正常新内容',{userId:'person'}),'worker');assert.equal(f.row('2').status,'ignored');
  assert.equal(f.triage.ignored('person','private','worker'),null);assert.equal(f.triage.ignored('person','public','another'),null);
  f.triage.clearIgnore('person','public','worker');assert.equal(f.triage.ignored('person','public','worker'),null);
  for(let n=0;n<3;n++){f.now(NOW+3000+n);f.triage.recordSkip(e,'worker','harassment');}
  f.now(NOW+3002+86400001);assert.equal(f.triage.ignored('person','public','worker'),null);
  f.triage.ingest(event('3','到期后新内容',{userId:'person',timestamp:NOW+3002+86400001}),'worker');assert.equal(f.row('3').status,'queued');
 }finally{f.close();}
});

test('每日额度以北京时间零点为界，公开帖子与回复共享且 legacy 不重复计数',()=>{
 const f=fixture();try{
  const day=Date.parse('2026-10-28T16:00:00Z');f.now(day-1);
  const insert=f.store.db.prepare('INSERT INTO outbox(id,account_id,channel,kind,source_id,text,status,created_at,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const legacy=event('legacy','已经回复',{timestamp:day-1000});f.store.ingest(legacy,'worker');f.store.update('legacy','confirmed',{},'worker');f.store.db.prepare('UPDATE messages SET updated_at=? WHERE source_id=?').run(day-1000,'legacy');
  const duplicate=event('duplicate','已经由出站发送',{timestamp:day-1000});f.store.ingest(duplicate,'worker');f.store.update('duplicate','confirmed',{},'worker');f.store.db.prepare('UPDATE messages SET updated_at=? WHERE source_id=?').run(day-1000,'duplicate');
  for(const [id,account,channel,kind,status,at,source] of [
   ['post','worker','public','post','confirmed',day-1000,'morning'],['reply','worker','public','reply','unknown',day-1000,f.row('duplicate').id],['new','worker','public','reply','submitting',day+1,'new'],['private','worker','private','dm','confirmed',day-1000,'dm'],['other','another','public','post','confirmed',day-1000,'other'],['cancel','worker','public','post','cancelled',day-1000,'cancel'],['reject','worker','public','post','rejected',day-1000,'reject']
  ] as const)insert.run(id,account,channel,kind,source,'内容',status,at,at,at);
  assert.equal(f.triage.dailyCount('worker'),3);
  const channels=f.triage.allowedChannels({accountId:'worker',mode:'auto',publicPerHour:10,privatePerHour:30,publicPerDay:3,cooldown:()=>0,hourlyCount:()=>0,unknown:()=>false});assert.deepEqual(channels,['private']);
  assert.equal(f.store.get('cooldown:public:worker'), '');
  f.now(day+2);assert.equal(f.triage.dailyCount('worker'),1);
 }finally{f.close();}
});

test('手动重排可恢复误过滤消息，但不能覆盖 unknown 或 sending 出站',()=>{
 const f=fixture();try{
  f.triage.ingest(event('ad','领取空投 https://example.com'),'worker');assert.equal(f.row('ad').status,'filtered');
  f.triage.requeue('ad','worker');assert.equal(f.row('ad').status,'queued');
  f.triage.refreshQueued('worker');assert.equal(f.row('ad').status,'queued');
  for(const status of ['unknown','sending']){const e=event(status,'仍有未知结果');f.triage.ingest(e,'worker');f.store.update(status,status,{},'worker');assert.throws(()=>f.triage.requeue(status,'worker'),/回查|发送|状态|重排|重新排队/);assert.equal(f.row(status).status,status);}
  assert.throws(()=>f.triage.requeue('ad','another'),/不存在|账号|消息/);
 }finally{f.close();}
});

test('重排旁路只属于该消息的下一次处理，解除旁路后继续应用过滤与用户忽略',()=>{
 const f=fixture();try{
  f.triage.ingest(event('ad','领取空投 https://example.com'),'worker');f.triage.requeue('ad','worker');
  f.triage.refreshQueued('worker');assert.equal(f.row('ad').status,'queued');
  f.triage.consumed(f.row('ad').id);f.triage.refreshQueued('worker');assert.equal(f.row('ad').status,'filtered');
  const person=event('harassment','发言',{userId:'person'});for(let n=0;n<3;n++)f.triage.recordSkip(person,'worker','harassment');
  f.triage.ingest(event('ignored','有内容消息',{userId:'person'}),'worker');assert.equal(f.row('ignored').status,'ignored');
  f.triage.requeue('ignored','worker');f.triage.refreshQueued('worker');assert.equal(f.row('ignored').status,'queued');
  f.triage.ingest(event('stillIgnored','另一条内容',{userId:'person'}),'worker');assert.equal(f.row('stillIgnored').status,'ignored');
  f.triage.consumed(f.row('ignored').id);f.triage.refreshQueued('worker');assert.equal(f.row('ignored').status,'ignored');
 }finally{f.close();}
});

test('真实数据库的 unknown 阻塞按当前账号和通道判断，终态与列表分页不能改变结果',()=>{
 const f=fixture();
 const transport:Transport={identity:async()=>({loggedIn:true,needsHuman:false,handle:'worker'}),collect:async()=>({events:[],warnings:[]}),context:async()=>'',send:async()=>({status:'unknown'}),lookup:async()=>({status:'unknown'}),control:async()=>{}};
 const config={...structuredClone(exampleConfig),mode:'auto',publicPerHour:1000,privatePerHour:1000} as Config;
 const workflow=new Workflow(f.store,transport,{async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async()=>({text:'',input:0,output:0,cache:0})},()=>config);
 try{
  const outbox=new Outbox(f.store);workflow.services={outbox,triage:f.triage};f.store.set('activeAccount','worker');
  f.store.ingest(event('foreign-unknown','其他账号的私信',{channel:'private'}),'another');f.store.update('foreign-unknown','unknown',{},'another');
  f.store.ingest(event('terminal','已确认的私信',{channel:'private'}),'worker');f.store.update('terminal','confirmed',{receipt:{status:'confirmed',id:'receipt-terminal'}},'worker');
  const insert=f.store.db.prepare('INSERT INTO outbox(id,account_id,channel,kind,source_id,text,status,receipt,created_at,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for(const status of ['confirmed','rejected','cancelled'])insert.run('terminal-'+status,'worker','private','dm','source-'+status,'固定正文',status,JSON.stringify({status:status==='confirmed'?'confirmed':'rejected',id:'receipt-'+status}),NOW,NOW,NOW);
  insert.run('foreign-outbox','another','private','dm','foreign-source','固定正文','unknown',null,NOW,NOW,NOW);
  assert.equal(workflow.channelWaitReason('private',config,false),null);
  f.store.ingest(event('current-unknown','当前账号的私信',{channel:'private'}),'worker');f.store.update('current-unknown','unknown',{},'worker');
  assert.equal(workflow.channelWaitReason('private',config,false),'unknown-pending');
  f.store.update('current-unknown','confirmed',{receipt:{status:'confirmed',id:'settled'}},'worker');assert.equal(workflow.channelWaitReason('private',config,false),null);
  insert.run('current-outbox','worker','private','dm','current-source','固定正文','unknown',null,NOW,NOW,NOW);
  assert.equal(workflow.channelWaitReason('private',config,false),'unknown-pending');
  f.store.db.prepare("UPDATE outbox SET status='confirmed',receipt=? WHERE id='current-outbox'").run(JSON.stringify({status:'confirmed',id:'settled-outbox'}));assert.equal(workflow.channelWaitReason('private',config,false),null);
  for(let index=0;index<12;index++){f.store.ingest(event('public-unknown-'+index,'另一通道待回查',{timestamp:NOW-1000-index}),'worker');f.store.update('public-unknown-'+index,'unknown',{},'worker');}
  f.store.ingest(event('private-after-public','排在列表第二页的私信',{channel:'private',timestamp:NOW}),'worker');f.store.update('private-after-public','unknown',{},'worker');
  assert.equal(workflow.channelWaitReason('private',config,false),'unknown-pending');
  f.store.update('private-after-public','confirmed',{receipt:{status:'confirmed',id:'settled-late'}},'worker');
  for(let index=0;index<52;index++)insert.run('public-outbox-'+index,'worker','public','post','post-'+index,'固定正文','unknown',null,NOW-1000-index,NOW-1000-index,NOW-1000-index);
  insert.run('private-late-outbox','worker','private','dm','dm-late','固定正文','unknown',null,NOW,NOW,NOW);
  assert.equal(workflow.channelWaitReason('private',config,false),'unknown-pending');
 }finally{workflow.stop();f.close();}
});

test('健康队列只读共用分级时效与忽略条件，并计入人工批准及重写候选',()=>{
 const f=fixture();try{
  for(const e of [event('normal-expired','hi',{timestamp:NOW-3.5*3600000}),event('priority-valid','有效优先内容',{timestamp:NOW-2.5*3600000}),event('ignored-queued','等待但已忽略',{userId:'ignored-person'}),event('approved','已批准正文',{channel:'private'}),event('rewrite','空投 https://example.com',{userId:'ignored-person',channel:'private'}),event('foreign','其他账号内容')])f.triage.ingest(e,e.id==='foreign'?'other':'worker');
  for(let n=0;n<3;n++){f.triage.recordSkip(event('strike','消息',{userId:'ignored-person'}),'worker','harassment');f.triage.recordSkip(event('private-strike','消息',{userId:'ignored-person',channel:'private'}),'worker','harassment');}
  f.store.update('approved','approved',{},'worker');
  f.store.db.prepare("UPDATE messages SET status='queued',tier='priority',draft=? WHERE source_id='rewrite'").run(JSON.stringify({action:'reply',text:'旧草稿',reason:'',review:true}));
  const before=f.store.db.prepare('SELECT id,status,updated_at,processed_seq FROM messages ORDER BY id').all();
  const observed=f.triage.healthQueue('worker',3);
  assert.deepEqual(observed,{public:{count:1,oldestAt:NOW-2.5*3600000},private:{count:2,oldestAt:NOW}});
  assert.deepEqual(f.store.db.prepare('SELECT id,status,updated_at,processed_seq FROM messages ORDER BY id').all(),before);
  const pending=f.triage.pending(4,'worker',['public','private'],3);
  assert.deepEqual(new Set(pending.map((row:any)=>JSON.parse(row.body).platformId)),new Set(['priority-valid','rewrite']));
 }finally{f.close();}
});

test('启动迁移备份旧 settings.json 并合并 normalMaxAgeHours 与 maxAgeHours，分流设置接口原子读写',async()=>{
 const {readPanelSettings,commitTriageSettings,upgradeMessageAgeSettings,panelDir}=await import('../src/settings.js');
 const {mkdirSync,writeFileSync,readFileSync,readdirSync}=await import('node:fs');
 const dir=mkdtempSync(tmpdir()+'/role-age-mig-'),prev=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 try{
  mkdirSync(panelDir(),{recursive:true});
  writeFileSync(panelDir()+'/settings.json',JSON.stringify({program:{mode:'draft',maxAgeHours:6},triage:{normalMaxAgeHours:4,batchThreshold:5},revisions:{program:2,triage:3}},null,2));
  const first=upgradeMessageAgeSettings(undefined,6,1700000000000);
  assert.equal(first.upgraded,true);assert.equal(first.maxAgeHours,4);
  const files=readdirSync(panelDir());assert.ok(files.some(name=>name.startsWith('settings.json.bak-message-age-')));
  const upgraded=readPanelSettings();
  assert.equal(upgraded.program?.maxAgeHours,4);
  assert.equal(upgraded.triage?.normalMaxAgeHours,4);
  assert.equal(upgraded.migrations?.messageAge,1);
  assert.equal(upgraded.revisions?.program,3);
  assert.equal(upgraded.revisions?.triage,4);
  assert.equal(upgradeMessageAgeSettings(undefined,6).upgraded,false);
  const saved=commitTriageSettings({batchThreshold:6},{maxAgeHours:8,expectedRevision:4,expectedProgramRevision:3});
  assert.equal(saved.revision,5);assert.equal(saved.programRevision,4);
  assert.equal(readPanelSettings().program?.maxAgeHours,8);
  assert.equal(readPanelSettings().triage?.batchThreshold,6);
  assert.equal(JSON.parse(readFileSync(panelDir()+'/settings.json','utf8')).triage.normalMaxAgeHours,4);
 }finally{
  if(prev===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=prev;
  rmSync(dir,{recursive:true,force:true});
 }
});
