import {fakeConverse,assistant} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {PersonaService,legacyPersona} from '../src/persona.js';
import {ReplayRunner} from '../src/persona-replay.js';
import {LlmStore} from '../src/llm-store.js';
import {ModelLibraryService} from '../src/model-library.js';
import {ModelService} from '../src/model.js';
import {freezeReplayModel,type FrozenReplayModel,type ReplayPrice} from '../src/replay-model.js';
import {commitModelLibrary,readPanelSettings,writeModelKey,keySlot,toConfigModel} from '../src/settings.js';
import type {Config,Event} from '../src/types.js';
import type {Generator} from '../src/model.js';
import {exampleConfig} from './config-fixture.js';

function fixture(){
 const dir=mkdtempSync(tmpdir()+'/replay-model-'),old=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(dir+'/store.sqlite'),ledger=new LlmStore(store),calls:any[]=[],frozen:any[]=[];
 let clock=Date.parse('2026-10-28T12:00:00+08:00'),libraryRevision=7,keyVersion=1,config:Config={...structuredClone(exampleConfig),model:{...exampleConfig.model,provider:'custom',id:'base',api:'openai-completions',baseUrl:'https://base.example/v1',source:'panel',reasoningLevel:'off'}};
 let response:(c:Config,system:string)=>Promise<string>=async(c,system)=>system.includes('语义路由器')?' {"matches":[{"id":"semantic-one","reason":"语义命中"}]} ':JSON.stringify({action:'reply',text:c.model.id+' '+c.model.reasoningLevel+' 回应',reason:'对比'});
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(c,system,user,signal,sessionId,metadata){calls.push({c:structuredClone(c),system,user,signal,sessionId,metadata});const id=ledger.start(c.model,metadata,clock),text=await response(c,system),cost=c.model.id==='base' ? .01 : .03;ledger.finish(id,'completed',{latencyMs:c.model.id==='base'?100:300,usage:{input:100,output:20,cacheRead:10,cacheWrite:2,totalTokens:132},pricingStatus:c.model.id==='unpriced'?'unpriced':'priced',cost:c.model.id==='unpriced'?null:{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost}},clock+100);return {text,input:100,output:20,cache:10,callId:id};}};
 const persona=new PersonaService(store,generator,()=>structuredClone(config));
 const price=(known:boolean):ReplayPrice=>({source:'pi-builtin',known,input:known?1:null,output:known?2:null,cacheRead:known ? .1 : null,cacheWrite:known?1.2:null});
 const freezeModel=async(c:Config,g:Generator,valid:()=>void):Promise<FrozenReplayModel>=>{
  const captured=keyVersion,record={model:c.model.id,disposed:false};frozen.push(record);
  const assertCurrent=()=>{valid();if(record.disposed||captured!==keyVersion)throw new Error('模型 Key 已变化或失效，请重新预估');};
  return {price:price(c.model.id!=='unpriced'),assertCurrent,dispose(){record.disposed=true;},generator:{async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(...args){assertCurrent();return g.complete(...args);}}};
 };
 const replay=new ReplayRunner(store,persona,generator,{accountId:()=> 'worker',now:()=>clock,config:()=>structuredClone(config),modelLibraryRevision:()=>libraryRevision,resolveModel:async selection=>{
  if(selection.key!=='candidate-provider'||!['candidate','unpriced','base'].includes(selection.modelId)||!['off','low'].includes(selection.reasoningLevel))throw new Error('候选模型或推理档位不可用');
  return {model:{...structuredClone(config.model),id:selection.modelId,baseUrl:'https://candidate.example/v1',reasoning:selection.reasoningLevel!=='off',reasoningLevel:selection.reasoningLevel},revision:libraryRevision,selection};
 },freezeModel});
 const add=(n:number)=>{const event:Event={id:'sample-'+n,platformId:String(n),accountId:'worker',userId:'user-'+n,channel:'public',handle:'person'+n,text:'对比样本 '+n,conversationId:'conversation-'+n,url:'https://x.com/person'+n+'/status/'+n,timestamp:clock-n*1000,timestampReliable:true};store.ingest(event,'worker');const row=store.db.prepare('SELECT id FROM messages WHERE platform_id=?').get(String(n)) as any;store.update(row.id,'confirmed',{draft:{action:'reply',text:'历史',reason:'旧结果'}},'worker');};
 const settings=(extra:any={})=>({compare:'model',persona:persona.get().persona,personaRevision:persona.get().revision,baselineMode:'saved',modelCandidate:{key:'candidate-provider',modelId:'candidate',reasoningLevel:'low'},filter:{limit:20},...extra});
 const seed=()=>{for(const id of ['base','candidate'])for(const purpose of ['reply','semantic-trigger']){const call=ledger.start({provider:'custom',id},{purpose,accountId:'worker'},clock);ledger.finish(call,'completed',{usage:{input:100,output:20,cacheRead:10,cacheWrite:2,totalTokens:132},pricingStatus:'priced',cost:{input:.001,output:0,cacheRead:0,cacheWrite:0,total:.001}},clock);}};
 return {store,ledger,persona,replay,calls,frozen,add,settings,seed,config:()=>config,setConfig:(c:Config)=>config=c,setClock:(n:number)=>clock=n,now:()=>clock,changeLibrary:()=>libraryRevision++,changeKey:()=>keyVersion++,setResponse:(fn:typeof response)=>response=fn,async close(){await replay.close();store.db.close();if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});}};
}

test('模型对比拒绝修改人设、提醒、actual基线以及不可用候选，确认前没有请求',async()=>{
 const f=fixture();try{
  f.add(1);
  await assert.rejects(f.replay.estimate(f.settings({persona:legacyPersona('被修改的候选')})),/一次只比较一个变量/);
  await assert.rejects(f.replay.estimate(f.settings({baselineMode:'actual'})),/重新生成基线/);
  await assert.rejects(f.replay.estimate(f.settings({promptHints:{lateEnabled:false}})),/已保存的动态提醒/);
  await assert.rejects(f.replay.estimate(f.settings({modelCandidate:{key:'bad',modelId:'candidate',reasoningLevel:'low'}})),/不可用/);
  const estimate=await f.replay.estimate(f.settings());assert.equal(estimate.compare,'model');assert.equal(estimate.requests,4);assert.equal(f.calls.length,0);assert.throws(()=>f.replay.start(estimate.estimateId,false),/确认/);
 }finally{await f.close();}
});

test('候选未定价单独显示，已定价基线按冻结Pi价格估算而不是免费',async()=>{
 const f=fixture();try{
  f.add(1);f.seed();const estimate=await f.replay.estimate(f.settings({modelCandidate:{key:'candidate-provider',modelId:'unpriced',reasoningLevel:'off'}}));
  assert.equal(estimate.sides.baseline.pricingStatus,'estimated');assert.ok(estimate.sides.baseline.estimatedUsd>0);assert.equal(estimate.sides.candidate.pricingStatus,'unpriced');assert.equal(estimate.sides.candidate.estimatedUsd,null);assert.equal(estimate.estimatedUsd,null);assert.equal(estimate.sides.shared.requests,0);assert.equal(f.calls.length,0);
 }finally{await f.close();}
});

test('每样本只做一次语义判定，两侧共享同一prompt并分别真实计量，不改变active',async()=>{
 const f=fixture();try{
  const p=legacyPersona('同一份角色');p.triggers=[{id:'semantic-one',title:'语义',condition:'问候',content:'语义正文',enabled:true,order:0},{id:'keyword-one',title:'关键词',condition:'样本',content:'关键词正文',enabled:true,order:1}];f.persona.save(p,0);f.add(1);f.add(2);f.seed();
  const active=JSON.stringify(f.config()),estimate=await f.replay.estimate(f.settings());assert.equal(estimate.requests,8);const run=f.replay.start(estimate.estimateId,true);await f.replay.waitIdle();
  const result=f.replay.detail(run.id);assert.equal(result.status,'completed');assert.equal(result.compare,'model');assert.equal(result.canAdopt,false);assert.equal(f.calls.filter(c=>c.system.includes('语义路由器')).length,0);assert.equal(f.calls.length,4);
  const generations=f.calls.filter(c=>!c.system.includes('语义路由器'));for(let i=0;i<generations.length;i+=2){assert.equal(generations[i].system,generations[i+1].system);assert.equal(generations[i].user,generations[i+1].user);assert.equal(generations[i].metadata.side,'baseline');assert.equal(generations[i+1].metadata.side,'candidate');assert.equal(generations[i+1].c.model.reasoningLevel,'low');}
  assert.equal(result.summary.sides.baseline.calls,2);assert.equal(result.summary.sides.candidate.calls,2);assert.equal(result.summary.sides.shared.calls,0);assert.equal(result.summary.sides.baseline.averageLatencyMs,100);assert.equal(result.summary.sides.candidate.averageLatencyMs,300);assert.equal(result.summary.sides.baseline.input,200);assert.equal(result.summary.sides.candidate.output,40);assert.equal(result.summary.sides.candidate.cacheRead,20);
  assert.ok(Math.abs(result.summary.fees.costUSD!-(result.summary.sides.baseline.costUSD+result.summary.sides.candidate.costUSD+result.summary.sides.shared.costUSD))<1e-10);assert.equal(f.ledger.calls({interactionId:run.id}).items.filter(c=>c.side==='shared').length,0);assert.equal(JSON.stringify(f.config()),active);assert.throws(()=>f.replay.adopt(run.id),/不能一键采用/);assert.ok(f.frozen.every(x=>x.disposed));
 }finally{await f.close();}
});

test('16条同模型开关思考只产生双侧回复，关键词卡片不增加路由请求',async()=>{
 const f=fixture();try{
  const p=legacyPersona('统一角色');p.triggers=[{id:'only-keywords',title:'规则',condition:'包含样本',content:'不给步骤',enabled:true,order:0}];f.persona.save(p,0);for(let i=1;i<=16;i++)f.add(i);
  const estimate=await f.replay.estimate(f.settings({modelCandidate:{key:'candidate-provider',modelId:'base',reasoningLevel:'low'}}));assert.equal(estimate.requests,64);const run=f.replay.start(estimate.estimateId,true);await f.replay.waitIdle();assert.equal(f.calls.length,32);assert.equal(f.calls.filter(c=>c.system.includes('语义路由器')).length,0);assert.equal(f.replay.detail(run.id).summary.completed,16);
 }finally{await f.close();}
});

test('外部模型或Key变化使预估失效，过期、显式取消和销毁清理内存冻结凭据',async()=>{
 const f=fixture();try{
  f.add(1);const first=await f.replay.estimate(f.settings());f.changeLibrary();assert.throws(()=>f.replay.start(first.estimateId,true),/变化/);assert.ok(f.frozen.every(x=>x.disposed));
  const second=await f.replay.estimate(f.settings());f.changeKey();assert.throws(()=>f.replay.start(second.estimateId,true),/Key/);assert.ok(f.frozen.every(x=>x.disposed));
  const third=await f.replay.estimate(f.settings());f.setClock(f.now()+600001);assert.throws(()=>f.replay.start(third.estimateId,true),/过期/);assert.ok(f.frozen.every(x=>x.disposed));
  const fourth=await f.replay.estimate(f.settings());f.replay.cancelEstimate(fourth.estimateId);assert.ok(f.frozen.every(x=>x.disposed));const fifth=await f.replay.estimate(f.settings());assert.ok(fifth.estimateId);await f.replay.close();assert.ok(f.frozen.every(x=>x.disposed));assert.equal(f.calls.length,0);
 }finally{await f.close();}
});

test('模型库非写解析不触发首次迁移、激活或Key回显，并沿用模型参数校验',async()=>{
 const f=fixture();try{
  const service=new ModelLibraryService({store:f.store}),before=JSON.stringify(readPanelSettings());await assert.rejects(service.resolveSelection({key:'candidate',modelId:'unknown-candidate',reasoningLevel:'low'}),/先在模型库保存/);assert.equal(JSON.stringify(readPanelSettings()),before);
  const panel={provider:'custom',baseUrl:'https://resolver.example/v1',api:'openai-completions' as const,id:'unknown-candidate',reasoningLevel:'off' as const,custom:{contextWindow:65536,reasoning:true}};
  commitModelLibrary({version:1,providers:[{key:'candidate',provider:'custom',name:'候选',baseUrl:panel.baseUrl,api:panel.api,models:[{id:panel.id,source:'manual',params:{maxTokens:4096,timeoutMs:60000,reasoningLevel:'off'},custom:panel.custom}]}],active:{default:{key:'candidate',modelId:panel.id}}},0,panel);writeModelKey(keySlot(panel.provider,panel.baseUrl),'PRIVATE_RESOLVER_KEY_0000');
  const saved=JSON.stringify(readPanelSettings()),resolved=await service.resolveSelection({key:'candidate',modelId:panel.id,reasoningLevel:'low'});assert.equal(resolved.model.reasoningLevel,'low');assert.equal(Object.hasOwn(resolved.model,'maxTokens'),false);assert.equal(JSON.stringify(readPanelSettings()),saved);assert.ok(!JSON.stringify(resolved).includes('PRIVATE_RESOLVER_KEY_0000'));await assert.rejects(service.resolveSelection({key:'candidate',modelId:panel.id,reasoningLevel:'max'}),/不支持/);
 }finally{await f.close();}
});

test('真实模型服务的冻结包装只用内存Key与Pi目录快照，Key轮换后拒绝调用',async()=>{
 const f=fixture();try{
  const model=toConfigModel({provider:'custom',baseUrl:'https://frozen.example/v1',api:'openai-completions',id:'frozen-unknown',reasoningLevel:'off',custom:{contextWindow:65536,reasoning:false}}),config={...f.config(),model},seen:any[]=[];
  writeModelKey(keySlot(model.provider,model.baseUrl),'FROZEN_ONLY_MEMORY_KEY');
  const service=new ModelService(f.store,async(m,key,system,user,options)=>{seen.push({m,key,options});return {text:'{"action":"reply","text":"已冻结","reason":"测试"}',input:1,output:1,cache:0,stopReason:'stop',latencyMs:10};});
  const frozen=await freezeReplayModel(config,service,()=>{});assert.equal(frozen.price.known,false);assert.ok(!JSON.stringify(frozen.price).includes('FROZEN_ONLY_MEMORY_KEY'));await frozen.generator.complete(config,'系统','用户',undefined,'replay-session',{purpose:'persona-replay',side:'baseline',source:'panel-replay'});assert.equal(seen[0].key,'FROZEN_ONLY_MEMORY_KEY');assert.ok(seen[0].options.resolvedModel);assert.equal(seen[0].options.sessionId,'replay-session');
  writeModelKey(keySlot(model.provider,model.baseUrl),'ROTATED_KEY');assert.throws(frozen.assertCurrent,/Key/);await assert.rejects(frozen.generator.complete(config,'系统','用户'),/Key/);frozen.dispose();assert.ok(!JSON.stringify(f.ledger.calls()).includes('FROZEN_ONLY_MEMORY_KEY'));
 }finally{await f.close();}
});

test('完整默认模型对比路径不把两侧Key或完整端点写入运行快照、结果与普通日志',async()=>{
 const f=fixture();let replay:ReplayRunner|undefined;try{
  f.add(1);const base={...structuredClone(f.config().model),custom:{contextWindow:65536,reasoning:false}},candidate={provider:'custom',baseUrl:'https://candidate-default.example/v1?credential=private-endpoint-query',api:'openai-completions' as const,id:'candidate-default-unknown',reasoningLevel:'off' as const,custom:{contextWindow:65536,reasoning:true}};
  commitModelLibrary({version:1,providers:[{key:'candidate-default',provider:'custom',name:'候选',baseUrl:candidate.baseUrl,api:candidate.api,models:[{id:candidate.id,source:'manual',params:{maxTokens:4096,timeoutMs:60000,reasoningLevel:'off'},custom:candidate.custom}]}],active:{}},0);
  writeModelKey(keySlot(base.provider,base.baseUrl),'BASE_PRIVATE_MODEL_KEY');writeModelKey(keySlot(candidate.provider,candidate.baseUrl),'CANDIDATE_PRIVATE_MODEL_KEY');
  const seen:string[]=[],service=new ModelService(f.store,async(_m,key)=>{seen.push(key);const toolCalls:any[]=[{type:'toolCall',id:'safe-draft',name:'submit_draft',arguments:{action:'reply',text:'安全结果',reason:'模拟'}}],result={text:'',input:1,output:1,cache:0,stopReason:'toolUse',latencyMs:20};return {...result,toolCalls,assistant:assistant(result,toolCalls)};}),config=()=>({...structuredClone(f.config()),model:base}),persona=new PersonaService(f.store,service,config);
  replay=new ReplayRunner(f.store,persona,service,{accountId:()=> 'worker',config,now:f.now});const estimate=await replay.estimate({compare:'model',persona:persona.get().persona,personaRevision:persona.get().revision,baselineMode:'saved',modelCandidate:{key:'candidate-default',modelId:candidate.id,reasoningLevel:'low'},filter:{limit:1}});assert.equal(seen.length,0);
  const run=replay.start(estimate.estimateId,true);await replay.waitIdle();assert.deepEqual(seen,['BASE_PRIVATE_MODEL_KEY','CANDIDATE_PRIVATE_MODEL_KEY']);
  const exposed=JSON.stringify({estimate,result:replay.detail(run.id),rows:f.store.db.prepare('SELECT settings_json,estimate_json FROM replay_runs WHERE id=?').get(run.id),logs:f.store.logs(),calls:f.ledger.calls({interactionId:run.id})});
  for(const secret of ['BASE_PRIVATE_MODEL_KEY','CANDIDATE_PRIVATE_MODEL_KEY','private-endpoint-query'])assert.ok(!exposed.includes(secret));assert.equal(replay.detail(run.id).summary.sides.baseline.calls,1);assert.equal(replay.detail(run.id).summary.sides.candidate.calls,1);
 }finally{await replay?.close();await f.close();}
});
