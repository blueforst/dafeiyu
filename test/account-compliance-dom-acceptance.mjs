// 仅在服务器隔离Camoufox执行；所有页面由route合成，无生产profile、凭据或外部请求。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {launch} from '/opt/role-camoufox/launch.mjs';
import {readCompliance} from '../dist/browser.js';
import {readComplianceProfileSnapshot,inspectComplianceProfileSnapshot,readComplianceQualitySnapshot,inspectComplianceQualitySnapshot,readComplianceFiltersSnapshot,inspectComplianceFiltersSnapshot,readReadyComplianceProfile} from '../dist/account-compliance-dom.js';
import {assessCompliance} from '../dist/unattended-health.js';

const artifactDir=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(artifactDir,{recursive:true});
const temporary=mkdtempSync(tmpdir()+'/role-compliance-dom-'),profile=temporary+'/profile',handle='fixture_worker';
const output={evidence:'服务器隔离Camoufox／真实DOM执行；X页面均由route合成，不代表真实账号合规验收',productionProfileUsed:false,externalRequests:0,writes:0,checks:[],errors:[]};
const check=(name,detail={})=>output.checks.push({name,passed:true,...detail}),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ready={timeoutMs:1000,stableMs:20,intervalMs:10};let xvfb,context,page,markup='',monitoredPageLoaded=false;
const header=({name='AI 测试角色',bio='AI 非官方合成角色',label='',handle:profileHandle=handle,details=true,bioMarkup,extra='',owner='<a href="/settings/profile">Edit profile</a>'}={})=>'<div data-testid="primaryColumn">'+owner+'<div data-testid="UserName"><div>'+name+'</div><div>@'+profileHandle+'</div></div>'+(bioMarkup??'<div data-testid="UserDescription">'+bio+'</div>')+label+(details?'<a href="/'+profileHandle+'/following">1 Following</a><a href="/'+profileHandle+'/verified_followers">2 Followers</a>':'')+extra+'</div>';
const documentFor=body=>'<!doctype html><html><body><main>'+body+'</main></body></html>';
async function readWriteMonitor(target=page){const raw=await target.evaluate(()=>document.documentElement.getAttribute('data-compliance-write-count'));assert.equal(typeof raw,'string','每页写入监测器必须已初始化');assert.match(raw,/^\d+$/,'写入计数必须为十进制整数');const count=Number(raw);assert.equal(Number.isSafeInteger(count),true,'写入计数必须为安全整数');return count;}
async function load(url,body){if(monitoredPageLoaded)output.writes+=await readWriteMonitor();markup=documentFor(body);await page.goto(url,{waitUntil:'domcontentloaded'});monitoredPageLoaded=true;assert.equal(await readWriteMonitor(),0,'新文档监测器必须从零开始');}
async function profileResult(body,url='https://x.com/'+handle){await load(url,body);return inspectComplianceProfileSnapshot(await readComplianceProfileSnapshot(page),handle);}
async function qualityResult(body,url='https://x.com/settings/notifications/filters'){await load(url,body);return inspectComplianceQualitySnapshot(await readComplianceQualitySnapshot(page));}
try{
 const supplied=/^:(\d+)(?:\.\d+)?$/.exec(process.env.DISPLAY||'');if(!(supplied&&existsSync('/tmp/.X11-unix/X'+supplied[1]))&&process.env.HEALTH_USE_EXISTING_DISPLAY!=='1'){
  const number=200+process.pid%10000;process.env.DISPLAY=':'+number;xvfb=spawn('Xvfb',[process.env.DISPLAY,'-screen','0','1440x900x24','-nolisten','tcp'],{stdio:'ignore'});let error;xvfb.once('error',value=>{error=value;});const deadline=Date.now()+10000;while(!existsSync('/tmp/.X11-unix/X'+number)){if(error)throw error;if(xvfb.exitCode!==null||Date.now()>deadline)throw Error('隔离Xvfb未就绪');await delay(50);}
 }
 context=await launch(profile);
 // 不依赖HTML内联脚本与evaluate共享window状态；每个新文档的监听器通过原生DOM发布计数。
 await context.addInitScript(()=>{let count=0;const publish=()=>document.documentElement?.setAttribute('data-compliance-write-count',String(count));for(const type of ['click','change','input'])document.addEventListener(type,()=>{count++;publish();},true);document.addEventListener('DOMContentLoaded',publish,{once:true});publish();});
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(request.method()!=='GET')output.writes++;if(url.origin!=='https://x.com'){output.externalRequests++;return route.abort();}return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:markup});});
 // 独立探针只验证监测器，不计入之后合规读取的零交互结果。
 const probe=await context.newPage();markup=documentFor('<input id="monitor-probe">');await probe.goto('https://x.com/fixture_monitor',{waitUntil:'domcontentloaded'});assert.equal(await readWriteMonitor(probe),0);await probe.evaluate(()=>{const target=document.querySelector('#monitor-probe');for(const type of ['click','change','input'])target.dispatchEvent(new Event(type,{bubbles:true}));});assert.equal(await readWriteMonitor(probe),3);await probe.close();check('独立合成探针确认click／change／input监测各计一次',{syntheticProbeEvents:3});
 page=context.pages()[0]||await context.newPage();
 const nativeLabel='<div data-testid="UserLabel"><span>Automated by </span><a href="/fixture_owner">@fixture_owner</a></div>';
 let result=await profileResult(header({label:nativeLabel}));assert.equal(result.reliable,true);assert.equal(result.automatedLabel,true);assert.match(result.name,/AI/);check('唯一完整目标资料与原生管理账号标签可确认');
 const setupProfile='<a href="/i/flow/setup_profile">Set up profile</a>';
 for(const href of ['/i/flow/setup_profile','https://x.com/i/flow/setup_profile']){
  result=await profileResult(header({owner:'<a href="'+href+'">Set up profile</a>'}));assert.equal(result.reliable,true);check('原生Set up profile精确路径与标题可作自身入口',{absolute:href.startsWith('https:')});
 }
 for(const [name,body] of [
  ['时间线内setup链接',header({owner:'',extra:'<article data-testid="tweet">'+setupProfile+'</article>'})],
  ['简介内setup链接',header({owner:'',bioMarkup:'<div data-testid="UserDescription">'+setupProfile+'</div>'})],
  ['推荐UserCell内setup链接',header({owner:'',extra:'<div data-testid="UserCell">'+setupProfile+'</div>'})],
  ['隐藏setup链接',header({owner:'',extra:'<div hidden>'+setupProfile+'</div>'})],
  ['编辑与setup两个自身入口',header({extra:setupProfile})],
  ['两个setup自身入口',header({owner:setupProfile+setupProfile})],
  ['setup路径不符',header({owner:'<a href="/i/flow/setup_profile/other">Set up profile</a>'})],
  ['setup外部host',header({owner:'<a href="https://example.com/i/flow/setup_profile">Set up profile</a>'})],
  ['setup伪装host',header({owner:'<a href="https://x.com.example.com/i/flow/setup_profile">Set up profile</a>'})],
  ['setup含凭据',header({owner:'<a href="https://user@x.com/i/flow/setup_profile">Set up profile</a>'})],
  ['setup含query',header({owner:'<a href="/i/flow/setup_profile?source=test">Set up profile</a>'})],
  ['setup含hash',header({owner:'<a href="/i/flow/setup_profile#step">Set up profile</a>'})],
  ['setup错误标题',header({owner:'<a href="/i/flow/setup_profile">Edit profile</a>'})],
  ['setup标题仅前缀相同',header({owner:'<a href="/i/flow/setup_profile">Set up profile later</a>'})],
  ['无原生href的setup按钮',header({owner:'<button type="button">Set up profile</button>'})],
 ]){assert.equal((await profileResult(body)).reliable,false);check(name+'不能作自身资料凭据');}
 result=await profileResult(header({bio:'Automated by @spoofed_owner'}));assert.equal(result.reliable,true);assert.equal(result.automatedLabel,false);check('简介文字不能冒充平台自动化标签');
 result=await profileResult(header({extra:'<article data-testid="tweet"><div data-testid="UserName">他人 @other</div><div data-testid="UserDescription">AI</div><span>Automated by @spoofed_owner</span></article>'}));assert.equal(result.reliable,true);assert.equal(result.automatedLabel,false);assert.ok(!result.name.includes('他人'));check('时间线同名testid与标签字样不污染资料');
 for(const [name,body,url] of [
  ['目标URL不符',header(),'https://x.com/another_worker'],['资料handle不符',header({handle:'another_worker'}),'https://x.com/'+handle],
  ['详情尚未水合',header({details:false}),'https://x.com/'+handle],['无自身编辑入口',header().replace('<a href="/settings/profile">Edit profile</a>',''),'https://x.com/'+handle],
  ['重复资料名字',header({extra:'<div data-testid="UserName">另一个 @'+handle+'</div>'}),'https://x.com/'+handle],['重复简介',header({bioMarkup:'<div data-testid="UserDescription">第一段</div><div data-testid="UserDescription">第二段</div>'}),'https://x.com/'+handle],
 ]){assert.equal((await profileResult(body,url)).reliable,false);check(name+'保持unknown');}
 result=await profileResult(header({name:'普通角色',bioMarkup:''}));assert.equal(result.reliable,true);assert.equal(result.bio,'');assert.equal(assessCompliance({accountId:handle,profileReliable:result.reliable,name:result.name,bio:result.bio,automatedLabel:result.automatedLabel,qualityFilter:null}).disclosure,'missing');check('完整详情确认空简介，可判定缺披露');
 result=await profileResult(header({label:'<div data-testid="UserLabel">Automated by @missing_link</div>'}));assert.equal(result.reliable,true);assert.equal(result.automatedLabel,null);check('原生标签缺少管理账号链接保持unknown');
 await load('https://x.com/'+handle,'<div aria-busy="true">资料载入中</div>');await page.evaluate(content=>{setTimeout(()=>{document.querySelector('main').innerHTML=content;},40);},header());result=await readReadyComplianceProfile(page,handle,ready);assert.equal(result.reliable,true);check('真实DOM延迟水合后有界等待稳定');
 assert.equal(await qualityResult('<label for="quality">Quality filter</label><input id="quality" type="checkbox" checked>'),true);check('原生label与checked可确认开启');
 assert.equal(await qualityResult('<div><span id="quality-title">Quality filter</span><button role="switch" aria-labelledby="quality-title" aria-checked="false">toggle</button></div>'),false);check('aria-labelledby关联唯一标题可确认关闭');
 assert.equal(await qualityResult('<div data-setting-row><div><span>Quality filter</span></div><button role="switch" aria-checked="true">toggle</button></div>'),true);check('唯一设置行标题与开关归属可确认');
 assert.equal(await qualityResult('<span id="quality-label">Quality filter</span><div role="checkbox" aria-labelledby="quality-label" aria-checked="false" tabindex="0"></div>'),false);check('独立ARIA checkbox通过唯一关联标签确认关闭');
 assert.equal(await qualityResult('<label for="quality">Quality filter</label><input id="quality" type="checkbox"><div hidden><label for="hidden">Quality filter</label><input id="hidden" type="checkbox" checked></div>'),false);check('隐藏副本不参与唯一可见控件判定');
 for(const [name,body,url] of [
  ['重复可见质量开关','<button role="switch" aria-label="Quality filter" aria-checked="true"></button><button role="switch" aria-label="Quality filter" aria-checked="false"></button>'],
  ['同设置行多个开关','<div><span>Quality filter</span><button role="switch" aria-checked="true"></button><button role="switch" aria-checked="false"></button></div>'],
  ['重复ARIA引用ID','<span id="q">Quality filter</span><span id="q">Quality filter</span><button role="switch" aria-labelledby="q" aria-checked="true"></button>'],
  ['显式label目标ID重复','<input id="q" type="checkbox" hidden checked><label for="q">Quality filter</label><input id="q" type="checkbox">'],
  ['相邻设置标题不能冒充同行关联','<section><div><span>Quality filter</span></div><div><span>Unrelated setting</span><button role="switch" aria-checked="true"></button></div></section>'],
  ['ARIA混合态','<button role="switch" aria-label="Quality filter" aria-checked="mixed"></button>'],
  ['缺少原生状态','<button role="switch" aria-label="Quality filter"></button>'],
  ['原生ARIA状态冲突','<label for="q">Quality filter</label><input id="q" type="checkbox" checked aria-checked="false">'],
  ['页面正在加载','<section aria-busy="true"><button role="switch" aria-label="Quality filter" aria-checked="true"></button></section>'],
  ['错误设置URL','<button role="switch" aria-label="Quality filter" aria-checked="true"></button>','https://x.com/settings/privacy_and_safety'],
 ]){assert.equal(await qualityResult(body,url),null);check(name+'保持unknown');}
 await load('https://x.com/settings/notifications','<a href="/settings/notifications/filters">Filters</a>');assert.equal(inspectComplianceFiltersSnapshot(await readComplianceFiltersSnapshot(page)),'/settings/notifications/filters');
 const filterDescription='Choose the notifications you’d like to see — and those you don’t.';
 const filterRow=(href='/settings/notifications/filters',title='Filters',description=filterDescription)=>'<a href="'+href+'"><div><span>'+title+'</span></div><div>'+description+'</div></a>';
 for(const href of ['/settings/notifications/filters','https://x.com/settings/notifications/filters']){
  await load('https://x.com/settings/notifications',filterRow(href));assert.equal(inspectComplianceFiltersSnapshot(await readComplianceFiltersSnapshot(page)),'/settings/notifications/filters');check('Filters独立标题与真实副文可读取唯一原生入口',{absolute:href.startsWith('https:')});
 }
 for(const [name,body] of [
  ['Filters错误路径',filterRow('/settings/notifications/advanced_filters')],
  ['Filters路径含额外层级',filterRow('/settings/notifications/filters/other')],
  ['Filters含query',filterRow('/settings/notifications/filters?source=test')],
  ['Filters含hash',filterRow('/settings/notifications/filters#quality')],
  ['Filters外部host',filterRow('https://example.com/settings/notifications/filters')],
  ['Filters伪装host',filterRow('https://x.com.example.com/settings/notifications/filters')],
  ['Filters含凭据',filterRow('https://user@x.com/settings/notifications/filters')],
  ['仅说明提及Filters',filterRow('/settings/notifications/filters','Preferences','Choose Filters for the notifications you’d like to see.')],
  ['隐藏Filters入口','<div hidden>'+filterRow()+'</div>'],
  ['隐藏首标题不能冒充可见标题','<a href="/settings/notifications/filters"><span hidden>Filters</span><span>Preferences</span><span>'+filterDescription+'</span></a>'],
  ['article内Filters入口','<article>'+filterRow()+'</article>'],
  ['messageEntry内Filters入口','<div data-testid="messageEntry">'+filterRow()+'</div>'],
  ['UserCell内Filters入口','<div data-testid="UserCell">'+filterRow()+'</div>'],
  ['简介内Filters入口','<div data-testid="UserDescription">'+filterRow()+'</div>'],
  ['同标题正确及错误目标并存',filterRow()+filterRow('/settings/notifications/advanced_filters')],
 ]){await load('https://x.com/settings/notifications',body);assert.equal(inspectComplianceFiltersSnapshot(await readComplianceFiltersSnapshot(page)),null);check(name+'不能作为通知过滤入口');}
 await load('https://x.com/settings/notifications','<a href="/settings/notifications/filters">Filters</a><a href="https://x.com/settings/notifications/filters">Filters</a>');assert.equal(inspectComplianceFiltersSnapshot(await readComplianceFiltersSnapshot(page)),null);check('过滤入口必须是当前通知页唯一原生链接');
 const navigations=[],complianceStartedAt=Date.now();const observation=await readCompliance(page,handle,async(_page,url)=>{navigations.push(url);if(url==='https://x.com/'+handle)await load(url,header({owner:setupProfile,label:nativeLabel}));else if(url==='https://x.com/settings/notifications')await load(url,filterRow());else if(url==='https://x.com/settings/notifications/filters')await load(url,'<div><span>Quality filter</span><button role="switch" aria-checked="false">toggle</button></div>');else throw Error('出现非预期导航');},ready);
 const compliance=assessCompliance(observation,['AI','非官方']);assert.equal(compliance.disclosure,'confirmed');assert.equal(compliance.automatedLabel,'confirmed');assert.equal(compliance.qualityFilter,'off');assert.deepEqual(navigations,['https://x.com/'+handle,'https://x.com/settings/notifications','https://x.com/settings/notifications/filters']);output.writes+=await readWriteMonitor();assert.equal(output.writes,0);assert.equal(output.externalRequests,0);check('实际readCompliance顺序导航与DTO评估，零点击零写请求');
 const diagnostics=observation.diagnostics;assert.deepEqual(Object.keys(diagnostics).sort(),['filters','profile','quality']);assert.equal(diagnostics.profile.mainCount,1);assert.equal(diagnostics.profile.nameCount,1);assert.equal(diagnostics.profile.handleCount,1);assert.equal(diagnostics.profile.editCount,1);assert.equal(diagnostics.profile.bioCount,1);assert.equal(diagnostics.profile.expectedHandleMatches,true);assert.equal(diagnostics.filters.visibleEntryCount,1);assert.equal(diagnostics.quality.matchedControlCount,1);assert.equal(diagnostics.quality.associationValidCount,1);assert.equal(diagnostics.quality.nativeStateCount,0);assert.equal(diagnostics.quality.ariaStateCount,1);
 assert.equal(diagnostics.profile.handleMatches,true);for(const part of Object.values(diagnostics)){assert.equal(part.locationMatches,true);assert.equal(part.stable,true);assert.ok(part.sampleCount>=2);assert.ok(part.readAttempts>=part.sampleCount);assert.ok(part.sampledAt>=complianceStartedAt&&part.sampledAt<=Date.now());for(const value of Object.values(part))assert.ok(value===null||typeof value==='number'||typeof value==='boolean');}
 assert.doesNotMatch(JSON.stringify(diagnostics),/fixture_worker|fixture_owner|https:|AI 测试角色|非官方/);assert.equal(Object.hasOwn(compliance,'diagnostics'),false);check('本次采样诊断仅返回固定计数布尔与真实采样时间，公共合规结果不含诊断');
 const unready=await readCompliance(page,handle,async(_page,url)=>load(url,'<div>合成未知结构</div>'),ready);assert.equal(unready.profileReliable,false);assert.equal(unready.qualityFilter,null);assert.equal(unready.diagnostics.profile.nameCount,0);assert.equal(unready.diagnostics.profile.handleMatches,false);assert.equal(unready.diagnostics.profile.expectedHandleMatches,false);assert.equal(unready.diagnostics.filters.visibleEntryCount,0);assert.equal(unready.diagnostics.quality.matchedControlCount,0);for(const part of Object.values(unready.diagnostics)){assert.equal(part.locationMatches,true);assert.equal(part.stable,false);assert.ok(part.sampleCount>0);assert.ok(part.sampledAt>=complianceStartedAt&&part.sampledAt<=Date.now());}output.writes+=await readWriteMonitor();assert.equal(output.writes,0);assert.equal(output.externalRequests,0);check('未就绪仍unknown且保留同次最后已完成采样的固定诊断');
}catch(error){output.errors.push(String(error?.stack||error));process.exitCode=1;}
finally{
 if(context)await context.close().catch(()=>{});if(xvfb){xvfb.kill('SIGTERM');await Promise.race([once(xvfb,'exit').catch(()=>{}),delay(2000)]);if(xvfb.exitCode===null)xvfb.kill('SIGKILL');}rmSync(temporary,{recursive:true,force:true});output.temporaryProfileRemoved=!existsSync(temporary);output.passed=output.checks.length;output.failed=output.errors.length;writeFileSync(artifactDir+'/account-compliance-dom-acceptance.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output));
}
