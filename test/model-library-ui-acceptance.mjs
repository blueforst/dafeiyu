// 服务器 Camoufox 专项验收；全部接口均由本脚本拦截为合成资料。
// 不 import 其他会自行执行的验收脚本，不连接真实服务商或 X 账号。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';

const BASE=process.env.PANEL_URL||'http://127.0.0.1:8081';
const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const now=Date.now(),fakeKey='ui-fixture-api-key-001234',calls=[],unexpected=[];
const report={evidence:'服务器 Camoufox + 合成 API；无真实模型调用、平台读取或发送',checks:[],errors:[],screenshots:[],skipped:[]};
let revision=7;
const info=(id,over={})=>({id,name:id,api:'anthropic-messages',baseUrl:'https://catalogue.example',contextWindow:131072,maxTokens:8192,reasoning:true,vision:true,levels:['off','high'],cost:{input:1,output:2},costKnown:true,...over});
const library={version:1,providers:[
 {key:'anthropic',provider:'anthropic',name:'目录接口',baseUrl:'https://catalogue.example',hasKey:true,keyHint:'••••1111',ready:true,active:true,models:[
  {id:'known-catalogue',source:'catalog',params:{reasoningLevel:'off',maxTokens:4096,timeoutMs:60000},info:info('known-catalogue'),lastTest:{ok:true,at:now,latencyMs:173},active:true},
  {id:'unknown-candidate',source:'discovered',params:{reasoningLevel:'off',maxTokens:4096,timeoutMs:60000},info:null,active:false},
 ]},
 {key:'custom-backup',provider:'custom',name:'备用接口',baseUrl:'https://backup.example/v1',api:'openai-completions',hasKey:true,keyHint:'••••2222',ready:true,active:false,models:[
  {id:'backup-model',source:'manual',params:{reasoningLevel:'low',maxTokens:3072,timeoutMs:45000},info:info('backup-model',{api:'openai-completions',levels:['off','low','medium','high'],vision:false,costKnown:false}),lastTest:{ok:true,at:now,latencyMs:29},active:false},
 ]},
],active:{default:{key:'anthropic',modelId:'known-catalogue'}}};
const view=()=>structuredClone({...library,revision});
const entries=path=>calls.filter(call=>call.path===path);
let holdStatus=false,statusPending=0;
const statusWaiters=[];
function releaseStatus(){holdStatus=false;for(const resolve of statusWaiters.splice(0))resolve();}
const browser=await observer(),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
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
 if(path==='/api/program')return send({control:'paused',revision:0,settings:{mode:'draft',maxAgeHours:6,maxPerRound:2,publicPerHour:10,privatePerHour:30,publicPerDay:180},stages:[],queue:{items:[],counts:[]},cooldown:{}});
 if(path==='/api/memory/policy')return send({policy:{recentCount:3,recentDays:7,retentionDays:30},revision:0});
 if(path==='/api/model/providers')return send([{id:'anthropic',name:'Anthropic',group:'intl',baseUrl:'https://catalogue.example',apis:['anthropic-messages'],available:true,modelCount:2},{id:'locked',name:'未接入目录项',group:'cn',available:false,reason:'需要尚未接入的认证',apis:[]}]);
 if(path==='/api/model'&&method==='GET')return send({settings:null,effective:null,revision:0,library:view()});
 if(method!=='GET'&&path.startsWith('/api/model/')){
  if(!body||body.revision!==revision)return send({error:'合成接口检测到修订号未链式传递',revision},409);
  if(path==='/api/model/library'&&method==='POST'){
   if(body.apiKey!==fakeKey||'key'in body)return send({error:'合成接口要求 apiKey 字段'},400);
   const provider={key:'custom-added',provider:body.provider,name:body.name,baseUrl:body.baseUrl,api:body.api,hasKey:true,keyHint:'••••1234',ready:false,active:false,models:[{id:'added-model',source:'discovered',params:{maxTokens:4096,timeoutMs:60000,reasoningLevel:'off'},custom:{contextWindow:128000,reasoning:false},info:null,active:false}]};library.providers.push(provider);revision++;return send(view());
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
   Object.assign(provider,{name:body.name??provider.name,baseUrl:body.baseUrl??provider.baseUrl,...(body.api?{api:body.api}:{})});revision++;return send(view());
  }
  if(parts[5]==='models'){
   const id=decodeURIComponent(parts[6]),model=provider.models.find(m=>m.id===id);if(!model)return send({error:'合成模型不存在'},404);
   if(parts.length===7&&method==='PUT'){model.params=structuredClone(body.params);if(body.custom)model.custom=structuredClone(body.custom);delete model.lastTest;revision++;return send(view());}
   if(parts[7]==='test'&&method==='POST'){model.lastTest={ok:true,at:now,latencyMs:241};revision++;return send({result:model.lastTest,library:view()});}
  }
 }
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

await check('目录协议按目录元数据展示，模型推理/看图标记与测试耗时可见',async()=>{
 await page.goto(BASE+'/#/settings/model');await row('known-catalogue').waitFor();assert.match(await page.locator('.protocol-auto').textContent(),/按模型自动选择/);assert.match(await page.locator('.protocol-auto').textContent(),/anthropic-messages|Anthropic/i);const text=await row('known-catalogue').textContent();assert.match(text,/支持推理/);assert.match(text,/支持看图/);assert.match(text,/173\s*ms/);assert.equal(await page.locator('#api-key').inputValue(),'');
});
await check('未知目录模型设使用中先填写参数，再明确确认未测试模型',async()=>{
 const before=entries('/api/model/active').length;await row('unknown-candidate').getByRole('button',{name:'设为使用中',exact:true}).click();const modal=await waitModal('编辑模型参数');assert.equal(entries('/api/model/active').length,before);await modal.getByLabel('上下文长度（token）',{exact:true}).fill('65536');await modal.getByLabel('支持推理',{exact:true}).check();await modal.getByLabel('回复长度上限（token）',{exact:true}).fill('2048');await modal.getByLabel('超时（秒）',{exact:true}).fill('70');await modal.getByLabel(/^推理强度/).selectOption('high');await modal.getByRole('button',{name:'保存参数',exact:true}).click();holdStatus=true;await confirmUnknown();await row('unknown-candidate').getByText('使用中',{exact:true}).waitFor();
 const saved=entries('/api/model/library/anthropic/models/unknown-candidate').at(-1);assert.deepEqual(saved.body.custom,{contextWindow:65536,reasoning:true});assert.deepEqual(saved.body.params,{maxTokens:2048,timeoutMs:70000,reasoningLevel:'high'});const active=entries('/api/model/active').at(-1);assert.equal(active.body.confirmUntested,true);assert.equal(active.body.revision,saved.body.revision+1);assert.equal(library.active.default.modelId,'unknown-candidate');
});
await check('状态刷新挂起时新行立即可测试，结果展示实际耗时',async()=>{
 // 前一组仅等待新行的“使用中”，没有等待 notice 或 /api/status 返回。
 assert.equal(holdStatus,true);const before=entries('/api/model/library/anthropic/models/unknown-candidate/test').length;await clickWithResponse(row('unknown-candidate').getByRole('button',{name:/^测试/}),'/api/model/library/anthropic/models/unknown-candidate/test');assert.equal(entries('/api/model/library/anthropic/models/unknown-candidate/test').length,before+1);assert.ok(statusPending>0,'测试请求发生时全局状态刷新仍被门控挂起');await page.waitForFunction(()=>[...document.querySelectorAll('.model-row')].some(e=>e.textContent.includes('unknown-candidate')&&e.textContent.includes('241 ms')));assert.match(await row('unknown-candidate').textContent(),/241\s*ms/);report.delayedStatus={testSentBeforeStatusRelease:true,pendingAtTest:statusPending};releaseStatus();await waitNotice('测试已完成');
});
await check('切换服务商与使用中模型来回保留参数及Key掩码',async()=>{
 await choose('备用接口');await clearNotice();await clickWithResponse(row('backup-model').getByRole('button',{name:'设为使用中',exact:true}),'/api/model/active','PUT');await waitNotice('使用中模型已切换');await row('backup-model').getByText('使用中',{exact:true}).waitFor();await row('backup-model').getByRole('button',{name:'编辑',exact:true}).click();let modal=await waitModal('编辑模型参数');assert.equal(await modal.getByLabel('回复长度上限（token）',{exact:true}).inputValue(),'3072');assert.equal(await modal.getByLabel('超时（秒）',{exact:true}).inputValue(),'45');assert.equal(await modal.getByLabel(/^推理强度/).inputValue(),'low');await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await choose('目录接口');await clearNotice();await clickWithResponse(row('unknown-candidate').getByRole('button',{name:'设为使用中',exact:true}),'/api/model/active','PUT');await waitNotice('使用中模型已切换');await row('unknown-candidate').getByText('使用中',{exact:true}).waitFor();assert.equal(library.active.default.modelId,'unknown-candidate');await row('unknown-candidate').getByRole('button',{name:'编辑',exact:true}).click();modal=await waitModal('编辑模型参数');assert.equal(await modal.getByLabel('上下文长度（token）',{exact:true}).inputValue(),'65536');assert.equal(await modal.getByLabel('回复长度上限（token）',{exact:true}).inputValue(),'2048');assert.equal(await modal.getByLabel('超时（秒）',{exact:true}).inputValue(),'70');assert.equal(await modal.getByLabel(/^推理强度/).inputValue(),'high');assert.equal(await modal.getByLabel('支持推理',{exact:true}).isChecked(),true);await modal.getByRole('button',{name:'关闭',exact:true}).click();assert.match(await page.locator('#api-key').getAttribute('placeholder'),/1111/);assert.equal(await page.locator('#api-key').inputValue(),'');
});
await check('添加服务商发送apiKey及当前revision，返回后选中新服务商',async()=>{
 await page.locator('#provider-add').click();await page.getByRole('button',{name:'自定义端点',exact:true}).click();const modal=await waitModal('添加服务商');await modal.getByLabel('名称',{exact:true}).fill('第三接口');await modal.getByLabel('Base URL',{exact:true}).fill('https://third.example/v1');await modal.getByLabel('API Key',{exact:true}).fill(fakeKey);const current=revision;await modal.getByRole('button',{name:'添加并拉取模型',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.provider-detail h3')?.textContent==='第三接口');const call=entries('/api/model/library').at(-1);assert.equal(call.body.apiKey,fakeKey);assert.equal(call.body.revision,current);assert.equal('key'in call.body,false);assert.equal(call.body.api,'openai-completions');assert.equal(library.providers.length,3);assert.ok(!(await page.locator('#view').textContent()).includes(fakeKey));assert.equal(await page.locator('#api-key').inputValue(),'');
});
await check('状态刷新挂起时重绘后的保存仍可执行，目录协议不伪造且仍暂停',async()=>{
 await choose('目录接口');await clearNotice();holdStatus=true;const oldButton=await page.locator('#provider-save').elementHandle(),before=entries('/api/model/library/anthropic').length;await clickWithResponse(page.locator('#provider-save'),'/api/model/library/anthropic','PUT');await page.waitForFunction(element=>!element.isConnected,oldButton);await clickWithResponse(page.locator('#provider-save'),'/api/model/library/anthropic','PUT');assert.equal(entries('/api/model/library/anthropic').length,before+2);assert.ok(statusPending>0,'第二次保存发生时全局状态刷新仍被门控挂起');report.delayedStatus={...report.delayedStatus,saveSentBeforeStatusRelease:true,pendingAtSave:statusPending};releaseStatus();await waitNotice('连接已保存');const call=entries('/api/model/library/anthropic').at(-1);assert.equal('api'in call.body,false);assert.equal(entries('/api/control/resume').length,0);assert.equal(entries('/api/control/takeover').length,0);
});
await check('375/1440浅深主题无溢出并保存四张专项截图',async()=>{
 for(const scheme of ['light','dark'])for(const width of [1440,375]){
  await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width,height:1000});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,scheme+' '+width+' 横向溢出');if(width===375)assert.equal(await page.locator('.provider-mobile').isVisible(),true);const file='model-library-'+scheme+'-'+width+'.png';await page.screenshot({path:OUT+'/'+file,fullPage:true});report.screenshots.push(file);
 }
});
if(unexpected.length)report.errors.push({name:'未定义接口',error:JSON.stringify(unexpected)});
releaseStatus();await context.close();await browser.close();persist();console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
