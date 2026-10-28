// 仅服务器隔离验收：真实 HTTP broker → BrowserTransport → Workflow。
// 使用临时资料、合成 X DOM 与原生读取响应；容器必须 --network none，禁止生产挂载。
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {observer} from '/opt/role-camoufox/launch.mjs';
import {startBrowserServer} from '../dist/browser.js';
import {BrowserTransport} from '../dist/transport.js';
import {Workflow} from '../dist/workflow.js';
import {Store} from '../dist/store.js';
import {Program} from '../dist/program.js';
import {Outbox} from '../dist/outbox.js';
import {ModelService} from '../dist/model.js';

const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const root=mkdtempSync(tmpdir()+'/browser-broker-'),actor='fixture_worker',secret='isolated-broker-key-fixture';
const previous=new Map(['SECRETS_DIR','PROFILE_DIR','DATA_DIR','BROWSER_PORT'].map(key=>[key,process.env[key]]));
mkdirSync(root+'/secrets');mkdirSync(root+'/profile');mkdirSync(root+'/data');
writeFileSync(root+'/secrets/browser_key',secret,{mode:0o600});writeFileSync(root+'/secrets/model_api_key','fixture-model-key-never-network',{mode:0o600});
Object.assign(process.env,{SECRETS_DIR:root+'/secrets',PROFILE_DIR:root+'/profile',DATA_DIR:root+'/data',BROWSER_PORT:'0'});
const report={evidence:'真实隔离 Camoufox、HTTP Fastify broker、BrowserTransport、Workflow、SQLite、统一模型流水；模型为注入模拟，所有 X 请求由路由合成',nativeFixture:'首帧缓存目标和main已存在、无spinner、原生读取延后800ms',checks:[],errors:[],broker:[],nativeReads:0,submitClicks:0,externalRequests:[],screenshots:[],platformNetworkUsed:false,realModelUsed:false,temporaryProfile:true};
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const journal=()=>existsSync(root+'/profile/transport-journal.json')?JSON.parse(readFileSync(root+'/profile/transport-journal.json','utf8')):{};
const preflight=()=>existsSync(root+'/profile/posting-preflight-v1.json')?JSON.parse(readFileSync(root+'/profile/posting-preflight-v1.json','utf8')).entries:{};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,broker,transport,scenario,endpoint,sequence=0,chatFixtureMode='empty';
const chatFixtures={native:readFileSync(new URL('./fixtures/chat/native-shadow.html',import.meta.url),'utf8'),legacy:readFileSync(new URL('./fixtures/chat/legacy.html',import.meta.url),'utf8')};
const resources=[];
function persist(){writeFileSync(OUT+'/browser-broker-acceptance.json',JSON.stringify({...report,passed:report.checks.length,failed:report.errors.length},null,2));}
async function check(name,fn){console.log('[开始] '+name);const started=Date.now();try{const detail=await fn();report.checks.push({name,durationMs:Date.now()-started,...(detail?{detail}:{})});console.log('[通过] '+name);}catch(error){report.errors.push({name,error:error.stack||String(error)});console.log('[失败] '+name+'：'+String(error));}finally{persist();}}
async function screenshot(name){const page=broker.context.pages().find(page=>!/^https:\/\/x\.com\/(?:messages|i\/chat)(?:\/|$)/.test(page.url()));assert.ok(page);await page.setViewportSize({width:1440,height:900});const path=OUT+'/'+name+'.png';await page.screenshot({path,fullPage:true});report.screenshots.push(path);}
function setScenario(id,handle,{deleted=false,unknown=false,nativeDelay=800,hasQuote=false,missingDuringContext=false}={}){
 const timestamp=Date.now(),event={id:'x:'+id,platformId:id,targetId:id,channel:'public',userId:'x:'+handle,handle,text:'@'+actor+' 合成新问题 '+id,url:'https://x.com/'+handle+'/status/'+id,conversationId:id,timestamp,timestampReliable:true};
 scenario={event,deleted,unknown,nativeDelay,hasQuote,missingDuringContext,generated:0,clicks:0};return scenario;
}
function article(event,reply=false,extras=''){
 return '<article data-testid="tweet"><a href="/'+event.handle+'/status/'+event.platformId+'"><time datetime="'+new Date(event.timestamp).toISOString()+'"></time></a><div data-testid="tweetText">'+esc(event.text)+'</div>'+extras+(reply?'<button data-testid="reply" onclick="openReply()">回复</button>':'')+'</article>';
}
function rootEvent(){return {handle:actor,platformId:'900',timestamp:Date.now()-60000,text:'合成主帖'};}
function shell(body,script=''){
 return '<!doctype html><html><body><nav><a data-testid="AppTabBar_Profile_Link" href="/'+actor+'">个人主页</a></nav><main>'+body+'</main><script>'+script+'</script></body></html>';
}
function targetBody(){
 if(scenario.deleted)return '<div data-testid="error-detail">This Post was deleted</div>';
 if(scenario.missingDuringContext)return article(rootEvent());
 const extras=scenario.hasQuote?'<div data-testid="quoteTweet"><a href="/quoted_person/status/801"><time datetime="'+new Date(scenario.event.timestamp).toISOString()+'"></time></a><div data-testid="tweetText">独立引用内容</div></div><div data-testid="card.wrapper"><a href="https://never-open.invalid/card"><div data-testid="card.domain">never-open.invalid</div><div data-testid="card.title">卡片独立标题</div></a></div>':'';
 return article(rootEvent())+article(scenario.event,true,extras);
}
function nativeHTML(body,path){
 // 缓存文章及main从首帧就存在，且没有spinner；必须实际等待页面自己的原生读取结束。
 return shell(body,`fetch('/i/api/graphql/fixture/TweetDetail?path='+encodeURIComponent(${JSON.stringify(path)})).then(r=>r.json()).then(()=>{document.querySelector('main').innerHTML=${JSON.stringify(body)}});function openReply(){const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div><button data-testid="tweetButton">发送</button>';document.body.append(d);d.querySelector('button').onclick=()=>{const text=d.querySelector('[contenteditable]').innerText;fetch('/i/api/graphql/fixture/CreateTweet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,target:${JSON.stringify(scenario?.event.platformId??'')}})}).then(r=>r.json()).then(()=>d.remove())};}`);
}
function workflowFixture(onGenerate){
 const folder=root+'/workflow-'+(++sequence);mkdirSync(folder);const store=new Store(folder+'/workflow.sqlite'),outbox=new Outbox(store),program=new Program(store);
 // 本套核对浏览器提交与回查边界，显式排除夜间作息对生成路径的遮挡。
 const config={mode:'auto',pollSeconds:60,maxAgeHours:6,maxPerRound:1,publicPerHour:20,privatePerHour:20,publicPerDay:180,replyHours:{enabled:false,closeDelayMinutes:30},retentionDays:30,persona:'你是 AI 隔离测试角色。',dailyState:'隔离模拟',model:{provider:'custom',source:'config',api:'openai-completions',baseUrl:'https://model-never-open.invalid',id:'fixture-model',reasoning:false,reasoningLevel:'low',vision:false,maxTokens:256,timeoutMs:10000},health:{memoryRatio:.95,publicCollectionSeconds:15,privateCollectionSeconds:10,rpcTimeoutSeconds:30}};
 const prompts=[],generator=new ModelService(store,async(_model,_key,system,user)=>{prompts.push({system,user});scenario.generated++;await onGenerate?.();return {text:JSON.stringify({action:'reply',text:'合成回复 '+scenario.event.platformId,reason:''}),input:8,output:8,cache:0,stopReason:'stop',latencyMs:1,pricingStatus:'unpriced'};});
 const workflow=new Workflow(store,transport,generator,()=>config);workflow.services={program,outbox};resources.push({workflow,store});
 const message=()=>store.getMessage(scenario.event.id,actor);
 return {workflow,store,outbox,program,config,prompts,message,row:()=>outbox.source(actor,'reply',message()?.id??scenario.event.id),calls:()=>store.db.prepare('SELECT id,status,purpose,pricing_status,input_tokens,output_tokens FROM llm_calls').all()};
}
function promptSection(user,title){const marker='【'+title+'】\n',start=user.indexOf(marker);assert.ok(start>=0,'缺少实际提示词段 '+title);const from=start+marker.length,end=user.indexOf('\n\n【',from);return JSON.parse(user.slice(from,end<0?undefined:end));}
try{
 browser=await observer();
 broker=await startBrowserServer({launch:async()=>{
  const context=await browser.newContext();
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!=='https://x.com'){if(!['about:','data:'].includes(url.protocol))report.externalRequests.push({origin:url.origin,path:url.pathname});await route.abort();return;}
   if(url.pathname==='/i/api/graphql/fixture/TweetDetail'){report.nativeReads++;await delay(scenario?.nativeDelay??0);await route.fulfill({status:200,json:{ready:true}});return;}
   if(url.pathname==='/i/api/graphql/fixture/CreateTweet'){
    report.submitClicks++;scenario.clicks++;const body=request.postDataJSON();if(body.target!==scenario.event.platformId){report.errors.push({name:'合成submit目标绑定',error:'fixture-target-mismatch'});await route.fulfill({status:400,json:{error:'fixture-target-mismatch'}});return;}
    const payload=scenario.unknown?{acknowledged:true}:{data:{create_tweet:{tweet_results:{result:{rest_id:String(7000+report.submitClicks),legacy:{full_text:body.text,created_at:new Date().toUTCString(),in_reply_to_status_id_str:body.target,truncated:false},core:{user_results:{result:{legacy:{screen_name:actor}}}}}}}}};
    await route.fulfill({status:200,json:payload});return;
   }
   let html;
   if(url.pathname==='/home')html=shell('<div data-testid="emptyState">No posts</div>');
   else if(url.pathname.startsWith('/messages')||url.pathname.startsWith('/i/chat'))html=chatFixtureMode==='empty'?shell('<div data-testid="emptyState">No messages</div>'):chatFixtures[chatFixtureMode].replace('<body>','<body><nav><a data-testid="AppTabBar_Profile_Link" href="/'+actor+'">个人主页</a></nav>');
   else if(url.pathname==='/notifications/mentions'||url.pathname==='/search')html=nativeHTML(scenario?article(scenario.event):'<div data-testid="emptyState">No results</div>',url.pathname);
   else if(url.pathname==='/'+actor)html=nativeHTML(article(rootEvent()),url.pathname);
   else if(url.pathname==='/'+actor+'/status/900')html=nativeHTML(article(rootEvent())+(scenario?article(scenario.event):'<div data-testid="emptyState">No replies</div>'),url.pathname);
   else if(scenario&&url.pathname===new URL(scenario.event.url).pathname)html=nativeHTML(targetBody(),url.pathname);
   else{report.externalRequests.push({origin:url.origin,path:url.pathname});await route.abort();return;}
   await route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'cache-control':'no-store'},body:html});
  });return context;
 }});
 endpoint='http://127.0.0.1:'+broker.app.server.address().port;
 class ObservedTransport extends BrowserTransport{async rpc(path,data,options){const entry={path,method:data===undefined?'GET':'POST',startedAt:Date.now()};report.broker.push(entry);try{const result=await super.rpc(path,data,options);entry.status='ok';if(result?.status)entry.receipt=result.status;return result;}catch(error){entry.status='failed';entry.diagnostic=error.diagnostic;throw error;}finally{entry.durationMs=Date.now()-entry.startedAt;}}}
 transport=new ObservedTransport(endpoint,secret,()=>({memoryRatio:.95,publicCollectionSeconds:15,privateCollectionSeconds:10,rpcTimeoutSeconds:30}));

 await check('HTTP认证与采集来源元数据只读，全部通知持续关闭',async()=>{
  assert.equal((await fetch(endpoint+'/collection-sources')).status,401);const before=report.nativeReads,sources=await transport.collectionSources();assert.equal(report.nativeReads,before);assert.equal(sources.sources.find(source=>source.id==='all-notifications').enabled,false);assert.equal((await transport.identity()).handle,actor);await transport.control('auto');return {enabled:sources.sources.filter(source=>source.enabled).map(source=>source.id)};
 });
 await check('HTTP context等待native SPA水合，inspect-post使用规范链接返回严格目标与独立字段',async()=>{
  const s=setScenario('101','visitor_alpha',{hasQuote:true}),started=Date.now();const conversation=JSON.parse(await transport.context(s.event,actor));assert.equal(conversation.contextIncomplete,false);assert.equal(conversation.messages.at(-1).platformId,'101');assert.ok(Date.now()-started>=s.nativeDelay);assert.equal(conversation.messages.at(-1).quote.text,'独立引用内容');
  const result=await transport.inspectPost(s.event.url+'?fixture=1',actor);assert.equal(result.event.platformId,'101');assert.equal(result.target.handle,'visitor_alpha');assert.equal(result.target.timestampReliable,true);assert.deepEqual(result.context.ancestorHandles,[actor]);assert.equal(result.context.messages.at(-1).platformId,'101');assert.equal(report.externalRequests.length,0);await screenshot('broker-target-ready');return {nativeDelayMs:s.nativeDelay,targetLast:true};
 });
 await check('task外层控制预检失败也形成持久not_submitted，恢复后仅回查终态',async()=>{
  const s=setScenario('107','visitor_eta'),before=report.nativeReads;await transport.control('paused');const receipt=await transport.send(s.event,'合成暂停测试',actor);assert.equal(receipt.status,'not_submitted');assert.equal(receipt.browserPaused,true);assert.equal(receipt.diagnostic.code,'control-unavailable');assert.equal(receipt.diagnostic.stage,'control');assert.equal(preflight()[s.event.id].receipt.status,'not_submitted');assert.equal(journal()[s.event.id],undefined);assert.equal(report.nativeReads,before);await transport.control('auto');assert.equal((await transport.lookup(s.event,'合成暂停测试',actor)).status,'not_submitted');return {diagnostic:receipt.diagnostic,browserPaused:true};
 });
 await check('Workflow经HTTP采集不同actor的新消息，无账号白名单并各提交一次',async()=>{
  const f=workflowFixture();for(const [id,handle] of [['102','visitor_beta'],['103','visitor_gamma']]){
   const s=setScenario(id,handle,{hasQuote:id==='102'});await f.workflow.resume();await f.workflow.tick();assert.equal(f.message()?.status,'confirmed');assert.equal(f.row()?.status,'confirmed');assert.equal(s.generated,1);assert.equal(s.clicks,1);assert.ok(journal()[f.row().id]);
   const prompt=f.prompts.at(-1),conversation=promptSection(prompt.user,'当前对话');assert.equal(typeof conversation,'object');assert.equal(Array.isArray(conversation),false);assert.equal(conversation.messages.at(-1).platformId,id);assert.ok(prompt.system.includes('不可信资料'));
   if(id==='102'){const target=conversation.messages.at(-1);assert.ok(target.quote.note.includes('不可信'));assert.ok(target.card.note.includes('没有打开'));assert.equal(target.text,s.event.text);}
  }
  assert.equal(f.calls().length,2);assert.ok(f.calls().every(call=>call.status==='completed'&&call.pricing_status==='unpriced'));assert.equal(f.program.list().filter(stage=>stage.status==='running').length,0);return {confirmed:2,modelCalls:f.calls().length,actualPromptConversationObject:true,quoteCardNotes:true};
 });
 await check('HTTP上下文无法定位目标时仅返回不完整空上文，生成仍依据采集正文且发送重新严格定位',async()=>{
  const s=setScenario('108','visitor_theta',{missingDuringContext:true}),f=workflowFixture(()=>{s.missingDuringContext=false;});await f.workflow.resume();await f.workflow.tick();assert.equal(f.message()?.status,'confirmed');assert.equal(f.calls().length,1);assert.equal(s.clicks,1);const prompt=f.prompts[0],conversation=promptSection(prompt.user,'当前对话'),message=promptSection(prompt.user,'本次消息');assert.deepEqual(conversation.messages,[]);assert.equal(conversation.contextIncomplete,true);assert.ok(conversation.contextNote.includes('不完整'));assert.equal(message.message,s.event.text);return {contextIncomplete:true,originalBodyKept:true,strictSendConfirmed:true};
 });
 await check('生成后目标明确删除，新的HTTP发送持久not_submitted且Workflow保留草稿',async()=>{
  const s=setScenario('104','visitor_delta'),f=workflowFixture(()=>{s.deleted=true;});const before=report.submitClicks;await f.workflow.resume();await f.workflow.tick();const message=f.message(),row=f.row(),receipt=JSON.parse(message.receipt);assert.equal(message.status,'draft');assert.equal(row.status,'cancelled');assert.equal(receipt.status,'not_submitted');assert.equal(receipt.diagnostic.code,'public-target-unavailable');assert.equal(receipt.diagnostic.stage,'target-ready');assert.equal(report.submitClicks,before);assert.equal(journal()[row.id],undefined);assert.equal(preflight()[row.id].receipt.status,'not_submitted');assert.equal(f.calls().length,1);assert.equal(f.workflow.cooldown('public'),0);
  assert.equal((await transport.lookup({...s.event,outboxId:row.id},row.text,actor)).status,'not_submitted');await screenshot('broker-deleted-not-submitted');return {message:message.status,outbox:row.status,diagnostic:receipt.diagnostic,modelCalls:f.calls().length};
 });
 await check('提交intent后缺回执保持unknown，多轮Workflow仅回查不生成不重复点击',async()=>{
  const s=setScenario('105','visitor_epsilon',{unknown:true}),f=workflowFixture();await f.workflow.resume();await f.workflow.tick();assert.equal(f.message()?.status,'unknown');assert.equal(f.row()?.status,'unknown');const row=f.row(),beforeClicks=report.submitClicks,beforeCalls=f.calls().length,beforeLookups=report.broker.filter(entry=>entry.path==='/lookup').length;assert.equal(journal()[row.id].receipt.status,'unknown');assert.equal(preflight()[row.id],undefined);await f.workflow.tick();await f.workflow.tick();const lookups=report.broker.filter(entry=>entry.path==='/lookup').length-beforeLookups;assert.ok(lookups>=2);assert.equal(f.workflow.control(),'running');assert.equal(f.message().status,'unknown');assert.equal(f.row().id,row.id);assert.equal(f.row().status,'unknown');assert.equal(report.submitClicks,beforeClicks);assert.equal(f.calls().length,beforeCalls);assert.equal(s.clicks,1);assert.equal((await transport.send({...s.event,outboxId:row.id},row.text,actor)).status,'unknown');assert.equal(report.submitClicks,beforeClicks);return {message:'unknown',intentPreserved:true,clicks:s.clicks,generations:f.calls().length,workflowLookups:lookups};
 });
 await check('历史unknown无journal不能降级为未提交或重发，安全诊断不复制正文',async()=>{
  const s=setScenario('106','visitor_zeta'),f=workflowFixture();await f.workflow.resume();f.store.ingest(s.event,actor);const stored=f.message(),storedEvent=JSON.parse(stored.body),row=f.outbox.prepare({id:'historical-unknown-fixture',accountId:actor,kind:'reply',sourceId:stored.id,targetId:s.event.platformId,event:storedEvent,text:'历史合成回复'});assert.equal(f.outbox.begin(row.id),true);f.outbox.settle(row.id,{status:'unknown'});f.store.update(stored.id,'unknown',{draft:{action:'reply',text:row.text}});const before=report.submitClicks,beforeLookups=report.broker.filter(entry=>entry.path==='/lookup').length;await f.workflow.tick();assert.ok(report.broker.filter(entry=>entry.path==='/lookup').length>beforeLookups);assert.equal(f.workflow.control(),'running');assert.equal(f.message().status,'unknown');assert.equal(f.outbox.get(row.id).status,'unknown');assert.equal(report.submitClicks,before);assert.equal(preflight()[row.id],undefined);assert.equal(journal()[row.id],undefined);assert.equal(f.calls().length,0);assert.equal(report.externalRequests.length,0);assert.ok(!JSON.stringify(f.store.logs()).includes(s.event.text));return {status:'unknown',noRetroactivePreflight:true};
 });
 await check('HTTP保留legacy可靠入站，新Chat样本仅诊断且发送明确未提交',async()=>{
  chatFixtureMode='legacy';const legacy=await transport.collectPrivate(actor);assert.equal(legacy.events.length,1);assert.equal(legacy.events[0].platformId,'legacy-platform-message');assert.equal(legacy.events[0].timestampReliable,true);
  chatFixtureMode='native';const native=await transport.collectPrivate(actor);assert.equal(native.events.length,0);assert.ok(native.diagnostics.some(entry=>entry.code==='chat-native-time-unverified'));assert.ok(!native.diagnostics.some(entry=>entry.status==='empty'));
  const event={id:'native-unverified-negative',platformId:'11111111-1111-4111-8111-111111111111',channel:'private',userId:'x:fixture_peer',handle:'fixture_peer',text:'合成结构未验收负向输入',url:'https://x.com/i/chat/111-222',conversationId:'111-222',timestamp:Date.now(),timestampReliable:true},before=report.submitClicks,receipt=await transport.send(event,'合成拒绝发送测试',actor);assert.equal(receipt.status,'not_submitted');assert.equal(receipt.diagnostic.code,'private-contract-unverified');assert.equal(receipt.diagnostic.stage,'dm-validate');assert.equal(journal()[event.id],undefined);assert.equal(preflight()[event.id].receipt.status,'not_submitted');assert.equal(report.submitClicks,before);const chatPage=broker.context.pages().find(page=>page.url()==='https://x.com/i/chat/111-222');assert.ok(chatPage);assert.equal(await chatPage.evaluate(()=>window.__requestActions||0),0);assert.equal(report.externalRequests.length,0);return {legacyEvents:1,nativeEvents:0,diagnostic:receipt.diagnostic,noAcceptOrBlockClicks:true};
 });
}catch(error){report.errors.push({name:'脚本执行异常',error:error.stack||String(error)});}
finally{
 for(const {workflow,store}of resources){workflow.stop();store.db.close();}
 if(broker)await broker.app.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});
 for(const [key,value]of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;
 rmSync(root,{recursive:true,force:true});persist();console.log(JSON.stringify({...report,passed:report.checks.length,failed:report.errors.length},null,2));if(report.errors.length)process.exitCode=1;
}
