import {readPrivatePeer} from './chat-dom.js';
import Fastify from 'fastify';
import twitterText from 'twitter-text';
import { type BrowserContext, type Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher.js';
import { readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,fsyncSync } from 'node:fs';
import { createHash,timingSafeEqual,randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { readSecret,redact } from './config.js';
import type { Event,Identity,Receipt } from './types.js';
import { validatePostingText,type PostingValidation } from './posting-policy.js';
import { BrowserPostingCapabilities } from './posting-capabilities.js';
import { BrowserResourceGuard,detectAccountRestriction,classifyPlatformRejection,healthSettings,waitForIdentityReady,type ComplianceObservation,type BrowserProtectionReason } from './unattended-health.js';
import {BrowserOperationError,safeBrowserDiagnostic,browserOperationReason,type BrowserOperationStage} from './browser-operation.js';
import {SubmissionAttempt,type DiagnosticValidation} from './submission-boundary.js';
import {waitForPublicTarget,publicConversationContext,inspectPublicPost,type PublicConversationContext} from './public-target.js';
import {readPublicPosts,validatePublicExtras} from './public-post.js';
import {relevantPublicMessage} from './public-relations.js';
import {collectReadyPublic,observeNativeReads} from './public-collection.js';
import {collectionSources} from './collection-sources.js';
import {inspectPrivateConversation,collectPrivateWithDiagnostics,type ChatProtection} from './chat-dom.js';
import {collectNativePrivate} from './xchat-inbox.js';
import {PrivateAcceptJournal,type PrivateRequestCandidate} from './private-requests.js';
import {acceptNativePrivateRequest,nativeComposerLocators,observeNativePending,matchNativePrivateReceipt,type NativeSubmitEvidence} from './xchat-actions.js';
import type {CollectionDiagnostic} from './collection-health.js';
import {readObservedComplianceProfile,readObservedComplianceFilters,readObservedComplianceQuality,type ComplianceWaitOptions} from './account-compliance-dom.js';
import {waitForPublicPostComposer,publicPostComposerLocators} from './public-composer.js';
const exec=promisify(execFile);
export function browserProxy(value?:string):{server:string}|undefined {
 if(!value?.trim())return undefined;
 try{
  const u=new URL(value);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error();
  return {server:u.origin};
 }catch{throw new Error('浏览器代理地址无效；请使用不含凭据的代理入口');}
}
export class Serial {
 private tail:Promise<unknown>=Promise.resolve();
 run<T>(fn:()=>Promise<T>,options:{timeoutMs?:number;onTimeout?:()=>void|Promise<void>;afterTimeout?:()=>void|Promise<void>}={}):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined,recovery:Promise<unknown>=Promise.resolve();let timedOut=false;let rejectTimeout:(error:Error)=>void=()=>{};
  const timeout=new Promise<never>((_,reject)=>{rejectTimeout=reject;});
  const execute=async()=>{if(options.timeoutMs){timer=setTimeout(()=>{timedOut=true;recovery=Promise.resolve(options.onTimeout?.()).catch(()=>{});rejectTimeout(new Error('浏览器操作超过请求时间上限'));},options.timeoutMs);}try{return await fn();}finally{if(timedOut){await recovery;await options.afterTimeout?.();}}};
  const operation=this.tail.then(execute,execute);
  // 请求超时可以返回，但旧操作退出并完成页面恢复前，下一项不能并发。
  this.tail=operation.catch(()=>{});return Promise.race([operation,timeout]).finally(()=>clearTimeout(timer));
 }
}
function hash(s:string){return createHash('sha256').update(s).digest('hex');}
export function validateOutboundText(text:unknown,isPublic:boolean):asserts text is string {
 const result=validatePostingText(text,isPublic?'reply':'dm');if(!result.allowed)throw new Error(result.reason);
}
export function safeEvent(e:Event){
 const u=new URL(e.url);if(u.origin!=='https://x.com'||u.username||u.password||!/^\/(?:[a-zA-Z0-9_]+\/status\/\d+|messages\/[\d-]+|i\/chat\/[a-zA-Z0-9_-]+)$/.test(u.pathname))throw new Error('消息地址不在允许范围');
 if(!['public','private'].includes(e.channel)||!e.id||!e.userId||typeof e.text!=='string'||e.text.length>30000)throw new Error('消息格式无效');
 if(e.channel==='public'&&(!/\/status\/\d+$/.test(u.pathname)||e.platformId&&u.pathname.split('/').at(-1)!==e.platformId))throw new Error('公开消息目标与地址不符');
 if(e.channel==='private'&&(!/^\/(messages|i\/chat)\//.test(u.pathname)||u.pathname.split('/').at(-1)!==e.conversationId))throw new Error('私信会话与地址不符');
 validatePublicExtras(e);
}
export function platformId(e:Event):string {
 const id=e.platformId||(e.channel==='public'?new URL(e.url).pathname.match(/\/status\/(\d+)$/)?.[1]:'');
 if(!id||e.channel==='public'&&!/^\d+$/.test(id))throw new Error('消息缺少可靠平台 ID');
 return id;
}
type Intent={kind:'reply'|'dm'|'post';handle:string;targetId:string;textHash:string;at:number;receipt:Receipt;native?:NativeSubmitEvidence};
function validNativeIntent(value:NativeSubmitEvidence,target:string){
 const uuid=(id:unknown)=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
 return value?.contract==='xchat-native-v2'&&/^\d{1,25}$/.test(value.selfUserId)&&/^\d+-\d+$/.test(target)&&target.split('-').includes(value.selfUserId)&&uuid(value.targetUuid)&&uuid(value.browserSession)&&Array.isArray(value.baselineIds)&&value.baselineIds.length<=20&&value.baselineIds.every(uuid)&&new Set(value.baselineIds).size===value.baselineIds.length&&(value.ambiguous===undefined||typeof value.ambiguous==='boolean')&&(value.localPendingId===undefined&&value.pendingCreatedAt===undefined||uuid(value.localPendingId)&&!value.baselineIds.includes(value.localPendingId!)&&Number.isSafeInteger(value.pendingCreatedAt)&&(value.pendingCreatedAt??0)>0);
}
// 浏览器与 app 使用同一出站 ID；unknown 永不被有界清理丢弃。
export class TransportJournal {
 entries:Record<string,Intent>=Object.create(null);
 constructor(public path:string){try{const raw=JSON.parse(readFileSync(path,'utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid journal');for(const [id,value] of Object.entries(raw)){const x=value as any;if(x&&x.receipt&&['confirmed','unknown','rejected'].includes(x.receipt.status)&&typeof x.textHash==='string'&&typeof x.handle==='string'&&typeof x.targetId==='string'&&Number.isFinite(x.at)&&['reply','dm','post'].includes(x.kind)){if(x.native!==undefined&&(x.kind!=='dm'||!validNativeIntent(x.native,x.targetId)))throw Error('invalid native intent');if(x.native&&x.receipt.status==='confirmed'&&(x.native.ambiguous||x.receipt.id!==x.native.localPendingId||!/^\d{1,25}$/.test(x.receipt.nativeSequence??'')||BigInt(x.receipt.nativeSequence)<=0n))throw Error('invalid native receipt');this.entries[id]=x;}else if(['confirmed','unknown','rejected'].includes(x?.status))this.entries[id]={kind:'reply',handle:'',targetId:'',textHash:'',at:0,receipt:x};else throw new Error('invalid journal entry');}}catch(e:any){if(e?.code!=='ENOENT')throw new Error('浏览器发送日志损坏，停止自动发送');}}
 get(id:string){return Object.hasOwn(this.entries,id)?this.entries[id]:undefined;}
 intent(id:string,kind:Intent['kind'],handle:string,targetId:string,text:string,native?:NativeSubmitEvidence):Intent {
  if(!/^[A-Za-z0-9:_-]{1,250}$/.test(id)||!handle||!text.trim())throw new Error('发送意图无效');
  const old=this.get(id);
  if(old){if(old.textHash&&(old.textHash!==hash(text)||old.handle!==handle.toLowerCase()||old.targetId!==targetId||old.kind!==kind))throw new Error('出站标识已使用，正文或目标不能改变');return old;}
  if(native&&(kind!=='dm'||!validNativeIntent(native,targetId)||native.localPendingId))throw Error('原生私信提交证据无效');
  const next:Intent={kind,handle:handle.toLowerCase(),targetId,textHash:hash(text),at:Date.now(),receipt:{status:'unknown',reason:'已保存提交意图，尚未取得唯一平台回执'},...(native?{native:structuredClone(native)}:{})};
  this.entries[id]=next;this.save();return next;
 }
 bindNativePending(id:string,pending:{id:string;createdAt:number}){
  const entry=this.get(id);if(!entry?.native||entry.receipt.status!=='unknown'||entry.native.ambiguous)throw Error('原生私信原意图不可绑定');
  if(entry.native.localPendingId&&entry.native.localPendingId!==pending.id)throw Error('本次存在多个本地待发送消息，不能改绑');
  const next={...entry.native,localPendingId:pending.id,pendingCreatedAt:pending.createdAt};
  if(!validNativeIntent(next,entry.targetId)||pending.createdAt<entry.at-1000||pending.createdAt>Date.now()+60000)throw Error('本地待发送消息证据无效');
  entry.native=next;this.save();return next;
 }
 nativePendingConflict(id:string){const entry=this.get(id);if(!entry?.native||entry.receipt.status!=='unknown')throw Error('原生私信原意图不可标记');entry.native.ambiguous=true;this.save();}
 settle(id:string,r:Receipt){if(r.status==='not_submitted')throw new Error('提交意图已存在，不能改记为未提交');const entry=this.get(id);if(!entry)throw new Error('发送意图不存在');if(entry.receipt.status==='confirmed'||entry.receipt.status==='rejected')return entry.receipt;if(r.status==='confirmed'&&!r.id)r={status:'unknown',reason:'缺少唯一平台回执 ID'};if(r.status==='confirmed'&&entry.native&&(entry.native.ambiguous||r.id!==entry.native.localPendingId||!/^\d{1,25}$/.test(r.nativeSequence??'')||BigInt(r.nativeSequence!)<=0n))r={status:'unknown',reason:'原生私信缺少与原待发送 ID 绑定的平台序号'};entry.receipt=r;this.save();return r;}
 save(){const entries=Object.entries(this.entries);const uncertain=entries.filter(([,x])=>x.receipt.status==='unknown');const finished=entries.filter(([,x])=>x.receipt.status!=='unknown').slice(-2000);this.entries=Object.assign(Object.create(null),Object.fromEntries([...finished,...uncertain]));persistPreflight(this.path,JSON.stringify(this.entries));}
}
type PreflightEntry={kind:Intent['kind'];handle:string;targetId:string;textHash:string;at:number;receipt:Receipt};
function persistPreflight(path:string,serialized:string){
 const temporary=path+'.tmp',fd=openSync(temporary,'w',0o600);try{writeFileSync(fd,serialized);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);
 const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
/** 与提交日志分开的版本化未提交终态；未对账项永不按数量丢弃。 */
export class PreflightJournal {
 private entries:Record<string,PreflightEntry>=Object.create(null);
 private uncertain:Record<string,PreflightEntry>=Object.create(null);
 constructor(readonly path:string,private persist:(path:string,serialized:string)=>void=persistPreflight){try{const raw=JSON.parse(readFileSync(path,'utf8'));if(raw?.version!==1||!raw.entries||typeof raw.entries!=='object'||Array.isArray(raw.entries))throw new Error();for(const [id,value] of Object.entries(raw.entries)){const x=value as any;if(!/^[A-Za-z0-9:_-]{1,250}$/.test(id)||!x||x.receipt?.status!=='not_submitted'||!x.receipt.validation||!['reply','dm','post'].includes(x.kind)||typeof x.handle!=='string'||typeof x.targetId!=='string'||typeof x.textHash!=='string'||!Number.isFinite(x.at))throw new Error();this.entries[id]=x;}}catch(e:any){if(e?.code!=='ENOENT')throw new Error('浏览器预检日志损坏，停止自动发送');}}
 get(id:string,kind:Intent['kind'],handle:string,targetId:string,text:string):Receipt|undefined {
  const old=Object.hasOwn(this.entries,id)?this.entries[id]:Object.hasOwn(this.uncertain,id)?this.uncertain[id]:undefined;if(!old)return;
  if(old.kind!==kind||old.handle!==handle.toLowerCase()||old.targetId!==targetId||old.textHash!==hash(text))throw new Error('出站标识已有未提交终态，正文或目标不能改变');return old.receipt;
 }
 block(id:string,kind:Intent['kind'],handle:string,targetId:string,text:string,validation:PostingValidation):Receipt {
  if(!/^[A-Za-z0-9:_-]{1,250}$/.test(id)||!handle||typeof text!=='string'||validation.allowed)throw new Error('未提交预检参数无效');
  const old=this.get(id,kind,handle,targetId,text);if(old)return old;
  const diagnostic=(validation as DiagnosticValidation).diagnostic;
  const receipt:Receipt&{diagnostic?:ReturnType<typeof safeBrowserDiagnostic>}={status:'not_submitted',reason:validation.reason,validation,...(diagnostic?{diagnostic:safeBrowserDiagnostic({diagnostic})}:{})};
  const next=Object.assign(Object.create(null),this.entries,{[id]:{kind,handle:handle.toLowerCase(),targetId,textHash:hash(text),at:Date.now(),receipt}});
  // 只在文件及目录同步成功后发布终态；写盘异常的同ID也被冻结为unknown，不能再次进入点击。
  try{this.persist(this.path,JSON.stringify({version:1,entries:next}));}catch(error){this.uncertain[id]={...next[id],receipt:{status:'unknown',reason:'预检结果未完成持久确认，禁止重复提交，只允许回查'}};throw error;}
  this.entries=next;return receipt;
 }
}
export type PlatformTweet={id:string;handle:string;text:string;timestamp:number;replyTo:string|null|undefined;url:string;complete?:boolean;textSource?:'legacy'|'unverified-long'};
// 仅解析页面自身已经取得的响应，不构造或调用平台私有接口。
export function platformTweets(data:unknown):PlatformTweet[] {
 const found=new Map<string,PlatformTweet>();let visited=0;
 const walk=(value:any,depth:number)=>{if(!value||typeof value!=='object'||depth>35||++visited>50000)return;
  const legacy=value.legacy;const user=value.core?.user_results?.result;const handle=user?.legacy?.screen_name??user?.core?.screen_name;
  const id=value.rest_id??legacy?.id_str;const timestamp=Date.parse(legacy?.created_at??'');
  if(legacy&&/^\d+$/.test(String(id??''))&&typeof handle==='string'&&/^[A-Za-z0-9_]{1,15}$/.test(handle)&&typeof legacy.full_text==='string'&&Number.isFinite(timestamp)){
   const replyTo=!Object.hasOwn(legacy,'in_reply_to_status_id_str')?undefined:legacy.in_reply_to_status_id_str===null?null:String(legacy.in_reply_to_status_id_str);
   found.set(String(id),{id:String(id),handle:handle.toLowerCase(),text:legacy.full_text,timestamp,replyTo,url:'https://x.com/'+handle+'/status/'+id,complete:twitterText.parseTweet(legacy.full_text).weightedLength<=280&&legacy.truncated!==true&&!value.note_tweet&&!value.note_tweet_results&&!value.note_tweet_id,textSource:value.note_tweet||value.note_tweet_results||value.note_tweet_id?'unverified-long':'legacy'});
  }
  for(const child of Object.values(value))if(child&&typeof child==='object')Array.isArray(child)?child.slice(0,1000).forEach(x=>walk(x,depth+1)):walk(child,depth+1);
 };walk(data,0);return [...found.values()];
}
export function matchTweetReceipt(rows:PlatformTweet[],handle:string,text:string,targetId:string|null,since:number):Receipt {
 if(!since)return {status:'unknown',reason:'缺少原提交时间，无法可靠确认历史发送'};
 const candidates=[...new Map(rows.filter(x=>x.complete!==false&&x.handle===handle.toLowerCase()&&x.text.trim()===text.trim()&&x.replyTo===targetId&&x.timestamp>=Math.floor(since/1000)*1000&&x.timestamp<=Date.now()+60000).map(x=>[x.id,x])).values()];
 return candidates.length===1?{status:'confirmed',id:candidates[0].id,url:candidates[0].url}:{status:'unknown',reason:'尚无唯一且匹配作者、目标、正文及提交时间的平台回执'};
}
/** 唯一回执优先；仅本次点击后新增、能明确归属于发送的提示可作为拒绝证据。 */
export function resolveSubmissionSignals(verified:Receipt,before:string[],after:string[]):Receipt {
 if(verified.status==='confirmed'||verified.status==='rejected')return verified;
 const previous=new Set(before.map(text=>text.trim()));
 const fresh=after.map(text=>text.trim()).filter(text=>text&&!previous.has(text));
 const automation=fresh.some(text=>classifyPlatformRejection(text)==='automation');
 if(automation)return {status:'rejected',reason:'平台自动化拦截本次发送',rejectionKind:'automation'};
 const quota=fresh.some(text=>classifyPlatformRejection(text)==='quota');
 if(quota)return {status:'rejected',reason:'平台明确拒绝本次发送：达到平台额度',rejectionKind:'quota'};
 if(fresh.some(text=>/(?:your (?:post|reply|message)|(?:post|reply|message)) (?:was not|could(?:n.t| not) be) sent|(?:帖子|回复|消息)(?:未能|无法|未)发送/i.test(text)))return {status:'rejected',reason:'平台明确提示本次内容未发送',rejectionKind:'other'};
 return verified;
}
export async function identity(page:Page):Promise<Identity>{
 const result=await page.evaluate(()=>{
  const a=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') as HTMLAnchorElement|null;
  const handle=a?.getAttribute('href')?.split('/').filter(Boolean)[0]||'';
  const cloned=document.body.cloneNode(true) as HTMLElement;cloned.querySelectorAll('article,[data-testid="messageEntry"],[data-testid="tweetText"],[data-testid="UserDescription"],[data-testid="UserName"],[data-testid^="tweetTextarea"],[role="textbox"]').forEach(node=>node.remove());
  const text=cloned.innerText||cloned.textContent||'';
  const needsHuman=/verify (your|you are)|unusual activity|authenticate your|enter (your )?passcode|unlock your|验证你的身份|输入.*密码锁|解锁.*聊天/i.test(text)||/challenge|account\/access/.test(location.pathname);
  return {handle,loggedIn:!!handle,needsHuman,pageText:text,ownAccount:!!handle,url:location.href,reason:needsHuman?'页面需要人工验证或解锁':!handle?'尚未登录或页面结构需要适配':undefined};
 });const restricted=detectAccountRestriction({url:result.url,text:result.pageText,ownAccount:result.ownAccount});
 const {pageText,ownAccount,url,...safe}=result;
 // twid 只提供当前会话的公开数字账号 ID；认证 cookie 和原值不进入结果或日志。
 let userId:string|undefined;try{if(safe.loggedIn){const cookies=await page.context().cookies('https://x.com'),ids=[...new Set(cookies.filter(cookie=>cookie.name==='twid'&&['x.com','.x.com'].includes(cookie.domain)&&cookie.path==='/'&&cookie.secure).flatMap(cookie=>{try{const match=decodeURIComponent(cookie.value).match(/^u=(\d{1,25})$/);return match?[match[1]]:[];}catch{return [];}}))];if(ids.length===1)userId=ids[0];}}catch{}
 return {...safe,...(userId?{userId}:{}),...(restricted?{restricted,reason:'当前工作账号受限：'+restricted}:{})};
}
export async function readTweets(page:Page):Promise<Event[]> {
 return readPublicPosts(page);
}
export async function replyArticleIndex(page:Page,target:string):Promise<number> {
 const indexes=await page.locator('article[data-testid="tweet"]').evaluateAll((nodes,id)=>nodes.slice(0,60).flatMap((a,index)=>{
  const time=Array.from(a.querySelectorAll('time')).find(t=>t.closest('article[data-testid="tweet"]')===a&&!t.closest('[data-testid="quoteTweet"],[data-testid="card.wrapper"],div[role="link"]'));
  return time?.closest('a')?.getAttribute('href')?.match(/\/status\/(\d+)$/)?.[1]===id?[index]:[];
 }),target);
 if(indexes.length!==1)throw Object.assign(new Error('无法唯一定位要回复的主帖'),{code:indexes.length?'public-target-ambiguous':'public-target-timeout',stage:'target-validate'});return indexes[0];
}
export async function readDM(page:Page,conversationId:string,selfHandle=''):Promise<{events:Event[];all:any[]}> {
 if(await page.locator('[data-testid="xchatEmbedRoute"]').count()){
  const actor=await identity(page);if(!selfHandle||actor.handle.toLowerCase()!==selfHandle.toLowerCase()||!actor.loggedIn||actor.needsHuman||!actor.userId)throw new BrowserOperationError('private-contract-unverified','dm-validate');
  const read=await inspectPrivateConversation(page,conversationId,{selfUserId:actor.userId});
  if(read.contract!=='xchat-native-v2'||!read.all.length||read.all.some(row=>row.blockedCodes.length))throw new BrowserOperationError('private-contract-unverified','dm-validate');
  return {events:read.events,all:read.all};
 }
 if(!/^\d+-\d+$/.test(conversationId)&&await page.locator('[data-conversation-type="direct"],[data-chat-type="direct"],[data-participant-count="2"]').count()===0)throw new Error('当前聊天缺少可靠一对一会话标识，停止自动处理');
 const all=await page.evaluate(()=>{
  const nodes=Array.from(document.querySelectorAll('[data-testid="messageEntry"]'));
  return nodes.slice(-20).map(n=>{
   const content=n.querySelector('[data-testid="messageEntryContent"],[data-testid="message-text"]') as HTMLElement|null;
   if(!content)return null;
   const explicit=n.getAttribute('data-direction');
   const direction=explicit==='in'||explicit==='out'?explicit:'unknown';
   const time=n.querySelector('time')?.getAttribute('datetime');const parsed=time?Date.parse(time):NaN;
   const id=n.getAttribute('data-message-id')||(/^message[-_:]/.test(n.id)?n.id:'');
   return {id,text:content.innerText,direction,timestamp:Number.isFinite(parsed)&&parsed>0?parsed:null,media:!!n.querySelector('img:not([data-testid*="Avatar"]),video')};
  }).filter(Boolean);
 });
 const latest=(all as any[]).at(-1);
 // 仅处理最后一条明确为入站的消息，防止重复响应自己的发言。
 const events:Event[]=[];
 if(latest&&latest.direction==='in'){
  if(!latest.id)throw new Error('私信缺少稳定平台消息 ID，停止该项采集');
  events.push({id:'dm:'+conversationId+':'+latest.id,platformId:String(latest.id),targetId:conversationId,channel:'private',userId:'dm:'+conversationId,handle:'',text:latest.text,url:page.url().split('?')[0],conversationId,timestamp:latest.timestamp||0,timestampReliable:!!latest.timestamp,mediaUnavailable:latest.media});
 }
 if(!all.length||latest?.direction==='unknown')throw new Error('私信方向或新版聊天结构尚未确认，已跳过');
 const peer=await readPrivatePeer(page,conversationId,selfHandle);if(peer.peerHandle)for(const event of events)event.peerHandle=peer.peerHandle;
 return {events,all};
}
export type CollectionBudgetInput={page:Page;handle:string;deadline:number;navigate:(page:Page,url:string,deadline:number)=>Promise<void>;now?:()=>number};
function collected(events:Event[],warnings:string[],handle:string,diagnostics?:CollectionDiagnostic[]){return {events:[...new Map(events.map(e=>[e.channel+':'+e.platformId,{...e,accountId:handle.toLowerCase()}])).values()],warnings,...(diagnostics?{diagnostics}:{})};}

export async function collectPublicWithBudget(input:CollectionBudgetInput&{source:number}){
 return collectReadyPublic({...input,readTweets});
 }

export async function collectPrivateWithBudget(input:CollectionBudgetInput){
 return collectPrivateWithDiagnostics(input);
}

/** 仅访问自己的资料及页面提供的通知设置链接；不点击任何开关。 */
export async function readCompliance(page:Page,handle:string,navigate:(page:Page,url:string)=>Promise<void>,readiness:ComplianceWaitOptions={}):Promise<ComplianceObservation>{
 const result:ComplianceObservation={accountId:handle.toLowerCase(),profileReliable:false,automatedLabel:null,qualityFilter:null,reasons:[]};
 await navigate(page,'https://x.com/'+handle);
 const profileObservation=await readObservedComplianceProfile(page,handle,readiness),profile=profileObservation.value;
 result.profileReliable=profile.reliable;result.name=profile.name;result.bio=profile.bio;result.automatedLabel=profile.automatedLabel;if(!profile.reliable)result.reasons!.push('自己的资料页结构无法可靠解析');else if(profile.automatedLabel===null)result.reasons!.push('自己的资料页自动化标签结构无法可靠确认');
 await navigate(page,'https://x.com/settings/notifications');
 const filtersObservation=await readObservedComplianceFilters(page,readiness),filterLink=filtersObservation.value;
 if(filterLink)await navigate(page,'https://x.com'+filterLink);
 const qualityObservation=await readObservedComplianceQuality(page,readiness);result.qualityFilter=qualityObservation.value;
 result.diagnostics={profile:profileObservation.diagnostics,filters:filtersObservation.diagnostics,quality:qualityObservation.diagnostics};
 if(result.qualityFilter===null)result.reasons!.push('通知质量过滤开关无法可靠确认');return result;
}
export async function startBrowserServer(options:{launch?:typeof launchBrowser}={}){
 const secret=readSecret('browser_key');if(!secret)throw new Error('缺少浏览器内部凭据');
 const profile=process.env.PROFILE_DIR||'/profile';mkdirSync(profile,{recursive:true});
 let shuttingDown=false,internalRestart=false;
 let mode='paused',effectiveHealth=healthSettings();const serial=new Serial();let round=0;let context:BrowserContext;const launch=options.launch??launchBrowser;
 const journal=new TransportJournal(profile+'/transport-journal.json');
 const privateAccepts=new PrivateAcceptJournal(profile+'/private-accept-v1.json'),privateOffsets=new Map<string,number>(),browserSession=randomUUID();
 const preflight=new PreflightJournal(profile+'/posting-preflight-v1.json');const capabilities=new BrowserPostingCapabilities();
 const proxy=browserProxy(process.env.BROWSER_PROXY_SERVER);
 context=await launch(profile,proxy);
 function supervise(){context.on('close',()=>{if(shuttingDown||internalRestart)return;console.error('浏览器上下文关闭，交由监督器恢复');process.exit(1);});}supervise();
 const isChatPage=(page:Page)=>!page.isClosed()&&/^https:\/\/x\.com\/(?:i\/chat|messages)(?:\/|$)/.test(page.url());
 let publicPage=context.pages().find(page=>!isChatPage(page))||await context.newPage();
 await publicPage.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
 let dmPage:Page|undefined=context.pages().filter(isChatPage).at(-1);
 let privateProtection:ChatProtection={hasUnlockedSession:false,unlockPending:false,needsHuman:false};
 async function adoptChatPage(){
  const candidates=context.pages().filter(isChatPage),selected=candidates.at(-1);
  if(selected&&(!dmPage||dmPage.isClosed()||selected!==dmPage))dmPage=selected;
  if(publicPage.isClosed()||isChatPage(publicPage)){
   if(isChatPage(publicPage))dmPage=publicPage;publicPage=await context.newPage();
   await publicPage.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000});
  }
 }
 const resourceGuard=new BrowserResourceGuard({settings:()=>effectiveHealth,identity:()=>identity(publicPage),restart:async(reportStage,expectedHandle)=>{
  internalRestart=true;try{
   reportStage?.('close-context');await context.close();reportStage?.('launch-context');context=await launch(profile,proxy);supervise();publicPage=context.pages().find(page=>!isChatPage(page))||await context.newPage();dmPage=context.pages().filter(isChatPage).at(-1);capabilities.invalidate('浏览器上下文重启，旧能力证据失效');
   reportStage?.('navigate-home');await publicPage.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000});
   reportStage?.('wait-identity');return await waitForIdentityReady(()=>identity(publicPage),expectedHandle??'',{timeoutMs:30000,intervalMs:250});
  }finally{internalRestart=false;}
 },onRestart:info=>{console.log(JSON.stringify({event:'browser-restart',...info}));}});
 async function operationTimeout(){mode='paused';capabilities.invalidate('浏览器操作超时');
  // 只取消程序公开页；不关闭人工页或已解锁的 Chat。串行锁仍等待旧操作完全退出。
  if(!publicPage.isClosed()&&!isChatPage(publicPage))await publicPage.close().catch(()=>{});
 }
 async function recoverTimedOutPages(){
  if(publicPage.isClosed()||isChatPage(publicPage)){publicPage=await context.newPage();await publicPage.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000});}
  if(dmPage?.isClosed())dmPage=undefined;
  // 请求超时后保持暂停，不能仅因首页仍登录就自动恢复发送。
 }
 async function check(handle:string){
  try{const i=await waitForIdentityReady(()=>identity(publicPage),handle,{timeoutMs:12000,intervalMs:250});capabilities.observe(i);return i;}
  catch(error){mode='paused';const current=await identity(publicPage).catch(()=>null);throw Object.assign(new BrowserOperationError(current?.restricted?'account-restricted':'identity-unavailable','identity'),current?.restricted?{restricted:current.restricted}:{});}
 }
 async function navigate(p:Page,url:string,deadline=Date.now()+45000){const remaining=()=>Math.max(1,Math.min(30000,deadline-Date.now()));if(Date.now()>=deadline)throw new Error('采集时间预算已用完');await p.goto(url,{waitUntil:'domcontentloaded',timeout:remaining()});await p.locator('main').waitFor({timeout:Math.min(12000,remaining())}).catch(()=>{});const state=await identity(p);if((state as any).restricted){mode='paused';throw Object.assign(new Error('当前工作账号受限：'+(state as any).restricted),{restricted:(state as any).restricted});}}
 async function getDM(){await adoptChatPage();if(!dmPage||dmPage.isClosed())dmPage=await context.newPage();return dmPage;}
 async function eventContext(e:Event,attempt?:SubmissionAttempt,handle?:string){
  safeEvent(e);
  if(e.channel==='public'){
   const deadline=Date.now()+45000,native=observeNativeReads(publicPage);attempt?.setStage('target-navigation');
   try{
   try{await navigate(publicPage,e.url,deadline);}catch(error){if((error as any)?.restricted)throw error;throw new BrowserOperationError('public-target-timeout','target-navigation');}
   const actor=handle??attempt?.binding.handle;if(actor)try{await check(actor);}catch(error){throw Object.assign(new BrowserOperationError((error as any)?.restricted?'account-restricted':'identity-unavailable','identity'),(error as any)?.restricted?{restricted:(error as any).restricted}:{});}
   attempt?.setStage('target-ready');
   const reading={page:publicPage,event:e,deadline,pendingRequests:native.count,failedRequests:native.failures,relations:native.relations},ready=attempt?await waitForPublicTarget(reading):null;
   if(ready&&actor&&!relevantPublicMessage(ready.target,actor,ready.context))throw new BrowserOperationError('public-target-unrelated','target-validate');
   const conversation:PublicConversationContext=ready?{messages:ready.context,contextIncomplete:ready.contextIncomplete,omittedEarlier:ready.omittedEarlier}:await publicConversationContext(reading);return JSON.stringify(conversation);
   }finally{native.dispose();}
  }
  const p=await getDM();await navigate(p,e.url);return JSON.stringify((await readDM(p,e.conversationId,handle)).all);
 }
 async function capture(page:Page,fn:()=>Promise<void>):Promise<PlatformTweet[]>{
  const pending:Promise<PlatformTweet[]>[]=[];
  const observe=(response:any)=>{let u:URL;try{u=new URL(response.url());}catch{return;}if(u.origin!=='https://x.com'||!/^\/i\/api\//.test(u.pathname)||pending.length>=80)return;pending.push(response.json().then(platformTweets).catch(()=>[]));};
  page.on('response',observe);
  try{await fn();await page.waitForTimeout(1200);return (await Promise.all(pending)).flat();}finally{page.off('response',observe);}
 }
 async function lookup(e:Event,text:string,requestId:string,handle:string):Promise<Receipt>{
  safeEvent(e);
  const intent=journal.get(requestId);if(!intent){const blocked=preflight.get(requestId,e.channel==='public'?'reply':'dm',handle,e.channel==='public'?platformId(e):e.conversationId,text);if(blocked)return blocked;}if(!intent||!intent.at)return {status:'unknown',reason:'缺少原发送意图，不能按同文消息猜测成功'};
  if(intent.textHash!==hash(text)||intent.handle!==handle.toLowerCase())throw new Error('回查正文或工作账号与原意图不符');
  if(intent.kind!==(e.channel==='public'?'reply':'dm')||intent.targetId!==(e.channel==='public'?platformId(e):e.conversationId))throw new Error('回查目标或渠道与原意图不符');
  if(intent.receipt.status==='confirmed'||intent.receipt.status==='rejected')return intent.receipt;
  if(e.channel==='public'){
   const target=platformId(e);if(intent.targetId!==target)throw new Error('回查目标与原发送意图不符');
   const rows=await capture(publicPage,()=>navigate(publicPage,e.url));
   return matchTweetReceipt(rows,handle,text,target,intent.at);
  }else{
   if(intent.targetId!==e.conversationId)throw new Error('回查私信会话与原发送意图不符');
   const p=await getDM();await navigate(p,e.url);const {all}=await readDM(p,e.conversationId,handle);
   if(intent.native){const actor=await check(handle);if(actor.userId!==intent.native.selfUserId)return {status:'unknown',reason:'原生私信回查账号与原意图不符'};return matchNativePrivateReceipt(all,text,intent.native,intent.at);}
   if(all.some(row=>row.contract==='xchat-native-v2'))return {status:'unknown',reason:'原意图缺少原生本地待发送 ID，不能认领同文消息'};
   const candidates=all.filter(x=>x.direction==='out'&&x.text?.trim()===text.trim()&&x.id&&x.timestamp&&x.timestamp>=intent.at-1000);
   if(candidates.length===1)return {status:'confirmed',id:String(candidates[0].id)};
  }
  return {status:'unknown',reason:'尚无唯一的平台消息回执，保持待回查'};
 }
 async function lookupPost(text:string,requestId:string,handle:string):Promise<Receipt>{
  const intent=journal.get(requestId);if(!intent){const blocked=preflight.get(requestId,'post',handle,'',text);if(blocked)return blocked;}if(!intent||!intent.at)return {status:'unknown',reason:'缺少原帖子提交意图'};
  if(intent.kind!=='post'||intent.handle!==handle.toLowerCase()||intent.textHash!==hash(text))throw new Error('帖子回查参数与原意图不符');
  if(intent.receipt.status!=='unknown')return intent.receipt;
  const rows=await capture(publicPage,()=>navigate(publicPage,'https://x.com/'+handle));
  return matchTweetReceipt(rows,handle,text,null,intent.at);
 }
 const app=Fastify({logger:false,bodyLimit:262144});
 app.addHook('onRequest',async(req,reply)=>{
  const value=String(req.headers['x-browser-key']||'');const a=Buffer.from(value),b=Buffer.from(secret);
  if(a.length!==b.length||!timingSafeEqual(a,b))return reply.code(401).send({error:'未授权'});
 });
 app.get('/health',async()=>({ready:!!context&&context.pages().length>0,mode,engine:'camoufox',version:context.browser()?.version(),...resourceGuard.sample()}));
 app.get('/collection-sources',async()=>collectionSources());
 app.get('/identity',async()=>{
  if(publicPage.isClosed())return {handle:'',loggedIn:false,needsHuman:true,reason:'程序公开页已关闭，请先恢复工作页面'};
  const current=await identity(publicPage);if(mode==='manual'||current.loggedIn||current.needsHuman||current.restricted)return current;
  try{return await waitForIdentityReady(()=>identity(publicPage),'',{timeoutMs:12000,intervalMs:250});}catch{return identity(publicPage);}
 });
 app.post('/control',async(req,reply)=>{
  const next=(req.body as any)?.mode;if(!['manual','paused','auto'].includes(next))return reply.code(400).send({error:'控制模式无效'});
  return serial.run(async()=>{
   if(mode==='manual'&&next!=='manual')await exec('x11vnc',['-display',process.env.DISPLAY||':99','-R','disconnect:all'],{timeout:5000});
   if(mode==='manual'&&next!=='manual'){capabilities.invalidate('人工接管已释放，旧能力证据失效');await adoptChatPage();}mode=next;return {mode};
  });
 });
 function requestHealth(req:any){return healthSettings(req.body?.runtimeHealth??effectiveHealth);}
 app.post('/compliance',async(req,reply)=>serial.run(async()=>{
  effectiveHealth=requestHealth(req);
  if(mode==='manual')return reply.code(409).send({error:'人工接管期间不能执行账号检查'});
  const handle=String((req.body as any)?.handle??'').replace(/^@/,'').toLowerCase();if(!/^[a-z0-9_]{1,15}$/.test(handle))return reply.code(400).send({error:'工作账号无效'});
  try{await resourceGuard.before('compliance',mode,handle);await check(handle);const result=await readCompliance(publicPage,handle,navigate);await check(handle);return result;}catch(error){if(['browser-recovery-failed','browser-resource-pressure'].includes((error as any)?.code))mode='paused';const diagnostic=safeBrowserDiagnostic(error);return reply.code(409).send({error:browserOperationReason(diagnostic.code),diagnostic,browserPaused:mode!=='auto',browserMode:mode});}
 },{timeoutMs:requestHealth(req).rpcTimeoutSeconds*1000,onTimeout:operationTimeout,afterTimeout:recoverTimedOutPages}));
 app.post('/capabilities',async(_req,reply)=>serial.run(async()=>{
  if(mode==='manual')return reply.code(409).send({error:'人工接管期间不能读取当前页面能力'});
  return capabilities.observe(await identity(publicPage));
 }));
 async function validationFor(text:string,operation:'reply'|'post'|'dm',handle:string){
  const snapshot=capabilities.observe(await identity(publicPage));
  return validatePostingText(text,operation,{accountId:handle,capability:operation==='dm'?undefined:snapshot[operation],sessionId:snapshot.sessionId});
 }
 function submissionFor(req:any):SubmissionAttempt|undefined {
  const path=String(req.url).split('?')[0];if(path!=='/send'&&path!=='/post')return;
  const body=req.body??{};let kind:'reply'|'dm'|'post',targetId='';
  try{
   if(path==='/send'){
    const event=body.event as Event;safeEvent(event);kind=event.channel==='public'?'reply':'dm';targetId=event.channel==='public'?platformId(event):event.conversationId;
    if(body.requestId!==(event.outboxId||event.id)||event.timestampReliable===false||!Number.isFinite(event.timestamp)||event.timestamp<=0||event.accountId&&event.accountId.toLowerCase()!==String(body.handle).toLowerCase())throw new Error();
   }else kind='post';
   const binding={requestId:body.requestId,kind,handle:body.handle,targetId,text:body.text};
   return new SubmissionAttempt(binding,{intent:id=>journal.get(id),previous:b=>preflight.get(b.requestId,b.kind,b.handle,b.targetId,b.text),block:(b,validation)=>preflight.block(b.requestId,b.kind,b.handle,b.targetId,b.text,validation)});
  }catch{throw new BrowserOperationError('invalid-request','request');}
 }
 async function task(req:any,reply:any,fn:(attempt?:SubmissionAttempt)=>Promise<unknown>){
  let attempt:SubmissionAttempt|undefined,stage:BrowserOperationStage='request';
  const phase=(next:BrowserOperationStage)=>{stage=next;attempt?.setStage(next);};
  const metadata=(error:any)=>({browserPaused:mode!=='auto',browserMode:mode,...(error?.restricted?{restricted:error.restricted}:{})});
  const report=(diagnostic:ReturnType<typeof safeBrowserDiagnostic>,status:string)=>console.warn(JSON.stringify({event:'browser-operation-failed',requestId:attempt?.binding.requestId,diagnostic,status}));
  try{
   return await serial.run(async()=>{
    try{
     effectiveHealth=requestHealth(req);attempt=submissionFor(req);
     if(typeof req.body?.handle!=='string'||!/^[A-Za-z0-9_]{1,15}$/.test(req.body.handle))throw new BrowserOperationError('invalid-request','request');
     if(attempt?.previous)return {...attempt.previous,...metadata(undefined)};
     phase('control');if(mode!=='auto')throw new BrowserOperationError('control-unavailable','control');
     phase('resource');const operation=String(req.url).split('?')[0].slice(1);await resourceGuard.before(operation==='lookup-post'?'lookupPost':operation,mode,req.body.handle);
     phase('identity');await check(req.body.handle);phase(operation==='context'?'target-navigation':operation.startsWith('lookup')?'lookup':'request');
     return await fn(attempt);
    }catch(original){
     let error=original;const failedStage=safeBrowserDiagnostic(error,attempt?.stage??stage).stage;
     if(['browser-recovery-failed','browser-resource-pressure'].includes((error as any)?.code)||(error as any)?.restricted||failedStage==='identity'){mode='paused';capabilities.invalidate('浏览器身份或恢复状态变化');}
     try{const receipt=attempt?.fail(error);if(receipt){const diagnostic=attempt!.safeFailure(error);report(diagnostic,receipt.status);return {...receipt,...metadata(error)};}}
     catch(failure){error=failure;mode='paused';}
     let diagnostic=attempt?.safeFailure(error)??safeBrowserDiagnostic(error,stage);
     if(diagnostic.code==='unknown-error'&&stage==='identity')diagnostic={code:(error as any)?.restricted?'account-restricted':'identity-unavailable',stage};
     report(diagnostic,'unknown');throw Object.assign(new BrowserOperationError(diagnostic.code,diagnostic.stage),metadata(error));
    }finally{attempt?.markFinished();}
   },{timeoutMs:requestHealth(req).rpcTimeoutSeconds*1000,onTimeout:()=>{attempt?.markTimedOut();return operationTimeout();},afterTimeout:async()=>{
    // 这里运行时旧 fn 已退出且 onTimeout 已关闭旧页面；此前绝不写确定未提交终态。
    try{const result=attempt?.finishTimedOut();if(result)report({code:'operation-timeout',stage:attempt!.stage},result.status);}catch(error){report(safeBrowserDiagnostic(error,attempt?.stage??stage),'unknown');}
    await recoverTimedOutPages();if(attempt)mode='paused';
   }});
  }catch(error){
   const diagnostic=attempt?.safeFailure(error)??safeBrowserDiagnostic(error,stage);
   return reply.code(409).send({error:browserOperationReason(diagnostic.code),diagnostic,...metadata(error)});
  }
 }
 app.post('/prepare-round',async(req,reply)=>task(req,reply,async()=>{
  await adoptChatPage();
  const protections:BrowserProtectionReason[]=[];
  if((req.body as any).unsettledOutbox===true)protections.push('unsettled-outbox');
  if(context.pages().some(isChatPage)){
   protections.push(privateProtection.hasUnlockedSession?'chat-unlocked':'chat-unlock-pending');
   if(privateProtection.needsHuman)protections.push('needs-human');
  }
  return resourceGuard.before('prepare-round',mode,(req.body as any).handle,{safePoint:true,protectedReasons:protections});
 }));
 async function collectPublic(handle:string,requestedDeadline?:number){
  const deadline=Math.min(Date.now()+effectiveHealth.publicCollectionSeconds*1000,Number.isFinite(requestedDeadline)?requestedDeadline!:Infinity);
  return collectPublicWithBudget({page:publicPage,handle,deadline,navigate,source:round++%3});
 }
 async function collectPrivate(handle:string,requestedDeadline?:number){
  const deadline=Math.min(Date.now()+effectiveHealth.privateCollectionSeconds*1000,Number.isFinite(requestedDeadline)?requestedDeadline!:Infinity);
  try{const page=await getDM(),actor=await check(handle),native=actor.userId?await collectNativePrivate({page,handle,deadline,navigate,selfUserId:actor.userId,canContinue:()=>mode==='auto',offsets:privateOffsets,unsettled:privateAccepts.pending(handle),confirmAccepted:conversationId=>{const entry=privateAccepts.get(handle,conversationId);if(entry){if(entry.selfUserId!==actor.userId)throw Error('接受意图与当前账号身份不符');privateAccepts.accepted(handle,conversationId);}}}):null;
   const result=native??await collectPrivateWithBudget({page,handle,deadline,navigate});privateProtection=result.chatProtection;return result;
  }catch(error){if((error as any)?.restricted)throw error;return collected([],['私信页面读取失败，结果未知'],handle,[{channel:'private',source:'chat',status:'failed',code:'private-navigation-failed',eventCount:0}]);}
 }
 app.post('/collect/public',async(req,reply)=>task(req,reply,()=>collectPublic((req.body as any).handle,(req.body as any).deadline)));
 app.post('/collect/private',async(req,reply)=>task(req,reply,()=>collectPrivate((req.body as any).handle,(req.body as any).deadline)));
 app.post('/private/request/accept',async(req,reply)=>task(req,reply,async()=>{
  const {candidate,handle}=req.body as {candidate:PrivateRequestCandidate;handle:string};if(!candidate?.event)throw new BrowserOperationError('invalid-request','request');safeEvent(candidate.event);
  const actor=await check(handle);if(!actor.userId)throw new BrowserOperationError('identity-unavailable','identity');
  const selfUserId=actor.userId;
  return acceptNativePrivateRequest({page:await getDM(),candidate,handle,selfUserId,journal:privateAccepts,lookupOnly:(req.body as any).lookupOnly===true,deadline:Math.min(Date.now()+20000,Number.isFinite((req.body as any).deadline)?(req.body as any).deadline:Infinity),navigate,assertActor:async()=>{const current=await check(handle);if(mode!=='auto'||current.userId!==selfUserId)throw new BrowserOperationError('control-unavailable','control');}});
 }));
 app.post('/collect',async(req,reply)=>task(req,reply,async()=>{
  const {handle}=req.body as {handle:string};const publicResult=await collectPublic(handle);await check(handle);const privateResult=await collectPrivate(handle);
  return collected([...publicResult.events,...privateResult.events],[...publicResult.warnings,...privateResult.warnings],handle,[...(publicResult.diagnostics??[]),...(privateResult.diagnostics??[])]);
 }));
 app.post('/context',async(req,reply)=>task(req,reply,async()=>({text:await eventContext((req.body as any).event,undefined,(req.body as any).handle)})));
 app.post('/inspect-post',async(req,reply)=>task(req,reply,async()=>{
  const body=req.body as any,deadline=Math.min(Date.now()+effectiveHealth.publicCollectionSeconds*1000,Number.isFinite(body.deadline)?body.deadline:Infinity);
  const result=await inspectPublicPost({page:publicPage,url:body.url,deadline,navigate});try{await check(body.handle);}catch(error){throw Object.assign(new BrowserOperationError((error as any)?.restricted?'account-restricted':'identity-unavailable','identity'),(error as any)?.restricted?{restricted:(error as any).restricted}:{});}return result;
 }));
 app.post('/lookup',async(req,reply)=>task(req,reply,async()=>{const {event,text,requestId,handle}=req.body as any;const r=await lookup(event,text,requestId||event.outboxId||event.id,handle);if(journal.get(requestId||event.outboxId||event.id))journal.settle(requestId||event.outboxId||event.id,r);return r;}));
 app.post('/send',async(req,reply)=>task(req,reply,async(attempt)=>{
  const {event:e,text,requestId,handle}=req.body as {event:Event;text:string;requestId:string;handle:string};
  safeEvent(e);if(typeof text!=='string')throw new Error('出站正文格式无效');if(requestId!==(e.outboxId||e.id)||e.timestampReliable===false||!Number.isFinite(e.timestamp)||e.timestamp<=0)throw new Error('发送参数或可靠时间无效');
  const target=platformId(e);
  if(e.channel==='public'&&new URL(e.url).pathname.split('/').at(-1)!==target)throw new Error('平台消息 ID 与目标地址不符');
  if(journal.get(requestId)){journal.intent(requestId,e.channel==='public'?'reply':'dm',handle,e.channel==='public'?target:e.conversationId,text);return lookup(e,text,requestId,handle);}
  const kind=e.channel==='public'?'reply':'dm',destination=e.channel==='public'?target:e.conversationId;
  const previous=preflight.get(requestId,kind,handle,destination,text);if(previous)return previous;
  attempt!.setStage('editor-validate');const initialValidation=await validationFor(text,kind,handle);if(!initialValidation.allowed)return attempt!.block(initialValidation);
  await eventContext(e,attempt,handle);let p=publicPage;
  let responseRows:PlatformTweet[]=[],toastsBefore:string[]=[];
  if(e.channel==='public'){
   attempt!.setStage('target-validate');const article=p.locator('article[data-testid="tweet"]').nth(await replyArticleIndex(p,target));
   attempt!.setStage('reply-open');await article.getByTestId('reply').click({timeout:10000});
   const dialog=p.getByRole('dialog');attempt!.setStage('reply-fill');await dialog.getByTestId('tweetTextarea_0').fill(text,{timeout:10000});
   attempt!.setStage('identity');await check(handle);if(mode!=='auto')throw new BrowserOperationError('control-unavailable','control');
   attempt!.setStage('editor-validate');const validation=await validationFor(text,'reply',handle);if(!validation.allowed)return attempt!.block(validation);
   const submit=dialog.getByTestId('tweetButton');if(await submit.count()!==1||!await submit.isEnabled())return attempt!.block({...validation,allowed:false,code:'editor-unavailable',reason:'编辑器未允许提交，未保存提交意图'});
   toastsBefore=await p.getByTestId('toast').allTextContents();
   attempt!.beforeIntent();journal.intent(requestId,'reply',handle,target,text);attempt!.setStage('submit-click');
   responseRows=await capture(p,async()=>{await dialog.getByTestId('tweetButton').click({timeout:15000});});
  }else{
   attempt!.setStage('dm-validate');p=await getDM();const snap=await readDM(p,e.conversationId,handle),native=e.privateContract==='xchat-native-v2';
   const sameTarget=(latest:Event|undefined)=>latest?.platformId===target&&(!native||latest.privateContract===e.privateContract&&latest.text===e.text&&latest.timestamp===e.timestamp&&latest.senderId===e.senderId&&latest.nativeSequence===e.nativeSequence);
   if(!sameTarget(snap.events.at(-1)))throw new Error('私信上下文已变化，停止发送');
   const composer=native?await nativeComposerLocators(p,e.conversationId,{requireSubmit:false}):null,input=composer?.input??p.locator('[data-testid="dmComposerTextInput"]');if(await input.count()!==1)throw new Error('当前私信输入框尚未适配');
   attempt!.setStage('reply-fill');await input.fill(text);
   if(native&&await input.evaluate(node=>node instanceof HTMLTextAreaElement?node.value:(node as HTMLElement).innerText)!==text)throw new Error('新 Chat 输入框未完整保留待发送正文');
   attempt!.setStage('identity');await check(handle);if(mode!=='auto')throw new BrowserOperationError('control-unavailable','control');
   attempt!.setStage('dm-validate');
   if(!sameTarget((await readDM(p,e.conversationId,handle)).events.at(-1)))throw new Error('提交前私信已有新消息，停止旧上下文回复');
   toastsBefore=await p.getByTestId('toast').allTextContents();
   if(native){
    const actor=await check(handle);if(!actor.userId)throw new BrowserOperationError('identity-unavailable','identity');
    const submit=(await nativeComposerLocators(p,e.conversationId)).submit;
    if(!await submit.isEnabled())return attempt!.block({...initialValidation,allowed:false,code:'editor-unavailable',reason:'新 Chat 编辑器当前不允许发送'});
    const evidence:NativeSubmitEvidence={contract:'xchat-native-v2',selfUserId:actor.userId,baselineIds:[...new Set(snap.all.map(row=>row.id).filter(id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)))],targetUuid:target,browserSession};
    const observer=await observeNativePending(p,{conversationId:e.conversationId,selfUserId:actor.userId,text,baselineIds:evidence.baselineIds,startedAt:Date.now(),key:'__rolePending_'+randomUUID().replace(/-/g,'')});
    try{
     attempt!.beforeIntent();journal.intent(requestId,'dm',handle,e.conversationId,text,evidence);attempt!.setStage('submit-click');await submit.click({timeout:15000});
     for(let count=0;count<15;count++){
      const state=await observer.read();if(state?.conflict){journal.nativePendingConflict(requestId);throw new Error('本次出现多个本地待发送消息，保持结果未知');}
      if(state?.pending.length===1){journal.bindNativePending(requestId,state.pending[0]);break;}
      await p.waitForTimeout(100);
     }
     await p.waitForTimeout(500);const stable=await observer.read();if(stable?.conflict){journal.nativePendingConflict(requestId);throw new Error('本次本地待发送消息出现冲突，保持结果未知');}
    }finally{await observer.dispose();}
   }else{
    attempt!.beforeIntent();journal.intent(requestId,'dm',handle,e.conversationId,text);attempt!.setStage('submit-click');
    await p.locator('[data-testid="dmComposerSendButton"]').click({timeout:15000});
   }
  }
  attempt!.setStage('receipt-read');await p.waitForTimeout(1500);
  const toast=await p.locator('[data-testid="toast"]').allTextContents();
  let r:Receipt=e.channel==='public'?matchTweetReceipt(responseRows,handle,text,target,journal.get(requestId)!.at):{status:'unknown'};
  if(r.status!=='confirmed')try{r=await lookup(e,text,requestId,handle);}catch{r={status:'unknown',reason:'尚未取得可靠回执，保持待回查'};}
  r=resolveSubmissionSignals(r,toastsBefore,toast);journal.settle(requestId,r);return r;
 }));
 app.post('/lookup-post',async(req,reply)=>task(req,reply,async()=>{const {text,requestId,handle}=req.body as any;const r=await lookupPost(text,requestId,handle);if(journal.get(requestId))journal.settle(requestId,r);return r;}));
 app.post('/post',async(req,reply)=>task(req,reply,async(attempt)=>{
  const {text,requestId,handle}=req.body as {text:string;requestId:string;handle:string};
  if(typeof text!=='string')throw new Error('出站正文格式无效');
  if(journal.get(requestId)){journal.intent(requestId,'post',handle,'',text);return lookupPost(text,requestId,handle);}
  const previous=preflight.get(requestId,'post',handle,'',text);if(previous)return previous;
  attempt!.setStage('editor-validate');const initialValidation=await validationFor(text,'post',handle);if(!initialValidation.allowed)return attempt!.block(initialValidation);
  attempt!.setStage('post-open');await navigate(publicPage,'https://x.com/compose/post');
  const composer=await waitForPublicPostComposer(publicPage);attempt!.setStage('post-fill');await composer.input.fill(text);
  attempt!.setStage('identity');await check(handle);if(mode!=='auto')throw new BrowserOperationError('control-unavailable','control');
  attempt!.setStage('editor-validate');const validation=await validationFor(text,'post',handle);if(!validation.allowed)return attempt!.block(validation);
  await waitForPublicPostComposer(publicPage,{requireSubmit:true,expectedText:text});
  const toastsBefore=await publicPage.getByTestId('toast').allTextContents();
  const finalComposer=await publicPostComposerLocators(publicPage,{requireSubmit:true,expectedText:text}),submit=await finalComposer.submit.elementHandle();
  if(!submit)throw new BrowserOperationError('editor-unavailable','editor-validate');
  try{
   attempt!.beforeIntent();journal.intent(requestId,'post',handle,'',text);attempt!.setStage('submit-click');
   const rows=await capture(publicPage,async()=>{await publicPostComposerLocators(publicPage,{requireSubmit:true,expectedText:text});if(!await submit.evaluate(button=>button.isConnected))throw new BrowserOperationError('editor-unavailable','submit-click');await submit.click({timeout:15000});});
   attempt!.setStage('receipt-read');const toast=await publicPage.getByTestId('toast').allTextContents();
   let r=matchTweetReceipt(rows,handle,text,null,journal.get(requestId)!.at);if(r.status!=='confirmed')try{r=await lookupPost(text,requestId,handle);}catch{r={status:'unknown',reason:'尚未取得可靠回执，保持待回查'};}
   return journal.settle(requestId,resolveSubmissionSignals(r,toastsBefore,toast));
  }finally{await submit.dispose().catch(()=>{});}
 }));
 app.setErrorHandler((err,req,reply)=>{const diagnostic=safeBrowserDiagnostic(err);reply.code(500).send({error:browserOperationReason(diagnostic.code),diagnostic,browserPaused:mode!=='auto',browserMode:mode});});
 app.addHook('onClose',async()=>{shuttingDown=true;await context.close().catch(()=>{});});
 await app.listen({port:Number(process.env.BROWSER_PORT||3001),host:'0.0.0.0'});
 process.on('SIGTERM',async()=>{await app.close();process.exit(0);});
 return {app,context};
}
if(process.argv[1]?.endsWith('/browser.js'))startBrowserServer().catch(e=>{console.error(redact(e));process.exit(1);});
