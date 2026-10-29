// 服务器 Camoufox：所有 API 与桌面均由合成资料接管，不读取生产账号或模型。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const BASE=process.env.PANEL_URL||'http://127.0.0.1:8083',OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const report={evidence:'服务器 Camoufox + 合成 API；无生产目录、模型或 X 访问',checks:[],errors:[],screenshots:[]},requests=[],pageErrors=[];
const now=Date.now(),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),add=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),control={value:'paused'};
let holdProgramSave=false;const saveWaiters=[];function releaseProgramSave(){holdProgramSave=false;for(const resolve of saveWaiters.splice(0))resolve();}
let programRevision=0,taskRevision=0,policyRevision=0,triageRevision=0,healthRevision=0,modelRevision=0,summaryFailure=false,desktopLoads=0;
let settings={mode:'draft',maxAgeHours:3,maxPerRound:2,publicPerHour:10,privatePerHour:30,publicPerDay:180,privatePerDay:400,replyHours:{enabled:true,closeDelayMinutes:30}},policy={recentCount:3,recentDays:7,retentionDays:30},triage={maxAgeHours:3,batchThreshold:3,advertisingKeywords:['推广'],greetings:['你好'],priorityPublicHandles:['one'],priorityPrivateConversations:[]},health={requiredPhrases:['AI'],softTimeoutMinutes:5,hardTimeoutMinutes:10,publicCollectionSeconds:60,privateCollectionSeconds:60,rpcTimeoutSeconds:90,memoryRatio:.75,browserMaxAgeHours:24};
const taskIds=['main','daily-state','memory-summary','morning-post','evening-post','backup','health','daily-report','account-check'];
const taskNames=['主循环','虚构日程','记忆补整理','早安帖','晚安帖','数据库备份','宿主健康检查','每日日报','账号合规检查'];
const taskTimes={'daily-state':'06:00','memory-summary':'03:00','morning-post':'08:00','evening-post':'23:00',backup:'04:00','daily-report':'09:00','account-check':'10:00'};
let tasks=taskIds.map((id,i)=>({id,title:taskNames[i],enabled:i===1||i===7,...(['main','health'].includes(id)?{intervalSeconds:id==='main'?60:300}:{time:taskTimes[id]||'06:00'}),lastRun:{status:'completed',startedAt:now-3600000,fees:{estimatedUsd:.001}},nextRunAt:now+3600000}));
const users=[{userId:'x:one',label:'@one',accountId:'fixture',channel:'public',identityConfirmed:true,itemCount:1,forgotten:false,lastInteractionAt:now},{userId:'dm:test',label:'私信测试',accountId:'fixture',channel:'private',identityConfirmed:true,itemCount:0,forgotten:false,lastInteractionAt:now-1000}];
let memoryItems=[{id:'memory-1',text:'喜欢散步 <img src=x onerror=alert(1)>',type:'preference',revision:0,sourceStatus:'complete',updatedAt:now,sources:[]}];
const totals={calls:4,input:100,output:100,totalTokens:1000,costUSD:.04840811,unpriced:0,unknown:0},model={id:'fixture-model',active:true,source:'catalog',params:{reasoningLevel:'off'},info:{id:'fixture-model',name:'fixture-model',api:'openai-completions',contextWindow:128000,maxTokens:8192,reasoning:false,vision:false,levels:['off'],costKnown:true,cost:{input:1,output:2}},lastTest:{ok:true,at:now,latencyMs:12}};
const library={version:1,active:{default:{key:'deepseek',modelId:model.id}},providers:[{key:'deepseek',provider:'deepseek',name:'DeepSeek',baseUrl:'https://fixture.example/v1',hasKey:true,keyHint:'••••1234',ready:true,active:true,models:[model]},{key:'custom',provider:'custom',name:'备用接口',baseUrl:'https://backup.example/v1',api:'openai-completions',hasKey:true,keyHint:'••••5678',ready:true,models:[{...model,active:false}]}]};
let richVisual=false;
let windowOverride=null,publicUsed=2;const windowState=()=>windowOverride||({open:true,reason:null,closeTime:String(Math.floor((23*60+settings.replyHours.closeDelayMinutes)%1440/60)).padStart(2,'0')+':'+String(settings.replyHours.closeDelayMinutes%60).padStart(2,'0'),openTime:'08:00',closesAt:now+3600000,opensAt:now,closures:[]});
const summary=()=>({publicToday:2,publicPerDay:180,privateRecent:3,privatePerDay:settings.privatePerDay,queues:[{channel:'public',tier:'normal',count:2,oldestAt:now-3000}],reasons:[{status:'filtered',reason:'广告关键词',count:1}]});
const healthy=()=>({status:'attention',at:now,metrics:[{id:'reply-stall',level:'normal',summary:'回复正常'},{id:'compliance-label',level:'attention',summary:'未标注自动化账号'}],activeAlerts:[],compliance:{checkedAt:now,disclosure:'missing',missingPhrases:['AI'],automatedLabel:'missing',qualityFilter:'on'},browser:null});
const browser=await observer(),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>pageErrors.push(e.stack||String(e)));
await page.route('**/desktop/**',route=>{desktopLoads++;return route.fulfill({contentType:'text/html',body:'<!doctype html><title>合成桌面</title><p>独立验收桌面</p>'});});
await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();let body;try{body=request.postDataJSON();}catch{}requests.push({path,method,body});const send=(json,status=200)=>route.fulfill({status,json});
 if(path==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'retry: 60000\nevent: feed\ndata: {"latest":0,"pending":2}\n\n'});
 if(path==='/api/status')return send({control:control.value,busy:false,accountId:'fixture',browser:{handle:'fixture',loggedIn:true,needsHuman:false},config:{mode:settings.mode,model:{configured:true,id:model.id,provider:'deepseek'}},cooldown:{}});
 if(path.startsWith('/api/control/')){control.value=path.endsWith('/takeover')?'manual':'paused';return send({control:control.value});}
 if(path==='/api/program')return send({control:control.value,revision:programRevision,settings,replyHours:windowState(),limits:{public:{used:publicUsed,limit:10},private:{used:3,limit:30}},stages:[],queue:{items:[],counts:[]},cooldown:{}});
 if(path==='/api/program/settings'){if(holdProgramSave)await new Promise(resolve=>saveWaiters.push(resolve));if(!Number.isInteger(body.settings.privatePerDay)||body.settings.privatePerDay<1||body.settings.privatePerDay>500)return send({error:'额度无效'},400);settings={...settings,...structuredClone(body.settings)};return send({revision:++programRevision,settings});}
 if(path==='/api/account/posting-limits')return send({effective:{post:{limit:280,unit:'weighted-characters'},reply:{limit:280,unit:'weighted-characters'}},post:{status:'unknown',checkedAt:now},reply:{status:'unknown',checkedAt:now}});
 if(path==='/api/account/posting-limits/refresh')return send({ok:true});
 if(path==='/api/tasks')return send({tasks,revision:taskRevision,hostAvailable:true});
 if(path==='/api/tasks/runs')return send({items:[{id:'run-1',taskId:'health',status:'completed',startedAt:now,durationMs:100},{id:'run-2',taskId:'health',status:'completed',startedAt:now-300000,durationMs:140},{id:'run-3',taskId:'daily-state',status:'completed',startedAt:now-600000,durationMs:120,fees:{estimatedUsd:.001}}],counts:richVisual?taskIds.map(task=>({task,total:task==='health'?2:1,failed:0})):[{task:'health',total:2,failed:0},{task:'daily-state',total:1,failed:0}],nextCursor:null});
 if(path==='/api/tasks/runs/run-3')return send({run:{id:'run-3',taskId:'daily-state',status:'completed',durationMs:120},calls:[{purpose:'daily-state',model:model.id,usage:{totalTokens:100},cost:{total:.001}}]});
 if(path.startsWith('/api/tasks/')){const id=path.split('/')[3];if(method==='PUT'){if(id==='main')assert.equal('enabled'in body,false);const task=tasks.find(t=>t.id===id);Object.assign(task,body);return send({revision:++taskRevision,tasks});}return send({run:{status:'completed'}});}
 if(path==='/api/triage/summary')return send(summary());
 if(path==='/api/triage/ignores')return send({items:[]});
 if(path==='/api/triage/settings'){if(method==='GET')return send({settings:{...triage,maxAgeHours:settings.maxAgeHours},maxAgeHours:settings.maxAgeHours,programRevision,revision:triageRevision});const {maxAgeHours,...rest}=body.settings||{};triage={...triage,...rest};if(maxAgeHours!==undefined){settings.maxAgeHours=Number(maxAgeHours);programRevision++;}return send({settings:{...triage,maxAgeHours:settings.maxAgeHours},maxAgeHours:settings.maxAgeHours,programRevision,revision:++triageRevision});}
 if(path==='/api/memory/policy'){if(method==='GET')return send({policy,revision:policyRevision});policy=body.policy;return send({revision:++policyRevision});}
 if(path==='/api/memory/users')return send({users,nextCursor:null});
 if(path.startsWith('/api/memory/users/')){const id=decodeURIComponent(path.split('/')[4]),user=users.find(u=>u.userId===id)||users[0];if(method==='GET')return send({...user,items:user.channel==='public'?memoryItems:[],recent:[],experiences:[],progress:{}});const action=path.split('/').at(-1);if(action==='forget')user.forgotten=true;if(action==='remember')user.forgotten=false;return send({written:action==='summarize',items:memoryItems});}
 if(path.startsWith('/api/memory/items/')){if(method==='DELETE')memoryItems=[];else Object.assign(memoryItems[0],{text:body.text,revision:memoryItems[0].revision+1});return send({ok:true});}
 if(path==='/api/memory/experiences')return send({accountId:'fixture',items:[],revision:0,nextCursor:null});
 if(path==='/api/model'){
 const richLibrary={...library,providers:library.providers.map((p,i)=>i?p:{...p,starred:[model.id,'layout-model-01','layout-model-02'],models:[model,...Array.from({length:29},(_,n)=>({...model,id:'layout-model-'+String(n+1).padStart(2,'0'),active:false,lastUsedAt:n<5?now-n*1000:null,info:{...model.info,reasoning:n%2===0,vision:n%3===0}}))]})};
 return send({library:{...(richVisual?richLibrary:library),revision:modelRevision},revision:modelRevision});
}
 if(path==='/api/model/providers')return send([{id:'deepseek',name:'DeepSeek',group:'cn',baseUrl:'https://fixture.example/v1',available:true,apis:['openai-completions']},{id:'anthropic',name:'Anthropic',group:'intl',available:true,baseUrl:'https://anthropic.example',apis:['anthropic-messages']}]);
 if(path.startsWith('/api/model/')){modelRevision++;return send({library:{...library,revision:modelRevision},revision:modelRevision});}
 if(path==='/api/health'){
 const data=healthy();
 if(richVisual){const ids=['send-stall','reply-stall','reply-hours','round-failures','watchdog-failure','collection-public','collection-private','collection-failures','cooldown-public','cooldown-private','automation-public','automation-private','browser-human','browser-recovery','browser-resource-pressure','account-restricted','backup-failure','certificate-expiry'];data.metrics=[...ids.map(id=>({id,level:'normal',summary:'合成正常状态'})),...data.metrics.filter(m=>m.level!=='normal')];}
 return summaryFailure?send({error:'合成摘要故障'},503):send(data);
}
 if(path==='/api/health/alerts')return send({items:[],nextCursor:null});
 if(path==='/api/health/reports')return send({items:[{date:day,model:{calls:4,totalTokens:1000,costUSD:.04,unpriced:0,unknown:0},channels:{public:{received:4,replied:2,skipped:1,failed:0,unknown:0},private:{received:0,replied:0,skipped:0,failed:0,unknown:0}},responseLatencyMs:{median:100,p90:200},alerts:1,automationBlocks:0,browserRestarts:0,pausedMs:1000}]});
 if(path==='/api/health/settings'){if(method==='GET')return send({settings:health,revision:healthRevision});const{revision,...value}=body;health=value;return send({revision:++healthRevision});}
 if(path==='/api/collection/sources')return send({sources:[{id:'mentions',label:'公开提及',enabled:true,reason:'只读采集已验证'},{id:'notifications-all',label:'通知全部',enabled:false,status:'awaiting-samples',reason:'等待真实样本'}]});
 if(path==='/api/program/logs')return send({items:[{id:1,at:now,level:'info',event:'model-library-refresh',detail:JSON.stringify({provider:'deepseek'})},{id:2,at:now-86400000,level:'warn',event:'browser-restart',detail:'重启完成'}],nextCursor:null});
 if(path==='/api/billing/activity')return send({range:{from:add(day,-363),to:add(day,1),weeks:52},daily:[{date:day,...totals}],totals,peakDailyTokens:1000,last7:{cache:{ratio:.4},reply:{averageCostUSD:.0002454}}});
 if(path==='/api/billing/summary')return send({totals,daily:[{date:day,...totals}],dailyModels:[{date:day,provider:'fixture',model:model.id,...totals}],models:[{provider:'fixture',model:model.id,...totals}],purposes:[{purpose:'chat-test',...totals}],cache:{ratio:.4}});
 if(path==='/api/billing/calls')return send({items:[{id:'call-1',purpose:'chat-test',status:'completed',startedAt:now,provider:'fixture',model:model.id,usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20},cost:{total:.001},pricingStatus:'priced',source:'chat-test:reply'}],nextCursor:null});
 if(path==='/api/feed'||path==='/api/feed/conversations')return send({items:[],pending:2,nextCursor:null});
 return send({error:'未定义合成接口 '+path},404);
});
function persist(){writeFileSync(OUT+'/settings-workspace-ui-acceptance.json',JSON.stringify(report,null,2));}
async function check(name,fn){report.inProgress=name;console.log('[开始] '+name);persist();try{await fn();report.checks.push(name);console.log('[通过] '+name);}catch(error){releaseProgramSave();let ui;try{ui=await page.evaluate(()=>({hash:location.hash,notice:document.querySelector('#notice')?.textContent,controls:[...document.querySelectorAll('button,input')].filter(e=>e.getClientRects().length).map(e=>({id:e.id,text:e.textContent,value:e.value,checked:e.checked,disabled:e.disabled})),confirms:[...document.querySelectorAll('.confirm')].map(e=>({text:e.textContent,hidden:e.hidden}))}));}catch{}report.errors.push({name,error:error.stack||String(error),ui});console.log('[失败] '+name+' '+(error.stack||String(error)));try{const file='settings-failure-'+report.errors.length+'.png';await page.screenshot({path:OUT+'/'+file,fullPage:true,timeout:3000});report.screenshots.push(file);}catch{}try{await page.goto(BASE+'/#/settings/run');await page.locator('input[data-setting="privatePerDay"]').waitFor();}catch{}}finally{delete report.inProgress;persist();}}
async function go(id,query=''){await page.evaluate(hash=>{location.hash=hash;},'#/settings/'+id+query);await page.locator('[data-settings-view="'+id+'"]:not([hidden])').waitFor();const markers={run:'input[data-setting="privatePerDay"]',model:'#provider-add',tasks:'[data-task-id="main"]',triage:'.ws-tag-input',memory:'.settings-memory',billing:'.usage-heatmap',browser:'.settings-browser',sources:'.collection-source',health:'.health-status',logs:'#program-logs',history:'.hist-table,.ws-empty-line'};await page.locator('[data-settings-view="'+id+'"] '+markers[id]).first().waitFor({state:'attached'});}
async function openAdv(id){const adv=page.locator('[data-settings-view="'+id+'"] details.ws-advanced[data-advanced-id]').first();if(!(await adv.evaluate(el=>el.open)))await adv.locator('summary').click();}
async function keep(){await page.getByRole('button',{name:'保留编辑',exact:true}).filter({visible:true}).click();}
async function discard(){await page.getByRole('button',{name:'放弃并离开',exact:true}).filter({visible:true}).click();}

await check('三项导航、四组十一项与只读状态圆点、输入框宽度上限',async()=>{
 await page.goto(BASE+'/#/settings/run');await page.locator('input[data-setting="privatePerDay"]').waitFor();await page.locator('[data-settings-item="health"] .ws-dot').waitFor();
 assert.equal(await page.locator('.tabs a').count(),3);
 assert.equal(await page.locator('.settings-nav-group').count(),4);
 assert.equal(await page.locator('[data-settings-item]').count(),11);
 assert.equal(requests.filter(r=>r.path==='/api/collection/sources').length,0);
 assert.equal(requests.filter(r=>r.method!=='GET').length,0);
 assert.equal(await page.locator('[data-settings-item="triage"]').textContent(),'消息分级与过滤');
 assert.equal(await page.locator('[data-settings-item="billing"]').textContent(),'计费');
 assert.equal(await page.locator('input[data-setting="privatePerDay"]').inputValue(),'400');
 // 四个发送上限输入框宽度不超过 96px，且没有 maxAgeHours 输入框
 assert.equal(await page.locator('[data-settings-view="run"] input[data-setting="maxAgeHours"]').count(),0);
 for(const key of ['publicPerHour','privatePerHour','publicPerDay','privatePerDay']){
  const w=await page.locator(`input[data-setting="${key}"]`).evaluate(el=>el.getBoundingClientRect().width);
  assert.ok(w>0&&w<=96,`${key} 宽度超限: ${w}`);
 }
});

await check('模式仅保存已保存值，保留限制编辑与暂停状态',async()=>{await page.locator('input[data-setting="publicPerHour"]').fill('11');await page.locator('#program-mode-auto').check();await page.waitForFunction(()=>document.querySelector('#program-mode-auto')?.checked);await page.waitForTimeout(250);const mutation=requests.filter(r=>r.path==='/api/program/settings').at(-1);assert.equal(mutation.body.settings.publicPerHour,10);assert.equal(mutation.body.settings.mode,'auto');assert.equal(await page.locator('input[data-setting="publicPerHour"]').inputValue(),'11');assert.equal(control.value,'paused');await page.evaluate(()=>location.hash='#/settings/health');await page.getByRole('button',{name:'保留编辑',exact:true}).waitFor();await keep();assert.match(await page.evaluate(()=>location.hash),/settings\/run/);assert.equal(await page.locator('input[data-setting="publicPerHour"]').inputValue(),'11');assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});dispatchEvent(e);return e.defaultPrevented;}),true);await page.locator('#program-settings-save').click();await page.waitForTimeout(150);assert.equal(settings.publicPerHour,11);});

await check('保存等待期的新输入保留为未保存修改',async()=>{holdProgramSave=true;await page.locator('input[data-setting="publicPerHour"]').fill('12');const request=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/program/settings');request.catch(()=>{});await Promise.all([request,page.locator('#program-settings-save').click()]);await page.locator('input[data-setting="publicPerHour"]').fill('13');releaseProgramSave();await page.waitForFunction(()=>!document.querySelector('#program-settings-save').disabled);assert.equal(settings.publicPerHour,12);assert.equal(await page.locator('input[data-setting="publicPerHour"]').inputValue(),'13');await page.evaluate(()=>location.hash='#/settings/health');await keep();assert.equal(await page.locator('input[data-setting="publicPerHour"]').inputValue(),'13');await page.locator('#program-settings-save').click();await page.waitForTimeout(100);assert.equal(settings.publicPerHour,13);});

await check('非法额度失败后保留编辑，刷新能力仅显式点击',async()=>{const before=requests.filter(r=>r.path.endsWith('/posting-limits/refresh')).length;await page.locator('input[data-setting="privatePerDay"]').fill('501');await page.locator('#program-settings-save').click();await page.waitForTimeout(100);assert.equal(settings.privatePerDay,400);assert.equal(await page.locator('input[data-setting="privatePerDay"]').inputValue(),'501');await page.locator('input[data-setting="privatePerDay"]').fill('400');await page.locator('#program-settings-save').click();await openAdv('run');await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.waitForTimeout(100);assert.equal(requests.filter(r=>r.path.endsWith('/posting-limits/refresh')).length,before+1);});

await check('时段保存及状态事件独立刷新，不覆盖脏输入与焦点',async()=>{await page.locator('#reply-hours-enabled').uncheck();await page.locator('#program-settings-save').click();await page.waitForFunction(()=>document.querySelector('#reply-hours-schedule')?.textContent.includes('全天回复'));await page.locator('#reply-hours-enabled').check();await openAdv('run');await page.locator('#reply-hours-delay').fill('60');await page.locator('#program-settings-save').click();await page.waitForFunction(()=>document.querySelector('#reply-hours-schedule')?.textContent.includes('00:00'));const input=page.locator('input[data-setting="publicPerHour"]'),handle=await input.elementHandle();await input.fill('14');await input.focus();publicUsed=9;windowOverride={...windowState(),open:false,reason:'reply-hours-closed',opensAt:now+3600000};await page.evaluate(async()=>{const state=await import('/js/state.js');await state.refreshStatus();});await page.waitForFunction(()=>document.querySelector('#reply-hours-state')?.textContent.includes('当前不回复'));assert.equal(await input.inputValue(),'14');assert.equal(await input.evaluate((el,old)=>el===old,handle),true);assert.equal(await input.evaluate(el=>document.activeElement===el),true);assert.match(await input.evaluate(el=>el.closest('tr').textContent),/9\s*·\s*2/);await input.fill('13');windowOverride=null;publicUsed=2;await page.locator('#reply-hours-delay').fill('30');await page.locator('#program-settings-save').click();await page.waitForFunction(()=>!document.querySelector('#program-settings-save').disabled);});

await check('主循环计划不带enabled，时间轴7点无重叠与早晚安发帖提示',async()=>{
 await go('tasks');
 assert.equal(await page.locator('[data-task-id]').count(),9);
 assert.equal(await page.locator('[data-task-id="main"] input[type="checkbox"]').count(),0);
 // 时间轴只画 7 个每日定时任务的圆点，标签两行交错不重叠
 assert.equal(await page.locator('#tasks-timeline .tasks-tl-dot').count(),7);
 const boxes=await page.locator('#tasks-timeline .tasks-tl-ev').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {row:el.classList.contains('row-a')?'a':'b',left:r.left,right:r.right};}));
 for(const rowName of ['a','b']){
  const rowBoxes=boxes.filter(b=>b.row===rowName).sort((x,y)=>x.left-y.left);
  for(let i=1;i<rowBoxes.length;i++)assert.ok(rowBoxes[i].left>=rowBoxes[i-1].right-1,`时间轴 ${rowName} 行标签重叠`);
 }
 // 早安帖与晚安帖显示“会发到 X”
 assert.match(await page.locator('[data-task-id="morning-post"]').textContent(),/会发到 X/);
 assert.match(await page.locator('[data-task-id="evening-post"]').textContent(),/会发到 X/);
 await openAdv('tasks');
 await page.locator('[data-task-id="main"] input[type="number"]').fill('90');
 await page.locator('#tasks-save').click();
 await page.waitForTimeout(100);
 const call=requests.filter(r=>r.path==='/api/tasks/main'&&r.method==='PUT').at(-1);
 assert.equal(call.body.intervalSeconds,90);
 assert.equal('enabled'in call.body,false);
 assert.equal(control.value,'paused');
});

await check('模型左栏仅已添加服务商、添加窗口预选与编辑窗口未保存保护',async()=>{
 await go('model');
 assert.equal(await page.locator('.provider-sidebar .provider-row').filter({hasText:'DeepSeek'}).count(),1);
 await page.locator('#provider-add').click();
 await page.getByRole('dialog',{name:'添加服务商'}).waitFor();
 await page.locator('#provider-search').fill('Anthropic');
 await page.locator('.provider-choice').filter({hasText:'Anthropic'}).click();
 assert.equal(await page.getByRole('dialog').getByLabel('Base URL',{exact:true}).inputValue(),'https://anthropic.example');
 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 // 打开编辑服务商窗口测试未保存离开保护
 await page.locator('.provider-sidebar .provider-row').filter({hasText:'DeepSeek'}).locator('button[aria-label="编辑服务商"]').click();
 await page.getByRole('dialog',{name:'编辑服务商'}).waitFor();
 await page.locator('#api-key').fill('unsaved');
 await page.evaluate(()=>location.hash='#/settings/health');
 await keep();
 assert.equal(await page.locator('#api-key').inputValue(),'unsaved');
 await page.evaluate(()=>location.hash='#/settings/health');
 await discard();
});

await check('分级标签与时效合并、记忆策略弹窗与健康未保存切项保护',async()=>{
 await go('triage');
 // 高级设置摘要写出消息时效与阈值
 assert.match(await page.locator('[data-settings-view="triage"] details.ws-advanced>summary').textContent(),/消息时效 3 小时.*阈值 3/);
 await openAdv('triage');
 const ageInput=page.locator('[data-settings-view="triage"] input[data-setting="maxAgeHours"]');
 await ageInput.fill('4');
 await page.evaluate(()=>location.hash='#/settings/run');
 await keep();
 assert.equal(await ageInput.inputValue(),'4');
 await page.locator('#triage-settings-save').click();
 await page.waitForTimeout(100);
 assert.equal(settings.maxAgeHours,4);
 // ?view=policy 自动进入用户视图并打开高级设置窗口
 await go('memory','?view=policy');
 assert.equal(await page.locator('#memory-policy-dialog').isVisible(),true);
 const memInput=page.locator('#memory-policy-dialog input[type="number"]').first();
 await memInput.fill('4');
 await page.evaluate(()=>location.hash='#/settings/run');
 await keep();
 assert.equal(await memInput.inputValue(),'4');
 await page.evaluate(()=>location.hash='#/settings/run');
 await discard();
 await page.locator('#program-settings-save').waitFor();
 // 健康页顶部需关注与“去处理”跳转，以及高级设置未保存保护
 await go('health');
 assert.match(await page.locator('.health-top-card').textContent(),/需关注/);
 assert.equal(await page.locator('.health-top-card a.health-action-link').first().getAttribute('href'),'#/settings/browser');
 await openAdv('health');
 const healthInput=page.locator('[data-settings-view="health"] textarea').first();
 await healthInput.fill('未保存测试');
 await page.evaluate(()=>location.hash='#/settings/run');
 await keep();
 assert.equal(await healthInput.inputValue(),'未保存测试');
 await page.evaluate(()=>location.hash='#/settings/run');
 await discard();
});

await check('记忆自动选中首个身份、深链三视图与条目操作',async()=>{
 await go('memory');
 // 自动选中第一个用户 @one
 await page.locator('#memory-detail textarea').waitFor();
 await go('memory','?account=fixture&user=x%3Aone&channel=public');
 await page.locator('#memory-detail textarea').waitFor();
 assert.match(await page.locator('#memory-detail').textContent(),/明确事实|偏好/);
 assert.equal(await page.locator('#memory-detail img').count(),0);
 await page.locator('#memory-detail textarea').fill('修订后的偏好');
 await page.getByRole('button',{name:'保存条目',exact:true}).click();
 await page.waitForTimeout(100);
 assert.equal(memoryItems[0].text,'修订后的偏好');
 await page.locator('#memory-preview').click();
 await page.getByRole('heading',{name:'只读召回预览',exact:true}).waitFor();
 await page.getByRole('link',{name:'角色经历',exact:true}).click();
 await page.locator('#memory-experiences').waitFor();
 await page.locator('#memory-advanced-btn').click();
 await page.locator('#memory-policy-save').waitFor();
 await page.locator('#memory-policy-dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('link',{name:'用户记忆',exact:true}).click();
 await page.locator('#memory-identity').waitFor({state:'attached'});
});

await check('连接桌面切项保持，同页返回还原操作，外页断开',async()=>{await go('browser');const ratio=await page.locator('.desk-placeholder').evaluate(el=>el.getBoundingClientRect().height/(window.innerHeight-el.getBoundingClientRect().top));assert.ok(ratio>=0.85,`未接管占位区高度占比过低: ${ratio}`);const widthRatio=await page.locator('.desk-placeholder').evaluate(el=>el.getBoundingClientRect().width/el.parentElement.getBoundingClientRect().width);assert.ok(widthRatio>=.95,`未接管占位区宽度占比过低: ${widthRatio}`);await page.locator('#connect').click();await page.locator('#desktop-frame').waitFor();assert.ok(await page.locator('#desktop-frame').evaluate(el=>el.getBoundingClientRect().width/el.closest('.settings-browser').getBoundingClientRect().width>=.95),'连接后桌面没有铺满宽度');assert.ok(await page.locator('#desktop-frame').evaluate(el=>el.getBoundingClientRect().height/el.parentElement.getBoundingClientRect().height>=.98),'连接后桌面没有铺满高度');const frame=await page.locator('#desktop-frame').elementHandle(),loads=desktopLoads;await go('health');assert.equal(await frame.evaluate(el=>el.isConnected),true);await go('browser');assert.equal(await page.locator('#desktop-frame').evaluate((el,old)=>el===old,frame),true);assert.equal(await page.locator('#release').isVisible(),true);assert.equal(desktopLoads,loads);await page.getByRole('link',{name:/^动态/}).click();await page.waitForTimeout(150);assert.equal(await frame.evaluate(el=>el.isConnected),false);assert.equal(control.value,'manual');control.value='paused';});

await check('全部旧地址和最近设置项兼容',async()=>{for(const [old,target]of [['overview','feed'],['model','settings/model'],['program','settings/logs'],['tasks','settings/tasks'],['browser','settings/browser'],['memory?account=fixture&user=x%3Aone&channel=public','settings/memory?account=fixture&user=x%3Aone&channel=public'],['billing','settings/billing'],['settings/limits','settings/run']]){await page.goto(BASE+'/#/'+old);await page.waitForFunction(expected=>location.hash==='#/'+expected,target);assert.equal(await page.evaluate(()=>location.hash),'#/'+target);}await go('triage');await page.goto(BASE+'/#/settings');await page.waitForFunction(()=>location.hash==='#/settings/triage');});

await check('摘要故障隔离、状态刷新与无额外采集请求',async()=>{await go('run');const sourceCount=requests.filter(r=>r.path==='/api/collection/sources').length,writeCount=requests.filter(r=>r.method!=='GET').length;summaryFailure=true;const failed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/health'&&r.status()===503);await Promise.all([failed,page.reload()]);await page.locator('input[data-setting="privatePerDay"]').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-settings-item="health"] .ws-dot'));assert.equal(await page.locator('[data-settings-item="memory"]').textContent(),'记忆');summaryFailure=false;await page.evaluate(()=>dispatchEvent(new CustomEvent('settings-saved')));await page.locator('[data-settings-item="health"] .ws-dot').waitFor();assert.match(await page.locator('[data-settings-item="health"] .ws-dot').getAttribute('title'),/需关注/);assert.equal(requests.filter(r=>r.path==='/api/collection/sources').length,sourceCount);assert.equal(requests.filter(r=>r.method!=='GET').length,writeCount);});

await check('设置左栏收起刷新后恢复并可展开',async()=>{await go('run');await page.getByRole('button',{name:'收起左栏',exact:true}).click();assert.equal(await page.locator('.ws-left').isVisible(),false);await page.reload();await page.locator('input[data-setting="privatePerDay"]').waitFor();assert.equal(await page.locator('.ws-left').isVisible(),false);await page.getByRole('button',{name:'展开左栏',exact:true}).click();assert.equal(await page.locator('.ws-left').isVisible(),true);});

// 用几何断言复现曾被“页面可打开”和无整体溢出漏掉的视觉偏差。
richVisual=true;
await page.emulateMedia({colorScheme:'light'});
await page.setViewportSize({width:1440,height:868});
await page.evaluate(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('ws:settings:advanced:'))localStorage.removeItem(k);});
const box=async selector=>page.locator(selector).first().evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};});
await check('草图：任务、日志、历史与来源表格铺满容器',async()=>{
 for(const [id,selector]of [['tasks','.tasks-table'],['logs','.logs-table'],['history','.hist-table'],['sources','.sources-table']]){
  await go(id);await page.locator(selector).waitFor();
  const ratio=await page.locator(selector).evaluate(el=>{const p=el.parentElement,c=getComputedStyle(p);return el.getBoundingClientRect().width/(p.clientWidth-parseFloat(c.paddingLeft)-parseFloat(c.paddingRight));});
  assert.ok(ratio>=.97,id+' 表格未铺满：'+ratio);
 }
});
await check('草图：日志筛选在宽屏保持一行',async()=>{
 await go('logs');
 const b=await box('.log-toolbar');assert.ok(b.height<=42,'日志筛选被拆成多行：'+b.height);
 const inputs=await page.locator('.log-toolbar>.input').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().top));
 assert.ok(Math.max(...inputs)-Math.min(...inputs)<3);
});
await check('草图：模型工具栏单行、内部栏满高与十四行可见',async()=>{
 await go('model');await page.locator('.model-row').nth(29).waitFor({state:'attached'});
 assert.ok((await box('.model-toolbar')).height<=42,'模型工具栏被拆成多行');
 assert.ok((await box('.provider-sidebar')).bottom>=840,'服务商栏没有填满可用高度');
 const visible=await page.locator('.model-table .model-row').evaluateAll(els=>els.filter(el=>{const r=el.getBoundingClientRect();return r.y>=100&&r.bottom<=868;}).length);
 assert.ok(visible>=14,'首屏只有 '+visible+' 行模型');
 await go('memory');assert.ok((await box('.memory-sidebar')).bottom>=840,'记忆身份栏没有填满可用高度');
});
await check('草图：运行双卡等高、用量条与开关同行',async()=>{
 await go('run');const cards=await page.locator('.settings-run .ws-cols>.ws-card').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().height));
 assert.ok(Math.abs(cards[0]-cards[1])<2,'并列卡片底边不齐');
 assert.equal(await page.locator('.run-used-bar').count(),2);
 assert.ok((await box('.run-used-bar')).width>=68,'发送用量条没有渲染');
});
await check('草图：健康告警逐项成行、分组纵排且完整状态首屏可见',async()=>{
 await go('health');const rows=await page.locator('.health-attention-row').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
 assert.equal(rows.length,3);for(let i=1;i<rows.length;i++)assert.ok(rows[i].top>=rows[i-1].bottom-1,'告警被挤到同一行');
 assert.equal(await page.locator('.health-groups-grid .health-chip').count(),21);
 const groups=await page.locator('.health-group-card').evaluateAll(els=>els.map(el=>{const h=el.querySelector('.health-group-head').getBoundingClientRect(),c=el.querySelector('.health-chips').getBoundingClientRect();return {head:h.bottom,chips:c.top};}));
 assert.ok(groups.every(g=>g.chips>=g.head),'健康组标题与胶囊挤成横排');
 assert.ok((await box('.health-page')).bottom<=868,'收起高级设置后健康页仍需滚动');
});
await check('草图：计费流水紧凑、热力格铺满、柱图保持模型色',async()=>{
 await go('billing');
 assert.ok((await box('.usage-calls>summary')).height<=68,'收起的流水标题过高');
 assert.ok((await box('.usage-calls')).bottom<=868,'首屏看不到完整流水标题');
 const coverage=await page.locator('.usage-heatmap').evaluate(svg=>{const cells=[...svg.querySelectorAll('.heat-cell')].map(el=>el.getBoundingClientRect());return (Math.max(...cells.map(r=>r.right))-Math.min(...cells.map(r=>r.left)))/svg.getBoundingClientRect().width;});
 assert.ok(coverage>=.92,'热力格缩在中间：'+coverage);
 assert.ok((await box('.usage-lines')).height<=220,'柱图超出指定高度');
 const color=await page.locator('.trend-bar').first().evaluate(el=>getComputedStyle(el).fill),legend=await page.locator('.billing-trend-card .legend-swatch').first().evaluate(el=>getComputedStyle(el).backgroundColor);
 assert.equal(color,legend,'柱色和模型图例颜色不一致');
});

await check('四宽浅深十一项截图与无横向溢出',async()=>{for(const scheme of ['light','dark'])for(const width of [1440,1280,860,375]){await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width,height:868});for(const id of Object.keys({run:1,model:1,tasks:1,triage:1,memory:1,billing:1,browser:1,sources:1,health:1,logs:1,history:1})){await go(id);await page.waitForTimeout(60);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,scheme+' '+width+' '+id);assert.equal(await page.locator('.ws-main>.ws-content').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'主区横向溢出 '+scheme+' '+width+' '+id);const file='settings-'+id+'-'+scheme+'-'+width+'.png';await page.screenshot({path:OUT+'/'+file,fullPage:true});report.screenshots.push(file);}if(width<=860){await go('run');await page.getByRole('button',{name:'展开左栏',exact:true}).click();await page.locator('[data-settings-item="memory"]').click();await page.locator('.settings-memory').waitFor();assert.equal(await page.locator('.ws-left').isVisible(),false);assert.equal(await page.locator('#memory-identity').isVisible(),true);}}});

await check('计费fmtUsd与堆叠柱图、日志事件表、任务历史合并与来源显式读取',async()=>{
 await page.setViewportSize({width:1440,height:868});
 await go('billing');
 // fmtUsd 两位有效小数与精确值 title
 assert.match(await page.locator('.usage-summary').textContent(),/\$0\.048/);
 assert.match(await page.locator('.usage-summary').textContent(),/\$0\.00025/);
 assert.equal(await page.locator('.usage-summary .ws-usd[title="$0.04840811"]').count(),1);
 // 展开前不请求流水明细
 const callsBefore=requests.filter(r=>r.path==='/api/billing/calls').length;
 assert.equal(callsBefore,0);
 await page.getByText('调用流水',{exact:true}).click();
 await page.locator('.call-record').getByText('试聊',{exact:true}).waitFor();
 assert.equal(await page.locator('.usage-heatmap').count(),1);
 await page.locator('.usage-lines').focus();
 await page.keyboard.press('End');
 assert.equal(await page.locator('.chart-tip:not([hidden])').count(),1);
 // 日志摘要与跨天分隔行
 await go('logs');
 assert.match(await page.locator('#program-logs').textContent(),/deepseek 模型列表已刷新/);
 assert.equal(await page.locator('#program-logs .log-day-divider').count(),2);
 await page.getByRole('button',{name:'阶段',exact:true}).click();
 assert.equal(await page.getByText('暂无阶段记录。',{exact:true}).isVisible(),true);
 await page.getByRole('button',{name:'队列',exact:true}).click();
 assert.equal(await page.getByText('当前没有排队消息。',{exact:true}).isVisible(),true);
 // 任务执行历史连续成功合并
 await go('history');
 assert.match(await page.locator('[data-settings-view="history"] .hist-group-row').first().textContent(),/×2/);
 await go('sources');
 assert.equal(await page.locator('.collection-source').count(),2);
 assert.deepEqual(pageErrors,[]);
});
await context.close();await browser.close();report.requests={total:requests.length,writes:requests.filter(r=>r.method!=='GET'),desktopLoads};writeFileSync(OUT+'/settings-workspace-ui-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
