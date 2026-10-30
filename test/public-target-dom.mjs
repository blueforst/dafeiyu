// 服务器隔离Camoufox：只验证公开目标加载范围，所有网络均由合成fixture拦截。
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {observer} from '/opt/role-camoufox/launch.mjs';
import {readPublicPosts} from '../dist/public-post.js';
import {publicTargetSnapshot,waitForPublicTarget} from '../dist/public-target.js';
import {readPublicPageSnapshot,waitForPublicTimeline,observeNativeReads} from '../dist/public-collection.js';

const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const stamp=new Date().toISOString(),at=Date.parse(stamp),url='https://x.com/visitor/status/500';
const event={id:'target-500',platformId:'500',targetId:'500',channel:'public',userId:'x:visitor',handle:'visitor',text:'可靠目标正文',url,conversationId:'500',timestamp:at,timestampReliable:true,mediaUnavailable:false};
const post=(handle='visitor',id='500',text='可靠目标正文',inside='')=>'<article data-testid="tweet"><a href="/'+handle+'/status/'+id+'"><time datetime="'+stamp+'"></time></a><div data-testid="tweetText">'+text+'</div>'+inside+'</article>';
const layout=(primary,sidebar='',mainAttributes='')=>'<main '+mainAttributes+'><div data-testid="primaryColumn">'+primary+'</div><aside>'+sidebar+'</aside></main>';
const spinner='<div role="progressbar">正在加载</div>',placeholder='<div data-testid="inline_reply_offscreen">'+spinner+'</div>';
const report={evidence:'全新隔离Camoufox、同页恢复合成DOM，所有请求由fixture拦截；未挂生产profile，未读取认证或真实X数据，未调用模型',checks:[],errors:[]};
let browser,context,page,native,detailStatus=200;
const input=(extra={})=>({page,event,timeoutMs:1500,intervalMs:50,deadline:Date.now()+2200,relations:native.relations,pendingRequests:native.count,failedRequests:native.failures,...extra});
async function setPage(body,location=url){native.reset();await page.evaluate(({body,location})=>{document.body.innerHTML=body;history.replaceState(null,'',location);},{body,location});}
async function check(name,fn){try{await fn();report.checks.push(name);}catch(error){report.errors.push({name,error:error.stack||String(error)});}finally{writeFileSync(OUT+'/public-target-dom.json',JSON.stringify(report,null,2));}}
try{
 browser=await observer();context=await browser.newContext();page=await context.newPage();page.setDefaultTimeout(5000);native=observeNativeReads(page);
 await context.route('**/*',async route=>{
  const requested=new URL(route.request().url());
  if(requested.origin==='https://x.com'&&requested.pathname==='/i/api/graphql/fixture/TweetDetail'){
   await new Promise(resolve=>setTimeout(resolve,800));await route.fulfill({status:detailStatus,json:{unavailable:detailStatus===200}});return;
  }
  if(requested.href===url){await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body><main></main></body></html>'});return;}
  await route.abort();
 });
 await page.goto(url,{waitUntil:'domcontentloaded'});

 await check('持久回复占位和侧栏spinner不冒充目标加载，严格目标仍能就绪',async()=>{
  await setPage(layout(post()+placeholder,spinner));assert.equal((await readPublicPageSnapshot(page)).loading,false);assert.equal((await publicTargetSnapshot(page)).loading,false);
  const ready=await waitForPublicTarget(input());assert.equal(ready.target.platformId,'500');assert.equal(ready.target.text,event.text);
 });
 await check('visibility:hidden但占位的进度条不阻塞完整目标',async()=>{
  await setPage(layout(post()+'<div role="progressbar" style="visibility:hidden;width:24px;height:24px">隐藏加载</div>'));
  assert.equal((await readPublicPageSnapshot(page)).loading,false);assert.equal((await publicTargetSnapshot(page)).loading,false);assert.equal((await waitForPublicTarget(input())).target.platformId,'500');
 });
 await check('主内容的真实spinner及main或primary自身busy仍阻止目标就绪',async()=>{
  for(const body of [layout(post()+spinner),layout(post('visitor','500',event.text,spinner)),layout(post(),'','aria-busy="true"'),'<main><div data-testid="primaryColumn" aria-busy="true">'+post()+'</div></main>']){
   await setPage(body);assert.equal((await readPublicPageSnapshot(page)).loading,true);assert.equal((await publicTargetSnapshot(page)).loading,true);
   await assert.rejects(()=>waitForPublicTarget(input({timeoutMs:250})),error=>error.code==='public-target-timeout');
  }
 });
 await check('文章外真实删除提示继续拒绝，不把不可用页面当成功空集',async()=>{
  await setPage(layout('<div data-testid="error-detail">This Post was deleted</div>'+placeholder,spinner));assert.equal((await readPublicPageSnapshot(page)).error,'target-unavailable');
  await assert.rejects(()=>waitForPublicTarget(input({timeoutMs:1400})),error=>error.code==='public-target-unavailable');
 });
 await check('缓存目标仍须等待TweetDetail，原生返回删除时不能提前提交',async()=>{
  await setPage(layout(post()+placeholder));detailStatus=200;
  await page.evaluate(()=>{window.__targetDetail=fetch('/i/api/graphql/fixture/TweetDetail').then(response=>response.json()).then(()=>{document.querySelector('[data-testid="primaryColumn"]').innerHTML='<div data-testid="error-detail">This Post was deleted</div>';});});
  await page.waitForTimeout(20);assert.ok(native.count()>0);const started=Date.now();
  await assert.rejects(()=>waitForPublicTarget(input({timeoutMs:2200,deadline:Date.now()+2500})),error=>error.code==='public-target-unavailable');assert.ok(Date.now()-started>=750);
 });
 await check('相关原生请求失败继续阻止严格目标，未弱化请求门禁',async()=>{
  await setPage(layout(post()+placeholder));detailStatus=503;
  await page.evaluate(()=>{window.__failedTargetDetail=fetch('/i/api/graphql/fixture/TweetDetail').then(response=>response.json());});await page.evaluate(()=>window.__failedTargetDetail);assert.ok(native.failures()>0);
  await assert.rejects(()=>waitForPublicTarget(input({timeoutMs:250})),error=>error.code==='public-target-timeout');
 });
 await check('去除无关加载后，重复目标与冻结正文变化仍拒绝',async()=>{
  for(const [body,code] of [[post()+post(),'public-target-ambiguous'],[post('visitor','500','目标正文已改变'),'public-target-mismatch']]){
   await setPage(layout(body+placeholder,spinner));await assert.rejects(()=>waitForPublicTarget(input({timeoutMs:250})),error=>error.code===code);
  }
 });
 await check('自己帖子评论采集复用相同加载范围，可靠父子关系仍必要',async()=>{
  const ownUrl='https://x.com/worker/status/700';await setPage(layout(post('worker','700','自己的帖子')+placeholder+post('visitor','701','对自己的帖子作出回复'),spinner),ownUrl);
  native.relations.observe([{rest_id:'700',legacy:{conversation_id_str:'700',in_reply_to_status_id_str:null,created_at:stamp},core:{user_results:{result:{legacy:{screen_name:'worker'}}}}},{rest_id:'701',legacy:{conversation_id_str:'700',in_reply_to_status_id_str:'700',in_reply_to_screen_name:'worker',created_at:stamp},core:{user_results:{result:{legacy:{screen_name:'visitor'}}}}}]);
  const ready=await waitForPublicTimeline({page,handle:'worker',deadline:Date.now()+2500,readTweets:async p=>native.relations.enrich(await readPublicPosts(p)),pendingRequests:native.count,failedRequests:native.failures,intervalMs:50,stableMs:200,minimumObserveMs:600,pageTimeoutMs:2000},{url:ownUrl,kind:'thread',targetId:'700'});
  assert.equal(ready.state,'ready');assert.equal(ready.code,'public-ready');assert.deepEqual(ready.events.map(row=>row.platformId),['700','701']);
 });
}finally{native?.dispose();await context?.close();await browser?.close();writeFileSync(OUT+'/public-target-dom.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));if(report.errors.length)process.exitCode=1;
