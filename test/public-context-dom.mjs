// 仅服务器隔离 Camoufox；全新临时 browser context，所有网络请求由合成资料拦截。
// 不读取生产 profile/凭据，不访问真实 X 或卡片网页，不调用模型。
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {observer} from '/opt/role-camoufox/launch.mjs';
import {readTweets} from '../dist/browser.js';
import {readPublicPosts} from '../dist/public-post.js';
import {publicConversationContext,inspectPublicPost,waitForPublicTarget} from '../dist/public-target.js';
import {observeNativeReads} from '../dist/public-collection.js';

const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const stamp=new Date().toISOString(),at=Date.parse(stamp),targetId='500',targetHandle='target_user';
const targetUrl='https://x.com/'+targetHandle+'/status/'+targetId;
const declaredRelations=new Map(),nativeFrames=new Map();
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const post=(handle,id,text,extra='')=>{declaredRelations.set(id,{rest_id:id,legacy:{conversation_id_str:id,in_reply_to_status_id_str:null,created_at:stamp},core:{user_results:{result:{legacy:{screen_name:handle}}}}});return '<article data-testid="tweet"><a href="/'+handle+'/status/'+id+'"><time datetime="'+stamp+'"></time></a><div data-testid="tweetText">'+esc(text)+'</div>'+extra+'</article>';};
const link=(id,parent,root)=>Object.assign(declaredRelations.get(id).legacy,{conversation_id_str:root,in_reply_to_status_id_str:parent});
const quote=(handle,id,text,extra='')=>'<div data-testid="quoteTweet" role="link"><a href="/'+handle+'/status/'+id+'"><time datetime="'+stamp+'"></time></a>'+(text===undefined?'':'<div data-testid="tweetText">'+esc(text)+'</div>')+extra+'</div>';
const card=(domain,title)=>'<div data-testid="card.wrapper"><a href="https://card-target.invalid/story" onclick="window.__cardClicks=(window.__cardClicks||0)+1"><div data-testid="card.domain">'+esc(domain)+'</div><div data-testid="card.title">'+esc(title)+'</div></a></div>';
const documentHTML=(body,script='')=>'<!doctype html><html><body><main>'+body+'</main>'+(script?'<script>'+script+'</script>':'')+'</body></html>';
const event=(text='可靠目标正文')=>({id:'fixture-target',platformId:targetId,targetId,channel:'public',userId:'x:'+targetHandle,handle:targetHandle,text,url:targetUrl,conversationId:targetId,timestamp:at,timestampReliable:true,mediaUnavailable:false});
const report={evidence:'真实隔离 Camoufox + 合成 DOM；全新临时 context，未挂载生产 profile，未访问真实平台、卡片网页或模型',checks:[],errors:[],requests:[],externalRequests:[],platformNetworkUsed:false};
const fixtures=new Map();let browser,context,page,native;
function persist(){writeFileSync(OUT+'/public-context-dom.json',JSON.stringify({...report,passed:report.checks.length,failed:report.errors.length},null,2));}
async function setPage(html,url=targetUrl){native.reset();fixtures.set(new URL(url).pathname,html);await page.goto(url,{waitUntil:'domcontentloaded',timeout:10000});}
const contextInput=(text='可靠目标正文',extra={})=>({page,event:event(text),deadline:Date.now()+3000,timeoutMs:2000,intervalMs:50,relations:native.relations,pendingRequests:native.count,failedRequests:native.failures,...extra});
async function check(name,fn){console.log('[开始] '+name);try{await fn();report.checks.push(name);console.log('[通过] '+name);}catch(error){report.errors.push({name,error:error.stack||String(error)});console.log('[失败] '+name+'：'+String(error));}finally{persist();}}
try{
 browser=await observer();context=await browser.newContext();page=await context.newPage();page.setDefaultTimeout(10000);native=observeNativeReads(page);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());report.requests.push({method:request.method(),origin:url.origin,path:url.pathname});
  if(url.origin!=='https://x.com'){if(!['data:','about:'].includes(url.protocol))report.externalRequests.push({origin:url.origin,path:url.pathname});await route.abort();return;}
  if(url.pathname==='/i/api/graphql/fixture/Relations'){await route.fulfill({status:200,json:{data:nativeFrames.get(url.searchParams.get('page'))??[]}});return;}
  if(url.pathname==='/i/api/graphql/fixture/TweetDetail'){await new Promise(resolve=>setTimeout(resolve,800));await route.fulfill({status:200,json:{unavailable:true}});return;}
  const fixture=fixtures.get(url.pathname);if(!fixture){await route.abort();return;}
  nativeFrames.set(url.pathname,[...declaredRelations.values()].map(row=>structuredClone(row)));
  const html=fixture.replace('</body>',`<script>fetch('/i/api/graphql/fixture/Relations?page='+encodeURIComponent(${JSON.stringify(url.pathname)}))</script></body>`);
  await route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'cache-control':'no-store'},body:html});
 });

 await check('作者正文、引用和链接卡片各自独立，readTweets与公共解析器一致',async()=>{
  await setPage(documentHTML(post('author_main','101','仅属于作者的正文',quote('quoted_author','701','被引用者的独立正文')+card('www.example.invalid','独立卡片标题'))));
  const direct=await readPublicPosts(page),compat=await readTweets(page);assert.deepEqual(compat,direct);assert.equal(direct.length,1);assert.equal(direct[0].text,'仅属于作者的正文');assert.deepEqual(direct[0].quote,{handle:'quoted_author',platformId:'701',text:'被引用者的独立正文',media:false});assert.deepEqual(direct[0].card,{domain:'example.invalid',title:'独立卡片标题'});assert.ok(!direct[0].text.includes('被引用者'));assert.equal(report.externalRequests.length,0);
 });
 await check('引用媒体只归属引用，不能冒充作者媒体',async()=>{
  const media='<div data-testid="tweetPhoto"><img alt="合成媒体占位" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="></div>';
  await setPage(documentHTML(post('author_main','102','作者自己的问题',quote('quoted_author','702','带媒体引用',media))));const [parsed]=await readPublicPosts(page);assert.equal(parsed.quote.media,true);assert.equal(parsed.mediaUnavailable,false);assert.equal(parsed.text,'作者自己的问题');
 });
 await check('引用1000和卡片300字符边界不切断UTF16代理对',async()=>{
  const quoted='a'.repeat(999)+'😀'+'尾',title='b'.repeat(299)+'😀'+'尾';await setPage(documentHTML(post('author_main','103','作者正文保持完整',quote('quoted_author','703',quoted)+card('example.invalid',title))));const [parsed]=await readPublicPosts(page);assert.equal(parsed.quote.truncated,true);assert.equal(parsed.card.truncated,true);assert.equal(parsed.quote.text.length,999);assert.equal(parsed.card.title.length,299);assert.ok(parsed.quote.text.length<=1000);assert.ok(parsed.card.title.length<=300);for(const text of [parsed.quote.text,parsed.card.title])assert.equal(/[\uD800-\uDBFF]$/.test(text),false);assert.equal(parsed.text,'作者正文保持完整');
 });
 await check('容器存在但引用或卡片不可读时明确标记，不能静默丢弃',async()=>{
  await setPage(documentHTML(post('author_main','104','正常提问','<div data-testid="quoteTweet">不可读引用容器</div><div data-testid="card.wrapper"><span>缺少可靠域名的卡片</span></div>')));const [parsed]=await readPublicPosts(page);assert.deepEqual(parsed.quote,{unreadable:true});assert.deepEqual(parsed.card,{unreadable:true});assert.equal(parsed.text,'正常提问');
 });
 await check('嵌套引用不串作者或媒体，引用内卡片不冒充作者卡片',async()=>{
  const nested=quote('nested_author','705','内层引用正文','<div data-testid="tweetPhoto">内层媒体</div>')+card('inside.invalid','引用内卡片');await setPage(documentHTML(post('author_main','105','作者正文',quote('outer_author','704','外层引用正文',nested))));let [parsed]=await readPublicPosts(page);assert.deepEqual(parsed.quote,{handle:'outer_author',platformId:'704',text:'外层引用正文',media:false});assert.equal(parsed.card,undefined);assert.equal(parsed.text,'作者正文');
  await setPage(documentHTML(post('author_main','106','另一条作者正文','<div data-testid="quoteTweet">'+quote('nested_author','706','不能偷用的内层正文')+'</div>')));[parsed]=await readPublicPosts(page);assert.deepEqual(parsed.quote,{unreadable:true});
 });
 await check('长串仅保留紧邻前十一条加目标，目标之后全部排除',async()=>{
  const before=Array.from({length:20},(_,index)=>post('ancestor_user',String(100+index),'上文'+index)).join(''),after=post('later_user','601','目标之后的旁人回复')+post('later_user','602','更多旁人回复'),html=documentHTML(before+post(targetHandle,targetId,'可靠目标正文')+after);for(let i=0;i<20;i++)link(String(100+i),i?String(99+i):null,'100');link(targetId,'119','100');await setPage(html);const result=await publicConversationContext(contextInput());assert.equal(result.contextIncomplete,false);assert.equal(result.omittedEarlier,true);assert.equal(result.messages.length,12);assert.equal(result.messages[0].platformId,'109');assert.equal(result.messages.at(-1).platformId,targetId);assert.ok(!result.messages.some(message=>['601','602'].includes(message.platformId)));
 });
 await check('短串保留目标前上文及引用卡片，不混入后续讨论',async()=>{
  const html=documentHTML(post('ancestor_a','201','最近的上文')+post(targetHandle,targetId,'可靠目标正文',quote('quoted_author','707','目标引用')+card('example.invalid','目标卡片'))+post('later_user','603','不属于上下文的后续回复'));link(targetId,'201','201');await setPage(html);const result=await publicConversationContext(contextInput());assert.deepEqual(result.messages.map(message=>message.platformId),['201',targetId]);assert.equal(result.omittedEarlier,false);assert.equal(result.messages.at(-1).quote.text,'目标引用');assert.equal(result.messages.at(-1).card.title,'目标卡片');
 });
 await check('缺失或重复目标只返回明确不完整的空数组，严格定位拒绝',async()=>{
  for(const [body,code]of [[post('ancestor_a','202','页面其它帖子'),'public-target-timeout'],[post(targetHandle,targetId,'可靠目标正文')+post(targetHandle,targetId,'可靠目标正文'),'public-target-ambiguous']]){
   await setPage(documentHTML(body));const input=contextInput('可靠目标正文',{timeoutMs:250,intervalMs:40});const result=await publicConversationContext(input);assert.equal(result.contextIncomplete,true);assert.deepEqual(result.messages,[]);assert.equal(result.diagnostic.code,code);await assert.rejects(()=>waitForPublicTarget(contextInput('可靠目标正文',{timeoutMs:250,intervalMs:40})),error=>error.code===code);
  }
 });
 await check('显式删除/不可用目标抛错，不允许以不完整上下文继续生成',async()=>{
  await setPage(documentHTML('<div data-testid="error-detail">This Post was deleted</div>'));await assert.rejects(()=>publicConversationContext(contextInput('可靠目标正文',{timeoutMs:1400,intervalMs:100})),error=>error.code==='public-target-unavailable');
 });
 await check('main提前ready但目标延后600ms水合时必须等待真实目标',async()=>{
  const before=post('ancestor_a','203','先出现的上文'),complete=before+post(targetHandle,targetId,'延后出现的目标');const started=Date.now();await setPage(documentHTML(before+'<div role="progressbar">正在读取目标</div>',`setTimeout(()=>{document.querySelector('main').innerHTML=${JSON.stringify(complete)}},600)`));const result=await publicConversationContext(contextInput('延后出现的目标',{timeoutMs:2500,intervalMs:50}));assert.equal(result.contextIncomplete,false);assert.equal(result.messages.at(-1).platformId,targetId);assert.equal(result.messages.at(-1).text,'延后出现的目标');assert.ok(Date.now()-started>=600);
  const native=observeNativeReads(page),pendingStarted=Date.now();try{await setPage(documentHTML(post(targetHandle,targetId,'旧缓存中看似可靠的目标'),`fetch('/i/api/graphql/fixture/TweetDetail').then(response=>response.json()).then(()=>{document.querySelector('main').innerHTML='<div data-testid="error-detail">This Post was deleted</div>'})`));await assert.rejects(()=>publicConversationContext(contextInput('旧缓存中看似可靠的目标',{timeoutMs:2500,intervalMs:50,pendingRequests:native.count,failedRequests:native.failures})),error=>error.code==='public-target-unavailable');assert.ok(Date.now()-pendingStarted>=800);}finally{native.dispose();}
 });
 await check('inspectPublicPost只读返回严格目标与去重上文作者，不含后续作者',async()=>{
  const html=documentHTML(post('ancestor_a','204','上文甲')+post('ancestor_b','205','上文乙')+post('ancestor_a','206','上文甲继续')+post(targetHandle,targetId,'核对取得的目标正文',card('example.invalid','不会被打开的卡片'))+post('later_user','604','后续讨论'));link('205','204','204');link('206','205','204');link(targetId,'206','204');fixtures.set(new URL(targetUrl).pathname,html);const navigated=[];const result=await inspectPublicPost({page,url:targetUrl+'?source=fixture',deadline:Date.now()+3000,navigate:async(p,url)=>{navigated.push(url);await p.goto(url,{waitUntil:'domcontentloaded'});}});assert.deepEqual(navigated,[targetUrl]);assert.equal(result.event.platformId,targetId);assert.equal(result.target.text,'核对取得的目标正文');assert.equal(result.target.timestampReliable,true);assert.deepEqual(result.context.ancestorHandles,['ancestor_a','ancestor_b']);assert.equal(result.context.posts.at(-1).platformId,targetId);assert.equal(result.context.contextIncomplete,false);assert.equal(report.externalRequests.length,0);
 });
 await check('inspectPublicPost拒绝缺失/重复/作者不符，所有访问均为合成只读导航',async()=>{
  for(const [body,codes]of [[post('ancestor_a','207','没有目标'),['public-target-timeout']],[post(targetHandle,targetId,'重复目标')+post(targetHandle,targetId,'重复目标'),['public-target-ambiguous']],[post('wrong_author',targetId,'错误作者目标'),['public-target-mismatch']]]){
   fixtures.set(new URL(targetUrl).pathname,documentHTML(body));await assert.rejects(()=>inspectPublicPost({page,url:targetUrl,deadline:Date.now()+350,navigate:async(p,url)=>p.goto(url,{waitUntil:'domcontentloaded'})}),error=>codes.includes(error.code));
  }
  assert.equal(report.externalRequests.length,0);assert.ok(report.requests.every(request=>request.method==='GET'));assert.equal(await page.evaluate(()=>window.__cardClicks||0),0);
 });
}catch(error){report.errors.push({name:'脚本执行异常',error:error.stack||String(error)});}
finally{if(context)await context.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});persist();console.log(JSON.stringify({...report,passed:report.checks.length,failed:report.errors.length},null,2));if(report.errors.length)process.exitCode=1;}
