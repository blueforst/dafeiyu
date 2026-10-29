import { randomUUID,createHash } from 'node:crypto';
import { applyMigration } from './migrations.js';
import type { Store } from './store.js';
import type { Channel, Event, Receipt } from './types.js';
import { publicResourceOK,validatePostingText,type PostingCapability,type PostingValidation } from './posting-policy.js';

export type OutboxKind = 'reply'|'dm'|'post';
export type OutboxStatus = 'prepared'|'submitting'|'confirmed'|'unknown'|'rejected'|'cancelled';
export type OutboxInput = { id?:string; accountId:string; kind:OutboxKind; sourceId:string; targetId?:string; event?:Event; text:string; capability?:PostingCapability };
export type OutboxRow = { id:string; account_id:string; channel:Channel; kind:OutboxKind; source_id:string; target_id:string; event:string|null; text:string; status:OutboxStatus; receipt:string|null; created_at:number; submitted_at:number|null; updated_at:number; validation_json:string|null };

// 正文仅存业务出站表，日志和计费表不复制。source 唯一约束使人工重试不能创建第二次提交。
export class Outbox {
 constructor(public store:Store) {
  applyMigration(store.db,6,'durable-outbox',`
   CREATE TABLE IF NOT EXISTS outbox(
    id TEXT PRIMARY KEY,account_id TEXT NOT NULL,channel TEXT NOT NULL,kind TEXT NOT NULL,
    source_id TEXT NOT NULL,target_id TEXT NOT NULL,event TEXT,text TEXT NOT NULL,status TEXT NOT NULL,
    receipt TEXT,created_at INTEGER NOT NULL,submitted_at INTEGER,updated_at INTEGER NOT NULL,
    UNIQUE(account_id,kind,source_id)
   );
   CREATE INDEX IF NOT EXISTS outbox_account_status ON outbox(account_id,status,created_at);
  `);
  applyMigration(store.db,8,'posting-validation',`ALTER TABLE outbox ADD COLUMN validation_json TEXT;`);
  store.registerForgetHandler((userId,accountId,before)=>this.forget(userId,accountId,before));
  store.registerPruneHandler(before=>this.prune(before));
  store.replayForgetLedger();
  for(const row of store.db.prepare('SELECT * FROM outbox').all() as OutboxRow[])if(store.forgottenSource(row.account_id,row.channel,row.source_id,row.target_id))this.redact(row,'forgotten');
  this.prune(0);
 }
 private event(row:OutboxRow):any {try{return JSON.parse(row.event??'null')??{};}catch{return {};}}
 private redact(row:OutboxRow,reason:'forgotten'|'retention',now=Date.now()){
  const event=this.event(row),unknown=['submitting','unknown'].includes(row.status),prior=event.outboxPrivacy;
  // 原文入站不参与回查；未知出站正文最多保留至提交后24小时，不随重启或回查延期。
  const eraseAfter=Math.min(prior?.eraseAfter??Infinity,reason==='forgotten'&&unknown?Math.min(now+86400000,(row.submitted_at??row.created_at)+86400000):now);
  const textHash=prior?.textHash??createHash('sha256').update(row.text).digest('hex');
  const minimal:any={text:'',outboxPrivacy:{version:1,reason,textHash,eraseAfter}};
  for(const key of ['id','accountId','channel','userId','platformId','targetId','conversationId','url','timestamp','timestampReliable','privateContract','senderId','nativeSequence','privacyRevision'])if(event[key]!==undefined)minimal[key]=event[key];
  const keepText=unknown&&now<eraseAfter;let receipt:any={};try{receipt=JSON.parse(row.receipt??'{}');}catch{}
  const safeReceipt:any={};for(const key of ['status','id','url','nativeSequence','rejectionKind'])if(receipt[key]!==undefined)safeReceipt[key]=receipt[key];
  if(unknown)safeReceipt.reason=keepText?'已清除入站副本，原出站核对材料最多保留24小时':'隐私核对材料已到期，仅保留摘要，需人工核对';
  this.store.db.prepare('UPDATE outbox SET event=?,text=?,status=?,receipt=?,validation_json=NULL WHERE id=?').run(JSON.stringify(minimal),keepText?row.text:'',row.status==='prepared'?'cancelled':row.status,JSON.stringify(safeReceipt),row.id);
 }
 private forget(userId:string,accountId:string,before?:number){
  for(const row of this.store.db.prepare('SELECT * FROM outbox WHERE account_id=?').all(accountId) as OutboxRow[]){
   const event=this.event(row),message=this.store.getMessage(row.source_id,accountId);
   if((event.userId===userId||message?.user_id===userId)&&(before===undefined||(message?.ingested_at??row.created_at)<=before))this.redact(row,'forgotten');
  }
 }
 prune(before:number){const now=Date.now();for(const row of this.store.db.prepare('SELECT * FROM outbox').all() as OutboxRow[]){const privacy=this.event(row).outboxPrivacy;if(row.created_at<before)this.redact(row,'retention',now);else if(privacy&&now>=privacy.eraseAfter&&row.text)this.redact(row,privacy.reason,now);}}
 recover() { return this.store.db.prepare("UPDATE outbox SET status='unknown',updated_at=? WHERE status='submitting'").run(Date.now()).changes; }
 get(id:string):OutboxRow|undefined { return this.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as OutboxRow|undefined; }
 source(accountId:string,kind:OutboxKind,sourceId:string):OutboxRow|undefined {
  return this.store.db.prepare('SELECT * FROM outbox WHERE account_id=? AND kind=? AND source_id=?').get(accountId,kind,sourceId) as OutboxRow|undefined;
 }
 prepare(input:OutboxInput):OutboxRow {
  if(input.id&&this.store.get('outbox:retired:'+input.id))throw new Error('旧出站标识已经退役');
  if(!input.accountId||!input.sourceId||!['reply','dm','post'].includes(input.kind)||typeof input.text!=='string'||!input.text.trim()||(input.kind==='dm'?input.text.length>4000:!publicResourceOK(input.text)))throw new Error('出站参数无效');
  const target=input.targetId??input.event?.platformId??'';
  if(input.kind!=='post'&&!target)throw new Error('缺少可靠出站目标');
  const old=this.source(input.accountId,input.kind,input.sourceId);
  if(old){
   const previous=this.event(old),revision=(input.event as any)?.privacyRevision;
   let proof:any;try{proof=JSON.parse(old.receipt??'{}');}catch{}
   if(old.status==='cancelled'&&proof?.status==='not_submitted'&&!previous.outboxPrivacy&&typeof revision==='string'&&revision!==previous.privacyRevision&&input.id!==old.id){
    // 仅有浏览器持久“未保存提交意图”证明时允许新生成使用新ID；未知与原ID永不重用。
    this.store.db.exec('SAVEPOINT renew_unsubmitted');try{
     this.store.set('outbox:retired:'+old.id,JSON.stringify({sourceId:old.source_id,accountId:old.account_id,targetId:old.target_id,textHash:createHash('sha256').update(old.text).digest('hex'),status:'not_submitted'}));
     this.store.db.prepare("DELETE FROM outbox WHERE id=? AND status='cancelled'").run(old.id);const renewed=this.prepare(input);this.store.db.exec('RELEASE renew_unsubmitted');return renewed;
    }catch(error){this.store.db.exec('ROLLBACK TO renew_unsubmitted');this.store.db.exec('RELEASE renew_unsubmitted');throw error;}
   }
   if(old.text!==input.text||old.target_id!==target)throw new Error('出站正文和目标已冻结，不能通过重试替换');
   if(old.status==='prepared'&&input.event)this.store.db.prepare("UPDATE outbox SET event=? WHERE id=? AND status='prepared'").run(JSON.stringify(input.event),old.id);
   return old;
  }
  const id=input.id??randomUUID(),at=this.store.nextTimestamp(),validation=validatePostingText(input.text,input.kind,{accountId:input.accountId,capability:input.capability});
  this.store.db.prepare('INSERT OR IGNORE INTO outbox(id,account_id,channel,kind,source_id,target_id,event,text,status,created_at,updated_at,validation_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.accountId,input.kind==='dm'?'private':'public',input.kind,input.sourceId,target,input.event?JSON.stringify(input.event):null,input.text,'prepared',at,at,JSON.stringify(validation));
  const row=this.source(input.accountId,input.kind,input.sourceId);
  if(!row||row.text!==input.text||row.target_id!==target)throw new Error('出站冲突');
  return row;
 }
 validate(id:string,capability?:PostingCapability):PostingValidation {
  const row=this.get(id);if(!row)throw new Error('出站不存在');
  const result=validatePostingText(row.text,row.kind,{accountId:row.account_id,capability});
  if(row.status==='prepared')this.store.db.prepare("UPDATE outbox SET validation_json=?,updated_at=? WHERE id=? AND status='prepared'").run(JSON.stringify(result),Date.now(),id);
  return result;
 }
 begin(id:string,capability?:PostingCapability):boolean {
  const row=this.get(id);if(!row||row.status!=='prepared'||!row.validation_json)return false;
  const validation=this.validate(id,capability);if(!validation.allowed)return false;
  const at=Date.now();
  return this.store.db.prepare("UPDATE outbox SET status='submitting',submitted_at=?,updated_at=? WHERE id=? AND status='prepared'").run(at,at,id).changes>0;
 }
 retext(id:string,text:string):OutboxRow {
  const row=this.get(id);if(!row||row.status!=='prepared')throw new Error('仅未提交草稿可以更新正文');
  const validation=validatePostingText(text,row.kind,{accountId:row.account_id});if(!validation.allowed)throw new Error(validation.reason);
  this.store.db.prepare("UPDATE outbox SET text=?,validation_json=?,updated_at=? WHERE id=? AND status='prepared'").run(text,JSON.stringify(validation),Date.now(),id);return this.get(id)!;
 }
 settle(id:string,receipt:Receipt):OutboxRow {
  const row=this.get(id);if(!row)throw new Error('出站不存在');
  if(row.status==='confirmed'||row.status==='rejected'||row.status==='cancelled')return row;
  if(row.status==='prepared')throw new Error('尚未保存提交意图');
  if(receipt.status==='confirmed'&&!receipt.id)receipt={status:'unknown',reason:'回执缺少唯一平台 ID'};
  this.store.db.prepare('UPDATE outbox SET status=?,receipt=?,validation_json=COALESCE(?,validation_json),updated_at=? WHERE id=?').run(receipt.status==='not_submitted'?'cancelled':receipt.status,JSON.stringify(receipt),receipt.validation?JSON.stringify(receipt.validation):null,Date.now(),id);
  const current=this.get(id)!;if(this.event(current).outboxPrivacy)this.redact(current,this.event(current).outboxPrivacy.reason);
  return this.get(id)!;
 }
 cancel(id:string):boolean { return this.store.db.prepare("UPDATE outbox SET status='cancelled',updated_at=? WHERE id=? AND status='prepared'").run(Date.now(),id).changes>0; }
 pendingUnknown(accountId:string):OutboxRow[] { return this.store.db.prepare("SELECT * FROM outbox WHERE account_id=? AND status='unknown' ORDER BY created_at LIMIT 50").all(accountId) as OutboxRow[]; }
 count(channel:Channel,accountId:string,since=Date.now()-3600000):number {
  return Number((this.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE account_id=? AND channel=? AND status IN ('submitting','confirmed','unknown','rejected') AND submitted_at>=?").get(accountId,channel,since) as any).n);
 }
}
