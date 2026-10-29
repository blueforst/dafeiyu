import type {Page} from 'playwright-core';
import type {ChatInspection,ChatObservedMessage,ChatDiagnostic} from './chat-dom.js';

/** 公开 getter 与同一原生 row 的 React messageItem／chatItem 双重绑定。 */
export const XCHAT_NATIVE_CONTRACT='xchat-native-v2' as const;
export type XChatModelProof={
 rowId:string;id:string;contentType:string;senderId:string;seconds:string;nanos:number;
 shownSeconds:string;shownNanos:number;sequence:string;fullText:string;textContent:string;
 oneToOne:boolean;fiberBound:boolean;isTextOnly:boolean;isTruncated:boolean;isUndecryptable:boolean;renderedText?:string;
};
export type XChatModelSnapshot={path:string;conversationId:string;validLocation:boolean;atBottom:boolean;ready:boolean;proofs:XChatModelProof[]};

/** 函数自包含，只读取当前会话的白名单字段；不调用页面业务方法或读取认证状态。 */
export function nativeModelSnapshot(input:{conversationId:string}):XChatModelSnapshot{
 const {conversationId}=input,path=location.pathname;
 const validLocation=location.origin==='https://x.com'&&/^\d+-\d+$/.test(conversationId)&&['/i/chat/'+conversationId,'/i/chat/requests/'+conversationId,'/i/chat/requests/other/'+conversationId].includes(path);
 const empty=():XChatModelSnapshot=>({path,conversationId,validLocation,atBottom:false,ready:false,proofs:[]});
 if(!validLocation)return empty();
 const hosts=document.querySelectorAll('[data-testid="xchatEmbedRoute"]');if(hosts.length!==1||!hosts[0].shadowRoot)return empty();
 const roots:ShadowRoot[]=[];let count=0,truncated=false;
 const walk=(root:ShadowRoot,depth=0)=>{if(depth>16||roots.length>=24){truncated=true;return;}roots.push(root);for(const node of root.querySelectorAll('*')){if(++count>6000){truncated=true;return;}if(node.shadowRoot)walk(node.shadowRoot,depth+1);}};
 walk(hosts[0].shadowRoot);if(truncated)return empty();
 const all=(selector:string)=>roots.flatMap(root=>Array.from(root.querySelectorAll(selector)));
 const parent=(node:Element):Element|null=>node.assignedSlot??node.parentElement??(node.getRootNode() instanceof ShadowRoot?(node.getRootNode() as ShadowRoot).host:null);
 const owner=(node:Element,selector:string)=>{let current:Element|null=node;for(let i=0;current&&i<64;i++,current=parent(current)){if(current.matches(selector))return current;if(current===hosts[0])break;}return null;};
 const panels=all('[data-testid="dm-conversation-panel"]').filter(node=>!owner(node,'[data-dm-message-row]'));
 const logs=all('[role="log"]').filter(node=>owner(node,'[data-testid="dm-conversation-panel"]')===panels[0]&&!owner(node,'[data-dm-message-row]'));
 if(panels.length!==1||logs.length!==1||!logs[0].getClientRects().length||Array.from(panels[0].querySelectorAll('[aria-busy="true"]')).some(node=>!owner(node,'[data-dm-message-row],[role="log"],article,[role="article"]')))return empty();
 const log=logs[0] as HTMLElement,atBottom=log.scrollHeight-log.clientHeight-log.scrollTop<=4;
 const rows=all('[data-dm-message-row]').filter(node=>owner(node,'[role="log"]')===log);
 if(rows.length>100)return empty();
 const proofs:XChatModelProof[]=rows.slice(-20).map(row=>{
  const rowId=row.getAttribute('data-dm-message-row')??'';
  const missing:XChatModelProof={rowId,id:'',contentType:'',senderId:'',seconds:'',nanos:-1,shownSeconds:'',shownNanos:-1,sequence:'',fullText:'',textContent:'',oneToOne:false,fiberBound:false,isTextOnly:false,isTruncated:true,isUndecryptable:true};
  try{
   const keys=Object.keys(row).filter(key=>key.startsWith('__reactFiber$'));if(keys.length!==1)return missing;
   let fiber=(row as any)[keys[0]],item:any,chatItem:any,oneToOne=false;
   for(let depth=0;fiber&&depth<9;depth++,fiber=fiber.return){const props=fiber.memoizedProps;if(!props||typeof props!=='object')continue;
    if(props.messageItem){if(item&&item!==props.messageItem)return missing;item=props.messageItem;oneToOne=props.isOneToOne===true;}
    if(props.chatItem){if(chatItem&&chatItem!==props.chatItem)return missing;chatItem=props.chatItem;}
   }
   if(!item||item!==chatItem||item.id!==rowId||!oneToOne)return missing;
   const created=item.created,shown=item.messageInfo?.showTimestamp;
   const fullText=typeof item.fullText==='string'&&item.fullText.length<=30000?item.fullText:'';
   const textContent=typeof item.textContent==='string'&&item.textContent.length<=30000?item.textContent:'';
   const bodies=row.querySelectorAll('[data-testid="message-text-'+rowId+'"] span[dir="auto"]');let reads=0,renderedText='',bodyTruncated=false;
   const bodyText=(node:Node,depth=0):string=>{
    if(++reads>2000||depth>32){bodyTruncated=true;return '';}
    if(node.nodeType===Node.TEXT_NODE)return node.textContent??'';
    if(node instanceof HTMLAnchorElement){const href=node.getAttribute('href')??'';if(/^https?:\/\//i.test(href))return href;}
    if(node instanceof HTMLBRElement)return '\n';
    return Array.from(node.childNodes).map(child=>bodyText(child,depth+1)).join('');
   };
   if(bodies.length===1){renderedText=bodyText(bodies[0]);if(bodyTruncated||renderedText.length>30000)renderedText='';}
   return {rowId,id:typeof item.id==='string'?item.id:'',contentType:typeof item.contentType==='string'?item.contentType:'',senderId:String(item.senderInfo?.userId?.userId??''),seconds:String(created?.epochSeconds??''),nanos:created?.nanosecondsOfSecond??-1,shownSeconds:String(shown?.epochSeconds??''),shownNanos:shown?.nanosecondsOfSecond??-1,sequence:String(item.sequenceNumber?.num??''),fullText,textContent,oneToOne,fiberBound:true,isTextOnly:item.isTextOnly===true,isTruncated:item.isTruncated!==false,isUndecryptable:item.isUndecryptable!==false,renderedText};
  }catch{return missing;}
 });
 return {path,conversationId,validLocation,atBottom,ready:true,proofs};
}

/** Camoufox 显式主世界只读；其他解析继续使用隔离世界。 */
export async function readNativeModels(page:Page,conversationId:string):Promise<XChatModelSnapshot>{
 return page.evaluate('mw:('+nativeModelSnapshot.toString()+')('+JSON.stringify({conversationId})+')');
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function timestamp(seconds:string,nanos:number){
 if(!/^\d{10}$/.test(seconds)||!Number.isInteger(nanos)||nanos<0||nanos>=1e9)return 0;
 const value=Number(seconds)*1000+Math.floor(nanos/1e6);return Number.isSafeInteger(value)&&value>=Date.UTC(2025,0,1)?value:0;
}
export function promoteNativeInspection(observed:ChatInspection,snapshot:XChatModelSnapshot,selfUserId:string,now=Date.now()):ChatInspection{
 const participants=observed.conversationId.split('-'),peer=participants.find(id=>id!==selfUserId);
 const binding=/^\d{1,25}$/.test(selfUserId)&&participants.length===2&&participants.includes(selfUserId)&&!!peer&&peer!==selfUserId&&snapshot.validLocation&&snapshot.conversationId===observed.conversationId&&snapshot.ready&&snapshot.atBottom;
 const proofs=new Map<string,XChatModelProof[]>();for(const proof of snapshot.proofs){const list=proofs.get(proof.rowId)??[];list.push(proof);proofs.set(proof.rowId,list);}
 const all:ChatObservedMessage[]=observed.all.map(row=>{
  const candidates=proofs.get(row.id)??[],proof=candidates[0],codes:string[]=[];
  const structural=row.blockedCodes.filter(code=>!['chat-native-sender-unverified','chat-native-time-unverified'].includes(code));
  const model=!!proof&&candidates.length===1&&proof.fiberBound&&proof.oneToOne&&UUID.test(proof.id)&&proof.id===row.id;
  const body=model&&proof.isTextOnly&&!proof.isTruncated&&!proof.isUndecryptable&&proof.fullText===proof.textContent&&(proof.fullText===row.text||proof.fullText===proof.renderedText)&&!!proof.fullText.trim();
  const time=model?timestamp(proof.seconds,proof.nanos):0,shown=model?timestamp(proof.shownSeconds,proof.shownNanos):0;
  const reliableTime=!!time&&time<=now+60000&&(!proof.shownSeconds||shown===time);
  const incoming=model&&proof.contentType==='ReceivedMessageTextOnly'&&proof.senderId===peer&&row.senderLabel!=='You';
  const outgoing=model&&proof.contentType==='SentMessageTextOnly'&&proof.senderId===selfUserId&&row.senderLabel==='You';
  const sequence=model&&/^\d{1,25}$/.test(proof.sequence)&&BigInt(proof.sequence)>0n;
  if(!binding||!model)codes.push('chat-native-model-unverified');
  if(!body||structural.length)codes.push('chat-native-body-unverified',...structural);
  if(!reliableTime)codes.push('chat-native-time-unverified');
  if(!incoming&&!outgoing)codes.push('chat-native-sender-unverified');
  if(!sequence)codes.push('chat-native-sequence-unverified');
  const valid=!codes.length;
  return {...row,text:valid?proof.fullText:row.text,contract:XCHAT_NATIVE_CONTRACT,direction:valid?(incoming?'in':'out'):'unknown',timestamp:valid?time:0,timestampReliable:valid,blockedCodes:[...new Set(codes)],...(valid?{nativeSequence:proof.sequence,senderId:proof.senderId}:{})};
 });
 const latest=all.at(-1),safe=!!latest&&latest.direction==='in'&&latest.timestampReliable;
 const codes=[...new Set(all.flatMap(row=>row.blockedCodes))];if(!binding&&!codes.includes('chat-native-model-unverified'))codes.push('chat-native-model-unverified');
 const diagnostics:ChatDiagnostic[]=codes.map(code=>({channel:'private',source:'conversation',status:'unsupported',code,eventCount:0}));
 if(!codes.length&&all.length)diagnostics.push({channel:'private',source:'conversation',status:'ok',code:'chat-native-readable',eventCount:safe?1:0});
 const events=safe?[{id:'dm:'+observed.conversationId+':'+latest.id,platformId:latest.id,targetId:observed.conversationId,channel:'private' as const,userId:'dm:'+observed.conversationId,handle:'',text:latest.text,url:'https://x.com/i/chat/'+observed.conversationId,conversationId:observed.conversationId,timestamp:latest.timestamp,timestampReliable:true,mediaUnavailable:latest.media,privateContract:XCHAT_NATIVE_CONTRACT,senderId:latest.senderId,nativeSequence:latest.nativeSequence}]:[];
 return {...observed,contract:XCHAT_NATIVE_CONTRACT,all,events,diagnostics,warnings:codes.map(code=>code==='chat-native-model-unverified'?'新 Chat 的账号、会话与原生消息模型尚未可靠绑定。':code==='chat-native-sequence-unverified'?'新 Chat 消息尚无平台序号，未进入自动处理。':'新 Chat 消息证据不完整，未进入自动处理。')};
}
