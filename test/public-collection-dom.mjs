// 仅服务器隔离 Camoufox；所有请求由本脚本合成响应，禁止访问真实平台。
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {observer} from '/opt/role-camoufox/launch.mjs';
import {collectReadyPublic,readPublicPageSnapshot,readPublicPinStates} from '../dist/public-collection.js';
import {readTweets} from '../dist/browser.js';

const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const worker='fixture_worker',stamp=new Date().toISOString();
const nativeRows=new Map(),parents={'601':'501','602':'502','603':'503','604':'504','605':'505'};
const article=(handle,id,text,options={})=>{
 const parent=parents[id]??null;nativeRows.set(id,{rest_id:id,legacy:{conversation_id_str:parent??id,in_reply_to_status_id_str:parent,...(parent?{in_reply_to_screen_name:worker}:{}),created_at:options.time||stamp},core:{user_results:{result:{legacy:{screen_name:handle}}}}});
 const body=handle===worker?text:'@'+worker+' '+text;
 return `<article data-testid="tweet">${options.social===undefined?'':'<div data-testid="socialContext">'+options.social+'</div>'}<a href="/${handle}/status/${id}"><time${options.time===null?'':' datetime="'+(options.time||stamp)+'"'}></time></a><div data-testid="tweetText">${body}</div></article>`;
};
const pageHTML=(body,script='')=>'<!doctype html><html><body>'+body+(script?'<script>'+script+'</script>':'')+'</body></html>';
const report={evidence:'真实隔离 Camoufox + 合成 DOM，所有网络请求均被脚本拦截；没有真实 X 页面或账号',checks:[],errors:[],requests:[],platformVisited:false};
const browser=await observer(),context=await browser.newContext(),page=await context.newPage();let scenario='mentions',releaseOldRead;
function nativeFixtures(html){return html.replace('</body>',`<script>fetch('/i/api/graphql/fixture/Relations')</script></body>`);}
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());report.requests.push({origin:url.origin,path:url.pathname});
 if(url.origin!=='https://x.com'){await route.abort();return;}
 if(url.pathname==='/i/api/graphql/fixture/UserOriginalsTimeline'){await new Promise(resolve=>{releaseOldRead=resolve;});await route.abort('aborted').catch(()=>{});return;}
 if(url.pathname==='/i/api/graphql/fixture/Relations'){await route.fulfill({status:200,json:{data:[...nativeRows.values()]}});return;}
 if(url.pathname==='/i/api/graphql/fixture/ViewerBadgeCounts'){await new Promise(resolve=>setTimeout(resolve,100));await route.fulfill({status:429,json:{errors:[{message:'合成辅助计数限流'}]}});return;}
 if(url.pathname==='/i/api/graphql/fixture/NotificationsTimeline'){const status=scenario==='native-error'?503:scenario==='main-429'?429:200;await new Promise(resolve=>setTimeout(resolve,status===200?1200:300));await route.fulfill({status,json:{ready:status===200}});return;}
 nativeRows.clear();let html;
 if(url.pathname==='/notifications/mentions'){
  const badgeScript=['badge-429','main-429'].includes(scenario)?"void fetch('/i/api/graphql/fixture/ViewerBadgeCounts').catch(()=>{});":'';
  html=scenario==='unknown'?pageHTML('<main><div>尚未水合的列表</div></main>'):['native-pending','native-error','badge-429','main-429'].includes(scenario)?pageHTML('<main>'+article('visitor','403','旧缓存评论')+'</main>',badgeScript+`fetch('/i/api/graphql/fixture/NotificationsTimeline').then(response=>{if(!response.ok)throw Error('合成读取故障');return response.json()}).then(()=>{document.querySelector('main').insertAdjacentHTML('beforeend',${JSON.stringify(article('visitor','404','原生读取结束后出现的新评论'))})}).catch(()=>{})`):pageHTML('<main><div role="progressbar">正在读取</div></main>',`setTimeout(()=>{document.querySelector('main').innerHTML=${JSON.stringify(article('visitor','401','正文中出现 No results 也不能被过滤'))}},1100)`);
 }else if(url.pathname==='/search')html=scenario==='navigation-isolation'?pageHTML('<main>'+article('visitor','403','新页中的旧缓存评论')+'</main>',`fetch('/i/api/graphql/fixture/NotificationsTimeline').then(response=>response.json()).then(()=>{document.querySelector('main').insertAdjacentHTML('beforeend',${JSON.stringify(article('visitor','404','新页原生读取完成后的评论'))})})`):pageHTML('<main><div data-testid="emptyState"><h2>No results</h2></div></main>');
 else if(url.pathname==='/'+worker){
  const old='2020-01-01T00:00:00Z',middle='2022-01-01T00:00:00Z',latest='2024-01-01T00:00:00Z';
  const content=scenario==='pinned'?article(worker,'501','置顶旧帖',{social:'Pinned',time:old})+article(worker,'502','较早主帖',{time:old})+article(worker,'503','最新主帖',{time:latest})+article(worker,'504','次新主帖',{time:middle}):scenario==='no-pinned'?article(worker,'502','较早主帖',{time:old})+article(worker,'505','缺少时间的主帖',{time:null})+article(worker,'504','次新主帖',{time:middle})+article(worker,'503','最新主帖',{time:latest}):scenario==='unknown-pin'?article(worker,'501','已置顶旧帖',{social:'已置顶',time:old})+article(worker,'502','未知标记主帖',{social:'无法识别的新标记',time:old})+article(worker,'503','时间最新主帖',{time:latest})+article(worker,'504','次新主帖',{time:middle}):article(worker,'501','自己的普通主帖一')+article(worker,'502','自己的普通主帖二');
  html=pageHTML('<main>'+content+'</main>');
 }
 else if(url.pathname==='/'+worker+'/status/501'){
  html=scenario==='deleted'?pageHTML('<main><div data-testid="error-detail">This Post was deleted</div></main>'):pageHTML('<main>'+article(worker,'501','自己的普通主帖一')+'<div role="progressbar">正在读取回复</div></main>',`setTimeout(()=>{document.querySelector('main').innerHTML=${JSON.stringify(article(worker,'501','自己的普通主帖一')+article('visitor','601','晚到但应被采集的普通新回复'))}},1200)`);
 }else if(url.pathname==='/'+worker+'/status/502')html=pageHTML('<main>'+article(worker,'502','自己的普通主帖二')+article('other_visitor','602','第二个主帖中的普通新回复')+'</main>');
 else if(url.pathname==='/'+worker+'/status/503')html=pageHTML('<main>'+article(worker,'503','自己的较新主帖')+article('other_visitor','603','较新主帖中的普通新回复')+'</main>');
 else if(url.pathname==='/'+worker+'/status/504')html=pageHTML('<main>'+article(worker,'504','自己的次新主帖')+article('other_visitor','604','次新主帖中的普通新回复')+'</main>');
 else if(url.pathname==='/'+worker+'/status/505')html=pageHTML('<main>'+article(worker,'505','自己的时间未知主帖',{time:null})+article('other_visitor','605','时间未知主帖中的可靠回复')+'</main>');
 else{await route.abort();return;}
 // 通知正文的提及由夹具直接给出；线程回复另外携带固定父帖元数据。
 await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:nativeFixtures(html)});
});
const run=source=>collectReadyPublic({page,handle:worker,source,deadline:Date.now()+15000,readTweets,navigate:async(p,url,deadline)=>p.goto(url,{waitUntil:'domcontentloaded',timeout:Math.max(1,Math.min(5000,deadline-Date.now()))})});
async function check(name,fn){console.log('[开始] '+name);try{await fn();report.checks.push(name);console.log('[通过] '+name);}catch(error){report.errors.push({name,error:error.stack||String(error)});console.log('[失败] '+name);}}
try{
 await check('main先出现、文章稍后水合，正文中的空提示词不会被过滤',async()=>{scenario='mentions';const result=await run(0);assert.deepEqual(result.events.map(e=>e.platformId),['401']);assert.equal(result.diagnostics[0].status,'ok');assert.equal(result.warnings.length,0);});
 await check('无spinner的旧缓存仍等待页面原生列表读取结束',async()=>{scenario='native-pending';const result=await run(0);assert.deepEqual(result.events.map(e=>e.platformId),['403','404']);assert.equal(result.diagnostics[0].status,'ok');});
 await check('原生读取失败时旧缓存只算部分结果，不伪报成功',async()=>{scenario='native-error';const result=await run(0);assert.deepEqual(result.events.map(e=>e.platformId),['403']);assert.equal(result.diagnostics[0].status,'partial');assert.equal(result.diagnostics[0].code,'public-page-error');});
 await check('同页ViewerBadgeCounts429不阻塞，仍等待真正时间线读取完成',async()=>{scenario='badge-429';const result=await run(0);assert.deepEqual(result.events.map(e=>e.platformId),['403','404']);assert.equal(result.diagnostics[0].status,'ok');assert.equal(result.warnings.length,0);});
 await check('同页辅助429不能掩盖真正时间线429',async()=>{scenario='main-429';const result=await run(0);assert.deepEqual(result.events.map(e=>e.platformId),['403']);assert.equal(result.diagnostics[0].status,'partial');assert.equal(result.diagnostics[0].code,'public-page-error');});
 await check('新导航截断上一页原生读取不污染新来源，新页inline读取仍等待完成',async()=>{
  scenario='navigation-isolation';await page.goto('https://x.com/'+worker,{waitUntil:'domcontentloaded'});
  const oldPath='/i/api/graphql/fixture/UserOriginalsTimeline';let sawOldAbort=false;
  const failed=request=>{if(new URL(request.url()).pathname===oldPath)sawOldAbort=true;};page.on('requestfailed',failed);
  try{
   const result=await collectReadyPublic({page,handle:worker,source:1,deadline:Date.now()+15000,readTweets,navigate:async(p,url)=>{
    const started=p.waitForEvent('request',{predicate:request=>new URL(request.url()).pathname===oldPath,timeout:3000});
    await p.evaluate(path=>{void fetch(path).catch(()=>{});},oldPath);await started;
    const committed=frame=>{if(frame===p.mainFrame())releaseOldRead?.();};p.on('framenavigated',committed);
    try{await p.goto(url,{waitUntil:'domcontentloaded'});}finally{p.off('framenavigated',committed);releaseOldRead?.();}
   }});
   assert.equal(sawOldAbort,true);assert.deepEqual(result.events.map(e=>e.platformId),['403','404']);assert.equal(result.diagnostics[0].status,'ok');assert.equal(result.warnings.length,0);
  }finally{releaseOldRead?.();releaseOldRead=undefined;page.off('requestfailed',failed);}
 });
 await check('显式空结果通过专用状态节点确认',async()=>{scenario='search-empty';const result=await run(1);assert.equal(result.events.length,0);assert.equal(result.diagnostics[0].status,'empty');assert.equal((await readPublicPageSnapshot(page)).empty,'timeline');});
 await check('profile进入两篇主帖，评论延后水合也会保留',async()=>{scenario='thread';const result=await run(2);assert.deepEqual(result.events.map(e=>e.platformId),['601','602']);assert.equal(result.diagnostics[0].readyPages,3);assert.equal(result.diagnostics[0].status,'ok');});
 await check('删除主帖明确失败，不阻止另一主帖的新评论',async()=>{scenario='deleted';const result=await run(2);assert.deepEqual(result.events.map(e=>e.platformId),['602']);assert.equal(result.diagnostics[0].status,'partial');assert.equal(result.diagnostics[0].code,'public-target-unavailable');});
 await check('未知空白main不会伪报可靠空集',async()=>{scenario='unknown';const result=await collectReadyPublic({page,handle:worker,source:0,deadline:Date.now()+3000,pageTimeoutMs:900,readTweets,navigate:async(p,url)=>p.goto(url,{waitUntil:'domcontentloaded'})});assert.equal(result.events.length,0);assert.equal(result.diagnostics[0].status,'failed');assert.ok(result.warnings.length>0);});
 await check('文章引用的删除提示不冒充页面删除状态',async()=>{await page.goto('https://x.com/'+worker+'/status/502',{waitUntil:'domcontentloaded'});await page.locator('main').evaluate(main=>{const article=main.querySelector('article');const state=document.createElement('div');state.setAttribute('role','alert');state.textContent='This Post was deleted';article.appendChild(state);});assert.equal((await readPublicPageSnapshot(page)).error,null);});
 await check('明确置顶旧帖不占名额，其余按可靠时间降序扫描两条',async()=>{scenario='pinned';const start=report.requests.length,result=await run(2),paths=report.requests.slice(start).map(r=>r.path);assert.deepEqual(result.events.map(e=>e.platformId),['603','604']);assert.ok(!paths.includes('/'+worker+'/status/501'));assert.ok(!paths.includes('/'+worker+'/status/502'));assert.equal(result.diagnostics[0].status,'ok');assert.equal(result.warnings.length,0);});
 await check('完全无socialContext不告警，时间乱序和不可靠时间按既定规则处理',async()=>{scenario='no-pinned';const result=await run(2);assert.deepEqual(result.events.map(e=>e.platformId),['603','604']);assert.equal(result.warnings.length,0);assert.equal(result.diagnostics[0].status,'ok');});
 await check('未知socialContext提示且按原顺序扫描，仍跳过明确已置顶',async()=>{scenario='unknown-pin';const start=report.requests.length,result=await run(2),paths=report.requests.slice(start).map(r=>r.path);assert.deepEqual(result.events.map(e=>e.platformId),['602','603']);assert.ok(!paths.includes('/'+worker+'/status/501'));assert.ok(result.warnings.some(w=>w.includes('置顶')));assert.equal(result.diagnostics[0].code,'public-pin-unrecognized');assert.equal(result.diagnostics[0].failedPages,0);});
 await check('引用容器里的置顶标记不会被当成本人的置顶状态',async()=>{await page.goto('https://x.com/'+worker+'/status/502',{waitUntil:'domcontentloaded'});await page.locator('article').first().evaluate(article=>{const quote=document.createElement('div');quote.dataset.testid='quoteTweet';quote.setAttribute('role','link');quote.innerHTML='<div data-testid="socialContext">Pinned</div><a href="/quoted/status/999"><time></time></a>';article.insertBefore(quote,article.firstChild);});const pins=await readPublicPinStates(page);assert.equal(pins.find(p=>p.platformId==='502')?.state,'plain');assert.ok(!pins.some(p=>p.platformId==='999'));await page.locator('article').first().evaluate(article=>{const marker=document.createElement('div');marker.dataset.testid='socialContext';marker.textContent='置顶';article.appendChild(marker);});assert.equal((await readPublicPinStates(page)).find(p=>p.platformId==='502')?.state,'pinned');});
}finally{await context.close();await browser.close();report.passed=report.checks.length;report.failed=report.errors.length;writeFileSync(OUT+'/public-collection-dom.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;}
