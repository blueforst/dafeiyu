import type {Page} from 'playwright-core';
import type {Receipt} from './types.js';
import {inspectPrivateConversation,type ChatObservedMessage} from './chat-dom.js';
import {readNativeRequestPrompt} from './xchat-inbox.js';
import {PrivateAcceptJournal,privateRequestFingerprint,type PrivateRequestCandidate,type PrivateRequestResult} from './private-requests.js';
import {nativeModelSnapshot} from './xchat-native.js';

export {readNativeComposer,nativeComposerLocators} from './xchat-composer.js';
import {readNativeComposer} from './xchat-composer.js';

export type NativeRequestActionInput={page:Page;candidate:PrivateRequestCandidate;handle:string;selfUserId:string;journal:PrivateAcceptJournal;deadline:number;navigate:(page:Page,url:string,deadline:number)=>Promise<void>;assertActor:()=>Promise<void>;lookupOnly?:boolean};
export async function acceptNativePrivateRequest(input:NativeRequestActionInput):Promise<PrivateRequestResult>{
 try{return await performNativePrivateRequest(input);}catch(error){
  if((error as any)?.restricted||['identity-unavailable','account-restricted','control-unavailable'].includes((error as any)?.code))throw error;
  const original=input.journal.get(input.handle,input.candidate.event.conversationId);
  return original||input.lookupOnly?{status:'unknown',reason:'原接受结果未确认，只回查，不重复点击'}:{status:'not_submitted',reason:'接受前界面检查未完成，未点击接受'};
 }
}
async function performNativePrivateRequest(input:NativeRequestActionInput):Promise<PrivateRequestResult>{
 const {page,candidate,handle,selfUserId,journal,deadline}=input,e=candidate.event,previous=journal.get(handle,e.conversationId);
 const unknown=(reason:string):PrivateRequestResult=>({status:'unknown',reason});
 let target:URL;try{target=new URL(candidate.url);}catch{return {status:'blocked',reason:'请求来源无效'};}
 if(target.origin!=='https://x.com'||target.search||target.hash||target.username||target.password||!['/i/chat/'+e.conversationId,'/i/chat/requests/'+e.conversationId,'/i/chat/requests/other/'+e.conversationId].includes(target.pathname)||e.accountId!==handle.toLowerCase()||e.privateContract!=='xchat-native-v2'||!['requests','other'].includes(candidate.source))return {status:'blocked',reason:'请求归属或契约无效'};
 if(previous&&previous.selfUserId!==selfUserId)return unknown('工作账号身份与原接受意图不符');
 await input.assertActor();await input.navigate(page,target.href,deadline);
 const inspect=()=>inspectPrivateConversation(page,e.conversationId,{deadline,selfUserId});
 const read=await inspect(),prompt=await readNativeRequestPrompt(page,e.conversationId),composer=await readNativeComposer(page,e.conversationId);
 const events=()=>read.events.map(event=>({...event,accountId:handle.toLowerCase(),...(prompt.peerHandle?{peerHandle:prompt.peerHandle}:{})}));
 if(composer.state==='ready'&&read.contract==='xchat-native-v2'){
  if(previous)journal.accepted(handle,e.conversationId);
  return {status:'accepted',reason:previous?'已核对原请求的接受结果':'平台会话已经允许回复，无需再次接受',events:events()};
 }
 if(previous)return unknown(previous.status==='accepted'?'已接受会话的界面状态发生变化，需要核对':'原接受意图结果尚未确认；只回查，不重复点击');
 if(input.lookupOnly)return unknown('缺少原接受意图，只允许人工核对，未重新接受');
 if(prompt.state!=='pending'||!prompt.peerHandle||prompt.peerHandle.toLowerCase()===handle.toLowerCase())return {status:'not_submitted',reason:'请求控件或对方身份尚未唯一绑定'};
 const latest=read.events.at(-1);if(!latest)return {status:'not_submitted',reason:'请求最新消息尚不具备可靠入站证据'};
 const actual:PrivateRequestCandidate={...candidate,event:{...latest,accountId:handle.toLowerCase()}};
 if(privateRequestFingerprint(actual,selfUserId)!==privateRequestFingerprint(candidate,selfUserId))return {status:'not_submitted',reason:'请求内容已更新，等待重新采集和过滤'};
 const button=page.locator('[data-testid="xchatEmbedRoute"] [data-testid="dm-conversation-panel"] [data-testid="dm-message-request-prompt"] [data-testid="dm-message-request-accept-button"]');
 if(await button.count()!==1||!await button.isVisible()||!await button.isEnabled())return {status:'not_submitted',reason:'请求接受控件当前不可用'};
 await input.assertActor();if(Date.now()>=deadline)return {status:'not_submitted',reason:'接受前处理预算已结束'};
 journal.plan(candidate,selfUserId);
 // 控制操作与本函数使用同一串行队列；持久意图之后的异常一律只回查。
 try{
  await input.assertActor();await button.click({timeout:Math.max(1,Math.min(10000,deadline-Date.now()))});
  for(let count=0;count<30&&Date.now()<deadline;count++){
   const state=await readNativeComposer(page,e.conversationId);
   if(state.state==='ready'){
    const accepted=await inspect();if(accepted.contract!=='xchat-native-v2'||!accepted.chatProtection.hasUnlockedSession)return unknown('接受后的原生会话证据仍需核对');
    await input.assertActor();journal.accepted(handle,e.conversationId);
    return {status:'accepted',reason:'正常的一对一请求已接受',events:accepted.events.map(event=>({...event,accountId:handle.toLowerCase(),peerHandle:prompt.peerHandle}))};
   }
   await page.waitForTimeout(Math.min(200,Math.max(1,deadline-Date.now())));
  }
 }catch(error){if((error as any)?.restricted||['identity-unavailable','account-restricted','control-unavailable'].includes((error as any)?.code))throw error;return unknown('接受请求后未取得可靠确认，只回查，不重复点击');}
 return unknown('接受结果仍待平台确认，只回查，不重复点击');
}

export type NativeSubmitEvidence={contract:'xchat-native-v2';selfUserId:string;baselineIds:string[];targetUuid:string;browserSession:string;localPendingId?:string;pendingCreatedAt?:number;ambiguous?:boolean};
export function matchNativePrivateReceipt(rows:ChatObservedMessage[],text:string,evidence:NativeSubmitEvidence,since:number):Receipt{
 if(evidence.ambiguous)return {status:'unknown',reason:'原提交观察到多个本地待发送消息，保留冲突，只允许人工核对'};
 if(!evidence.localPendingId||!evidence.pendingCreatedAt||evidence.baselineIds.includes(evidence.localPendingId))return {status:'unknown',reason:'原意图尚无持久绑定的本地待发送消息 ID，不能按同文猜测成功'};
 const matches=rows.filter(row=>row.contract==='xchat-native-v2'&&row.id===evidence.localPendingId&&row.direction==='out'&&row.senderId===evidence.selfUserId&&row.timestampReliable&&row.timestamp>=since-1000&&row.text===text&&/^\d{1,25}$/.test(row.nativeSequence??'')&&BigInt(row.nativeSequence!)>0n&&row.blockedCodes.length===0);
 return matches.length===1?{status:'confirmed',id:matches[0].id,nativeSequence:matches[0].nativeSequence}:{status:'unknown',reason:'本次待发送 ID 尚未取得唯一的原生平台确认'};
}

/** 只观察本地 Pending→Sent；其他客户端同步的 Sent 不会被认领成本次提交。 */
export async function observeNativePending(page:Page,input:{conversationId:string;selfUserId:string;text:string;baselineIds:string[];startedAt:number;key:string}){
 const script='mw:('+function(args:any,readSnapshot:any){
  const global=globalThis as any;if(Object.hasOwn(global,args.key))throw Error('observer key collision');
  const host=document.querySelector('[data-testid="xchatEmbedRoute"]');if(!host?.shadowRoot)throw Error('native host unavailable');
  const state={pending:[] as Array<{id:string;createdAt:number}>,conflict:false,scans:0},seen=new Set<string>(args.baselineIds);let queued=false;
  const scan=()=>{queued=false;if(++state.scans>100||Date.now()-args.startedAt>15000)return;
   const snapshot=readSnapshot({conversationId:args.conversationId});if(!snapshot.validLocation||!snapshot.ready)return;
   for(const p of snapshot.proofs){
    if(!p.fiberBound||!p.oneToOne||p.contentType!=='PendingMessageTextOnly'||p.senderId!==args.selfUserId||p.fullText!==args.text||p.textContent!==args.text||seen.has(p.id)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(p.id))continue;
    if(!/^\d{10}$/.test(p.seconds)||!Number.isInteger(p.nanos)||p.nanos<0||p.nanos>=1e9)continue;
    const createdAt=Number(p.seconds)*1000+Math.floor(p.nanos/1e6);if(createdAt<args.startedAt-1000||createdAt>Date.now()+60000)continue;
    const row=host.shadowRoot!.querySelector('[data-dm-message-row="'+p.id+'"]'),body=row?.querySelectorAll('[data-testid="message-text-'+p.id+'"] span[dir="auto"]');
    if(!body||body.length!==1||((body[0] as HTMLElement).innerText!==args.text&&p.renderedText!==args.text))continue;
    seen.add(p.id);state.pending.push({id:p.id,createdAt});if(state.pending.length>1){state.conflict=true;state.pending=state.pending.slice(0,2);}
   }
  };
  const observer=new MutationObserver(()=>{if(!queued){queued=true;queueMicrotask(scan);}});
  observer.observe(host.shadowRoot,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-send-status','data-dm-message-row']});
  global[args.key]={state,observer};return true;
 }.toString()+')('+JSON.stringify(input)+','+nativeModelSnapshot.toString()+')';
 await page.evaluate(script);
 const read=async()=>page.evaluate('mw:('+function(key:string){const value=(globalThis as any)[key];return value?{pending:value.state.pending,conflict:value.state.conflict}:null;}.toString()+')('+JSON.stringify(input.key)+')') as Promise<{pending:Array<{id:string;createdAt:number}>;conflict:boolean}|null>;
 const dispose=async()=>{await page.evaluate('mw:('+function(key:string){const global=globalThis as any;global[key]?.observer.disconnect();delete global[key];return true;}.toString()+')('+JSON.stringify(input.key)+')').catch(()=>{});};
 return {read,dispose};
}
