import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync,copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { applyMigration } from '../src/migrations.js';
import type { Event } from '../src/types.js';
const event:Event={id:'x:123',platformId:'123',targetId:'123',channel:'public',userId:'x:alice',handle:'alice',text:'你好',url:'https://x.com/alice/status/123',conversationId:'123',timestamp:Date.now()};
function fixture(){const dir=mkdtempSync(tmpdir()+'/role-migration-');return {dir,path:dir+'/db.sqlite',close:()=>rmSync(dir,{recursive:true,force:true})};}
test('旧库升级保留消息摘要用量，未知归属不分配给新工作账号，重复打开不重复迁移',()=>{
 const f=fixture();let store:Store|undefined;
 try{
  const old=new DatabaseSync(f.path);
  old.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,channel TEXT NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',draft TEXT,receipt TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE memory(user_id TEXT NOT NULL,visibility TEXT NOT NULL,summary TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,visibility));
  CREATE TABLE usage(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read INTEGER NOT NULL);`);
  old.prepare('INSERT INTO messages(id,channel,user_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(event.id,event.channel,event.userId,JSON.stringify(event),event.timestamp,event.timestamp);
  old.prepare('INSERT INTO memory VALUES(?,?,?,?)').run(event.userId,'public','旧摘要',1);
  old.prepare('INSERT INTO usage(at,input_tokens,output_tokens,cache_read) VALUES(?,?,?,?)').run(1,12,4,3);old.close();
  store=new Store(f.path);
  assert.equal(store.getMessage(event.id).account_id,'');assert.equal(store.pending(10,'new-account').length,0);assert.equal(store.context(event.userId,'public','new-account').memories.length,0);
  assert.equal((store.context(event.userId,'public').memories[0] as any).summary,'旧摘要');assert.equal((store.stats().usage as any).input,12);
  const migrations=store.db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as any;assert.equal(migrations.n,1);store.db.close();
  store=new Store(f.path);assert.equal((store.db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as any).n,1);assert.equal(store.pending().length,1);assert.equal((store.stats().usage as any).input,12);
 }finally{store?.db.close();f.close();}
});
test('独立模块迁移可乱序注册，重复安全，SQL失败不留半迁移',()=>{
 const db=new DatabaseSync(':memory:');try{
  assert.equal(applyMigration(db,7,'stages','CREATE TABLE stage_test(id TEXT)'),true);assert.equal(applyMigration(db,2,'calls','CREATE TABLE call_test(id TEXT)'),true);assert.equal(applyMigration(db,7,'stages','CREATE TABLE stage_test(id TEXT)'),false);
  assert.throws(()=>applyMigration(db,8,'bad','CREATE TABLE half_test(id TEXT); SQL IS INVALID;'));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='half_test'").get(),undefined);assert.equal(db.prepare('SELECT * FROM schema_migrations WHERE version=8').get(),undefined);
  assert.throws(()=>applyMigration(db,7,'wrong',''),/迁移版本冲突/);
 }finally{db.close();}
});
test('相同平台消息按工作账号隔离且跨来源去重；兼容原ID只在唯一时解析',()=>{
 const f=fixture(),store=new Store(f.path);try{
  assert.equal(store.ingest(event,'first'),true);assert.equal(store.ingest({...event,id:'notification:123'},'first'),false);assert.equal(store.ingest(event,'second'),true);
  const first=store.pending(10,'first')[0],second=store.pending(10,'second')[0];assert.notEqual(first.id,second.id);assert.equal(JSON.parse(first.body).id,first.id);assert.equal(first.platform_id,'123');assert.equal(store.getMessage(event.id),undefined);assert.equal(store.getMessage(event.id,'first').id,first.id);
  store.update(first.id,'draft',{draft:{action:'reply',text:'草稿',reason:''}});store.update(second.id,'confirmed',{draft:{action:'reply',text:'已发送',reason:''}});
  assert.ok(first.processed_seq<store.getMessage(first.id).processed_seq);assert.ok(!JSON.stringify(store.context(event.userId,'public','first')).includes('已发送'));
  store.summary(event.userId,'private','甲的私密摘要',0,'first');assert.ok(!JSON.stringify(store.context(event.userId,'private','second')).includes('甲的私密摘要'));
 }finally{store.db.close();f.close();}
});
test('已处理进度跨清理单调增加，账号遗忘影响旧后台结果并保留其他账号',()=>{
 const f=fixture(),store=new Store(f.path);try{
  store.ingest(event,'first');store.ingest(event,'second');const first=store.pending(1,'first')[0];store.update(first.id,'draft');const sequence=store.getMessage(first.id).processed_seq;
  store.db.prepare('DELETE FROM messages WHERE id=?').run(first.id);store.ingest({...event,id:'x:124',platformId:'124'},'first');const newer=store.pending(1,'first')[0];store.update(newer.id,'draft');assert.ok(store.getMessage(newer.id).processed_seq>sequence);
  const epoch=store.epoch(event.userId,'first');store.forget(event.userId,'first');assert.equal(store.summary(event.userId,'public','迟到内容',epoch,'first'),false);assert.equal(store.ingest(event,'first'),false);assert.equal(store.pending(10,'second').length,1);
  store.remember(event.userId,'first');assert.equal(store.ingest(event,'first'),false);assert.equal(store.ingest({...event,id:'x:999',platformId:'999',timestamp:store.recordingAfter(event.userId,'first')+1},'first'),true);
 }finally{store.db.close();f.close();}
});

test('显式恢复只覆盖当前账号旧全局遗忘，重启与恢复旧库不复活旧消息或旧来源',()=>{
 const f=fixture();let store=new Store(f.path);
 try{
  store.ingest(event,'first');store.ingest(event,'second');store.db.exec("VACUUM INTO '"+f.dir+"/old.sqlite'");
  store.forget(event.userId);store.remember(event.userId,'first');
  assert.equal(store.forgotten(event.userId,'first'),false);assert.equal(store.forgotten(event.userId,'second'),true);
  assert.equal(store.ingest(event,'first'),false);const future={...event,id:'x:future',platformId:'999',text:'恢复后的新消息',timestamp:store.recordingAfter(event.userId,'first')+1};assert.equal(store.ingest(future,'first'),true);
  const epoch=store.epoch(event.userId,'first');store.db.close();store=new Store(f.path);
  assert.equal(store.epoch(event.userId,'first'),epoch);assert.equal(store.pending(10,'first').length,1);assert.equal(store.pending(10,'first')[0].platform_id,'999');assert.equal(store.forgotten(event.userId,'second'),true);store.db.close();
  copyFileSync(f.dir+'/old.sqlite',f.path);store=new Store(f.path);
  assert.equal(store.pending(10,'first').length,0);assert.equal(store.pending(10,'second').length,0);assert.equal(store.forgotten(event.userId,'first'),false);assert.equal(store.forgotten(event.userId,'second'),true);
  assert.equal(store.ingest(event,'first'),false);assert.equal(store.ingest({...future,id:'x:1000',platformId:'1000'},'first'),true);
 }finally{store.db.close();f.close();}
});

test('恢复后的时间边界拒绝遗忘期间未采集的旧消息和未知时间，只接受可靠的新消息',()=>{
 const f=fixture();let store=new Store(f.path);try{
  store.ingest(event,'first');store.forget(event.userId,'first');store.remember(event.userId,'first');const after=store.recordingAfter(event.userId,'first');
  const unseen={...event,id:'x:unseen',platformId:'unseen',timestamp:after-1};assert.equal(store.ingest(unseen,'first'),false);
  assert.equal(store.ingest({...unseen,id:'x:same-time',platformId:'same-time',timestamp:after},'first'),false);
  assert.equal(store.ingest({...unseen,id:'x:unknown-time',platformId:'unknown-time',timestamp:after+1000,timestampReliable:false},'first'),false);
  assert.equal(store.ingest({...unseen,id:'x:future',platformId:'future',timestamp:after+1000,timestampReliable:true},'first'),true);
  store.db.close();store=new Store(f.path);assert.equal(store.recordingAfter(event.userId,'first'),after);assert.equal(store.ingest({...unseen,id:'x:unseen-restart',platformId:'unseen-restart'},'first'),false);
 }finally{store.db.close();f.close();}
});

test('兼容全局恢复也为此前单账号遗忘建立未来时间边界',()=>{
 const f=fixture(),store=new Store(f.path);try{
  store.ingest(event,'first');store.forget(event.userId,'first');store.remember(event.userId);
  const after=store.recordingAfter(event.userId,'first');assert.ok(after>0);assert.equal(store.forgotten(event.userId,'first'),false);
  assert.equal(store.ingest({...event,id:'x:never-collected',platformId:'never-collected',timestamp:after-1},'first'),false);
  assert.equal(store.ingest({...event,id:'x:future-global',platformId:'future-global',timestamp:after+1000},'first'),true);
 }finally{store.db.close();f.close();}
});
