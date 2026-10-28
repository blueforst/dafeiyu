// 服务器 Camoufox 专项交互验收；全部业务接口为模拟数据，不连接生产账号、模型或 X。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const BASE=process.env.PANEL_URL||'http://127.0.0.1:8081',OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const now=Date.now(),date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),unsafe='<img src=x onerror="window.__injected=1">';
const result={evidence:'服务器 Camoufox / 模拟API；不代表真实模型、账号能力、X收发或生产健康验收',checks:[],errors:[]};
const quality={total:10,replies:8,skipped:2,skipRate:.2,averageLength:22,openingRepeatRate:.3,kaomojiPerTen:1,emojiPerTen:2,tildePerTen:1,stepsRate:0,forbiddenLinks:0,forbiddenMentions:0,publicLengthViolations:0};
async function fixtures(page){
 const calls=[];let healthRevision=0,triageRevision=0,modelRevision=0,postingState='unknown',conflict=false,run=null,ignored=true;
 let persona={sections:[{id:'role',title:'角色',content:'候选人设'}],triggers:[]};
 const personaItem=()=>({id:'current',name:'当前人设',revision:7,createdAt:now,updatedAt:now,origin:{kind:'migrated'},persona:structuredClone(persona),fixedRules:'固定约束'});
 const feedRows={posts:[{id:'post:p1',type:'post',taskId:'morning-post',runId:'task-post',at:now,sortAt:now,updatedAt:now,status:'confirmed',text:'早安帖',receipt:{url:'https://x.com/tester/status/456'},memory:null}],'x:person':[{id:'message:old',messageId:'old',type:'reply',at:now-1000,sortAt:now-1000,updatedAt:now-1000,revision:1,status:'confirmed',original:'旧入站',text:'旧回复',draft:{text:'旧回复'},memory:null}]};
 const conversations=[{key:'posts',channel:'public',title:'角色帖',latestAt:now,status:'confirmed',pending:0,preview:'早安帖',avatar:'帖',updatedAt:now},{key:'x:person',channel:'public',title:'@person',handle:'person',latestAt:now-1000,status:'confirmed',pending:0,preview:'旧回复',avatar:'P',updatedAt:now-1000}];
 let healthSettings={softTimeoutMinutes:8,hardTimeoutMinutes:12,publicCollectionSeconds:90,privateCollectionSeconds:90,rpcTimeoutSeconds:120,memoryRatio:.75,browserMaxAgeHours:24,requiredPhrases:['AI']};
 let triage={normalMaxAgeHours:3,batchThreshold:3,advertisingKeywords:['广告'],greetings:['hi'],priorityPublicHandles:[],priorityPrivateConversations:[]};
 const sample={id:'r-public',channel:'public',timestamp:now,tier:'priority',status:'confirmed',revision:1,private:false,message:{text:unsafe,handle:'person'},actual:{action:'reply',text:'旧回复'}};
 const privateSample={id:'r-private',channel:'private',timestamp:now,tier:'normal',status:'confirmed',revision:1,private:true,collapsed:true};
 const runItem={...sample,status:'completed',baseline:{draft:{action:'reply',text:'基线回复'}},candidate:{draft:{action:'reply',text:'候选回复'},contextIncomplete:true},label:null,issues:[]};
 const privateItem={id:'r-private',channel:'private',status:'completed',label:null,issues:[],collapsed:true};
 const library={version:1,providers:[{key:'anthropic',provider:'anthropic',name:'Anthropic',baseUrl:'https://api.anthropic.com',hasKey:true,keyHint:'••••1234',ready:true,active:true,models:[{id:'claude-known',source:'catalog',active:true,info:{contextWindow:200000,reasoning:true,vision:true,levels:['off','high'],costKnown:true,cost:{input:3,output:15}},params:{maxTokens:4096,timeoutMs:60000,reasoningLevel:'off'},lastTest:{ok:true,at:now,latencyMs:123}},{id:'unknown-model',source:'discovered',info:null,params:{maxTokens:4096,timeoutMs:60000,reasoningLevel:'off'}}]}],active:{default:{key:'anthropic',modelId:'claude-known'}}};
 const posting=()=>{const reason={unknown:'没有已验收长帖证据',stale:'能力缓存已过期',none:'当前账号未确认，使用普通账号模拟限制'}[postingState];const cap={accountId:postingState==='none'?'':'tester',status:postingState==='stale'?'stale':'unknown',limit:280,unit:'weighted-characters',source:'短帖默认规则',checkedAt:postingState==='stale'?now-3600000:0,reason};return{accountId:cap.accountId,simulation:postingState==='none',post:cap,reply:cap,effective:{post:cap,reply:cap}};};
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method();let body;try{body=req.postDataJSON();}catch{}calls.push({path,method,body,query:Object.fromEntries(url.searchParams)});let data;
 if(path==='/api/events'){await route.fulfill({contentType:'text/event-stream',body:'retry: 500\nevent: health\ndata: '+JSON.stringify({status:'attention',activeAlerts:[{summary:'浏览器需要人工处理'}]})+'\n\n'});return;}
 if(path==='/api/status')data={control:'paused',busy:false,accountId:postingState==='none'?'':'tester',browser:{loggedIn:postingState!=='none',handle:postingState==='none'?'':'tester'},config:{mode:'draft',model:{configured:true,id:'claude-known',provider:'anthropic'}},cooldown:{}};
 else if(path==='/api/personas')data={activeId:'current',libraryRevision:0,items:[{...personaItem(),persona:undefined,characters:20}]};
 else if(path==='/api/personas/current')data=personaItem();
 else if(path==='/api/persona/presets')data={version:2,items:[{id:'default',name:'通用（默认）',summary:'只读预设',persona:structuredClone(persona)}]};
 else if(path==='/api/persona')data={persona,revision:7,fixedRules:'固定约束'};
 else if(path==='/api/persona/prompt-hints')data={promptHints:{lateEnabled:true,lateMinutes:60,languageEnabled:true,openingEnabled:true,openingCount:12,expressionEnabled:true,kaomojiPer10:1,emojiPer10:2,tildePer10:1,replyCheckEnabled:true},revision:0};
 else if(path==='/api/persona/daily')data={date,status:'missing',scheduleTime:'06:00',history:[]};
 else if(path==='/api/persona/replay/samples')data={samples:url.searchParams.get('includePrivate')==='true'?[sample,privateSample]:[sample],excluded:{forgotten:1,deleted:1}};
 else if(path==='/api/persona/replay/estimate')data={estimateId:'estimate-1',requests:body.baselineMode==='actual'?2:4,estimatedUsd:null,pricingStatus:'unpriced',samples:body.filter.includePrivate?[sample,privateSample]:[sample],requiresConfirmation:true};
 else if(path==='/api/persona/replay/runs'&&method==='POST'){run={id:'run-1',status:'running',createdAt:now,baselineMode:'actual',persona,personaRevision:7,summary:{total:2,completed:1,failed:0,labels:{candidate:0,baseline:0,same:0,'both-bad':0},issues:{},baseline:quality,candidate:quality,fees:{calls:1,costUSD:null,unpriced:1}},items:[runItem,privateItem]};data={run};}
 else if(path==='/api/persona/replay/runs')data={items:run?[{id:run.id,status:run.status,createdAt:now}]:[]};
 else if(path==='/api/persona/replay/runs/run-1')data=method==='DELETE'?{ok:true}:run;
 else if(path==='/api/persona/replay/runs/run-1/abort'){run.status='aborted';data={ok:true};}
 else if(path==='/api/persona/replay/estimates/estimate-1'&&method==='DELETE')data={ok:true};
 else if(path==='/api/persona/replay/runs/run-1/adopt'){if(conflict){await route.fulfill({status:409,json:{error:'人设修订已变化，请重新回放或手动合并'}});return;}data={ok:true,revision:8};}
 else if(path==='/api/persona/replay/runs/run-1/items/r-public/label'){Object.assign(runItem,{label:body.label,issues:body.issues});run.summary.labels[body.label]=1;run.summary.issues=Object.fromEntries(body.issues.map(x=>[x,1]));data={ok:true};}
 else if(path==='/api/persona/replay/runs/run-1/items/r-private')data={...privateItem,collapsed:false,private:true,message:{text:'私信仅在显式展开后显示'},baseline:{draft:{action:'skip',reason:'当时跳过'}},candidate:{draft:{action:'reply',text:'私信候选'}}};
 else if(path==='/api/persona/quality')data={metrics:quality,daily:[{date,...quality},{date:'2026-10-27',...quality,openingRepeatRate:.1}]};
 else if(path==='/api/program')data={control:'paused',settings:{mode:'draft',maxAgeHours:24,maxPerRound:2,publicPerHour:10,privatePerHour:30,publicPerDay:180,privatePerDay:400,replyHours:{enabled:true,closeDelayMinutes:30}},replyHours:{open:true,reason:null,closeTime:'23:30',openTime:'08:00'},limits:{public:{used:1,limit:10},private:{used:0,limit:30}},revision:0,stages:[],queue:{items:[],counts:[]},cooldown:{}};
 else if(path==='/api/tasks')data={tasks:['main','daily-state','memory-summary','morning-post','evening-post','backup','health','daily-report','account-check'].map(id=>({id,title:id,enabled:id==='daily-state',time:id==='morning-post'?'08:00':id==='evening-post'?'23:00':'06:00'})),revision:0};
 else if(path==='/api/tasks/runs')data={items:[],nextCursor:null};
 else if(path==='/api/billing/summary')data={totals:{calls:4,costUSD:null,unpriced:4,unknown:0},models:[],purposes:[],daily:[]};
 else if(path==='/api/messages/imports')data={items:[],pending:0,nextCursor:null,accountId:'tester'};
 else if(path==='/api/chat-test/status')data={accountId:'tester',accountConfirmed:true,activePersona:{id:'current'},model:{provider:'anthropic',id:'claude-known'},concurrency:{active:0,limit:2}};
 else if(path==='/api/chat-test/users')data={items:[]};
 else if(path==='/api/memory/policy')data={policy:{recentCount:3,recentDays:7,retentionDays:30},revision:0};
 else if(path==='/api/health')data={status:'error',at:now,metrics:[{key:'browser-human',level:'error',summary:'浏览器需要人工处理'}],activeAlerts:[{summary:'浏览器需要人工处理'}],compliance:{disclosure:'missing',automatedLabel:'unknown',qualityFilter:'on'}};
 else if(path==='/api/health/settings'){if(method==='PUT'){const {revision,...patch}=body;assert.equal(revision,healthRevision);healthSettings=patch;healthRevision++;}data={settings:healthSettings,revision:healthRevision};}
 else if(path==='/api/health/alerts')data={items:[{summary:unsafe,startedAt:now-60000,lastSeenAt:now,resolvedAt:null}],nextCursor:null};
 else if(path==='/api/health/reports')data={items:[{date,model:{calls:4,totalTokens:1234,costUSD:null,unpriced:4,unknown:0},channels:{public:{received:4,replied:2,skipped:1,failed:0,unknown:1},private:{received:1,replied:1,skipped:0,failed:0,unknown:0}},responseLatencyMs:{median:1000,p90:2000},alerts:1,automationBlocks:1,browserRestarts:1,pausedMs:60000}]};
 else if(path==='/api/triage/settings'){if(method==='PUT'){assert.equal(body.revision,triageRevision);triage=body.settings;triageRevision++;}data={settings:triage,revision:triageRevision};}
 else if(path==='/api/triage/summary')data={queues:[{channel:'public',tier:'priority',count:2,oldestAt:now-60000},{channel:'private',tier:'normal',count:1,oldestAt:now-30000}],reasons:[{status:'filtered',reason:'批量广告',count:3}],publicToday:17,publicPerDay:180,privateRecent:12,privatePerDay:400};
 else if(path==='/api/triage/ignores'){if(method==='DELETE')ignored=false;data={items:ignored?[{userId:'noisy',channel:'public',until:now+3600000,reason:'骚扰冷却'}]:[],ok:true};}
 else if(path==='/api/account/posting-limits'||path==='/api/account/posting-limits/refresh')data=posting();
 else if(path==='/api/feed')data={items:Object.values(feedRows).flat(),pending:0,nextCursor:null};
 else if(path==='/api/feed/conversations'){const filter=url.searchParams.get('filter')||'all';data={items:conversations.filter(c=>filter==='all'||filter==='public'&&c.key!=='posts'||filter==='posts'&&c.key==='posts'),pending:0,importsPending:0,nextCursor:null,serverTime:now};}
 else if(/^\/api\/feed\/conversations\/.+\/items$/.test(path)){const key=decodeURIComponent(path.slice('/api/feed/conversations/'.length,-'/items'.length)),items=feedRows[key]||[];data={items,total:items.length,firstAt:items[0]?.sortAt||0,nextBefore:null,conversation:conversations.find(c=>c.key===key),serverTime:now};}
 else if(path==='/api/tasks/runs/task-post')data={run:{status:'completed',outboxId:'p1',validation:{allowed:true,measuredLength:3,limit:280,unit:'weighted-characters'}},calls:[{id:'call-post',purpose:'morning-post',provider:'anthropic',model:'claude-known',latencyMs:150,usage:{totalTokens:123,cacheRead:45},pricingStatus:'priced',cost:{total:.001}}],outbox:[{id:'p1',kind:'post',status:'confirmed',receipt:JSON.stringify({url:'https://x.com/tester/status/456'}),validation_json:JSON.stringify({allowed:true,measuredLength:3,limit:280,policyRevision:'sample-policy'})}]};
 else if(path==='/api/messages/old')data={message:{status:'confirmed'},calls:[{id:'call-legacy',purpose:'reply',model:'historical',usage:null,latencyMs:null,pricingStatus:'unknown'}],outbox:[]};
 else if(path==='/api/model/providers')data=[{id:'anthropic',name:'Anthropic',group:'intl',available:true,baseUrl:'https://api.anthropic.com',apis:['anthropic-messages']}];
 else if(path==='/api/model')data={library:{...library,revision:modelRevision}};
 else if(path==='/api/model/library/anthropic/models/unknown-model'&&method==='PUT'){const m=library.providers[0].models[1];Object.assign(m,{custom:body.custom,params:body.params});modelRevision++;data={...library,revision:modelRevision};}
 else if(path==='/api/model/active'){library.active.default={key:body.key,modelId:body.modelId};modelRevision++;data={...library,revision:modelRevision};}
 else{await route.fulfill({status:404,json:{error:'专项模拟接口未定义 '+path}});return;}
 await route.fulfill({json:data});});
 return{calls,setPosting(value){postingState=value;},setConflict(value){conflict=value;}};
}
async function check(name,fn){try{await fn();result.checks.push(name);}catch(e){result.errors.push({name,error:e.stack||String(e),visibleText:await page.locator('#view').innerText().catch(()=>''),lastRequests:fx.calls.slice(-12).map(x=>({path:x.path,method:x.method,query:x.query}))});}}
const browser=await observer(),context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage(),fx=await fixtures(page);page.setDefaultTimeout(12000);page.on('pageerror',e=>result.errors.push({name:'页面异常',error:e.stack||String(e)}));
// 交互检查在下方逐组执行，最后只导出模拟验收证据。
async function openReplay(){
 await page.goto(BASE+'/?ui-probe='+Date.now()+'#/persona/p/current');await page.waitForSelector('#persona-section-0');
 // 新人设工作区以已保存库项为上下文，回放仍复用原有比较组件。
 await page.getByRole('button',{name:'回放对比',exact:true}).click();await page.waitForURL(url=>url.hash==='#/persona/p/current/replay');
 await page.waitForFunction(()=>document.querySelector('.ws-main > .ws-header')?.textContent.includes('回放 · 当前人设'));
 assert.match(await page.locator('.ws-main > .ws-header').textContent(),/回放 · 当前人设/);
 const replay=page.locator('.ws-main > .ws-content');await replay.getByRole('button',{name:'预览真实样本',exact:true}).waitFor();return replay;
}
async function startReplay(replay){await replay.getByLabel(/^渠道/).selectOption('all');await replay.getByLabel('明确允许私信样本参与回放',{exact:true}).check();await replay.getByRole('button',{name:/预估回放/}).click();await replay.getByRole('button',{name:/确认开始/}).click();await page.waitForFunction(()=>document.body.textContent.includes('完成 1 / 2'));}

await check('回放筛选、私信显式勾选与预估确认',async()=>{
 const replay=await openReplay();
 await replay.getByLabel('数量',{exact:true}).fill('2');await replay.getByLabel(/^消息分级/).selectOption('priority');await replay.getByLabel(/^选取方式/).selectOption('latest');await replay.getByRole('button',{name:'预览真实样本',exact:true}).click();
 await page.waitForFunction(()=>document.body.textContent.includes('r-public'));assert.equal(fx.calls.filter(c=>c.path.endsWith('/samples')).at(-1).query.includePrivate,'false');assert.equal(await page.locator('#view').textContent().then(t=>t.includes('私信仅在显式展开后显示')),false);
 await replay.getByLabel(/^渠道/).selectOption('all');await replay.getByLabel('明确允许私信样本参与回放',{exact:true}).check();await replay.getByRole('button',{name:'预览真实样本',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('r-private'));
 const f=fx.calls.filter(c=>c.path.endsWith('/samples')).at(-1);assert.equal(f.query.channel,'all');assert.equal(f.query.includePrivate,'true');assert.equal(f.query.limit,'2');assert.equal(f.query.tier,'priority');assert.equal(f.query.order,'latest');assert.equal(await page.locator('#view img').count(),0);
 await replay.getByRole('button',{name:/预估回放/}).click();await page.waitForFunction(()=>document.body.textContent.includes('预计 2 次模型请求'));assert.match(await replay.textContent(),/未定价/);assert.equal(fx.calls.filter(c=>c.path==='/api/persona/replay/runs'&&c.method==='POST').length,0);
 await replay.getByRole('button',{name:/确认开始/}).click();await page.waitForFunction(()=>document.body.textContent.includes('完成 1 / 2'));assert.deepEqual(fx.calls.filter(c=>c.path==='/api/persona/replay/runs'&&c.method==='POST').at(-1).body,{estimateId:'estimate-1',confirmed:true});assert.equal(fx.calls.filter(c=>c.path==='/api/persona/replay/estimate').at(-1).body.personaId,'current');
 await page.screenshot({path:OUT+'/replay-running.png',fullPage:true});
});
await check('回放中止、标注、私信展开与采用候选修订冲突',async()=>{
 const replay=await openReplay();await startReplay(replay);
 await page.getByRole('button',{name:'中止',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('aborted'));
 const card=page.locator('article.subcard').filter({hasText:'r-public'});await card.locator('select').selectOption('candidate');await card.getByLabel('模板开头',{exact:true}).check();await card.getByRole('button',{name:'保存标注',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('候选更好 1'));
 assert.deepEqual(fx.calls.filter(c=>c.path.endsWith('/r-public/label')).at(-1).body,{label:'candidate',issues:['template-opening']});
 assert.equal(fx.calls.filter(c=>c.path.endsWith('/items/r-private')).length,0);await page.getByText('私信样本 r-private · completed',{exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('私信仅在显式展开后显示'));assert.equal(fx.calls.filter(c=>c.path.endsWith('/items/r-private')).length,1);
 fx.setConflict(true);await page.getByRole('button',{name:'采用候选人设',exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('修订已变化'));fx.setConflict(false);await page.getByRole('button',{name:'采用候选人设',exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('下一轮生效'));
 assert.equal(fx.calls.filter(c=>c.path.startsWith('/api/control/')).length,0);assert.equal(fx.calls.filter(c=>c.path.includes('/approve')||c.path.includes('/outbox')).length,0);await page.screenshot({path:OUT+'/replay-aborted-labelled.png',fullPage:true});
});
await check('生产质量汇总与逐日趋势不请求模型',async()=>{
 const replay=await openReplay();await replay.getByLabel(/^渠道/).selectOption('all');
 await page.getByText('生产回复质量统计',{exact:true}).click();await page.getByRole('button',{name:'按当前日期与渠道读取',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('30.0%'));
 const qualitySection=page.locator('details').filter({has:page.getByText('生产回复质量统计',{exact:true})}).last();assert.match(await qualitySection.textContent(),/2026-10-27/);assert.match(await qualitySection.textContent(),/开头重复率/);assert.match(await qualitySection.textContent(),/颜文字/);assert.equal(fx.calls.filter(c=>c.path==='/api/persona/quality').at(-1).query.channel,'all');assert.equal(fx.calls.filter(c=>c.path==='/api/persona/preview').length,0);await page.screenshot({path:OUT+'/replay-quality.png',fullPage:true});
});
await check('健康告警历史、日报与配置保存保持暂停',async()=>{
 await page.goto(BASE+'/#/settings/health');await page.waitForFunction(()=>document.body.textContent.includes('浏览器需要人工处理'));const section=page.locator('[data-settings-view="health"]');await section.getByText('告警历史',{exact:true}).click();assert.match(await section.textContent(),/持续中/);assert.match(await section.textContent(),/<img/);assert.equal(await section.locator('img').count(),0);
 await section.getByText(date+' · 调用 4 次 · 1234 token',{exact:true}).click();assert.match(await section.textContent(),/公开：入站 4 · 回复 2/);assert.match(await section.textContent(),/P90 2000 ms/);
 await section.getByText('健康与披露配置',{exact:true}).click();await section.getByLabel('简介披露词（每行一项）',{exact:true}).fill('AI\n自动化');await section.getByLabel('轮次软超时（分钟）',{exact:true}).fill('9');await section.getByRole('button',{name:'保存健康配置',exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('健康配置已保存'));
 const saved=fx.calls.filter(c=>c.path==='/api/health/settings'&&c.method==='PUT').at(-1);assert.equal(saved.body.revision,0);assert.deepEqual(saved.body.requiredPhrases,['AI','自动化']);assert.equal(saved.body.softTimeoutMinutes,9);assert.equal(fx.calls.filter(c=>c.path.startsWith('/api/control/')).length,0);await page.screenshot({path:OUT+'/health-settings-report.png',fullPage:true});
});
await check('消息分级参数、名单、冷却解除与每日额度',async()=>{
 await page.goto(BASE+'/#/settings/triage');await page.waitForSelector('[data-settings-view="triage"] textarea');const section=page.locator('[data-settings-view="triage"]');assert.match(await section.textContent(),/今日公开额度\s*17 \/ 180/);assert.match(await section.textContent(),/近 24 小时私信 12 \/ 400/);assert.match(await section.textContent(),/批量广告/);assert.match(await section.textContent(),/优先/);
 await section.getByLabel(/^优先公开账号/).fill('person\nfriend');await section.getByLabel(/^广告关键词/).fill('广告\n空投');await section.getByLabel('批量重复阈值',{exact:true}).fill('4');await page.getByRole('button',{name:'保存分级设置',exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('分级设置已保存'));
 const saved=fx.calls.filter(c=>c.path==='/api/triage/settings'&&c.method==='PUT').at(-1);assert.equal(saved.body.revision,0);assert.deepEqual(saved.body.settings.priorityPublicHandles,['person','friend']);assert.deepEqual(saved.body.settings.advertisingKeywords,['广告','空投']);assert.equal(saved.body.settings.batchThreshold,4);
 await section.getByText('骚扰冷却名单',{exact:true}).click();await section.getByRole('button',{name:'解除冷却',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('没有处于骚扰冷却的用户'));assert.deepEqual(fx.calls.filter(c=>c.path==='/api/triage/ignores'&&c.method==='DELETE').at(-1).body,{userId:'noisy',channel:'public'});await page.screenshot({path:OUT+'/triage-settings-summary.png',fullPage:true});
});
await check('字数未知、过期、无账号模拟与显式刷新',async()=>{
 for(const [state,text]of [['unknown','没有已验收长帖证据'],['stale','能力缓存已过期'],['none','当前账号未确认，使用普通账号模拟限制']]){
  const c=await browser.newContext({viewport:{width:1440,height:1100}}),p=await c.newPage(),mock=await fixtures(p);mock.setPosting(state);
  try{await p.goto(BASE+'/#/settings/limits');await p.waitForSelector('#posting-limits');await p.waitForFunction(text=>document.getElementById('posting-limits')?.textContent.includes(text),text);const box=p.locator('#posting-limits');assert.match(await box.textContent(),/280 加权字符/);
   const before=mock.calls.filter(c=>c.path==='/api/account/posting-limits/refresh').length,refreshed=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/account/posting-limits/refresh'&&r.request().method()==='POST');await box.getByRole('button',{name:'重新读取',exact:true}).click();await refreshed;await p.waitForFunction(text=>document.getElementById('posting-limits')?.textContent.includes(text),text);assert.equal(mock.calls.filter(c=>c.path==='/api/account/posting-limits/refresh').length,before+1);assert.equal(mock.calls.filter(c=>c.path.startsWith('/api/control/')).length,0);await p.screenshot({path:OUT+'/posting-'+state+'.png',fullPage:true});
  }catch(error){result.errors.push({name:'字数字段诊断 '+state,error:error.stack||String(error),visibleText:await p.locator('#view').innerText(),requests:mock.calls.map(x=>({path:x.path,method:x.method}))});throw error;}finally{await c.close();}
 }
});
await check('帖子详情调用缓存与字数元数据、旧消息缺失元数据',async()=>{
 await page.goto(BASE+'/#/feed/c/posts');await page.waitForSelector('.feed-item[data-id="post:p1"]');const post=page.locator('.feed-item[data-id="post:p1"]');await post.locator('.feed-details-button').click();await page.waitForFunction(()=>document.querySelector('.feed-inspector')?.textContent.includes('缓存读取 45 token'));
 const inspector=page.locator('.feed-inspector');assert.match(await inspector.textContent(),/call-post/);assert.match(await inspector.textContent(),/字数校验：3 \/ 280 加权字符/);assert.match(await inspector.textContent(),/sample-policy/);assert.equal(await inspector.getByRole('link',{name:'平台回执 ↗',exact:true}).first().getAttribute('href'),'https://x.com/tester/status/456');
 await page.goto(BASE+'/#/feed/c/x%3Aperson');const old=page.locator('.feed-item[data-id="message:old"]');await old.waitFor();await old.locator('.feed-details-button').click();await page.waitForFunction(()=>document.querySelector('.feed-inspector')?.textContent.includes('call-legacy'));assert.match(await inspector.textContent(),/缓存读取 未知 token/);assert.match(await inspector.textContent(),/token 未知/);assert.equal(await page.locator('#view img').count(),0);assert.equal(await page.evaluate(()=>window.__injected),undefined);await page.screenshot({path:OUT+'/feed-post-validation-cache.png',fullPage:true});
});
await check('专项窄屏深色布局',async()=>{await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:375,height:1100});for(const [route,target]of [['feed','feed/c/posts'],['settings/health','settings/health'],['settings/triage','settings/triage'],['persona','persona/p/current/replay']]){await page.goto(BASE+'/#/'+target);await page.waitForSelector('.ws-shell');if(route==='persona')await page.getByRole('button',{name:'预览真实样本',exact:true}).waitFor();else if(route.startsWith('settings/'))await page.locator('[data-settings-view]').waitFor();else await page.waitForSelector('.feed-item');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,route+' 横向溢出');await page.screenshot({path:OUT+'/proposals-dark-375-'+route.replace('/','-')+'.png',fullPage:true});}});
await context.close();await browser.close();writeFileSync(OUT+'/proposals-ui-acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(result.errors.length)process.exitCode=1;
