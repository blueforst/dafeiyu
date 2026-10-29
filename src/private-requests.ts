import {createHash} from 'node:crypto';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {classify,normalizeTriageSettings} from './reply-triage.js';
import type {Event,Config} from './types.js';
import type {Store} from './store.js';

export type PrivateRequestCandidate={event:Event;source:'requests'|'other';url:string};
export type PrivateRequestResult={status:'accepted'|'unknown'|'not_submitted'|'blocked';reason:string;events?:Event[]};
export type PrivateRequestReason='eligible'|'invalid-evidence'|'not-running'|'draft-mode'|'forgotten'|'harassment-cooldown'|'advertising';
export function privateRequestDecision(candidate:PrivateRequestCandidate,input:{accountId:string;config:Config;control:string;forgotten:boolean;ignored:boolean}):PrivateRequestReason{
 const e=candidate?.event,c=input.config;
 if(!e||e.channel!=='private'||e.privateContract!=='xchat-native-v2'||e.accountId!==input.accountId||e.userId!=='dm:'+e.conversationId||!/^\d+-\d+$/.test(e.conversationId)||!e.platformId||e.id!=='dm:'+e.conversationId+':'+e.platformId||e.timestampReliable!==true||!Number.isSafeInteger(e.timestamp)||e.timestamp<=0||!e.text?.trim()||e.text.length>30000||!/^\d{1,25}$/.test(e.nativeSequence??'')||!e.conversationId.split('-').includes(e.senderId??'')||!['requests','other'].includes(candidate.source))return 'invalid-evidence';
 if(input.control!=='running')return 'not-running';if(c.mode!=='auto')return 'draft-mode';
 if(input.forgotten)return 'forgotten';if(input.ignored)return 'harassment-cooldown';
 if(classify(e,{totalCount:0,processedCount:0,recentOtherConversation:false},normalizeTriageSettings(c.triage)).tier==='filtered')return 'advertising';
 return 'eligible';
}
export function privateRequestFingerprint(candidate:PrivateRequestCandidate,selfUserId:string){
 const e=candidate.event;return createHash('sha256').update(JSON.stringify([e.accountId,e.conversationId,e.platformId,e.text,e.timestamp,e.senderId,e.nativeSequence,selfUserId,e.privateContract])).digest('hex');
}
export type PrivateRequestState={version:1;accountId:string;conversationId:string;messageId:string;source:'requests'|'other';receivedAt:number;status:'waiting'|'filtered'|'ignored'|'expired'|'blocked'|'unknown'|'accepted';reason:string;firstObservedAt:number;lastObservedAt:number;updatedAt:number};
const requestKey=(account:string,conversationId:string)=>'private-request-v1:'+account+':'+conversationId;
export function privateRequestState(store:Store,account:string,conversationId:string):PrivateRequestState|null{
 try{const value=JSON.parse(store.get(requestKey(account,conversationId),'null'));return value?.version===1&&value.accountId===account&&value.conversationId===conversationId?value:null;}catch{return null;}
}
export function recordPrivateRequestState(store:Store,candidate:PrivateRequestCandidate,status:PrivateRequestState['status'],reason:string,now=Date.now()){
 const e=candidate.event,account=e.accountId??'';if(!/^[a-z0-9_]{1,15}$/.test(account)||!/^\d+-\d+$/.test(e.conversationId)||!e.platformId)throw Error('私信请求状态范围无效');
 const old=privateRequestState(store,account,e.conversationId),changed=!old||old.messageId!==e.platformId||old.status!==status||old.reason!==reason;
 const state:PrivateRequestState={version:1,accountId:account,conversationId:e.conversationId,messageId:e.platformId,source:candidate.source,receivedAt:e.timestamp,status,reason,firstObservedAt:old?.firstObservedAt??now,lastObservedAt:now,updatedAt:changed?Math.max(now,(old?.updatedAt??0)+1):old!.updatedAt};
 store.set(requestKey(account,e.conversationId),JSON.stringify(state));
 if(changed)store.log('private-request-state',JSON.stringify({accountId:account,conversationId:e.conversationId,channel:'private',source:candidate.source,status,reason}),status==='unknown'||status==='blocked'?'warn':'info');
 return state;
}
export function confirmPrivateRequestState(store:Store,account:string,conversationId:string,now=Date.now()){
 const old=privateRequestState(store,account,conversationId);if(!old||old.status==='accepted')return;
 const next={...old,status:'accepted' as const,reason:'已核对平台正常会话',updatedAt:Math.max(now,old.updatedAt+1),lastObservedAt:now};store.set(requestKey(account,conversationId),JSON.stringify(next));
 store.log('private-request-state',JSON.stringify({accountId:account,conversationId,channel:'private',source:old.source,status:next.status,reason:next.reason}));
}
export function privateRequestsSummary(store:Store,account:string){
 const prefix='private-request-v1:'+account+':',params=[prefix,prefix+'~',account],where="key>=? AND key<? AND json_valid(value) AND json_extract(value,'$.version')=1 AND json_extract(value,'$.accountId')=?";
 const summary=store.db.prepare("SELECT MAX(json_extract(value,'$.updatedAt')) latest,COUNT(*) total,SUM(json_extract(value,'$.status') IN ('waiting','unknown','blocked')) pending,SUM(json_extract(value,'$.status')='unknown') unknown,SUM(json_extract(value,'$.status') IN ('filtered','ignored')) retained FROM runtime WHERE "+where).get(...params) as any;
 const rows=store.db.prepare("SELECT value FROM runtime WHERE "+where+" AND json_extract(value,'$.status') IN ('waiting','unknown','blocked','filtered','ignored') ORDER BY CASE json_extract(value,'$.status') WHEN 'unknown' THEN 0 WHEN 'blocked' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,json_extract(value,'$.updatedAt') DESC LIMIT 5").all(...params) as {value:string}[];
 return {latest:Number(summary?.latest??0),total:Number(summary?.total??0),pending:Number(summary?.pending??0),unknown:Number(summary?.unknown??0),retained:Number(summary?.retained??0),items:rows.map(row=>{const value=JSON.parse(row.value);return {conversationId:value.conversationId,status:value.status,reason:value.reason,updatedAt:value.updatedAt};})};
}
export type PrivateAcceptIntent={accountId:string;conversationId:string;messageId:string;fingerprint:string;selfUserId:string;at:number;status:'unknown'|'accepted';source:'requests'|'other';url:string};
function validRequestURL(url:string,conversationId:string){try{const value=new URL(url);return value.origin==='https://x.com'&&!value.search&&!value.hash&&!value.username&&!value.password&&['/i/chat/'+conversationId,'/i/chat/requests/'+conversationId,'/i/chat/requests/other/'+conversationId].includes(value.pathname);}catch{return false;}}
function persist(path:string,serialized:string){
 const fd=openSync(path+'.tmp','w',0o600);try{writeFileSync(fd,serialized);fsyncSync(fd);}finally{closeSync(fd);}renameSync(path+'.tmp',path);
 const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
/** 接受联系人是独立副作用；unknown 永不按数量清理，重启只读回查。 */
export class PrivateAcceptJournal{
 private entries:Record<string,PrivateAcceptIntent>=Object.create(null);
 constructor(readonly path:string,private write:(path:string,serialized:string)=>void=persist,private now:()=>number=Date.now){
  try{const raw=JSON.parse(readFileSync(path,'utf8'));if(raw?.version!==1||!raw.entries||Array.isArray(raw.entries)||typeof raw.entries!=='object')throw Error();
   for(const [key,value] of Object.entries(raw.entries)){const x=value as PrivateAcceptIntent;if(!x||!['unknown','accepted'].includes(x.status)||!/^\w{1,15}$/.test(x.accountId)||!/^\d+-\d+$/.test(x.conversationId)||key!==this.key(x.accountId,x.conversationId)||!/^\d{1,25}$/.test(x.selfUserId)||!x.conversationId.split('-').includes(x.selfUserId)||!x.messageId||!/^[a-f0-9]{64}$/.test(x.fingerprint)||!Number.isSafeInteger(x.at)||x.at<=0||!['requests','other'].includes(x.source)||!validRequestURL(x.url,x.conversationId))throw Error();this.entries[key]=x;}
  }catch(error:any){if(error?.code!=='ENOENT')throw Error('私信请求接受日志损坏，停止自动接受');}
 }
 private key(account:string,conversationId:string){return account.toLowerCase()+':'+conversationId;}
 get(account:string,conversationId:string){return this.entries[this.key(account,conversationId)];}
 pending(account:string){return Object.values(this.entries).filter(value=>value.accountId===account.toLowerCase()&&value.status==='unknown').map(value=>({...value}));}
 plan(candidate:PrivateRequestCandidate,selfUserId:string):PrivateAcceptIntent{
  const e=candidate.event,account=e.accountId??'';
  if(!/^\w{1,15}$/.test(account)||!/^\d+-\d+$/.test(e.conversationId)||!/^\d{1,25}$/.test(selfUserId)||!e.conversationId.split('-').includes(selfUserId)||!e.platformId||!['requests','other'].includes(candidate.source)||!validRequestURL(candidate.url,e.conversationId))throw Error('私信请求接受意图无效');
  const previous=this.get(account,e.conversationId);if(previous)return previous;
  const next:PrivateAcceptIntent={accountId:account.toLowerCase(),conversationId:e.conversationId,messageId:e.platformId,fingerprint:privateRequestFingerprint(candidate,selfUserId),selfUserId,at:this.now(),status:'unknown',source:candidate.source,url:candidate.url};
  // 写盘失败也在本进程冻结；调用者只有 plan 成功返回之后才能点击。
  this.entries[this.key(account,e.conversationId)]=next;this.save();return next;
 }
 accepted(account:string,conversationId:string){
  const previous=this.get(account,conversationId);if(!previous)throw Error('缺少原接受意图');if(previous.status==='accepted')return previous;
  const next={...previous,status:'accepted' as const},key=this.key(account,conversationId);this.entries[key]=next;
  try{this.save();return next;}catch(error){this.entries[key]=previous;throw error;}
 }
 private save(){
  const rows=Object.entries(this.entries),uncertain=rows.filter(([,value])=>value.status==='unknown'),done=rows.filter(([,value])=>value.status==='accepted').slice(-2000);
  this.write(this.path,JSON.stringify({version:1,entries:Object.fromEntries([...done,...uncertain])}));
 }
}
