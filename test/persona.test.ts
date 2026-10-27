import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { PersonaService,legacyPersona,validatePersona,FIXED_SYSTEM_RULES,visibleContext,type Persona } from '../src/persona.js';
import { LlmStore } from '../src/llm-store.js';
import type { Config } from '../src/types.js';
import type { Generator,GenerationResult } from '../src/model.js';
import { readPanelSettings,mergePanelSettings } from '../src/settings.js';
import { exampleConfig } from './config-fixture.js';

function fixture(run?:(n:number,system:string,user:string,c:Config,meta:any)=>Promise<GenerationResult>){
 const dir=mkdtempSync(join(tmpdir(),'role-persona-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(join(dir,'workflow.sqlite'));store.set('control','paused');let requests=0;
 const invocations:any[]=[];
 const generator:Generator={async complete(c,system,user,signal,session,meta){requests++;invocations.push({c,system,user,signal,session,meta});return run?run(requests,system,user,c,meta):{text:'{"action":"reply","text":"你好","reason":"回应"}',input:10,output:5,cache:0};}};
 const service=new PersonaService(store,generator,()=>structuredClone(exampleConfig) as Config);
 return {store,service,invocations,get requests(){return requests;},close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(dir,{recursive:true,force:true});}};
}
function rules():Persona {
 const p=legacyPersona('原有角色定义');p.triggers=[{id:'later',title:'后序规则',condition:'谈到书籍',content:'命中后序正文',enabled:true,order:2},{id:'first',title:'前序规则',condition:'谈到阅读',content:'命中前序正文',enabled:true,order:1},{id:'off',title:'关闭规则',condition:'任意时候',content:'禁止注入的关闭正文',enabled:false,order:0}];return p;
}

test('旧人格原文完整保留，不自动添加身份事实，最大旧文本仍可导入',()=>{
 const original='  原文\n第二行\n';assert.equal(legacyPersona(original).sections[0].content,original);
 assert.equal(validatePersona(legacyPersona('字'.repeat(20000))).sections[0].content.length,20000);
 const f=fixture();try{assert.equal(f.service.get().persona.sections[0].content,exampleConfig.persona);assert.equal(f.service.get().fixedRules,FIXED_SYSTEM_RULES);}finally{f.close();}
});

test('人设保存按域修订，不覆盖模型或恢复暂停，陈旧修订返回冲突',()=>{
 const f=fixture();try{
  mergePanelSettings('program',{mode:'draft'},0);
  const saved=f.service.save(rules(),0);assert.equal(saved.revision,1);assert.equal(readPanelSettings().program?.mode,'draft');assert.equal(f.store.get('control'),'paused');
  assert.throws(()=>f.service.save(legacyPersona('陈旧草稿'),0),/修订|更新|冲突|修改/);assert.equal(f.service.get().persona.sections[0].content,'原有角色定义');
 }finally{f.close();}
});

test('总长、重复ID、规则开关及顺序均校验',()=>{
 assert.throws(()=>validatePersona({...legacyPersona('字'.repeat(20000)),triggers:[{id:'x',title:'x',condition:'条件',content:'正文',enabled:true,order:0}]}),/20,000/);
 assert.throws(()=>validatePersona({...legacyPersona('原文'),triggers:[{id:'role',title:'x',condition:'条件',content:'正文',enabled:true,order:0}]}),/重复/);
 assert.throws(()=>validatePersona({...legacyPersona('原文'),triggers:[{id:'x',title:'x',condition:'条件',content:'正文',enabled:'yes',order:0}]}),/开关/);
});

test('无启用规则时无语义请求，固定约束始终存在',async()=>{
 const f=fixture();try{
  const p=rules();p.triggers.forEach(t=>t.enabled=false);
  const a=await f.service.assemble({persona:p,accountId:'worker-a',channel:'public',message:'你好'});
  assert.equal(f.requests,0);assert.equal(a.hits.length,0);assert.ok(a.system.includes(FIXED_SYSTEM_RULES));assert.ok(!a.system.includes('命中前序正文'));
 }finally{f.close();}
});

test('一次路由覆盖全部启用条件，未知重复ID忽略并按配置顺序注入',async()=>{
 const f=fixture(async()=>({text:JSON.stringify({matches:[{id:'later',reason:'书籍'},{id:'alien',reason:'未知'},{id:'first',reason:'阅读'},{id:'later',reason:'重复'},{id:'off',reason:'关闭'}]}),input:8,output:20,cache:0}));
 try{
  const a=await f.service.assemble({persona:rules(),accountId:'worker-a',channel:'public',message:'谈谈阅读',sessionId:'stable-session',interactionId:'interaction-1'});
  assert.equal(f.requests,1);assert.deepEqual(a.hits.map(h=>h.id),['first','later']);assert.ok(a.user.indexOf('命中前序正文')<a.user.indexOf('命中后序正文'));assert.ok(!a.system.includes('命中前序正文'));assert.ok(!a.user.includes('禁止注入的关闭正文'));
  const request=f.invocations[0],routing=JSON.parse(request.user);assert.deepEqual(routing.rules.map((r:any)=>r.id),['first','later']);assert.ok(!request.user.includes('命中前序正文'));assert.equal(request.meta.purpose,'semantic-trigger');assert.equal(request.meta.interactionId,'interaction-1');assert.equal(request.session,'stable-session');assert.equal(request.c.model.maxTokens,512);assert.equal(request.c.model.reasoning,false);
 }finally{f.close();}
});

test('格式失败回退静态内容、不重复路由，公开内容不带私信',async()=>{
 const f=fixture(async()=>({text:'不能解析',input:10,output:2,cache:0}));try{
  const a=await f.service.assemble({persona:rules(),accountId:'worker-a',channel:'public',message:'你好',memory:[{visibility:'private',summary:'私密资料'},{visibility:'public',summary:'公开资料'}],conversation:[{channel:'private',message:'私信内容'},{channel:'public',message:'公开对话'}]});
  assert.equal(f.requests,1);assert.ok(a.warning?.includes('静态'));assert.equal(a.hits.length,0);assert.ok(a.system.includes('原有角色定义'));assert.ok(!a.system.includes('命中前序正文'));assert.ok(!a.user.includes('私密资料'));assert.ok(!a.user.includes('私信内容'));assert.ok(a.user.includes('公开资料'));
  assert.deepEqual(visibleContext([{channel:'private',text:'x'}],'private'),[{channel:'private',text:'x'}]);
 }finally{f.close();}
});

test('生成保存后仍使用当前快照，日程与真实经历分层',async()=>{
 let finish!:(v:GenerationResult)=>void;
 const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));try{
  const persona=rules();const pending=f.service.assemble({persona,accountId:'worker-a',channel:'public',message:'阅读',dailyState:{fictional:true,activity:'散步'},experiences:[{visibility:'public',sourceId:'receipt-1',summary:'回复过问题'}]});
  await Promise.resolve();await Promise.resolve();persona.sections[0].content='后来的编辑';
  finish({text:'{"matches":[]}',input:1,output:1,cache:0});const a=await pending;
  assert.ok(a.system.includes('原有角色定义'));assert.ok(!a.system.includes('后来的编辑'));const daily=JSON.parse(a.segments.find(s=>s.kind==='daily')!.content),experiences=JSON.parse(a.segments.find(s=>s.kind==='experiences')!.content);assert.equal(daily.fictional,true);assert.equal(experiences.fictional,false);
 }finally{f.close();}
});

test('未保存的多轮试聊使用模拟记忆且不写消息、记忆或人格',async()=>{
 const f=fixture(async(n)=>({text:n===1?'{}':'{"action":"reply","text":"收到","reason":"试聊"}',input:10,output:10,cache:0}));try{
  const p=legacyPersona('未保存人格');const result=await f.service.preview({persona:p,channel:'private',messages:[{role:'user',text:'第一轮'},{role:'assistant',text:'你好'},{role:'user',text:'第二轮'}]});
  // 该人格无规则，因此只有最终生成；其格式失败也不能写入真实状态。
  assert.equal(f.requests,1);assert.equal(result.draft,null);assert.ok(result.error);assert.ok(f.invocations[0].system.includes('未保存人格'));assert.ok(f.invocations[0].user.includes('第一轮'));assert.ok(f.invocations[0].user.includes('simulated'));
  assert.equal(Number((f.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n),0);assert.equal(Number((f.store.db.prepare('SELECT COUNT(*) AS n FROM memory').get() as any).n),0);assert.equal(readPanelSettings().persona,undefined);
 }finally{f.close();}
});

test('试聊汇总路由与生成费用，思考不重复累计，格式失败仍保留调用',async()=>{
 const f=fixture(async n=>({text:n===1?'的确不是JSON':'{"action":"reply","text":"收到","reason":"回应"}',input:20,output:10,cache:4,cost:{input:.00001,output:.00002,cacheRead:0,cacheWrite:0,total:.00003},pricingStatus:'priced'}));try{
  const result=await f.service.preview({persona:rules(),channel:'public',messages:[{role:'user',text:'你好'}]});
  assert.equal(result.draft?.text,'收到');assert.equal(f.requests,2);assert.equal(result.fees.requests,2);assert.equal(result.fees.estimatedUsd,.00006);assert.equal(result.calls[0].purpose,'semantic-trigger');assert.ok(result.warning);
 }finally{f.close();}
});

test('失败已落账的部分用量仍在试聊费用中，流水没有提示词正文',async()=>{
 const f=fixture(async(n,system,user,c,meta)=>{
  const ledger=new LlmStore(f.store),id=ledger.start(c.model,meta);ledger.finish(id,'aborted',{usage:{input:12,output:3,cacheRead:0,cacheWrite:null,totalTokens:15},pricingStatus:'unpriced',stopReason:'aborted'});throw new Error('中止');
 });try{
  const result=await f.service.preview({persona:legacyPersona('角色'),channel:'private',messages:[{role:'user',text:'不应进入流水的私信'}]});
  assert.equal(result.draft,null);assert.equal(result.fees.requests,1);assert.equal(result.fees.unpriced,1);assert.equal(result.fees.estimatedUsd,null);assert.equal(result.calls[0].input,12);assert.ok(!JSON.stringify(new LlmStore(f.store).calls()).includes('不应进入流水的私信'));
 }finally{f.close();}
});

test('试聊约束输入角色及对话条数',async()=>{
 const f=fixture();try{
  await assert.rejects(f.service.preview({channel:'public',messages:[{role:'system',text:'越权'}]}),/角色/);
  await assert.rejects(f.service.preview({channel:'public',messages:[{role:'assistant',text:'没有新入站'}]}),/最后/);
  await assert.rejects(f.service.preview({channel:'public',messages:Array.from({length:31},()=>({role:'user',text:'x'}))}),/三十/);
 }finally{f.close();}
});

test('生产组装保留合法长消息及三次原文，不误用试聊额度',async()=>{
 const f=fixture();try{
  const message='长'.repeat(30000),recent=Array.from({length:3},()=>({message:'旧'.repeat(20000),reply:'已确认'}));
  const result=await f.service.assemble({persona:legacyPersona('角色'),message,channel:'private',accountId:'worker-a',memory:{recent}});
  const messageSegment=JSON.parse(result.segments.find(s=>s.kind==='message')!.content),memory=JSON.parse(result.segments.find(s=>s.kind==='memory')!.content);assert.equal(messageSegment.message.length,30000);assert.equal(memory.recent.length,3);assert.equal(memory.recent[0].message.length,20000);assert.equal(f.requests,0);
 }finally{f.close();}
});
