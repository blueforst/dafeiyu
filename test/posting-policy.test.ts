import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';
import { BrowserPostingCapabilities,PostingCapabilitiesService } from '../src/posting-capabilities.js';
import { CAPABILITY_TTL_MS,effectivePostingLimit,normalizePublicText,postingLimitPrompt,publicResourceOK,rpcResourceOK,validatePostingText,type PostingCapability } from '../src/posting-policy.js';
import { PreflightJournal,TransportJournal,matchTweetReceipt,platformTweets,resolveSubmissionSignals } from '../src/browser.js';
const fixture=()=>{const dir=mkdtempSync(tmpdir()+'/posting-');const store=new Store(dir+'/db.sqlite');return {dir,store,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};};
test('短帖完整加权边界、私信渠道及公开Unicode资源保护一致',()=>{
 for(const text of ['a'.repeat(280),'中'.repeat(140),'😀'.repeat(140),'👩‍💻'.repeat(140)])assert.equal(validatePostingText(text,'reply').allowed,true,text.slice(0,8));
 for(const text of ['a'.repeat(281),'中'.repeat(141),'😀'.repeat(141),'👩‍💻'.repeat(141)])assert.equal(validatePostingText(text,'post').allowed,false,text.slice(0,8));
 assert.equal(validatePostingText('e\u0301','post').code,'normalization-required');assert.equal(normalizePublicText('e\u0301'),'é');assert.equal(validatePostingText('é','post').allowed,true);
 assert.equal(validatePostingText('a'.repeat(4000),'dm').allowed,true);assert.equal(validatePostingText('a'.repeat(4001),'dm').allowed,false);
 assert.equal(publicResourceOK('😀'.repeat(25000)),true);assert.equal(publicResourceOK('😀'.repeat(25001)),false);
 assert.equal(validatePostingText('中'.repeat(25001),'reply').code,'resource-limit');
 for(const text of ['','@alice hi','www.example.com','https://example.com'])assert.equal(validatePostingText(text,'dm').allowed,false);
 assert.equal(rpcResourceOK({text:'a'.repeat(300000)}),false);
});
test('数字、蓝标、伪造适配修订及其他账号不能授权长帖',()=>{
 const now=Date.now(),cap:PostingCapability={accountId:'worker',operation:'post',sessionId:'one',status:'confirmed',limit:25000,countingMode:'unicode-codepoints',adapterRevision:'unverified-field-name',source:'仅模拟证据',checkedAt:now,expiresAt:now+CAPABILITY_TTL_MS,revision:'1'};
 assert.equal(effectivePostingLimit('post',cap,'worker').limit,280);
 for(const capability of [cap,{...cap,accountId:'other'},{...cap,operation:'reply' as const},{...cap,expiresAt:now-1},{...cap,status:'stale' as const}])assert.equal(validatePostingText('x'.repeat(281),'post',{capability,accountId:'worker'}).allowed,false);
 assert.match(postingLimitPrompt('reply',cap,'worker'),/280.*加权字符/);
});
test('能力缓存读取消耗零浏览器调用、进程重启及账号切换不继承权限',()=>{
 const f=fixture();try{let account='worker';const service=new PostingCapabilitiesService(f.store,()=>account),browser=new BrowserPostingCapabilities();
  assert.equal(service.get().reply.status,'unknown');const snapshot=browser.observe({handle:'worker',loggedIn:true,needsHuman:false},100);
  service.accept(snapshot);assert.equal(service.get().post.status,'stale'); // 模拟时钟记录已过期。
  const fresh=browser.observe({handle:'worker',loggedIn:true,needsHuman:false});service.accept(fresh);
  assert.equal(new PostingCapabilitiesService(f.store,()=>account).get().post.status,'stale');
  browser.invalidate();assert.equal(browser.observe({handle:'worker',loggedIn:true,needsHuman:false}).post.status,'unknown');
  account='other';assert.equal(service.get().post.accountId,'other');assert.equal(service.get().effective.post.limit,280);assert.throws(()=>service.accept(fresh),/账号不符/);
  const changed=browser.observe({handle:'other',loggedIn:true,needsHuman:false});assert.equal(changed.accountId,'other');assert.notEqual(changed.post.revision,fresh.post.revision);
 }finally{f.close();}
});
test('有界超长候选保留但不可begin，旧NULL元数据不可绕过；未提交不计额度',()=>{
 const f=fixture();try{const outbox=new Outbox(f.store);new Outbox(f.store);
  const long=outbox.prepare({accountId:'worker',kind:'post',sourceId:'long',text:'a'.repeat(4001)});assert.equal(long.text.length,4001);assert.equal(JSON.parse(long.validation_json!).allowed,false);assert.equal(outbox.begin(long.id),false);
  const normal=outbox.prepare({accountId:'worker',kind:'post',sourceId:'normal',text:'早安'});f.store.db.prepare('UPDATE outbox SET validation_json=NULL WHERE id=?').run(normal.id);assert.equal(outbox.begin(normal.id),false);outbox.validate(normal.id);assert.equal(outbox.begin(normal.id),true);
  outbox.settle(normal.id,{status:'not_submitted',reason:'能力变化',validation:validatePostingText('x'.repeat(281),'post')});assert.equal(outbox.get(normal.id)?.status,'cancelled');assert.equal(outbox.count('public','worker'),0);assert.equal(outbox.begin(normal.id),false);
  const prepared=outbox.prepare({accountId:'worker',kind:'post',sourceId:'edit',text:'旧稿'});outbox.retext(prepared.id,'新稿');assert.equal(outbox.get(prepared.id)?.text,'新稿');outbox.begin(prepared.id);assert.throws(()=>outbox.retext(prepared.id,'再次修改'),/未提交/);
 }finally{f.close();}
});
test('独立预检终态在丢失响应、重启和同ID重放时可回查，写盘失败不伪报终态',()=>{
 const f=fixture();try{const path=f.dir+'/preflight.json',preflight=new PreflightJournal(path),validation=validatePostingText('中'.repeat(141),'reply');
  const result=preflight.block('same-id','reply','Worker','123','中'.repeat(141),validation);assert.equal(result.status,'not_submitted');assert.equal(new PreflightJournal(path).get('same-id','reply','worker','123','中'.repeat(141))?.status,'not_submitted');assert.equal(JSON.parse(readFileSync(path,'utf8')).version,1);
  assert.throws(()=>preflight.get('same-id','reply','worker','999','中'.repeat(141)),/不能改变/);
  const fail=new PreflightJournal(f.dir+'/absent/result.json');assert.throws(()=>fail.block('write-fails','reply','worker','123','超长',validation));assert.equal(fail.get('write-fails','reply','worker','123','超长')?.status,'unknown');
  const journal=new TransportJournal(f.dir+'/submissions.json');journal.intent('submitted','reply','worker','123','正文');assert.throws(()=>journal.settle('submitted',result),/不能改记/);assert.equal(journal.get('submitted')?.receipt.status,'unknown');
  writeFileSync(f.dir+'/bad.json','{}');assert.throws(()=>new PreflightJournal(f.dir+'/bad.json'),/日志损坏/);
 }finally{f.close();}
});
test('截断长帖与未验收note正文不确认，普通完整回执仍匹配且作者目标严格',()=>{
 const now=Date.now()-1000;const result={rest_id:'42',legacy:{full_text:'前缀',created_at:new Date(now).toUTCString(),in_reply_to_status_id_str:'41',truncated:true},core:{user_results:{result:{legacy:{screen_name:'Worker'}}}}};
 const incomplete=platformTweets(result);assert.equal(incomplete[0].complete,false);assert.equal(matchTweetReceipt(incomplete,'worker','前缀','41',now).status,'unknown');
 const note={...result,legacy:{...result.legacy,truncated:false},note_tweet:{note_tweet_results:{result:{text:'前缀完整长帖'}}}};assert.equal(platformTweets(note)[0].complete,false);assert.equal(matchTweetReceipt(platformTweets(note),'worker','前缀','41',now).status,'unknown');
 const complete={...result,legacy:{...result.legacy,truncated:false}};assert.equal(matchTweetReceipt(platformTweets(complete),'worker','前缀','41',now).status,'confirmed');assert.equal(matchTweetReceipt(platformTweets(complete),'worker','前缀',null,now).status,'unknown');
});
test('能力GET纯读缓存，刷新与人工接管互斥且忽略外部自报上限',async()=>{
 const {default:Fastify}=await import('fastify');const {registerPostingRoutes}=await import('../src/posting-routes.js');const f=fixture(),app=Fastify();let control='paused',busy=false,reads=0,operations=0;
 try{const capabilities=new PostingCapabilitiesService(f.store,()=> 'worker'),browser=new BrowserPostingCapabilities();registerPostingRoutes(app,{capabilities,control:()=>control,busy:()=>busy,refresh:async()=>{reads++;return browser.observe({handle:'worker',loggedIn:true,needsHuman:false});},operation:async fn=>{operations++;return fn();}});
  assert.equal((await app.inject({url:'/api/account/posting-limits'})).statusCode,200);assert.equal(reads,0);assert.equal(operations,0);
  const response=await app.inject({method:'POST',url:'/api/account/posting-limits/refresh',payload:{limit:25000,status:'confirmed'}});assert.equal(response.statusCode,200);assert.equal(response.json().effective.post.limit,280);assert.equal(control,'paused');assert.equal(reads,1);
  control='manual';assert.equal((await app.inject({method:'POST',url:'/api/account/posting-limits/refresh',payload:{}})).statusCode,409);assert.equal(reads,1);assert.equal((await app.inject({url:'/api/account/posting-limits'})).statusCode,200);
  control='running';busy=true;assert.equal((await app.inject({method:'POST',url:'/api/account/posting-limits/refresh',payload:{}})).statusCode,409);assert.equal(reads,1);
 }finally{await app.close();f.close();}
});

test('唯一完整回执优先于旧toast，新提示须明确证明本次拒绝且other不冒充quota',()=>{
 const confirmed={status:'confirmed' as const,id:'receipt-unique'},unknown={status:'unknown' as const};
 assert.deepEqual(resolveSubmissionSignals(confirmed,[],['Your daily post limit was reached']),confirmed);
 assert.equal(resolveSubmissionSignals(unknown,['Your daily post limit was reached'],['Your daily post limit was reached']).status,'unknown');
 for(const text of ['Something failed. Please try again.','More information about automated accounts','稍后查看通知','Unable to load notifications'])assert.equal(resolveSubmissionSignals(unknown,[],[text]).status,'unknown');
 const quota=resolveSubmissionSignals(unknown,[],['You reached your daily post limit']);assert.equal(quota.status,'rejected');assert.equal(quota.rejectionKind,'quota');
 const automation=resolveSubmissionSignals(unknown,[],['This request looks like it might be automated']);assert.equal(automation.status,'rejected');assert.equal(automation.rejectionKind,'automation');
 const other=resolveSubmissionSignals(unknown,[],['Your message could not be sent']);assert.equal(other.status,'rejected');assert.equal(other.rejectionKind,'other');
});

test('预检rename后持久同步失败时同ID冻结unknown，重启可读取已落盘终态',()=>{
 const f=fixture();try{const path=f.dir+'/late-failure.json',validation=validatePostingText('中'.repeat(141),'reply');let writes=0;
  const journal=new PreflightJournal(path,(target,serialized)=>{writes++;writeFileSync(target,serialized,{mode:0o600});throw new Error('模拟目录同步失败');});
  assert.throws(()=>journal.block('late-fail','reply','worker','123','中'.repeat(141),validation),/同步失败/);
  assert.equal(journal.get('late-fail','reply','worker','123','中'.repeat(141))?.status,'unknown');assert.equal(journal.block('late-fail','reply','worker','123','中'.repeat(141),validation).status,'unknown');assert.equal(writes,1);
  assert.throws(()=>journal.get('late-fail','reply','worker','123','改写'),/不能改变/);
  assert.equal(new PreflightJournal(path).get('late-fail','reply','worker','123','中'.repeat(141))?.status,'not_submitted');
 }finally{f.close();}
});
