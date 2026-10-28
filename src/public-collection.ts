// 公开采集的就绪契约。只读页面，始终受调用者的同一采集截止时间约束。
import type {Page} from 'playwright-core';
import type {Event} from './types.js';

export const PUBLIC_COLLECTION_CODES=[
 'public-ready','public-confirmed-empty','public-budget-exhausted','public-page-timeout',
 'public-page-error','public-target-unavailable','public-target-missing','public-wrong-location',
 'public-parser-unready','public-profile-unready','public-navigation-failed','public-pin-unrecognized',
] as const;
export type PublicCollectionCode=typeof PUBLIC_COLLECTION_CODES[number];
export type PublicSource='mentions'|'search'|'own-post-replies';
export type PublicPageKind='mentions'|'search'|'profile'|'thread';
export type PublicPageSnapshot={url:string;mainPresent:boolean;loading:boolean;empty:'timeline'|'replies'|null;error:'target-unavailable'|'page-error'|null};
export type PublicPinState={platformId:string;state:'pinned'|'plain'|'unknown'};
export type PublicCollectionDiagnostic={channel:'public';status:'ok'|'empty'|'partial'|'failed'|'unsupported';code:PublicCollectionCode;source:PublicSource;eventCount:number;readyPages:number;failedPages:number;emptyPages:number};
export type ReadyPublicPage={events:Event[];state:'ready'|'empty'|'partial'|'failed';code:PublicCollectionCode;targetSeen:boolean;reads:number};
export type PublicReadinessInput={
 page:Page;handle:string;deadline:number;readTweets:(page:Page)=>Promise<Event[]>;
 now?:()=>number;sleep?:(milliseconds:number)=>Promise<void>;inspect?:(page:Page)=>Promise<PublicPageSnapshot>;
 pendingRequests?:()=>number;
 failedRequests?:()=>number;
 readPinStates?:(page:Page)=>Promise<PublicPinState[]>;
 intervalMs?:number;stableMs?:number;minimumObserveMs?:number;pageTimeoutMs?:number;
};

/** 只识别文章之外的专用状态节点；帖子中引用“已删除／无结果”不会冒充页面状态。 */
export async function readPublicPageSnapshot(page:Page):Promise<PublicPageSnapshot>{
 return page.evaluate(()=>{
  const main=document.querySelector('main');
  const visible=(node:Element)=>{const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&!!node.getClientRects().length;};
  const states=main?[...main.querySelectorAll('[data-testid="emptyState"],[data-testid="error-detail"],[role="alert"]')].filter(node=>!node.closest('article')&&visible(node)):[];
  const statusText=states.map(node=>(node as HTMLElement).innerText||node.textContent||'').join('\n');
  const missing=/this (?:post|tweet) (?:was|has been) deleted|this (?:post|tweet) is unavailable|(?:this page|that page|page) (?:does(?:n.t| not) exist|is unavailable)|此(?:帖子|贴文|推文)(?:已被?删除|不存在|无法查看|不可用)|(?:帖子|贴文|推文)已被删除|此页面不存在/i.test(statusText);
  const failed=/something went wrong|try reloading|could(?:n.t| not) (?:load|retrieve)|unable to load|发生错误|出了点问题|加载失败|重新加载/i.test(statusText);
  const replies=/no (?:replies|responses)|be the first to reply|(?:暂无|尚无|还没有|没有)(?:任何)?回复/i.test(statusText);
  const timeline=/no (?:notifications|results|posts|tweets)|nothing to see|nothing here yet|(?:暂无|尚无|还没有|没有)(?:任何)?(?:通知|结果|帖子|贴文|推文)/i.test(statusText);
  const progress=main?[...main.querySelectorAll('[role="progressbar"],[data-testid="spinner"],[data-testid="loading"],[aria-busy="true"]')].some(visible):false;
  return {url:location.href,mainPresent:!!main,loading:!!main&&(main.getAttribute('aria-busy')==='true'||progress),empty:replies?'replies':timeline?'timeline':null,error:missing?'target-unavailable':failed?'page-error':null} as PublicPageSnapshot;
 });
}

/** 置顶信息属于文章自身，引用卡片里的 socialContext 不能替文章作证。 */
export async function readPublicPinStates(page:Page):Promise<PublicPinState[]>{
 if(typeof page.locator!=='function')return [];
 return page.locator('article[data-testid="tweet"]').evaluateAll(articles=>articles.slice(0,60).flatMap((article):PublicPinState[]=>{
  const owned=(node:Element)=>node.closest('article[data-testid="tweet"]')===article&&!node.closest('[data-testid="quoteTweet"],[data-testid="card.wrapper"],div[role="link"]');
  const time=Array.from(article.querySelectorAll('time')).find(owned),id=time?.closest('a')?.getAttribute('href')?.match(/\/status\/(\d+)(?:\?.*)?$/)?.[1];
  if(!id)return [];
  const labels=Array.from(article.querySelectorAll('[data-testid="socialContext"]')).filter(owned).map(node=>((node as HTMLElement).innerText||node.textContent||'').trim().replace(/\s+/g,' '));
  return labels.length?labels.map(label=>({platformId:id,state:/^(?:Pinned|已置顶|置顶)$/i.test(label)?'pinned' as const:'unknown' as const})):[{platformId:id,state:'plain' as const}];
 }));
}

/** 已确认置顶一律排除；未知标记只降级排序，不把猜测当“未置顶”。 */
export function selectRecentOwnPosts(events:Event[],handle:string,pins:PublicPinState[],inspectionFailed=false):{posts:Event[];unknown:boolean;pinnedSkipped:number}{
 const pinned=new Set(pins.filter(pin=>pin.state==='pinned').map(pin=>pin.platformId));
 const unknown=inspectionFailed||pins.some(pin=>pin.state==='unknown');
 const own=events.filter(event=>event.handle.toLowerCase()===handle.toLowerCase()),remaining=own.map((event,index)=>({event,index})).filter(({event})=>!pinned.has(event.platformId??''));
 const reliableAt=(event:Event)=>event.timestampReliable!==false&&Number.isFinite(event.timestamp)&&event.timestamp>0?event.timestamp:null;
 if(!unknown)remaining.sort((a,b)=>{const left=reliableAt(a.event),right=reliableAt(b.event);return left===null&&right!==null?1:left!==null&&right===null?-1:left!==null&&right!==null&&left!==right?right-left:a.index-b.index;});
 return {posts:remaining.slice(0,2).map(({event})=>event),unknown,pinnedSkipped:own.length-remaining.length};
}

function sameLocation(actual:string,expected:string):boolean{
 try{const a=new URL(actual),e=new URL(expected);return a.origin===e.origin&&a.pathname.replace(/\/$/,'').toLowerCase()===e.pathname.replace(/\/$/,'').toLowerCase()&&(e.pathname!=='/search'||a.searchParams.get('q')===e.searchParams.get('q')&&a.searchParams.get('f')===e.searchParams.get('f'));}catch{return false;}
}
function reliable(event:Event,allowUnknownTime=false):boolean{
 if(event.channel!=='public'||typeof event.text!=='string'||!event.text.trim()&&!event.mediaUnavailable||!allowUnknownTime&&(event.timestampReliable===false||!Number.isFinite(event.timestamp)||event.timestamp<=0)||!/^\d+$/.test(event.platformId??'')||!/^\w{1,15}$/.test(event.handle))return false;
 try{const url=new URL(event.url);return url.origin==='https://x.com'&&url.pathname.match(/\/status\/(\d+)$/)?.[1]===event.platformId&&!url.username&&!url.password;}catch{return false;}
}
function finite(value:number|undefined,fallback:number,min:number,max:number){return typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;}

/** 只旁观页面自己发起的原生读取；不读取认证头、不构造或重放平台接口。 */
export function observeNativeReads(page:Page):{count:()=>number;failures:()=>number;reset:()=>void;dispose:()=>void}{
 const requests=new Set<unknown>();let failures=0;if(typeof page.on!=='function'||typeof page.off!=='function')return {count:()=>0,failures:()=>0,reset:()=>{},dispose:()=>{}};
 const started=(request:any)=>{try{const url=new URL(request.url());if(url.origin==='https://x.com'&&/^\/i\/api\/(?:graphql\/|2\/)/.test(url.pathname)&&['fetch','xhr'].includes(request.resourceType()))requests.add(request);}catch{}};
 const finished=(request:unknown)=>requests.delete(request);
 const failed=(request:unknown)=>{if(requests.delete(request))failures++;};
 const response=(value:any)=>{try{if(requests.has(value.request())&&value.status()>=400)failures++;}catch{}};
 page.on('request',started);page.on('requestfinished',finished);page.on('requestfailed',failed);page.on('response',response);
 return {count:()=>requests.size,failures:()=>failures,reset:()=>{requests.clear();failures=0;},dispose:()=>{page.off('request',started);page.off('requestfinished',finished);page.off('requestfailed',failed);page.off('response',response);}};
}

/**
 * 不把 main、第一篇文章或一次空解析当成就绪。线程至少见到目标与可读回复，或明确的无回复标志。
 * 返回前等待一个短的稳定窗口；预算用完时仅保留确实读到的有界来源，不伪造成功空集。
 */
export async function waitForPublicTimeline(input:PublicReadinessInput,expected:{url:string;kind:PublicPageKind;targetId?:string}):Promise<ReadyPublicPage>{
 const now=input.now??Date.now,sleep=input.sleep??(milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))),inspect=input.inspect??readPublicPageSnapshot;
 const interval=finite(input.intervalMs,100,10,1000),stable=finite(input.stableMs,400,0,5000),minimum=finite(input.minimumObserveMs,expected.kind==='thread'?1000:600,0,10000),start=now(),wallStart=Date.now(),pageLimit=finite(input.pageTimeoutMs,10000,50,30000),until=Math.min(input.deadline,start+pageLimit);
 const found=new Map<string,Event>();let targetSeen=false,reads=0,lastSignature='',unchangedAt=start,last:PublicPageSnapshot|undefined,errorSince=start,lastError='';
 const maxReads=Math.ceil(pageLimit/interval)+3;
 const result=(state:ReadyPublicPage['state'],code:PublicCollectionCode):ReadyPublicPage=>({events:[...found.values()],state,code,targetSeen,reads});
 // 墙钟和次数边界同时存在，注入时钟忘记前进也不能形成无限读取。
 while(reads<maxReads&&Date.now()-wallStart<=pageLimit+interval){
  if(now()>=input.deadline)return result(found.size?'partial':'failed','public-budget-exhausted');
  let rows:Event[];
  try{[last,rows]=await Promise.all([inspect(input.page),input.readTweets(input.page)]);}catch(error){if((error as any)?.restricted)throw error;return result(found.size?'partial':'failed','public-parser-unready');}
  reads++;const at=now(),here=sameLocation(last.url,expected.url),valid=rows.filter(event=>reliable(event,event.handle.toLowerCase()===input.handle.toLowerCase()&&(expected.kind==='profile'||expected.kind==='thread'&&event.platformId===expected.targetId))).slice(0,120),networkPending=(input.pendingRequests?.()??0)>0;
  if(here){
   // profile 只是下一步扫描的候选目录；用当前 DOM 顺序，不能把早先缓存里的置顶/旧位置带入最终选帖。
   if(expected.kind==='profile')found.clear();
   for(const event of valid){if(found.size>=120&&!found.has(event.platformId!))continue;found.set(event.platformId!,event);}if(expected.targetId&&valid.some(event=>event.platformId===expected.targetId))targetSeen=true;
  }
  const signature=JSON.stringify([here,last.mainPresent,last.loading,networkPending,last.empty,last.error,valid.map(event=>[event.platformId,event.text.length,event.timestamp])]);if(signature!==lastSignature){lastSignature=signature;unchangedAt=at;}
  const stableNow=at-unchangedAt>=stable&&at-start>=minimum;
  if((input.failedRequests?.()??0)>0)return result(found.size?'partial':'failed','public-page-error');
  if(here&&last.error){
   if(lastError!==last.error){lastError=last.error;errorSince=at;}
   if(at-errorSince>=Math.min(200,stable)&&reads>=2)return result(found.size?'partial':'failed',last.error==='target-unavailable'?'public-target-unavailable':'public-page-error');
  }else{lastError='';errorSince=at;}
  if(here&&last.mainPresent&&!last.loading&&!networkPending&&!last.error&&stableNow){
   if(expected.kind==='thread'){
    const target=valid.find(event=>event.platformId===expected.targetId),foreign=valid.some(event=>event.platformId!==expected.targetId&&event.handle.toLowerCase()!==input.handle.toLowerCase());
    if(target&&foreign)return result('ready','public-ready');
    if(target&&last.empty==='replies')return result('empty','public-confirmed-empty');
   }else{
    if(last.empty==='timeline'&&!valid.length)return result('empty','public-confirmed-empty');
    if(valid.length&&(expected.kind!=='profile'||valid.some(event=>event.handle.toLowerCase()===input.handle.toLowerCase())))return result('ready','public-ready');
   }
  }
  if(at>=until)break;
  await sleep(Math.max(1,Math.min(interval,until-at)));
 }
 if(now()>=input.deadline)return result(found.size?'partial':'failed','public-budget-exhausted');
 if(last&&!sameLocation(last.url,expected.url))return result(found.size?'partial':'failed','public-wrong-location');
 if(expected.kind==='thread'&&!targetSeen)return result(found.size?'partial':'failed','public-target-missing');
 if(expected.kind==='profile'&&!found.size)return result('failed','public-profile-unready');
 if(!found.size)return result('failed',last?.mainPresent?'public-parser-unready':'public-page-timeout');
 return result('partial','public-page-timeout');
}

export type ReadyPublicCollectionInput=PublicReadinessInput&{source:number;navigate:(page:Page,url:string,deadline:number)=>Promise<void>};
const warning=(code:PublicCollectionCode)=>`公开采集未完成（${code}）`;
/** 三种来源继续由外层轮换；自己的两条可读帖子逐条等待评论列表，单条失败不吞掉其他已读来源。 */
export async function collectReadyPublic(input:ReadyPublicCollectionInput):Promise<{events:Event[];warnings:string[];diagnostics:PublicCollectionDiagnostic[]}>{
 const native=observeNativeReads(input.page),readiness={...input,pendingRequests:()=>native.count()+(input.pendingRequests?.()??0),failedRequests:()=>native.failures()+(input.failedRequests?.()??0)};
 try{
 const now=input.now??Date.now,source:PublicSource=input.source===0?'mentions':input.source===1?'search':'own-post-replies',events:Event[]=[],warnings:string[]=[],codes:PublicCollectionCode[]=[];
 let readyPages=0,failedPages=0,emptyPages=0,threadPages=0,emptyThreads=0,initialEmpty=false,pinUnknown=false;
 const consume=(page:ReadyPublicPage)=>{codes.push(page.code);if(page.state==='ready'||page.state==='empty'){readyPages++;if(page.state==='empty')emptyPages++;}else if(page.code!=='public-budget-exhausted')failedPages++;if(page.state==='partial'||page.state==='failed')warnings.push(warning(page.code));};
 const navigate=async(url:string)=>{
  if(now()>=input.deadline){codes.push('public-budget-exhausted');warnings.push(warning('public-budget-exhausted'));return false;}
  native.reset();try{await input.navigate(input.page,url,input.deadline);return true;}catch(error){if((error as any)?.restricted)throw error;const code:PublicCollectionCode=now()>=input.deadline?'public-budget-exhausted':'public-navigation-failed';codes.push(code);warnings.push(warning(code));if(code!=='public-budget-exhausted')failedPages++;return false;}
 };
 const url=source==='mentions'?'https://x.com/notifications/mentions':source==='search'?'https://x.com/search?q='+encodeURIComponent('@'+input.handle)+'&f=live':'https://x.com/'+input.handle;
 if(await navigate(url)){
  const initial=await waitForPublicTimeline(readiness,{url,kind:source==='own-post-replies'?'profile':source});consume(initial);initialEmpty=initial.state==='empty';
  if(source==='own-post-replies'){
   let pins:PublicPinState[]=[],inspectionFailed=false;try{pins=await (input.readPinStates??readPublicPinStates)(input.page);}catch(error){if((error as any)?.restricted)throw error;inspectionFailed=true;}
   const selection=selectRecentOwnPosts(initial.events,input.handle,pins,inspectionFailed),own=selection.posts;pinUnknown=selection.unknown;if(pinUnknown){codes.push('public-pin-unrecognized');warnings.push('公开采集置顶标记无法识别，按页面顺序处理（public-pin-unrecognized）');}
   for(const post of own){
    if(!await navigate(post.url)){if(now()>=input.deadline)break;continue;}
    threadPages++;const thread=await waitForPublicTimeline(readiness,{url:post.url,kind:'thread',targetId:post.platformId});consume(thread);if(thread.state==='empty')emptyThreads++;
    // 没有看见自己目标帖的页面可能仍显示前一页，不能把推荐或旧页面当成回复来源。
    if(thread.targetSeen)events.push(...thread.events.filter(event=>event.handle.toLowerCase()!==input.handle.toLowerCase()));
    if(now()>=input.deadline)break;
   }
  }else events.push(...initial.events.filter(event=>event.handle.toLowerCase()!==input.handle.toLowerCase()));
 }
 const deduped=[...new Map(events.map(event=>[event.channel+':'+event.platformId,{...event,accountId:input.handle.toLowerCase()}])).values()];
 const budget=codes.includes('public-budget-exhausted'),failed=failedPages>0,status:PublicCollectionDiagnostic['status']=failed?(deduped.length?'partial':'failed'):budget||pinUnknown?'partial':initialEmpty||threadPages>0&&threadPages===emptyThreads?'empty':'ok';
 const code:PublicCollectionCode=failed?(codes.find(value=>!['public-ready','public-confirmed-empty','public-budget-exhausted','public-pin-unrecognized'].includes(value))??'public-parser-unready'):budget?'public-budget-exhausted':pinUnknown?'public-pin-unrecognized':status==='empty'?'public-confirmed-empty':'public-ready';
 return {events:deduped,warnings:[...new Set(warnings)],diagnostics:[{channel:'public',source,status,code,eventCount:deduped.length,readyPages,failedPages,emptyPages}]};
 }finally{native.dispose();}
}
