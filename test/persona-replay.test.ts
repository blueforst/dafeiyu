import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MemoryService } from '../src/memory.js';
import { Outbox } from '../src/outbox.js';
import { PersonaService, legacyPersona } from '../src/persona.js';
import { ReplayRunner, boundedGenerationSnapshot, captureGenerationSnapshot, invalidateReplayMemory, pruneReplayData, qualityMetrics } from '../src/persona-replay.js';
import { registerReplayRoutes } from '../src/replay-routes.js';
import { LlmStore } from '../src/llm-store.js';
import type { Generator, GenerationResult } from '../src/model.js';
import type { Config, Event, Channel } from '../src/types.js';
import { exampleConfig } from './config-fixture.js';

type Invocation = {system:string;user:string;signal?:AbortSignal;session?:string;meta:any};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'persona-replay-')),prior=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(join(dir,'workflow.sqlite'));store.set('control','paused');new Outbox(store);
 let now=Date.parse('2026-10-28T12:00:00+08:00'),account='worker-a',produce:((r:Invocation)=>Promise<GenerationResult>)|undefined;
 const config=()=>({...structuredClone(exampleConfig),model:{...exampleConfig.model,provider:'custom',id:'mock-model',baseUrl:'https://mock.invalid'}}) as Config;
 const ledger=new LlmStore(store),calls:Invocation[]=[];
 const generator:Generator={async complete(c,system,user,signal,session,meta){
  const request={system,user,signal,session,meta};calls.push(request);const id=ledger.start(c.model,meta,now);
  try{
   const result=produce?await produce(request):{text:system.includes('语义路由器')?' {"matches":[]} ':JSON.stringify({action:'reply',text:'候选自然回应',reason:'回应'}),input:12,output:5,cache:0};
   ledger.finish(id,'completed',{usage:{input:result.input,output:result.output,cacheRead:result.cache,cacheWrite:0,totalTokens:result.input+result.output+result.cache},pricingStatus:result.pricingStatus??'unpriced',cost:result.cost??null},now);
   return {...result,callId:id};
  }catch(error){ledger.finish(id,signal?.aborted?'aborted':'failed',{},now);throw error;}
 }};
 const persona=new PersonaService(store,generator,config),memory=new MemoryService(store,generator,config,()=>now);
 const replay=new ReplayRunner(store,persona,generator,{accountId:()=>account,config,now:()=>now,memory:(userId,channel,accountId,at)=>memory.context(userId,channel,accountId,at)});
 const add=(id:number,over:Partial<Event>={},status='confirmed',accountId=account)=>{
  const event:Event={id:'message-'+id,platformId:String(id),userId:'user-'+id,channel:'public',handle:'person'+id,text:'真实消息'+id,url:'https://x.com/person'+id+'/status/'+id,conversationId:'thread-'+id,timestamp:now-id*60000,timestampReliable:true,...over};
  store.ingest(event,accountId);const row=store.db.prepare('SELECT * FROM messages WHERE account_id=? AND platform_id=?').get(accountId,event.platformId!) as any;
  store.update(row.id,status,{draft:status==='skipped'?{action:'skip',text:'',reason:'当时不适合回复'}:{action:'reply',text:'当时实际回复'+id,reason:'历史回应'}},accountId);
  return JSON.parse(store.getMessage(row.id,accountId).body) as Event;
 };
 const estimate=(options:any={})=>replay.estimate({persona:legacyPersona('未保存候选'),personaRevision:persona.get().revision,baselineMode:'actual',filter:{limit:20,order:'latest'},...options});
 const tableState=()=>Object.fromEntries(['messages','outbox','memory','memory_items','role_experiences'].map(table=>[table,JSON.stringify(store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all())]));
 return {store,persona,memory,replay,generator,ledger,calls,add,estimate,tableState,config,now:()=>now,setNow:(value:number)=>now=value,setAccount:(value:string)=>account=value,setProduce:(fn:typeof produce)=>produce=fn,async close(){await replay.close();store.db.close();if(prior===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}};
}

test('回放样本绑定工作账号，私信需明确勾选且默认只返回折叠元数据',async()=>{
 const f=fixture();try{
  const pub=f.add(1),dm=f.add(2,{channel:'private',text:'不应出现在预览汇总的秘密'});f.add(3,{},'confirmed','worker-b');f.add(4,{},'queued');
  const normal=f.replay.samples();assert.deepEqual(normal.items.map(x=>x.id),[pub.id]);
  assert.throws(()=>f.replay.samples({channel:'private'}),/单独确认/);
  const selected=f.replay.samples({channel:'all',includePrivate:true});assert.equal(selected.items.length,2);assert.ok(!JSON.stringify(selected).includes('秘密'));assert.equal(selected.items.find(x=>x.id===dm.id)?.collapsed,true);
  assert.throws(()=>f.replay.samples({limit:51}),/50/);f.setAccount('');assert.throws(()=>f.replay.samples(),/账号/);
 }finally{await f.close();}
});

test('遗忘用户和删除来源不可选，旧来源重新出现仍被排除',async()=>{
 const f=fixture();try{
  const hidden=f.add(1),deleted=f.add(2),visible=f.add(3);
  f.store.forget(hidden.userId,'worker-a');
  f.store.db.prepare('INSERT INTO memory_ignored VALUES(?,?,?,?,?)').run('worker-a',deleted.userId,'public',deleted.id,f.now());
  // 模拟旧数据库恢复时重新出现的已遗忘原文。
  f.store.db.prepare('INSERT INTO messages(id,account_id,source_id,platform_id,target_id,channel,user_id,body,status,created_at,updated_at,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(hidden.id,'worker-a',hidden.id,hidden.platformId,'','public',hidden.userId,JSON.stringify(hidden),'confirmed',hidden.timestamp,f.now(),f.now());
  const samples=f.replay.samples();assert.deepEqual(samples.items.map(x=>x.id),[visible.id]);assert.equal(samples.excluded,2);
 }finally{await f.close();}
});

test('生成快照上限为16KiB，截断早期对话且不修改调用者原始上下文',async()=>{
 const f=fixture();try{
  const event=f.add(1),original={conversation:Array.from({length:50},(_,i)=>({text:'旧'.repeat(400)+i})),memory:{text:'保留的允许记忆'},hintMeta:{kinds:['language']},personaRevision:2};
  const before=JSON.stringify(original),bounded=boundedGenerationSnapshot(original);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded),'utf8')<=16384);assert.equal(bounded.truncated,true);assert.equal(JSON.stringify(original),before);
  assert.equal(captureGenerationSnapshot(f.store,event,original,f.now()),true);
  const saved=f.store.db.prepare('SELECT body_json FROM generation_snapshots WHERE message_id=?').get(event.id) as any;assert.ok(Buffer.byteLength(saved.body_json,'utf8')<=16384);assert.ok(!JSON.stringify(f.store.logs()).includes('保留的允许记忆'));
  f.store.forget(event.userId,'worker-a');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM generation_snapshots').get()!.n,0);
 }finally{await f.close();}
});

test('质量指标用共同开头规则，20条中6条重复为30%，不调用模型评审',()=>{
 const items=Array.from({length:20},(_,i)=>({action:'reply' as const,text:i<6?'相同开头，后文'+i:'唯一'+String.fromCharCode(0x4e00+i)+'开头，后文',channel:'public' as const}));
 const metrics=qualityMetrics(items);assert.equal(metrics.openingRepeatRate,.3);assert.equal(metrics.topOpenings[0].count,6);assert.equal(metrics.replies,20);
 const flags=qualityMetrics([{action:'reply',text:'(^ω^) 😀～\n1. 先做\n2. 后做 https://example.com @alice',channel:'public'},{action:'reply',text:'a'.repeat(281),channel:'public'},{action:'skip',text:'',channel:'private'}]);
 assert.equal(flags.skipRate,1/3);assert.equal(flags.kaomojiPerTen,5);assert.equal(flags.emojiPerTen,5);assert.equal(flags.tildePerTen,5);assert.equal(flags.stepsRate,.5);assert.equal(flags.forbiddenLinks,1);assert.equal(flags.forbiddenMentions,1);assert.equal(flags.publicLengthViolations,1);
});

test('回放保留有界禁用内容结果用于确定性违规计数，仍不写生产出站',async()=>{
 const f=fixture();try{
  f.add(1);f.setProduce(async()=>({text:JSON.stringify({action:'reply',text:'请看 https://example.com @alice',reason:'模型违规样本'}),input:1,output:1,cache:0}));
  const before=f.tableState(),run=f.replay.start(f.estimate().estimateId,true);await f.replay.waitIdle();const result=f.replay.detail(run.id);
  assert.equal(result.status,'completed');assert.match(result.items[0].candidate.validationError,/禁用/);assert.equal(result.summary.candidate.forbiddenLinks,1);assert.equal(result.summary.candidate.forbiddenMentions,1);assert.equal(result.summary.candidate.publicLengthViolations,0);assert.deepEqual(f.tableState(),before);
 }finally{await f.close();}
});

test('预估只读、请求数含语义，费用未知不冒充免费，开始必须确认并复核修订',async()=>{
 const f=fixture();try{
  f.add(1);f.add(2);const candidate=legacyPersona('候选');candidate.triggers=[{id:'replay-style-trigger',title:'风格',condition:'有人问候',content:'自然回应',enabled:true,order:0}];
  const state=f.tableState(),estimate=f.estimate({persona:candidate});assert.equal(estimate.requests,4);assert.equal(estimate.estimatedUsd,null);assert.match(estimate.note,/不代表免费/);assert.equal(f.calls.length,0);assert.deepEqual(f.tableState(),state);
  assert.throws(()=>f.replay.start(estimate.estimateId,false),/确认/);f.persona.save(legacyPersona('他人更新'),0);assert.throws(()=>f.replay.start(estimate.estimateId,true),/修订/);assert.equal(f.calls.length,0);
 }finally{await f.close();}
});

test('费用预估采用相同模型的Pi已定价历史，重新生成基线计入两侧请求',async()=>{
 const f=fixture();try{
  f.add(1);const candidate=legacyPersona('候选');candidate.triggers=[{id:'one',title:'条件',condition:'问候',content:'回应',enabled:true,order:0}];f.persona.save(candidate,0);
  for(const [purpose,cost] of [['reply',.004],['semantic-trigger',.002]] as const){const id=f.ledger.start(f.config().model,{purpose,accountId:'worker-a'},f.now());f.ledger.finish(id,'completed',{usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15},pricingStatus:'priced',cost:{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost}},f.now());}
  const estimate=f.estimate({persona:candidate,baselineMode:'saved'});assert.equal(estimate.requests,4);assert.equal(estimate.estimatedUsd,.012);assert.equal(estimate.pricingStatus,'estimated');
 }finally{await f.close();}
});

test('双版本回放复用组装并独立会话和计费，不改写消息、出站、记忆或经历',async()=>{
 const f=fixture();try{
  const event=f.add(1);captureGenerationSnapshot(f.store,event,{conversation:[{text:'当时对话'}],memory:{text:'不得复活的旧记忆'},personaRevision:0},f.now());
  const state=f.tableState(),estimate=f.estimate({baselineMode:'saved'}),run=f.replay.start(estimate.estimateId,true);await f.replay.waitIdle();
  const detail=f.replay.detail(run.id);assert.equal(detail.status,'completed');assert.equal(detail.items[0].candidate.draft.text,'候选自然回应');assert.equal(f.calls.length,2);assert.ok(f.calls.every(x=>x.meta.purpose==='persona-replay'&&x.meta.source==='panel-replay'&&x.meta.interactionId===run.id&&x.meta.jsonObject===true));assert.equal(new Set(f.calls.map(x=>x.session)).size,2);assert.ok(f.calls.every(x=>x.session?.startsWith('replay-'+run.id)));assert.ok(f.calls.every(x=>x.user.includes('当时对话')&&!x.user.includes('不得复活的旧记忆')));assert.deepEqual(f.tableState(),state);assert.equal(detail.summary.fees.calls,2);assert.equal(f.store.get('control'),'paused');
 }finally{await f.close();}
});

test('实际回复基线不请求模型，旧消息标注上下文不完整，标注汇总且采用修订冲突',async()=>{
 const f=fixture();try{
  const event=f.add(1,{},'skipped'),estimate=f.estimate(),run=f.replay.start(estimate.estimateId,true);await f.replay.waitIdle();
  const detail=f.replay.detail(run.id);assert.equal(f.calls.length,1);assert.equal(detail.items[0].baseline.draft.action,'skip');assert.equal(detail.items[0].baseline.draft.reason,'当时不适合回复');assert.equal(detail.items[0].candidate.contextIncomplete,true);
  const labeled=f.replay.label(run.id,event.id,'candidate',['template-opening','should-skip']);assert.equal(labeled.summary.labels.candidate,1);assert.equal(labeled.summary.issues['template-opening'],1);assert.throws(()=>f.replay.label(run.id,event.id,'nonsense',[]),/标记/);
  f.persona.save(legacyPersona('别人保存的稿'),0);assert.throws(()=>f.replay.adopt(run.id),/修订|修改/);assert.equal(f.persona.get().persona.sections[0].content,'别人保存的稿');
 }finally{await f.close();}
});

test('回放语义判定与回复全部按persona-replay计费，不混入生产语义用途',async()=>{
 const f=fixture();try{
  f.add(1);const candidate=legacyPersona('未保存候选');candidate.triggers=[{id:'greet',title:'问候',condition:'对方问好',content:'自然问候',enabled:true,order:0}];
  const run=f.replay.start(f.estimate({persona:candidate}).estimateId,true);await f.replay.waitIdle();assert.equal(f.calls.length,2);assert.ok(f.calls.some(x=>x.system.includes('语义路由器')));assert.ok(f.calls.every(x=>x.meta.purpose==='persona-replay'&&x.meta.source==='panel-replay'&&x.meta.jsonObject===true));assert.equal(f.ledger.calls({purpose:'semantic-trigger'}).items.length,0);assert.equal(f.replay.detail(run.id).summary.fees.calls,2);
 }finally{await f.close();}
});

test('中止保留已完成条目，当前请求被中止后其余条目不再调用',async()=>{
 const f=fixture();let reached!:()=>void;const ready=new Promise<void>(resolve=>reached=resolve);
 try{
  f.add(1);f.add(2);f.add(3);f.setProduce(async request=>{
   if(f.calls.length===2){reached();return new Promise((_resolve,reject)=>request.signal!.addEventListener('abort',()=>reject(new Error('中止')),{once:true}));}
   return {text:'{"action":"reply","text":"完成第一条","reason":"回应"}',input:1,output:1,cache:0};
  });
  const estimate=f.estimate(),run=f.replay.start(estimate.estimateId,true);await ready;f.replay.abort(run.id);await f.replay.waitIdle();
  const detail=f.replay.detail(run.id);assert.equal(detail.status,'aborted');assert.equal(detail.summary.completed,1);assert.equal(f.calls.length,2);assert.equal(detail.items.filter(x=>x.status==='completed').length,1);assert.equal(f.ledger.calls({interactionId:run.id}).items.filter(x=>x.status==='aborted').length,1);
 }finally{await f.close();}
});

test('回放中遗忘来源不会重新写入已移除结果，读回和质量汇总都不泄露原文',async()=>{
 const f=fixture();let reached!:()=>void,finish!:(v:GenerationResult)=>void;const ready=new Promise<void>(resolve=>reached=resolve);
 try{
  const event=f.add(1,{text:'需要遗忘的真实原文'});captureGenerationSnapshot(f.store,event,{conversation:[{text:'需要遗忘的旧对话'}]},f.now());
  f.setProduce(async()=>{reached();return new Promise(resolve=>finish=resolve);});const estimate=f.estimate(),run=f.replay.start(estimate.estimateId,true);await ready;
  f.store.forget(event.userId,'worker-a');finish({text:'{"action":"reply","text":"不应写回","reason":"旧请求"}',input:1,output:1,cache:0});await f.replay.waitIdle();
  assert.equal(f.replay.detail(run.id).items.length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM generation_snapshots').get()!.n,0);assert.ok(!JSON.stringify(f.replay.list()).includes('需要遗忘'));assert.equal(f.replay.quality().metrics.total,0);
 }finally{await f.close();}
});

test('人工记忆失效和原文保留清理覆盖快照及派生条目',async()=>{
 const f=fixture();try{
  const event=f.add(1);captureGenerationSnapshot(f.store,event,{conversation:[{text:'有效对话'}],memory:{text:'旧记忆快照'}},f.now());invalidateReplayMemory(f.store,'worker-a',event.userId,'public');
  const snapshot=JSON.parse((f.store.db.prepare('SELECT body_json FROM generation_snapshots WHERE message_id=?').get(event.id) as any).body_json);assert.equal(snapshot.memory,undefined);assert.equal(snapshot.memoryInvalidated,true);
  const run=f.replay.start(f.estimate().estimateId,true);await f.replay.waitIdle();f.store.db.prepare('DELETE FROM messages WHERE id=?').run(event.id);pruneReplayData(f.store,0);assert.equal(f.replay.detail(run.id).items.length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM generation_snapshots').get()!.n,0);
 }finally{await f.close();}
});

test('保留最近二十次运行且允许单次删除，其他账号无法读取运行',async()=>{
 const f=fixture();try{
  f.add(1);let first='';for(let i=0;i<21;i++){f.setNow(f.now()+1000);const run=f.replay.start(f.estimate().estimateId,true);if(i===0)first=run.id;await f.replay.waitIdle();}
  const list=f.replay.list();assert.equal(list.items.length,20);assert.ok(!list.items.some(x=>x.id===first));assert.throws(()=>f.replay.detail(first),/不存在/);
  const latest=list.items[0].id;f.setAccount('worker-b');assert.throws(()=>f.replay.detail(latest),/不存在/);f.setAccount('worker-a');assert.equal(f.replay.delete(latest).ok,true);assert.equal(f.replay.list().items.length,19);
 }finally{await f.close();}
});

test('回放HTTP接口继承入口鉴权，私信正文只在明确的条目详情返回',async()=>{
 const f=fixture(),app=Fastify();try{
  const event=f.add(1,{channel:'private',text:'受鉴权私信正文'});app.addHook('onRequest',async(req,reply)=>{if(req.headers['x-test-auth']!=='valid')return reply.code(401).send({error:'未授权'});});registerReplayRoutes(app,{store:f.store,replay:f.replay});await app.ready();const headers={'x-test-auth':'valid'};
  assert.equal((await app.inject({url:'/api/persona/replay/samples'})).statusCode,401);
  const estimate=await app.inject({method:'POST',url:'/api/persona/replay/estimate',headers,payload:{persona:legacyPersona('候选'),personaRevision:0,baselineMode:'actual',filter:{channel:'private',includePrivate:true,limit:1}}});assert.equal(estimate.statusCode,200);assert.ok(!estimate.body.includes('受鉴权私信正文'));
  const run=f.replay.start(estimate.json().estimateId,true);await f.replay.waitIdle();const detail=await app.inject({url:'/api/persona/replay/runs/'+run.id,headers});assert.ok(!detail.body.includes('受鉴权私信正文'));
  const expanded=await app.inject({url:'/api/persona/replay/runs/'+run.id+'/items/'+encodeURIComponent(event.id),headers});assert.equal(expanded.statusCode,200);assert.equal(expanded.json().message.text,'受鉴权私信正文');assert.equal((await app.inject({url:'/api/persona/quality',headers})).statusCode,200);
 }finally{await app.close();await f.close();}
});

test('私信参与质量统计和回放汇总时保留数值指标，不暴露回复开头片段',async()=>{
 const f=fixture();try{
  const event=f.add(1,{channel:'private'});f.store.update(event.id,'confirmed',{draft:{action:'reply',text:'私密开头秘密内容，后文仅供私信使用',reason:'私信回应'}},'worker-a');
  const quality=f.replay.quality({channel:'private'});assert.equal(quality.metrics.replies,1);assert.equal(quality.metrics.privateOpeningsHidden,true);assert.deepEqual(quality.metrics.topOpenings,[]);assert.ok(!JSON.stringify(quality).includes('私密开头'));
  const estimate=f.estimate({filter:{channel:'private',includePrivate:true,limit:1}}),run=f.replay.start(estimate.estimateId,true);await f.replay.waitIdle();
  const detail=f.replay.detail(run.id);assert.equal(detail.summary.baseline.privateOpeningsHidden,true);assert.deepEqual(detail.summary.baseline.topOpenings,[]);assert.ok(!JSON.stringify(detail).includes('私密开头'));assert.ok(f.replay.item(run.id,event.id).baseline.draft.text.includes('私密开头'));
 }finally{await f.close();}
});

test('真实记忆编辑移除已有回放，恢复旧派生数据后删除账本重放仍使其失效',async()=>{
 const f=fixture();try{
  const event=f.add(1),itemId='memory-replay-source';
  f.store.db.prepare('INSERT INTO memory_items(id,account_id,user_id,channel,kind,text,source_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(itemId,'worker-a',event.userId,'public','fact','旧事实','complete',f.now(),f.now());
  f.store.db.prepare('INSERT INTO memory_sources VALUES(?,?,?)').run(itemId,event.id,f.now());
  captureGenerationSnapshot(f.store,event,{conversation:[{text:'原对话'}],memory:{text:'旧事实'}},f.now());
  const run=f.replay.start(f.estimate().estimateId,true);await f.replay.waitIdle();const oldReplay=f.store.db.prepare('SELECT * FROM replay_items WHERE run_id=?').get(run.id) as any;
  assert.equal(f.replay.detail(run.id).items.length,1);f.memory.edit(itemId,'worker-a','人工修订事实',1);assert.equal(f.replay.detail(run.id).items.length,0);
  let snapshot=JSON.parse((f.store.db.prepare('SELECT body_json FROM generation_snapshots WHERE message_id=?').get(event.id) as any).body_json);assert.equal(snapshot.memory,undefined);assert.equal(snapshot.memoryInvalidated,true);
  f.memory.remove(itemId,'worker-a',2);
  // 将旧库里的记忆与派生快照、条目恢复回来，保留当前外部删除账本。
  f.store.db.prepare('INSERT INTO memory_items(id,account_id,user_id,channel,kind,text,source_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(itemId,'worker-a',event.userId,'public','fact','人工修订事实','complete',f.now(),f.now());
  f.store.db.prepare('INSERT INTO memory_sources VALUES(?,?,?)').run(itemId,event.id,f.now());
  f.store.db.prepare('UPDATE generation_snapshots SET body_json=? WHERE message_id=?').run(JSON.stringify({conversation:[{text:'原对话'}],memory:{text:'已删除的人工修订事实'}}),event.id);
  const keys=Object.keys(oldReplay);f.store.db.prepare('INSERT INTO replay_items('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(oldReplay) as any[]);
  new MemoryService(f.store,f.generator,f.config,f.now);
  assert.equal(f.memory.items(event.userId,'public','worker-a').length,0);snapshot=JSON.parse((f.store.db.prepare('SELECT body_json FROM generation_snapshots WHERE message_id=?').get(event.id) as any).body_json);assert.equal(snapshot.memory,undefined);assert.equal(snapshot.memoryInvalidated,true);assert.equal(f.replay.detail(run.id).items.length,0);
 }finally{await f.close();}
});

test('基线生成期间真实编辑记忆会阻止候选新请求和旧结果回写',async()=>{
 const f=fixture();let reached!:()=>void,finish!:(v:GenerationResult)=>void;const ready=new Promise<void>(resolve=>reached=resolve);
 try{
  const event=f.add(1),itemId='memory-inflight';f.store.db.prepare('INSERT INTO memory_items(id,account_id,user_id,channel,kind,text,source_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(itemId,'worker-a',event.userId,'public','fact','生成前事实','complete',f.now(),f.now());
  f.store.db.prepare('INSERT INTO memory_sources VALUES(?,?,?)').run(itemId,event.id,f.now());f.setProduce(async()=>{reached();return new Promise(resolve=>finish=resolve);});
  const run=f.replay.start(f.estimate({baselineMode:'saved'}).estimateId,true);await ready;f.memory.edit(itemId,'worker-a','生成期间修订事实',1);finish({text:'{"action":"reply","text":"基线旧上下文结果","reason":"旧请求"}',input:1,output:1,cache:0});await f.replay.waitIdle();
  assert.equal(f.calls.length,1);assert.equal(f.replay.detail(run.id).items.length,0);assert.equal(f.memory.items(event.userId,'public','worker-a')[0].text,'生成期间修订事实');assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM replay_items WHERE run_id=?').get(run.id) as any).n,0);
 }finally{await f.close();}
});
