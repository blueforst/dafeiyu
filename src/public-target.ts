import type {Page} from 'playwright-core';
import type {Event} from './types.js';
import {BrowserOperationError,safeBrowserDiagnostic,type BrowserDiagnostic} from './browser-operation.js';
import {readPublicPosts,type PublicExtras} from './public-post.js';
import {observeNativeReads,readPublicPageSnapshot} from './public-collection.js';
import {publicAncestors,type PublicRelations} from './public-relations.js';

export type PublicArticleSnapshot={index:number;id:string;handle:string;timestamp:number;timestampReliable:boolean;text:string;mediaUnavailable:boolean;conversationId?:string;conversationIdReliable?:boolean;publicRelationConflict?:boolean;replyToId?:string|null;replyToHandle?:string}&PublicExtras;
export type PublicTargetSnapshot={url:string;main:boolean;loading:boolean;unavailable:boolean;articles:PublicArticleSnapshot[]};
export type PublicConversationContext={messages:Event[];contextIncomplete:boolean;omittedEarlier:boolean;diagnostic?:BrowserDiagnostic};
export type InspectPostResult={event:Event;target:Event;context:PublicConversationContext&{posts:Event[];ancestorHandles:string[]}};
export type PublicTargetInput={page:Page;event:Event;verifyCollected?:boolean;deadline?:number;timeoutMs?:number;intervalMs?:number;now?:()=>number;sleep?:(ms:number)=>Promise<void>;snapshot?:()=>Promise<PublicTargetSnapshot>;pendingRequests?:()=>number;failedRequests?:()=>number;relations?:PublicRelations};
/** 只读取页面已经呈现的 DOM，不构造平台请求。引用卡片里的 status 链接不能冒充主目标。 */
export async function publicTargetSnapshot(page:Page,relations?:PublicRelations):Promise<PublicTargetSnapshot>{
 const snapshot=await page.evaluate(()=>{
  const main=document.querySelector('main'),visible=(node:Element)=>{const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&!!node.getClientRects().length;};
  const articles=Array.from(document.querySelectorAll('article[data-testid="tweet"]')).slice(0,60).flatMap((article,index)=>{
   const owned=(node:Element)=>node.closest('article[data-testid="tweet"]')===article&&!node.closest('[data-testid="quoteTweet"],[data-testid="card.wrapper"],div[role="link"]');
   const time=Array.from(article.querySelectorAll('time')).find(owned),href=time?.closest('a')?.getAttribute('href')||'',match=href.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:[/?#]|$)/);if(!match)return [];
   const textNode=Array.from(article.querySelectorAll('[data-testid="tweetText"]')).find(owned) as HTMLElement|undefined;
   const timestamp=Date.parse(time?.getAttribute('datetime')||'');
   return [{index,id:match[2],handle:match[1],text:textNode?.innerText??'',timestamp:Number.isFinite(timestamp)?timestamp:0,timestampReliable:Number.isFinite(timestamp)&&timestamp>0,mediaUnavailable:Array.from(article.querySelectorAll('[data-testid="tweetPhoto"],video')).some(owned)}];
  });
  const notices=main?Array.from(main.querySelectorAll('[data-testid="error-detail"],[data-testid="emptyState"],[role="alert"]')).filter(node=>!node.closest('article')&&visible(node)).map(node=>(node as HTMLElement).innerText||node.textContent||''):[];
  const unavailable=notices.some(text=>/this (?:post|tweet) (?:was deleted|is unavailable|is no longer available)|(?:post|tweet) (?:has been|was) deleted|hmm.{0,12}this page (?:doesn.t|does not) exist|(?:此|这)(?:条|则)?(?:帖子|贴文|推文).{0,12}(?:已删除|已被删除|无法查看|不可用)|(?:帖子|贴文|推文)不存在|此页面不存在/i.test(text));
  return {url:location.href,main:!!main,unavailable,articles};
 });
 const [raw,readiness]=await Promise.all([readPublicPosts(page),readPublicPageSnapshot(page)]),posts=relations?relations.enrich(raw):raw;
 return {...snapshot,main:snapshot.main&&readiness.mainPresent,loading:readiness.loading||readiness.url!==snapshot.url,articles:snapshot.articles.map(article=>{const post=posts.find(value=>value.platformId===article.id&&value.handle===article.handle&&value.timestamp===article.timestamp);return {...article,...(post?{text:post.text,mediaUnavailable:!!post.mediaUnavailable,conversationId:post.conversationId,conversationIdReliable:post.conversationIdReliable,publicRelationConflict:post.publicRelationConflict,replyToId:post.replyToId,replyToHandle:post.replyToHandle}:{}),...(post?.quote?{quote:post.quote}:{}),...(post?.card?{card:post.card}:{})};})};
}
function targetId(event:Event):string{
 let url:URL;try{url=new URL(event.url);}catch{throw new BrowserOperationError('invalid-request','request');}
 const match=url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)$/);
 if(event.channel!=='public'||url.origin!=='https://x.com'||!match||event.platformId&&event.platformId!==match[2]||event.targetId&&event.targetId!==match[2])throw new BrowserOperationError('invalid-request','request');
 return match[2];
}
function sameLocation(url:string,id:string):boolean{try{const actual=new URL(url);return actual.origin==='https://x.com'&&actual.pathname.match(/^\/[A-Za-z0-9_]+\/status\/(\d+)$/)?.[1]===id;}catch{return false;}}
function articleEvent(article:PublicArticleSnapshot):Event{return {id:'x:'+article.id,platformId:article.id,targetId:article.id,channel:'public',userId:'x:'+article.handle.toLowerCase(),handle:article.handle,text:article.text,url:'https://x.com/'+article.handle+'/status/'+article.id,conversationId:article.conversationId??article.id,conversationIdReliable:article.conversationIdReliable===true,publicRelationConflict:article.publicRelationConflict,replyToId:article.replyToId,replyToHandle:article.replyToHandle,timestamp:article.timestamp,timestampReliable:article.timestampReliable,mediaUnavailable:article.mediaUnavailable,...(article.quote?{quote:article.quote}:{}),...(article.card?{card:article.card}:{})};}
/** main 或任意帖子出现都不足以证明目标完成。目标必须唯一、时间可靠且与采集快照一致。 */
export async function waitForPublicTarget(input:PublicTargetInput):Promise<{index:number;target:Event;context:Event[];contextIncomplete:boolean;omittedEarlier:boolean;ancestorHandles:string[]}> {
 const now=input.now??Date.now,sleep=input.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),started=now(),wallStarted=Date.now(),timeout=Math.max(1,Math.min(20000,input.timeoutMs??12000)),deadline=Math.min(input.deadline??Infinity,started+timeout),interval=Math.max(1,Math.min(500,input.intervalMs??200)),id=targetId(input.event),read=input.snapshot??(()=>publicTargetSnapshot(input.page,input.relations));
 let previous='',stable=0,last:PublicTargetSnapshot|undefined,lastProblem:'public-target-timeout'|'public-target-unavailable'|'public-target-ambiguous'|'public-target-mismatch'|'public-context-incomplete'='public-target-timeout';
 let reads=0;const maximumReads=Math.ceil(timeout/interval)+3;
 while(now()<=deadline&&reads++<maximumReads&&Date.now()-wallStarted<=timeout+interval){
  const snapshot=await read();last=snapshot;
  if(!sameLocation(snapshot.url,id))throw new BrowserOperationError('public-target-mismatch','target-navigation');
  const pending=(input.pendingRequests?.()??0)>0,failed=(input.failedRequests?.()??0)>0,targets=snapshot.articles.filter(article=>article.id===id),signature=JSON.stringify([targets,pending]);stable=signature===previous?stable+1:1;previous=signature;
  if(targets.length===1){
   const target=targets[0],expectedHandle=(input.event.handle||new URL(input.event.url).pathname.split('/')[1]).replace(/^@/,'').toLowerCase(),sameAuthor=target.handle.toLowerCase()===expectedHandle,sameTime=input.verifyCollected===false||input.event.timestampReliable!==true||Math.abs(target.timestamp-input.event.timestamp)<1000,sameText=input.verifyCollected===false||target.text.trim().normalize('NFC')===input.event.text.trim().normalize('NFC'),sameMedia=input.verifyCollected===false||input.event.mediaUnavailable===undefined||target.mediaUnavailable===input.event.mediaUnavailable;
   if(!target.text.trim()&&!target.mediaUnavailable&&!target.quote&&!target.card)lastProblem='public-context-incomplete';
   else if(!sameAuthor||!target.timestampReliable||!sameTime||!sameText||!sameMedia)lastProblem='public-target-mismatch';
   else if(snapshot.main&&!snapshot.loading&&!pending&&!failed&&stable>=2&&now()-started>=Math.min(600,timeout)){const verified=articleEvent(target);return {index:target.index,target:verified,...publicAncestors(verified,snapshot.articles.map(articleEvent))};}
  }else if(targets.length>1)lastProblem='public-target-ambiguous';
  else lastProblem=snapshot.unavailable?'public-target-unavailable':'public-target-timeout';
  // 错误提示也可能是 SPA 的旧画面，至少等待一秒且停止加载后才确认不可用。
  if(!targets.length&&snapshot.unavailable&&!snapshot.loading&&!pending&&now()-started>=Math.min(1000,timeout))throw new BrowserOperationError('public-target-unavailable','target-ready');
  if(failed&&!snapshot.unavailable)lastProblem='public-target-timeout';
  if(now()>=deadline)break;await sleep(Math.min(interval,deadline-now()));
 }
 throw new BrowserOperationError(last?.main?lastProblem:'public-target-timeout',lastProblem==='public-target-mismatch'||lastProblem==='public-context-incomplete'?'target-validate':'target-ready');
}

export function canonicalPublicPostUrl(raw:unknown):{url:string;handle:string;platformId:string}{
 let value:URL;try{value=new URL(typeof raw==='string'?raw:'');}catch{throw new BrowserOperationError('invalid-request','request');}
 const match=value.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,40})$/);
 if(value.origin!=='https://x.com'||value.username||value.password||!match)throw new BrowserOperationError('invalid-request','request');
 return {url:value.origin+value.pathname,handle:match[1],platformId:match[2]};
}

/** 生成可使用原采集正文；目标加载不完整时返回显式空上文，绝不拿页面其它帖子凑数。 */
export async function publicConversationContext(input:PublicTargetInput):Promise<PublicConversationContext>{
 try{const result=await waitForPublicTarget(input);return {messages:result.context,contextIncomplete:result.contextIncomplete,omittedEarlier:result.omittedEarlier};}
 catch(error){const diagnostic=safeBrowserDiagnostic(error,'target-ready');if(['public-target-timeout','public-target-ambiguous','public-target-mismatch','public-context-incomplete'].includes(diagnostic.code))return {messages:[],contextIncomplete:true,omittedEarlier:false,diagnostic};throw error;}
}

/** 只读核对供人工补录/角色经历共用，严格目标失败不伪造 event。 */
export async function inspectPublicPost(input:{page:Page;url:unknown;deadline:number;navigate:(page:Page,url:string,deadline:number)=>Promise<void>;now?:()=>number;sleep?:(ms:number)=>Promise<void>;snapshot?:()=>Promise<PublicTargetSnapshot>}):Promise<InspectPostResult>{
 const canonical=canonicalPublicPostUrl(input.url),now=input.now??Date.now;
 if(now()>=input.deadline)throw new BrowserOperationError('operation-timeout','target-navigation');
 const event:Event={id:'x:'+canonical.platformId,platformId:canonical.platformId,targetId:canonical.platformId,channel:'public',userId:'x:'+canonical.handle.toLowerCase(),handle:canonical.handle,text:'',url:canonical.url,conversationId:canonical.platformId,timestamp:0,timestampReliable:false};
 const native=observeNativeReads(input.page);
 try{await input.navigate(input.page,canonical.url,input.deadline);
  const result=await waitForPublicTarget({page:input.page,event,verifyCollected:false,deadline:input.deadline,now,sleep:input.sleep,snapshot:input.snapshot,pendingRequests:native.count,failedRequests:native.failures,relations:native.relations});
  const context={messages:result.context,posts:result.context,ancestorHandles:result.ancestorHandles,contextIncomplete:result.contextIncomplete,omittedEarlier:result.omittedEarlier};
  return {event:result.target,target:result.target,context};
 }finally{native.dispose();}
}
