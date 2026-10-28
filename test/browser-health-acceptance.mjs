// 仅由服务器隔离 Camoufox 镜像执行；全新临时 profile，不读取生产凭据，不访问 X。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {launch} from '/opt/role-camoufox/launch.mjs';
import {BrowserResourceGuard,assessCompliance,readBrowserMemory,waitForIdentityReady} from '../dist/unattended-health.js';
import {readCompliance,identity as browserIdentity,collectPublicWithBudget,collectPrivateWithBudget} from '../dist/browser.js';
import {Store} from '../dist/store.js';
import {Workflow} from '../dist/workflow.js';
import {readPrivatePeer} from '../dist/chat-dom.js';
import {readPublicPageSnapshot} from '../dist/public-collection.js';

const artifactDir=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(artifactDir,{recursive:true});
const temporary=mkdtempSync(tmpdir()+'/role-browser-health-'),profile=temporary+'/profile';
const output={evidence:'真实隔离 Camoufox 持久 profile／localhost cookie；账号与合规为合成 DOM，不代表 X 真实登录或合规验收',checks:[],errors:[],engine:'camoufox',productionProfileUsed:false,platformVisited:false};
const checks=(name,detail={})=>output.checks.push({name,passed:true,...detail});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=value=>createHash('sha256').update(value).digest('hex');
let xvfb,context,page,origin,restarts=0,now=Date.now(),memoryRatio=.2;
const requests=[],blocked=[];
const server=createServer((request,response)=>{requests.push(request.url);response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end('<!doctype html><html><body><main data-fixture="local-profile">隔离持久 profile 检查</main></body></html>');});
async function routeLocalOnly(current){await current.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();blocked.push(url.origin);return route.abort();});}
async function openContext(){const next=await launch(profile);await routeLocalOnly(next);context=next;page=next.pages()[0]||await next.newPage();await page.goto(origin+'/profile-fixture',{waitUntil:'domcontentloaded',timeout:30000});return next;}
const marker=randomUUID();
async function localIdentity(){const cookies=await context.cookies(origin);const visible=await page.locator('main[data-fixture="local-profile"]').count();return {handle:'fixture_worker',loggedIn:!!visible&&cookies.some(cookie=>cookie.name==='health_profile_marker'&&cookie.value===marker),needsHuman:false};}
async function fingerprint(){return page.evaluate(()=>({userAgent:navigator.userAgent,platform:navigator.platform,language:navigator.language,screenWidth:screen.width,screenHeight:screen.height}));}
try{
 const suppliedDisplay=/^:(\d+)(?:\.\d+)?$/.exec(process.env.DISPLAY||'');const displayAvailable=!!(suppliedDisplay&&existsSync('/tmp/.X11-unix/X'+suppliedDisplay[1]));
 if(!displayAvailable&&process.env.HEALTH_USE_EXISTING_DISPLAY!=='1'){
  const number=200+process.pid%10000,display=':'+number;process.env.DISPLAY=display;
  xvfb=spawn('Xvfb',[display,'-screen','0','1440x900x24','-nolisten','tcp'],{stdio:'ignore'});let launchError;xvfb.once('error',error=>{launchError=error;});
  const deadline=Date.now()+10000;while(!existsSync('/tmp/.X11-unix/X'+number)){if(launchError)throw launchError;if(xvfb.exitCode!==null)throw Error('隔离 Xvfb 退出');if(Date.now()>deadline)throw Error('隔离 Xvfb 启动超时');await delay(50);}
 }
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 const actualMemory=readBrowserMemory();assert.ok(['cgroup','process-rss','unavailable'].includes(actualMemory.source));checks('真实容器只读内存采样或明确无法确认', {memory:actualMemory});
 await openContext();await context.addCookies([{name:'health_profile_marker',value:marker,url:origin,httpOnly:true,sameSite:'Lax',expires:Math.floor(Date.now()/1000)+86400}]);
 const presetPath=profile+'/device-preset.json',presetBefore=sha(readFileSync(presetPath)),fingerprintBefore=await fingerprint();assert.equal((await localIdentity()).loggedIn,true);checks('全新临时profile与localhost持久cookie', {devicePresetHash:presetBefore});
 const guard=new BrowserResourceGuard({clock:()=>now,settings:()=>({memoryRatio:.75,browserMaxAgeHours:24}),readMemory:()=>({bytes:memoryRatio*2147483648,limitBytes:2147483648,ratio:memoryRatio,source:'cgroup'}),identity:localIdentity,restart:async()=>{const previous=context;await previous.close();assert.equal(previous.pages().length,0);await openContext();restarts++;return localIdentity();}});
 memoryRatio=.9;await guard.before('prepare-round','auto','fixture_worker',{safePoint:true});now+=31000;await guard.before('prepare-round','auto','fixture_worker',{safePoint:true});assert.equal(restarts,1);assert.equal((await localIdentity()).loggedIn,true);assert.equal(sha(readFileSync(presetPath)),presetBefore);assert.deepEqual(await fingerprint(),fingerprintBefore);assert.equal(guard.snapshot().lastRestartReason,'memory-threshold');checks('高内存触发真实close与launch，cookie及设备预设保持', {restarts});
 for(const operation of ['send','post','lookup','lookupPost'])await guard.before(operation,'auto','fixture_worker');await guard.before('collect/public','manual','fixture_worker');await guard.before('collect/private','draining','fixture_worker');assert.equal(restarts,1);checks('send／post／lookup／manual／draining不重启', {restarts});
 const protectedContext=context;now+=31000;await guard.before('prepare-round','auto','fixture_worker',{safePoint:true,protectedReasons:['chat-unlocked']});assert.equal(context,protectedContext);assert.equal(restarts,1);assert.equal((await localIdentity()).loggedIn,true);assert.equal(guard.snapshot().recoveryDeferredReason,'protected-session');checks('合成Chat保护标记下持续高内存保持真实上下文和持久标记', {syntheticProtection:true,restarts});
 memoryRatio=.2;now+=25*3600000;await guard.before('prepare-round','auto','fixture_worker',{safePoint:true});assert.equal(restarts,2);assert.equal(guard.snapshot().lastRestartReason,'runtime-threshold');assert.equal((await localIdentity()).loggedIn,true);assert.equal(sha(readFileSync(presetPath)),presetBefore);checks('运行时长触发真实上下文恢复，持久标记保持', {restarts});
 let mode='auto',failureNow=0;const failedGuard=new BrowserResourceGuard({clock:()=>failureNow,identity:localIdentity,readMemory:()=>({bytes:200,limitBytes:200,ratio:1,source:'cgroup'}),restart:async()=>{throw Error('合成重启故障');}});
 await failedGuard.before('prepare-round',mode,'fixture_worker',{safePoint:true});failureNow+=31000;
 try{await failedGuard.before('prepare-round',mode,'fixture_worker',{safePoint:true});assert.fail('故障应中止操作');}catch(error){if(error.code==='browser-recovery-failed')mode='paused';else throw error;}assert.equal(mode,'paused');assert.ok(failedGuard.snapshot().restartError);checks('资源恢复故障经浏览器适配器进入暂停', {injectedFailure:true});
 const navigations=[];let writes=0,complianceMarkup='';const complianceReadiness={timeoutMs:1000,stableMs:20,intervalMs:10};
 const complianceHeader=(name,bio,label='')=>'<main><div data-testid="primaryColumn"><a href="/settings/profile">Edit profile</a><div data-testid="UserName"><div>'+name+'</div><div>@fixture_worker</div></div><div data-testid="UserDescription">'+bio+'</div>'+label+'<a href="/fixture_worker/following">1 Following</a><a href="/fixture_worker/verified_followers">2 Followers</a></div></main>';
 // page级route优先于外部网络拒绝规则，仅合成本地HTML，保留待判定页面的真实URL。
 await page.route('https://x.com/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:complianceMarkup}));
 const loadCompliance=async(p,url,html)=>{complianceMarkup=html;await p.goto(url,{waitUntil:'domcontentloaded'});await p.evaluate(()=>{window.__healthWrites=0;document.querySelectorAll('button,input').forEach(node=>node.addEventListener('click',()=>window.__healthWrites++));});};
 const syntheticNavigate=async(p,url)=>{navigations.push(url);if(url==='https://x.com/fixture_worker')await loadCompliance(p,url,complianceHeader('AI 测试角色','AI 非官方。仅用于合成 DOM 解析。','<div data-testid="UserLabel"><span>Automated by </span><a href="/fixture_owner">@fixture_owner</a></div>'));else if(url==='https://x.com/settings/notifications')await loadCompliance(p,url,'<main><a href="/settings/notifications/filters">Filters</a></main>');else if(url==='https://x.com/settings/notifications/filters')await loadCompliance(p,url,'<main><label for="quality">Quality filter</label><input id="quality" type="checkbox" checked onclick="window.__healthWrites++"></main>');else throw Error('出现非预期只读路径');};
 const observation=await readCompliance(page,'fixture_worker',syntheticNavigate,complianceReadiness),compliance=assessCompliance(observation,['AI','非官方']);writes+=await page.evaluate(()=>window.__healthWrites);
 assert.equal(observation.profileReliable,true);assert.equal(compliance.disclosure,'confirmed');assert.equal(compliance.automatedLabel,'confirmed');assert.equal(compliance.qualityFilter,'on');assert.deepEqual(navigations,['https://x.com/fixture_worker','https://x.com/settings/notifications','https://x.com/settings/notifications/filters']);assert.equal(writes,0);checks('合规合成DOM：披露、自动化标签、质量过滤开启，零写入', {syntheticDOM:true,navigationCount:navigations.length});
 const unknown=await readCompliance(page,'fixture_worker',async(p,url)=>{await loadCompliance(p,url,'<main>无法识别的合成页面</main>');},complianceReadiness);const unknownResult=assessCompliance(unknown);assert.equal(unknownResult.disclosure,'unknown');assert.equal(unknownResult.automatedLabel,'unknown');assert.equal(unknownResult.qualityFilter,'unknown');checks('合规合成DOM：无法可靠解析时保持unknown', {syntheticDOM:true});
 const missing=await readCompliance(page,'fixture_worker',async(p,url)=>{await loadCompliance(p,url,url.includes('/settings/')?'<main><label for="quality">Quality filter</label><input id="quality" type="checkbox"></main>':complianceHeader('普通测试角色','缺少披露说明'));},complianceReadiness);const missingResult=assessCompliance(missing);assert.equal(missingResult.disclosure,'missing');assert.equal(missingResult.automatedLabel,'missing');assert.equal(missingResult.qualityFilter,'off');checks('合规合成DOM：缺披露、缺标签与过滤关闭分别呈现', {syntheticDOM:true});
 await page.unroute('https://x.com/**');await page.goto(origin+'/profile-fixture',{waitUntil:'domcontentloaded'});
 for(const [message,restriction] of [['Your account is suspended','suspended'],['Your account is locked','locked'],['Your account is read-only','read_only'],['Your account is restricted','limited']]){await page.setContent('<a data-testid="AppTabBar_Profile_Link" href="/fixture_worker"></a><main><div role="alert">'+message+'</div></main>');assert.equal((await browserIdentity(page)).restricted,restriction);}
 await page.setContent('<a data-testid="AppTabBar_Profile_Link" href="/fixture_worker"></a><main><article data-testid="tweet">Your account is suspended</article><div data-testid="UserDescription">Your account is restricted</div></main>');assert.equal((await browserIdentity(page)).restricted,undefined);checks('受限合成DOM：四类自身提示与引用／简介误判保护', {syntheticDOM:true});
 await page.setContent('<main>合成 SPA 账号导航尚未水合</main>');let hydrationReads=0;
 const hydrated=await waitForIdentityReady(async()=>{const current=await browserIdentity(page);hydrationReads++;if(hydrationReads===1){assert.equal(current.loggedIn,false);await page.evaluate(()=>{const a=document.createElement('a');a.dataset.testid='AppTabBar_Profile_Link';a.setAttribute('href','/fixture_worker');document.body.appendChild(a);});}return current;},'fixture_worker',{timeoutMs:3000,intervalMs:25});assert.equal(hydrated.loggedIn,true);assert.ok(hydrationReads>=2);checks('DOMContentLoaded后的实际合成SPA水合延迟等待，不误判登录丢失', {syntheticDOM:true,identityReads:hydrationReads});
 const stamp=new Date().toISOString(),article=(handle,id,text)=>'<article data-testid="tweet"><a href="/'+handle+'/status/'+id+'"><time datetime="'+stamp+'"></time></a><div data-testid="tweetText">'+text+'</div></article>';
 let publicClock=0,publicLocation='';const publicNavigations=[];
 const partialPublic=await collectPublicWithBudget({page,handle:'fixture_worker',source:2,deadline:100,now:()=>publicClock,stableMs:0,minimumObserveMs:0,intervalMs:10,pageTimeoutMs:1000,sleep:async ms=>{publicClock+=ms;},inspect:async p=>{const snapshot=await readPublicPageSnapshot(p);if(publicLocation.endsWith('/status/101'))publicClock=101;return {...snapshot,url:publicLocation};},navigate:async(p,url)=>{publicLocation=url;publicNavigations.push(url);if(url==='https://x.com/fixture_worker')await p.setContent('<main>'+article('fixture_worker','101','合成原帖一')+article('fixture_worker','102','合成原帖二')+'</main>');else if(url==='https://x.com/fixture_worker/status/101')await p.setContent('<main aria-busy="true">'+article('fixture_worker','101','合成目标帖')+article('alice','201','已读到的公开回复')+'</main>');else throw Error('超预算后不得开始第二个帖文读取');}});
 assert.equal(partialPublic.events.length,1);assert.equal(partialPublic.events[0].platformId,'201');assert.ok(partialPublic.diagnostics.some(d=>d.code==='public-budget-exhausted'&&d.status==='partial'));assert.equal(publicNavigations.length,2);
 // 本项验收预算耗尽后的部分采集仍进入草稿链路，作息另有专项覆盖。
 const store=new Store(temporary+'/partial-workflow.sqlite');let generated=0;const config={mode:'draft',pollSeconds:60,maxAgeHours:6,maxPerRound:2,publicPerHour:10,privatePerHour:30,replyHours:{enabled:false,closeDelayMinutes:30},retentionDays:30,persona:'明确为AI的隔离测试角色',dailyState:'合成测试',model:{provider:'custom',api:'openai-completions',baseUrl:'',id:'',reasoning:false,reasoningLevel:'off',vision:false,maxTokens:4096,timeoutMs:60000}};
 const workflow=new Workflow(store,{identity:async()=>({handle:'fixture_worker',loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>partialPublic,context:async()=>'',send:async()=>{throw Error('草稿模式不得发送');},lookup:async()=>({status:'unknown'})},{complete:async()=>{generated++;return {text:JSON.stringify({action:'reply',text:'保留部分采集后的测试草稿',reason:''}),input:0,output:0,cache:0};}},()=>config);
 try{await workflow.resume();await workflow.tick();assert.equal(store.getMessage('x:201','fixture_worker')?.status,'draft');assert.equal(generated,1);assert.ok(store.logs().some(log=>log.event==='collection-warning'));}finally{workflow.stop();store.db.close();}
 checks('公开采集真实循环：超预算保留已读回复并进入实际工作流生成草稿', {syntheticDOM:true,events:partialPublic.events.length,navigations:publicNavigations.length});
 let privateClock=1000;const privateNavigations=[];
 await page.route('https://x.com/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(!['/messages','/messages/requests','/messages/1-2','/messages/1-3','/messages/1-4'].includes(path))return route.abort();
  const inbox=path==='/messages'||path==='/messages/requests',id=path==='/messages/1-2'?'dm201':'dm202';
  const body=inbox?'<main><a href="/messages/1-2">合成会话一</a><a href="/messages/1-3">合成会话二</a><a href="/messages/1-4">不应开始的会话三</a></main>':'<main><div data-testid="messageEntry" data-direction="in" data-message-id="'+id+'"><time datetime="'+stamp+'"></time><div data-testid="messageEntryContent">预算验证合成私信</div></div></main>';
  return route.fulfill({status:200,contentType:'text/html',body});
 });
 try{
  const partialPrivate=await collectPrivateWithBudget({page,handle:'fixture_worker',deadline:31000,now:()=>privateClock,navigate:async(p,url)=>{
   privateNavigations.push(url);if(url==='https://x.com/messages/1-4')throw Error('预算耗尽后不得开始第三个私信会话');
   await p.goto(url,{waitUntil:'domcontentloaded'});if(url==='https://x.com/messages/1-3')privateClock=31001;
  }});
  assert.equal(partialPrivate.events.length,1);assert.equal(partialPrivate.events[0].platformId,'dm201');assert.ok(partialPrivate.diagnostics.some(d=>d.code==='private-collection-deadline'&&d.status==='partial'));assert.equal(privateNavigations.length,4);assert.ok(privateNavigations.includes('https://x.com/messages/1-3'));assert.ok(!privateNavigations.includes('https://x.com/messages/1-4'));assert.equal(partialPrivate.events.some(event=>event.platformId==='dm202'),false);checks('私信采集真实循环：首会话保留，第二会话导航耗尽预算后不解析、不开始第三会话', {syntheticDOM:true,events:partialPrivate.events.length,navigations:privateNavigations.length});
 }finally{await page.unroute('https://x.com/**');}
 let peerFixture='';await page.route('https://x.com/**',route=>route.fulfill({contentType:'text/html',body:peerFixture}));
 for(const native of [false,true])for(const [handles,expected] of [[['alice'],'alice'],[['alice','bob'],undefined],[[],undefined],[['fixture_worker'],undefined]]){
  const header='<header data-testid="dm-conversation-header">'+handles.map(handle=>'<a href="/'+handle+'">@'+handle+'</a>').join('')+'</header>',body='<article><a href="/untrusted_body">@untrusted_body</a></article>';
  peerFixture=native?'<div data-testid="xchatEmbedRoute"></div><script>document.querySelector("div").attachShadow({mode:"open"}).innerHTML='+JSON.stringify(header+body)+'</script>':header+body;
  await page.goto('https://x.com/'+(native?'i/chat/':'messages/')+'111-222?case='+Math.random(),{waitUntil:'domcontentloaded'});const before=page.url(),peer=await readPrivatePeer(page,'111-222','fixture_worker');assert.equal(peer.peerHandle,expected);assert.equal(peer.code,expected?'private-peer-verified':handles.length>1?'private-peer-ambiguous':'private-peer-unverified');assert.equal(page.url(),before);
 }
 await page.unroute('https://x.com/**');checks('旧版与原生shadow私信头部：唯一、多个、缺失、自己handle八种DOM，只读且不读取正文链接',{syntheticDOM:true,cases:8});
 assert.ok(requests.length>=3);assert.ok(requests.every(url=>url==='/profile-fixture'||url==='/favicon.ico'));checks('网络只访问隔离localhost；所有外部页面请求被拒绝', {localRequests:requests.length,blockedExternalRequests:blocked.length});
}catch(error){output.errors.push(String(error?.stack||error));process.exitCode=1;}
finally{
 if(context)await context.close().catch(()=>{});await new Promise(resolve=>server.close(()=>resolve()));
 if(xvfb){xvfb.kill('SIGTERM');await Promise.race([once(xvfb,'exit').catch(()=>{}),delay(2000)]);if(xvfb.exitCode===null)xvfb.kill('SIGKILL');}
 rmSync(temporary,{recursive:true,force:true});output.temporaryProfileRemoved=!existsSync(temporary);output.passed=output.checks.length;output.failed=output.errors.length;
 writeFileSync(artifactDir+'/browser-health-acceptance.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output));
}
