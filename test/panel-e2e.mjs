// 服务器 --network none 隔离验收；真实 dist、SQLite 和模型库配合本地合成模型／浏览器。
import {observer} from '/opt/role-camoufox/launch.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {startPanelFixture} from './panel-isolated-fixture.mjs';

const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const fx=await startPanelFixture(),BASE=fx.baseURL,checks=[];
export function check(name,fn){checks.push({name,fn});}
const waitResponse=(page,...args)=>{const pending=page.waitForResponse(...args);void pending.catch(()=>{});return pending;};
const waitRequest=(page,...args)=>{const pending=page.waitForRequest(...args);void pending.catch(()=>{});return pending;};
const library=async request=>(await (await request.get(BASE+'/api/model')).json()).library;
async function openPanel(page,route='feed'){
 await page.goto(BASE+'/#/'+route);
 await page.locator('#status-pill',{hasText:'已暂停'}).waitFor({timeout:15000});
}
async function openModel(page){await openPanel(page,'settings/model');await page.locator('#provider-add').waitFor();await page.locator('#base-url').waitFor();}
const row=(page,id)=>page.locator('.model-row').filter({has:page.locator('b',{hasText:new RegExp('^'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
const dialog=page=>page.getByRole('dialog');
async function addProvider(page,id='custom'){
 await page.locator('#provider-add').click();
 const catalog=await (await page.request.get(BASE+'/api/model/providers')).json();
 await dialog(page).getByRole('button',{name:id==='custom'?'自定义端点':catalog.find(p=>p.id===id).name,exact:true}).click();
 return dialog(page);
}
async function saveParams(page,id,values={}){
 await row(page,id).getByRole('button',{name:'编辑',exact:true}).click();
 for(const [name,value]of Object.entries(values)){
  const input=dialog(page).getByLabel(name,{exact:true});
  if(typeof value==='boolean')await input.setChecked(value);else await input.fill(String(value));
 }
 const done=waitResponse(page,r=>r.request().method()==='PUT'&&r.url().includes('/models/'+encodeURIComponent(id)));
 await dialog(page).getByRole('button',{name:'保存参数',exact:true}).click();assert.equal((await done).status(),200);
 await dialog(page).waitFor({state:'detached'});await row(page,id).waitFor();
}
async function refreshModels(page){const done=waitResponse(page,r=>r.url().endsWith('/refresh'));await page.getByRole('button',{name:'刷新列表',exact:true}).click();assert.equal((await done).status(),200);await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('模型列表已刷新'));}
async function testModel(page,id,ok=true){const done=waitResponse(page,r=>r.url().endsWith('/models/'+encodeURIComponent(id)+'/test'),{timeout:45000});await row(page,id).getByRole('button',{name:/^测试/}).click();assert.equal((await done).status(),200);await row(page,id).getByText(ok?/测试通过/:/测试失败/).waitFor();}
async function screenshot(page,name){await page.screenshot({path:OUT+'/'+name+'.png',fullPage:true});}

check('服务商目录接口',async(page,{request})=>{const r=await request.get(BASE+'/api/model/providers');assert.equal(r.status(),200);assert.ok((await r.json()).some(p=>p.id==='deepseek'));});
check('五页导航与旧地址映射',async page=>{
 await openPanel(page);assert.deepEqual((await page.locator('.tabs a').allTextContents()).map(text=>text.trim()),['动态','人设','记忆','设置','计费']);
 assert.equal((await page.locator('#primary-action').innerText()).trim(),'启动');
 for(const [old,target]of [['overview','feed'],['model','settings/model'],['program','settings/logs'],['tasks','settings/tasks'],['browser','settings/browser']]){
  await openPanel(page,old);await page.waitForFunction(target=>location.hash==='#/'+target,target);
  if(target.includes('/'))await page.locator('#settings-'+target.split('/')[1]+'[open]').waitFor();
 }
});
check('启动仍要求浏览器登录',async page=>{await openPanel(page);await page.click('#primary-action');await page.waitForFunction(()=>{const n=document.getElementById('notice');return n&&!n.hidden&&n.dataset.kind==='error';});assert.ok(!(await page.locator('#notice').innerText()).includes('预期'));assert.equal(await page.locator('#status-pill').innerText(),'已暂停');});
check('账号跟随浏览器且无预期账号设置',async(page,{request})=>{
 fx.state.loggedIn=true;await openPanel(page);await page.locator('.feed-overview').getByText('账号 @Current_User',{exact:true}).waitFor();
 assert.equal(await page.locator('#handle-input,#handle-save,#handle-use-current').count(),0);assert.doesNotMatch(await page.locator('.feed-overview').innerText(),/预期账号/);
 assert.equal((await request.put(BASE+'/api/account',{data:{},headers:{'x-workflow-control':'1'}})).status(),404);fx.state.loggedIn=false;
});
check('运行日志移入设置分区',async page=>{await openPanel(page,'settings/logs');await page.locator('#program-logs li').first().waitFor();assert.ok(await page.locator('#program-logs li').count()>=1);assert.equal(await page.locator('#logs').count(),0);});
check('浅深色主题',async page=>{await page.emulateMedia({colorScheme:'light'});await openPanel(page);const light=await page.evaluate(()=>getComputedStyle(document.body).backgroundColor);await screenshot(page,'feed-light');await page.emulateMedia({colorScheme:'dark'});assert.notEqual(light,await page.evaluate(()=>getComputedStyle(document.body).backgroundColor));await screenshot(page,'feed-dark');});
check('375宽度无整体横向滚动',async page=>{await page.setViewportSize({width:375,height:800});await openPanel(page);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=375));await screenshot(page,'feed-mobile');});
check('添加目录保留可用与禁用服务商及搜索',async page=>{
 await openModel(page);await page.locator('#provider-add').click();const catalog=await (await page.request.get(BASE+'/api/model/providers')).json();
 for(const id of ['deepseek','opencode','opencode-go','radius','github-copilot','commandcode'])assert.equal(await dialog(page).getByRole('button',{name:catalog.find(p=>p.id===id).name,exact:true}).isEnabled(),true,id);
 const locked=catalog.find(p=>p.id==='amazon-bedrock');assert.equal(await dialog(page).getByRole('button',{name:new RegExp(locked.name)}).isDisabled(),true);
 assert.equal(await dialog(page).getByRole('button',{name:'自定义端点',exact:true}).isEnabled(),true);
 await dialog(page).getByPlaceholder('搜索服务商…').fill('code');assert.ok(await dialog(page).locator('.provider-choice').count()>=2);await screenshot(page,'provider-catalog');
});
check('OpenCode目录保留双协议及模型端点且内置协议自动选择',async(page,{request})=>{
 const models=await (await request.get(BASE+'/api/model/providers/opencode/models')).json();const claude=models.find(m=>m.api==='anthropic-messages'),other=models.find(m=>m.api==='openai-completions');assert.ok(claude&&other);assert.notEqual(claude.baseUrl,other.baseUrl);
 await openModel(page);const modal=await addProvider(page,'opencode');assert.match(await modal.locator('.protocol-auto').innerText(),/按模型自动选择/);await modal.getByLabel('Base URL',{exact:true}).fill('https://edited.example/v1');assert.equal(await modal.getByLabel('Base URL',{exact:true}).inputValue(),'https://edited.example/v1');
});
check('CommandCode无凭据可浏览完整目录与协议',async(page,{request})=>{
 const r=await request.get(BASE+'/api/model/providers/commandcode/models');assert.equal(r.status(),200);const models=await r.json();const claude=models.find(m=>m.id==='claude-sonnet-4-6'),gpt=models.find(m=>m.id==='gpt-6.1-sol');assert.ok(claude&&gpt);assert.equal(claude.api,'anthropic-messages');assert.equal(gpt.api,'openai-completions');assert.equal(claude.costKnown,false);assert.equal(claude.baseUrl,'https://api.commandcode.ai/provider');assert.equal(gpt.baseUrl,'https://api.commandcode.ai/provider/v1');
 await openModel(page);const modal=await addProvider(page,'commandcode');assert.match(await modal.locator('.protocol-auto').innerText(),/按模型自动选择/);await screenshot(page,'model-commandcode');
});
check('内置目录元数据与自定义协议选择',async(page,{request})=>{
 const models=await (await request.get(BASE+'/api/model/providers/deepseek/models')).json(),known=models.find(m=>m.id==='deepseek-flash');assert.ok(known.contextWindow>=1000000);
 await openModel(page);let modal=await addProvider(page,'deepseek');assert.equal(await modal.getByLabel('Base URL',{exact:true}).inputValue(),'https://api.deepseek.com');assert.equal(await modal.locator('.protocol-auto select').count(),0);await modal.getByRole('button',{name:'关闭',exact:true}).click();modal=await addProvider(page);assert.deepEqual(await modal.locator('select').locator('option').evaluateAll(xs=>xs.map(x=>x.value)),['openai-completions','openai-responses','anthropic-messages']);
});
check('自定义添加发现、参数、测试与使用中保存真实回读',async(page,{request})=>{
 await openModel(page);const modal=await addProvider(page);await modal.getByLabel('名称',{exact:true}).fill('隔离自定义接口');await modal.getByLabel('Base URL',{exact:true}).fill(fx.modelURL);await modal.locator('select').selectOption('openai-completions');await modal.getByLabel('API Key',{exact:true}).fill(fx.modelKey);
 const added=waitResponse(page,r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/model/library');await modal.getByRole('button',{name:'添加并拉取模型',exact:true}).click();assert.equal((await added).status(),200);await dialog(page).waitFor({state:'detached'});await row(page,'my-finetune-v2').waitFor();
 assert.match(await row(page,'deepseek-flash').innerText(),/上下文/);assert.match(await row(page,'my-finetune-v2').innerText(),/自定义参数/);
 await saveParams(page,'my-finetune-v2',{'上下文长度（token）':128000,'支持推理':false});await testModel(page,'my-finetune-v2');await screenshot(page,'model-custom');
 await row(page,'my-finetune-v2').getByRole('button',{name:'设为使用中',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('使用中模型已切换'));assert.equal((await (await request.get(BASE+'/api/status')).json()).control,'paused');
 const d=await library(request);assert.equal(d.active.default.modelId,'my-finetune-v2');assert.equal(d.providers.find(p=>p.active).name,'隔离自定义接口');await page.reload();await page.locator('#base-url').waitFor();assert.match(await page.locator('.provider-detail').innerText(),/已保存.*••••0001/);assert.ok(!(await page.locator('html').innerHTML()).includes(fx.modelKey));assert.equal(await page.locator('#api-key').inputValue(),'');
});
check('未知模型参数真实保存',async(page,{request})=>{await openModel(page);await row(page,'my-finetune-v2').getByRole('button',{name:'编辑',exact:true}).click();assert.equal(await dialog(page).getByLabel('模型 ID',{exact:true}).inputValue(),'my-finetune-v2');assert.equal(await dialog(page).getByLabel('上下文长度（token）',{exact:true}).inputValue(),'128000');assert.equal(await dialog(page).getByLabel('支持推理',{exact:true}).isChecked(),false);const d=await library(request);assert.deepEqual(d.providers.find(p=>p.active).models.find(m=>m.id==='my-finetune-v2').custom,{contextWindow:128000,reasoning:false});});
check('模型参数弹窗未保存跨页保护',async page=>{
 await openModel(page);await row(page,'my-finetune-v2').getByRole('button',{name:'编辑',exact:true}).click();await dialog(page).getByLabel('回复长度上限（token）',{exact:true}).fill('2048');
 // 弹窗覆盖页面；用地址栏 hash 导航等价路径触发跨页保护，再用鼠标点击置于弹窗上方的确认。
 await page.evaluate(()=>{location.hash='#/feed';});await page.locator('.confirm-over-modal').waitFor();await page.getByRole('button',{name:'保留编辑',exact:true}).click();assert.equal(await page.evaluate(()=>location.hash),'#/settings/model');assert.equal(await dialog(page).getByLabel('回复长度上限（token）',{exact:true}).inputValue(),'2048');
 await page.evaluate(()=>{location.hash='#/feed';});await page.locator('.confirm-over-modal').waitFor();await page.getByRole('button',{name:'放弃并离开',exact:true}).click();await page.locator('.feed-page').waitFor();
});
check('连接未保存跨页保护',async page=>{await openModel(page);await page.fill('#base-url',fx.modelURL+'/edited');await page.getByRole('link',{name:'计费',exact:true}).click();await page.getByRole('button',{name:'保留编辑',exact:true}).click();assert.equal(await page.evaluate(()=>location.hash),'#/settings/model');assert.equal(await page.inputValue('#base-url'),fx.modelURL+'/edited');});
check('已有连接目标origin改变或invalid清空DOM与提交Key',async page=>{
 for(const target of [fx.modelURL.replace('model.fixture.test','second.fixture.test'),'not a url']){
  page.once('dialog',dialog=>dialog.accept());await openModel(page);await page.fill('#api-key','typed-0003');await page.fill('#base-url',target);assert.equal(await page.inputValue('#api-key'),'');
  const sent=waitRequest(page,r=>r.method()==='PUT'&&/\/api\/model\/library\/[^/]+$/.test(new URL(r.url()).pathname));await page.locator('#provider-save').click();const request=await sent;assert.equal(request.postDataJSON().apiKey,'');await page.waitForFunction(()=>document.querySelector('#notice')?.dataset.kind==='error');
 }
});
check('添加modal换origin或服务商清明文Key',async page=>{
 await openModel(page);const modal=await addProvider(page);await modal.getByLabel('Base URL',{exact:true}).fill(fx.modelURL);await modal.getByLabel('API Key',{exact:true}).fill('typed-0002');await modal.getByLabel('Base URL',{exact:true}).fill(fx.modelURL.replace('model.fixture.test','second.fixture.test'));assert.equal(await modal.getByLabel('API Key',{exact:true}).inputValue(),'');await modal.getByLabel('API Key',{exact:true}).fill('typed-0002');await modal.getByLabel('Base URL',{exact:true}).fill('invalid');assert.equal(await modal.getByLabel('API Key',{exact:true}).inputValue(),'');await modal.getByLabel('API Key',{exact:true}).fill('typed-0002');await modal.getByRole('button',{name:'DeepSeek',exact:true}).click();assert.equal(await modal.getByLabel('API Key',{exact:true}).inputValue(),'');
});
check('未测试模型先确认再切换且不恢复',async(page,{request})=>{
 await openModel(page);const before=(await library(request)).active.default;await row(page,'deepseek-flash').getByRole('button',{name:'设为使用中',exact:true}).click();await page.getByRole('dialog',{name:'该模型尚未通过测试'}).waitFor();assert.deepEqual((await library(request)).active.default,before);await dialog(page).getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual((await library(request)).active.default,before);
});
check('失败测试后使用仍需确认',async(page,{request})=>{await openModel(page);fx.state.modelFails=true;try{await testModel(page,'deepseek-flash',false);}finally{fx.state.modelFails=false;}await row(page,'deepseek-flash').getByRole('button',{name:'设为使用中',exact:true}).click();await page.getByRole('dialog',{name:'该模型尚未通过测试'}).waitFor();const active=waitRequest(page,r=>new URL(r.url()).pathname==='/api/model/active');await dialog(page).getByRole('button',{name:'仍然使用',exact:true}).click();assert.equal((await active).postDataJSON().confirmUntested,true);await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('使用中模型已切换'));assert.equal((await library(request)).active.default.modelId,'deepseek-flash');assert.equal((await (await request.get(BASE+'/api/status')).json()).control,'paused');});
check('模型加载期间无可操作旧连接',async page=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});await page.route('**/api/model',async route=>{await gate;await route.continue();});
 try{await page.goto(BASE+'/#/settings/model',{waitUntil:'domcontentloaded'});await page.locator('.model-library').waitFor({state:'attached'});assert.equal(await page.locator('#provider-add').count(),0);assert.equal(await page.locator('#provider-save').count(),0);assert.equal(await page.locator('.provider-row').count(),0);}finally{release();}
 await page.locator('#provider-save').waitFor();
});
check('大列表1000上限、60行增量和搜索',async(page,{request})=>{
 await openModel(page);await page.fill('#base-url',fx.bigModelURL);const saved=waitResponse(page,r=>r.request().method()==='PUT'&&/\/api\/model\/library\/[^/]+$/.test(new URL(r.url()).pathname));await page.locator('#provider-save').click();assert.equal((await saved).status(),200);await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('连接已保存'));await refreshModels(page);
 const p=(await library(request)).providers.find(p=>p.active);assert.equal(p.models.filter(m=>/^m-/.test(m.id)).length,1000);assert.equal(await page.locator('.model-row').count(),60);await page.getByRole('button',{name:'显示更多模型',exact:true}).click();assert.equal(await page.locator('.model-row').count(),120);await page.fill('#model-search','m-0999');await row(page,'m-0999').waitFor();assert.equal(await page.locator('.model-row').count(),1);await page.fill('#model-search','m-1499');assert.equal(await page.locator('.model-row').count(),0);
});
check('状态短暂失败保留已连接桌面并停用释放',async page=>{
 let fail=false;const real=await (await page.request.get(BASE+'/api/status')).json();await page.route('**/api/status',route=>fail?route.abort():route.fulfill({json:{...real,control:'manual'}}));await page.route('**/desktop/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>本地合成桌面</title><p>desktop stub</p>'}));await page.goto(BASE+'/#/settings/browser');await page.locator('#connect',{hasText:'连接桌面'}).click();await page.locator('#desktop-frame').waitFor();assert.equal(await page.locator('#open-new-tab').isVisible(),true);assert.equal(await page.locator('#primary-action').innerText(),'启动');assert.equal(await page.locator('#primary-action').isDisabled(),true);assert.equal(await page.locator('#release').isVisible(),true);fail=true;await page.waitForFunction(()=>document.getElementById('conn')?.dataset.state==='error',null,{timeout:15000});assert.equal(await page.locator('#desktop-frame').count(),1);assert.equal(await page.locator('#release').isDisabled(),true);
});
check('接管区释放已连接桌面并423',async(page,{request})=>{
 await openPanel(page,'settings/browser');await page.route('**/desktop/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>本地合成桌面</title><p>desktop stub</p>'}));await page.locator('#connect').click();await page.locator('#desktop-frame').waitFor();assert.equal(fx.state.control,'manual');assert.equal(await page.locator('#status-pill').innerText(),'已暂停');assert.equal(await page.locator('#primary-action').isDisabled(),true);assert.equal(await page.locator('#takeover-link').isVisible(),true);assert.equal(await page.locator('.top-actions #release').count(),0);await page.locator('#settings-browser .desk-bar #release').click();await page.locator('#desktop-frame').waitFor({state:'detached'});await page.waitForFunction(()=>!document.querySelector('#primary-action').disabled);assert.equal(fx.state.control,'paused');assert.equal((await request.get(BASE+'/desktop/vnc.html')).status(),423);assert.equal(await page.locator('#notice').innerText(),'已释放接管，处理保持暂停，可在顶部启动');
});
check('浏览器空闲与未连接释放',async page=>{
 await openPanel(page,'settings/browser');await page.getByText('浏览器未连接',{exact:true}).waitFor();assert.equal(await page.locator('#connect').innerText(),'接管并连接');assert.equal(await page.locator('#desktop-frame').count(),0);await screenshot(page,'browser-idle');fx.state.control='manual';await page.reload();await page.locator('#release').waitFor();assert.equal(await page.locator('#desktop-frame').count(),0);await page.locator('#release').click();await page.locator('#release').waitFor({state:'detached'});assert.equal(fx.state.control,'paused');
});
check('接管失败保持暂停，孤立排空仍可重试暂停',async page=>{
 fx.state.takeoverFails=true;await openPanel(page,'settings/browser');await page.click('#connect');await page.waitForFunction(()=>{const n=document.getElementById('notice');return n&&!n.hidden&&n.dataset.kind==='error';},null,{timeout:30000});assert.equal(await page.locator('#desktop-frame').count(),0);assert.notEqual(await page.locator('#settings-browser .section-summary').innerText(),'人工接管中');assert.equal(fx.state.control,'paused');await page.waitForFunction(()=>!document.querySelector('#primary-action').disabled);assert.equal(await page.locator('#primary-action').innerText(),'启动');
 // 当前后端已把失败安全落为 paused；另行保留无操作 draining 的重试路径验收。
 fx.state.control='draining';await page.reload();await page.locator('#primary-action',{hasText:'重试暂停'}).waitFor();assert.equal(await page.locator('#primary-action').isEnabled(),true);await page.locator('#primary-action').click();await page.locator('#status-pill',{hasText:'已暂停'}).waitFor();assert.equal(fx.state.control,'paused');
});

const results={evidence:'服务器无网络隔离；真实dist/SQLite/ModelLibrary、本地合成模型与浏览器；未连接生产、X或真实供应商',checks:[],errors:[]};
let browser;
try{
 browser=await observer();
 for(const {name,fn}of checks){
  fx.state.loggedIn=false;fx.state.takeoverFails=false;fx.state.modelFails=false;fx.state.control='paused';
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.route('**/*',route=>new URL(route.request().url()).origin===BASE?route.continue():route.abort());const page=await context.newPage(),pageErrors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>pageErrors.push(e.message));
  try{await fn(page,{context,request:context.request,base:BASE});assert.deepEqual(pageErrors,[]);results.checks.push(name);console.log('通过 '+name);}
  catch(e){results.errors.push({name,error:e.stack||String(e)});console.log('失败 '+name+' '+e);await screenshot(page,'fail-'+checks.findIndex(x=>x.name===name)).catch(()=>{});}
  finally{await context.close();}
 }
 assert.deepEqual(fx.externalAttempts,[],'夹具意外尝试外部HTTP');
}catch(error){results.errors.push({name:'整体隔离断言',error:error.stack||String(error)});}
finally{await browser?.close();results.requests=fx.requests;results.externalAttempts=fx.externalAttempts;await fx.close();writeFileSync(OUT+'/panel-e2e.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));if(results.errors.length)process.exitCode=1;}
