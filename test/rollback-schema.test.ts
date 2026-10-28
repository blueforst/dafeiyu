import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { LlmStore } from '../src/llm-store.js';
import { MemoryService } from '../src/memory.js';
import { DailyStateService } from '../src/daily-state.js';
import { TaskScheduler } from '../src/scheduler.js';
import { Outbox } from '../src/outbox.js';
import { Program } from '../src/program.js';
import type { Config,Event } from '../src/types.js';
import type { Generator } from '../src/model.js';
import { exampleConfig } from './config-fixture.js';
import { ensureReferenceGapMigration } from '../src/reference-gap-schema.js';

const helper=resolve('deploy/rollback-schema.py');
const generator:Generator={complete:async()=>{throw new Error('逆迁移测试不得调用模型');}};
const externalNames=['forget-ledger.json','forget-history.json','forgotten-sources.json','memory-mutations.json'];
function migrate(path:string){
 const store=new Store(path);store.boot();new LlmStore(store);new MemoryService(store,generator,()=>exampleConfig as Config);new DailyStateService(store,generator,()=>exampleConfig as Config);
 new TaskScheduler(store,{account:()=>'',control:()=>store.get('control'),execute:async()=>{throw new Error('逆迁移测试不得执行任务');}});new Outbox(store);new Program(store);
 // 固定历史 schema 演练；新版新增空关联表不属于历史降级工具的授权范围。
 assert.equal(store.db.prepare('SELECT count(*) n FROM identity_links').get()!.n,0);
 store.db.exec('DROP TABLE identity_links; DROP TABLE identity_link_blocks; DELETE FROM schema_migrations WHERE version=14');
 // 本组验证已发布七页 v7 的历史窗口，不能随当前 Outbox 的 v8 自动扩大原工具范围。
 store.db.exec('ALTER TABLE outbox DROP COLUMN validation_json; DELETE FROM schema_migrations WHERE version=8');
 return store;
}
function fixture(){
 const root=mkdtempSync(tmpdir()+'/role-rollback-schema-'),path=root+'/workflow.sqlite';
 for(const name of externalNames)writeFileSync(root+'/'+name,name==='memory-mutations.json'?'[]':name==='forget-ledger.json'?'{"x:forgotten":true}':'{}');
 const db=new DatabaseSync(path);
 db.exec(`CREATE TABLE runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE users(id TEXT PRIMARY KEY,forgot INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE messages(id TEXT PRIMARY KEY,channel TEXT NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',draft TEXT,receipt TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE memory(user_id TEXT NOT NULL,visibility TEXT NOT NULL,summary TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,visibility));
 CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,level TEXT NOT NULL,event TEXT NOT NULL,detail TEXT NOT NULL);
 CREATE TABLE usage(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read INTEGER NOT NULL);
 CREATE INDEX messages_queue ON messages(status,created_at);CREATE INDEX messages_user ON messages(user_id,channel,created_at);
 INSERT INTO runtime VALUES('control','paused');INSERT INTO runtime VALUES('legacy-marker','保留运行记录');INSERT INTO users VALUES('x:alice',0,0);
 INSERT INTO memory VALUES('x:alice','public','旧摘要原文',123);INSERT INTO usage(at,input_tokens,output_tokens,cache_read) VALUES(123,12,4,2);
 INSERT INTO logs(at,level,event,detail) VALUES(123,'info','legacy','旧日志');`);
 const event:Event={id:'x:123',channel:'public',userId:'x:alice',handle:'alice',text:'旧消息',url:'https://x.com/alice/status/123',conversationId:'123',timestamp:123};
 db.prepare('INSERT INTO messages(id,channel,user_id,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(event.id,event.channel,event.userId,JSON.stringify(event),'draft',123,123);db.close();
 return {root,path,event,close:()=>rmSync(root,{recursive:true,force:true})};
}
function invoke(path:string,apply=false){
 const result=spawnSync('python3',[helper,'--db',path,...(apply?['--apply']:[])],{encoding:'utf8',timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.error,undefined,result.error?.message);assert.ok(result.stdout.trim(),result.stderr);return {code:result.status,report:JSON.parse(result.stdout)};
}
function content(path:string){
 const db=new DatabaseSync(path,{readOnly:true});try{
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as any[];
  const rows:Record<string,unknown>={};for(const item of schema.filter(x=>x.type==='table'))rows[item.name]=db.prepare('SELECT * FROM "'+item.name.replaceAll('"','""')+'" ORDER BY rowid').all();
  return {schema,rows};
 }finally{db.close();}
}

test('旧库全模块升级可在初始暂停窗口只读检查、反向恢复四列摘要，再升级且不丢旧数据或外部账本',()=>{
 const f=fixture();try{
  const store=migrate(f.path);assert.equal((store.db.prepare('SELECT count(*) n FROM schema_migrations').get() as any).n,7);assert.equal((store.db.prepare('SELECT count(*) n FROM memory_items').get() as any).n,1);store.db.close();
  const fileBefore=readFileSync(f.path),before=content(f.path),external=externalNames.map(name=>readFileSync(f.root+'/'+name,'utf8'));
  const check=invoke(f.path);assert.equal(check.code,0,JSON.stringify(check.report));assert.equal(check.report.applied,false);assert.equal(check.report.eligible,true);assert.equal(check.report.derived.memory_items,1);assert.deepEqual(readFileSync(f.path),fileBefore);assert.deepEqual(content(f.path),before);
  const down=invoke(f.path,true);assert.equal(down.code,0,JSON.stringify(down.report));assert.equal(down.report.applied,true);assert.equal(down.report.integrityAfter,'ok');
  const legacy=new DatabaseSync(f.path);try{
   assert.equal(legacy.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(),undefined);
   assert.deepEqual((legacy.prepare('PRAGMA table_info(memory)').all() as any[]).map(x=>x.name),['user_id','visibility','summary','updated_at']);
   assert.deepEqual((legacy.prepare('PRAGMA table_info(messages)').all() as any[]).map(x=>x.name),['id','channel','user_id','body','status','draft','receipt','error','created_at','updated_at']);
   assert.equal((legacy.prepare('SELECT summary FROM memory').get() as any).summary,'旧摘要原文');assert.equal((legacy.prepare('SELECT body FROM messages').get() as any).body,JSON.stringify(f.event));assert.equal((legacy.prepare('SELECT input_tokens FROM usage').get() as any).input_tokens,12);
   assert.equal((legacy.prepare("SELECT value FROM runtime WHERE key='legacy-marker'").get() as any).value,'保留运行记录');assert.equal((legacy.prepare("SELECT detail FROM logs WHERE event='legacy'").get() as any).detail,'旧日志');assert.equal((legacy.prepare('SELECT id FROM users').get() as any).id,'x:alice');
   legacy.prepare('INSERT INTO memory VALUES(?,?,?,?) ON CONFLICT(user_id,visibility) DO UPDATE SET summary=excluded.summary,updated_at=excluded.updated_at').run('x:alice','public','旧版四值写入兼容',456);
   assert.equal((legacy.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok');
  }finally{legacy.close();}
  const upgraded=migrate(f.path);try{assert.equal((upgraded.db.prepare('SELECT count(*) n FROM schema_migrations').get() as any).n,7);assert.equal((upgraded.db.prepare('SELECT text FROM memory_items').get() as any).text,'旧版四值写入兼容');assert.equal((upgraded.stats().usage as any).input,12);}finally{upgraded.db.close();}
  assert.deepEqual(externalNames.map(name=>readFileSync(f.root+'/'+name,'utf8')),external);assert.equal(readdirSync(f.root).some(name=>/backup|\.bak|snapshot/.test(name)),false);
 }finally{f.close();}
});

test('任何新调用、明确账号、修改记忆或未来迁移都拒绝反向，检查与申请执行均不改原库',()=>{
 const variants:Array<{name:string;change:(store:Store)=>void}>=[
  {name:'新模型流水',change:store=>{new LlmStore(store).start({provider:'custom',id:'mock'},{purpose:'model-test'});}},
  {name:'明确账号消息',change:store=>{store.ingest({id:'x:999',platformId:'999',channel:'public',userId:'x:bob',handle:'bob',text:'新消息',url:'https://x.com/bob/status/999',conversationId:'999',timestamp:Date.now()},'work');}},
  {name:'修订长期条目',change:store=>{store.db.prepare("UPDATE memory_items SET text='人工修改',revision=revision+1").run();}},
  {name:'虚构日程尝试',change:store=>{store.db.prepare("INSERT INTO daily_attempts(account_id,local_date) VALUES('work','2026-10-28')").run();}},
  {name:'任务历史',change:store=>{store.db.prepare("INSERT INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at) VALUES('task','health','host',1,'automatic','completed',1)").run();}},
  {name:'出站记录',change:store=>{new Outbox(store).prepare({accountId:'work',kind:'post',sourceId:'greeting',text:'正文'});}},
  {name:'程序阶段',change:store=>{new Program(store).begin('waiting');}},
  {name:'未来迁移',change:store=>{store.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(8,'future-change',Date.now());}},
  {name:'非暂停状态',change:store=>{store.set('control','running');}},
  {name:'发送结果未知',change:store=>{store.db.prepare("UPDATE messages SET status='unknown'").run();}},
  {name:'发送中',change:store=>{store.db.prepare("UPDATE messages SET status='sending'").run();}},
 ];
 for(const variant of variants){
  const f=fixture();try{
   const store=migrate(f.path);variant.change(store);store.db.close();const before=content(f.path);
   const check=invoke(f.path);assert.equal(check.code,2,variant.name+':'+JSON.stringify(check.report));assert.equal(check.report.eligible,false);assert.deepEqual(content(f.path),before);
   const down=invoke(f.path,true);assert.equal(down.code,2,variant.name+':'+JSON.stringify(down.report));assert.equal(down.report.applied,false);assert.deepEqual(content(f.path),before);
  }finally{f.close();}
 }
});

test('当前提案 v8 新增校验元数据后，原七页初始窗口工具继续拒绝且不删除校验或正文',()=>{
 const f=fixture();try{
  const store=migrate(f.path),outbox=new Outbox(store);outbox.prepare({accountId:'work',kind:'post',sourceId:'candidate',text:'保留的候选正文'});store.db.close();
  const before=content(f.path);const result=invoke(f.path,true);
  assert.equal(result.code,2);assert.equal(result.report.applied,false);assert.ok(result.report.reasons.some((reason:string)=>reason.includes('未知迁移版本：8')));assert.deepEqual(content(f.path),before);
 }finally{f.close();}
});

test('初始窗口工具识别版本13空表，但拒绝任何经历元信息或补录数据',()=>{
 for(const populated of [false,true]){
  const f=fixture();try{
   const store=migrate(f.path);ensureReferenceGapMigration(store.db);if(populated)store.db.prepare('INSERT INTO manual_imports VALUES(?,?,?,?,?,?,?,?,?)').run('pending','worker','https://x.com/visitor/status/1','1','pending',null,null,100,100);store.db.close();const before=content(f.path);
   const checked=invoke(f.path);assert.equal(checked.code,populated?2:0,JSON.stringify(checked.report));assert.ok(checked.report.versions.includes(13));assert.deepEqual(content(f.path),before);
   const result=invoke(f.path,true);assert.equal(result.code,populated?2:0,JSON.stringify(result.report));if(populated){assert.equal(result.report.applied,false);assert.deepEqual(content(f.path),before);}else {const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('role_experience_meta','manual_imports','schema_migrations')").all().length,0);}finally{db.close();}}
  }finally{f.close();}
 }
});

test('DDL中途失败时完整回滚全部扩展表与消息列，没有半逆迁移',()=>{
 const f=fixture();try{
  const store=migrate(f.path);store.db.close();const before=content(f.path),external=externalNames.map(name=>readFileSync(f.root+'/'+name,'utf8'));
  const code='import importlib.util,json,sys; s=importlib.util.spec_from_file_location("rollback_schema",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); original=m.reverse; m.reverse=lambda connection:(original(connection),(_ for _ in ()).throw(RuntimeError("模拟DDL后失败"))); report,status=m.run(sys.argv[2],True); print(json.dumps(report,ensure_ascii=False)); sys.exit(status)';
  const result=spawnSync('python3',['-c',code,helper,f.path],{encoding:'utf8',timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).applied,false);assert.deepEqual(content(f.path),before);assert.deepEqual(externalNames.map(name=>readFileSync(f.root+'/'+name,'utf8')),external);
 }finally{f.close();}
});

test('旧程序不能执行的新范围遗忘或删除账本即使新表为空也拒绝降级，并原样保留账本',()=>{
 for(const [name,value] of [['forget-history.json',JSON.stringify({'resume:x:alice':123})],['forgotten-sources.json',JSON.stringify({source:true})],['memory-mutations.json',JSON.stringify([{id:'delete'}])],['forget-ledger.json',JSON.stringify({'scope:["work","x:alice"]':false})]]){
  const f=fixture();try{
   const store=migrate(f.path);store.db.close();writeFileSync(f.root+'/'+name,value);const before=content(f.path);
   const result=invoke(f.path,true);assert.equal(result.code,2,name+':'+JSON.stringify(result.report));assert.equal(result.report.applied,false);assert.deepEqual(content(f.path),before);assert.equal(readFileSync(f.root+'/'+name,'utf8'),value);
  }finally{f.close();}
 }
});

test('暂停时仅保存新页面配置或其修订也拒绝降级，旧模型配置保持允许且不被改写',()=>{
 for(const settings of [{persona:{sections:[{id:'role',content:'新角色'}]}},{tasks:{plans:{backup:{enabled:true}}}},{memory:{recentCount:4}},{program:{mode:'auto'}},{revisions:{persona:1}},{futureField:true},{revisions:{futureDomain:1}},{revisions:[]},{revisions:{model:-1}},{revisions:{persona:false}},{model:'broken'},'{"model":']){
  const f=fixture();try{
   const store=migrate(f.path);store.db.close();mkdirSync(f.root+'/panel');const raw=typeof settings==='string'?settings:JSON.stringify(settings);writeFileSync(f.root+'/panel/settings.json',raw);const before=content(f.path);
   const result=invoke(f.path,true);assert.equal(result.code,2,JSON.stringify(result.report));assert.equal(result.report.applied,false);assert.deepEqual(content(f.path),before);assert.equal(readFileSync(f.root+'/panel/settings.json','utf8'),raw);
  }finally{f.close();}
 }
 const f=fixture();try{
  const store=migrate(f.path);store.db.close();mkdirSync(f.root+'/panel');const raw=JSON.stringify({model:{provider:'custom',id:'legacy-model'},revisions:{model:1}});writeFileSync(f.root+'/panel/settings.json',raw);
  assert.equal(invoke(f.path,true).code,0);assert.equal(readFileSync(f.root+'/panel/settings.json','utf8'),raw);
 }finally{f.close();}
});
