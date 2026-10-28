import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import {PersonaService,legacyPersona} from '../src/persona.js';
import {assembleReplyPrompt,REPLY_PROMPT_VERSION,FIXED_SYSTEM_RULES} from '../src/reply-prompt.js';
import {buildReplyHints,validatePromptHints,recentReplySamples} from '../src/reply-hints.js';
import {exampleConfig} from './config-fixture.js';
import type {Config,Event} from '../src/types.js';

const base={staticText:'固定测试角色',message:'现在聊另一件事',channel:'public' as const,accountId:'worker'};
const segment=(result:ReturnType<typeof assembleReplyPrompt>,kind:string)=>result.segments.find(s=>s.kind===kind)!;
test('v4只把近期往来放进独立user段，保留删除约束与稳定system',()=>{
 const memory={memories:[{text:'喜欢茶'}],recent:[{message:'昨天好吗',reply:'我用过的口癖'}],experiences:[{text:'已确认的角色发帖'}],recallOmitted:2},before=JSON.stringify(memory),now=Date.now();
 const result=assembleReplyPrompt({...base,memory,now});assert.equal(REPLY_PROMPT_VERSION,'reply-context-v4');assert.ok(FIXED_SYSTEM_RULES.includes('记录由运营者管理'));
 assert.deepEqual(result.segments.filter(s=>s.role==='user').map(s=>s.kind),['experiences','daily','memory','recent','conversation','reminders','message','now']);
 assert.deepEqual(JSON.parse(segment(result,'memory').content),{memories:memory.memories,recallOmitted:2});const recent=JSON.parse(segment(result,'recent').content);assert.deepEqual(recent.items,memory.recent);assert.match(recent.note,/reply 是你已经发出的原话/);assert.match(recent.note,/梗、口癖、开头、收尾和说法/);
 assert.equal((result.user.match(/我用过的口癖/g)??[]).length,1);assert.ok(!result.system.includes('我用过的口癖'));assert.equal(result.system,assembleReplyPrompt({...base,memory:{...memory,recent:[]},now:now+1000}).system);assert.equal(JSON.stringify(memory),before);
});
test('缺失、空或旧快照近期往来可重新组装，无数据保留暂无分段',()=>{
 for(const memory of [undefined,[],{recent:[]},{memories:[]},{recent:'无法识别的旧值'}]){const result=assembleReplyPrompt({...base,memory});assert.equal(JSON.parse(segment(result,'recent').content).items,'暂无');if(memory&&typeof memory==='object'&&!Array.isArray(memory))assert.equal(Object.hasOwn(JSON.parse(segment(result,'memory').content),'recent'),false);}
 const oldSnapshot=JSON.parse(JSON.stringify({memory:{memories:[{text:'旧事实'}],recent:[{message:'旧快照入站',reply:'旧确认发言'}]},conversation:[]}));const result=assembleReplyPrompt({...base,...oldSnapshot});assert.equal(JSON.parse(segment(result,'recent').content).items[0].reply,'旧确认发言');assert.ok(!segment(result,'memory').content.includes('旧确认发言'));
});
test('旧开头设置仍校验保存结构，但不再向模型提供其他人的开头，表情提醒不变',()=>{
 const recentReplies=[{accountId:'worker',channel:'public' as const,text:'其他人私事独有开头，😀～(´▽`)'}],settings=validatePromptHints({openingEnabled:true,openingCount:12});assert.equal(settings.openingEnabled,true);assert.equal(settings.openingCount,12);
 const enabled=buildReplyHints({...base,recentReplies,settings}),disabled=buildReplyHints({...base,recentReplies,settings:{...settings,openingEnabled:false,openingCount:1}});assert.deepEqual(enabled,disabled);assert.ok(!JSON.stringify(enabled).includes('其他人私事独有开头'));assert.ok(!enabled.hints.some(h=>String(h.kind)==='opening'));assert.match(enabled.hints.find(h=>h.kind==='expression')!.text,/不要使用颜文字/);
});
test('只有早晚安标识才加入帖子去重，不因旧设置开关或普通回复误加',()=>{
 const normal=buildReplyHints(base),post=buildReplyHints({...base,postVariety:true});assert.ok(!normal.hints.some(h=>h.kind==='post-variety'));const hint=post.hints.find(h=>h.kind==='post-variety')!;assert.match(hint.text,/不要重复它们的开头、句式和切入点/);assert.match(hint.text,/不要把以前帖子里的事当成今天又发生一次/);assert.equal(post.hints.length,normal.hints.length+1);
});
test('真实记忆召回按人和渠道隔离，草稿不带已发回复，遗忘后近期为空且日志无原文',async()=>{
 const path=mkdtempSync(tmpdir()+'/style-prompt-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=path;const store=new Store(path+'/db.sqlite'),config=structuredClone(exampleConfig) as Config;let calls=0;const generator={complete:async()=>{calls++;return {text:'{"action":"reply","text":"收到","reason":""}',input:1,output:1,cache:0};}};const memory=new MemoryService(store,generator,()=>config),persona=new PersonaService(store,generator,()=>config),now=Date.now();
 try{
  const add=(id:string,userId:string,channel:'public'|'private',text:string,reply:string,status='confirmed')=>{const e:Event={id:'x:'+id,platformId:id,targetId:id,channel,userId,handle:userId,url:channel==='public'?'https://x.com/'+userId+'/status/'+id:'https://x.com/messages/1-2',conversationId:channel==='public'?id:'1-2',text,timestamp:now-1000,timestampReliable:true};assert.equal(store.ingest(e,'worker'),true);store.update(store.getMessage(e.id,'worker')!.id,status,{draft:{action:'reply',text:reply,reason:''}},'worker');};
  add('90101','alice','public','甲的入站独有','甲的已发原话独有');add('90102','bob','public','乙的公开入站独有','乙的已发原话独有');add('90103','bob','private','乙的私信入站独有','乙的私信回复独有');add('90104','bob','public','乙的草稿入站独有','乙的未发草稿独有','draft');
  for(const channel of ['public','private'] as const){const result=await persona.assemble({message:'现在聊另一件事',channel,accountId:'worker',persona:legacyPersona('测试角色'),memory:memory.context('bob',channel,'worker'),recentReplies:recentReplySamples(store,'worker',channel,'1-2')});assert.ok(!result.user.includes('甲的'));assert.ok(!result.user.includes('乙的未发草稿独有'));assert.ok(result.user.includes('乙的草稿入站独有'));if(channel==='public')assert.ok(!result.user.includes('乙的私信'));else assert.ok(result.user.includes('乙的私信回复独有'));}
  store.forget('bob','worker');const result=assembleReplyPrompt({...base,memory:memory.context('bob','public','worker')});assert.equal(JSON.parse(segment(result,'recent').content).items,'暂无');assert.equal(calls,0);assert.ok(!JSON.stringify(store.logs()).includes('独有'));
 }finally{store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(path,{recursive:true,force:true});}
});
