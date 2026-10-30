// 仅服务器隔离验收：真实 Camoufox → Fastify broker → BrowserTransport。
// 必须由 --network none 的临时容器执行；全部 X 页面由路由合成，不使用生产 profile 或模型。
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {Camoufox,getRandomPreset} from '/opt/role-camoufox/node_modules/camoufox/dist/index.js';
import {startBrowserServer} from '../dist/browser.js';
import {BrowserTransport} from '../dist/transport.js';

const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const root=mkdtempSync(tmpdir()+'/browser-round-recovery-');
const actor='fixture_worker',self='222',conversation='111-222',legacyId='legacy-reviewed-fixture';
const orphanId='orphan-receipt-like-fixture';
const incoming='11111111-1111-4111-8111-111111111111',outgoing='22222222-2222-4222-8222-222222222222';
const fixtureTime=Date.now()-60000;
const sha=value=>createHash('sha256').update(value).digest('hex');
const previous=new Map(['SECRETS_DIR','PROFILE_DIR','DATA_DIR','BROWSER_PORT'].map(key=>[key,process.env[key]]));
const selection=process.env.ROUND_RECOVERY_CASE;
if(selection!==undefined&&!/^[1-7]$/.test(selection))throw Error('ROUND_RECOVERY_CASE仅接受1至7');
const fixturePreferences={'dom.ipc.processCount':1,'dom.ipc.processCount.webIsolated':1,'dom.ipc.processPrelaunch.enabled':false,'fission.autostart':false};
const report={evidence:'真实隔离 Camoufox 156 持久上下文、临时profile、Fastify HTTP broker、BrowserTransport；仅夹具使用无头限进程配置，X DOM与React机器字段为合成，未调用模型或平台外网',runtimeConfiguration:{productionLaunchUsed:false,headless:true,xvfbUsed:false,persistentContext:true,mainWorldEval:true,firefoxUserPrefs:fixturePreferences},platformNetworkUsed:false,realModelUsed:false,productionProfileUsed:false,selectedCase:selection?Number(selection):null,skipped:[],checks:[],errors:[]};
const resources=new Set(),liveContexts=new Set();let sequence=0,declaredCases=0;
const persist=()=>writeFileSync(OUT+'/browser-round-recovery-dom.json',JSON.stringify({...report,passed:report.checks.length,failed:report.errors.length},null,2));
const scalar=value=>value===null||['number','boolean','undefined'].includes(typeof value)?value:typeof value==='string'&&/^[A-Za-z0-9_-]{0,100}$/.test(value)?value:{type:Array.isArray(value)?'array':typeof value,...(typeof value==='string'||Array.isArray(value)?{length:value.length}:{})};
const errorCode=error=>({code:String(error?.diagnostic?.code??error?.code??error?.name??'unknown-error').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,100),stage:typeof error?.diagnostic?.stage==='string'?error.diagnostic.stage:null,...(error?.code==='ERR_ASSERTION'?{operator:scalar(error.operator),actual:scalar(error.actual),expected:scalar(error.expected),assertionLine:Number(String(error.stack??'').match(/browser-round-recovery-dom\.mjs:(\d+):\d+/)?.[1]??0)}:{})});
const roundOptions={unsettledOutbox:false,reviewedUnknownOutboxIds:[legacyId]};

async function launchFixtureContext(profile){
 mkdirSync('/tmp/role-camoufox-fontconfig',{recursive:true,mode:0o700});mkdirSync(profile,{recursive:true,mode:0o700});
 const presetPath=profile+'/device-preset.json';let preset;
 try{preset=JSON.parse(readFileSync(presetPath,'utf8'));if(!preset||typeof preset!=='object'||Array.isArray(preset))throw Error('隔离设备预设无效');}
 catch(error){if(error?.code!=='ENOENT')throw error;preset=getRandomPreset('linux','156');if(!preset)throw Error('隔离Camoufox缺少156设备预设');const temporary=presetPath+'.tmp';writeFileSync(temporary,JSON.stringify(preset),{mode:0o600});renameSync(temporary,presetPath);}
 return Camoufox({persistent_context:true,main_world_eval:true,user_data_dir:profile,headless:true,os:'linux',fingerprint_preset:preset,window:[1440,900],viewport:null,locale:'en-US',exclude_addons:['UBO'],firefox_user_prefs:fixturePreferences});
}

function shell(content,script=''){
 return '<!doctype html><html><meta charset="utf-8"><body><nav><a data-testid="AppTabBar_Profile_Link" href="/'+actor+'">Fixture profile</a></nav>'+content+'<script>'+script+'</script></body></html>';
}

function chatHTML(path,locked,replaceHistory=false,delayedHydration=false){
 const inbox='<main><section data-testid="dm-inbox-panel"><header data-testid="dm-inbox-header"><button id="fixture-inbox-menu" data-testid="dm-inbox-dropdown-trigger" aria-haspopup="menu" aria-expanded="false">All</button><input type="search" aria-label="Search"></header><div role="listbox" aria-label="Conversations"><div data-testid="dm-conversation-item-111:222"><a id="dm-conversation-option-111:222" role="option" href="/i/chat/111-222">Accepted fixture conversation</a></div><a href="/i/chat/requests">Requests</a><a href="/i/chat/other">Other</a></div></section></main>';
 const requests='<main><section data-testid="dm-inbox-panel"><section data-testid="dm-message-requests"><div data-testid="dm-message-requests-empty"><h2>No message requests</h2><p>You don’t have any message requests from accounts in your network</p></div><button data-testid="dm-message-requests-other-button">Other</button></section></section></main>';
 const other='<main><section data-testid="dm-inbox-panel"><section data-testid="dm-message-requests"><header><button data-testid="dm-message-requests-back" aria-label="Back"><svg aria-hidden="true"></svg></button><div>Other</div></header><div data-testid="dm-message-requests-empty"><div><svg aria-hidden="true"></svg></div><div><div>No hidden requests</div><div>Message requests from outside of your network, or potentially containing spam</div></div></div></section></section></main>';
 const accepted='<main><section data-testid="dm-conversation-panel"><div role="log" aria-label="Messages" data-testid="dm-message-scroller" style="height:400px;overflow:auto"></div><footer><textarea aria-label="Message" data-testid="fixture-recovery-editor"></textarea></footer></section></main>';
 const lock='<main><section data-testid="dm-conversation-panel"><label>Enter passcode<input type="password" aria-label="Enter passcode" data-testid="fixture-lock"></label></section></main>';
 const markup=path==='/i/chat'?inbox:path==='/i/chat/requests'?requests:path==='/i/chat/requests/other'?other:locked?lock:accepted;
 return shell('<div data-testid="xchatEmbedRoute"></div>',`
${replaceHistory?'history.replaceState(null,"",'+JSON.stringify(path)+');':''}
const root=document.querySelector('[data-testid="xchatEmbedRoute"]').attachShadow({mode:'open'});root.innerHTML=${JSON.stringify(markup)};
if(${JSON.stringify(path)}==='/i/chat'){
 const trigger=root.querySelector('[data-testid="dm-inbox-dropdown-trigger"]');
 trigger.onclick=()=>{trigger.setAttribute('aria-expanded','true');const menu=document.createElement('div');menu.setAttribute('role','menu');menu.setAttribute('aria-labelledby','fixture-inbox-menu');menu.setAttribute('data-testid','dm-inbox-dropdown-content');menu.innerHTML='<div role="menuitemradio" data-testid="dm-inbox-dropdown-requests">Requests</div>';menu.firstChild.onclick=()=>location.href='/i/chat/requests';root.append(menu);};
}
const otherButton=root.querySelector('[data-testid="dm-message-requests-other-button"]');if(otherButton)otherButton.onclick=()=>location.href='/i/chat/requests/other';
const log=root.querySelector('[role="log"]');if(log){
 const hydration=${delayedHydration}?{startedAt:Date.now(),incomingReadyAfterMs:null,editorReadyAfterMs:null}:null;
 const editor=root.querySelector('[data-testid="fixture-recovery-editor"]');if(hydration)editor.disabled=true;
 const add=(id,kind,text,uid,sequence,milliseconds)=>{
  const row=document.createElement('div');row.setAttribute('data-dm-message-row',id);row.setAttribute('data-testid','message-'+id);row.setAttribute('data-send-status','sent');
  row.innerHTML='<div role="article" data-dm-message-focus-target="'+id+':content" aria-labelledby="'+id+'-sender '+id+'-time" aria-describedby="'+id+'-content"><span hidden id="'+id+'-sender">'+(uid==='222'?'You':'Fixture peer')+'</span><span hidden id="'+id+'-time">2:35 PM</span><div id="'+id+'-content" data-testid="message-text-'+id+'"><span dir="auto"></span></div></div>';
  row.querySelector('span[dir]').textContent=text;
  const created={epochSeconds:Math.floor(milliseconds/1000),nanosecondsOfSecond:milliseconds%1000*1000000};
  const item={id,created,senderInfo:{userId:{userId:BigInt(uid)}},textContent:text,fullText:text,sequenceNumber:{num:BigInt(sequence)},messageInfo:{showTimestamp:created},contentType:kind,isTextOnly:true,isTruncated:false,isUndecryptable:false};
  const bind=()=>{row.__reactFiber$fixture={memoizedProps:{messageItem:item,isOneToOne:true},return:{memoizedProps:{chatItem:item}}};};
  log.append(row);
  if(hydration&&id==='${incoming}')setTimeout(()=>{bind();hydration.incomingReadyAfterMs=Date.now()-hydration.startedAt;},6000);else bind();
  return row;
 };
 const first=add('${incoming}','ReceivedMessageTextOnly','合成历史来言，不应写入日志正文','111','123456',${fixtureTime});
 const last=add('${outgoing}','SentMessageTextOnly','合成已确认历史回复，不得再次提交','222','123457',${fixtureTime+1000});
 if(hydration){
  Object.assign(hydration,{initialRows:log.querySelectorAll('[data-dm-message-row]').length,rowsInitiallyVisible:[first,last].every(row=>row.getClientRects().length>0),editorInitiallyVisible:editor.getClientRects().length>0,incomingInitiallyBound:Object.keys(first).some(key=>key.startsWith('__reactFiber$')),outgoingInitiallyBound:Object.keys(last).some(key=>key.startsWith('__reactFiber$')),editorInitiallyDisabled:editor.disabled,lockInputs:root.querySelectorAll('input[type="password"]').length});window.__fixtureRecoveryHydration=hydration;
  setTimeout(()=>{editor.disabled=false;hydration.editorReadyAfterMs=Date.now()-hydration.startedAt;},9000);
 }
}
`);
}

async function createFixture({lockedAfterRestart=false,newUnknown=false,orphanUnknown=false,delayedAfterRestart=false}={}){
 const directory=root+'/case-'+(++sequence);for(const child of ['secrets','profile','data'])mkdirSync(directory+'/'+child,{recursive:true});
 const secret='round-recovery-isolated-fixture-key';
 writeFileSync(directory+'/secrets/browser_key',secret,{mode:0o600});
 Object.assign(process.env,{SECRETS_DIR:directory+'/secrets',PROFILE_DIR:directory+'/profile',DATA_DIR:directory+'/data',BROWSER_PORT:'0'});
 const journalPath=directory+'/profile/transport-journal.json';
 const intent=(target,at)=>({kind:'reply',handle:actor,targetId:target,textHash:sha('合成冻结公开回复'),at,receipt:{status:'unknown',reason:'合成原未知意图，仅核对完整保留'}});
 const entries={[legacyId]:intent('7001',Date.now()-1000)};if(newUnknown)entries['new-unreviewed-fixture']=intent('7002',Date.now()-500);
 if(orphanUnknown)entries[orphanId]={...intent('7003',Date.now()-400),handle:'',receipt:{status:'unknown',id:'8003',url:'https://x.com/'+actor+'/status/8003'}};
 writeFileSync(journalPath,JSON.stringify(entries),{mode:0o600});
 const journalHash=sha(readFileSync(journalPath));
 const state={clock:Date.now(),memoryRatio:.82,launches:0,closes:0,contexts:[],requests:[],externalRequests:[],formWrites:0,sendActions:0,acceptActions:0,platformWrites:0};
 const broker=await startBrowserServer({clock:()=>state.clock,readMemory:()=>({bytes:Math.round(state.memoryRatio*2147483648),limitBytes:2147483648,ratio:state.memoryRatio,source:'cgroup'}),launch:async()=>{
  assert.equal(liveContexts.size,0,'前一持久上下文必须完整退出后才能启动下一引擎');
  const generation=++state.launches;if(generation>1)state.memoryRatio=.2;
  // 持久context关闭会结束整个Firefox；无头和限进程prefs仅用于此隔离fixture。
  const context=await launchFixtureContext(directory+'/profile/camoufox');liveContexts.add(context);
  const originalClose=context.close.bind(context);let closing;
  context.close=(...args)=>closing??=(async()=>{try{await originalClose(...args);liveContexts.delete(context);}catch(error){closing=undefined;throw error;}})();
  state.contexts.push(context);context.on('close',()=>state.closes++);
  if(generation===1)await context.addCookies([{name:'twid',value:'u%3D'+self,domain:'.x.com',path:'/',secure:true,httpOnly:true,expires:Math.floor(Date.now()/1000)+86400}]);
  else assert.ok((await context.cookies('https://x.com')).some(cookie=>cookie.name==='twid'&&cookie.value==='u%3D'+self),'重启必须从同一隔离profile恢复合成身份，不得重新注入');
  await context.exposeBinding('__fixtureRecoveryAction',(_source,kind)=>{if(kind==='form')state.formWrites++;else if(kind==='send')state.sendActions++;else if(kind==='accept')state.acceptActions++;});
  await context.addInitScript(()=>{
   window.addEventListener('input',event=>{const node=event.composedPath()[0];if(node instanceof HTMLTextAreaElement||node instanceof HTMLInputElement&&node.type==='password'||node instanceof HTMLElement&&node.isContentEditable)void window.__fixtureRecoveryAction('form');},true);
   window.addEventListener('submit',()=>{void window.__fixtureRecoveryAction('send');},true);
   window.addEventListener('click',event=>{const first=event.composedPath()[0],button=first instanceof Element?first.closest('button'):null;if(!button)return;if(button.matches('[aria-label="Send"],[data-testid="tweetButton"],[data-testid="dmComposerSendButton"]'))void window.__fixtureRecoveryAction('send');if(button.matches('[data-testid="dm-message-request-accept-button"],[data-testid="dm-message-request-delete-button"]'))void window.__fixtureRecoveryAction('accept');},true);
  });
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!=='https://x.com'){state.externalRequests.push({origin:url.origin,path:url.pathname});return route.abort();}
   state.requests.push({generation,path:url.pathname,method:request.method()});
   if(request.method()!=='GET'){state.platformWrites++;return route.abort();}
   const gate=state.canonicalGate;
   if(gate&&!gate.entered&&generation===1&&url.pathname==='/i/chat/'+conversation){gate.entered=true;gate.arrive();await gate.wait;}
   if(url.pathname==='/favicon.ico')return route.fulfill({status:204,body:''});
   // 合成302的后续请求可能绕过Playwright路由；隔离夹具用200规范化历史地址，避免访问外网。
   // 保留正常采集入口和请求路径；这是fixture拦截约束，不表示真实平台重定向有误。
   const canonicalPath=url.pathname==='/messages'?'/i/chat':url.pathname==='/i/chat/other'?'/i/chat/requests/other':null;
   if(canonicalPath)return route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'cache-control':'no-store'},body:chatHTML(canonicalPath,false,true)});
   if(url.pathname==='/home')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:shell('<main><div data-testid="emptyState">No posts</div></main>')});
   if(['/i/chat','/i/chat/requests','/i/chat/requests/other','/i/chat/'+conversation].includes(url.pathname)){
    const delayed=delayedAfterRestart&&generation>1&&url.pathname==='/i/chat/'+conversation&&!state.delayedHydrationServed;
    if(delayed)state.delayedHydrationServed=true;
    return route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'cache-control':'no-store'},body:chatHTML(url.pathname,lockedAfterRestart&&generation>1,false,delayed)});
   }
   state.externalRequests.push({origin:url.origin,path:url.pathname});return route.abort();
  });
  return context;
 }});
 const endpoint='http://127.0.0.1:'+broker.app.server.address().port;
 const transport=new BrowserTransport(endpoint,secret,()=>({memoryRatio:.75,browserMaxAgeHours:24,publicCollectionSeconds:10,privateCollectionSeconds:15,rpcTimeoutSeconds:50}));
 const fixture={broker,transport,state,journalHash,endpoint,finishOptions:{...roundOptions,roundId:randomUUID()},
  advance:()=>{state.clock+=31000;},
  unchanged:()=>assert.equal(sha(readFileSync(journalPath)),journalHash,'重启和验证不得改写未知发送 journal'),
  zeroEffects:()=>{assert.equal(state.formWrites,0);assert.equal(state.sendActions,0);assert.equal(state.acceptActions,0);assert.equal(state.platformWrites,0);assert.equal(state.externalRequests.length,0);},
  close:async()=>{await broker.app.close();resources.delete(fixture);},
 };
 resources.add(fixture);await transport.control('auto');return fixture;
}

async function collectAccepted(fixture){
 fixture.state.phase='collect-private-http';
 const result=await fixture.transport.collectPrivate(actor);
 fixture.state.collectionProof={events:Array.isArray(result.events)?result.events.length:null,requests:Array.isArray(result.requests)?result.requests.length:null,acceptances:Array.isArray(result.privateAcceptances)?result.privateAcceptances.length:null,chatProtection:result.chatProtection?{hasUnlockedSession:result.chatProtection.hasUnlockedSession,unlockPending:result.chatProtection.unlockPending,needsHuman:result.chatProtection.needsHuman}:null,diagnostics:(result.diagnostics??[]).map(row=>({source:row.source,status:row.status,code:row.code})),observations:(result.observations??[]).map(row=>({contract:row.contract,messageCount:row.messageCount,outgoing:row.outgoing,unknownDirection:row.unknownDirection,queueable:row.queueable,blockedCodes:row.blockedCodes,composerState:row.composer?.state})),pageStates:(result.pageStates??[]).map(row=>({source:row.source,state:row.state,code:row.code,contract:row.contract,lockInputs:row.lockInputs,messageRows:row.messageRows,validConversations:row.validConversations,loading:row.loading,traversalTruncated:row.traversalTruncated}))};
 fixture.state.phase='collect-observation-present';
 const observed=result.observations?.find(row=>row.conversationId===conversation);
 assert.ok(observed,'正常私信采集必须取得同一已接受会话的实际观察结果');
 assert.equal(observed.contract,'xchat-native-v2');assert.equal(observed.composer?.state,'ready');
 assert.equal(observed.messageCount,2);assert.equal(observed.outgoing,1);assert.equal(observed.unknownDirection,0);assert.deepEqual(observed.blockedCodes,[]);
 assert.equal(result.events.length,0,'最后一条为本人出站，不得排入新回复');assert.equal(result.requests.length,0);
 assert.equal(result.chatProtection.hasUnlockedSession,true);assert.equal(result.chatProtection.needsHuman,false);
 assert.ok(result.privateAcceptances.some(item=>item.conversationId===conversation&&item.status==='accepted'));
 fixture.zeroEffects();fixture.unchanged();return observed;
}

async function check(name,options,fn){
 const caseNumber=++declaredCases;if(selection&&caseNumber!==Number(selection)){report.skipped.push({caseNumber,name});return;}
 let fixture;const started=Date.now();console.log('[开始] '+name);
 try{fixture=await createFixture(options);const detail=await fn(fixture);fixture.zeroEffects();fixture.unchanged();report.checks.push({caseNumber,name,roundId:fixture.finishOptions.roundId,durationMs:Date.now()-started,launches:fixture.state.launches,maintenanceCloses:fixture.state.closes,journalUnchanged:true,formWrites:0,sendActions:0,acceptActions:0,platformWrites:0,externalRequests:0,...(detail?{detail}:{})});console.log('[通过] '+name);}
 catch(error){const safe=errorCode(error);report.errors.push({caseNumber,name,...safe,...(fixture?{phase:fixture.state.phase??null,collectionProof:fixture.state.collectionProof??null,launches:fixture.state.launches,closes:fixture.state.closes,formWrites:fixture.state.formWrites,sendActions:fixture.state.sendActions,acceptActions:fixture.state.acceptActions,platformWrites:fixture.state.platformWrites}:{} )});console.log('[失败] '+name+' '+safe.code);}
 finally{if(fixture)await fixture.close().catch(()=>{});persist();}
}

try{
 await check('持续压力只在采集完成后的finish恢复一次，旧封存journal与原Chat保持可读',{},async f=>{
  assert.equal((await fetch(f.endpoint+'/health')).status,401);
  const first=f.broker.context;await f.transport.prepareRound(actor,roundOptions);f.advance();await f.transport.prepareRound(actor,roundOptions);
  assert.equal(f.state.launches,1);assert.equal(f.state.closes,0,'轮首不得关闭现有上下文');
  await collectAccepted(f);
  const health=await f.transport.finishRound(actor,f.finishOptions);
  assert.equal(f.state.launches,2);assert.equal(f.state.closes,1);assert.notEqual(f.broker.context,first,'context getter应返回恢复后的真实上下文');
  assert.equal(health.restarts,1);assert.equal(health.lastRestartStage,'completed');assert.equal(health.lastRestartFailureCode,null);assert.equal((await f.transport.health()).mode,'auto');
  assert.ok(f.state.requests.some(request=>request.generation===2&&request.path==='/i/chat/'+conversation),'finish返回前必须实际重开原Chat验证');
  const identity=await f.transport.identity();assert.equal(identity.handle,actor);assert.equal(identity.userId,self);assert.equal(identity.needsHuman,false);
  const event={id:'fixture-known-incoming',platformId:incoming,targetId:conversation,channel:'private',userId:'dm:'+conversation,handle:'',text:'合成历史来言，不应写入日志正文',url:'https://x.com/i/chat/'+conversation,conversationId:conversation,timestamp:fixtureTime,timestampReliable:true,privateContract:'xchat-native-v2'};
  const rows=JSON.parse(await f.transport.context(event,actor));assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.id),[incoming,outgoing]);assert.ok(rows.every(row=>row.contract==='xchat-native-v2'&&row.timestampReliable&&row.blockedCodes.length===0));
  await collectAccepted(f);assert.equal((await f.transport.health()).mode,'auto');assert.equal(f.state.launches,2);assert.equal(f.state.closes,1);
  // 再次出现压力也不能把同一个已完成轮次当成新恢复机会。
  f.state.memoryRatio=.82;f.advance();const repeated=await f.transport.finishRound(actor,f.finishOptions);
  assert.equal(repeated.restarts,health.restarts);assert.equal(repeated.lastRestartAt,health.lastRestartAt);assert.equal(f.state.launches,2);assert.equal(f.state.closes,1);
  const uppercaseReplay=await f.transport.finishRound(actor,{...f.finishOptions,roundId:f.finishOptions.roundId.toUpperCase()});
  assert.equal(uppercaseReplay.duplicate,true);assert.equal(uppercaseReplay.restarts,health.restarts);assert.equal(uppercaseReplay.lastRestartAt,health.lastRestartAt);assert.equal(f.state.launches,2);assert.equal(f.state.closes,1);
  return {normalPrivateCollection:true,originalConversationVerified:true,persistentIdentityRestoredWithoutInjection:true,autoModePreservedAndCollectionContinued:true,sameRoundReplayedWithoutRecovery:true,uppercaseRoundReplayedWithoutRecovery:true,additionalSubmissionCount:0};
 });
 await check('压力在完整私信采集后消退则不恢复，暂停控制也不被轮末请求改回',{},async f=>{
  await f.transport.prepareRound(actor,roundOptions);f.advance();await collectAccepted(f);f.state.memoryRatio=.5;
  const health=await f.transport.finishRound(actor,f.finishOptions);assert.equal(health.restarts,0);assert.equal(f.state.launches,1);assert.equal(f.state.closes,0);
  await f.transport.finishRound(actor,f.finishOptions);assert.equal(f.state.launches,1);assert.equal(f.state.closes,0);
  await f.transport.control('paused');await assert.rejects(f.transport.finishRound(actor,{...f.finishOptions,roundId:randomUUID()}),error=>error.browserPaused===true);
  assert.equal((await f.transport.health()).mode,'paused');assert.equal(f.state.launches,1);assert.equal(f.state.closes,0);
  return {pressureRecheckedAtBoundary:true,pausedPreserved:true};
 });
 await check('浏览器journal中的新unknown不在精确封存名单时始终阻止轮末恢复',{newUnknown:true},async f=>{
  await f.transport.prepareRound(actor,roundOptions);f.advance();await collectAccepted(f);
  const health=await f.transport.finishRound(actor,f.finishOptions);
  assert.equal(health.restarts,0);assert.equal(f.state.launches,1);assert.equal(f.state.closes,0);assert.ok(health.protectedReasons.includes('unsettled-outbox'));assert.equal(health.recoveryDeferredReason,'protected-session');
  await f.transport.finishRound(actor,f.finishOptions);assert.equal(f.state.launches,1);assert.equal(f.state.closes,0);
  return {callerReportedNoNewUnknown:true,browserJournalIndependentlyBlocked:true};
 });
 await check('无账号且带旧回执外形的orphan未知意图即使被列为review也不能解除硬保护',{orphanUnknown:true},async f=>{
  const listed={...f.finishOptions,reviewedUnknownOutboxIds:[legacyId,orphanId]};
  await f.transport.prepareRound(actor,{...roundOptions,reviewedUnknownOutboxIds:listed.reviewedUnknownOutboxIds});f.advance();await collectAccepted(f);
  const health=await f.transport.finishRound(actor,listed);
  assert.equal(health.restarts,0);assert.equal(f.state.launches,1);assert.equal(f.state.closes,0);assert.ok(health.protectedReasons.includes('unsettled-outbox'));assert.equal(health.recoveryDeferredReason,'protected-session');
  await f.transport.finishRound(actor,listed);assert.equal(f.state.launches,1);assert.equal(f.state.closes,0);
  return {orphanHandleEmpty:true,receiptLikeIdAndUrlPresent:true,callerListedOrphanAsReviewed:true,invalidBindingStillBlocked:true};
 });
 await check('恢复后首页仍登录但Chat重新锁住时明确暂停，后续请求不能再次自动重启',{lockedAfterRestart:true},async f=>{
  await f.transport.prepareRound(actor,roundOptions);f.advance();await collectAccepted(f);
  let initialFailure;await assert.rejects(f.transport.finishRound(actor,f.finishOptions),error=>{initialFailure=errorCode(error);return error.browserPaused===true;});
  assert.equal(f.state.launches,2);assert.equal(f.state.closes,1);
  const health=await f.transport.health();assert.equal(health.mode,'paused');assert.ok(health.restartError);assert.equal(health.lastRestartFailureCode,'chat-recovery-unverified');
  const identity=await f.transport.identity();assert.equal(identity.handle,actor);assert.equal(identity.loggedIn,true);
  await assert.rejects(f.transport.finishRound(actor,f.finishOptions),error=>{assert.deepEqual(errorCode(error),initialFailure,'同一轮次重试应返回原固定失败');return error.browserPaused===true;});
  await assert.rejects(f.transport.finishRound(actor,{...f.finishOptions,roundId:randomUUID()}),error=>error.browserPaused===true);await assert.rejects(f.transport.prepareRound(actor,roundOptions),error=>error.browserPaused===true);
  assert.equal(f.state.launches,2);assert.equal(f.state.closes,1);
  return {homepageLoginInsufficient:true,chatReadFailurePaused:true,noAutomaticPasscodeOrSend:true};
 });
 await check('真实finish HTTP取消后等response关闭再释放Chat导航，排队人工控制优先且零重启',{},async f=>{
  await f.transport.prepareRound(actor,roundOptions);f.advance();await collectAccepted(f);
  const originalContext=f.broker.context,controller=new AbortController();
  let enteredResolve,releaseResolve,closedResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;}),release=new Promise(resolve=>{releaseResolve=resolve;}),closed=new Promise(resolve=>{closedResolve=resolve;});
  f.state.canonicalGate={entered:false,arrive:enteredResolve,wait:release};
  let actualResponseClosed=false,responseEndedAtClose;
  const onRequest=(request,response)=>{
   if(request.method!=='POST'||request.url!=='/finish-round')return;
   // 观察真实ServerResponse的close，不读取或消费请求body。
   response.once('close',()=>{actualResponseClosed=true;responseEndedAtClose=response.writableEnded;closedResolve();});
  };
  const within=async(promise,code)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('隔离取消验收等待超时'),{code})),7000);})]);}finally{clearTimeout(timer);}};
  f.broker.app.server.on('request',onRequest);
  const pending=f.transport.finishRound(actor,{...f.finishOptions,signal:controller.signal}).then(value=>({ok:true,value}),error=>({ok:false,error}));
  try{
   await within(entered,'fixture-chat-gate-timeout');
   assert.equal(f.state.closes,0);assert.equal(f.state.launches,1);
   controller.abort();await within(closed,'fixture-http-close-timeout');
   assert.equal(actualResponseClosed,true);assert.equal(responseEndedAtClose,false,'必须是未完成响应的真实取消关闭');
   const cancelled=await within(pending,'fixture-fetch-abort-timeout');assert.equal(cancelled.ok,false);
   // 先确认HTTP已断开，再解除真实页面GET gate并发出会排队的控制请求。
   releaseResolve();const manual=f.transport.control('manual');await within(manual,'fixture-manual-control-timeout');
   const health=await f.transport.health();
   assert.equal(health.mode,'manual');assert.equal(health.restarts,0);assert.equal(health.lastRestartAt,null);
   assert.equal(f.state.launches,1);assert.equal(f.state.closes,0);assert.equal(f.broker.context,originalContext);
   return {finishRequestCancelled:true,serverResponseCloseObserved:true,responseCompletedBeforeClose:false,queuedManualPreserved:true,actualRestartBudgetConsumed:false,lastRestartFailureCode:health.lastRestartFailureCode??null};
  }finally{
   controller.abort();releaseResolve();f.broker.app.server.off('request',onRequest);delete f.state.canonicalGate;
   await pending;
  }
 });
 await check('恢复后旧行机器证据与composer延迟水合仍完整等待，保持auto并自然继续采集',{delayedAfterRestart:true},async f=>{
  await f.transport.prepareRound(actor,roundOptions);f.advance();await collectAccepted(f);
  const originalLog=console.log,verified=[];
  console.log=(...args)=>{
   try{
    if(args.length===1&&typeof args[0]==='string'){
     const row=JSON.parse(args[0]);
     if(row?.event==='browser-chat-recovery-verified'&&row.roundId===f.finishOptions.roundId&&row.stage==='verify-chat'){
      const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
      verified.push({roundId:f.finishOptions.roundId,stage:'verify-chat',checkpointMessages:number(row.checkpointMessages),matchedMessages:number(row.matchedMessages),attempts:number(row.attempts),durationMs:number(row.durationMs)});
     }
    }
   }catch{}
   return originalLog.apply(console,args);
  };
  try{
   const health=await f.transport.finishRound(actor,f.finishOptions);
   assert.equal((await f.transport.health()).mode,'auto');assert.equal(health.restarts,1);assert.equal(health.lastRestartStage,'completed');assert.equal(health.lastRestartFailureCode,null);assert.equal(f.state.launches,2);assert.equal(f.state.closes,1);
   assert.equal(f.state.requests.filter(row=>row.generation===2&&row.path==='/i/chat/'+conversation).length,1,'验证不得重载页面绕过延迟水合');
   const page=f.broker.context.pages().find(page=>page.url()==='https://x.com/i/chat/'+conversation);assert.ok(page);
   const hydration=await page.evaluate('mw:(()=>{const state=window.__fixtureRecoveryHydration;if(!state)return null;const root=document.querySelector(\'[data-testid="xchatEmbedRoute"]\').shadowRoot;return {initialRows:state.initialRows,rowsInitiallyVisible:state.rowsInitiallyVisible,editorInitiallyVisible:state.editorInitiallyVisible,incomingInitiallyBound:state.incomingInitiallyBound,outgoingInitiallyBound:state.outgoingInitiallyBound,editorInitiallyDisabled:state.editorInitiallyDisabled,lockInputs:state.lockInputs,incomingReadyAfterMs:state.incomingReadyAfterMs,editorReadyAfterMs:state.editorReadyAfterMs,editorEnabled:!root.querySelector(\'[data-testid="fixture-recovery-editor"]\').disabled};})()');
   assert.ok(hydration);assert.equal(hydration.initialRows,2);assert.equal(hydration.rowsInitiallyVisible,true);assert.equal(hydration.editorInitiallyVisible,true);assert.equal(hydration.incomingInitiallyBound,false);assert.equal(hydration.outgoingInitiallyBound,true);assert.equal(hydration.editorInitiallyDisabled,true);assert.equal(hydration.lockInputs,0);assert.equal(hydration.editorEnabled,true);assert.ok(hydration.incomingReadyAfterMs>=5900);assert.ok(hydration.editorReadyAfterMs>=8900);
   assert.equal(verified.length,1);const proof=verified[0];assert.ok(Number.isInteger(proof.attempts)&&proof.attempts>=2);assert.ok(proof.durationMs>=5000);assert.ok(proof.checkpointMessages>=1);assert.ok(proof.matchedMessages>=1);
   await collectAccepted(f);assert.equal((await f.transport.health()).mode,'auto');assert.equal(f.state.launches,2);assert.equal(f.state.closes,1);
   return {incomingProofDelayedMs:6000,composerEnableDelayedMs:9000,hydration,verified:proof,normalCollectionContinued:true,additionalSubmissionCount:0};
  }finally{console.log=originalLog;}
 });
}catch(error){report.errors.push({name:'隔离验收初始化',...errorCode(error)});}
finally{
 for(const fixture of resources)await fixture.close().catch(()=>{});
 for(const context of liveContexts)await context.close().catch(()=>{});
 for(const [key,value] of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;
 rmSync(root,{recursive:true,force:true});persist();console.log(JSON.stringify({...report,passed:report.checks.length,failed:report.errors.length}));if(report.errors.length)process.exitCode=1;
}
