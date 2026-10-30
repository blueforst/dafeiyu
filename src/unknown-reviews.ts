import {createHash} from 'node:crypto';
import type {Store} from './store.js';
import type {Channel} from './types.js';
import type {OutboxRow} from './outbox.js';

const PREFIX='unknown-review-v1:';
const HASH=/^[a-f0-9]{64}$/;
const ALLOW='allow-other-public-items' as const;
const RESTORE='restore-public-block' as const;
type MessageRow={id:string;account_id:string;channel:string;user_id:string;source_id?:string;platform_id?:string;target_id?:string;status:string;body:string;draft:string|null;receipt:string|null;error:string|null;created_at:number;updated_at:number};
type ReviewRecord={version:1;state:'active'|'revoked';accountId:string;channel:'public';outboxId:string;messageId:string;fingerprint:string;reviewedAt:number;revokedAt?:number;requestRevision:string;dataRevision:string};
export type UnknownReviewEnvironment={accountId:string;control:string;busy:boolean};
export type UnknownReviewApproval={revision:string;confirmed:true;action:typeof ALLOW};
export type UnknownReviewRevocation={revision:string;confirmed:true;action:typeof RESTORE};
export type UnknownReviewPreview={outboxId:string;messageId:string;accountId:string;channel:Channel;status:string;submittedAt:number|null;reviewable:boolean;reason?:string;fingerprint:string;revision:string;reviewed:boolean;reviewedAt:number|null;revokedAt:number|null};
export class UnknownReviewError extends Error {constructor(message:string,public statusCode=409){super(message);}}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=(account:string,id:string)=>PREFIX+JSON.stringify([account,id]);
const hasTable=(store:Store,name:string)=>!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function object(raw:string|null){try{const value=JSON.parse(raw??'null');return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}catch{return null;}}
function pair(store:Store,row:OutboxRow){return store.db.prepare('SELECT * FROM messages WHERE id=? AND account_id=?').get(row.source_id,row.account_id) as MessageRow|undefined;}
function ineligible(store:Store,row:OutboxRow,message:MessageRow|undefined):string|undefined {
 if(row.channel!=='public'||row.kind!=='reply')return '仅支持公开回复的旧未知出站审核';
 if(row.status!=='unknown'||message?.status!=='unknown')return '消息和出站必须同时保持待回查';
 if(!message||message.account_id!==row.account_id||message.channel!=='public'||message.id!==row.source_id)return '消息与出站关联不一致';
 if(!Number.isSafeInteger(row.submitted_at)||Number(row.submitted_at)<=0||!row.target_id||!row.text.trim())return '缺少冻结目标、正文或原提交时间';
 const event=object(row.event),body=object(message.body),draft=object(message.draft);
 if(!event||!body||!draft||draft.text!==row.text||body.id!==message.id||event.id!==message.id||body.channel!=='public'||event.channel!=='public'||body.accountId!==row.account_id||event.accountId!==row.account_id||body.platformId!==row.target_id||event.platformId!==row.target_id||body.userId!==message.user_id||event.userId!==message.user_id||event.text!==body.text||event.url!==body.url)return '冻结消息、目标和出站正文不一致';
 if(message.platform_id&&message.platform_id!==row.target_id||message.target_id&&message.target_id!==row.target_id)return '消息原生身份列与冻结目标冲突';
 // source_id 是原采集别名，可能是 x:<平台ID>，不能要求它等于规范消息 ID。
 if(message.source_id){const aliases=store.db.prepare('SELECT id FROM messages WHERE account_id=? AND (id=? OR source_id=?) LIMIT 2').all(row.account_id,message.source_id,message.source_id) as {id:string}[];if(aliases.length!==1||aliases[0].id!==message.id)return '消息原采集来源存在关联冲突';}
 return undefined;
}
function fingerprint(row:OutboxRow,message:MessageRow|undefined){
 // 回查会更新 updated_at／未知原因；它们不能让已经审核的冻结意图失效。
 return hash({outbox:{id:row.id,account:row.account_id,channel:row.channel,kind:row.kind,source:row.source_id,target:row.target_id,event:row.event,text:row.text,createdAt:row.created_at,submittedAt:row.submitted_at,status:row.status},message:message?{id:message.id,account:message.account_id,channel:message.channel,user:message.user_id,source:message.source_id,platform:message.platform_id,target:message.target_id,body:message.body,draft:message.draft,createdAt:message.created_at,status:message.status}:null});
}
function dataRevision(row:OutboxRow,message:MessageRow|undefined,frozen:string){return hash({frozen,outbox:{updatedAt:row.updated_at,receipt:row.receipt,validation:row.validation_json},message:message?{updatedAt:message.updated_at,receipt:message.receipt,error:message.error}:null});}
function readRecord(raw:string,row:OutboxRow):ReviewRecord|null {
 if(!raw)return null;
 const value=object(raw);
 if(!value||value.version!==1||!['active','revoked'].includes(String(value.state))||value.accountId!==row.account_id||value.channel!=='public'||value.outboxId!==row.id||value.messageId!==row.source_id||!HASH.test(String(value.fingerprint))||!HASH.test(String(value.requestRevision))||!HASH.test(String(value.dataRevision))||!Number.isSafeInteger(value.reviewedAt)||Number(value.reviewedAt)<=0||(value.state==='revoked'&&(!Number.isSafeInteger(value.revokedAt)||Number(value.revokedAt)<=0))||(value.state==='active'&&value.revokedAt!==undefined))throw new UnknownReviewError('人工审核记录损坏，继续保留通道阻塞');
 return value as ReviewRecord;
}
function activeReview(store:Store,row:OutboxRow,message:MessageRow|undefined){
 if(ineligible(store,row,message))return false;
 try{const value=readRecord(store.get(key(row.account_id,row.id)),row);return value?.state==='active'&&value.fingerprint===fingerprint(row,message);}catch{return false;}
}

/** 仅精确人工审核的旧公开回复可不再阻塞新项；unknown 本身始终保留。 */
export function hasBlockingUnknown(store:Store,accountId:string,channel:Channel):boolean {
 const messages=store.db.prepare("SELECT * FROM messages WHERE account_id=? AND channel=? AND status='unknown'").all(accountId,channel) as MessageRow[];
 if(!hasTable(store,'outbox'))return messages.length>0;
 const rows=store.db.prepare("SELECT * FROM outbox WHERE account_id=? AND channel=? AND status IN ('submitting','unknown')").all(accountId,channel) as OutboxRow[];
 const reviewedMessages=new Set<string>();
 for(const row of rows){
  const message=messages.find(item=>item.id===row.source_id);
  if(!activeReview(store,row,message))return true;
  reviewedMessages.add(row.source_id);
 }
 return messages.some(message=>!reviewedMessages.has(message.id));
}

/** 管理审核不伪造平台回执，不修改原出站，也不启动或恢复工作流。 */
export class UnknownReviews {
 constructor(public store:Store,private environment:()=>UnknownReviewEnvironment,private now=Date.now){}
 private account(){const account=this.environment().accountId;if(!account)throw new UnknownReviewError('请先确认工作账号');return account;}
 private row(id:string):OutboxRow {
  const account=this.account();
  const row=hasTable(this.store,'outbox')?this.store.db.prepare('SELECT * FROM outbox WHERE id=? AND account_id=?').get(id,account) as OutboxRow|undefined:undefined;
  if(!row)throw new UnknownReviewError('出站记录不存在',404);return row;
 }
 private snapshot(row:OutboxRow){
  const message=pair(this.store,row),frozen=fingerprint(row,message),data=dataRevision(row,message,frozen),raw=this.store.get(key(row.account_id,row.id));
  let record:ReviewRecord|null=null,corrupt=false;try{record=readRecord(raw,row);}catch{corrupt=true;}
  const reason=corrupt?'人工审核记录损坏，继续保留通道阻塞':ineligible(this.store,row,message);
  const preview:UnknownReviewPreview={outboxId:row.id,messageId:row.source_id,accountId:row.account_id,channel:row.channel,status:row.status,submittedAt:row.submitted_at,reviewable:!reason,...(reason?{reason}:{}),fingerprint:frozen,revision:hash({data,review:raw}),reviewed:!reason&&record?.state==='active'&&record.fingerprint===frozen,reviewedAt:record?.reviewedAt??null,revokedAt:record?.revokedAt??null};
  return {preview,record,raw,data,corrupt};
 }
 list(){
  const account=this.account();
  const rows=hasTable(this.store,'outbox')?this.store.db.prepare("SELECT * FROM outbox WHERE account_id=? AND channel='public' AND status IN ('unknown','submitting') ORDER BY created_at,id").all(account) as OutboxRow[]:[];
  return {items:rows.map(row=>this.snapshot(row).preview)};
 }
 preview(outboxId:string){return this.snapshot(this.row(outboxId)).preview;}
 private idle(account:string){const env=this.environment();if(env.accountId!==account||env.control!=='paused'||env.busy)throw new UnknownReviewError('人工审核需要当前账号保持暂停且没有在途任务');}
 private mutate(outboxId:string,input:UnknownReviewApproval|UnknownReviewRevocation,revoke:boolean){
  if(!input||input.confirmed!==true||input.action!==(revoke?RESTORE:ALLOW)||typeof input.revision!=='string'||!HASH.test(input.revision))throw new UnknownReviewError('需要明确人工确认、审核动作和当前修订',400);
  const account=this.account();this.idle(account);this.store.db.exec('BEGIN IMMEDIATE');
  try{
   this.idle(account);const row=this.row(outboxId),snapshot=this.snapshot(row),{preview,record}=snapshot;
   if(snapshot.corrupt)throw new UnknownReviewError('人工审核记录损坏，继续保留通道阻塞');
   // 精确重放同一已完成请求只读复用，不新写审核，也不让撤销前的请求重新生效。
   const sameState=record?.state===(revoke?'revoked':'active');
   if(sameState&&record!.dataRevision===snapshot.data&&record!.requestRevision===input.revision&&(!revoke?preview.reviewed:true)){this.store.db.exec('COMMIT');return preview;}
   if(preview.revision!==input.revision)throw new UnknownReviewError('记录已变化，请重新读取后审核');
   if(revoke){if(!record||record.state!=='active')throw new UnknownReviewError('当前没有可撤销的人工审核');}
   else if(!preview.reviewable)throw new UnknownReviewError(preview.reason??'该出站不能人工审核');
   if(!revoke&&preview.reviewed){this.store.db.exec('COMMIT');return preview;}
   const at=this.now();if(!Number.isSafeInteger(at)||at<=0)throw new UnknownReviewError('人工审核时间无效');
   const next:ReviewRecord=revoke?{...record!,state:'revoked',revokedAt:at,requestRevision:input.revision,dataRevision:snapshot.data}:{version:1,state:'active',accountId:account,channel:'public',outboxId:row.id,messageId:row.source_id,fingerprint:preview.fingerprint,reviewedAt:at,requestRevision:input.revision,dataRevision:snapshot.data};
   this.store.set(key(account,row.id),JSON.stringify(next));
   this.store.log(revoke?'unknown-review-revoked':'unknown-review-approved',JSON.stringify({accountId:account,channel:'public',outboxId:row.id,messageId:row.source_id,fingerprint:next.fingerprint,action:input.action,at}));
   const result=this.snapshot(row).preview;this.store.db.exec('COMMIT');return result;
  }catch(error){this.store.db.exec('ROLLBACK');throw error;}
 }
 approve(outboxId:string,input:UnknownReviewApproval){return this.mutate(outboxId,input,false);}
 revoke(outboxId:string,input:UnknownReviewRevocation){return this.mutate(outboxId,input,true);}
}
