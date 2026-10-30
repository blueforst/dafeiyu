import {createHash} from 'node:crypto';
import type {ChatInspection} from './chat-dom.js';
import type {NativeComposer} from './xchat-composer.js';

export type BrowserChatRecoveryCode='checkpoint-invalid'|'identity-mismatch'|'location-mismatch'|'session-unready'|'message-unreliable'|'checkpoint-mismatch';
const reasons:Record<BrowserChatRecoveryCode,string>={
 'checkpoint-invalid':'私信恢复检查点无效',
 'identity-mismatch':'私信恢复账号或参与者不一致',
 'location-mismatch':'私信恢复会话地址不一致',
 'session-unready':'私信会话尚未可靠恢复',
 'message-unreliable':'私信恢复消息证据不完整',
 'checkpoint-mismatch':'私信恢复未匹配原检查点',
};
export class BrowserChatRecoveryError extends Error {
 constructor(readonly code:BrowserChatRecoveryCode){super(reasons[code]);this.name='BrowserChatRecoveryError';}
}

export type BrowserChatRecoveryObservation={
 selfUserId:string;
 url:string;
 inspection:Pick<ChatInspection,'contract'|'conversationId'|'all'|'chatProtection'>&{ui?:Pick<NonNullable<ChatInspection['ui']>,'state'|'locationValid'|'loading'|'lockInputs'|'traversalTruncated'>};
 composer:Pick<NativeComposer,'state'>;
};
export type BrowserChatCheckpointMessage=Readonly<{id:string;nativeSequence:string;direction:'in'|'out';timestamp:number;senderId:string;textHash:string}>;
export type BrowserChatCheckpoint=Readonly<{version:1;selfUserId:string;conversationId:string;canonicalUrl:string;messages:readonly BrowserChatCheckpointMessage[]}>;

const MAX_INSPECTED_ROWS=100,MAX_CHECKPOINT_MESSAGES=3;
const numericId=/^[1-9]\d{0,24}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,hash=/^[a-f0-9]{64}$/;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code:BrowserChatRecoveryCode):never=>{throw new BrowserChatRecoveryError(code);};
function binding(selfUserId:unknown,conversationId:unknown,code:BrowserChatRecoveryCode){
 if(typeof selfUserId!=='string'||!numericId.test(selfUserId)||typeof conversationId!=='string')return fail(code);
 const parts=conversationId.split('-');
 if(parts.length!==2||parts.some(id=>!numericId.test(id))||parts[0]===parts[1]||!parts.includes(selfUserId))return fail(code);
 return {selfUserId,conversationId,peerId:parts[0]===selfUserId?parts[1]:parts[0],canonicalUrl:'https://x.com/i/chat/'+conversationId};
}
function messageFields(row:Record<string,unknown>,selfUserId:string,peerId:string,code:BrowserChatRecoveryCode):Omit<BrowserChatCheckpointMessage,'textHash'>{
 if(typeof row.id!=='string'||!uuid.test(row.id)||typeof row.nativeSequence!=='string'||!numericId.test(row.nativeSequence)||!Number.isSafeInteger(row.timestamp)||Number(row.timestamp)<=0||(row.direction!=='in'&&row.direction!=='out')||row.senderId!==(row.direction==='out'?selfUserId:peerId))return fail(code);
 return {id:row.id.toLowerCase(),nativeSequence:row.nativeSequence,direction:row.direction,timestamp:row.timestamp as number,senderId:row.senderId as string};
}
function inspect(observation:BrowserChatRecoveryObservation){
 if(!object(observation)||!object(observation.inspection))return fail('session-unready');
 const bound=binding(observation.selfUserId,observation.inspection.conversationId,'identity-mismatch');
 if(observation.url!==bound.canonicalUrl)return fail('location-mismatch');
 const read=observation.inspection,ui=read.ui,protection=read.chatProtection;
 if(read.contract!=='xchat-native-v2'||!object(ui)||ui.state!=='ready'||ui.locationValid!==true||ui.loading!==false||ui.lockInputs!==0||ui.traversalTruncated===true||!object(protection)||protection.hasUnlockedSession!==true||protection.unlockPending!==false||protection.needsHuman!==false||!object(observation.composer)||observation.composer.state!=='ready')return fail('session-unready');
 if(!Array.isArray(read.all)||!read.all.length)return fail('session-unready');
 if(read.all.length>MAX_INSPECTED_ROWS)return fail('message-unreliable');
 const ids=new Set<string>(),sequences=new Set<string>();
 const messages=Array.from(read.all).map(row=>{
  if(!object(row)||row.contract!=='xchat-native-v2'||row.timestampReliable!==true||row.media!==false||!Array.isArray(row.blockedCodes)||row.blockedCodes.length||typeof row.text!=='string'||!row.text.trim()||row.text.length>30000)return fail('message-unreliable');
  const fields=messageFields(row,bound.selfUserId,bound.peerId,'message-unreliable');
  if(ids.has(fields.id)||sequences.has(fields.nativeSequence))return fail('message-unreliable');
  ids.add(fields.id);sequences.add(fields.nativeSequence);
  return {...fields,textHash:createHash('sha256').update(row.text,'utf8').digest('hex')};
 });
 return {...bound,messages};
}

/** 仅从已接受、已解锁的一对一原生会话提取少量摘要，不保留正文。 */
export function captureBrowserChatCheckpoint(observation:BrowserChatRecoveryObservation):BrowserChatCheckpoint{
 const checked=inspect(observation),messages=checked.messages.slice(-MAX_CHECKPOINT_MESSAGES).map(row=>Object.freeze(row));
 return Object.freeze({version:1 as const,selfUserId:checked.selfUserId,conversationId:checked.conversationId,canonicalUrl:checked.canonicalUrl,messages:Object.freeze(messages)});
}

function checkedCheckpoint(value:BrowserChatCheckpoint){
 if(!object(value)||value.version!==1||Object.keys(value).some(key=>!['version','selfUserId','conversationId','canonicalUrl','messages'].includes(key)))return fail('checkpoint-invalid');
 const bound=binding(value.selfUserId,value.conversationId,'checkpoint-invalid');
 if(value.canonicalUrl!==bound.canonicalUrl||!Array.isArray(value.messages)||!value.messages.length||value.messages.length>MAX_CHECKPOINT_MESSAGES)return fail('checkpoint-invalid');
 const ids=new Set<string>(),sequences=new Set<string>();
 const messages=Array.from(value.messages).map(row=>{
  if(!object(row)||Object.keys(row).some(key=>!['id','nativeSequence','direction','timestamp','senderId','textHash'].includes(key))||typeof row.textHash!=='string'||!hash.test(row.textHash))return fail('checkpoint-invalid');
  const fields=messageFields(row,bound.selfUserId,bound.peerId,'checkpoint-invalid');
  if(ids.has(fields.id)||sequences.has(fields.nativeSequence))return fail('checkpoint-invalid');
  ids.add(fields.id);sequences.add(fields.nativeSequence);return {...fields,textHash:row.textHash};
 });
 return {...bound,messages};
}

/** 恢复后允许新消息，但每条仍须可靠，且至少保留一个完全一致的旧检查点。 */
export function verifyBrowserChatCheckpoint(checkpoint:BrowserChatCheckpoint,observation:BrowserChatRecoveryObservation):{restored:true;matchedMessages:number}{
 const before=checkedCheckpoint(checkpoint);
 if(observation?.selfUserId!==before.selfUserId)return fail('identity-mismatch');
 if(observation?.inspection?.conversationId!==before.conversationId||observation?.url!==before.canonicalUrl)return fail('location-mismatch');
 const after=inspect(observation),byId=new Map(after.messages.map(row=>[row.id,row]));
 const matchedMessages=before.messages.filter(row=>{const current=byId.get(row.id);return current&&current.nativeSequence===row.nativeSequence&&current.direction===row.direction&&current.timestamp===row.timestamp&&current.senderId===row.senderId&&current.textHash===row.textHash;}).length;
 if(!matchedMessages)return fail('checkpoint-mismatch');
 return {restored:true,matchedMessages};
}
