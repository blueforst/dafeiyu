// 服务器合成调用流水，覆盖延迟筛选、错误、分页与键盘。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const BASE=process.env.PANEL_URL||'http://127.0.0.1:8083',OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const report={evidence:'服务器静态界面和合成账单接口，不访问生产、模型或X',checks:[],errors:[],screenshots:[]},requests=[],totals={calls:3,totalTokens:1700,input:1300,output:400,costUSD:.0006,unpriced:1,unknown:1};
const browser=await observer(),context=await browser.newContext({viewport:{width:1440,height:868}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push({name:'页面异常',error:String(e)}));
const sample=(id,more={})=>({id,startedAt:Date.now(),finishedAt:Date.now()+4630,status:'completed',provider:'OpenCode',model:'requested',actualModel:'DeepSeek V4.1 Flash',accountId:'fixture-account',purpose:'chat-test',latencyMs:4630,source:'fixture',channel:'public',interactionId:'interaction-fixture',usage:{input:1300,output:400,cacheRead:800,cacheWrite:20,cacheWrite1h:10,totalTokens:1700,reasoning:100},cost:{total:.0006},pricingStatus:'priced',...more});
let hold=null,entered=null,mode='normal';
await page.route('**/api/**',async route=>{const r=route.request(),url=new URL(r.url()),p=url.pathname;requests.push({path:p,query:url.search,method:r.method()});let data;
 if(p==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'retry:60000\n\n'});
 if(p==='/api/status')data={control:'paused',busy:false,accountId:'fixture',browser:{handle:'fixture',loggedIn:true},config:{mode:'auto',model:{configured:true,id:'fixture'}},cooldown:{}};
 else if(p==='/api/billing/activity')data={range:{from:'2025-11-01',to:'2026-10-30',weeks:52},daily:[],totals,peakDailyTokens:0,last7:{cache:{ratio:null},reply:{averageCostUSD:null}}};
 else if(p==='/api/billing/summary')data={totals,daily:[],dailyModels:[],models:[],purposes:[],cache:{ratio:null}};
 else if(p==='/api/billing/calls'){
  if(mode==='hold'){mode='normal';entered();await new Promise(resolve=>hold=resolve);return route.fulfill({status:500,json:{error:'迟到的旧错误'}});}
  if(mode==='error'){mode='normal';return route.fulfill({status:500,json:{error:'合成暂时故障'}});}
  if(url.searchParams.get('purpose')==='reply')data={items:[sample('filtered',{purpose:'reply'})],nextCursor:null};
  else if(url.searchParams.get('cursor'))data={items:[sample('next',{status:'interrupted'})],nextCursor:null};
  else data={items:[sample('first'),sample('unpriced',{status:'failed',accountId:null,usage:null,cost:null,latencyMs:null,pricingStatus:'unpriced'}),sample('<img src=x onerror=alert(1)>',{status:'started',actualModel:'<img src=x>',usage:{totalTokens:0},cost:{total:0}})],nextCursor:'next-fixture'};
 }else if(p==='/api/account/posting-limits')data={effective:{post:{limit:280},reply:{limit:280}}};
 else return route.fulfill({status:404,json:{error:'未定义合成接口 '+p}});
 await route.fulfill({json:data});
});
// 切换视口后先复位文档滚动，保留各业务滚动区；避免旧聚焦位置使顶部截图裁切。
async function shot(options){await page.evaluate(()=>{window.scrollTo(0,0);document.body.scrollTop=0;});return page.screenshot(options);}
async function check(name,fn){console.log('开始 '+name);try{await fn();report.checks.push(name);console.log('通过 '+name);}catch(e){report.errors.push({name,error:e.stack||String(e)});}}
const records=()=>page.locator('.call-ledger-row');
await check('默认懒加载、七列摘要和真实状态、未知费用',async()=>{
 await page.goto(BASE+'/#/settings/billing');await page.locator('.usage-calls').waitFor();await page.waitForFunction(()=>document.querySelector('.usage-calls-summary')?.textContent.includes('3'));
 assert.equal(requests.filter(x=>x.path==='/api/billing/calls').length,0);await page.locator('.usage-calls-summary>strong').click();await records().first().waitFor();
 assert.equal(await records().count(),3);assert.deepEqual(await page.locator('.call-ledger th').allTextContents(),['时间','状态','模型','账号 / 用途','耗时','Token','费用']);assert.match(await records().first().textContent(),/完成.*DeepSeek V4.1 Flash.*OpenCode.*fixture-account.*试聊.*4.63 s.*0.0006/s);assert.match(await records().nth(1).textContent(),/失败.*—.*未定价/s);assert.equal(await page.locator('.call-ledger img').count(),0);assert.equal(await records().first().getAttribute('aria-expanded'),'false');
});
await check('点击及回车空格展开详情、不重复请求、精确费用可查',async()=>{
 const before=requests.length,row=records().first();await row.click();assert.equal(await row.getAttribute('aria-expanded'),'true');assert.match(await page.locator('.call-ledger-detail:not([hidden])').textContent(),/调用 ID.*first.*缓存读取.*800.*1 小时缓存写入.*10/s);assert.equal(requests.length,before);await row.press('Enter');assert.equal(await row.getAttribute('aria-expanded'),'false');await row.press(' ');assert.equal(await row.getAttribute('aria-expanded'),'true');assert.equal(await row.locator('td').last().getAttribute('title'),'$0.0006');await row.press('Enter');
});
await check('分页追加保持详情与首行，下一页错误状态保留',async()=>{const node=await records().first().elementHandle();await page.getByRole('button',{name:'加载更多调用',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.call-ledger-row').length===4);assert.equal(await node.evaluate(n=>n.isConnected),true);assert.match(await records().last().textContent(),/重启中断/);assert.equal(await page.getByRole('button',{name:'加载更多调用',exact:true}).isVisible(),false);});
await check('新筛选不受旧请求阻塞、旧错误不覆盖新结果',async()=>{
 mode='hold';const ready=new Promise(resolve=>entered=resolve);await page.getByRole('button',{name:'应用筛选',exact:true}).click();await ready;
 await page.getByLabel('用途',{exact:true}).selectOption('reply');await page.waitForFunction(()=>document.querySelector('.call-ledger-row')?.textContent.includes('回复'));hold();await page.waitForTimeout(100);assert.equal(await records().count(),1);assert.ok(!(await page.locator('.usage-calls').textContent()).includes('迟到的旧错误'));
});
await check('当前请求错误显示并可重试',async()=>{mode='error';await page.getByLabel('用途',{exact:true}).selectOption('');await page.getByText(/合成暂时故障/).waitFor();const retry=page.locator('.usage-calls').getByRole('button',{name:'重新读取',exact:true});await retry.scrollIntoViewIfNeeded();await shot({path:OUT+'/billing-ledger-retry.png',fullPage:true});report.retryGeometry=await retry.evaluate(n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.outerHTML.slice(0,200)};});const box=await retry.boundingBox();assert.equal(await retry.evaluate(n=>{const b=n.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===n;}),true,'重读按钮中心被遮挡');await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await records().first().waitFor();assert.equal(await records().count(),3);});
await check('五宽浅深紧凑行、宽表只在组件内滚动和截图',async()=>{
 for(const scheme of ['light','dark'])for(const width of [375,860,1100,1280,1440]){await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width,height:868});await records().first().scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.ok((await records().first().boundingBox()).height<=55);const g=await page.locator('.call-ledger-wrap').evaluate(n=>({client:n.clientWidth,scroll:n.scrollWidth}));if(width===375)assert.ok(g.scroll>g.client);for(const expand of [false,true]){if((await records().first().getAttribute('aria-expanded')==='true')!==expand)await records().first().press('Enter');const f='billing-ledger-'+scheme+'-'+width+(expand?'-detail':'')+'.png';await shot({path:OUT+'/'+f,fullPage:true});report.screenshots.push(f);}}
 assert.deepEqual(requests.filter(x=>x.method!=='GET'),[]);
});
await browser.close();writeFileSync(OUT+'/billing-ledger-ui-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
