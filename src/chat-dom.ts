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
export type ChatInspection={contract:ChatContract;conversationId:string;events:Event[];all:ChatObservedMessage[];diagnostics:ChatDiagnostic[];warnings:string[];chatProtection:ChatProtection};
export type PrivateInboxKind='inbox'|'requests'|'other';
export type PrivateConversationLink={conversationId:string;url:string;contract:'legacy'|'xchat-observation-v1';source:PrivateInboxKind};
export type PrivateInboxDiscovery={contract:ChatContract;conversations:PrivateConversationLink[];entries:Array<{kind:PrivateInboxKind;url:string}>;diagnostics:ChatDiagnostic[];warnings:string[];chatProtection:ChatProtection};
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
 const protection=chatProtection??(contract===NATIVE_CHAT_CONTRACT?{hasUnlockedSession:false,unlockPending:true,needsHuman:false}:noProtection());
 return {contract,conversationId,events,all,diagnostics,warnings:[...new Set(diagnostics.filter(d=>d.status!=='ok').map(d=>chatDiagnosticMessage(d.code)))],chatProtection:protection};
}
function conversationPath(url:string,conversationId:string){try{const parsed=new URL(url);return parsed.origin==='https://x.com'&&parsed.pathname==='/i/chat/'+conversationId;}catch{return false;}}

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
 return result(NATIVE_CHAT_CONTRACT,conversationId,all,diagnostics,[],{hasUnlockedSession,unlockPending:!hasUnlockedSession,needsHuman:false});
}

/** locator穿透open ShadowRoot，ARIA引用必须属于同一row，禁止从document同名节点取证。 */
export async function inspectPrivateConversation(page:Page,conversationId:string,options:{needsHuman?:boolean}={}):Promise<ChatInspection>{
 const hosts=page.locator('[data-testid="xchatEmbedRoute"]'),hostCount=await hosts.count();
 if(hostCount){
  if(options.needsHuman)return result(NATIVE_CHAT_CONTRACT,conversationId,[],[diagnostic('blocked','chat-native-locked')],[],{hasUnlockedSession:false,unlockPending:true,needsHuman:true});
  if(hostCount!==1||!await hosts.first().evaluate(node=>!!node.shadowRoot))return result(NATIVE_CHAT_CONTRACT,conversationId,[],[diagnostic('unsupported','chat-native-shadow-unavailable')],[],{hasUnlockedSession:false,unlockPending:true,needsHuman:false});
  if(!DIRECT.test(conversationId)||!conversationPath(page.url(),conversationId))return result(NATIVE_CHAT_CONTRACT,conversationId,[],[diagnostic('failed','chat-native-conversation-mismatch')]);
  const logs=hosts.locator('[role="log"][aria-label="Messages"][data-testid="dm-message-scroller"]');
  if(await logs.count()!==1)return result(NATIVE_CHAT_CONTRACT,conversationId,[],[diagnostic('unknown','chat-native-messages-unavailable')],[],{hasUnlockedSession:false,unlockPending:true,needsHuman:false});
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
  return inspectNativeChatRows(rows,conversationId,page.url());
 }
 if(!DIRECT.test(conversationId)&&await page.locator('[data-conversation-type="direct"],[data-chat-type="direct"],[data-participant-count="2"]').count()===0)return result('legacy',conversationId,[],[diagnostic('unsupported','private-direct-unverified','conversation')]);
 const all:ChatObservedMessage[]=await page.locator('[data-testid="messageEntry"]').evaluateAll(nodes=>nodes.slice(-20).flatMap(node=>{
  const content=node.querySelector('[data-testid="messageEntryContent"],[data-testid="message-text"]') as HTMLElement|null;if(!content)return [];
  const explicit=node.getAttribute('data-direction'),time=node.querySelector('time')?.getAttribute('datetime'),parsed=time?Date.parse(time):NaN,id=node.getAttribute('data-message-id')||(/^message[-_:]/.test(node.id)?node.id:'');
  return [{id,text:content.innerText,direction:(explicit==='in'||explicit==='out'?explicit:'unknown') as 'in'|'out'|'unknown',timestamp:Number.isFinite(parsed)&&parsed>0?parsed:0,timestampReliable:Number.isFinite(parsed)&&parsed>0,media:!!node.querySelector('img:not([data-testid*="Avatar"]),video'),contract:'legacy' as const,blockedCodes:[]}];
 }));
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
 return result('legacy',conversationId,all,diagnostics,events);
}

/** requests/other是原生收件入口，不是会话ID；只导航页面实际提供的新Chat入口。 */
export async function discoverPrivateInboxes(page:Page):Promise<PrivateInboxDiscovery>{
 const native=await page.locator('[data-testid="xchatEmbedRoute"]').count()>0,contract=native?NATIVE_CHAT_CONTRACT:'legacy';
 const links=await page.locator('a[href^="/messages/"],a[href^="/i/chat/"],a[href^="https://x.com/messages/"],a[href^="https://x.com/i/chat/"]').evaluateAll(nodes=>nodes.slice(0,200).map(node=>({href:node.getAttribute('href')??'',optionId:node.getAttribute('id')??'',role:node.getAttribute('role')??'',itemTestId:node.parentElement?.tagName==='DIV'?node.parentElement.getAttribute('data-testid')??'':'',inConversations:node.closest('[role="listbox"]')?.getAttribute('aria-label')==='Conversations'})));
 const conversations:PrivateConversationLink[]=[],entries:PrivateInboxDiscovery['entries']=[],diagnostics:ChatDiagnostic[]=[];let unknown=false;
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
 if(unknown)diagnostics.push(diagnostic('unsupported','chat-inbox-entries-unverified','inbox'));
 if(native){if(!uniqueEntries.some(x=>x.kind==='requests')&&currentKind!=='requests')diagnostics.push(diagnostic('unsupported','chat-request-entry-missing','requests'));if(!uniqueEntries.some(x=>x.kind==='other')&&currentKind!=='other')diagnostics.push(diagnostic('unsupported','chat-other-entry-missing','inbox'));}
 if(!uniqueConversations.length)diagnostics.push(diagnostic('unknown','private-inbox-unverified',currentKind==='requests'?'requests':'inbox'));
 return {contract,conversations:uniqueConversations,entries:uniqueEntries,diagnostics,warnings:diagnostics.map(x=>chatDiagnosticMessage(x.code)),chatProtection:{hasUnlockedSession:false,unlockPending:native,needsHuman:false}};
}

export type PrivateCollectionInput={page:Page;handle:string;deadline:number;navigate:(page:Page,url:string,deadline:number)=>Promise<void>;now?:()=>number};
export type PrivateCollectionResult=CollectionResult&{diagnostics:ChatDiagnostic[];observations:Array<{conversationId:string;source:PrivateInboxKind;contract:ChatContract;messageCount:number;outgoing:number;unknownDirection:number;queueable:number;blockedCodes:string[]}>;chatProtection:ChatProtection};
export async function collectPrivateWithDiagnostics(input:PrivateCollectionInput):Promise<PrivateCollectionResult>{
 const {page,handle,deadline,navigate}=input,now=input.now??Date.now,events:Event[]=[],diagnostics:ChatDiagnostic[]=[],warnings:string[]=[],observations:PrivateCollectionResult['observations']=[];
 const inboxes=['https://x.com/messages'],visited=new Set<string>(),conversations=new Map<string,PrivateConversationLink>();let protection=noProtection();
 const addProtection=(value:ChatProtection)=>{protection={hasUnlockedSession:protection.hasUnlockedSession||value.hasUnlockedSession,unlockPending:protection.unlockPending||value.unlockPending,needsHuman:protection.needsHuman||value.needsHuman};};
 const timedOut=()=>{if(now()<deadline)return false;diagnostics.push(diagnostic(events.length||observations.length?'partial':'failed','private-collection-deadline','inbox',events.length));return true;};
 for(let index=0;index<inboxes.length&&index<4;index++){
  if(timedOut())break;const url=inboxes[index];if(visited.has(url))continue;visited.add(url);
  try{await navigate(page,url,deadline);const found=await discoverPrivateInboxes(page);diagnostics.push(...found.diagnostics);addProtection(found.chatProtection);for(const row of found.conversations.slice(0,found.contract===NATIVE_CHAT_CONTRACT?2:3))if(!conversations.has(row.url)&&conversations.size<6)conversations.set(row.url,row);
   for(const entry of found.entries)if(!visited.has(entry.url)&&!inboxes.includes(entry.url))inboxes.push(entry.url);
   if(index===0&&found.contract==='legacy'&&!inboxes.includes('https://x.com/messages/requests'))inboxes.push('https://x.com/messages/requests');
  }catch(error){if((error as any)?.restricted)throw error;diagnostics.push(diagnostic('failed','private-navigation-failed',url.endsWith('/requests')?'requests':'inbox'));}
 }
 for(const link of conversations.values()){
  if(timedOut())break;
  try{await navigate(page,link.url,deadline);const read=await inspectPrivateConversation(page,link.conversationId);events.push(...read.events);diagnostics.push(...read.diagnostics);addProtection(read.chatProtection);observations.push({conversationId:link.conversationId,source:link.source,contract:read.contract,messageCount:read.all.length,outgoing:read.all.filter(x=>x.direction==='out').length,unknownDirection:read.all.filter(x=>x.direction==='unknown').length,queueable:read.events.length,blockedCodes:[...new Set(read.all.flatMap(x=>x.blockedCodes))]});}
  catch(error){if((error as any)?.restricted)throw error;diagnostics.push(diagnostic('failed','private-navigation-failed','conversation'));}
 }
 warnings.push(...diagnostics.filter(d=>d.status!=='ok').map(d=>chatDiagnosticMessage(d.code)));
 return {events:[...new Map(events.map(e=>[e.platformId+':'+e.conversationId,{...e,accountId:handle.toLowerCase()}])).values()],warnings:[...new Set(warnings)],diagnostics,observations,chatProtection:protection};
}
