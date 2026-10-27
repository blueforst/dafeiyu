import Fastify from 'fastify';
import twitterText from 'twitter-text';
import { type BrowserContext, type Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher.js';
import { readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,fsyncSync } from 'node:fs';
import { createHash,timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { readSecret,redact } from './config.js';
import type { Event,Identity,Receipt } from './types.js';
import { validatePostingText,type PostingValidation } from './posting-policy.js';
import { BrowserPostingCapabilities } from './posting-capabilities.js';
import { BrowserResourceGuard,detectAccountRestriction,classifyPlatformRejection,healthSettings,type ComplianceObservation } from './unattended-health.js';
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
}
export function platformId(e:Event):string {
 const id=e.platformId||(e.channel==='public'?new URL(e.url).pathname.match(/\/status\/(\d+)$/)?.[1]:'');
 if(!id||e.channel==='public'&&!/^\d+$/.test(id))throw new Error('消息缺少可靠平台 ID');
 return id;
}
type Intent={kind:'reply'|'dm'|'post';handle:string;targetId:string;textHash:string;at:number;receipt:Receipt};
// 浏览器与 app 使用同一出站 ID；unknown 永不被有界清理丢弃。
export class TransportJournal {
 entries:Record<string,Intent>=Object.create(null);
 constructor(public path:string){try{const raw=JSON.parse(readFileSync(path,'utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid journal');for(const [id,value] of Object.entries(raw)){const x=value as any;if(x&&x.receipt&&['confirmed','unknown','rejected'].includes(x.receipt.status)&&typeof x.textHash==='string'&&typeof x.handle==='string'&&typeof x.targetId==='string'&&Number.isFinite(x.at)&&['reply','dm','post'].includes(x.kind))this.entries[id]=x;else if(['confirmed','unknown','rejected'].includes(x?.status))this.entries[id]={kind:'reply',handle:'',targetId:'',textHash:'',at:0,receipt:x};else throw new Error('invalid journal entry');}}catch(e:any){if(e?.code!=='ENOENT')throw new Error('浏览器发送日志损坏，停止自动发送');}}
 get(id:string){return Object.hasOwn(this.entries,id)?this.entries[id]:undefined;}
 intent(id:string,kind:Intent['kind'],handle:string,targetId:string,text:string):Intent {
  if(!/^[A-Za-z0-9:_-]{1,250}$/.test(id)||!handle||!text.trim())throw new Error('发送意图无效');
  const old=this.get(id);
  if(old){if(old.textHash&&(old.textHash!==hash(text)||old.handle!==handle.toLowerCase()||old.targetId!==targetId||old.kind!==kind))throw new Error('出站标识已使用，正文或目标不能改变');return old;}
  const next:Intent={kind,handle:handle.toLowerCase(),targetId,textHash:hash(text),at:Date.now(),receipt:{status:'unknown',reason:'已保存提交意图，尚未取得唯一平台回执'}};
  this.entries[id]=next;this.save();return next;
 }
 settle(id:string,r:Receipt){if(r.status==='not_submitted')throw new Error('提交意图已存在，不能改记为未提交');const entry=this.get(id);if(!entry)throw new Error('发送意图不存在');if(entry.receipt.status==='confirmed'||entry.receipt.status==='rejected')return entry.receipt;if(r.status==='confirmed'&&!r.id)r={status:'unknown',reason:'缺少唯一平台回执 ID'};entry.receipt=r;this.save();return r;}
 save(){const entries=Object.entries(this.entries);const uncertain=entries.filter(([,x])=>x.receipt.status==='unknown');const finished=entries.filter(([,x])=>x.receipt.status!=='unknown').slice(-2000);this.entries=Object.assign(Object.create(null),Object.fromEntries([...finished,...uncertain]));writeFileSync(this.path+'.tmp',JSON.stringify(this.entries),{mode:0o600});renameSync(this.path+'.tmp',this.path);}
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
  const receipt:Receipt={status:'not_submitted',reason:validation.reason,validation};
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
  const cloned=document.body.cloneNode(true) as HTMLElement;cloned.querySelectorAll('article,[data-testid="messageEntry"],[data-testid="tweetText"],[data-testid="UserDescription"],[data-testid="UserName"]').forEach(node=>node.remove());
  const text=cloned.innerText||cloned.textContent||'';
  const needsHuman=/verify (your|you are)|unusual activity|authenticate your|enter (your )?passcode|unlock your|验证你的身份|输入.*密码锁|解锁.*聊天/i.test(text)||/challenge|account\/access/.test(location.pathname);
  return {handle,loggedIn:!!handle,needsHuman,pageText:text,ownAccount:!!handle,url:location.href,reason:needsHuman?'页面需要人工验证或解锁':!handle?'尚未登录或页面结构需要适配':undefined};
 });const restricted=detectAccountRestriction({url:result.url,text:result.pageText,ownAccount:result.ownAccount});
 const {pageText,ownAccount,url,...safe}=result;return {...safe,...(restricted?{restricted,reason:'当前工作账号受限：'+restricted}:{})};
}
export async function readTweets(page:Page):Promise<Event[]> {
 const rows=await page.locator('article[data-testid="tweet"]').evaluateAll(articles=>articles.slice(0,60).map(a=>{
  const owned=(node:Element)=>node.closest('article[data-testid="tweet"]')===a&&!node.closest('[data-testid="quoteTweet"],[data-testid="card.wrapper"],div[role="link"]');
  const time=Array.from(a.querySelectorAll('time')).find(owned);
  const link=time?.closest('a') as HTMLAnchorElement|null;
  const match=link?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
  if(!match)return null;
  const text=(Array.from(a.querySelectorAll('[data-testid="tweetText"]')).find(owned) as HTMLElement|undefined)?.innerText||'';
  const parsed=Date.parse(time?.getAttribute('datetime')||'');const reliable=Number.isFinite(parsed)&&parsed>0;
  return {id:'x:'+match[2],platformId:match[2],targetId:match[2],channel:'public' as const,userId:'x:'+match[1].toLowerCase(),handle:match[1],text,url:'https://x.com/'+match[1]+'/status/'+match[2],conversationId:match[2],timestamp:reliable?parsed:0,timestampReliable:reliable,mediaUnavailable:!!a.querySelector('[data-testid="tweetPhoto"],video')};
 }).filter(Boolean));
 return rows as Event[];
}
export async function replyArticleIndex(page:Page,target:string):Promise<number> {
 const indexes=await page.locator('article[data-testid="tweet"]').evaluateAll((nodes,id)=>nodes.slice(0,60).flatMap((a,index)=>{
  const time=Array.from(a.querySelectorAll('time')).find(t=>t.closest('article[data-testid="tweet"]')===a&&!t.closest('[data-testid="quoteTweet"],[data-testid="card.wrapper"],div[role="link"]'));
  return time?.closest('a')?.getAttribute('href')?.match(/\/status\/(\d+)$/)?.[1]===id?[index]:[];
 }),target);
 if(indexes.length!==1)throw new Error('无法唯一定位要回复的主帖');return indexes[0];
}
export async function readDM(page:Page,conversationId:string):Promise<{events:Event[];all:any[]}> {
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
 return {events,all};
}
export type CollectionBudgetInput={page:Page;handle:string;deadline:number;navigate:(page:Page,url:string,deadline:number)=>Promise<void>;now?:()=>number};
function collected(events:Event[],warnings:string[],handle:string){return {events:[...new Map(events.map(e=>[e.channel+':'+e.platformId,{...e,accountId:handle.toLowerCase()}])).values()],warnings};}

export async function collectPublicWithBudget(input:CollectionBudgetInput&{source:number}){
  const {page:publicPage,handle,deadline,navigate,source}=input,now=input.now??Date.now;const expired=()=>now()>=deadline;
  const events:Event[]=[],warnings:string[]=[];
  const url=source===0?'https://x.com/notifications/mentions':source===1?'https://x.com/search?q='+encodeURIComponent('@'+handle)+'&f=live':'https://x.com/'+handle;
  if(expired())return collected(events,['公开采集时间预算已用完'],handle);
  try{await navigate(publicPage,url,deadline);}catch(error){if((error as any)?.restricted)throw error;return collected(events,['公开采集未完成：'+redact(error)],handle);}
  await publicPage.locator('article[data-testid="tweet"]').first().waitFor({timeout:Math.max(1,Math.min(10000,deadline-now()))}).catch(()=>{});
  if(expired())return collected(events,['公开采集时间预算已用完，保留已采集消息'],handle);
  const initial=await readTweets(publicPage);
  if(!initial.length){const body=await publicPage.locator('main').innerText().catch(()=>'');if(!/no (notifications|results|posts)|nothing to see|没有.*(通知|结果|帖子)|暂无|尚无/i.test(body))warnings.push('公开页面没有可可靠解析的帖子；可能为空、加载失败或结构需要适配');}
  if(source===2){
   const own=initial.filter(e=>e.handle.toLowerCase()===handle.toLowerCase()).slice(0,2);
   for(const post of own){if(expired()){warnings.push('公开采集时间预算已用完，保留已采集消息');break;}try{await navigate(publicPage,post.url,deadline);events.push(...(await readTweets(publicPage)).filter(e=>e.handle.toLowerCase()!==handle.toLowerCase()));}catch(error){if((error as any)?.restricted)throw error;warnings.push('公开采集未完成：'+redact(error));break;}}
  }else events.push(...initial.filter(e=>e.handle.toLowerCase()!==handle.toLowerCase()));
  return collected(events,warnings,handle);
 }

export async function collectPrivateWithBudget(input:CollectionBudgetInput){
  const {page:p,handle,deadline,navigate}=input,now=input.now??Date.now;const expired=()=>now()>=deadline;
  const events:Event[]=[],warnings:string[]=[];
  try{
   const links:string[]=[];
   for(const inbox of ['https://x.com/messages','https://x.com/messages/requests']){
    if(expired()){warnings.push('私信采集时间预算已用完，保留已采集消息');break;}await navigate(p,inbox,deadline);
    links.push(...await p.locator('a[href^="/messages/"],a[href^="/i/chat/"]').evaluateAll(as=>as.map(a=>a.getAttribute('href')||'').filter(h=>/^\/(messages\/[\d-]+|i\/chat\/[a-zA-Z0-9_-]+)$/.test(h)).slice(0,3)));
   }
   if(!links.length)warnings.push('私信列表暂无可识别会话；新版 Chat 或加密会话需人工确认');
   for(const link of [...new Set(links)].slice(0,6)){if(expired()){warnings.push('私信采集时间预算已用完，保留已采集消息');break;}try{await navigate(p,'https://x.com'+link,deadline);const conversationId=link.split('/').at(-1)!;events.push(...(await readDM(p,conversationId)).events);}catch(err){if((err as any)?.restricted)throw err;warnings.push('会话适配：'+redact(err));}}
  }catch(err){if((err as any)?.restricted)throw err;warnings.push('私信采集：'+redact(err));}
  return collected(events,warnings,handle);
 }

/** 仅访问自己的资料及页面提供的通知设置链接；不点击任何开关。 */
export async function readCompliance(page:Page,handle:string,navigate:(page:Page,url:string)=>Promise<void>):Promise<ComplianceObservation>{
 const result:ComplianceObservation={accountId:handle.toLowerCase(),profileReliable:false,automatedLabel:null,qualityFilter:null,reasons:[]};
 await navigate(page,'https://x.com/'+handle);
 const profile=await page.evaluate(()=>{const main=document.querySelector('main');const name=main?.querySelector('[data-testid="UserName"]') as HTMLElement|null;const bio=main?.querySelector('[data-testid="UserDescription"]') as HTMLElement|null;const text=(main as HTMLElement|null)?.innerText??'';return {name:name?.innerText??'',bio:bio?.innerText??'',reliable:!!name&&!!main,label:/\bAutomated by\s+@|由\s*@[^\s]+\s*自动/i.test(text)};});
 result.profileReliable=profile.reliable;result.name=profile.name;result.bio=profile.bio;result.automatedLabel=profile.reliable?profile.label:null;if(!profile.reliable)result.reasons!.push('自己的资料页结构无法可靠解析');
 await navigate(page,'https://x.com/settings/notifications');
 const filterLink=await page.locator('main a[href]').evaluateAll(nodes=>{const a=nodes.find(node=>/^(Filters|过滤|筛选)$/i.test((node.textContent??'').trim()));const href=a?.getAttribute('href');return href&&/^\/settings\/notifications(?:\/|$)/.test(href)?href:null;});
 if(filterLink)await navigate(page,'https://x.com'+filterLink);
 result.qualityFilter=await page.evaluate(()=>{const candidates=Array.from(document.querySelectorAll('main [role="switch"],main input[type="checkbox"]')).filter(node=>{const id=node.getAttribute('id'),label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]'):null;const text=(node.getAttribute('aria-label')??'')+' '+(label?.textContent??'')+' '+(node.closest('label')?.textContent??'');return /quality filter|质量过滤|优质内容过滤/i.test(text);});if(candidates.length!==1)return null;const node=candidates[0];if(node instanceof HTMLInputElement)return node.checked;const checked=node.getAttribute('aria-checked');return checked==='true'?true:checked==='false'?false:null;});
 if(result.qualityFilter===null)result.reasons!.push('通知质量过滤开关无法可靠确认');return result;
}
export async function startBrowserServer(){
 const secret=readSecret('browser_key');if(!secret)throw new Error('缺少浏览器内部凭据');
 const profile=process.env.PROFILE_DIR||'/profile';mkdirSync(profile,{recursive:true});
 let shuttingDown=false,internalRestart=false;
 let mode='paused',effectiveHealth=healthSettings();const serial=new Serial();let round=0;let context:BrowserContext;
 const journal=new TransportJournal(profile+'/transport-journal.json');
 const preflight=new PreflightJournal(profile+'/posting-preflight-v1.json');const capabilities=new BrowserPostingCapabilities();
 const proxy=browserProxy(process.env.BROWSER_PROXY_SERVER);
 context=await launchBrowser(profile,proxy);
 function supervise(){context.on('close',()=>{if(shuttingDown||internalRestart)return;console.error('浏览器上下文关闭，交由监督器恢复');process.exit(1);});}supervise();
 let publicPage=context.pages()[0]||await context.newPage();
 await publicPage.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
 let dmPage:Page|undefined;
 const resourceGuard=new BrowserResourceGuard({settings:()=>effectiveHealth,identity:()=>identity(publicPage),restart:async()=>{
  internalRestart=true;try{await context.close();context=await launchBrowser(profile,proxy);supervise();publicPage=context.pages()[0]||await context.newPage();dmPage=undefined;capabilities.invalidate('浏览器上下文重启，旧能力证据失效');await publicPage.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000});return await identity(publicPage);}finally{internalRestart=false;}
 },onRestart:info=>{console.log(JSON.stringify({event:'browser-restart',...info}));}});
 let timeoutPreviousMode='paused';
 async function operationTimeout(){timeoutPreviousMode=mode;mode='paused';capabilities.invalidate('浏览器操作超时');const pages=context.pages();await Promise.allSettled(pages.map(p=>p.close()));}
 async function recoverTimedOutPages(){publicPage=await context.newPage();dmPage=undefined;await publicPage.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000});const current=await identity(publicPage);if(current.loggedIn&&!current.needsHuman&&!current.restricted)mode=timeoutPreviousMode;}
 async function check(handle:string){const i=await identity(publicPage);capabilities.observe(i);if((i as any).restricted){mode='paused';throw Object.assign(new Error('当前工作账号受限：'+(i as any).restricted),{restricted:(i as any).restricted});}if(!i.loggedIn||i.needsHuman||i.handle.toLowerCase()!==handle.toLowerCase())throw new Error('账号未登录、身份不符或需要人工验证');}
 async function navigate(p:Page,url:string,deadline=Date.now()+45000){const remaining=()=>Math.max(1,Math.min(30000,deadline-Date.now()));if(Date.now()>=deadline)throw new Error('采集时间预算已用完');await p.goto(url,{waitUntil:'domcontentloaded',timeout:remaining()});await p.locator('main').waitFor({timeout:Math.min(12000,remaining())}).catch(()=>{});const state=await identity(p);if((state as any).restricted){mode='paused';throw Object.assign(new Error('当前工作账号受限：'+(state as any).restricted),{restricted:(state as any).restricted});}}
 async function getDM(){if(!dmPage||dmPage.isClosed())dmPage=await context.newPage();return dmPage;}
 async function eventContext(e:Event){
  safeEvent(e);
  if(e.channel==='public'){await navigate(publicPage,e.url);return JSON.stringify((await readTweets(publicPage)).slice(0,12));}
  const p=await getDM();await navigate(p,e.url);return JSON.stringify((await readDM(p,e.conversationId)).all);
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
   const p=await getDM();await navigate(p,e.url);const {all}=await readDM(p,e.conversationId);
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
 app.get('/identity',async()=>{if(publicPage.isClosed()){const replacement=context.pages().find(p=>p.url().startsWith('https://x.com/'));if(replacement)publicPage=replacement;else return {handle:'',loggedIn:false,needsHuman:true,reason:'请人工打开 X 页面'};}return identity(publicPage);});
 app.post('/control',async(req,reply)=>{
  const next=(req.body as any)?.mode;if(!['manual','paused','auto'].includes(next))return reply.code(400).send({error:'控制模式无效'});
  return serial.run(async()=>{
   if(mode==='manual'&&next!=='manual')await exec('x11vnc',['-display',process.env.DISPLAY||':99','-R','disconnect:all'],{timeout:5000});
   if(mode==='manual'&&next!=='manual')capabilities.invalidate('人工接管已释放，旧能力证据失效');mode=next;return {mode};
  });
 });
 function requestHealth(req:any){return healthSettings(req.body?.runtimeHealth??effectiveHealth);}
 app.post('/compliance',async(req,reply)=>serial.run(async()=>{
  effectiveHealth=requestHealth(req);
  if(mode==='manual')return reply.code(409).send({error:'人工接管期间不能执行账号检查'});
  const handle=String((req.body as any)?.handle??'').replace(/^@/,'').toLowerCase();if(!/^[a-z0-9_]{1,15}$/.test(handle))return reply.code(400).send({error:'工作账号无效'});
  try{await resourceGuard.before('compliance',mode,handle);await check(handle);const result=await readCompliance(publicPage,handle,navigate);await check(handle);return result;}catch(error){if((error as any)?.code==='browser-recovery-failed')mode='paused';return reply.code(409).send({error:redact(error),browserPaused:mode!=='auto',browserMode:mode});}
 },{timeoutMs:requestHealth(req).rpcTimeoutSeconds*1000,onTimeout:operationTimeout,afterTimeout:recoverTimedOutPages}));
 app.post('/capabilities',async(_req,reply)=>serial.run(async()=>{
  if(mode==='manual')return reply.code(409).send({error:'人工接管期间不能读取当前页面能力'});
  return capabilities.observe(await identity(publicPage));
 }));
 async function validationFor(text:string,operation:'reply'|'post'|'dm',handle:string){
  const snapshot=capabilities.observe(await identity(publicPage));
  return validatePostingText(text,operation,{accountId:handle,capability:operation==='dm'?undefined:snapshot[operation],sessionId:snapshot.sessionId});
 }
 async function task(req:any,reply:any,fn:()=>Promise<unknown>){
  return serial.run(async()=>{
   effectiveHealth=requestHealth(req);
   if(mode!=='auto')return reply.code(409).send({error:'浏览器已暂停或正在人工接管',browserPaused:true,browserMode:mode});
   try{const operation=String(req.url).split('?')[0].slice(1);await resourceGuard.before(operation==='lookup-post'?'lookupPost':operation,mode,req.body.handle);await check(req.body.handle);return await fn();}catch(err){if((err as any)?.code==='browser-recovery-failed')mode='paused';return reply.code(409).send({error:redact(err),browserPaused:mode!=='auto',browserMode:mode,...((err as any)?.restricted?{restricted:(err as any).restricted}:{})});}
  },{timeoutMs:requestHealth(req).rpcTimeoutSeconds*1000,onTimeout:operationTimeout,afterTimeout:recoverTimedOutPages});
 }
 async function collectPublic(handle:string,requestedDeadline?:number){
  const deadline=Math.min(Date.now()+effectiveHealth.publicCollectionSeconds*1000,Number.isFinite(requestedDeadline)?requestedDeadline!:Infinity);
  return collectPublicWithBudget({page:publicPage,handle,deadline,navigate,source:round++%3});
 }
 async function collectPrivate(handle:string,requestedDeadline?:number){
  const deadline=Math.min(Date.now()+effectiveHealth.privateCollectionSeconds*1000,Number.isFinite(requestedDeadline)?requestedDeadline!:Infinity);
  try{return await collectPrivateWithBudget({page:await getDM(),handle,deadline,navigate});}catch(error){if((error as any)?.restricted)throw error;return collected([],['私信采集：'+redact(error)],handle);}
 }
 app.post('/collect/public',async(req,reply)=>task(req,reply,()=>collectPublic((req.body as any).handle,(req.body as any).deadline)));
 app.post('/collect/private',async(req,reply)=>task(req,reply,()=>collectPrivate((req.body as any).handle,(req.body as any).deadline)));
 app.post('/collect',async(req,reply)=>task(req,reply,async()=>{
  const {handle}=req.body as {handle:string};const publicResult=await collectPublic(handle);await check(handle);const privateResult=await collectPrivate(handle);
  return collected([...publicResult.events,...privateResult.events],[...publicResult.warnings,...privateResult.warnings],handle);
 }));
 app.post('/context',async(req,reply)=>task(req,reply,async()=>({text:await eventContext((req.body as any).event)})));
 app.post('/lookup',async(req,reply)=>task(req,reply,async()=>{const {event,text,requestId,handle}=req.body as any;const r=await lookup(event,text,requestId||event.outboxId||event.id,handle);if(journal.get(requestId||event.outboxId||event.id))journal.settle(requestId||event.outboxId||event.id,r);return r;}));
 app.post('/send',async(req,reply)=>task(req,reply,async()=>{
  const {event:e,text,requestId,handle}=req.body as {event:Event;text:string;requestId:string;handle:string};
  safeEvent(e);if(typeof text!=='string')throw new Error('出站正文格式无效');if(requestId!==(e.outboxId||e.id)||e.timestampReliable===false||!Number.isFinite(e.timestamp)||e.timestamp<=0)throw new Error('发送参数或可靠时间无效');
  const target=platformId(e);
  if(e.channel==='public'&&new URL(e.url).pathname.split('/').at(-1)!==target)throw new Error('平台消息 ID 与目标地址不符');
  if(journal.get(requestId)){journal.intent(requestId,e.channel==='public'?'reply':'dm',handle,e.channel==='public'?target:e.conversationId,text);return lookup(e,text,requestId,handle);}
  const kind=e.channel==='public'?'reply':'dm',destination=e.channel==='public'?target:e.conversationId;
  const previous=preflight.get(requestId,kind,handle,destination,text);if(previous)return previous;
  const initialValidation=await validationFor(text,kind,handle);if(!initialValidation.allowed)return preflight.block(requestId,kind,handle,destination,text,initialValidation);
  await eventContext(e);let p=publicPage;
  let responseRows:PlatformTweet[]=[],toastsBefore:string[]=[];
  if(e.channel==='public'){
   const article=p.locator('article[data-testid="tweet"]').nth(await replyArticleIndex(p,target));
   await article.getByTestId('reply').click();
   const dialog=p.getByRole('dialog');await dialog.getByTestId('tweetTextarea_0').fill(text);
   await check(handle);if(mode!=='auto')throw new Error('提交前控制状态已变化');
   const validation=await validationFor(text,'reply',handle);if(!validation.allowed)return preflight.block(requestId,'reply',handle,target,text,validation);
   const submit=dialog.getByTestId('tweetButton');if(await submit.count()!==1||!await submit.isEnabled())return preflight.block(requestId,'reply',handle,target,text,{...validation,allowed:false,code:'editor-unavailable',reason:'编辑器未允许提交，未保存提交意图'});
   toastsBefore=await p.getByTestId('toast').allTextContents();
   journal.intent(requestId,'reply',handle,target,text);
   responseRows=await capture(p,async()=>{await dialog.getByTestId('tweetButton').click({timeout:15000});});
  }else{
   p=await getDM();const snap=await readDM(p,e.conversationId);
   if(snap.events.at(-1)?.platformId!==target)throw new Error('私信上下文已变化，停止发送');
   const input=p.locator('[data-testid="dmComposerTextInput"]');if(await input.count()!==1)throw new Error('当前私信输入框尚未适配');
   await input.fill(text);
   await check(handle);if(mode!=='auto')throw new Error('提交前控制状态已变化');
   if((await readDM(p,e.conversationId)).events.at(-1)?.platformId!==target)throw new Error('提交前私信已有新消息，停止旧上下文回复');
   toastsBefore=await p.getByTestId('toast').allTextContents();
   journal.intent(requestId,'dm',handle,e.conversationId,text);
   await p.locator('[data-testid="dmComposerSendButton"]').click({timeout:15000});
  }
  await p.waitForTimeout(1500);
  const toast=await p.locator('[data-testid="toast"]').allTextContents();
  let r:Receipt=e.channel==='public'?matchTweetReceipt(responseRows,handle,text,target,journal.get(requestId)!.at):{status:'unknown'};
  if(r.status!=='confirmed')try{r=await lookup(e,text,requestId,handle);}catch{r={status:'unknown',reason:'尚未取得可靠回执，保持待回查'};}
  r=resolveSubmissionSignals(r,toastsBefore,toast);journal.settle(requestId,r);return r;
 }));
 app.post('/lookup-post',async(req,reply)=>task(req,reply,async()=>{const {text,requestId,handle}=req.body as any;const r=await lookupPost(text,requestId,handle);if(journal.get(requestId))journal.settle(requestId,r);return r;}));
 app.post('/post',async(req,reply)=>task(req,reply,async()=>{
  const {text,requestId,handle}=req.body as {text:string;requestId:string;handle:string};
  if(typeof text!=='string')throw new Error('出站正文格式无效');
  if(journal.get(requestId)){journal.intent(requestId,'post',handle,'',text);return lookupPost(text,requestId,handle);}
  const previous=preflight.get(requestId,'post',handle,'',text);if(previous)return previous;
  const initialValidation=await validationFor(text,'post',handle);if(!initialValidation.allowed)return preflight.block(requestId,'post',handle,'',text,initialValidation);
  await navigate(publicPage,'https://x.com/compose/post');
  const input=publicPage.getByTestId('tweetTextarea_0');if(await input.count()!==1)throw new Error('无法唯一识别发帖输入框');await input.fill(text);
  await check(handle);if(mode!=='auto')throw new Error('提交前控制状态已变化');
  const validation=await validationFor(text,'post',handle);if(!validation.allowed)return preflight.block(requestId,'post',handle,'',text,validation);
  const submit=publicPage.getByTestId('tweetButton');if(await submit.count()!==1||!await submit.isEnabled())return preflight.block(requestId,'post',handle,'',text,{...validation,allowed:false,code:'editor-unavailable',reason:'编辑器未允许提交，未保存提交意图'});
  const toastsBefore=await publicPage.getByTestId('toast').allTextContents();
  journal.intent(requestId,'post',handle,'',text);
  const rows=await capture(publicPage,async()=>{const button=publicPage.getByTestId('tweetButton');if(await button.count()!==1)throw new Error('无法唯一识别发帖按钮');await button.click({timeout:15000});});
  const toast=await publicPage.getByTestId('toast').allTextContents();
  let r=matchTweetReceipt(rows,handle,text,null,journal.get(requestId)!.at);if(r.status!=='confirmed')try{r=await lookupPost(text,requestId,handle);}catch{r={status:'unknown',reason:'尚未取得可靠回执，保持待回查'};}
  return journal.settle(requestId,resolveSubmissionSignals(r,toastsBefore,toast));
 }));
 app.setErrorHandler((err,req,reply)=>reply.code(500).send({error:redact(err instanceof Error?err.message:err),browserPaused:mode!=='auto',browserMode:mode}));
 await app.listen({port:Number(process.env.BROWSER_PORT||3001),host:'0.0.0.0'});
 process.on('SIGTERM',async()=>{shuttingDown=true;await app.close();await context.close();process.exit(0);});
 return {app,context};
}
if(process.argv[1]?.endsWith('/browser.js'))startBrowserServer().catch(e=>{console.error(redact(e));process.exit(1);});
