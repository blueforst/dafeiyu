import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {PersonaService,legacyPersona,validatePersona,normalizeTriggerText,matchedKeyword,type Persona,type PersonaTrigger} from '../src/persona.js';
import {LlmStore} from '../src/llm-store.js';
import {exampleConfig} from './config-fixture.js';
import type {Config} from '../src/types.js';
import type {Generator,GenerationResult} from '../src/model.js';

const keyword=(patch:Partial<PersonaTrigger>={}):PersonaTrigger=>({id:'keyword',title:'不给步骤',condition:'消息包含关键词',content:'仅谈感受，不提供步骤。',enabled:true,order:0,match:'keywords',keywords:['怎么做','教程','步骤'],...patch});
function persona(...triggers:PersonaTrigger[]):Persona{return {...legacyPersona('虚构测试角色'),triggers};}
function fixture(routerResult:unknown={matches:[]},routerError=false){
 const directory=mkdtempSync(join(tmpdir(),'role-keyword-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=directory;
 const store=new Store(directory+'/workflow.sqlite'),ledger=new LlmStore(store),requests:any[]=[],config=structuredClone(exampleConfig) as Config;
 const generator:Generator={async complete(c,system,user,signal,session,metadata){
  requests.push({c,system,user,session,metadata});const id=ledger.start(c.model,metadata);
  ledger.finish(id,routerError?'failed':'completed',{usage:{input:3,output:4,cacheRead:0,cacheWrite:0,totalTokens:7},pricingStatus:'unpriced'});
  if(routerError)throw new Error('路由故障');
  return {text:metadata?.purpose==='semantic-trigger'?JSON.stringify(routerResult):'{"action":"reply","text":"收到。","reason":"回应"}',input:3,output:4,cache:0,callId:id};
 }};
 const service=new PersonaService(store,generator,()=>config);
 return {store,ledger,requests,service,config,generator,close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(directory,{recursive:true,force:true});}};
}

test('旧卡片缺省语义且JSON形状保持，关键词按NFKC规整保存并保留显式方式',()=>{
 const old=persona({id:'old',title:'语义',condition:'阅读',content:'原文',enabled:true,order:0});assert.deepEqual(validatePersona(old),old);
 const normalized=validatePersona(persona(keyword({keywords:['  ＨＯＷ  ','　教程　']}))).triggers[0];assert.deepEqual(normalized.keywords,['HOW','教程']);assert.equal(normalized.match,'keywords');
 const semantic=validatePersona(persona(keyword({match:'semantic',keywords:[' HOW ']}))).triggers[0];assert.equal(semantic.match,'semantic');assert.deepEqual(semantic.keywords,['HOW']);
});

test('关键词数量、规整后长度、类型与condition边界均拒绝，keyword总长计入人格',()=>{
 for(const words of [[],Array.from({length:31},()=> '字'),[' '],['a'.repeat(41)],['ﬃ'.repeat(14)],[12]])assert.throws(()=>validatePersona(persona(keyword({keywords:words as string[]}))),/关键词/);
 assert.throws(()=>validatePersona(persona(keyword({condition:' '}))),/触发条件/);
 assert.throws(()=>validatePersona(persona(keyword({match:'bad' as any}))),/触发方式/);
 const trigger=keyword({condition:'条件',content:'规则',keywords:['关键词']}),used=trigger.condition.length+trigger.content.length+trigger.keywords![0].length;
 const exact={sections:[{id:'role',title:'角色',content:'字'.repeat(20000-used)}],triggers:[trigger]};assert.equal(validatePersona(exact).sections[0].content.length,20000-used);
 assert.throws(()=>validatePersona({...exact,sections:[{...exact.sections[0],content:exact.sections[0].content+'字'}]}),/20,000/);
});

test('匹配忽略大小写、全半角与被提及账号名，保留正文子串而不跨消息',()=>{
 assert.equal(normalizeTriggerText(' @ＨＯＷ　ＳＴＥＰＳ '),'steps');
 assert.equal(matchedKeyword(keyword({keywords:['How']}),'ＨＯＷ can I do this?'),'How');
 assert.equal(matchedKeyword(keyword({keywords:['steps']}),'@ＳＴＥＰＳ 你好'),undefined);
 assert.equal(matchedKeyword(keyword({keywords:['@onlymention']}),'任意正文'),undefined);
 assert.equal(matchedKeyword(keyword(),'番茄炒蛋怎么做'),'怎么做');
});

test('只启用关键词卡片时组装零路由，试聊只有一次回复生成且费用保留',async()=>{
 const f=fixture();try{
  const p=persona(keyword());const assembled=await f.service.assemble({persona:p,accountId:'a',channel:'public',message:'番茄炒蛋怎么做'});
  assert.equal(f.requests.length,0);assert.equal(f.ledger.calls().items.length,0);assert.deepEqual(assembled.hits,[{id:'keyword',title:'不给步骤',reason:'关键词：怎么做'}]);assert.deepEqual(assembled.meta.triggerHits,assembled.hits);assert.ok(!JSON.stringify(assembled.meta).includes('仅谈感受'));assert.ok(assembled.user.includes('仅谈感受'));assert.ok(!assembled.system.includes('仅谈感受'));
  const preview=await f.service.preview({persona:p,channel:'public',messages:[{role:'user',text:'给个教程'}]});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].metadata.purpose,'persona-preview');assert.equal(preview.calls.length,1);assert.equal(preview.fees.requests,1);assert.equal(preview.hits[0].reason,'关键词：教程');assert.equal(f.ledger.calls({purpose:'semantic-trigger'}).items.length,0);
 }finally{f.close();}
});

test('关键词不读取对话、引用、卡片，也不触发已关闭规则',async()=>{
 const f=fixture();try{
  const assembled=await f.service.assemble({persona:persona(keyword(),keyword({id:'off',enabled:false,keywords:['你好']})),accountId:'a',channel:'public',message:'你好',conversation:[{text:'怎么做'}],quote:{handle:'quoted',platformId:'123',text:'教程步骤',media:false},card:{domain:'example.test',title:'怎么做教程'}});
  assert.deepEqual(assembled.hits,[]);assert.equal(f.requests.length,0);assert.ok(assembled.user.includes('教程步骤'));
 }finally{f.close();}
});

test('关键词和语义合并顺序稳定，路由只含语义条件且不能伪造关键词命中',async()=>{
 const f=fixture({matches:[{id:'semantic',reason:'阅读语义'},{id:'keyword',reason:'伪造原因'},{id:'unknown',reason:'无效'}]});try{
  const p=persona(keyword({order:2}),{id:'semantic',title:'阅读',condition:'谈阅读',content:'语义规则正文',enabled:true,order:1});
  const result=await f.service.assemble({persona:p,accountId:'a',channel:'public',message:'教程'});
  assert.equal(f.requests.length,1);const routing=JSON.parse(f.requests[0].user);assert.deepEqual(routing.rules,[{id:'semantic',condition:'谈阅读'}]);assert.ok(!f.requests[0].user.includes('语义规则正文'));
  assert.deepEqual(result.hits.map(h=>h.id),['semantic','keyword']);assert.equal(result.hits[1].reason,'关键词：教程');assert.ok(result.user.indexOf('语义规则正文')<result.user.indexOf('仅谈感受'));
 }finally{f.close();}
});

test('语义请求失败或格式无效时保留关键词命中，静态与关键词不重复路由',async()=>{
 for(const fail of [false,true]){
  const f=fixture({invalid:true},fail);try{
   const p=persona(keyword(),{id:'semantic',title:'阅读',condition:'谈阅读',content:'不可注入的语义正文',enabled:true,order:1});
   const result=await f.service.assemble({persona:p,accountId:'a',channel:'public',message:'教程'});
   assert.equal(f.requests.length,1);assert.equal(f.ledger.calls().items.length,1);assert.deepEqual(result.hits.map(h=>h.id),['keyword']);assert.ok(result.warning?.includes('关键词'));assert.ok(result.user.includes('仅谈感受'));assert.ok(!result.user.includes('不可注入的语义正文'));assert.ok(!JSON.stringify(f.store.logs()).includes('教程'));
  }finally{f.close();}
 }
});

test('回放可注入冻结generator与shared侧计量，正常PersonaService生成器不被调用',async()=>{
 const f=fixture();let overrides=0,metadata:any,session:string|undefined;const override:Generator={async complete(c,system,user,signal,id,meta):Promise<GenerationResult>{overrides++;metadata=meta;session=id;assert.equal(c.model.maxTokens,512);return {text:'{"matches":[{"id":"semantic","reason":"共享"}]}',input:1,output:1,cache:0};}};
 try{
  const p=persona({id:'semantic',title:'语义',condition:'条件',content:'共享语义正文',enabled:true,order:0});const result=await f.service.assemble({persona:p,accountId:'a',channel:'public',message:'你好',generator:override,routingPurpose:'persona-replay',routingSource:'panel-replay',routingSide:'shared',sessionId:'replay-shared-session'});
  assert.equal(overrides,1);assert.equal(f.requests.length,0);assert.equal(metadata.side,'shared');assert.equal(metadata.purpose,'persona-replay');assert.equal(session,'replay-shared-session');assert.equal(result.hits[0].reason,'共享');
 }finally{f.close();}
});
