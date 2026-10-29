// 服务器 Camoufox 专项验收；全部接口均由本脚本拦截为合成资料。
// 不 import 其他会自行执行的验收脚本，不连接真实服务商或 X 账号。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';

const BASE=process.env.PANEL_URL||'http://127.0.0.1:8081';
const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const now=Date.now(),fakeKey='ui-fixture-api-key-001234',calls=[],unexpected=[];
const report={evidence:'服务器 Camoufox + 合成 API；无真实模型调用、平台读取或发送',checks:[],errors:[],screenshots:[],skipped:[]};
let revision=7,failNextStars=false;
const info=(id,over={})=>({id,name:id,api:'anthropic-messages',baseUrl:'https://catalogue.example',contextWindow:131072,maxTokens:8192,reasoning:true,vision:true,levels:['off','high'],cost:{input:1,output:2,cacheRead:.1,cacheWrite:.25},costKnown:true,...over});
const extraModels=Array.from({length:28},(_,i)=>{
 const id=`extra-model-${String(i+1).padStart(2,'0')}`;
 return {
  id,
  source:'catalog',
  params:{reasoningLevel:'off'},
  info:info(id,{reasoning:i%2===0,vision:i%3===0}),
  ...(i>=2&&i<4?{lastUsedAt:now-(i+1)*3600_000}:{}),
  active:false
 };
});
const library={version:1,providers:[
 {
  key:'anthropic',
  provider:'anthropic',
  name:'目录接口',
  baseUrl:'https://catalogue.example',
  hasKey:true,
  keyHint:'••••1111',
  ready:true,
  active:true,
  starred:['known-catalogue','extra-model-01','extra-model-02'],
  models:[
   {id:'known-catalogue',source:'catalog',params:{reasoningLevel:'off'},info:info('known-catalogue'),lastTest:{ok:true,at:now,latencyMs:173},lastUsedAt:now-1000,active:true},
   {id:'unknown-candidate',source:'discovered',params:{reasoningLevel:'off'},info:null,active:false},
   ...extraModels
  ]
 },
 {
  key:'custom-backup',
  provider:'custom',
  name:'备用接口',
  baseUrl:'https://backup.example/v1',
  api:'openai-completions',
  hasKey:true,
  keyHint:'••••2222',
  ready:true,
  active:false,
  starred:[],
  models:[
   {id:'backup-model',source:'manual',api:'openai-completions',params:{reasoningLevel:'low'},info:info('backup-model',{api:'openai-completions',levels:['off','low','medium','high'],vision:false,costKnown:false}),lastTest:{ok:true,at:now,latencyMs:29},active:false},
  ]
 },
],active:{default:{key:'anthropic',modelId:'known-catalogue'}}};

const catalogProviders=[
 {id:'anthropic',name:'Anthropic',group:'intl',baseUrl:'https://catalogue.example',apis:['anthropic-messages'],available:true,modelCount:2},
 {id:'locked',name:'未接入目录项',group:'cn',available:false,reason:'需要尚未接入的认证',apis:[]},
 ...Array.from({length:38},(_,i)=>({id:`cat-${i+1}`,name:`目录服务商 ${i+1}`,group:i%2===0?'cn':'intl',baseUrl:`https://cat-${i+1}.example/v1`,apis:['openai-completions'],available:true,modelCount:5}))
];

const view=()=>structuredClone({...library,revision});
const entries=path=>calls.filter(call=>call.path===path);
let holdStatus=false,statusPending=0;
const statusWaiters=[];
function releaseStatus(){holdStatus=false;for(const resolve of statusWaiters.splice(0))resolve();}
const browser=await observer(),context=await browser.newContext({viewport:{width:1440,height:868}}),page=await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror',error=>report.errors.push({name:'页面异常',error:error.stack||String(error)}));

await page.route('**/api/**',async route=>{
 const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();let body;try{body=request.postDataJSON();}catch{}
 calls.push({path,method,body});
 const send=(json,status=200)=>route.fulfill({status,json});
 if(path==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:'retry: 5000\nevent: feed\ndata: {"latest":1,"pending":0}\n\n'});
 if(path==='/api/status'){
  if(holdStatus){statusPending++;await new Promise(resolve=>statusWaiters.push(resolve));statusPending--;}
  return send({control:'paused',busy:false,accountId:'ui-fixture',browser:{loggedIn:true,needsHuman:false,handle:'ui-fixture'},config:{mode:'draft',model:{configured:true,provider:library.active.default.key,id:library.active.default.modelId}},cooldown:{},stats:{messages:[],usage:{calls:0}}});
 }
 if(path==='/api/program')return send({control:'paused',revision:0,settings:{mode:'draft',maxAgeHours:3,maxPerRound:2,publicPerHour:10,privatePerHour:30,publicPerDay:180},stages:[],queue:{items:[],counts:[]},cooldown:{}});
 if(path==='/api/memory/policy')return send({policy:{recentCount:3,recentDays:7,retentionDays:30},revision:0});
 if(path==='/api/model/providers')return send(catalogProviders);
 if(path==='/api/model'&&method==='GET')return send({settings:null,effective:null,revision:0,library:view()});
 if(method!=='GET'&&path.startsWith('/api/model/')){
  if(!body||body.revision!==revision)return send({error:'合成接口检测到修订号未链式传递',revision},409);
  if(path==='/api/model/library'&&method==='POST'){
   if(body.apiKey!==fakeKey||'key'in body)return send({error:'合成接口要求 apiKey 字段'},400);
   const provider={key:'custom-added',provider:body.provider,name:body.name,baseUrl:body.baseUrl,hasKey:true,keyHint:'••••1234',ready:false,active:false,starred:[],models:[{id:'added-model',source:'discovered',api:'openai-completions',params:{reasoningLevel:'off'},custom:{contextWindow:128000,reasoning:false},info:null,active:false}]};
   library.providers.push(provider);revision++;return send(view());
  }
  if(path==='/api/model/active'&&method==='PUT'){
   const provider=library.providers.find(p=>p.key===body.key),model=provider?.models.find(m=>m.id===body.modelId);if(!provider||!model)return send({error:'不存在的合成模型'},404);
   if(!model.info&&!model.custom)return send({error:'未知模型尚未填写上下文及推理参数'},400);
   if(!model.lastTest?.ok&&body.confirmUntested!==true)return send({error:'需要明确确认未测试模型'},409);
   library.active.default={key:provider.key,modelId:model.id};for(const p of library.providers){p.active=p.key===provider.key;for(const m of p.models)m.active=p.active&&m.id===model.id;}revision++;return send(view());
  }
  const parts=path.split('/'),provider=library.providers.find(p=>p.key===decodeURIComponent(parts[4]||''));if(!provider)return send({error:'合成服务商不存在'},404);
  if(parts.length===5&&method==='PUT'){
   if(provider.provider!=='custom'&&'api'in body)return send({error:'目录协议必须由模型自动选择'},400);
   Object.assign(provider,{name:body.name??provider.name,baseUrl:body.baseUrl??provider.baseUrl});revision++;return send(view());
  }
  if(parts[5]==='stars'&&method==='PUT'){
   if(failNextStars){failNextStars=false;return send({error:'合成星标保存失败'},500);}
   const valid=new Set(provider.models.map(m=>m.id));
   provider.starred=[...new Set((body.ids||[]).filter(id=>valid.has(id)))];
   revision++;return send(view());
  }
  if(parts[5]==='models'){
   const id=decodeURIComponent(parts[6]),model=provider.models.find(m=>m.id===id);
   if(parts.length===7&&method==='PUT'){
    if(!model){
     const created={id,source:'manual',api:body.api||'openai-completions',params:structuredClone(body.params||{reasoningLevel:'off'}),...(body.custom?{custom:structuredClone(body.custom)}:{})};
     provider.models.push(created);revision++;return send(view());
    }
    model.params=structuredClone(body.params);
    if(body.api)model.api=body.api;
    if(body.custom)model.custom=structuredClone(body.custom);
    delete model.lastTest;revision++;return send(view());
   }
   if(!model)return send({error:'合成模型不存在'},404);
   if(parts[7]==='test'&&method==='POST'){model.lastTest={ok:true,at:now,latencyMs:241};revision++;return send({result:model.lastTest,library:view()});}
  }
 }
 if(method==='GET'&&path==='/api/tasks')return send({tasks:[],revision:0});
 if(method==='GET'&&path==='/api/tasks/runs')return send({items:[],counts:[],nextCursor:null});
 if(method==='GET'&&path==='/api/triage/summary')return send({queues:[],reasons:[],publicToday:0,publicPerDay:180,privateRecent:0,privatePerDay:400});
 if(method==='GET'&&path==='/api/billing/summary')return send({totals:{costUSD:0,unpriced:0},daily:[],models:[],purposes:[]});
 if(method==='GET'&&path==='/api/health')return send({status:'normal',metrics:[],activeAlerts:[]});
 unexpected.push({path,method});return send({error:'未定义的合成接口 '+path},404);
});

function persist(){report.requests={total:calls.length,writes:calls.filter(c=>c.method!=='GET').map(c=>({path:c.path,method:c.method,revision:c.body?.revision,fields:Object.keys(c.body||{})})),unexpected};writeFileSync(OUT+'/model-library-ui-acceptance.json',JSON.stringify(report,null,2));}
let failed=false;
async function check(name,fn){
 if(failed&&!name.includes('截图')){report.skipped.push(name);console.log('[跳过] '+name+'：先处理前一失败');persist();return;}
 report.inProgress=name;console.log('[开始] '+name);persist();
 try{await fn();report.checks.push(name);console.log('[通过] '+name);}
 catch(error){failed=true;releaseStatus();let ui;try{ui=await page.evaluate(()=>({notice:document.querySelector('#notice')?.textContent,modal:document.querySelector('.modal-card h2')?.textContent,provider:document.querySelector('.provider-detail h3')?.textContent,models:[...document.querySelectorAll('.model-row')].map(e=>({id:e.querySelector('b')?.textContent,buttons:[...e.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled}))}))}));}catch{}report.errors.push({name,error:error.stack||String(error),ui});console.log('[失败] '+name+'：'+String(error));try{const file='model-library-failure-'+report.errors.length+'.png';await page.screenshot({path:OUT+'/'+file,fullPage:true,timeout:3000});report.screenshots.push(file);}catch{}}
 finally{delete report.inProgress;persist();}
}
const row=id=>page.locator('.model-row').filter({has:page.getByText(id,{exact:true})});
const provider=name=>page.locator('.provider-sidebar .provider-row').filter({hasText:name});
async function choose(name){await provider(name).click();await page.waitForFunction(name=>document.querySelector('.provider-detail h3')?.textContent===name,name);}
async function waitModal(title){const modal=page.locator('.modal-card');await modal.getByRole('heading',{name:title,exact:true}).waitFor();return modal;}
async function clearNotice(){await page.evaluate(()=>{const notice=document.querySelector('#notice');if(notice)notice.textContent='';});}
async function waitNotice(text){await page.waitForFunction(text=>document.querySelector('#notice')?.textContent===text,text);}
async function clickWithResponse(locator,path,method='POST'){const [response]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method),locator.click()]);assert.equal(response.status(),200);return response;}
async function confirmUnknown(){const modal=await waitModal('该模型尚未通过测试');await clearNotice();await clickWithResponse(modal.getByRole('button',{name:'仍然使用',exact:true}),'/api/model/active','PUT');await page.waitForFunction(()=>!document.querySelector('.modal-card'));}

await check('左栏仅列已添加服务商，三块分组、14行可见、缓存价提示与协议归属模型',async()=>{
 await page.goto(BASE+'/#/settings/model');await row('known-catalogue').waitFor();
 // 40 个目录服务商中左栏只出现已添加的 2 个
 assert.equal(await page.locator('.provider-sidebar .provider-row').count(),2);
 // 页面上不直接展示 Base URL、协议下拉或 API Key
 assert.equal(await page.locator('#base-url,#api-key').count(),0);
 // 页头没有动作按钮
 assert.equal(await page.locator('.settings-actions button').count(),0);
 // 三块分组：星标 3 个、最近使用 2 个（extra-model-03、extra-model-04，因 known-catalogue 已在星标）、其他 25 个
 assert.equal(await page.locator('.model-row[data-section="starred"]').count(),3);
 assert.equal(await page.locator('.model-row[data-section="recent"]').count(),2);
 assert.equal(await page.locator('.model-row[data-section="other"]').count(),25);
 // 1440×868 下首屏可见不少于 14 行模型
 const visibleRows=await page.locator('.model-row').evaluateAll(rows=>rows.filter(r=>{const b=r.getBoundingClientRect();return b.top>=0&&b.bottom<=window.innerHeight;}).length);
 assert.ok(visibleRows>=14,`1440x868 首屏可见模型行数不足 14：实际 ${visibleRows}`);
 // 推理/看图 SVG title 与测试耗时
 const text=await row('known-catalogue').textContent();
 assert.match(text,/支持推理/);assert.match(text,/支持看图/);assert.match(text,/173\s*ms/);
 // 价格提示框包含四项单价与来自 pi 目录
 const tipText=await row('known-catalogue').locator('.model-price-tip').textContent();
 assert.match(tipText,/输入/);assert.match(tipText,/输出/);assert.match(tipText,/缓存读取/);assert.match(tipText,/缓存写入/);assert.match(tipText,/来自 pi 目录/);
 // 搜索同时过滤三块
 await page.locator('#model-search').fill('extra-model-0');
 assert.equal(await page.locator('.model-row[data-section="starred"]').count(),2);
 assert.equal(await page.locator('.model-row[data-section="recent"]').count(),2);
 await page.locator('#model-search').fill('');
});

await check('星标键盘移动排序与保存失败回滚',async()=>{
 const firstStar=page.locator('.model-row[data-section="starred"]').first();
 assert.equal(await firstStar.getAttribute('data-model-id'),'known-catalogue');
 await firstStar.focus();
 const [res]=await Promise.all([
  page.waitForResponse(r=>new URL(r.url()).pathname==='/api/model/library/anthropic/stars'&&r.request().method()==='PUT'),
  page.keyboard.press('Alt+ArrowDown')
 ]);
 assert.equal(res.status(),200);
 const savedIds=entries('/api/model/library/anthropic/stars').at(-1).body.ids;
 assert.deepEqual(savedIds,['extra-model-01','known-catalogue','extra-model-02']);
 // 接口失败时回滚
 failNextStars=true;
 const secondStar=page.locator('.model-row[data-section="starred"]').nth(1);
 await secondStar.focus();
 await page.keyboard.press('Alt+ArrowDown');
 await page.waitForFunction(()=>document.querySelector('#notice')?.textContent?.includes('星标保存失败'));
 const rolledBack=await page.locator('.model-row[data-section="starred"]').evaluateAll(rows=>rows.map(r=>r.getAttribute('data-model-id')));
 assert.deepEqual(rolledBack,['extra-model-01','known-catalogue','extra-model-02']);
});

await check('未知目录模型设使用中先填写参数，再明确确认未测试模型',async()=>{
 const before=entries('/api/model/active').length;await row('unknown-candidate').hover();await row('unknown-candidate').getByRole('button',{name:'设为使用中',exact:true}).click();const modal=await waitModal('编辑模型参数');assert.equal(entries('/api/model/active').length,before);await modal.getByLabel('上下文长度（token）',{exact:true}).fill('65536');await modal.getByLabel('支持推理',{exact:true}).check();await modal.getByLabel(/^推理强度/).selectOption('high');await modal.getByRole('button',{name:'保存参数',exact:true}).click();holdStatus=true;await confirmUnknown();await row('unknown-candidate').getByText('使用中',{exact:true}).waitFor();
 const saved=entries('/api/model/library/anthropic/models/unknown-candidate').at(-1);assert.deepEqual(saved.body.custom,{contextWindow:65536,reasoning:true});assert.deepEqual(saved.body.params,{reasoningLevel:'high'});const active=entries('/api/model/active').at(-1);assert.equal(active.body.confirmUntested,true);assert.equal(active.body.revision,saved.body.revision+1);assert.equal(library.active.default.modelId,'unknown-candidate');
});

await check('状态刷新挂起时新行立即可测试，结果展示实际耗时',async()=>{
 assert.equal(holdStatus,true);const before=entries('/api/model/library/anthropic/models/unknown-candidate/test').length;await row('unknown-candidate').hover();await clickWithResponse(row('unknown-candidate').getByRole('button',{name:/^测试/}),'/api/model/library/anthropic/models/unknown-candidate/test');assert.equal(entries('/api/model/library/anthropic/models/unknown-candidate/test').length,before+1);assert.ok(statusPending>0,'测试请求发生时全局状态刷新仍被门控挂起');await page.waitForFunction(()=>[...document.querySelectorAll('.model-row')].some(e=>e.textContent.includes('unknown-candidate')&&e.textContent.includes('241 ms')));assert.match(await row('unknown-candidate').textContent(),/241\s*ms/);report.delayedStatus={testSentBeforeStatusRelease:true,pendingAtTest:statusPending};releaseStatus();await waitNotice('测试已完成');
});

await check('切换服务商与使用中模型来回保留参数、模型协议选项及编辑窗口Key掩码',async()=>{
 await choose('备用接口');await clearNotice();await row('backup-model').hover();await clickWithResponse(row('backup-model').getByRole('button',{name:'设为使用中',exact:true}),'/api/model/active','PUT');await waitNotice('使用中模型已切换');await row('backup-model').getByText('使用中',{exact:true}).waitFor();await row('backup-model').hover();await row('backup-model').getByRole('button',{name:'编辑',exact:true}).click();let modal=await waitModal('编辑模型参数');assert.equal(await modal.getByLabel('回复长度上限（token）',{exact:true}).count(),0);assert.equal(await modal.getByLabel('超时（秒）',{exact:true}).count(),0);assert.equal(await modal.getByLabel('接口协议',{exact:true}).inputValue(),'openai-completions');assert.equal(await modal.getByLabel(/^推理强度/).inputValue(),'low');await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await choose('目录接口');await clearNotice();await row('unknown-candidate').hover();await clickWithResponse(row('unknown-candidate').getByRole('button',{name:'设为使用中',exact:true}),'/api/model/active','PUT');await waitNotice('使用中模型已切换');await row('unknown-candidate').getByText('使用中',{exact:true}).waitFor();assert.equal(library.active.default.modelId,'unknown-candidate');await row('unknown-candidate').hover();await row('unknown-candidate').getByRole('button',{name:'编辑',exact:true}).click();modal=await waitModal('编辑模型参数');assert.match(await modal.locator('.protocol-auto').textContent(),/目录自带/);assert.equal(await modal.getByLabel('上下文长度（token）',{exact:true}).inputValue(),'65536');assert.equal(await modal.getByLabel('回复长度上限（token）',{exact:true}).count(),0);assert.equal(await modal.getByLabel('超时（秒）',{exact:true}).count(),0);assert.equal(await modal.getByLabel(/^推理强度/).inputValue(),'high');assert.equal(await modal.getByLabel('支持推理',{exact:true}).isChecked(),true);await modal.getByRole('button',{name:'关闭',exact:true}).click();
 // 打开服务商编辑窗口验证 Key 掩码、主机变更清空 Key、以及使用中禁用删除
 await provider('目录接口').locator('button[aria-label="编辑服务商"]').click();
 modal=await waitModal('编辑服务商');
 assert.match(await modal.locator('#api-key').getAttribute('placeholder'),/1111/);
 assert.equal(await modal.locator('#api-key').inputValue(),'');
 assert.equal(await modal.locator('#provider-delete').isDisabled(),true);
 await modal.locator('#api-key').fill('temp-key');
 await modal.locator('#base-url').fill('https://another-host.example/v1');
 assert.equal(await modal.locator('#api-key').inputValue(),'');
 assert.match(await modal.locator('#api-key').getAttribute('placeholder'),/重新填写/);
 await modal.getByRole('button',{name:'关闭',exact:true}).click();
});

await check('添加服务商窗口不要求协议，发送apiKey及当前revision后选中新服务商',async()=>{
 await page.locator('#provider-add').click();await page.getByRole('button',{name:'自定义端点',exact:true}).click();const modal=await waitModal('添加服务商');
 assert.equal(await modal.getByLabel('接口协议',{exact:true}).count(),0);
 await modal.getByLabel('名称',{exact:true}).fill('第三接口');await modal.getByLabel('Base URL',{exact:true}).fill('https://third.example/v1');await modal.getByLabel('API Key',{exact:true}).fill(fakeKey);const current=revision;await modal.getByRole('button',{name:'添加并拉取模型',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.provider-detail h3')?.textContent==='第三接口');const call=entries('/api/model/library').at(-1);assert.equal(call.body.apiKey,fakeKey);assert.equal(call.body.revision,current);assert.equal('key'in call.body,false);assert.equal('api'in call.body,false);assert.equal(library.providers.length,3);assert.ok(!(await page.locator('#view').textContent()).includes(fakeKey));
});

await check('状态刷新挂起时编辑窗口保存仍可执行，目录协议不伪造且仍暂停',async()=>{
 await choose('目录接口');await clearNotice();holdStatus=true;const before=entries('/api/model/library/anthropic').length;
 await provider('目录接口').locator('button[aria-label="编辑服务商"]').click();
 await waitModal('编辑服务商');
 await clickWithResponse(page.locator('#provider-save'),'/api/model/library/anthropic','PUT');
 await page.waitForFunction(()=>!document.querySelector('.modal-card'));
 await provider('目录接口').locator('button[aria-label="编辑服务商"]').click();
 await waitModal('编辑服务商');
 await clickWithResponse(page.locator('#provider-save'),'/api/model/library/anthropic','PUT');
 assert.equal(entries('/api/model/library/anthropic').length,before+2);assert.ok(statusPending>0,'第二次保存发生时全局状态刷新仍被门控挂起');report.delayedStatus={...report.delayedStatus,saveSentBeforeStatusRelease:true,pendingAtSave:statusPending};releaseStatus();await waitNotice('连接已保存');const call=entries('/api/model/library/anthropic').at(-1);assert.equal('api'in call.body,false);assert.equal(entries('/api/control/resume').length,0);assert.equal(entries('/api/control/takeover').length,0);
});

await check('375/1440浅深主题无溢出并保存四张专项截图',async()=>{
 for(const scheme of ['light','dark'])for(const width of [1440,375]){
  await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width,height:1000});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,scheme+' '+width+' 横向溢出');if(width===375)assert.equal(await page.locator('.provider-mobile').isVisible(),true);const file='model-library-'+scheme+'-'+width+'.png';await page.screenshot({path:OUT+'/'+file,fullPage:true});report.screenshots.push(file);
 }
});
if(unexpected.length)report.errors.push({name:'未定义接口',error:JSON.stringify(unexpected)});
releaseStatus();await context.close();await browser.close();persist();console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
