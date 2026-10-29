import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {Store} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import {PersonaService,type Persona} from '../src/persona.js';
import {LlmStore,type CallMetadata} from '../src/llm-store.js';
import {Outbox} from '../src/outbox.js';
import {ReplyTriage} from '../src/reply-triage.js';
import {ChatTestService} from '../src/chat-test.js';
import {registerChatTestRoutes} from '../src/chat-test-routes.js';
import type {Generator} from '../src/model.js';
import type {Config} from '../src/types.js';
import {exampleConfig} from './config-fixture.js';

const customPersona:Persona={sections:[{id:'role',title:'角色',content:'只回应当前资料，明确自己是AI。'}],triggers:[{id:'semantic',title:'项目',condition:'谈到项目',content:'关心进度。',enabled:true,order:0,match:'semantic'}]};
function snapshot(store:Store){
 const tables=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'llm_calls' ORDER BY name").all() as {name:string}[]);
 return Object.fromEntries(tables.map(({name})=>[name,store.db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
}
function ledgerFiles(root:string){return Object.fromEntries(['forget-ledger.json','forget-history.json','forgotten-sources.json','memory-mutations.json'].map(name=>[name,existsSync(join(root,name))?readFileSync(join(root,name),'utf8'):null]));}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'chat-isolation-')),old=process.env.DATA_DIR;process.env.DATA_DIR=root;
 const store=new Store(join(root,'workflow.sqlite')),ledger=new LlmStore(store),calls:{system:string;user:string;meta:CallMetadata;session?:string}[]=[];
 const config:Config=structuredClone(exampleConfig) as Config;
 config.mode='draft';config.publicPerHour=1;config.privatePerHour=1;config.publicPerDay=1;config.privatePerDay=1;config.replyHours={enabled:true,closeDelayMinutes:30};
 let reply='先按你的节奏把项目收尾。',dailyReads=0;
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(c,system,user,_signal,session,meta={}){
  calls.push({system,user,meta,session});const callId=ledger.start(c.model,meta);
  let text:string;if(meta.source==='chat-test:semantic-trigger')text=JSON.stringify({matches:[{id:'semantic',reason:'提到了项目'}]});
  else if(meta.source==='chat-test:memory-summary'){const incoming=JSON.parse(user).incoming;text=JSON.stringify({items:[{type:'fact',text:'测试用户项目下周上线',sourceIds:[incoming[0].id]}]});}
  else text=JSON.stringify({action:'reply',text:reply,reason:'回应'});
  const usage={input:5,output:3,cacheRead:0,cacheWrite:0,totalTokens:8},cost={input:0.001,output:0.001,cacheRead:0,cacheWrite:0,total:0.002};
  ledger.finish(callId,'completed',{usage,cost,pricingStatus:'priced'});return {text,input:5,output:3,cache:0,callId,usage,cost,pricingStatus:'priced'};
 }};
 new MemoryService(store,generator,()=>config);new Outbox(store);new ReplyTriage(store);
 const persona=new PersonaService(store,generator,()=>config);persona.save(customPersona,persona.get().revision);
 store.set('activeAccount','real_bot');store.set('control','manual');store.set('cooldown:public:real_bot',String(Date.now()+86400000));
 const seed=store.db.prepare('INSERT INTO outbox(id,account_id,channel,kind,source_id,target_id,text,status,created_at,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 for(const c of ['public','private'])seed.run('blocked-'+c,'real_bot',c,c==='public'?'reply':'dm','existing-'+c,'existing-target','既有待回查出站','unknown',Date.now(),Date.now(),Date.now());
 for(const name of ['forget-ledger.json','forget-history.json','forgotten-sources.json'])writeFileSync(join(root,name),'{}');writeFileSync(join(root,'memory-mutations.json'),'[]');
 const chat=new ChatTestService({dataDir:root,store,generator,persona,config:()=>config,daily:{describe:()=>{dailyReads++;return {state:{content:'只读生产日程，绝不生成'}} as any;}}});
 return {root,store,ledger,chat,calls,config,persona,dailyReads:()=>dailyReads,reply:(value:string)=>reply=value,async close(){await chat.close();store.db.close();rmSync(root,{recursive:true,force:true});if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;}};
}

test('回复、过滤、长稿、摘要、重置和删除只改变独立库与统一试聊调用流水',{timeout:10000},async()=>{
 const f=fixture();try{
  assert.equal(existsSync(join(f.root,'chat-test')),false,'构造不应打开试聊库');
  const before=snapshot(f.store),files=ledgerFiles(f.root),user=f.chat.createUser({name:'小林'}).user;
  for(let i=0;i<5;i++){const {turn}=await f.chat.addMessage(user.id,{channel:'public',text:'我的项目下周上线，今天处理第'+i+'个问题'});assert.equal(turn.status,'completed');assert.equal(turn.result.receipt.status,'confirmed');}
  assert.ok(f.calls.some(call=>call.meta.source==='chat-test:memory-summary'));
  const priorCalls=f.calls.length;const filtered=await f.chat.addMessage(user.id,{channel:'public',text:'领取空投 https://example.invalid'});
  assert.equal(filtered.turn.result.status,'filtered');assert.equal(f.calls.length,priorCalls,'广告不应调用模型');
  f.reply('长'.repeat(200));const tooLong=await f.chat.addMessage(user.id,{channel:'public',text:'项目新的提问，帮我看看进展吗？'});
  assert.equal(tooLong.turn.result.validation.allowed,false);assert.match(tooLong.turn.result.note,/正常流程不会发出/);
  f.reply('回到正常长度。');await f.chat.addMessage(user.id,{channel:'public',text:'继续项目话题，刚才那条还记得吗？'});
  const last=f.calls.filter(call=>call.meta.source==='chat-test:reply').at(-1)!;
  const recent=last.user.split('【与对方的近期往来】')[1]?.split('【当前对话】')[0]??'';assert.ok(!recent.includes('长'.repeat(20)),'未发出的超长草稿不应成为已说过的话');
  const memory=f.chat.memory(user.id);assert.equal(memory.public.items.length,1);assert.equal(memory.private.items.length,0);
  assert.ok(f.calls.every(call=>call.meta.purpose==='chat-test'&&call.meta.accountId==='real_bot'&&call.meta.interactionId));
  assert.ok(f.calls.every(call=>call.session?.startsWith('chat-test-'+user.id+'-')));
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(ledgerFiles(f.root),files);
  f.chat.reset(user.id);assert.equal(f.chat.memory(user.id).public.items.length,0);f.chat.reset(user.id,true);assert.equal(f.chat.users().items.length,0);
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(ledgerFiles(f.root),files);assert.ok(f.ledger.calls({purpose:'chat-test',limit:100}).items.length>0);
  assert.ok(existsSync(join(f.root,'chat-test','workflow.sqlite')));assert.ok(f.dailyReads()>0);
 }finally{await f.close();}
});

test('未确认账号的试聊仍可处理，账号层来源为空且不改变控制和限额',{timeout:10000},async()=>{
 const f=fixture();try{
  f.store.set('activeAccount','');const before=snapshot(f.store),user=f.chat.createUser({name:'无账号会话'}).user;
  assert.equal(f.chat.status().accountConfirmed,false);
  const result=await f.chat.addMessage(user.id,{channel:'private',text:'我的项目下周上线，可以聊聊吗？'});assert.equal(result.turn.status,'completed');
  assert.equal(f.dailyReads(),0);assert.ok(f.calls.every(call=>call.meta.accountId===''));
  const reply=f.calls.find(call=>call.meta.source==='chat-test:reply')!;assert.ok(reply.user.includes('暂无当日日程'));assert.deepEqual(snapshot(f.store),before);assert.equal(f.store.get('control'),'manual');
 }finally{await f.close();}
});

test('试聊库损坏只让试聊接口503，生产数据仍可读写',{timeout:10000},async()=>{
 const f=fixture(),app=Fastify();try{
  mkdirSync(join(f.root,'chat-test'));writeFileSync(join(f.root,'chat-test','workflow.sqlite'),'明确损坏的测试库');
  registerChatTestRoutes(app,{service:f.chat});
  const oversized=await app.inject({method:'POST',url:'/api/chat-test/users',payload:{name:'消息',padding:'x'.repeat(65536)}});assert.equal(oversized.statusCode,413,'请求体超过64KiB在读取试聊库前拒绝');
  const res=await app.inject({method:'GET',url:'/api/chat-test/users'});assert.equal(res.statusCode,503);assert.equal(f.store.get('control'),'manual');f.store.set('still-running','yes');assert.equal(f.store.get('still-running'),'yes');
 }finally{await app.close();await f.close();}
});
