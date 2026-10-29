// 目录编辑器的实际交互与几何验收，仅服务器合成接口。
import {observer} from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {personaWorkspaceFixture} from './persona-workspace-fixture.mjs';
import {pickPersonaItem} from './persona-editor-driver.mjs';
const BASE=process.env.PANEL_URL||'http://127.0.0.1:8083',OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const report={evidence:'服务器隔离 Camoufox，合成资料，无真实模型',checks:[],errors:[],screenshots:[],geometry:[]};
const browser=await observer(),context=await browser.newContext({viewport:{width:1440,height:868}}),page=await context.newPage(),fx=await personaWorkspaceFixture(page);
page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push({name:'页面异常',error:String(e)}));
const current=fx.items[0],style=('中文为主，跟随对方语言。自然回应，不编造记忆；短句，避免重复开头和收尾。\n'.repeat(12)).slice(0,384);current.persona.sections[1].content=style;
current.persona.triggers.unshift({id:'steps',title:'不给步骤',condition:'对方聊到下列说法或类似意思时使用：想要详细教程',content:'不写教程和操作步骤，自然交流。',enabled:true,order:0});current.persona.triggers[1].order=1;
const input=()=>page.locator('#persona-section-1');
// 切换视口后先复位文档滚动，保留各业务滚动区；避免旧聚焦位置使顶部截图裁切。
async function shot(options){await page.evaluate(()=>{window.scrollTo(0,0);document.body.scrollTop=0;});return page.screenshot(options);}
async function check(name,fn){console.log('开始 '+name);try{await fn();report.checks.push(name);console.log('通过 '+name);}catch(e){report.errors.push({name,error:e.stack||String(e)});console.log('失败 '+name+' '+e.message);}}
async function saved(){await page.locator('#persona-save').click();await page.waitForFunction(()=>!document.querySelector('.ws-main .ws-header-content')?.textContent.includes('未保存'));}
await check('三组目录、统计、预览与选中分隔',async()=>{
 await page.goto(BASE+'/#/persona/p/current');await page.locator('#persona-section-0').waitFor();
 assert.deepEqual(await page.locator('.pe-toc h3').allTextContents(),['始终生效','触发卡','只读']);assert.equal(await page.locator('.pe-toc-item').count(),7);
 assert.equal(await page.locator('[data-pe-key="t:steps"] .pe-preview').textContent(),'想要详细教程');
 const sum=current.persona.sections.reduce((n,x)=>n+x.content.length,0)+current.persona.triggers.reduce((n,x)=>n+x.content.length+x.condition.length,0);assert.match(await page.locator('.ws-main .ws-header-content').textContent(),new RegExp(sum.toLocaleString()));
 for(const [i,x]of current.persona.sections.entries())assert.equal(await page.locator('[data-pe-key="s:'+i+'"] .pe-item-count').textContent(),String(x.content.length));
 assert.equal(await page.locator('.pe-toc').getByText(/%/).count(),0);assert.equal(await page.locator('.pe-toc-item.selected').evaluate(n=>getComputedStyle(n,'::before').display),'none');
});
await check('连续编辑不换输入节点、圆点撤销、条目切换与选中缓存',async()=>{
 await pickPersonaItem(page,'s:1');const handle=await input().elementHandle();await input().fill(style+'新增');assert.equal(await handle.evaluate(n=>n.isConnected&&n===document.activeElement),true);
 assert.equal(await page.locator('[data-pe-key="s:1"] [aria-label="未保存"]').isVisible(),true);await input().fill(style);assert.equal(await page.locator('[data-pe-key="s:1"] [aria-label="未保存"]').isVisible(),false);
 await input().fill(style+'修改');await pickPersonaItem(page,'s:2');assert.equal(await page.locator('.ws-leave-confirm').isVisible(),false);await pickPersonaItem(page,'s:1');assert.equal(await input().inputValue(),style+'修改');await input().fill(style);
 await page.locator('[data-persona-nav="p:other"]').click();await page.locator('#persona-section-0').waitFor();await page.locator('[data-persona-nav="p:current"]').click();await input().waitFor();assert.equal(await input().inputValue(),style);
});
await check('触发开关不切项、添加空卡聚焦、菜单键盘上下移动和删除',async()=>{
 const selected=await page.locator('.pe-toc-item.selected').getAttribute('data-pe-key');await page.locator('[data-pe-key="t:steps"] [role="switch"]').click();assert.equal(await page.locator('.pe-toc-item.selected').getAttribute('data-pe-key'),selected);
 await page.locator('#trigger-add').click();assert.equal(await page.getByLabel('卡名',{exact:true}).evaluate(n=>document.activeElement===n),true);await page.getByLabel('卡名',{exact:true}).fill('新卡');assert.equal(await page.locator('.pe-header [role="switch"]').getAttribute('aria-checked'),'true');
 await page.getByLabel('什么时候用',{exact:true}).fill('条件\n'.repeat(30));const height=await page.getByLabel('什么时候用',{exact:true}).evaluate(n=>({height:n.clientHeight,line:parseFloat(getComputedStyle(n).lineHeight),padding:parseFloat(getComputedStyle(n).paddingTop)*2,scroll:n.scrollHeight}));assert.ok(height.height<=height.line*8+height.padding+2);assert.ok(height.scroll>height.height);
 const menu=page.getByLabel('触发卡操作',{exact:true});await menu.focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'上移',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.pe-toc-item[data-rule]').nth(1).getAttribute('data-rule'),await page.locator('.pe-toc-item.selected').getAttribute('data-rule'));
 await menu.press('Enter');await page.getByRole('button',{name:'下移',exact:true}).focus();await page.keyboard.press('Enter');await menu.press('Enter');await page.getByRole('button',{name:'删除卡片',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.pe-toc-item.selected').getAttribute('data-pe-key'),'t:card1');await saved();
 assert.equal(fx.items[0].persona.triggers.length,2);assert.equal(fx.items[0].persona.triggers[0].enabled,false);
});
async function drag(pointerType){
 const from=page.locator('[data-pe-key="t:card1"]'),to=page.locator('[data-pe-key="t:steps"]');await from.scrollIntoViewIfNeeded();const a=await from.boundingBox(),b=await to.boundingBox(),x=a.x+a.width-12,y=a.y+15;
 if(pointerType==='mouse'){await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(b.x+100,b.y+4,{steps:12});await page.mouse.up();}
 else{const handle=from.locator('.pe-drag-handle'),opts={pointerType:'touch',pointerId:5,button:0,bubbles:true};await handle.dispatchEvent('pointerdown',{...opts,clientX:x,clientY:y});await handle.dispatchEvent('pointermove',{...opts,clientX:b.x+100,clientY:b.y+4});await handle.dispatchEvent('pointerup',{...opts,clientX:b.x+100,clientY:b.y+4});}
 assert.deepEqual(await page.locator('.pe-toc-item[data-rule]').evaluateAll(nodes=>nodes.map(n=>n.dataset.rule)),['card1','steps']);await saved();assert.deepEqual(fx.items[0].persona.triggers.map(x=>x.order),[0,1]);
}
await check('指针与触屏拖动保持本组并保存编号',async()=>{await drag('mouse');await page.reload();await page.locator('#persona-section-0').waitFor();const p=fx.items[0].persona;p.triggers.reverse();p.triggers.forEach((r,i)=>r.order=i);await page.reload();await page.locator('#persona-section-0').waitFor();await drag('touch');});
await check('固定规则为可选文本、无输入边框，预设所有字段只读',async()=>{
 await pickPersonaItem(page,'fixed');assert.equal(await page.locator('#fixed-rules').evaluate(n=>n.matches('div.pe-readonly')&&getComputedStyle(n).borderTopWidth==='0px'&&getComputedStyle(n).userSelect==='text'),true);
 await page.locator('[data-persona-nav="preset:default"]').click();await page.locator('.pe-detail').waitFor();assert.equal(await page.locator('.pe-detail input,.pe-detail textarea').count(),0);assert.match(await page.locator('.ws-main .ws-header-content').textContent(),/只读模板/);await pickPersonaItem(page,'t:card1');assert.equal(await page.locator('.pe-detail input,.pe-detail textarea').count(),0);assert.equal(await page.locator('.pe-header [role="switch"]').isDisabled(),true);await pickPersonaItem(page,'bio');assert.equal(await page.locator('.pe-readonly[aria-label="建议简介"]').textContent(),'AI 自动回复');
});
await check('五宽浅深实际几何与截图：输入铺满、384字完整显示、只读窄屏',async()=>{
 await page.locator('[data-persona-nav="p:current"]').click();await page.locator('.pe-detail').waitFor();await page.evaluate(()=>{const n=document.getElementById('notice');n.hidden=true;n.textContent='';});
 for(const scheme of ['light','dark'])for(const width of [375,860,1100,1280,1440]){
  await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width,height:868});await pickPersonaItem(page,'s:1');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const g=await page.evaluate(()=>{const host=document.querySelector('.pe-host'),toc=document.querySelector('.pe-toc'),field=document.querySelector('.pe-fields'),input=document.querySelector('#persona-section-1'),a=input.getBoundingClientRect(),b=field.getBoundingClientRect();return{overflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:host.scrollWidth>host.clientWidth+1,toc:getComputedStyle(toc).display,tocWidth:toc.getBoundingClientRect().width,inputHeight:a.height,bottomGap:b.bottom-a.bottom,scroll:input.scrollHeight,client:input.clientHeight,resize:getComputedStyle(input).resize};});report.geometry.push({scheme,width,...g});assert.equal(g.overflow,false);assert.equal(g.mainOverflow,false);assert.ok(g.inputHeight>=300,JSON.stringify(g));assert.ok(g.bottomGap<=25,JSON.stringify(g));assert.equal(g.resize,'vertical');if(width>=1100)assert.ok(g.scroll<=g.client+1,'384字未完整显示');if(width===1100)assert.equal(g.tocWidth,260);if(width<=860){assert.equal(g.toc,'none');assert.deepEqual(await page.locator('.pe-mobile-controls optgroup').evaluateAll(n=>n.map(x=>x.label)),['始终生效','触发卡','只读']);}
  for(const key of ['s:1','t:steps','fixed']){await pickPersonaItem(page,key);const file='persona-editor-'+key.replace(':','-')+'-'+scheme+'-'+width+'.png';await shot({path:OUT+'/'+file,fullPage:true});report.screenshots.push(file);}
 }
});
await check('输入框保留手动纵向拉伸与邻项导航',async()=>{await page.setViewportSize({width:1440,height:868});await pickPersonaItem(page,'s:1');await input().evaluate(n=>{n.style.height='800px';});assert.ok((await input().boundingBox()).height>=799);await pickPersonaItem(page,'s:3');await page.getByRole('button',{name:'下一项 '+fx.items[0].persona.triggers[0].title,exact:true}).click();assert.equal(await page.locator('.pe-header>b').textContent(),fx.items[0].persona.triggers[0].title);});
await browser.close();writeFileSync(OUT+'/persona-editor-ui-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
