import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
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
import { ReplyTriage } from '../src/reply-triage.js';
import { RuntimeHealth } from '../src/unattended-health.js';
import { PersonaService } from '../src/persona.js';
import { ReplayRunner } from '../src/persona-replay.js';
import { ActivityFeed } from '../src/activity-feed.js';
import { validatePostingText } from '../src/posting-policy.js';
import type { Config,Event } from '../src/types.js';
import type { Generator } from '../src/model.js';
import { exampleConfig } from './config-fixture.js';

const helper=resolve('deploy/prepare-proposals-rollback.py');
const generator:Generator={complete:async()=>{throw new Error('回退演练不调用模型');}};
const model={provider:'custom',baseUrl:'https://rollback-fixture.invalid/v1',api:'openai-completions',id:'fixture-model',reasoningLevel:'off',maxTokens:4096,timeoutMs:60000};
function fixture(){
 const root=mkdtempSync(tmpdir()+'/role-proposals-rollback-'),path=root+'/workflow.sqlite',profile=root+'/profile';mkdirSync(profile);mkdirSync(root+'/panel');
 const store=new Store(path);store.boot();const outbox=new Outbox(store),ledger=new LlmStore(store),config=()=>exampleConfig as Config;
 new MemoryService(store,generator,config);new DailyStateService(store,generator,config);new TaskScheduler(store,{account:()=> 'worker',control:()=>store.get('control'),execute:async()=>{throw new Error('不执行任务');}});new Program(store);new ReplyTriage(store);new RuntimeHealth(store);new ReplayRunner(store,new PersonaService(store,generator,config),generator,{accountId:()=> 'worker',config});new ActivityFeed(store,()=> 'worker',()=>6);
 const settings={model,modelLibrary:{version:1,providers:[{key:'custom-legacy',provider:'custom',name:'演练接口',baseUrl:model.baseUrl,api:model.api,models:[{id:model.id,source:'manual',params:{reasoningLevel:model.reasoningLevel,maxTokens:model.maxTokens,timeoutMs:model.timeoutMs}}]}],active:{default:{key:'custom-legacy',modelId:model.id}}},promptHints:{late:true},triage:{greetings:['你好']},health:{requiredPhrases:['AI']},revisions:{model:2,modelLibrary:3,promptHints:1,triage:1,health:1}};
 writeFileSync(root+'/panel/settings.json',JSON.stringify(settings));writeFileSync(root+'/panel/model-keys.json','{"custom@rollback-fixture.invalid":"fixture-only-key"}');
 const externals=['forget-ledger.json','forget-history.json','forgotten-sources.json','memory-mutations.json'];for(const name of externals)writeFileSync(root+'/'+name,name==='memory-mutations.json'?'[]':'{}');
 writeFileSync(profile+'/transport-journal.json','{}');writeFileSync(profile+'/posting-preflight-v1.json','{"version":1,"entries":{}}');
 let closed=false;const stop=()=>{if(!closed){store.db.close();closed=true;}};
 const message=(id:string,status='draft',text='待复核正文',review=false)=>{
  const event:Event={id,platformId:'platform-'+id,userId:'user-'+id,channel:'public',handle:'visitor',text:'原始消息',url:'https://x.com/visitor/status/123',conversationId:'thread',timestamp:Date.now(),timestampReliable:true};
  store.ingest(event,'worker');const row=store.getMessage(id,'worker');store.update(row.id,status,{draft:{action:'reply',text,reason:'来源保留',...(review?{review:true,previous:{action:'reply',text:'上一次草稿',reason:'此前草稿'}}:{})}});return store.getMessage(row.id,'worker');
 };
 const invoke=(apply=false,stopped=true)=>{stop();const args=[helper,'--db',path,'--browser-profile',profile,...(apply?['--apply']:['--check']),...(stopped?['--confirm-stopped']:[])];const result=spawnSync('python3',args,{encoding:'utf8',timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(result.error,undefined,result.error?.message);assert.ok(result.stdout.trim(),result.stderr);return {code:result.status,report:JSON.parse(result.stdout)};};
 const files=()=>Object.fromEntries([...externals.map(name=>root+'/'+name),root+'/panel/settings.json',root+'/panel/model-keys.json',profile+'/transport-journal.json',profile+'/posting-preflight-v1.json'].map(file=>[file,readFileSync(file,'utf8')]));
 return {root,path,profile,store,outbox,ledger,settings,message,invoke,stop,files,close(){stop();rmSync(root,{recursive:true,force:true});}};
}
function state(path:string){const db=new DatabaseSync(path,{readOnly:true});try{const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as any[],rows:Record<string,any[]>={};for(const item of schema.filter(r=>r.type==='table'))rows[item.name]=db.prepare('SELECT * FROM "'+item.name.replaceAll('"','""')+'" ORDER BY rowid').all() as any[];return {schema,rows};}finally{db.close();}}

test('离线只读检查不写库或证据，执行只转换批准/重写和长prepared，全部新结构供再升级复用',()=>{
 const f=fixture();try{
  const approved=f.message('approved','approved'),review=f.message('rewrite','queued','重写前保留的正文',true),normal=f.message('normal','queued');
  const long=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'long',text:'x'.repeat(281)}),short=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'short',text:'短帖候选'});
  f.store.db.prepare("INSERT INTO alerts(id,account_id,key,level,summary,started_at,last_seen_at,resolved_at) VALUES('old-alert','worker','model','attention','已恢复告警',1,2,3)").run();
  f.store.db.prepare("INSERT INTO daily_reports VALUES('2026-10-28','worker',1,'{}')").run();
  f.store.db.prepare("INSERT INTO replay_runs(id,account_id,created_at,updated_at,status,settings_json,persona_json,baseline_mode,estimate_json) VALUES('finished','worker',1,2,'aborted','{}','{}','actual','{}')").run();
  f.stop();const before=state(f.path),external=f.files(),file=readFileSync(f.path);
  const check=f.invoke();assert.equal(check.code,0,JSON.stringify(check.report));assert.equal(check.report.applied,false);assert.equal(check.report.plan.approvedToDraft,1);assert.equal(check.report.plan.reviewToDraft,1);assert.equal(check.report.plan.preparedToCancelled,1);assert.deepEqual(readFileSync(f.path),file);assert.deepEqual(state(f.path),before);assert.deepEqual(f.files(),external);
  const applied=f.invoke(true);assert.equal(applied.code,0,JSON.stringify(applied.report));assert.equal(applied.report.applied,true);assert.equal(applied.report.resumeAllowed,false);
  const after=state(f.path);assert.deepEqual(after.schema,before.schema);assert.deepEqual(after.rows.schema_migrations,before.rows.schema_migrations);assert.deepEqual(after.rows.replay_runs,before.rows.replay_runs);assert.deepEqual(after.rows.alerts,before.rows.alerts);assert.deepEqual(after.rows.daily_reports,before.rows.daily_reports);
  for(const id of [approved.id,review.id]){const old=before.rows.messages.find(r=>r.id===id),row=after.rows.messages.find(r=>r.id===id);assert.equal(row.status,'draft');assert.equal(row.draft,old.draft);assert.equal(row.body,old.body);}
  assert.equal(after.rows.messages.find(r=>r.id===normal.id).status,'queued');assert.equal(after.rows.outbox.find(r=>r.id===long.id).status,'cancelled');assert.equal(after.rows.outbox.find(r=>r.id===short.id).status,'prepared');
  for(const prior of before.rows.outbox){const row=after.rows.outbox.find(r=>r.id===prior.id);assert.equal(row.text,prior.text);assert.equal(row.validation_json,prior.validation_json);assert.equal(row.receipt,prior.receipt);}
  assert.deepEqual(f.files(),external);assert.equal(f.invoke(true).code,0);assert.equal(readdirSync(f.root).some(name=>/backup|\.bak|snapshot/.test(name)),false);
  const upgraded=new Store(f.path);try{new Outbox(upgraded);new ReplyTriage(upgraded);new RuntimeHealth(upgraded);assert.equal((upgraded.db.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as any).n,12);assert.equal(upgraded.get('control'),'paused');assert.equal(upgraded.getMessage(approved.id,'worker').status,'draft');}finally{upgraded.db.close();}
 }finally{f.close();}
});

test('新预检终态完成对账后保留两日志、冻结正文与校验，普通unknown仍仅可回查',()=>{
 const f=fixture();try{
  const blocked=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'not-submitted',text:'安全短帖'});assert.equal(f.outbox.begin(blocked.id),true);
  const receipt={status:'not_submitted' as const,reason:'编辑器未允许提交',validation:{...validatePostingText(blocked.text,'post'),allowed:false,code:'editor-unavailable',reason:'编辑器未允许提交'}};f.outbox.settle(blocked.id,receipt);
  const unknown=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'unknown',text:'正常待回查短帖'});f.outbox.begin(unknown.id);f.outbox.settle(unknown.id,{status:'unknown'});
  const entry=(row:any,r:any)=>({kind:row.kind,handle:'worker',targetId:row.target_id,textHash:createHash('sha256').update(row.text).digest('hex'),at:Date.now(),receipt:r});
  writeFileSync(f.profile+'/posting-preflight-v1.json',JSON.stringify({version:1,entries:{[blocked.id]:entry(blocked,receipt)}}));writeFileSync(f.profile+'/transport-journal.json',JSON.stringify({[unknown.id]:entry(unknown,{status:'unknown'})}));
  const files=f.files();const result=f.invoke(true);assert.equal(result.code,0,JSON.stringify(result.report));assert.deepEqual(f.files(),files);const after=state(f.path);assert.equal(after.rows.outbox.find(r=>r.id===blocked.id).status,'cancelled');assert.equal(after.rows.outbox.find(r=>r.id===unknown.id).status,'unknown');
 }finally{f.close();}
});

test('没有停止确认、非暂停、未收束提交/长unknown/模型/回放/任务及未知schema均拒绝且原子保留',()=>{
 const variants:Array<{name:string;change:(f:ReturnType<typeof fixture>)=>void;stopped?:boolean}>=[
  {name:'缺少停止确认',change:()=>{},stopped:false},
  {name:'running控制',change:f=>f.store.set('control','running')},
  {name:'人工接管',change:f=>f.store.set('control','manual')},
  {name:'submitting',change:f=>{const row=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'submitting',text:'未收束'});f.outbox.begin(row.id);}},
  {name:'unknown长帖',change:f=>{const row=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'long-unknown',text:'x'.repeat(281)});f.store.db.prepare("UPDATE outbox SET status='unknown' WHERE id=?").run(row.id);}},
  {name:'unknown长回复',change:f=>{f.message('unknown-message','unknown','汉'.repeat(141));}},
  {name:'未完成模型',change:f=>{f.ledger.start({provider:'custom',id:'fixture'},{purpose:'reply'});}},
  {name:'running回放',change:f=>{f.store.db.prepare("INSERT INTO replay_runs(id,account_id,created_at,updated_at,status,settings_json,persona_json,baseline_mode,estimate_json) VALUES('active','worker',1,2,'running','{}','{}','actual','{}')").run();}},
  {name:'未结束任务',change:f=>{f.store.db.prepare("INSERT INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at) VALUES('active','daily-state','worker',1,'manual','running',1)").run();}},
  {name:'有效骚扰冷却',change:f=>{f.store.db.prepare("INSERT INTO triage_ignores VALUES('worker','user','public',?,'骚扰','[]')").run(Date.now()+60000);}},
  {name:'未来迁移',change:f=>{f.store.db.prepare('INSERT INTO schema_migrations VALUES(99,?,1)').run('future');}},
  {name:'未知表',change:f=>{f.store.db.exec('CREATE TABLE future_table(id TEXT)');}},
  {name:'未知列',change:f=>{f.store.db.exec('ALTER TABLE outbox ADD COLUMN future_column TEXT');}},
  {name:'未知状态',change:f=>{f.message('future','future-status');}},
 ];
 for(const variant of variants){const f=fixture();try{f.message('would-change','approved');variant.change(f);f.stop();const before=state(f.path),files=f.files();const result=f.invoke(true,variant.stopped??true);assert.equal(result.code,2,variant.name+':'+JSON.stringify(result.report));assert.equal(result.report.applied,false);assert.deepEqual(state(f.path),before);assert.deepEqual(f.files(),files);}finally{f.close();}}
});

test('损坏或未对账预检、日志正文不符和模型库未物化均拒绝，绝不清理证据',()=>{
 const variants:Array<(f:ReturnType<typeof fixture>)=>void>=[
  f=>{writeFileSync(f.profile+'/posting-preflight-v1.json','{"version":2,"entries":{}}');},
  f=>{writeFileSync(f.profile+'/posting-preflight-v1.json',JSON.stringify({version:1,entries:{missing:{receipt:{status:'not_submitted',validation:{}}}}}));},
  f=>{const row=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'u',text:'正文'});f.outbox.begin(row.id);f.outbox.settle(row.id,{status:'unknown'});writeFileSync(f.profile+'/transport-journal.json',JSON.stringify({[row.id]:{kind:'post',handle:'worker',targetId:'',textHash:'wrong',at:1,receipt:{status:'unknown'}}}));},
  f=>{const settings=structuredClone(f.settings);settings.model.id='mismatched';writeFileSync(f.root+'/panel/settings.json',JSON.stringify(settings));},
  f=>{writeFileSync(f.root+'/panel/settings.json','{"model":"broken"}');},
 ];
 for(const change of variants){const f=fixture();try{change(f);f.stop();const before=state(f.path),files=f.files();const result=f.invoke(true);assert.equal(result.code,2,JSON.stringify(result.report));assert.equal(result.report.applied,false);assert.deepEqual(state(f.path),before);assert.deepEqual(f.files(),files);}finally{f.close();}}
});

test('兼容转换中途失败回滚全部状态，外部设置及新日志从不改写',()=>{
 const f=fixture();try{
  f.message('approved','approved');f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'long',text:'x'.repeat(281)});f.stop();const before=state(f.path),files=f.files();
  const code='import importlib.util,json,sys; s=importlib.util.spec_from_file_location("prepare_rollback",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); original=m.prepare; m.prepare=lambda connection,actions:(original(connection,actions),(_ for _ in ()).throw(RuntimeError("注入转换后异常"))); report,status=m.run(sys.argv[2],sys.argv[3],True,True); print(json.dumps(report,ensure_ascii=False)); sys.exit(status)';
  const result=spawnSync('python3',['-c',code,helper,f.path,f.profile],{encoding:'utf8',timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).applied,false);assert.deepEqual(state(f.path),before);assert.deepEqual(f.files(),files);
 }finally{f.close();}
});
