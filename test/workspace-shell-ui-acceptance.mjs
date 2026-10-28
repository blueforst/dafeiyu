// 服务器组件契约验收：无业务接口、模型、浏览器账号或生产数据。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const BASE=process.env.PANEL_URL||'http://127.0.0.1:8083',OUT=process.env.ARTIFACT_DIR||'/artifacts';
mkdirSync(OUT,{recursive:true});
const report={evidence:'服务器 Camoufox，独立组件夹具，无业务请求',checks:[],errors:[]};
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>工作区组件验收</title><header class="topbar"><button id="outside">外部焦点</button><button id="dispose">卸载工作区</button></header><main id="view"></main><script type="module">
import {mountWorkspace} from '/js/shell.js';
import {h} from '/js/dom.js';
const params=new URL(location.href).searchParams;
if(params.get('blocked')==='1')Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('禁用存储','SecurityError');}});
const root=document.getElementById('view');
document.documentElement.dataset.originalWidth=getComputedStyle(root).maxWidth;
const content=()=>h('div',{},Array.from({length:40},(_,i)=>h('p',{},'可滚动内容 '+i)));
const ws=mountWorkspace(root,{page:'component',left:content(),main:content(),right:params.get('right')==='0'?false:content()});
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
  assert.ok(left&&header&&title,'主区及左栏入口可见');
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
await check('卸载移除全局工作区布局并恢复原main宽度',async()=>{
 await page.setViewportSize({width:1440,height:1000});await open();assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('workspace')),true);await page.locator('#dispose').click();
 assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('workspace')),false);assert.equal(await page.locator('.ws-shell').count(),0);
 assert.equal(await page.locator('html').getAttribute('data-restored-width'),await page.locator('html').getAttribute('data-original-width'));
});
await browser.close();console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
