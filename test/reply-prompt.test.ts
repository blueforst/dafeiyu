import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { PersonaService,legacyPersona,type Persona } from '../src/persona.js';
import { parseDraft,parseDraftStructure,type Generator } from '../src/model.js';
import { assembleReplyPrompt,beijingTime,REPLY_PROMPT_VERSION } from '../src/reply-prompt.js';
import { DEFAULT_PROMPT_HINTS,validatePromptHints,buildReplyHints,detectLanguage,replyOpening,expressionFlags,recentReplySamples,scopedReplies,type ReplySample } from '../src/reply-hints.js';
import { registerPromptHintsRoutes } from '../src/reply-hints-routes.js';
import { Program,registerProgramRoutes } from '../src/program.js';
import { Outbox } from '../src/outbox.js';
import { Workflow } from '../src/workflow.js';
import { LlmStore } from '../src/llm-store.js';
import { exampleConfig } from './config-fixture.js';
import type { Config,Event } from '../src/types.js';

const NOW=Date.parse('2026-10-28T15:30:00Z');
const disabled={lateEnabled:false,languageEnabled:false,openingEnabled:false,expressionEnabled:false,replyCheckEnabled:false};
function fixture(generator?:Generator){
 const dir=mkdtempSync(join(tmpdir(),'role-reply-prompt-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(join(dir,'workflow.sqlite')),requests:any[]=[];
 const config=structuredClone(exampleConfig) as Config;
 const service=new PersonaService(store,generator??{async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(c,system,user,signal,session,meta){requests.push({c,system,user,session,meta});return {text:meta?.purpose==='semantic-trigger'?'{"matches":[{"id":"rule","reason":"命中"}]}':'{"action":"reply","text":"收到","reason":"回应"}',input:2,output:3,cache:1};}},()=>config);
 return {store,service,requests,config,close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(dir,{recursive:true,force:true});}};
}

test('北京时间、星期与每个时段边界正确，时间只精确到分钟',()=>{
 assert.equal(beijingTime(NOW).text,'2026-10-28 周三 23:30（深夜，北京时间）');
 const cases:[[number,string],...Array<[number,string]>]=[[0,'深夜'],[5,'深夜'],[6,'早上'],[8,'早上'],[9,'上午'],[10,'上午'],[11,'中午'],[12,'中午'],[13,'下午'],[16,'下午'],[17,'傍晚'],[18,'傍晚'],[19,'晚上'],[22,'晚上'],[23,'深夜']];
 for(const [hour,slot] of cases)assert.equal(beijingTime(Date.UTC(2026,9,28,hour-8)).slot,slot);
});

test('提示词实际请求与分段一致，动态数据及命中规则不进入system',()=>{
 const input={message:'甲',channel:'public' as const,accountId:'a',staticText:'静态人格',triggered:'不给步骤',dailyState:{activity:'读书'},now:NOW,settings:disabled};
 const first=assembleReplyPrompt(input),second=assembleReplyPrompt({...input,message:'乙',triggered:'另一命中',now:NOW+60000});
 assert.equal(first.system,second.system);assert.ok(!first.system.includes('不给步骤'));assert.ok(!first.system.includes('读书'));assert.ok(!first.user.includes('不给步骤'));
 assert.equal(first.system,first.segments.filter(s=>s.role==='system').map(s=>s.content).filter(Boolean).join('\n\n'));
 assert.equal(first.user,first.segments.filter(s=>s.role==='user').map(s=>'【'+s.title+'】\n'+s.content).join('\n\n'));
 assert.deepEqual(first.segments.filter(s=>s.role==='user').map(s=>s.kind),['experiences','daily','memory','recent','conversation','reminders','message','now']);
 assert.equal(first.segments.find(s=>s.kind==='daily')!.content,second.segments.find(s=>s.kind==='daily')!.content);
 const tomorrow=assembleReplyPrompt({...input,now:NOW+86400000});assert.equal(first.system,tomorrow.system);assert.notEqual(first.segments.find(s=>s.kind==='daily')!.content,tomorrow.segments.find(s=>s.kind==='daily')!.content);
 const revised=assembleReplyPrompt({...input,staticText:'修改后的人格'});assert.notEqual(first.system,revised.system);assert.ok(revised.system.includes('修改后的人格'));
});

test('记忆召回中的角色经历移到首节，不混入对方事实或重复正文',()=>{
 const result=assembleReplyPrompt({accountId:'a',channel:'public',message:'你好',staticText:'角色',memory:{memories:[{text:'喜欢茶'}],recent:[],experiences:[{text:'有回执的互动',sourceMessageId:'source'}]}});
 assert.ok(result.segments.find(s=>s.kind==='experiences')!.content.includes('有回执的互动'));assert.ok(!result.segments.find(s=>s.kind==='memory')!.content.includes('有回执的互动'));assert.equal((result.user.match(/有回执的互动/gu)??[]).length,1);
});

test('迟到提醒只接受可靠平台时间，阈值边界、未来时间和禁用有效',()=>{
 const base={message:'你好',channel:'public' as const,accountId:'a',now:NOW,timestampReliable:true,settings:{...disabled,lateEnabled:true}};
 const late=(timestamp:number,reliable=true)=>buildReplyHints({...base,timestamp,timestampReliable:reliable}).hints.some(h=>h.kind==='late');
 assert.equal(late(NOW-60*60000+1),false);assert.equal(late(NOW-60*60000),true);assert.equal(late(NOW-12*3600000),true);
 assert.equal(late(NOW-12*3600000,false),false);assert.equal(late(NOW+60000),false);assert.equal(late(NaN),false);
 assert.equal(buildReplyHints({...base,timestamp:NOW-7200000,timestampReliable:undefined}).hints.length,0);
 assert.throws(()=>validatePromptHints({lateMinutes:29}),/30/);assert.throws(()=>validatePromptHints({lateMinutes:361}),/360/);
});

test('语言提醒区分繁体、日文、韩文、拉丁字母与无法确定的消息',()=>{
 const cases:Array<[string,string]>=[['這個問題讓我覺得很開心','traditional'],['今日はいい天気ですね','japanese'],['정말 감사합니다','korean'],['Could you help me today?','latin'],['觉得今天好多了','unknown'],['你好世界','unknown'],['😀 (´▽`) ～','unknown'],['你好 abc','unknown']];
 for(const [text,language] of cases)assert.equal(detectLanguage(text),language,text);
 const hint=buildReplyHints({message:cases[0][0],channel:'public',accountId:'a',settings:{...disabled,languageEnabled:true}}).hints[0];
 assert.ok(hint.text.includes('不混入簡體'));assert.equal(hint.kind,'language');
});

test('回放开头截断保留码点，旧开关不生成开头提醒且样本范围仍严格隔离',()=>{
 assert.equal(replyOpening('  你好呀，后续内容'),'你好呀');assert.equal(Array.from(replyOpening('😀😀😀😀😀😀😀😀😀')).length,8);
 const samples:ReplySample[]=[{text:'公开开头，正文',channel:'public',accountId:'a'},{text:'同会话呀，正文',channel:'private',conversationId:'one',accountId:'a'},{text:'别的私密，正文',channel:'private',conversationId:'two',accountId:'a'},{text:'其他账号，正文',channel:'public',accountId:'b'},{text:'公开开头！重复',channel:'public',accountId:'a'}];
 const input={message:'你好',channel:'public' as const,accountId:'a',recentReplies:samples,settings:{...disabled,openingEnabled:true}};
 assert.deepEqual(buildReplyHints(input).hints,[]);assert.deepEqual(buildReplyHints({...input,channel:'private',conversationId:'one'}).hints,[]);
 assert.deepEqual(scopedReplies(samples,'a','public').map(s=>s.text),['公开开头，正文','公开开头！重复']);assert.deepEqual(scopedReplies(samples,'a','private','one').map(s=>s.text),['公开开头，正文','同会话呀，正文','公开开头！重复']);
});

test('颜文字、emoji和波浪号统计独立，连续颜文字与各上限生效',()=>{
 assert.deepEqual(expressionFlags('(´▽`) 😀 ～'),{kaomoji:true,emoji:true,tilde:true});assert.equal(expressionFlags('你好~').tilde,true);assert.equal(expressionFlags('zoo').kaomoji,false);assert.equal(expressionFlags('^_^').kaomoji,true);
 const input={message:'你好',channel:'public' as const,accountId:'a',recentReplies:[{text:'(´▽`) 😀～',channel:'public' as const},{text:'前一条😀',channel:'public' as const}],settings:{...disabled,expressionEnabled:true}};
 const hint=buildReplyHints(input).hints[0];assert.ok(hint.text.includes('本条不要使用颜文字、emoji、“～”'));
 const noPublicBleed=buildReplyHints({...input,channel:'private',conversationId:'one'}).hints[0];assert.ok(!noPublicBleed.text.includes('本条不要使用'));
});

test('提醒默认值、范围和所有关闭状态不触发额外调用',()=>{
 assert.deepEqual(validatePromptHints({}),DEFAULT_PROMPT_HINTS);assert.throws(()=>validatePromptHints({openingCount:13}),/12/);assert.throws(()=>validatePromptHints({emojiPer10:11}),/10/);assert.throws(()=>validatePromptHints({lateEnabled:1}),/开关/);assert.throws(()=>validatePromptHints({evil:true}),/字段/);
 assert.deepEqual(buildReplyHints({message:'Hello there!',channel:'public',accountId:'a',now:NOW,timestamp:1,timestampReliable:true,settings:disabled}).hints,[]);
});

test('生产最近回复查询按账号和会话限制，片段不写入日志',()=>{
 const f=fixture();try{
  const add=(id:string,accountId:string,channel:'public'|'private',conversationId:string,text:string)=>{const event:Event={id,platformId:id,channel,userId:'visitor',handle:'visitor',text:'入站',url:'',conversationId,timestamp:NOW,timestampReliable:true};f.store.ingest(event,accountId);f.store.update(id,'draft',{draft:{action:'reply',text,reason:'测试'}},accountId);};
  add('one','a','public','public','公开样本');add('two','a','private','one','当前私信');add('three','a','private','two','不能出现的私信');add('four','b','public','public','其他账号');
  assert.deepEqual(recentReplySamples(f.store,'a','public').map(s=>s.text),['公开样本']);
  const privateSamples=recentReplySamples(f.store,'a','private','one');assert.equal(privateSamples.length,2);assert.ok(!privateSamples.some(s=>s.text==='不能出现的私信'));
  buildReplyHints({message:'你好',accountId:'a',channel:'private',conversationId:'one',recentReplies:privateSamples});assert.equal(f.store.logs().length,0);
 }finally{f.close();}
});

test('语义判定与提示词层共用一次路由，试聊样本来自模拟对话且不会读取生产回复',async()=>{
 const f=fixture();try{
  const persona:Persona=legacyPersona('角色');persona.triggers=[{id:'rule',title:'不给步骤',condition:'问做法',content:'不要提供步骤',enabled:true,order:0}];
  const result=await f.service.preview({persona,channel:'public',messages:[{role:'assistant',text:'模拟开头，原回复'},{role:'user',text:'How are you doing today?'}]});
  assert.equal(f.requests.length,1);assert.equal(result.meta.promptVersion,REPLY_PROMPT_VERSION);assert.equal(result.meta.sampleSource,'preview-dialogue');assert.ok(result.hints.some(h=>h.kind==='language'));assert.ok(!result.hints.some(h=>String(h.kind)==='opening'));assert.ok(!result.segments.find(s=>s.kind==='reminders')!.content.includes('模拟开头'));assert.ok(result.segments.find(s=>s.kind==='conversation')!.content.includes('模拟开头'));assert.ok(!f.requests[0].system.includes('不要提供步骤'));assert.ok(!f.requests[0].user.includes('不要提供步骤'));assert.deepEqual(result.hits,[]);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM messages').get() as any).n,0);assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM memory').get() as any).n,0);
 }finally{f.close();}
});

test('回放可把语义请求归为persona-replay，模型会话路由与默认token不变',async()=>{
 const f=fixture();try{
  const p=legacyPersona('角色');p.triggers=[{id:'rule',title:'规则',condition:'条件',content:'命中规则',enabled:true,order:0}];
  const result=await f.service.assemble({persona:p,message:'你好',channel:'public',accountId:'a',now:NOW,sessionId:'replay-run-saved',routingPurpose:'persona-replay',routingSource:'panel-replay'});
  assert.equal(f.requests.length,0);assert.equal(result.calls.length,0);assert.ok(result.system.includes('rule｜规则：条件'));assert.ok(!result.user.includes('命中规则'));
 }finally{f.close();}
});

test('提醒设置在await之前冻结，生成中修改不影响本次请求',async()=>{
 let finish!:(result:any)=>void;const f=fixture({async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(){return new Promise(resolve=>{finish=resolve;});}});try{
  const p=legacyPersona('角色');p.triggers=[{id:'rule',title:'规则',condition:'条件',content:'规则正文',enabled:true,order:0}];
  const settings={...DEFAULT_PROMPT_HINTS},pending=f.service.assemble({persona:p,message:'Hello my friend!',channel:'public',accountId:'a',now:NOW,promptHints:settings});
  await Promise.resolve();await Promise.resolve();settings.languageEnabled=false;const result=await pending;assert.ok(result.hints.some(h=>h.kind==='language'));
 }finally{f.close();}
});

test('提醒API校验修订与范围，保存保持暂停且不会覆盖人格',async()=>{
 const f=fixture(),app=Fastify();registerPromptHintsRoutes(app,{store:f.store});try{
  f.store.set('control','paused');const first=(await app.inject('/api/persona/prompt-hints')).json();assert.equal(first.revision,0);
  const saved=await app.inject({method:'PUT',url:'/api/persona/prompt-hints',payload:{revision:0,promptHints:{...DEFAULT_PROMPT_HINTS,lateMinutes:90}}});assert.equal(saved.statusCode,200);assert.equal(saved.json().revision,1);
  assert.equal((await app.inject({method:'PUT',url:'/api/persona/prompt-hints',payload:{revision:0,promptHints:DEFAULT_PROMPT_HINTS}})).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:'/api/persona/prompt-hints',payload:{revision:1,promptHints:{lateMinutes:1}}})).statusCode,400);assert.equal(f.store.get('control'),'paused');
 }finally{await app.close();f.close();}
});

test('结构解析独立于公开计数，NFC在冻结前应用，私信4000门槛保留',()=>{
 const raw=(text:string)=>JSON.stringify({action:'reply',text,reason:'理由'});
 assert.equal(parseDraftStructure(raw('字'.repeat(5000))).text.length,5000);assert.equal(parseDraft(raw('字'.repeat(5000)),{channel:'public'}).text.length,5000);assert.throws(()=>parseDraft(raw('字'.repeat(5000)),{channel:'private'}),/4,000/);
 assert.equal(parseDraft(raw('e\u0301'),{channel:'public'}).text,'é');assert.throws(()=>parseDraftStructure(raw('https://example.test')),/禁用/);
});

test('跳过类别白名单兼容缺失或错误值，不丢失骚扰调度标签',()=>{
 const raw=(category:unknown)=>JSON.stringify({action:'skip',text:'',reason:'无需回复',category});
 for(const category of ['harassment','spam','no_reply','other'])assert.equal(parseDraft(raw(category)).category,category);
 for(const category of [undefined,'invalid',{nested:'harassment'},12,null])assert.equal(parseDraft(raw(category)).category,'other');
 const prompt=assembleReplyPrompt({accountId:'a',channel:'public',staticText:'角色',message:'你好'});assert.ok(prompt.system.includes('harassment'));assert.ok(prompt.system.includes('不是用户事实'));
});

test('正常生产草稿保存提醒meta并关联原调用cacheRead，旧草稿详情兼容且日志无片段',async()=>{
 const f=fixture(),app=Fastify(),ledger=new LlmStore(f.store),now=Date.now();let calls=0;
 const event:Event={id:'prompt-production',platformId:'1234567',channel:'public',userId:'visitor',handle:'visitor',text:'Hello my friend, how is your day?',url:'https://x.com/visitor/status/1234567',conversationId:'1234567',timestamp:now-7200000,timestampReliable:true};
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(c,system,user,signal,session,meta){calls++;const callId=ledger.start(c.model,meta);ledger.finish(callId,'completed',{usage:{input:8,output:3,cacheRead:4,cacheWrite:0,totalTokens:15},pricingStatus:'unpriced'});return {text:'{"action":"reply","text":"收到，祝你今天顺利。","reason":"回应"}',input:8,output:3,cache:4,callId};}};
 const workflow=new Workflow(f.store,{identity:async()=>({handle:'prompt_bot',loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>({events:[event],warnings:[]}),context:async()=>'',send:async()=>{throw new Error('草稿模式禁止发送');},lookup:async()=>({status:'unknown'})},generator,()=>f.config);
 const program=new Program(f.store),outbox=new Outbox(f.store),persona=new PersonaService(f.store,generator,()=>f.config);workflow.services={program,outbox,persona};registerProgramRoutes(app,{store:f.store,program,workflow});
 try{
  await workflow.resume();await workflow.tick();const row=f.store.getMessage(event.id,'prompt_bot')!;assert.equal(row.status,'draft');assert.equal(calls,1);
  const response=await app.inject('/api/messages/'+encodeURIComponent(row.id));assert.equal(response.statusCode,200,response.body);const detail=response.json(),meta=detail.message.draft.meta;
  assert.equal(meta.promptVersion,REPLY_PROMPT_VERSION);assert.ok(meta.hintKinds.includes('late'));assert.ok(meta.hintKinds.includes('language'));assert.equal(detail.calls.find((call:any)=>call.id===meta.callId).usage.cacheRead,4);assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM llm_calls').get() as any).n,1);
  const old={...event,id:'old-draft',platformId:'2345678',url:'https://x.com/visitor/status/2345678'};f.store.ingest(old,'prompt_bot');f.store.update(old.id,'draft',{draft:{action:'reply',text:'旧版草稿',reason:''}},'prompt_bot');const oldRow=f.store.getMessage(old.id,'prompt_bot')!;
  const oldResponse=await app.inject('/api/messages/'+encodeURIComponent(oldRow.id));assert.equal(oldResponse.statusCode,200);assert.equal(oldResponse.json().message.draft.meta,undefined);
  const logs=JSON.stringify(f.store.logs());assert.ok(!logs.includes(event.text));assert.ok(!logs.includes('祝你今天顺利'));assert.equal(workflow.control(),'running');
 }finally{workflow.stop();await app.close();f.close();}
});
