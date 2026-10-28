import type { Page } from 'playwright-core';
import type { Event } from './types.js';
import type { CollectionDiagnostic,CollectionResult } from './collection-health.js';

/** 新 Chat 当前只读观察契约；没有可靠原生时间与接收端身份样本时不产生自动回复事件。 */
export const NATIVE_CHAT_CONTRACT='xchat-observation-v1';
export type ChatContract='legacy'|'xchat-observation-v1'|'unknown';
export type ChatDiagnosticStatus='ok'|'empty'|'partial'|'failed'|'unsupported'|'blocked'|'unknown';
export type ChatDiagnostic=CollectionDiagnostic&{channel:'private';source:'inbox'|'requests'|'conversation'|'chat';messageCount?:number};
export type ChatProtection={hasUnlockedSession:boolean;unlockPending:boolean;needsHuman:boolean};
export type ChatObservedMessage={id:string;text:string;direction:'in'|'out'|'unknown';timestamp:number;timestampReliable:boolean;media:boolean;contract:ChatContract;senderLabel?:string;displayTime?:string;dateBoundary?:string;sendStatus?:string;blockedCodes:string[]};
export type ChatInspection={ui?:PrivateUIReadiness;contract:ChatContract;conversationId:string;events:Event[];all:ChatObservedMessage[];diagnostics:ChatDiagnostic[];warnings:string[];chatProtection:ChatProtection};
export type PrivateInboxKind='inbox'|'requests'|'other';
export type PrivateConversationLink={conversationId:string;url:string;contract:'legacy'|'xchat-observation-v1';source:PrivateInboxKind};
export type PrivateInboxDiscovery={ui:PrivateUIReadiness;contract:ChatContract;conversations:PrivateConversationLink[];entries:Array<{kind:PrivateInboxKind;url:string}>;diagnostics:ChatDiagnostic[];warnings:string[];chatProtection:ChatProtection};
export type NativeChatRow={nativeId:string;testId:string;articleRole:string;focusTarget:string;contentTestId:string;contentLinked:boolean;bodyUnique:boolean;text:string;sender:string;senderLinked:boolean;displayTime:string;dateBoundary:string;sendStatus:string;media:boolean};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIRECT=/^\d+-\d+$/;
const diagnostic=(status:ChatDiagnosticStatus,code:string,source:ChatDiagnostic['source']='chat',eventCount=0,messageCount=0):ChatDiagnostic=>({channel:'private',status,code,source,eventCount,messageCount});
const noProtection=():ChatProtection=>({hasUnlockedSession:false,unlockPending:false,needsHuman:false});
const messages:Record<string,string>={
 'chat-native-observed':'已识别新 Chat 并读取原生消息；当前只观察，不自动回复。',
 'chat-native-time-unverified':'新 Chat 只提供尚未验收的显示时间，缺少可靠平台时间，未排入自动回复。',
 'chat-native-sender-unverified':'新 Chat 对方 sender 与参与者身份尚未验收，不能反推入站方向。',
 'chat-native-messages-unavailable':'新 Chat 消息区域尚未就绪或结构未知，不能把空结果认定为没有消息。',
 'chat-native-locked':'新 Chat 需要人工验证或解锁，未读取或处理私信。',
 'chat-native-shadow-unavailable':'新 Chat 的 ShadowRoot 无法可靠读取，未处理私信。',
 'chat-native-conversation-mismatch':'新 Chat 当前页面与待检查会话不符，未读取其他会话。',
 'chat-native-id-conflict':'新 Chat 原生消息标识或内容引用缺失／冲突，不能确认消息身份。',
 'chat-native-message-structure-unverified':'新 Chat 消息 article 角色或内容焦点目标未绑定当前原生 UUID，未读取正文。',
 'chat-native-body-unverified':'新 Chat 正文不是唯一的 dir=auto 子树，或正文为空／超出资源边界，未猜测正文。',
 'chat-inbox-entries-unverified':'新 Chat 列表存在未验收的会话结构，未猜测会话目标。',
 'chat-request-entry-missing':'新 Chat 当前页面没有提供可确认的消息请求入口；未猜测或点击其他入口。',
 'chat-other-entry-missing':'新 Chat 当前页面没有提供可确认的 Other 入口；未猜测或点击其他入口。',
 'private-legacy-readable':'已按原有私信契约读取消息。',
 'private-legacy-time-unverified':'原私信消息缺少可靠平台时间，未排入自动回复。',
 'private-legacy-direction-unverified':'原私信最新消息方向未知，未改选较早消息自动回复。',
 'private-legacy-id-missing':'原私信最新消息缺少稳定平台消息 ID，未自动回复。',
 'private-legacy-body-unverified':'原私信正文为空或超出资源边界，未自动处理。',
 'private-direct-unverified':'当前私信缺少可靠一对一会话标识，未处理消息。',
 'private-inbox-unverified':'私信列表未读到可靠会话且没有已验收的空状态，结果未知。',
 'private-navigation-failed':'私信页面读取失败，已保留此前取得的结果。',
 'private-collection-deadline':'私信采集时间预算已用完，已保留此前取得的结果。'
};
export function chatDiagnosticMessage(code:string):string{return messages[code]??'私信结构尚未验收，未自动处理。';}
function result(contract:ChatContract,conversationId:string,all:ChatObservedMessage[],diagnostics:ChatDiagnostic[],events:Event[]=[],chatProtection?:ChatProtection):ChatInspection{
 const protection=chatProtection??noProtection();
 return {contract,conversationId,events,all,diagnostics,warnings:[...new Set(diagnostics.filter(d=>!['ok','empty'].includes(d.status)).map(d=>chatDiagnosticMessage(d.code)))],chatProtection:protection};
}
function conversationPath(url:string,conversationId:string){try{const parsed=new URL(url);return parsed.origin==='https://x.com'&&parsed.pathname==='/i/chat/'+conversationId;}catch{return false;}}

export type PrivateUIKind='inbox'|'conversation';
export type PrivateUIState={state:'ready'|'empty'|'locked'|'loading'|'unsupported'|'unknown'|'wrong-location';code:string;contract:ChatContract;locationValid:boolean;nativeHosts:number;openShadowRoots:number;mainPresent:boolean;loading:boolean;loadingIndicators:number;lockInputs:number;emptyMarkers:number;conversationLinks:number;conversationLists:number;optionalEntries:number;validConversations:number;messageLogs:number;messageRows:number;legacyRows:number};
export type PrivateUIReadiness=PrivateUIState&{uiState:PrivateUIState['state'];samples:number;elapsedMs:number};
export type PrivateReadinessOptions={deadline?:number;now?:()=>number;sleep?:(milliseconds:number)=>Promise<void>;inspect?:(page:Page,expected:{kind:PrivateUIKind;conversationId?:string})=>Promise<PrivateUIState>;stableMs?:number;minimumObserveMs?:number;timeoutMs?:number;intervalMs?:number};

/** 仅返回结构计数。页面函数自包含，不读取正文、口令值或账号资料，也不操作任何控件。 */
export async function readPrivateUIState(page:Page,expected:{kind:PrivateUIKind;conversationId?:string}):Promise<PrivateUIState>{
 const snapshot=await page.evaluate(({kind,conversationId})=>{
  const path=location.pathname,origin=location.origin;
  const locationValid=origin==='https://x.com'&&(kind==='conversation'?!!conversationId&&['/i/chat/'+conversationId,'/messages/'+conversationId].includes(path):/^\/(?:i\/chat|messages)(?:\/(?:requests|other|\d+(?:-\d+)?))?\/?$/.test(path));
  const hosts=Array.from(document.querySelectorAll('[data-testid="xchatEmbedRoute"]')),host=hosts.length===1?hosts[0]:null,shadow=host?.shadowRoot;
  const scope:Document|ShadowRoot=shadow??document;
  const visible=(node:Element)=>{const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&!!node.getClientRects().length;};
  const outsideMessage=(node:Element)=>!node.closest('[data-dm-message-row],[data-testid="messageEntry"],article,[role="article"],[role="option"]');
  const elements=(selector:string)=>Array.from(scope.querySelectorAll(selector)).slice(0,200);
  const ui=(selector:string)=>elements(selector).filter(node=>outsideMessage(node)&&visible(node));
  const name=(node:Element)=>{
   const ids=(node.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean).slice(0,10),linked=ids.map(id=>scope.querySelector('#'+CSS.escape(id))?.textContent??'').join(' '),id=node.getAttribute('id');
   const label=id?scope.querySelector('label[for="'+CSS.escape(id)+'"]')?.textContent??'':'';
   return [node.getAttribute('aria-label')??'',linked,label,node.closest('label')?.textContent??'',node.getAttribute('placeholder')??''].join(' ');
  };
  // 必须存在可见的专用口令控件；普通消息或提示文字中的“PIN/密码”不是锁定证据。
  const lockInputs=shadow?ui('input').filter(node=>{
   const input=node as HTMLInputElement;if(input.type==='password')return true;
   // 数值及一次性口令以页面声明的原生属性和关联名称共同确认。
   const autocomplete=(node.getAttribute('autocomplete')??'').trim().toLowerCase(),inputMode=(node.getAttribute('inputmode')??'').trim().toLowerCase();
   return (autocomplete==='one-time-code'||inputMode==='numeric')&&/\b(?:passcode|pin|password)\b|口令|密码|密碼|解锁码/i.test(name(node));
  }).length:0;
  const loadingIndicators=ui('[role="progressbar"],[data-testid="spinner"],[data-testid="loading"],[aria-busy="true"]').length,loading=loadingIndicators>0;
  const listSelector='[role="listbox"][aria-label="Conversations"]',logSelector='[role="log"][aria-label="Messages"][data-testid="dm-message-scroller"]';
  const conversationLists=elements(listSelector).length,messageLogs=elements(logSelector).length;
  const inboxEmpty=/^(?:no conversations(?: yet)?|no messages(?: yet)?|no message requests|you (?:do not|don.t) have any (?:messages|message requests)(?: yet)?|暂无(?:任何)?(?:会话|消息|私信|消息请求)|没有(?:任何)?(?:会话|消息|私信|消息请求))[.!。！]?$/i;
  const conversationEmpty=/^(?:no messages(?: yet)?|you (?:do not|don.t) have any messages(?: yet)?|暂无(?:任何)?(?:消息|私信)|没有(?:任何)?(?:消息|私信))[.!。！]?$/i;
  const emptyMarkers=ui('[data-testid="emptyState"]').filter(node=>{
   const text=((node as HTMLElement).innerText||node.textContent||'').trim().replace(/\s+/g,' ');
   return kind==='conversation'?messageLogs===1&&!!node.closest(logSelector)&&conversationEmpty.test(text):conversationLists===1&&!!node.closest('main')&&!node.closest(logSelector)&&inboxEmpty.test(text);
  }).length;
  const pathOf=(node:Element)=>{try{const url=new URL(node.getAttribute('href')??'',location.origin);return url.origin==='https://x.com'&&!url.username&&!url.password?url.pathname:'';}catch{return '';}};
  const links=elements('a[href]'),nativeLinks=links.filter(node=>/^\/(?:i\/chat)\/\d+-\d+$/.test(pathOf(node)));
  const validConversations=nativeLinks.filter(node=>{
   const direct=pathOf(node).match(/^\/i\/chat\/(\d+)-(\d+)$/),item=node.parentElement?.getAttribute('data-testid')?.match(/^dm-conversation-item-(\d+):(\d+)$/),option=node.id.match(/^dm-conversation-option-(\d+):(\d+)$/);
   return !!direct&&!!item&&!!option&&node.getAttribute('role')==='option'&&node.closest('[role="listbox"]')?.getAttribute('aria-label')==='Conversations'&&direct[1]===item[1]&&direct[2]===item[2]&&direct[1]===option[1]&&direct[2]===option[2];
  }).length;
  const optionalEntries=links.filter(node=>['/messages/requests','/i/chat/requests','/i/chat/other'].includes(pathOf(node))).length;
  const legacyLinks=links.filter(node=>/^\/messages\/\d+(?:-\d+)?$/.test(pathOf(node))).length;
  const legacyRows=elements('[data-testid="messageEntry"]').length,messageRows=elements('[data-dm-message-row]').length;
  const nativeRoute=origin==='https://x.com'&&/^\/i\/chat(?:\/|$)/.test(path);
  const contract=hosts.length||nativeRoute?'xchat-observation-v1':legacyRows||legacyLinks?'legacy':'unknown';
  return {contract,locationValid,nativeHosts:hosts.length,openShadowRoots:hosts.filter(node=>!!node.shadowRoot).length,mainPresent:!!scope.querySelector('main'),loading,loadingIndicators,lockInputs,emptyMarkers,conversationLinks:contract==='xchat-observation-v1'?nativeLinks.length:legacyLinks,conversationLists,optionalEntries,validConversations:contract==='xchat-observation-v1'?validConversations:legacyLinks,messageLogs,messageRows,legacyRows};
 },expected);
 const value=snapshot as Omit<PrivateUIState,'state'|'code'>;
 let state:PrivateUIState['state']='unknown',code=expected.kind==='inbox'?'private-inbox-unverified':'chat-native-messages-unavailable';
 if(!value.locationValid){state='wrong-location';code='private-wrong-location';}
 else if(value.nativeHosts>1){state='unsupported';code='private-structure-unverified';}
 else if(value.contract===NATIVE_CHAT_CONTRACT&&(value.nativeHosts!==1||value.openShadowRoots!==1)){state='loading';code='private-page-loading';}
 else if(value.lockInputs){state='locked';code='chat-native-locked';}
 else if(value.loading){state='loading';code='private-page-loading';}
 else if(value.emptyMarkers===1&&(expected.kind==='conversation'||value.conversationLinks===0&&value.validConversations===0)&&value.messageRows===0&&value.legacyRows===0){state='empty';code=expected.kind==='inbox'?'private-inbox-empty':'chat-native-conversation-empty';}
 else if(expected.kind==='inbox'&&value.contract===NATIVE_CHAT_CONTRACT&&value.conversationLinks>0&&value.validConversations===0){state='unsupported';code='chat-inbox-entries-unverified';}
 else if(expected.kind==='inbox'&&value.validConversations>0){state='ready';code='private-inbox-ready';}
 else if(expected.kind==='conversation'&&(value.contract==='legacy'&&value.legacyRows>0||value.contract===NATIVE_CHAT_CONTRACT&&value.messageLogs===1&&value.messageRows>0)){state='ready';code=value.contract==='legacy'?'private-legacy-readable':'chat-native-messages-ready';}
 return {...value,state,code};
}
const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
/** 和采集共用截止时间；延迟挂载 ShadowRoot 不会被一次空查询提前判死。 */
export async function waitForPrivateUI(input:PrivateReadinessOptions&{page:Page;kind:PrivateUIKind;conversationId?:string}):Promise<PrivateUIReadiness>{
 const now=input.now??Date.now,sleep=input.sleep??(milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))),inspect=input.inspect??readPrivateUIState;
 const start=now(),wallStart=Date.now(),timeout=bounded(input.timeoutMs,8000,1,30000),interval=bounded(input.intervalMs,100,1,1000),stable=bounded(input.stableMs,400,0,5000),minimum=bounded(input.minimumObserveMs,600,0,10000),deadline=Math.min(input.deadline??Infinity,start+timeout);
 const blank:PrivateUIState={state:'loading',code:'private-page-loading',contract:'unknown',locationValid:false,nativeHosts:0,openShadowRoots:0,mainPresent:false,loading:false,loadingIndicators:0,lockInputs:0,emptyMarkers:0,conversationLinks:0,conversationLists:0,optionalEntries:0,validConversations:0,messageLogs:0,messageRows:0,legacyRows:0};
 let samples=0,last:PrivateUIState=blank,lastSignature='',stableAt=start,wallStableAt=wallStart,lastSettled=false,everNative=false;
 if(input.deadline!==undefined&&start>=input.deadline)return {...blank,state:'unknown',uiState:'unknown',code:'private-collection-deadline',samples:0,elapsedMs:0};
 const finish=(timedOut=false):PrivateUIReadiness=>{let value=last!;if(timedOut&&value.nativeHosts===1&&value.openShadowRoots===0)value={...value,state:'unsupported',code:'chat-native-shadow-unavailable'};else if(timedOut&&!lastSettled&&['ready','empty','locked'].includes(value.state))value={...value,state:'loading',code:'private-page-loading'};return {...value,uiState:value.state,samples,elapsedMs:Math.max(0,Date.now()-wallStart)};};
 // 次数、注入时钟和墙钟三重上限，损坏的测试时钟或页面不会无限等待。
 while(samples<Math.ceil(timeout/interval)+3&&Date.now()-wallStart<=timeout+interval){
  const remaining=Math.max(1,Math.min(deadline-now(),timeout-(Date.now()-wallStart)));let timer:ReturnType<typeof setTimeout>|undefined;
  let value:PrivateUIState|null;try{samples++;value=await Promise.race([inspect(input.page,{kind:input.kind,conversationId:input.conversationId}),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),remaining);})]);}finally{clearTimeout(timer);}
  if(!value)break;
  everNative=everNative||value.nativeHosts>0||value.contract===NATIVE_CHAT_CONTRACT;
  // 本次等待一旦识别新Chat，就绪前的SPA卸载也不能退回document里的旧私信残留。
  if(everNative&&value.contract!==NATIVE_CHAT_CONTRACT)value={...value,contract:NATIVE_CHAT_CONTRACT,...(value.state==='wrong-location'?{}:{state:'unknown' as const,code:'chat-native-messages-unavailable'})};
  last=value;
  const at=now(),wallAt=Date.now(),signature=JSON.stringify(value);if(signature!==lastSignature){lastSignature=signature;stableAt=at;wallStableAt=wallAt;}
  const settled=(at-stableAt>=stable||wallAt-wallStableAt>=stable)&&(at-start>=minimum||wallAt-wallStart>=minimum);lastSettled=settled;
  if(input.deadline!==undefined&&at>=input.deadline&&['ready','empty'].includes(value.state)){last={...value,state:'unknown',code:'private-collection-deadline'};break;}
  if(settled&&['ready','empty','locked','wrong-location'].includes(value.state))return finish();
  if(at>=deadline||wallAt-wallStart>=timeout)break;
  await sleep(Math.max(1,Math.min(interval,deadline-at,timeout-(wallAt-wallStart))));
 }
 return finish(true);
}
function uiDiagnostic(ui:PrivateUIState,source:ChatDiagnostic['source']):ChatDiagnostic{
 const status:ChatDiagnosticStatus=ui.code==='private-collection-deadline'?'partial':ui.state==='ready'?'ok':ui.state==='empty'?'empty':ui.state==='locked'?'blocked':ui.state==='unsupported'?'unsupported':ui.state==='loading'?'partial':ui.state==='wrong-location'?'failed':'unknown';
 return diagnostic(status,ui.code,source);
}
const uiProtection=(ui:PrivateUIState):ChatProtection=>({hasUnlockedSession:ui.contract===NATIVE_CHAT_CONTRACT&&['ready','empty'].includes(ui.state),unlockPending:ui.contract===NATIVE_CHAT_CONTRACT&&ui.state==='locked',needsHuman:ui.state==='locked'});

/** 纯解析只接受页面原生属性；UUID不生成时间，非You也不反推入站。 */
export function inspectNativeChatRows(rows:NativeChatRow[],conversationId:string,url:string):ChatInspection{
 if(!DIRECT.test(conversationId)||!conversationPath(url,conversationId))return result(NATIVE_CHAT_CONTRACT,conversationId,[],[diagnostic('failed','chat-native-conversation-mismatch')]);
 const seen=new Map<string,string>(),all:ChatObservedMessage[]=[];let invalid=false,unknownSender=false,invalidStructure=false,invalidBody=false;
 for(const row of rows.slice(-20)){
  const codes:string[]=[];const id=UUID.test(row.nativeId)&&row.testId==='message-'+row.nativeId?row.nativeId:'';
  const articleBound=!!id&&row.articleRole==='article'&&row.focusTarget===id+':content';
  const contentBound=!!id&&row.contentLinked&&row.contentTestId==='message-text-'+id;
  const bodyValid=row.bodyUnique&&typeof row.text==='string'&&!!row.text.trim()&&row.text.length<=30000;
  const complete=articleBound&&contentBound&&bodyValid;
  if(!id||!contentBound){invalid=true;codes.push('chat-native-id-conflict');}
  if(!articleBound){invalidStructure=true;codes.push('chat-native-message-structure-unverified');}
  if(!bodyValid){invalidBody=true;codes.push('chat-native-body-unverified');}
  const signature=JSON.stringify([row.text,row.sender,row.displayTime,row.sendStatus]);
  if(id&&seen.has(id)){if(seen.get(id)!==signature){invalid=true;codes.push('chat-native-id-conflict');}else continue;}else if(id)seen.set(id,signature);
  const direction=articleBound&&row.senderLinked&&row.sender==='You'?'out':'unknown';
  if(direction==='unknown'){unknownSender=true;codes.push('chat-native-sender-unverified');}
  codes.push('chat-native-time-unverified');
  all.push({id,text:complete?row.text:'',direction,timestamp:0,timestampReliable:false,media:row.media,contract:NATIVE_CHAT_CONTRACT,senderLabel:articleBound&&row.senderLinked?row.sender:undefined,displayTime:articleBound?row.displayTime||undefined:undefined,dateBoundary:row.dateBoundary||undefined,sendStatus:row.sendStatus||undefined,blockedCodes:[...new Set(codes)]});
 }
 const diagnostics:ChatDiagnostic[]=[diagnostic('unsupported','chat-native-observed','chat',0,all.length)];
 if(!all.length)diagnostics.push(diagnostic('unknown','chat-native-messages-unavailable'));
 else diagnostics.push(diagnostic('unsupported','chat-native-time-unverified','chat',0,all.length));
 if(unknownSender)diagnostics.push(diagnostic('unsupported','chat-native-sender-unverified','chat',0,all.length));
 if(invalid)diagnostics.push(diagnostic('unsupported','chat-native-id-conflict','chat',0,all.length));
 if(invalidStructure)diagnostics.push(diagnostic('unsupported','chat-native-message-structure-unverified','chat',0,all.length));
 if(invalidBody)diagnostics.push(diagnostic('unsupported','chat-native-body-unverified','chat',0,all.length));
 const hasUnlockedSession=all.some(r=>!!r.id&&!!r.text);
 return result(NATIVE_CHAT_CONTRACT,conversationId,all,diagnostics,[],{hasUnlockedSession,unlockPending:false,needsHuman:false});
}

/** locator穿透open ShadowRoot，ARIA引用必须属于同一row，禁止从document同名节点取证。 */
export async function inspectPrivateConversation(page:Page,conversationId:string,options:PrivateReadinessOptions={}):Promise<ChatInspection>{
 const ui=await waitForPrivateUI({...options,page,kind:'conversation',conversationId});
 if(ui.state!=='ready')return {...result(ui.contract,conversationId,[],[uiDiagnostic(ui,'conversation')],[],uiProtection(ui)),ui};
 const expired=()=>options.deadline!==undefined&&(options.now??Date.now)()>=options.deadline!;
 const budgetResult=()=>({...result(ui.contract,conversationId,[],[diagnostic('partial','private-collection-deadline','conversation')]),ui:{...ui,state:'unknown' as const,uiState:'unknown' as const,code:'private-collection-deadline'}});
 if(expired())return budgetResult();
 const hosts=page.locator('[data-testid="xchatEmbedRoute"]'),hostCount=await hosts.count();
 if(ui.contract===NATIVE_CHAT_CONTRACT){
  if(hostCount!==1||!await hosts.first().evaluate(node=>!!node.shadowRoot)){const changed={...ui,state:'unsupported' as const,uiState:'unsupported' as const,code:'chat-native-shadow-unavailable',nativeHosts:hostCount,openShadowRoots:0};return {...result(NATIVE_CHAT_CONTRACT,conversationId,[],[uiDiagnostic(changed,'conversation')]),ui:changed};}
  if(!DIRECT.test(conversationId)||!conversationPath(page.url(),conversationId)){const changed={...ui,state:'wrong-location' as const,uiState:'wrong-location' as const,code:'private-wrong-location',locationValid:false};return {...result(NATIVE_CHAT_CONTRACT,conversationId,[],[uiDiagnostic(changed,'conversation')]),ui:changed};}
  const logs=hosts.locator('[role="log"][aria-label="Messages"][data-testid="dm-message-scroller"]');
  const logCount=await logs.count();if(logCount!==1){const changed={...ui,state:'unknown' as const,uiState:'unknown' as const,code:'chat-native-messages-unavailable',messageLogs:logCount};return {...result(NATIVE_CHAT_CONTRACT,conversationId,[],[uiDiagnostic(changed,'conversation')]),ui:changed};}
  const rows=await logs.locator('[data-dm-message-row]').evaluateAll(nodes=>nodes.slice(-20).map(row=>{
   const root=row.getRootNode() as ShadowRoot,nativeId=row.getAttribute('data-dm-message-row')??'';
   const articles=Array.from(row.querySelectorAll('[role="article"]'));
   const candidate=articles.length===1?articles[0]:null;
   const article=candidate?.getAttribute('data-dm-message-focus-target')===nativeId+':content'?candidate:null;
   const referenced=(attribute:string,suffix:string)=>{
    const ids=(article?.getAttribute(attribute)??'').split(/\s+/).filter(Boolean).filter(id=>id.endsWith(suffix));
    const owned=ids.map(id=>root.querySelector('#'+CSS.escape(id))).filter((node):node is Element=>!!node&&row.contains(node));return owned.length===1?owned[0]:null;
   };
   const sender=referenced('aria-labelledby','-sender'),time=referenced('aria-labelledby','-time'),content=referenced('aria-describedby','-content');
   const boundaries=Array.from(root.querySelectorAll('[data-dm-item-key^="dateBoundary-"]')).filter(node=>!node.contains(row)&&!!(node.compareDocumentPosition(row)&Node.DOCUMENT_POSITION_FOLLOWING));
   const boundary=boundaries.at(-1),bodies=content?Array.from(content.querySelectorAll('span[dir="auto"]')):[];
   const body=bodies.length===1?bodies[0] as HTMLElement:null;
   return {nativeId,articleRole:article?.getAttribute('role')??'',focusTarget:article?.getAttribute('data-dm-message-focus-target')??'',testId:row.getAttribute('data-testid')??'',contentTestId:content?.getAttribute('data-testid')??'',contentLinked:!!content,bodyUnique:bodies.length===1,text:body?.innerText??'',sender:sender?.textContent?.trim()??'',senderLinked:!!sender,displayTime:time?.textContent?.trim()??'',dateBoundary:boundary?.textContent?.trim().slice(0,100)??'',sendStatus:row.getAttribute('data-send-status')??'',media:!!row.querySelector('img:not([data-testid*="Avatar"]),video')};
  }));
  if(expired())return budgetResult();
  return {...inspectNativeChatRows(rows,conversationId,page.url()),ui};
 }
 if(ui.contract!=='legacy'||hostCount>0)return {...result(ui.contract,conversationId,[],[diagnostic('unknown','private-structure-unverified','conversation')]),ui:{...ui,state:'unknown',uiState:'unknown',code:'private-structure-unverified'}};
 if(expired())return budgetResult();
 if(!DIRECT.test(conversationId)&&await page.locator('[data-conversation-type="direct"],[data-chat-type="direct"],[data-participant-count="2"]').count()===0)return result('legacy',conversationId,[],[diagnostic('unsupported','private-direct-unverified','conversation')]);
 const all:ChatObservedMessage[]=await page.locator('[data-testid="messageEntry"]').evaluateAll(nodes=>nodes.slice(-20).flatMap(node=>{
  const content=node.querySelector('[data-testid="messageEntryContent"],[data-testid="message-text"]') as HTMLElement|null;if(!content)return [];
  const explicit=node.getAttribute('data-direction'),time=node.querySelector('time')?.getAttribute('datetime'),parsed=time?Date.parse(time):NaN,id=node.getAttribute('data-message-id')||(/^message[-_:]/.test(node.id)?node.id:'');
  return [{id,text:content.innerText,direction:(explicit==='in'||explicit==='out'?explicit:'unknown') as 'in'|'out'|'unknown',timestamp:Number.isFinite(parsed)&&parsed>0?parsed:0,timestampReliable:Number.isFinite(parsed)&&parsed>0,media:!!node.querySelector('img:not([data-testid*="Avatar"]),video'),contract:'legacy' as const,blockedCodes:[]}];
 }));
 if(expired())return budgetResult();
 const latest=all.at(-1),diagnostics:ChatDiagnostic[]=[],events:Event[]=[];
 if(!latest)diagnostics.push(diagnostic('unknown','private-inbox-unverified','conversation'));
 else if(latest.direction==='unknown')diagnostics.push(diagnostic('unsupported','private-legacy-direction-unverified','conversation',0,all.length));
 else if(latest.direction==='out')diagnostics.push(diagnostic('ok','private-legacy-readable','conversation',0,all.length));
 else if(!latest.id)diagnostics.push(diagnostic('unsupported','private-legacy-id-missing','conversation',0,all.length));
 else if(!latest.text.trim()||latest.text.length>30000)diagnostics.push(diagnostic('unsupported','private-legacy-body-unverified','conversation',0,all.length));
 else if(!latest.timestampReliable)diagnostics.push(diagnostic('unsupported','private-legacy-time-unverified','conversation',0,all.length));
 else {
  events.push({id:'dm:'+conversationId+':'+latest.id,platformId:latest.id,targetId:conversationId,channel:'private',userId:'dm:'+conversationId,handle:'',text:latest.text,url:page.url().split('?')[0],conversationId,timestamp:latest.timestamp,timestampReliable:true,mediaUnavailable:latest.media});
  diagnostics.push(diagnostic('ok','private-legacy-readable','conversation',1,all.length));
 }
 return {...result('legacy',conversationId,all,diagnostics,events),ui};
}

/** requests/other是原生收件入口，不是会话ID；只导航页面实际提供的新Chat入口。 */
export async function discoverPrivateInboxes(page:Page,options:PrivateReadinessOptions={}):Promise<PrivateInboxDiscovery>{
 const ui=await waitForPrivateUI({...options,page,kind:'inbox'}),contract=ui.contract,native=contract===NATIVE_CHAT_CONTRACT;
 let source:ChatDiagnostic['source']='inbox';try{if(new URL(page.url()).pathname.endsWith('/requests'))source='requests';}catch{}
 if(ui.state!=='ready'){const diagnostics=[uiDiagnostic(ui,source)];return {ui,contract,conversations:[],entries:[],diagnostics,warnings:diagnostics.filter(row=>!['ok','empty'].includes(row.status)).map(row=>chatDiagnosticMessage(row.code)),chatProtection:uiProtection(ui)};}
 const links=await page.locator('a[href^="/messages/"],a[href^="/i/chat/"],a[href^="https://x.com/messages/"],a[href^="https://x.com/i/chat/"]').evaluateAll(nodes=>nodes.slice(0,200).map(node=>({href:node.getAttribute('href')??'',optionId:node.getAttribute('id')??'',role:node.getAttribute('role')??'',itemTestId:node.parentElement?.tagName==='DIV'?node.parentElement.getAttribute('data-testid')??'':'',inConversations:node.closest('[role="listbox"]')?.getAttribute('aria-label')==='Conversations'})));
 const conversations:PrivateConversationLink[]=[],entries:PrivateInboxDiscovery['entries']=[],diagnostics:ChatDiagnostic[]=[uiDiagnostic(ui,source)];let unknown=false;
 let currentKind:PrivateInboxKind='inbox';try{const path=new URL(page.url()).pathname;currentKind=path.endsWith('/requests')?'requests':path.endsWith('/other')?'other':'inbox';}catch{}
 for(const link of links){let url:URL;try{url=new URL(link.href,'https://x.com');}catch{continue;}if(url.origin!=='https://x.com')continue;const path=url.pathname;
  if(['/i/chat/requests','/messages/requests'].includes(path)){entries.push({kind:'requests',url:url.origin+path});continue;}
  if(path==='/i/chat/other'){entries.push({kind:'other',url:url.origin+path});continue;}
  const direct=path.match(/^\/i\/chat\/(\d+)-(\d+)$/),test=link.itemTestId.match(/^dm-conversation-item-(\d+):(\d+)$/),option=link.optionId.match(/^dm-conversation-option-(\d+):(\d+)$/);
  if(direct){if(!link.inConversations||link.role!=='option'||!test||!option||direct[1]!==test[1]||direct[2]!==test[2]||direct[1]!==option[1]||direct[2]!==option[2]){unknown=true;continue;}conversations.push({conversationId:direct[1]+'-'+direct[2],url:url.origin+path,contract:NATIVE_CHAT_CONTRACT,source:currentKind});continue;}
  if(!native&&/^\/messages\/[\d-]+$/.test(path)){conversations.push({conversationId:path.split('/').at(-1)!,url:url.origin+path,contract:'legacy',source:currentKind});continue;}
  unknown=true;
 }
 const uniqueConversations=[...new Map(conversations.map(x=>[x.url,x])).values()],uniqueEntries=[...new Map(entries.map(x=>[x.url,x])).values()];
 if(unknown)diagnostics.push(diagnostic(uniqueConversations.length?'partial':'unsupported','chat-inbox-entries-unverified','inbox'));
 if(native){if(!uniqueEntries.some(x=>x.kind==='requests')&&currentKind!=='requests')diagnostics.push(diagnostic('partial','chat-request-entry-missing','requests'));if(!uniqueEntries.some(x=>x.kind==='other')&&currentKind!=='other')diagnostics.push(diagnostic('partial','chat-other-entry-missing','inbox'));}
 if(!uniqueConversations.length)diagnostics.push(diagnostic('unknown','private-inbox-unverified',currentKind==='requests'?'requests':'inbox'));
 return {ui,contract,conversations:uniqueConversations,entries:uniqueEntries,diagnostics,warnings:diagnostics.filter(row=>!['ok','empty'].includes(row.status)).map(x=>chatDiagnosticMessage(x.code)),chatProtection:{hasUnlockedSession:native&&uniqueConversations.length>0,unlockPending:false,needsHuman:false}};
}

export type PrivateCollectionInput={page:Page;handle:string;deadline:number;navigate:(page:Page,url:string,deadline:number)=>Promise<void>;now?:()=>number;readiness?:PrivateReadinessOptions};
export type PrivateCollectionResult=CollectionResult&{pageStates:Array<PrivateUIReadiness&{source:PrivateInboxKind|'conversation'}>;diagnostics:ChatDiagnostic[];observations:Array<{conversationId:string;source:PrivateInboxKind;contract:ChatContract;messageCount:number;outgoing:number;unknownDirection:number;queueable:number;blockedCodes:string[]}>;chatProtection:ChatProtection};
export async function collectPrivateWithDiagnostics(input:PrivateCollectionInput):Promise<PrivateCollectionResult>{
 const {page,handle,deadline,navigate}=input,now=input.now??Date.now,events:Event[]=[],diagnostics:ChatDiagnostic[]=[],warnings:string[]=[],observations:PrivateCollectionResult['observations']=[],pageStates:PrivateCollectionResult['pageStates']=[];
 const inboxes=['https://x.com/messages'],visited=new Set<string>(),conversations=new Map<string,PrivateConversationLink>();let protection=noProtection();
 const addProtection=(value:ChatProtection)=>{protection={hasUnlockedSession:protection.hasUnlockedSession||value.hasUnlockedSession,unlockPending:protection.unlockPending||value.unlockPending,needsHuman:protection.needsHuman||value.needsHuman};};
 const timedOut=()=>{if(now()<deadline)return false;diagnostics.push(diagnostic(events.length||observations.length?'partial':'failed','private-collection-deadline','inbox',events.length));return true;};
 for(let index=0;index<inboxes.length&&index<4;index++){
  if(timedOut())break;const url=inboxes[index];if(visited.has(url))continue;visited.add(url);
  try{await navigate(page,url,deadline);const found=await discoverPrivateInboxes(page,{...input.readiness,deadline,now});pageStates.push({source:url.endsWith('/requests')?'requests':url.endsWith('/other')?'other':'inbox',...found.ui});diagnostics.push(...found.diagnostics);addProtection(found.chatProtection);for(const row of found.conversations.slice(0,found.contract===NATIVE_CHAT_CONTRACT?2:3))if(!conversations.has(row.url)&&conversations.size<6)conversations.set(row.url,row);
   for(const entry of found.entries)if(!visited.has(entry.url)&&!inboxes.includes(entry.url))inboxes.push(entry.url);
   if(index===0&&found.contract==='legacy'&&!inboxes.includes('https://x.com/messages/requests'))inboxes.push('https://x.com/messages/requests');
  }catch(error){if((error as any)?.restricted)throw error;diagnostics.push(diagnostic('failed','private-navigation-failed',url.endsWith('/requests')?'requests':'inbox'));}
 }
 for(const link of conversations.values()){
  if(timedOut())break;
  try{await navigate(page,link.url,deadline);const read=await inspectPrivateConversation(page,link.conversationId,{...input.readiness,deadline,now});if(read.ui)pageStates.push({source:'conversation',...read.ui});const freshEvents=now()<deadline?read.events:[];if(freshEvents!==read.events&&read.events.length)diagnostics.push(diagnostic('partial','private-collection-deadline','conversation'));events.push(...freshEvents);diagnostics.push(...read.diagnostics);addProtection(read.chatProtection);observations.push({conversationId:link.conversationId,source:link.source,contract:read.contract,messageCount:read.all.length,outgoing:read.all.filter(x=>x.direction==='out').length,unknownDirection:read.all.filter(x=>x.direction==='unknown').length,queueable:freshEvents.length,blockedCodes:[...new Set(read.all.flatMap(x=>x.blockedCodes))]});}
  catch(error){if((error as any)?.restricted)throw error;diagnostics.push(diagnostic('failed','private-navigation-failed','conversation'));}
 }
 warnings.push(...diagnostics.filter(d=>!['ok','empty'].includes(d.status)).map(d=>chatDiagnosticMessage(d.code)));
 return {events:[...new Map(events.map(e=>[e.platformId+':'+e.conversationId,{...e,accountId:handle.toLowerCase()}])).values()],warnings:[...new Set(warnings)],diagnostics,observations,pageStates,chatProtection:protection};
}
