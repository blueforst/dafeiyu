// 服务器 Camoufox：实际公开预设文案、合成 API；不使用生产 profile 或真实模型。
import {observer} from '/opt/role-camoufox/launch.mjs';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const ROOT=resolve(process.env.PUBLIC_DIR||'/app/public'),OUT=process.env.ARTIFACT_DIR||'/artifacts';
const catalog=JSON.parse(readFileSync(process.env.PRESET_CATALOG||'/fixtures/persona-presets-catalog.json','utf8'));
assert.equal(catalog.version,2);assert.deepEqual(catalog.items.map(x=>x.id),['default','deepseek','gpt','claude','kimi','glm']);mkdirSync(OUT,{recursive:true});
const clone=value=>structuredClone(value),preset=id=>catalog.items.find(x=>x.id===id);
const normalize=value=>{const result=clone(value);for(const trigger of result.triggers)if(trigger.keywords)trigger.keywords=trigger.keywords.map(x=>x.normalize('NFKC').trim());return result;};
const clipboardFixture="Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{\n  const mode=document.documentElement.dataset.copyMode;\n  if(mode==='fail')throw Error('合成剪贴板拒绝');\n  if(mode==='hold')await new Promise(done=>document.addEventListener('test-copy-release',done,{once:true}));\n  document.documentElement.dataset.copiedBio=text;\n }}});";
const server=createServer((req,res)=>{try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=resolve(ROOT,'.'+(name==='/'?'/index.html':name));if(!file.startsWith(ROOT+'/'))throw Error();res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript'})[extname(file)]||'text/plain'});const content=readFileSync(file);res.end(extname(file)==='.html'?content.toString().replace('</head>','<script>'+clipboardFixture+'</script></head>'):content);}catch{res.writeHead(404);res.end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const BASE='http://127.0.0.1:'+server.address().port;
const report={evidence:'服务器隔离 Camoufox，正式预设文案与合成 API；未访问生产、X 或真实模型',catalogVersion:catalog.version,checks:[],errors:[],screenshots:[]};
let savedPersona,revision,failPresetReads=false,failSave=false,saveGate=null,adoptGate=null,estimates,runs,sequence=0,caseId=0;
const requests=[],dialogs=[],gates=new Set();
function gate(){let release,entered;const started=new Promise(done=>entered=done),wait=new Promise(done=>release=done);const value={wait,entered,started,release:()=>{release();gates.delete(value);}};gates.add(value);return value;}
const browser=await observer(),context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();page.setDefaultTimeout(8000);
await context.route('**/*',route=>new URL(route.request().url()).origin===BASE?route.continue():route.abort());
await page.route('**/api/**',async route=>{
 const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();let body;try{body=request.postDataJSON();}catch{}
 requests.push({path,method,body});let data,status=200;
 if(path==='/api/events'){await route.fulfill({contentType:'text/event-stream',body:'retry: 10000\n\n'});return;}
 if(path==='/api/status')data={control:'paused',busy:false,accountId:'fixture_worker',browser:{loggedIn:true,handle:'fixture_worker'},config:{mode:'draft',model:{configured:true,provider:'fixture',id:'fixture-model'}}};
 else if(path==='/api/persona/presets'){if(failPresetReads){status=503;data={error:'合成预设读取失败'};}else data=clone(catalog);}
 else if(path==='/api/persona'&&method==='PUT'){
  assert.deepEqual(Object.keys(body).sort(),['persona','revision']);
  if(failSave||body.revision!==revision){status=409;data={error:'合成人设修订冲突，请重新核对'};}
  else{savedPersona=normalize(body.persona);revision++;data={persona:clone(savedPersona),revision};if(saveGate){const waiting=saveGate;saveGate=null;waiting.entered();await waiting.wait;}}
 }
 else if(path==='/api/persona')data={persona:clone(savedPersona),revision,fixedRules:'明确是 AI 自动回复；不能查看对方主页和历史帖子。'};
 else if(path==='/api/persona/daily')data={status:'missing',date:'2026-10-28',history:[],scheduleTime:'06:00'};
 else if(path==='/api/persona/prompt-hints')data={promptHints:{lateEnabled:true,lateMinutes:60,languageEnabled:true,openingEnabled:true,openingCount:12,expressionEnabled:true,kaomojiPer10:1,emojiPer10:2,tildePer10:1,replyCheckEnabled:true},revision:0};
 else if(path==='/api/persona/preview')data={draft:{action:'reply',text:'合成试聊回复'},fees:{requests:1,estimatedUsd:.001,unpriced:0,unknown:0},hits:[{title:'不给步骤',reason:'关键词：怎么做'}],segments:[{title:'静态人格',kind:'persona',role:'system',stable:true,content:body.persona.sections.map(x=>x.content).join('\n')}],meta:{promptVersion:'reply-context-v2'}};
 else if(path==='/api/persona/replay/estimate'){
  const id='estimate-'+(++sequence);estimates.set(id,clone(body));data={estimateId:id,requests:1,samples:1,estimatedUsd:.001,pricingStatus:'estimated'};
 }
 else if(path.startsWith('/api/persona/replay/estimates/')&&method==='DELETE'){estimates.delete(path.split('/').at(-1));data={ok:true};}
 else if(path==='/api/persona/replay/runs'&&method==='POST'){
  const input=estimates.get(body.estimateId);assert.ok(input);const run={id:'run-'+(++sequence),status:'completed',compare:'persona',canAdopt:true,persona:normalize(input.persona),personaRevision:input.personaRevision,createdAt:Date.now(),summary:{total:1,completed:1,fees:{calls:1,costUSD:.001,unpriced:0}},items:[]};runs.set(run.id,run);data={run};
 }
 else if(path==='/api/persona/replay/runs')data={items:[...runs.values()]};
 else if(path.endsWith('/adopt')){
  const run=runs.get(path.split('/').at(-2));assert.ok(run);if(run.personaRevision!==revision){status=409;data={error:'合成采用修订冲突'};}else{savedPersona=clone(run.persona);revision++;data={persona:clone(savedPersona),revision};if(adoptGate){const waiting=adoptGate;adoptGate=null;waiting.entered();await waiting.wait;}}
 }
 else if(path.startsWith('/api/persona/replay/runs/'))data={run:runs.get(path.split('/').at(-1))};
 else if(path==='/api/memory/users')data={users:[],nextCursor:null};
 else if(path==='/api/memory/policy')data={policy:{recentCount:3,recentDays:7,retentionDays:30},revision:0};
 else{await route.fulfill({status:404,json:{error:'隔离 API 未定义 '+path}});return;}
 await route.fulfill({status,headers:{'cache-control':'no-store'},json:data});
});
page.on('pageerror',error=>report.errors.push({name:'页面异常',error:String(error)}));
page.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.accept();});
async function entered(waiting){let timer;try{await Promise.race([waiting.started,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('等待保存请求超时')),8000))]);}finally{clearTimeout(timer);}}
async function fresh(){for(const waiting of gates)waiting.release();savedPersona=clone(preset('default').persona);revision=0;failPresetReads=false;failSave=false;saveGate=null;adoptGate=null;estimates=new Map();runs=new Map();await page.goto(BASE+'/?case='+(++caseId)+'#/persona');await page.waitForSelector('#persona-section-0');}
async function open(){const box=page.locator('#persona-presets');if(!await box.evaluate(el=>el.open))await box.locator(':scope > summary').click();await page.waitForSelector('input[name="persona-preset"]');}
async function choose(id){await page.locator('input[name="persona-preset"][value="'+id+'"]').check();}
async function fill(id){await open();await choose(id);await page.locator('#persona-preset-fill').click();await page.locator('#persona-preset-confirm').click();await page.waitForFunction(()=>document.querySelector('#persona-presets').textContent.includes('尚未保存'));}
async function save(){const previous=revision;await page.locator('#persona-save').click();await page.waitForFunction(()=>!document.querySelector('#persona-save').disabled);assert.equal(revision,previous+1);}
async function currentSections(){return page.locator('#view textarea[id^="persona-section-"]').evaluateAll(elements=>elements.map(el=>el.value));}
async function shot(name){await page.evaluate(()=>window.scrollTo(0,0));await page.waitForFunction(()=>scrollY===0);await page.screenshot({path:OUT+'/'+name+'.png',fullPage:true});report.screenshots.push(name+'.png');}
async function layout(){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.equal(await page.locator('#view img').count(),0);}
async function check(name,run){if(process.env.CHECK_FILTER&&!name.includes(process.env.CHECK_FILTER))return;console.log('开始 '+name);try{await run();report.checks.push(name);console.log('通过 '+name);}catch(error){report.errors.push({name,error:error.stack||String(error),visible:await page.locator('#view').innerText().catch(()=>''),requests:requests.slice(-8)});console.log('失败 '+name+' '+String(error));}finally{for(const waiting of gates)waiting.release();}}
async function startReplay(){await page.locator('#persona-tab-persona').click();const summary=page.getByText('回放对比与质量统计',{exact:true});const box=page.locator('details').filter({has:summary}).first();if(!await box.evaluate(el=>el.open))await summary.click();await page.getByRole('button',{name:/预估回放/}).click();await page.getByRole('button',{name:/确认开始/}).click();await page.getByRole('button',{name:'采用候选人设',exact:true}).waitFor();return box;}
try{
 await check('默认折叠、六单选和键盘仅改变选择',async()=>{
  await fresh();assert.equal(await page.locator('#persona-presets').evaluate(el=>el.open),false);const before=requests.filter(x=>x.path==='/api/persona/presets').length;assert.equal(before,0);await open();assert.deepEqual(await page.locator('input[name="persona-preset"]').evaluateAll(elements=>elements.map(el=>el.value)),catalog.items.map(x=>x.id));const original=await currentSections();await page.locator('input[name="persona-preset"]').first().focus();await page.keyboard.press('ArrowDown');await page.waitForSelector('#persona-preset-bio');assert.equal(await page.locator('input[name="persona-preset"]:checked').inputValue(),'deepseek');assert.deepEqual(await currentSections(),original);assert.equal(revision,0);
 });
 await check('确认取消、切换时取消确认、深拷贝和单步撤销',async()=>{
  await fresh();await page.locator('#persona-section-0').fill('填入前的未保存编辑');await open();await choose('deepseek');await page.locator('#persona-preset-fill').click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('#persona-section-0').inputValue(),'填入前的未保存编辑');await page.locator('#persona-preset-fill').click();await choose('gpt');assert.equal(await page.locator('#persona-preset-confirm').count(),0);await fill('deepseek');assert.deepEqual(await currentSections(),preset('deepseek').persona.sections.map(x=>x.content));await page.locator('#persona-section-0').fill('不能污染预设原本');await fill('deepseek');assert.equal(await page.locator('#persona-section-0').inputValue(),preset('deepseek').persona.sections[0].content);await page.locator('#persona-preset-undo').click();assert.equal(await page.locator('#persona-section-0').inputValue(),'不能污染预设原本');assert.equal(revision,0);assert.equal(requests.filter(x=>x.path==='/api/persona'&&x.method==='PUT').length,0);
 });
 await check('相同通用默认仍未保存、离页保护、撤销和保存提示',async()=>{
  await fresh();await fill('default');await page.locator('.tabs a[data-route="memory"]').click();await page.getByRole('button',{name:'保留编辑',exact:true}).click();await page.locator('#persona-preset-undo').click();assert.match(await page.locator('#view').innerText(),/已保存/);await fill('default');await save();assert.equal(await page.locator('#persona-preset-undo').isVisible(),false);const reminder=page.locator('#persona-preset-reminder');await reminder.getByText(/今日日程不会自动改变/).waitFor();assert.ok(!(await reminder.innerText()).includes('非官方'));assert.equal(await reminder.locator('a').count(),0);await page.getByRole('button',{name:'关闭保存提示',exact:true}).click();assert.equal(await reminder.innerText(),'');
 });
 await check('建议简介复制成功、失败回退与异步选择归因',async()=>{
  await fresh();await open();await choose('deepseek');await page.locator('#persona-preset-copy').click();await page.waitForFunction(()=>document.documentElement.dataset.copiedBio);assert.equal(await page.locator('html').getAttribute('data-copied-bio'),preset('deepseek').bioSuggestion);await page.evaluate(()=>document.documentElement.dataset.copyMode='fail');await page.locator('#persona-preset-copy').click();await page.getByText('自动复制失败，已选中建议简介，请手动复制。',{exact:true}).waitFor();assert.deepEqual(await page.locator('#persona-preset-bio').evaluate(el=>[el.selectionStart,el.selectionEnd,el.readOnly]),[0,preset('deepseek').bioSuggestion.length,true]);await page.evaluate(()=>document.documentElement.dataset.copyMode='hold');await page.locator('#persona-preset-copy').click();await choose('gpt');await page.evaluate(()=>document.dispatchEvent(new Event('test-copy-release')));assert.equal(await page.locator('#persona-preset-bio').inputValue(),preset('gpt').bioSuggestion);assert.ok(!(await page.locator('#persona-presets').innerText()).includes('建议简介已复制'));
 });
 await check('填入后的试聊和回放读取同一草稿、替换释放旧预估',async()=>{
  await fresh();await fill('deepseek');const edited=preset('deepseek').persona.sections[1].content+' 自定义尾句';await page.locator('#persona-section-1').fill(edited);await page.locator('#persona-tab-preview').click();await page.locator('#preview-message').fill('番茄炒蛋怎么做');await page.locator('#persona-preview').click();await page.getByText('合成试聊回复',{exact:true}).waitFor();const preview=requests.filter(x=>x.path==='/api/persona/preview').at(-1);assert.equal(preview.body.persona.sections[1].content,edited);await page.locator('#persona-tab-persona').click();await page.getByText('回放对比与质量统计',{exact:true}).click();await page.getByRole('button',{name:/预估回放/}).click();await page.getByRole('button',{name:/确认开始/}).waitFor();const estimate=requests.filter(x=>x.path==='/api/persona/replay/estimate').at(-1);assert.deepEqual(estimate.body.persona,preview.body.persona);assert.ok(!Object.hasOwn(estimate.body,'origin'));await fill('gpt');await page.waitForFunction(()=>!document.body.textContent.includes('确认开始'));assert.ok(requests.some(x=>x.path.includes('/replay/estimates/')&&x.method==='DELETE'));await page.locator('#persona-preset-undo').click();assert.equal(await page.locator('#persona-section-1').inputValue(),edited);
 });
 await check('角色保存持久提醒跨同页标签、来源不进入保存数据',async()=>{
  await fresh();await fill('deepseek');await save();const reminder=page.locator('#persona-preset-reminder');await reminder.getByText(/已保存来自「大肥鱼」/).waitFor();assert.match(await reminder.innerText(),/今日日程不会自动改变/);assert.match(await reminder.innerText(),/名称不要只写角色名/);assert.ok((await reminder.innerText()).includes(preset('deepseek').bioSuggestion));assert.equal(await reminder.locator('a').getAttribute('href'),'#/settings/health');await page.locator('#persona-tab-preview').click();assert.equal(await reminder.isVisible(),true);await page.locator('#persona-tab-daily').click();assert.equal(await reminder.isVisible(),true);await page.locator('#persona-tab-persona').click();assert.deepEqual(savedPersona,normalize(preset('deepseek').persona));assert.deepEqual(Object.keys(savedPersona).sort(),['sections','triggers']);
 });
 await check('保存途中普通编辑受保护，改回后不永久脏',async()=>{
  await fresh();await fill('deepseek');const pending=gate();saveGate=pending;await page.locator('#persona-save').click();await entered(pending);await page.locator('#persona-section-0').fill('保存请求发出后的新编辑');pending.release();await page.waitForFunction(()=>!document.querySelector('#persona-save').disabled);assert.equal(await page.locator('#persona-section-0').inputValue(),'保存请求发出后的新编辑');assert.equal(await page.locator('#persona-preset-undo').isVisible(),false);await page.locator('.tabs a[data-route="memory"]').click();await page.getByRole('button',{name:'保留编辑',exact:true}).click();await page.locator('#persona-section-0').fill(savedPersona.sections[0].content);await page.locator('.tabs a[data-route="memory"]').click();await page.waitForSelector('#memory-users');
 });
 await check('旧 A 保存不能清新 B 撤销，撤销保留 A 提交后编辑',async()=>{
  await fresh();await fill('deepseek');const pending=gate();saveGate=pending;await page.locator('#persona-save').click();await entered(pending);await page.locator('#persona-section-0').fill('A 提交后继续编辑');await fill('glm');pending.release();await page.waitForFunction(()=>!document.querySelector('#persona-save').disabled);assert.equal(await page.locator('#persona-section-0').inputValue(),preset('glm').persona.sections[0].content);assert.equal(await page.locator('#persona-preset-undo').isVisible(),true);assert.match(await page.locator('#persona-preset-reminder').innerText(),/大肥鱼/);await page.locator('#persona-preset-undo').click();assert.equal(await page.locator('#persona-section-0').inputValue(),'A 提交后继续编辑');await save();assert.match(await page.locator('#persona-preset-reminder').innerText(),/大肥鱼/);
 });
 await check('冲突保存保留来源与撤销，成功后再显示提醒',async()=>{
  await fresh();await fill('glm');failSave=true;await page.locator('#persona-save').click();await page.getByText('合成人设修订冲突，请重新核对',{exact:true}).waitFor();assert.equal(await page.locator('#persona-preset-undo').isVisible(),true);assert.equal(await page.locator('#persona-preset-reminder').innerText(),'');assert.equal(revision,0);failSave=false;await save();assert.match(await page.locator('#persona-preset-reminder').innerText(),/GLM 娘/);
 });
 await check('回放采用按 run 绑定来源，规范关键词且保留新 B 撤销',async()=>{
  await fresh();await fill('kimi');await page.getByText('语义与关键词触发规则',{exact:true}).click();await page.locator('[data-rule]').first().getByLabel('关键词（每行一个）',{exact:true}).fill(' ＴＵＴＯＲＩＡＬ ');await startReplay();const pending=gate();adoptGate=pending;await page.getByRole('button',{name:'采用候选人设',exact:true}).click();await entered(pending);await fill('glm');pending.release();await page.getByText('已采用候选人设，下一轮生效',{exact:true}).waitFor();assert.equal(await page.locator('#persona-section-0').inputValue(),preset('glm').persona.sections[0].content);assert.equal(await page.locator('#persona-preset-undo').isVisible(),true);assert.match(await page.locator('#persona-preset-reminder').innerText(),/Kimi 娘/);await page.locator('#persona-preset-undo').click();assert.equal(await page.locator('[data-rule]').first().getByLabel('关键词（每行一个）',{exact:true}).inputValue(),'TUTORIAL');await save();assert.equal(revision,2);assert.match(await page.locator('#persona-preset-reminder').innerText(),/Kimi 娘/);
 });
 await check('历史回放采用不猜测预设来源，离开清空提示与撤销',async()=>{
  await fresh();runs.set('history-1',{id:'history-1',status:'completed',compare:'persona',canAdopt:true,persona:clone(preset('claude').persona),personaRevision:0,createdAt:Date.now(),summary:{},items:[]});await page.getByText('回放对比与质量统计',{exact:true}).click();const history=page.getByText('最近回放记录',{exact:true});await history.click();await page.locator('.provider-choice').click();await page.getByRole('button',{name:'采用候选人设',exact:true}).click();await page.getByText('已采用候选人设，下一轮生效',{exact:true}).waitFor();assert.equal(await page.locator('#persona-preset-reminder').innerText(),'');await fresh();assert.equal(await page.locator('#persona-preset-reminder').innerText(),'');assert.equal(await page.locator('#persona-preset-undo').count(),0);
 });
 await check('预设加载失败和重试不伤编辑器或修订号',async()=>{
  await fresh();await page.locator('#persona-section-0').fill('先保存取得修订一');await save();await page.locator('#persona-section-0').fill('读取预设失败也要保留');failPresetReads=true;await page.locator('#persona-presets > summary').click();await page.getByText('合成预设读取失败',{exact:true}).waitFor();assert.equal(await page.locator('#persona-section-0').inputValue(),'读取预设失败也要保留');failPresetReads=false;await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.waitForSelector('input[name="persona-preset"]');assert.equal(await page.locator('#persona-section-0').inputValue(),'读取预设失败也要保留');assert.equal(revision,1);await save();assert.equal(revision,2);
 });
 await check('浅深色 1440 和 375 布局、简介与持续提醒可读',async()=>{
  for(const color of ['light','dark'])for(const width of [1440,375]){await page.emulateMedia({colorScheme:color});await page.setViewportSize({width,height:1100});await fresh();await fill('claude');await save();await layout();await shot('persona-presets-'+color+'-'+width);}
 });
 assert.equal(dialogs.filter(type=>type!=='beforeunload').length,0);
 assert.equal(requests.filter(x=>x.method!=='GET'&&!['/api/persona','/api/persona/preview','/api/persona/replay/estimate','/api/persona/replay/runs'].includes(x.path)&&!x.path.startsWith('/api/persona/replay/estimates/')&&!x.path.endsWith('/adopt')).length,0);
}catch(error){report.errors.push({name:'总体断言',error:error.stack||String(error)});}
finally{for(const waiting of gates)waiting.release();await context.close();await browser.close();await new Promise(done=>server.close(done));report.requests=requests.map(({path,method})=>({path,method}));writeFileSync(OUT+'/persona-presets-ui-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.errors.length)process.exitCode=1;}
