import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';
import { BrowserPostingCapabilities,PostingCapabilitiesService } from '../src/posting-capabilities.js';
import { CAPABILITY_TTL_MS,validatePostingText } from '../src/posting-policy.js';
import { PersonaService,legacyPersona } from '../src/persona.js';
import { LlmStore } from '../src/llm-store.js';
import { exampleConfig } from './config-fixture.js';
import type { Config,Identity } from '../src/types.js';
import type { Generator } from '../src/model.js';
const NOW=Date.parse('2026-10-28T10:00:00+08:00');
const logged:Identity={handle:'worker',userId:'own-id',loggedIn:true,needsHuman:false};
function fixture(){const dir=mkdtempSync(tmpdir()+'/posting-preview-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;const store=new Store(dir+'/workflow.sqlite');new Outbox(store);return {store,close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(dir,{recursive:true,force:true});}};}

test('十五分钟到期及人工释放后生成新unknown证据，保留新检查时间与独立操作修订',()=>{
 const f=fixture();let now=NOW;try{const browser=new BrowserPostingCapabilities(),service=new PostingCapabilitiesService(f.store,()=> 'worker',()=>now);
  const original=browser.observe(logged,now);assert.notEqual(original.post.revision,original.reply.revision);assert.equal(original.post.operation,'post');assert.equal(original.reply.operation,'reply');assert.equal(original.post.checkedAt,now);assert.equal(original.post.expiresAt,now+CAPABILITY_TTL_MS);assert.equal(service.accept(original).post.status,'unknown');
  now+=CAPABILITY_TTL_MS-1;assert.equal(service.get().post.status,'unknown');assert.equal(browser.observe(logged,now).post.revision,original.post.revision);
  now++;assert.equal(service.get().post.status,'stale');const refreshed=browser.observe(logged,now);assert.equal(refreshed.post.status,'unknown');assert.equal(refreshed.post.checkedAt,now);assert.equal(refreshed.post.expiresAt,now+CAPABILITY_TTL_MS);assert.notEqual(refreshed.post.revision,original.post.revision);assert.equal(service.accept(refreshed).post.status,'unknown');
  now++;browser.invalidate('人工释放');service.invalidate('人工释放');assert.equal(service.get().post.status,'stale');const released=browser.observe(logged,now);assert.equal(released.post.checkedAt,now);assert.notEqual(released.post.revision,refreshed.post.revision);assert.equal(service.accept(released).post.status,'unknown');assert.equal(service.get().effective.post.limit,280);
 }finally{f.close();}
});
test('浏览器与应用重启、同handle身份ID变化均不能继承先前证据',()=>{
 const f=fixture();let now=NOW;try{const browser=new BrowserPostingCapabilities(),service=new PostingCapabilitiesService(f.store,()=> 'worker',()=>now),original=browser.observe(logged,now);service.accept(original);
  assert.equal(new PostingCapabilitiesService(f.store,()=> 'worker',()=>now).get().post.status,'stale');now++;
  const restarted=new BrowserPostingCapabilities().observe(logged,now);assert.notEqual(restarted.sessionId,original.sessionId);service.accept(restarted);assert.equal(service.get().sessionId,restarted.sessionId);assert.equal(service.get().effective.reply.limit,280);
  const before=browser.observe(logged,now);now++;const changed=browser.observe({...logged,userId:'different-own-id'},now);assert.notEqual(changed.reply.revision,before.reply.revision);assert.equal(changed.reply.userId,'different-own-id');assert.equal(changed.reply.checkedAt,now);assert.equal(changed.reply.status,'unknown');
 }finally{f.close();}
});
test('切号、退出、需人工验证和账号受限清空绑定，旧账号缓存不可移交',()=>{
 const f=fixture();let account='worker',now=NOW;try{const browser=new BrowserPostingCapabilities(),service=new PostingCapabilitiesService(f.store,()=>account,()=>now),original=browser.observe(logged,now);service.accept(original);
  account='other';now++;const changed=browser.observe({...logged,handle:'other',userId:'other-id'},now);assert.equal(changed.accountId,'other');assert.notEqual(changed.reply.revision,original.reply.revision);assert.equal(service.get().reply.accountId,'other');assert.equal(service.get().reply.status,'unknown');service.accept(changed);assert.throws(()=>service.accept(original),/账号不符/);assert.equal(service.get().reply.status,'stale');
  for(const identity of [{...logged,loggedIn:false},{...logged,needsHuman:true},{...logged,restricted:'locked' as const}]){account='';now++;const absent=browser.observe(identity,now);assert.equal(absent.accountId,'');assert.equal(absent.post.status,'unknown');assert.equal(service.get().simulation,true);assert.equal(service.get().effective.reply.limit,280);assert.throws(()=>service.accept(absent),/账号不符/);}
  account='worker';now++;const returned=browser.observe(logged,now);assert.notEqual(returned.reply.revision,original.reply.revision);assert.equal(service.get().reply.status,'stale');assert.equal(service.accept(returned).reply.status,'unknown');
 }finally{f.close();}
});
test('账号、操作、会话、时效与同修订证据冲突均拒绝并使旧缓存失效',()=>{
 const f=fixture();try{const browser=new BrowserPostingCapabilities(),service=new PostingCapabilitiesService(f.store,()=> 'worker',()=>NOW),original=browser.observe(logged,NOW);
  const mutations=[(x:any)=>x.reply.accountId='other',(x:any)=>x.reply.operation='post',(x:any)=>x.reply.sessionId='other-session',(x:any)=>x.reply.limit=25001,(x:any)=>x.reply.expiresAt+=1,(x:any)=>x.reply.checkedAt=NOW+120000,(x:any)=>x.reply.source='与同修订先前证据冲突'];
  for(const mutate of mutations){service.accept(original);const conflict=structuredClone(original);mutate(conflict);assert.throws(()=>service.accept(conflict),/无效|冲突/);assert.equal(service.get().post.status,'stale');assert.equal(service.get().effective.reply.limit,280);}
  const forged=structuredClone(original);for(const op of ['post','reply'] as const)Object.assign(forged[op],{status:'confirmed',limit:25000,countingMode:'unicode-codepoints',adapterRevision:'unverified-native-field',revision:'forged-'+op});service.accept(forged);assert.equal(service.get().effective.reply.limit,280);assert.equal(validatePostingText('a'.repeat(281),'reply',{accountId:'worker',capability:service.get().reply,now:NOW}).allowed,false);
 }finally{f.close();}
});

function previewFixture(accountId:string){
 const f=fixture(),config=structuredClone(exampleConfig) as Config,ledger=new LlmStore(f.store);let requests=0,policyReads=0,output='回复正文';const systems:string[]=[],requestsMetadata:any[]=[];
 const service=new PostingCapabilitiesService(f.store,()=>accountId);if(accountId)service.accept(new BrowserPostingCapabilities().observe({...logged,handle:accountId}));
 const generator:Generator={async complete(c,system,_user,_signal,_session,meta){requests++;systems.push(system);requestsMetadata.push(meta);const callId=ledger.start(c.model,meta);ledger.finish(callId,'completed',{usage:{input:10,output:5,cacheRead:2,cacheWrite:0,totalTokens:17},cost:{input:.001,output:.002,cacheRead:0,cacheWrite:0,total:.003},pricingStatus:'priced'});return {callId,text:JSON.stringify({action:'reply',text:output,reason:''}),input:10,output:5,cache:2};}};
 const persona=new PersonaService(f.store,generator,()=>config);persona.postingPolicy=()=>{policyReads++;return service.get();};
 return {...f,persona,ledger,systems,requestsMetadata,setOutput:(value:string)=>output=value,get requests(){return requests;},get policyReads(){return policyReads;}};
}
const previewRequest=(channel:'public'|'private')=>({persona:legacyPersona('明确是AI的角色'),channel,messages:[{role:'user',text:'这是一条模拟消息'}]});
test('公开试聊分别使用当前账号缓存及无账号普通模拟，GET策略不额外访问浏览器或模型',async()=>{
 for(const accountId of ['','worker']){const f=previewFixture(accountId);try{const before=f.ledger.calls().items.length,result=await f.persona.preview(previewRequest('public'));assert.equal(result.postingPolicy.accountId,accountId||null);assert.equal(result.postingPolicy.simulation,!accountId);assert.match(result.postingPolicy.rule,/280.*加权字符/);assert.equal(result.draft?.text,'回复正文');assert.equal(f.policyReads,1);assert.equal(f.requests,1);assert.match(f.systems[0],/280.*加权字符/);assert.equal(result.fees.requests,1);assert.equal(result.fees.estimatedUsd,.003);assert.equal(result.calls[0].purpose,'persona-preview');assert.equal(f.ledger.calls().items.length,before+1);assert.equal(f.requestsMetadata[0].accountId,'preview');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get()?.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory').get()?.n,0);
  }finally{f.close();}}
});
test('公开试聊超长只报字数错误并保留一次真实夹具计量，不创建真实出站',async()=>{
 const f=previewFixture('worker');try{f.setOutput('a'.repeat(4001));const result=await f.persona.preview(previewRequest('public'));assert.equal(result.draft,null);assert.match(result.error??'',/字数限制/);assert.equal(f.requests,1);assert.equal(result.fees.requests,1);assert.equal(result.fees.estimatedUsd,.003);assert.equal(f.ledger.calls().items[0].status,'completed');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get()?.n,0);
 }finally{f.close();}
});
test('私信试聊继续使用4000 JavaScript字符，越界仍保留已产生费用',async()=>{
 const f=previewFixture('worker');try{f.setOutput('a'.repeat(4000));const good=await f.persona.preview(previewRequest('private'));assert.equal(good.draft?.text.length,4000);assert.match(good.postingPolicy.rule,/4,?000.*JavaScript/);f.setOutput('a'.repeat(4001));const bad=await f.persona.preview(previewRequest('private'));assert.equal(bad.draft,null);assert.match(bad.error??'',/4,000/);assert.equal(f.requests,2);assert.equal(bad.fees.requests,1);assert.equal(bad.fees.estimatedUsd,.003);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n,0);
 }finally{f.close();}
});
