// 仅在服务器 Camoufox 容器执行；所有业务数据使用模拟接口，不连接生产账号。
import { observer } from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
const BASE=process.env.PANEL_URL||'http://127.0.0.1:8081',OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const now=Date.now(),date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),unsafe='<img src=x onerror="window.__injected=1">';
const result={evidence:'服务器 Camoufox + 模拟 API；没有真实模型调用、X读取或发送',checks:[],errors:[]};
const browser=await observer();
async function fixtures(page,{empty=false,error=false}={}){
 let feedEvent={latest:1,pending:1};
 const calls=[],feed=[{id:'message:m1',messageId:'m1',type:'reply',at:now,status:'draft',revision:10,expired:false,handle:'person',original:unsafe,text:'原始草稿',draft:{action:'reply',text:'原始草稿'},memory:{account:'tester',userId:'person',channel:'public'}},{id:'post:p1',type:'post',at:now-1000,status:'confirmed',revision:1,text:'早安世界',taskId:'morning-post',runId:'run-post',receipt:{platformUrl:'https://x.com/tester/status/456'}}];
 let modelRevision=0,programRevision=0,taskRevision=0,personaRevision=0;
 let library={version:1,revision:0,providers:[{key:'custom-legacy',provider:'custom',name:'测试接口',baseUrl:'https://model.example/v1',api:'openai-completions',hasKey:true,keyHint:'••••1234',ready:true,active:true,models:[{id:'mock',source:'manual',active:true,params:{maxTokens:4096,timeoutMs:60000,reasoningLevel:'off'},lastTest:{ok:true,at:now,latencyMs:10},info:null}]}],active:{default:{key:'custom-legacy',modelId:'mock'}}};
 let program={mode:'draft',maxAgeHours:24,maxPerRound:2,publicPerHour:10,privatePerHour:30,publicPerDay:180};
 let tasks=[['main',true,null,60,'main'],['daily-state',true,'06:00',null,'business'],['memory-summary',true,'03:00',null,'business'],['morning-post',false,'08:00',null,'business'],['evening-post',false,'23:00',null,'business'],['backup',false,'02:30',null,'host'],['health',true,null,300,'host']].map(([id,enabled,time,intervalSeconds,kind])=>({id,title:id,enabled,...(time?{time}:{}),...(intervalSeconds?{intervalSeconds}:{}),kind,nextRunAt:enabled?now+60000:null}));
 let persona={sections:[{id:'role',title:'角色',content:'原始人设 '+unsafe},{id:'style',title:'风格',content:''}],triggers:[{id:'trigger1',title:'问候',condition:'对方问候',content:'自然回应',enabled:true,order:0}]};
 const totals={calls:2,input:30,output:20,cacheRead:10,cacheWrite:0,totalTokens:60,costUSD:null,priced:0,unpriced:2,unknown:0,legacyRows:0};
 const daily={date,status:'ready',scheduleTime:'06:00',today:{date,revision:1,generatedAt:now,source:'automatic',content:{date,fictional:true,periods:[{start:'06:00',end:'24:00',activity:'读书'}],meals:{breakfast:'面包',lunch:'米饭',dinner:'蔬菜'},activities:['阅读'],mood:'平静'}},history:[]};
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method();let body;try{body=req.postDataJSON();}catch{}calls.push({path,method,body,query:Object.fromEntries(url.searchParams)});if(path==='/api/events'){await route.fulfill({status:200,contentType:'text/event-stream',headers:{'Cache-Control':'no-cache'},body:'retry: 250\nevent: feed\ndata: '+JSON.stringify(feedEvent)+'\n\n'});return;}if(error&&path!=='/api/status'){await route.fulfill({status:503,json:{error:'模拟服务不可用'}});return;}let data;
 if(path==='/api/status')data={control:'paused',busy:false,accountId:'tester',browser:{loggedIn:true,needsHuman:false,handle:'tester'},config:{mode:program.mode,model:{configured:true,provider:'custom',id:'mock'}},cooldown:{},stats:{messages:[],usage:totals}};
 else if(path==='/api/feed') {const filter=url.searchParams.get('filter');data={items:empty?[]:filter==='post'?feed.filter(x=>x.type==='post'):filter==='pending'?feed.filter(x=>x.status==='draft'||x.status==='approved'):feed,pending:empty?0:feed.filter(x=>x.status==='draft'||x.status==='approved').length,nextCursor:null};}
 else if(/^\/api\/messages\/m1\/(approve|cancel|regenerate|requeue)$/.test(path)){const action=path.split('/').at(-1),m=feed[0];if(action==='approve'){if(body.text.length>280){await route.fulfill({status:400,json:{error:'公开正文超过长度限制'}});return;}if(body.revision!==m.revision){await route.fulfill({status:409,json:{error:'修订冲突，请重新读取'}});return;}m.status='approved';m.draft.text=body.text;m.text=body.text;}else if(action==='cancel')m.status='draft';else if(action==='regenerate'){m.status='queued';m.draft.review=true;}m.revision++;data={ok:true};}
 else if(path==='/api/messages/m1')data={message:{status:feed[0].status,error:unsafe,receipt:{status:'confirmed',platformUrl:'https://x.com/tester/status/123'}},calls:[{purpose:'reply',model:'mock',provider:'custom',latencyMs:10,usage:{totalTokens:60},pricingStatus:'unpriced'}],outbox:[]};
 else if(path==='/api/model/providers')data=[{id:'deepseek',name:'DeepSeek',group:'cn',baseUrl:'https://api.deepseek.com',available:true},{id:'locked',name:'暂未接入',group:'intl',available:false,reason:'需要额外认证'}];
 else if(path==='/api/model')data={settings:null,effective:null,library:empty?{...library,providers:[],active:{},revision:modelRevision}:{...library,revision:modelRevision}};
 else if(path==='/api/model/library'&&method==='POST'){modelRevision++;library.providers.push({key:'custom-new',provider:body.provider,name:body.name,baseUrl:body.baseUrl,api:body.api,hasKey:true,keyHint:'••••5678',ready:false,models:[{id:'new-model',source:'discovered',custom:{contextWindow:128000,reasoning:false},params:{maxTokens:4096,timeoutMs:60000,reasoningLevel:'off'}}]});data={...library,revision:modelRevision};}
 else if(path==='/api/model/active'){modelRevision++;library.active.default={key:body.key,modelId:body.modelId};for(const p of library.providers){p.active=p.key===body.key;for(const m of p.models)m.active=p.active&&m.id===body.modelId;}data={...library,revision:modelRevision};}
 else if(path.startsWith('/api/model/library/')){modelRevision++;const key=decodeURIComponent(path.split('/')[4]),p=library.providers.find(x=>x.key===key);if(method==='PUT'&&path.split('/').length===5)Object.assign(p,{name:body.name??p.name,baseUrl:body.baseUrl??p.baseUrl,api:body.api??p.api});if(path.endsWith('/test'))data={result:{ok:true},library:empty?{...library,providers:[],active:{},revision:modelRevision}:{...library,revision:modelRevision}};else data={...library,revision:modelRevision};}
 else if(path==='/api/program')data={control:'paused',stage:null,stages:[],queue:{items:[],counts:[]},lastTick:null,nextTick:null,cooldown:{},settings:program,revision:programRevision,limits:{public:{used:0,limit:10},private:{used:0,limit:30}}};
 else if(path==='/api/program/settings'){program={...body.settings};programRevision++;data={settings:program,revision:programRevision};}
 else if(path==='/api/program/logs')data={items:empty?[]:[{id:1,at:now,level:'error',event:'模拟事件',detail:unsafe}],nextCursor:null};
 else if(path==='/api/account/posting-limits'||path==='/api/account/posting-limits/refresh')data={accountId:'tester',simulation:false,post:{status:'unknown',limit:280,checkedAt:now,reason:'未确认长帖能力'},reply:{status:'unknown',limit:280,checkedAt:now,reason:'未确认长帖能力'},effective:{post:{limit:280,unit:'weighted-characters'},reply:{limit:280,unit:'weighted-characters'}}};
 else if(path==='/api/tasks'||/^\/api\/tasks\/[^/]+$/.test(path)){if(method==='PUT'){Object.assign(tasks.find(t=>t.id===path.split('/').at(-1)),body);taskRevision++;}data={revision:taskRevision,tasks,hostAvailable:true,timezone:'Asia/Shanghai'};}
 else if(path==='/api/tasks/runs')data={items:[],nextCursor:null};
 else if(path==='/api/tasks/runs/run-post')data={run:{status:'completed',outboxId:'p1'}};
 else if(path==='/api/memory/policy')data={policy:body?.policy||{recentCount:3,recentDays:7,retentionDays:30},revision:method==='PUT'?1:0};
 else if(path==='/api/memory/users')data={users:empty?[]:[{userId:'person',accountId:'tester',channel:url.searchParams.get('channel')||'public',label:'person',itemCount:1,identityConfirmed:true,lastInteractionAt:now}],nextCursor:null};
 else if(path==='/api/memory/users/person')data={userId:'person',accountId:'tester',channel:url.searchParams.get('channel')||'public',items:[{id:'memory1',type:'fact',text:'记忆内容',revision:1,sourceStatus:'complete',sources:[]}],recent:[],experiences:[]};
 else if(path==='/api/persona'){if(method==='PUT'){persona=body.persona;personaRevision++;}data={persona,revision:personaRevision,fixedRules:'固定系统约束'};}
 else if(path==='/api/persona/preview')data={draft:{action:'reply',text:'模拟回复'},hints:[{kind:'late',text:'这条消息较晚，请自然回应',reason:'消息超过迟到阈值'}],hits:[],segments:[{kind:'static',title:'静态人设',role:'system',stable:true,content:'稳定人设前缀'},{kind:'hints',title:'动态提醒',role:'user',stable:false,content:'迟到提醒'}],meta:{promptVersion:'test-v1',sampleSource:'模拟',sampleCount:1},postingPolicy:{accountId:'tester',simulation:true,rule:{limit:280,unit:'weighted-characters'}},fees:{requests:1,estimatedUsd:null,unpriced:1,unknown:0},latencyMs:10};
 else if(path==='/api/persona/daily')data=daily;
 else if(path==='/api/persona/prompt-hints')data={promptHints:body?.promptHints||{lateEnabled:true,lateMinutes:60,languageEnabled:true,openingEnabled:true,openingCount:12,expressionEnabled:true,kaomojiPer10:1,emojiPer10:2,tildePer10:1,replyCheckEnabled:true},revision:method==='PUT'?1:0};
 else if(path==='/api/persona/replay/runs')data={items:[]};
 else if(path==='/api/triage/settings')data={settings:body?.settings||{normalMaxAgeHours:3,batchThreshold:3,advertisingKeywords:['广告'],greetings:['hi'],priorityPublicHandles:[],priorityPrivateConversations:[]},revision:method==='PUT'?1:0};
 else if(path==='/api/triage/summary')data={queues:[],reasons:[],publicToday:0,publicPerDay:180};
 else if(path==='/api/triage/ignores')data={items:[]};
 else if(path==='/api/health')data={status:'normal',at:now,metrics:[],activeAlerts:[]};
 else if(path==='/api/health/settings')data={settings:{softTimeoutMinutes:8,hardTimeoutMinutes:12,publicCollectionSeconds:90,privateCollectionSeconds:90,rpcTimeoutSeconds:120,memoryRatio:.75,browserMaxAgeHours:24,requiredPhrases:['AI']},revision:0};
 else if(path==='/api/health/alerts'||path==='/api/health/reports')data={items:[]};
 else if(path==='/api/billing/activity'){const start=new Date(date+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-start.getUTCDay()-51*7);data={range:{from:start.toISOString().slice(0,10),to:date,weeks:52},daily:empty?[]:[{date,...totals}],totals:empty?{...totals,calls:0,totalTokens:0,unpriced:0}:totals,peakDailyTokens:empty?0:60,last7:{cache:{read:10,input:30,ratio:null},reply:{calls:0,costUSD:null,averageCostUSD:null}}};}
 else if(path==='/api/billing/summary')data={totals,daily:empty?[]:[{date,...totals}],models:empty?[]:[{provider:'custom',model:'mock',...totals}],purposes:empty?[]:[{purpose:'reply',...totals}],dailyModels:empty?[]:[{date,provider:'custom',model:'mock',...totals}],cache:{read:10,input:30,ratio:null}};
 else if(path==='/api/billing/calls')data={items:empty?[]:[{id:'c1',purpose:'reply',source:'workflow',provider:'custom',model:'mock',status:'completed',startedAt:now,latencyMs:10,usage:totals,cost:null,pricingStatus:'unpriced'}],nextCursor:null};
 else{await route.fulfill({status:404,json:{error:'模拟接口不存在 '+path}});return;}
 await route.fulfill({json:data});});return{calls,feed,emitFeed(payload){feedEvent=payload;}};
}

// 只替换新增统一设计CSS，保留冻结版四页DOM及合成业务数据，验证引入外壳时的逐像素兼容。
const css=readFileSync('/candidate/style.css','utf8'),baselineApp=readFileSync('/baseline/js/app.js','utf8');
for(const scheme of ['light','dark'])for(const width of [1440,375])for(const route of ['feed','memory','settings','billing']){
 let baseline;
 for(const variant of ['before','after']){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:scheme}),page=await context.newPage();page.setDefaultTimeout(12000);await fixtures(page);
  // 对比两侧固定同一个显示时钟，避免相对时间跨分钟造成假差异。
  await page.route('**/js/app.js',r=>r.fulfill({contentType:'text/javascript',body:'Date.now=()=>'+now+';\n'+baselineApp}));
  if(variant==='after')await page.route('**/style.css',r=>r.fulfill({contentType:'text/css',body:css}));
  await page.goto(BASE+'/#/'+route);await page.waitForTimeout(400);await page.locator('#view').waitFor();
  const shot=await page.screenshot({path:OUT+'/'+route+'-'+scheme+'-'+width+'-'+variant+'.png',fullPage:true,animations:'disabled',caret:'hide'});
  if(variant==='before')baseline=shot;else assert.ok(baseline.equals(shot),route+' '+scheme+' '+width+' CSS引入前后截图不一致');
  await context.close();
 }
 result.checks.push(route+' '+scheme+' '+width+' 截图字节完全一致');console.log(result.checks.at(-1));
}
await browser.close();writeFileSync(OUT+'/workspace-style-compatibility.json',JSON.stringify(result,null,2));
