// 真实生产五页验收：仅只读接口与面板；接管仅限初始暂停且本脚本收到成功响应的会话。
// 不保存配置、不调用模型、不执行任务、不批准草稿，不在 X 桌面输入或操作内容。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';

const BASE=(process.env.PANEL_URL||'https://43.133.80.237').replace(/\/$/,''),OUT=process.env.ARTIFACT_DIR||'/artifacts';
const CREDENTIAL_FILE=process.env.ADMIN_ACCESS_FILE||'/run/test/admin-access.txt';
const baseURL=new URL(BASE);
if(baseURL.protocol!=='https:'||baseURL.username||baseURL.password||baseURL.search||baseURL.hash)throw new Error('生产面板地址必须为不含凭据、查询及片段的 HTTPS 地址');
const credentialText=readFileSync(CREDENTIAL_FILE,'utf8'),lines=credentialText.split(/\r?\n/);
const field=index=>{const line=lines[index]||'',at=line.indexOf('：');return at<0?'':line.slice(at+1).trim();};
const password=field(2),username=field(1)||'operator';
if(!password)throw new Error('挂载的临时验收凭据缺失');
const httpCredentials={username,password},basic=Buffer.from(username+':'+password).toString('base64');
function redact(value){return String(value).split(password).join('[已隐藏]').split(basic).join('[已隐藏]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/Basic\s+[A-Za-z0-9+/=]+/gi,'Basic [已隐藏]').replace(/(?:sk-|buf_|ghp_)[A-Za-z0-9_-]{8,}/g,'[已隐藏]').slice(0,1400);}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ROUTES=[['feed','动态','.feed-page'],['persona','人设','#persona-section-0'],['memory','记忆','#memory-search-button'],['settings','设置','#program-mode'],['billing','计费','.usage-summary']];
const LEGACY=[['overview','feed'],['model','settings/model'],['program','settings/logs'],['tasks','settings/tasks'],['browser','settings/browser']];
const API_PATHS=['/api/status','/api/model','/api/persona','/api/persona/daily','/api/persona/prompt-hints','/api/memory/policy','/api/memory/users','/api/program','/api/program/logs','/api/messages','/api/tasks','/api/tasks/runs','/api/feed','/api/account/posting-limits','/api/health','/api/health/settings','/api/health/alerts','/api/health/reports','/api/triage/settings','/api/billing/activity?weeks=52','/api/billing/summary','/api/billing/calls'];
const SCOPED_PATHS=['/api/triage/summary','/api/triage/ignores','/api/persona/replay/runs','/api/persona/replay/samples?channel=public&limit=1','/api/persona/quality?channel=public'];
const results={evidence:'真实 HTTPS 面板、鉴权接口、五页与旧地址以及可选受控桌面连接；没有模型调用或 X 内容操作',controlOwnershipPolicy:'仅在独占验收窗口且初始 paused、本脚本接管收到200时推定所有权；未确认响应不盲目释放。初始 manual 仅只读观察。',checks:[],errors:[],apiReads:[],scopedUnavailable:[],screenshots:[],writes:[],blockedWrites:[],startedAt:new Date().toISOString()};
let browser,context,page,initial=null,ownsTakeover=false,permittedControl=null,exitCode=0;
const cached=new Map();mkdirSync(OUT,{recursive:true});

async function readJson(path,{scoped=false}={}){
 assert.ok(path.startsWith('/api/'),'只读验收仅允许指定 API 路径');
 const response=await context.request.get(BASE+path,{timeout:30000}),status=response.status();
 if(scoped&&status===409&&!initial?.accountId){results.scopedUnavailable.push({path,status,reason:'当前账号尚未确认，未访问其他账号资料'});return null;}
 assert.equal(status,200,path+' HTTP '+status);
 const data=await response.json();assert.ok(data&&typeof data==='object',path+' 未返回 JSON 对象');
 cached.set(path,data);return data;
}
async function snapshot(){
 // 模型库首次 GET 可能执行已设计的旧配置登记；快照在初次迁移读回后建立。
 const status=await readJson('/api/status'),model=await readJson('/api/model');
 const persona=await readJson('/api/persona'),memory=await readJson('/api/memory/policy'),program=await readJson('/api/program'),tasks=await readJson('/api/tasks'),hints=await readJson('/api/persona/prompt-hints'),triage=await readJson('/api/triage/settings'),health=await readJson('/api/health/settings'),activity=await readJson('/api/billing/activity?weeks=52');
 return{control:status.control,busy:status.busy,accountId:status.accountId||'',mode:status.config?.mode||null,model:{provider:model.effective?.provider||null,id:model.effective?.id||null,source:model.source||null},modelHash:hash({source:model.source,settings:model.settings,effective:model.effective}),libraryHash:hash(model.library),panelSettingsHash:hash({persona:{persona:persona.persona,revision:persona.revision},memory,program:{settings:program.settings,revision:program.revision},tasks:{revision:tasks.revision,plans:(tasks.tasks||[]).map(t=>({id:t.id,enabled:t.enabled,time:t.time,intervalSeconds:t.intervalSeconds}))},hints,triage,health}),effectiveConfigHash:hash(status.config),usage:status.stats?.usage||null,llmCalls:Number(activity.totals?.calls||0),messageCountsHash:hash(status.stats?.messages||[])};
}
async function step(name,fn){try{await fn();results.checks.push(name);return true;}catch(error){results.errors.push(name+'：'+redact(error?.message||error));return false;}}
async function statusIs(expected){const status=await readJson('/api/status');assert.equal(status.control,expected,'控制状态变化，停止本次控制操作');return status;}
async function screenshot(name,extraMasks=[]){
 // 私信条目及桌面整块遮蔽；不把可见的真实 Chat/profile 内容保存到证据文件。
 const privateCards=page.locator('.feed-item').filter({has:page.locator('b').filter({hasText:/^私信(?: ·|$)/})});
 await page.screenshot({path:OUT+'/'+name+'.png',fullPage:true,mask:[privateCards,page.locator('#desktop-frame'),...extraMasks]});results.screenshots.push(name+'.png');
}
async function assertSafeDOM(){
 assert.equal(await page.locator('#view script,#view object,#view embed,#view img').count(),0,'面板正文不应产生可执行外部 HTML 节点');
 const handlers=await page.locator('#view *').evaluateAll(nodes=>nodes.some(el=>[...el.attributes].some(a=>/^on/i.test(a.name))));assert.equal(handlers,false,'面板发现内联事件属性');
 const unsafeLinks=await page.locator('#view a[href]').evaluateAll(nodes=>nodes.some(a=>{try{const u=new URL(a.href);return !['http:','https:'].includes(u.protocol)||!!u.username||!!u.password;}catch{return true;}}));assert.equal(unsafeLinks,false,'面板发现不安全链接');
 assert.ok(!/页面加载失败|读取失败|读取计划失败|请求失败|加载失败/.test(await page.locator('#view').innerText()),'页面出现读取或加载错误');
}
async function waitData(route){
 if(route==='feed')await page.waitForFunction(()=>{const list=document.querySelector('.feed-list');return list&&(list.querySelector('.feed-item')||list.textContent.includes('暂无动态'));},null,{timeout:30000});
 if(route==='persona')await page.waitForFunction(()=>document.getElementById('persona-section-0')&&!document.getElementById('view').textContent.includes('正在读取当日日程'),null,{timeout:30000});
 if(route==='memory')await page.waitForFunction(()=>{const list=document.getElementById('memory-users');return list&&(list.querySelector('.memory-user')||list.textContent.includes('没有符合筛选条件'));},null,{timeout:30000});
 if(route==='settings')await page.waitForFunction(mode=>document.getElementById('program-mode')?.value===mode,initial.mode,{timeout:30000});
 if(route==='billing')await page.locator('.usage-heatmap .heat-cell').first().waitFor({timeout:30000});
 await assertSafeDOM();
}
async function sectionReady(id){
 await page.locator('#settings-'+id+'[open]').waitFor({timeout:30000});
 if(id==='model')await page.locator('#provider-add').waitFor({timeout:30000});
 if(id==='tasks')await page.locator('#tasks-save').waitFor({timeout:30000});
 if(id==='logs')await page.waitForFunction(()=>{const l=document.getElementById('program-logs');return l&&!l.textContent.includes('正在读取日志');},null,{timeout:30000});
 if(id==='browser')await page.locator('#connect').waitFor({timeout:30000});
 await assertSafeDOM();
}
async function releaseOwned(){
 if(!ownsTakeover)return;
 const status=await readJson('/api/status');
 if(status.control!=='manual'){ownsTakeover=false;assert.equal(status.control,'paused','本次接管后控制状态已由外部改变');return;}
 permittedControl='release';
 try{const response=await context.request.post(BASE+'/api/control/release',{headers:{'x-workflow-control':'1'},timeout:120000});results.writes.push({method:'POST',path:'/api/control/release',cleanup:true});assert.equal(response.status(),200,'释放接管失败 HTTP '+response.status());await statusIs('paused');ownsTakeover=false;}finally{permittedControl=null;}
}

try{
 browser=await observer();context=await browser.newContext({httpCredentials,viewport:{width:1440,height:1000}});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  if(url.origin===baseURL.origin&&!['GET','HEAD','OPTIONS'].includes(method)){
   const allowed=method==='POST'&&permittedControl&&url.pathname==='/api/control/'+permittedControl&&request.headers()['x-workflow-control']==='1';
   if(!allowed){results.blockedWrites.push({method,path:url.pathname});await route.abort('blockedbyclient');return;}
   results.writes.push({method,path:url.pathname});
  }
  await route.continue();
 });
 await readJson('/api/model');initial=await snapshot();results.initial=initial;
 if(!['paused','manual'].includes(initial.control)){
  results.skipped='初始控制为 '+initial.control+'；本脚本未暂停、接管或访问业务页面。请在独占只读验收窗口运行。';exitCode=2;
 }else{
  results.existingManualReadOnly=initial.control==='manual';page=await context.newPage();
  page.on('pageerror',error=>results.errors.push('页面脚本异常：'+redact(error.message)));
  page.on('response',response=>{const url=new URL(response.url());if(url.origin===baseURL.origin&&url.pathname.startsWith('/api/')&&response.status()>=400){if(response.status()===409&&!initial.accountId&&SCOPED_PATHS.some(p=>p.split('?')[0]===url.pathname))return;results.errors.push('页面接口失败：'+response.request().method()+' '+url.pathname+' HTTP '+response.status());}});
  await step('匿名 HTTPS 请求被鉴权拒绝',async()=>{const anonymous=await browser.newContext();try{const response=await anonymous.request.get(BASE+'/api/status',{timeout:30000});assert.equal(response.status(),401,'未提供凭据的状态请求未被拒绝');results.anonymousStatus=response.status();}finally{await anonymous.close();}});
  await step('新旧真实只读接口、健康/分级/回放列表',async()=>{
   for(const path of API_PATHS){const d=await readJson(path);results.apiReads.push({path,status:200,...(Array.isArray(d.items)?{items:d.items.length,empty:d.items.length===0}:{})});}
   for(const path of SCOPED_PATHS){const d=await readJson(path,{scoped:true});if(d)results.apiReads.push({path,status:200,...(Array.isArray(d.items)?{items:d.items.length,empty:d.items.length===0}:{})});}
   const feed=cached.get('/api/feed');assert.ok(Array.isArray(feed.items)&&Number.isSafeInteger(feed.pending),'动态接口缺少条目或待处理数');
   const health=cached.get('/api/health');assert.ok(Array.isArray(health.metrics)&&Array.isArray(health.activeAlerts),'健康接口结构无效');
   const activity=cached.get('/api/billing/activity?weeks=52');assert.ok(Array.isArray(activity.daily)&&activity.totals&&activity.last7,'活动汇总结构无效');
   assert.ok(Array.isArray(cached.get('/api/billing/summary').dailyModels),'计费缺少按日期模型聚合');
   const limits=cached.get('/api/account/posting-limits');assert.ok(limits.effective?.post&&limits.effective?.reply,'字数接口缺少两种操作策略');
   results.listStates={alerts:cached.get('/api/health/alerts')?.items?.length??null,reports:cached.get('/api/health/reports')?.items?.length??null,ignores:cached.get('/api/triage/ignores')?.items?.length??null,replayRuns:cached.get('/api/persona/replay/runs')?.items?.length??null};
  });
  await step('模型库迁移读回、使用中模型与掩码一致',async()=>{
   const model=await readJson('/api/model'),library=model.library;assert.equal(library?.version,1,'模型库版本无效');assert.ok(Array.isArray(library.providers),'模型库缺少服务商列表');assert.ok(Number.isSafeInteger(library.revision),'模型库缺少修订号');
   const keys=new Set();for(const provider of library.providers){assert.ok(provider.key&&!keys.has(provider.key),'服务商标识缺失或重复');keys.add(provider.key);assert.ok(Array.isArray(provider.models),'服务商模型列表无效');if(provider.keyHint)assert.ok(/^[•*●]+.{0,4}$/u.test(String(provider.keyHint)),'Key 未以掩码返回');for(const m of provider.models)assert.ok(!Object.hasOwn(m,'apiKey'),'模型响应包含密钥字段');assert.ok(!Object.hasOwn(provider,'apiKey'),'服务商响应包含密钥字段');}
   for(const hint of Object.values(model.keys||{}))if(hint)assert.ok(/^[•*●]+.{0,4}$/u.test(String(hint)),'旧 Key 槽未以掩码返回');
   const active=library.active?.default;
   if(active){const provider=library.providers.find(p=>p.key===active.key),entry=provider?.models.find(m=>m.id===active.modelId);assert.ok(provider&&entry,'使用中模型未在库中');assert.equal(model.effective?.id,entry.id,'实际模型与库指向不同');assert.equal(model.effective?.provider,provider.provider,'实际服务商与库指向不同');if(model.settings){assert.equal(entry.params.maxTokens,model.settings.maxTokens);assert.equal(entry.params.timeoutMs,model.settings.timeoutMs);assert.equal(entry.params.reasoningLevel,model.settings.reasoningLevel);}}
   else assert.ok(model.source==='config'||!model.effective?.id,'面板模型存在却未登记为使用中');
   const second=await readJson('/api/model');assert.equal(hash(second.library),hash(library),'只读模型库读回不稳定');
   results.modelLibrary={version:library.version,revision:library.revision,providers:library.providers.length,active:active?{providerKey:active.key,modelId:active.modelId}:null,source:model.source};
  });
  await step('五页真实页面、20组主题宽度与安全DOM',async()=>{
   for(const scheme of ['light','dark'])for(const width of [1440,375]){
    await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width,height:1000});
    for(const [route,label,selector]of ROUTES){
     await page.goto(BASE+'/?acceptance-view='+route+'-'+scheme+'-'+width+'#/'+route);
     await page.locator('.tabs a.active[data-route="'+route+'"]').waitFor({timeout:30000});await page.locator(selector).waitFor({timeout:30000});await waitData(route);
     assert.deepEqual(await page.locator('.tabs a').evaluateAll(nodes=>nodes.map(a=>({route:a.dataset.route,label:a.childNodes[0]?.textContent.trim()}))),ROUTES.map(([r,l])=>({route:r,label:l})),'导航不是精确五页');
     assert.ok(page.url().endsWith('#/'+route),'页面地址与导航不符');
     const scrollWidth=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(scrollWidth<=width+1,route+' 横向溢出 '+scrollWidth+'/'+width);
     if(route==='feed')assert.equal(await page.locator('#view ul.logs').count(),0,'动态页混入运行日志');
     if(route==='billing'){assert.equal(await page.locator('.usage-heatmap .heat-cell').count(),364,'活动图不是52×7');assert.equal(await page.locator('.usage-calls').getAttribute('open'),null,'流水默认未收起');}
     await screenshot('production-five-'+route+'-'+scheme+'-'+width);
    }
   }
  });
  await step('五个旧地址替换映射与折叠分区读回',async()=>{
   await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({colorScheme:'light'});
   for(const [old,target]of LEGACY){await page.goto(BASE+'/?legacy-check='+old+'#/'+old);await page.waitForFunction(target=>location.hash==='#/'+target,target,{timeout:30000});const [route,section]=target.split('/');await page.locator('.tabs a.active[data-route="'+route+'"]').waitFor({timeout:30000});if(section)await sectionReady(section);else await waitData(route);if(old==='browser')assert.equal(await page.locator('#desktop-frame').count(),0,'旧地址自动建立了桌面连接');await screenshot('production-legacy-'+old);}
  });
  await step('健康与分级真实只读面板',async()=>{
   await page.goto(BASE+'/?section-check=health#/settings/health');await page.locator('#settings-health[open]').waitFor({timeout:30000});await page.waitForFunction(()=>{const v=document.querySelector('#settings-health .settings-body');return v&&!v.textContent.includes('正在读取…');},null,{timeout:30000});await assertSafeDOM();await screenshot('production-health-readonly');
   if(!initial.accountId){results.triagePageSkipped='当前账号未确认，保留409限制；未冒用其他账号。';return;}
   await page.goto(BASE+'/?section-check=triage#/settings/triage');await page.locator('#settings-triage textarea').first().waitFor({timeout:30000});await assertSafeDOM();await screenshot('production-triage-readonly');
  });
  const browserPage=await step('旧浏览器地址展开设置接管区且不自动连接',async()=>{
   await page.goto(BASE+'/?desktop-check=1#/browser');await page.waitForFunction(()=>location.hash==='#/settings/browser');await sectionReady('browser');assert.equal(await page.locator('#desktop-frame').count(),0);assert.equal(await page.locator('.tabs a[data-route="browser"]').count(),0);
  });
  if(browserPage&&initial.control==='paused'){
   await step('初始暂停时受控接管与noVNC有效画布',async()=>{
    await statusIs('paused');permittedControl='takeover';
    try{const responsePromise=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/control/takeover',{timeout:120000});await page.locator('#connect').click();const response=await responsePromise;assert.equal(response.status(),200,'接管请求未确认成功');ownsTakeover=true;await page.locator('#status-pill',{hasText:'人工接管中'}).waitFor({timeout:120000});}finally{permittedControl=null;}
    await page.locator('#desktop-frame').waitFor({timeout:30000});const frame=await(await page.locator('#desktop-frame').elementHandle()).contentFrame();assert.ok(frame,'桌面 iframe 不可用');
    try{await frame.waitForFunction(()=>{const canvas=document.querySelector('#noVNC_container canvas');return document.documentElement.classList.contains('noVNC_connected')&&canvas?.width>100;},null,{timeout:45000});await frame.waitForFunction(()=>{const c=document.querySelector('#noVNC_container canvas'),x=c?.getContext('2d');if(!c||!x)return false;const d=x.getImageData(0,0,Math.min(c.width,800),Math.min(c.height,600)).data,colors=new Set();for(let i=0;i<d.length;i+=400)if(d[i+3])colors.add(d[i]+','+d[i+1]+','+d[i+2]);return colors.size>12;},null,{timeout:20000});}
    catch(error){results.desktopDiagnostic=await frame.evaluate(()=>({rootClass:document.documentElement.className,width:document.querySelector('#noVNC_container canvas')?.width||0,height:document.querySelector('#noVNC_container canvas')?.height||0})).catch(()=>({unavailable:true}));await screenshot('production-desktop-failed-masked');throw error;}
    results.desktop=await frame.evaluate(()=>{const c=document.querySelector('#noVNC_container canvas');return{connected:document.documentElement.classList.contains('noVNC_connected'),width:c?.width||0,height:c?.height||0,hasPixels:true,screenshotMasked:true};});await screenshot('production-desktop-connected-masked');
   });
   if(ownsTakeover)await step('释放本次接管后仍暂停且桌面423',async()=>{await statusIs('manual');await releaseOwned();await page.locator('#status-pill',{hasText:'已暂停'}).waitFor({timeout:30000});assert.equal(await page.locator('#desktop-frame').count(),0);assert.equal((await context.request.get(BASE+'/desktop/vnc.html')).status(),423);});
   else results.desktopSkipped='未确认取得本次接管所有权，未盲目释放。';
  }else if(initial.control==='manual')results.desktopSkipped='初始已由他人接管，只读取面板，不连接桌面、不释放他人会话。';
  await step('配置、模型库、LLM调用与消息计数保持不变',async()=>{
   const final=await snapshot();results.final=final;assert.equal(final.control,initial.control);assert.equal(final.modelHash,initial.modelHash);assert.equal(final.libraryHash,initial.libraryHash);assert.equal(final.panelSettingsHash,initial.panelSettingsHash);assert.equal(final.effectiveConfigHash,initial.effectiveConfigHash);assert.deepEqual(final.model,initial.model);assert.deepEqual(final.usage,initial.usage);assert.equal(final.llmCalls,initial.llmCalls,'验收期间新增模型调用');assert.equal(final.messageCountsHash,initial.messageCountsHash,'验收期间消息状态计数变化');assert.deepEqual(results.blockedWrites,[]);assert.ok(results.writes.every(w=>['/api/control/takeover','/api/control/release'].includes(w.path)));
  });
 }
}catch(error){results.errors.push('验收异常：'+redact(error?.message||error));}
finally{
 if(ownsTakeover&&context)await step('异常清理仅释放本脚本确认的接管',releaseOwned);
 if(context&&initial)await step('记录最终只读状态',async()=>{results.final=await snapshot();if(initial.control==='paused'&&results.final.control==='manual')results.controlWarning=ownsTakeover?'本脚本接管释放未成功，需要处理当前人工接管状态。':'接管响应/所有权未确认或由外部接管；未盲目释放，请核对。';});
 if(context)try{await context.close();}catch(error){results.errors.push('关闭观察上下文：'+redact(error?.message||error));}
 if(browser)try{await browser.close();}catch(error){results.errors.push('关闭观察浏览器：'+redact(error?.message||error));}
 results.finishedAt=new Date().toISOString();writeFileSync(OUT+'/production-five-pages.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}
process.exit(results.errors.length?1:exitCode);
