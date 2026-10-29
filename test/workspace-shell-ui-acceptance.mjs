// 服务器组件契约验收：无业务接口、模型、浏览器账号或生产数据。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const BASE=process.env.PANEL_URL||'http://127.0.0.1:8083',OUT=process.env.ARTIFACT_DIR||'/artifacts';
mkdirSync(OUT,{recursive:true});
const report={evidence:'服务器 Camoufox，独立组件夹具，无业务请求',checks:[],errors:[]};
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>工作区组件验收</title><header class="topbar"><button id="outside">外部焦点</button><button id="dispose">卸载工作区</button></header><main id="view"></main><script type="module">
import * as shell from '/js/shell.js';
const {mountWorkspace}=shell;window.__shell=shell;
import {h} from '/js/dom.js';
const params=new URL(location.href).searchParams;
if(params.get('blocked')==='1')Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('禁用存储','SecurityError');}});
const root=document.getElementById('view');
document.documentElement.dataset.originalWidth=getComputedStyle(root).maxWidth;
const content=()=>h('div',{},Array.from({length:40},(_,i)=>h('p',{},'可滚动内容 '+i)));
const ws=mountWorkspace(root,{page:'component',left:content(),main:content(),right:params.get('right')==='0'?false:content()});
window.__workspace=ws;
ws.leftHeader.append('左栏');ws.mainHeader.append('主区');ws.rightHeader.append('右栏');
document.getElementById('dispose').onclick=()=>{ws.dispose();document.documentElement.dataset.restoredWidth=getComputedStyle(root).maxWidth;document.documentElement.dataset.disposed='1';};
document.documentElement.dataset.ready='1';
</script></html>`;
const browser=await observer(),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
page.setDefaultTimeout(12000);
page.on('pageerror',error=>report.errors.push({name:'页面异常',error:String(error)}));
await page.route('**/workspace-shell-fixture**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
async function open(query=''){await page.goto(BASE+'/workspace-shell-fixture'+query);await page.waitForSelector('html[data-ready="1"]');}
async function check(name,fn){console.log('开始 '+name);try{await fn();report.checks.push(name);console.log('通过 '+name);}catch(error){report.errors.push({name,error:String(error.stack||error)});}finally{writeFileSync(OUT+'/workspace-shell-ui-acceptance.json',JSON.stringify(report,null,2));}}
await check('两栏与三栏页头同行，整体不滚动',async()=>{
 for(const right of ['0','1']){
  await open('?right='+right);assert.equal(await page.locator('.ws-right').isVisible(),right==='1');
  const dimensions=await page.locator('.ws-pane:not([hidden])>.ws-header').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {top:b.top,height:b.height};}));
  assert.ok(dimensions.every(b=>b.top===dimensions[0].top&&b.height===44));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+1),false);
  assert.ok(await page.locator('.ws-main>.ws-content').evaluate(node=>node.scrollHeight>node.clientHeight));
 }
});
await check('收起存储与重新加载恢复，控制关系可访问',async()=>{
 await open();const close=page.getByRole('button',{name:'收起右栏',exact:true}).first();
 const controlled=await close.getAttribute('aria-controls');assert.ok(controlled);assert.equal(await close.getAttribute('aria-expanded'),'true');
 await close.click();assert.equal(await page.locator('#'+controlled).isVisible(),false);await page.reload();await page.waitForSelector('html[data-ready="1"]');
 assert.equal(await page.locator('.ws-right').isVisible(),false);await page.getByRole('button',{name:'展开右栏',exact:true}).click();
 assert.equal(await page.locator('.ws-right').isVisible(),true);
});
await check('侧栏图标按状态变化且键盘切换保留可见焦点',async()=>{
 await page.setViewportSize({width:1440,height:900});await open();if(await page.getByRole('button',{name:'展开左栏',exact:true}).isVisible())await page.getByRole('button',{name:'展开左栏',exact:true}).click();if(await page.getByRole('button',{name:'展开右栏',exact:true}).isVisible())await page.getByRole('button',{name:'展开右栏',exact:true}).click();
 const close=page.getByRole('button',{name:'收起左栏',exact:true});await close.focus();const before=await close.locator('svg g path').last().getAttribute('d');await close.press('Enter');const launch=page.getByRole('button',{name:'展开左栏',exact:true});assert.equal(await launch.evaluate(node=>document.activeElement===node),true);assert.notEqual(await launch.locator('svg g path').last().getAttribute('d'),before);await launch.press('Space');assert.equal(await close.isVisible(),true);assert.equal(await close.evaluate(node=>document.activeElement===node),true);
 const rightClose=page.locator('.ws-right').getByRole('button',{name:'收起右栏',exact:true});await rightClose.focus();await rightClose.press('Enter');assert.equal(await page.getByRole('button',{name:'展开右栏',exact:true}).evaluate(node=>document.activeElement===node),true);
 await page.setViewportSize({width:375,height:900});await page.getByRole('button',{name:'展开左栏',exact:true}).click();assert.equal(await close.locator('svg rect').isVisible(),false);assert.equal(await close.locator('svg>path').isVisible(),true);await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'展开左栏',exact:true}).evaluate(node=>document.activeElement===node),true);
 await page.setViewportSize({width:1440,height:900});if(await page.getByRole('button',{name:'展开左栏',exact:true}).isVisible())await page.getByRole('button',{name:'展开左栏',exact:true}).click();if(await page.getByRole('button',{name:'展开右栏',exact:true}).isVisible())await page.getByRole('button',{name:'展开右栏',exact:true}).click();
});
await check('禁用存储时默认展开且交互不异常',async()=>{
 await open('?blocked=1');assert.equal(await page.locator('.ws-left').isVisible(),true);assert.equal(await page.locator('.ws-right').isVisible(),true);
 await page.getByRole('button',{name:'收起左栏',exact:true}).first().click();assert.equal(await page.locator('.ws-left').isVisible(),false);
 await page.reload();await page.waitForSelector('html[data-ready="1"]');assert.equal(await page.locator('.ws-left').isVisible(),true);
});
await check('左栏展开入口靠左，右栏入口靠右，宽窄屏浅深色布局一致',async()=>{
 for(const scheme of ['light','dark'])for(const width of [1440,1280,860,375])for(const right of ['0','1']){
  await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width,height:900});await open('?right='+right);
  const close=page.getByRole('button',{name:'收起左栏',exact:true});if(await close.isVisible())await close.click();
  const launcher=page.getByRole('button',{name:'展开左栏',exact:true}),header=await page.locator('.ws-main>.ws-header').boundingBox(),left=await launcher.boundingBox(),title=await page.locator('.ws-main .ws-header-content').boundingBox();
  assert.ok(left&&header&&title,'主区及左栏入口可见');const icon=await launcher.locator('svg').evaluate(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});assert.ok(icon&&icon.width===16&&icon.height===16,JSON.stringify({scheme,width,right,icon}));assert.ok(Math.abs(icon.x+icon.width/2-left.x-left.width/2)<1&&Math.abs(icon.y+icon.height/2-left.y-left.height/2)<1,'图标须在点击区域中居中');
  await page.screenshot({path:OUT+`/shell-collapsed-${scheme}-${width}-right-${right}.png`});
  assert.ok(left.x>=header.x&&left.x<=header.x+16,`${scheme}/${width}/${right} 左栏入口应贴近主区左缘，实际 x=${left.x}`);
  assert.ok(left.x+left.width<=title.x+1,'左栏入口在标题之前');
  if(right==='1'){const control=await page.locator('.ws-main .ws-header-tools button').boundingBox();assert.ok(control.x>left.x+left.width&&control.x+control.width>=header.x+header.width-16,'右栏入口仍在主区右端');}
  await launcher.click();assert.equal(await page.locator('.ws-left').isVisible(),true);
  if(width<=860)await page.keyboard.press('Escape');else await page.getByRole('button',{name:'收起左栏',exact:true}).click();
  assert.equal(await launcher.isVisible(),true);
 }
});
await check('375px抽屉与浮层焦点、Esc恢复、无整体横溢',async()=>{
 await page.setViewportSize({width:375,height:900});await open();assert.equal(await page.locator('.ws-left').isVisible(),false);assert.equal(await page.locator('.ws-right').isVisible(),false);
 const trigger=page.getByRole('button',{name:'展开右栏',exact:true});await trigger.click();assert.equal(await page.locator('.ws-right[role="dialog"]').isVisible(),true);
 assert.equal(await page.locator('.ws-right').evaluate(node=>node.contains(document.activeElement)),true);await page.keyboard.press('Escape');assert.equal(await page.locator('.ws-right').isVisible(),false);assert.equal(await trigger.evaluate(node=>document.activeElement===node),true);
 await page.getByRole('button',{name:'展开左栏',exact:true}).click();assert.equal(await page.locator('.ws-left').isVisible(),true);await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
});
await check('共用头像、完整表情、六组浅深配色和五分钟分隔',async()=>{
 await page.setViewportSize({width:1440,height:1000});await open();
 const values=await page.evaluate(async()=>{const s=await import(location.origin+'/js/shell.js');const first=s.avatar('🧑‍💻角色','stable'),second=s.avatar('另一个名','stable'),empty=s.avatar('');const at=Date.parse('2026-10-29T12:00:00+08:00');return {first:first.textContent,same:first.className===second.className,empty:empty.textContent,times:[s.timeDivider(null,at),s.timeDivider(at,at+120000),s.timeDivider(at,at+480000),s.timeDivider(Date.parse('2026-10-29T23:59:00+08:00'),Date.parse('2026-10-30T00:01:00+08:00'))]};});
 assert.equal(values.first,'🧑‍💻');assert.equal(values.same,true);assert.equal(values.empty,'?');assert.ok(values.times[0]);assert.equal(values.times[1],null);assert.ok(values.times[2]);assert.ok(values.times[3]);
 report.avatarContrast={};for(const scheme of ['light','dark']){await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'});const ratios=await page.evaluate(async()=>{const shell=await import(location.origin+'/js/shell.js'),host=document.querySelector('.ws-main>.ws-content');host.replaceChildren();const luminance=value=>{const rgb=value.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};return Array.from({length:6},(_,i)=>{const a=shell.avatar('字');a.className='ws-avatar ws-avatar-'+(i+1);host.append(a);const css=getComputedStyle(a),x=luminance(css.color),y=luminance(css.backgroundColor);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);});});assert.ok(ratios.every(r=>r>=4.5),scheme+'头像对比度');report.avatarContrast[scheme]=ratios;}
});
await check('回复选择、操作隔离、摘要显隐和详情首行顶端对齐',async()=>{
 await open();await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 await page.evaluate(async()=>{const s=await import(location.origin+'/js/shell.js');document.documentElement.dataset.selected='0';document.documentElement.dataset.buttons='0';const child=document.createElement('button');child.id='reply-child';child.textContent='操作';child.onclick=()=>document.documentElement.dataset.buttons=String(Number(document.documentElement.dataset.buttons)+1);const r=s.reply({name:'角色',avatar:s.avatar('角色'),body:'正文',actions:[child],stats:'统计',id:'sample-reply',onselect:event=>{document.documentElement.dataset.selected=String(Number(document.documentElement.dataset.selected)+1);event.currentTarget.classList.add('selected');}});document.querySelector('.ws-main>.ws-content').classList.add('ws-thread');document.querySelector('.ws-main>.ws-content').replaceChildren(r);const rows=document.createElement('div');rows.id='align-rows';rows.style.width='240px';rows.append(s.detailRow('模型','x'.repeat(40)),s.detailRow('耗时','12 ms'));document.querySelector('.ws-right>.ws-content').replaceChildren(rows);});
 const row=page.locator('#sample-reply'),stat=row.locator('.ws-stat');await page.mouse.move(0,0);assert.equal(await stat.evaluate(n=>getComputedStyle(n).opacity),'0');await row.hover();assert.equal(await stat.evaluate(n=>getComputedStyle(n).opacity),'1');await page.mouse.move(0,0);await row.focus();assert.equal(await stat.evaluate(n=>getComputedStyle(n).opacity),'1');await row.press('Enter');await row.press('Space');assert.equal(await page.evaluate(()=>Number(document.documentElement.dataset.selected)),2);await page.locator('#reply-child').click();assert.equal(await page.evaluate(()=>Number(document.documentElement.dataset.selected)),2);assert.equal(await page.evaluate(()=>Number(document.documentElement.dataset.buttons)),1);
 await row.locator('.ws-reply-name').click();assert.equal(await page.evaluate(()=>Number(document.documentElement.dataset.selected)),3);await page.mouse.move(0,0);assert.equal(await stat.evaluate(n=>getComputedStyle(n).opacity),'1');
 const alignment=await page.locator('.ws-detail-row').evaluateAll(rows=>rows.map(r=>{const [label,value]=r.children,a=label.getBoundingClientRect(),b=value.getBoundingClientRect();return {top:Math.abs(a.top-b.top),label:a.height,value:b.height};}));assert.ok(alignment.every(x=>x.top<=1));assert.ok(alignment[0].value>alignment[0].label);
 // 直接激活媒体规则，模拟 hover:none；验证触屏不会因悬停或聚焦显露摘要。
 await page.evaluate(()=>{for(const sheet of document.styleSheets)for(const rule of sheet.cssRules)if(rule.conditionText==='(hover: none)'||rule.conditionText==='(hover:none)')rule.media.mediaText='all';document.querySelector('#sample-reply').classList.remove('selected');});
 await row.hover();await row.focus();assert.equal(await stat.evaluate(n=>getComputedStyle(n).opacity),'0');await row.press('Enter');assert.equal(await stat.evaluate(n=>getComputedStyle(n).opacity),'1');
});
await check('卸载移除全局工作区布局并恢复原main宽度',async()=>{
 await page.setViewportSize({width:1440,height:1000});await open();assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('workspace')),true);await page.locator('#dispose').click();
 assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('workspace')),false);assert.equal(await page.locator('.ws-shell').count(),0);
 assert.equal(await page.locator('html').getAttribute('data-restored-width'),await page.locator('html').getAttribute('data-original-width'));
});
await browser.close();console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
