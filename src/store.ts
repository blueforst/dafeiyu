import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,readFileSync,writeFileSync,renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyMigration, FOUNDATION_MIGRATION } from './migrations.js';
import type { Event, Channel, Draft, Receipt } from './types.js';

type ForgetHandler=(userId:string,accountId:string,before?:number)=>void;
export function eventIdentity(accountId:string,channel:Channel,platformId:string):string {
 return 'event:'+encodeURIComponent(accountId)+':'+channel+':'+encodeURIComponent(platformId);
}
/** 同一原生ID出现冲突证据时停止，不选一行自动归并。 */
export class NativeIdentityConflictError extends Error {
 readonly statusCode=409;readonly code='native-identity-conflict';
 constructor(){super('平台消息身份存在冲突，未自动去重或归并');}
}
const PUBLIC_NATIVE_ID=/^\d{1,32}$/;
const PRIVATE_NATIVE_ID=/^[A-Za-z0-9:_-]{1,250}$/;
const nativeId=(value:unknown,channel:Channel):string|undefined=>typeof value==='string'&&(channel==='public'?PUBLIC_NATIVE_ID:PRIVATE_NATIVE_ID).test(value)?value:undefined;
/** 只从明确字段或规范公开帖子URL取证；私信会话URL不是消息ID。 */
function nativeEvidence(row:{account_id:string;channel:Channel;platform_id?:unknown;body:unknown}):{ids:string[];platformId?:string;conflict:boolean}{
 let body:any=row.body,malformed=false;
 try{if(typeof body==='string')body=JSON.parse(body);if(!body||typeof body!=='object'||Array.isArray(body)){body={};malformed=true;}}catch{body={};malformed=true;}
 const ids=new Set<string>();for(const value of [row.platform_id,body.platformId]){const id=nativeId(value,row.channel);if(id)ids.add(id);}
 if(row.channel==='public'&&typeof body.url==='string')try{
  const url=new URL(body.url),match=url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,32})\/?$/);
  if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['x.com','www.x.com','twitter.com','www.twitter.com','mobile.x.com','mobile.twitter.com'].includes(url.hostname.toLowerCase())&&match)ids.add(match[2]);
 }catch{}
  const accountHandle=(value:unknown)=>{if(typeof value!=='string')return;const handle=value.trim().replace(/^@/,'');return /^[A-Za-z0-9_]{1,15}$/.test(handle)?handle.toLowerCase():undefined;};
 const declaresAccount=body.accountId!==undefined&&body.accountId!==null&&body.accountId!=='';
 const bodyAccount=accountHandle(body.accountId),rowAccount=accountHandle(row.account_id);
 const scopeConflict=(declaresAccount&&(!bodyAccount||!rowAccount||bodyAccount!==rowAccount))||(body.channel!==undefined&&body.channel!==row.channel);
 const invalidTypedField=[row.platform_id,body.platformId].some(value=>value!==undefined&&value!==null&&value!==''&&!nativeId(value,row.channel));
 const conflict=ids.size>1||scopeConflict||(ids.size>0&&(malformed||invalidTypedField));
 return {ids:[...ids],platformId:!conflict&&ids.size===1?[...ids][0]:undefined,conflict};
}
export class Store {
 db:DatabaseSync;ledgerPath:string;
 private forgetHandlers:ForgetHandler[]=[];
 constructor(path:string){
  mkdirSync(dirname(path),{recursive:true});this.ledgerPath=dirname(path)+'/forget-ledger.json';this.db=new DatabaseSync(path);
  this.db.exec(`
   PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,forgot INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel TEXT NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',draft TEXT,receipt TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS memory(user_id TEXT NOT NULL,visibility TEXT NOT NULL,summary TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,visibility));
   CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,level TEXT NOT NULL,event TEXT NOT NULL,detail TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS messages_queue ON messages(status,created_at);
   CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id,channel,created_at);
  `);
  applyMigration(this.db,1,'account-ownership-and-settings-baseline',FOUNDATION_MIGRATION);
  this.replayForgetLedger();
 }
 registerForgetHandler(handler:ForgetHandler){this.forgetHandlers.push(handler);}
 private ledger():Record<string,boolean>{
  let raw:string;try{raw=readFileSync(this.ledgerPath,'utf8');}catch(error:any){if(error?.code==='ENOENT')return {};throw error;}
  const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(v=>typeof v!=='boolean'))throw new Error('独立遗忘记录损坏，停止处理');return value;
 }
 private ledgerKey(userId:string,accountId:string){return accountId?'scope:'+JSON.stringify([accountId,userId]):userId;}
 private updateLedger(userId:string,forgot:boolean,accountId=''){
  const ledger=this.ledger();ledger[this.ledgerKey(userId,accountId)]=forgot;
  if(!accountId)for(const key of Object.keys(ledger))if(key.startsWith('scope:')){const scope=JSON.parse(key.slice(6));if(scope[1]===userId)ledger[key]=forgot;}
  const tmp=this.ledgerPath+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(ledger),{mode:0o600});renameSync(tmp,this.ledgerPath);
 }
 private history():Record<string,number>{
  let raw:string;try{raw=readFileSync(dirname(this.ledgerPath)+'/forget-history.json','utf8');}catch(error:any){if(error?.code==='ENOENT')return {};throw error;}
  const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(v=>!Number.isSafeInteger(v)||(v as number)<0))throw new Error('独立遗忘历史损坏，停止处理');return value;
 }
 private rememberCutoff(userId:string,accountId:string,before:number){
  const history=this.history();history[this.ledgerKey(userId,accountId)]=before;
  this.writeHistory(history);
 }
 private writeHistory(history:Record<string,number>){const file=dirname(this.ledgerPath)+'/forget-history.json',tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(history),{mode:0o600});renameSync(tmp,file);}
 recordingAfter(userId:string,accountId=''):number{const history=this.history();return Math.max(history['resume:'+this.ledgerKey(userId,accountId)]??0,history['resume:'+userId]??0);}
 private resumeRecording(userId:string,accountId:string){const history=this.history(),key='resume:'+this.ledgerKey(userId,accountId);history[key]=Math.max(Date.now(),(history[key]??0)+1);this.writeHistory(history);}

 private sourceLedger():Record<string,boolean>{
  let raw:string;try{raw=readFileSync(dirname(this.ledgerPath)+'/forgotten-sources.json','utf8');}catch(error:any){if(error?.code==='ENOENT')return {};throw error;}
  const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(v=>v!==true))throw new Error('独立遗忘来源记录损坏，停止处理');return value;
 }
 private sourceKey(accountId:string,channel:string,platformId:string,sourceId:string){return JSON.stringify([accountId,channel,platformId?'platform':'source',platformId||sourceId]);}
 private ignoreForgottenSources(userId:string,accountId:string){
  const rows=this.db.prepare('SELECT account_id,channel,platform_id,source_id,id,body FROM messages WHERE user_id=?'+(accountId?' AND account_id=?':'')).all(...(accountId?[userId,accountId]:[userId])) as any[];
  if(!rows.length)return;
  const ledger=this.sourceLedger();for(const row of rows){
   ledger[this.sourceKey(row.account_id,row.channel,row.platform_id,row.source_id||row.id)]=true;ledger[this.sourceKey(row.account_id,row.channel,'',row.source_id||row.id)]=true;
   // 删除旧空platform列之前保留已验证的原生来源键；不回填或修改历史消息。
   const evidence=nativeEvidence(row);if(evidence.platformId)ledger[this.sourceKey(row.account_id,row.channel,evidence.platformId,row.source_id||row.id)]=true;
  }
  const file=dirname(this.ledgerPath)+'/forgotten-sources.json',tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(ledger),{mode:0o600});renameSync(tmp,file);
 }
 nextTimestamp(now=Date.now()):number{const at=Math.max(now,Number(this.get('ingestionClock','0'))+1);this.set('ingestionClock',String(at));return at;}
 private knownAccounts(userId:string){return (this.db.prepare('SELECT account_id FROM account_users WHERE id=? UNION SELECT account_id FROM messages WHERE user_id=? AND account_id<>\'\' UNION SELECT account_id FROM memory WHERE user_id=? AND account_id<>\'\'').all(userId,userId,userId) as {account_id:string}[]).map(row=>row.account_id);}
 private erase(userId:string,accountId:string,before?:number){
  if(before===undefined){this.db.prepare('DELETE FROM messages WHERE user_id=? AND account_id=?').run(userId,accountId);this.db.prepare('DELETE FROM memory WHERE user_id=? AND account_id=?').run(userId,accountId);}
  else{this.db.prepare('DELETE FROM messages WHERE user_id=? AND account_id=? AND ingested_at<=?').run(userId,accountId,before);this.db.prepare('DELETE FROM memory WHERE user_id=? AND account_id=? AND updated_at<=?').run(userId,accountId,before);}
  for(const handler of this.forgetHandlers)handler(userId,accountId,before);
 }
 private parseScope(key:string):[string,string]{
  if(!key.startsWith('scope:'))return ['',key];
  const scope=JSON.parse(key.slice(6));if(!Array.isArray(scope)||scope.length!==2||scope.some(v=>typeof v!=='string'))throw new Error('独立遗忘范围无效');return scope as [string,string];
 }
 private replayEpoch(userId:string,accountId:string,forgot:boolean,history=this.history()){return Math.max(1,history[this.ledgerKey(userId,accountId)]??0,history[userId]??0)+(forgot?0:1);}
 replayForgetLedger(){
  const ledger=this.ledger(),history=this.history();this.sourceLedger();this.db.exec('BEGIN IMMEDIATE');
  try{
   for(const [key,before] of Object.entries(history)){
    if(key.startsWith('resume:'))continue;
    const [accountId,userId]=this.parseScope(key);this.set('ingestionClock',String(Math.max(before,Number(this.get('ingestionClock','0')))));
    this.erase(userId,accountId,before);if(!accountId)for(const account of this.knownAccounts(userId))this.erase(userId,account,before);
   }
   for(const [key,forgot] of Object.entries(ledger)){
    const [accountId,userId]=this.parseScope(key);
    if(accountId){
     this.db.prepare('INSERT INTO account_users(account_id,id,forgot,epoch) VALUES(?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET forgot=excluded.forgot,epoch=MAX(epoch,excluded.epoch)').run(accountId,userId,forgot?1:0,this.replayEpoch(userId,accountId,forgot,history));
     if(forgot)this.erase(userId,accountId);
    }else{
     this.db.prepare('INSERT INTO users(id,forgot,epoch) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET forgot=excluded.forgot,epoch=MAX(epoch,excluded.epoch)').run(userId,forgot?1:0,this.replayEpoch(userId,'',forgot,history));
     if(forgot)this.erase(userId,'');
     for(const account of this.knownAccounts(userId)){
      if(ledger[this.ledgerKey(userId,account)]===false&&forgot)continue;
      this.db.prepare('INSERT INTO account_users(account_id,id,forgot,epoch) VALUES(?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET forgot=excluded.forgot,epoch=MAX(epoch,excluded.epoch)').run(account,userId,forgot?1:0,this.replayEpoch(userId,account,forgot,history));
      if(forgot)this.erase(userId,account);
     }
    }
   }
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 get(key:string,fallback=''){return (this.db.prepare('SELECT value FROM runtime WHERE key=?').get(key) as any)?.value??fallback;}
 set(key:string,value:string){this.db.prepare('INSERT INTO runtime VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
 log(event:string,detail='',level='info'){this.db.prepare('INSERT INTO logs(at,level,event,detail) VALUES(?,?,?,?)').run(Date.now(),level,event,detail);}
 boot(){this.db.exec("UPDATE messages SET status='queued' WHERE status='generating'; UPDATE messages SET status='unknown' WHERE status='sending'");this.set('control','paused');this.log('boot','服务启动，保持暂停；发送中的任务已转为待回查');}
 user(id:string,accountId=''){return accountId?this.db.prepare('SELECT * FROM account_users WHERE id=? AND account_id=?').get(id,accountId) as any:this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;}
 forgotten(id:string,accountId=''){const scoped=this.user(id,accountId);if(accountId&&scoped?.epoch>0)return !!scoped.forgot;return !!scoped?.forgot||!!(accountId&&this.user(id)?.forgot);}
 epoch(id:string,accountId=''){return Number(this.user(id,accountId)?.epoch||0);}
 ingest(e:Event,accountId=e.accountId??''){
  if(this.forgotten(e.userId,accountId))return false;
  const after=this.recordingAfter(e.userId,accountId);if(after&&(e.timestampReliable===false||!Number.isFinite(e.timestamp)||e.timestamp<=after))return false;
  const platformId=e.platformId??'',sourceId=e.id,evidence=nativeEvidence({account_id:accountId,channel:e.channel,platform_id:platformId,body:e});
  if(evidence.conflict)return false;
  if(evidence.platformId)try{if(this.findByPlatformId(accountId,e.channel,evidence.platformId))return false;}catch(error){if(error instanceof NativeIdentityConflictError)return false;throw error;}
  const ignored=this.sourceLedger(),keys=[platformId,...(evidence.platformId&&evidence.platformId!==platformId?[evidence.platformId]:[])];
  if(keys.some(id=>ignored[this.sourceKey(accountId,e.channel,id,sourceId)]||(accountId&&ignored[this.sourceKey('',e.channel,id,sourceId)]))||ignored[this.sourceKey(accountId,e.channel,'',sourceId)]||(accountId&&ignored[this.sourceKey('',e.channel,'',sourceId)]))return false;
  const id=accountId?eventIdentity(accountId,e.channel,platformId||sourceId):e.id;
  const body={...e,id,accountId,...(platformId?{platformId}:{} )};const ingestedAt=this.nextTimestamp();
  if(accountId)this.db.prepare('INSERT OR IGNORE INTO account_users(account_id,id) VALUES(?,?)').run(accountId,e.userId);
  else this.db.prepare('INSERT OR IGNORE INTO users(id) VALUES(?)').run(e.userId);
  // 同批私信历史保留在动态中，由最新入站统一触发回复，避免补采后逐条补发。
  const history=e.channel==='private'&&e.privateContract==='xchat-native-v2'&&!!e.privateHistoryOf&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(e.privateHistoryOf)&&e.privateHistoryOf!==platformId;
  return this.db.prepare('INSERT OR IGNORE INTO messages(id,account_id,source_id,platform_id,target_id,channel,user_id,body,created_at,updated_at,ingested_at,status,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,accountId,sourceId,platformId,e.targetId??'',e.channel,e.userId,JSON.stringify(body),e.timestamp,Date.now(),ingestedAt,history?'merged':'queued',history?'已采集同会话历史，由最新消息统一处理':null).changes>0;
 }
 pending(limit=2,accountId?:string){return this.db.prepare("SELECT * FROM messages WHERE status='queued'"+(accountId===undefined?'':' AND account_id=?')+" ORDER BY CASE WHEN json_valid(draft) AND json_extract(draft,'$.review')=1 THEN 0 ELSE 1 END,created_at DESC LIMIT ?").all(...(accountId===undefined?[limit]:[accountId,limit])) as any[];}
 unknown(accountId?:string){return this.db.prepare("SELECT * FROM messages WHERE status='unknown'"+(accountId===undefined?'':' AND account_id=?')+' ORDER BY created_at LIMIT 10').all(...(accountId===undefined?[]:[accountId])) as any[];}
 update(id:string,status:string,values:{draft?:Draft;receipt?:Receipt;error?:string}={},accountId?:string){
  const row=this.getMessage(id,accountId);if(!row)return;
  const processed=['confirmed','draft','skipped','failed'].includes(status)&&!row.processed_seq?Math.max(Number(this.get('processedSequence','0')),Number((this.db.prepare('SELECT MAX(processed_seq) AS n FROM messages').get() as any).n??0))+1:row.processed_seq;
  if(processed>Number(this.get('processedSequence','0')))this.set('processedSequence',String(processed));
  this.db.prepare('UPDATE messages SET status=?,draft=COALESCE(?,draft),receipt=COALESCE(?,receipt),error=?,updated_at=?,processed_seq=? WHERE id=?').run(status,values.draft?JSON.stringify(values.draft):null,values.receipt?JSON.stringify(values.receipt):null,values.error||null,Math.max(Date.now(),row.updated_at+1),processed,row.id);
 }
 /** 只读历史兼容查找：不从内部id/source_id或正文散列推平台ID，不改变归属或回填列。 */
 findByPlatformId(accountId:string,channel:Channel,platformId:string):any|undefined {
  if(typeof accountId!=='string'||!['public','private'].includes(channel)||!nativeId(platformId,channel))return;
  const rows=this.db.prepare(`SELECT * FROM messages WHERE account_id=? AND channel=? AND (
   platform_id=? OR (CASE WHEN json_valid(body) THEN json_extract(body,'$.platformId') END)=?
   OR (?='public' AND (CASE WHEN json_valid(body) THEN json_extract(body,'$.url') END) LIKE ?)
  ) ORDER BY id`).all(accountId,channel,platformId,platformId,channel,'%/status/'+platformId+'%') as any[];
  const matches:any[]=[];
  for(const row of rows){const evidence=nativeEvidence(row);if(!evidence.ids.includes(platformId))continue;if(evidence.conflict)throw new NativeIdentityConflictError();matches.push(row);}
  if(matches.length>1)throw new NativeIdentityConflictError();return matches[0];
 }
 getMessage(id:string,accountId?:string){
  const exact=this.db.prepare('SELECT * FROM messages WHERE id=?'+(accountId===undefined?'':' AND account_id=?')).get(...(accountId===undefined?[id]:[id,accountId])) as any;if(exact)return exact;
  const rows=this.db.prepare('SELECT * FROM messages WHERE source_id=?'+(accountId===undefined?'':' AND account_id=?')+' LIMIT 2').all(...(accountId===undefined?[id]:[id,accountId])) as any[];
  return rows.length===1?rows[0]:undefined;
 }
 context(userId:string,channel:Channel,accountId='',policy={recentCount:3,recentDays:7}){
  if(this.forgotten(userId,accountId))return {memories:[],recent:[]};
  const memories=this.db.prepare("SELECT visibility,summary FROM memory WHERE user_id=? AND account_id=? AND (?='private' OR visibility='public')").all(userId,accountId,channel);
  const rows=this.db.prepare("SELECT body,draft,status FROM messages WHERE user_id=? AND account_id=? AND (?='private' OR channel='public') AND status IN ('confirmed','draft','skipped','failed') AND created_at>=? ORDER BY created_at DESC LIMIT ?").all(userId,accountId,channel,Date.now()-policy.recentDays*86400000,policy.recentCount) as any[];
  return {memories,recent:rows.reverse().map(r=>({message:JSON.parse(r.body).text,reply:r.status==='confirmed'?JSON.parse(r.draft||'{}').text:undefined}))};
 }
 originals(userId:string,visibility:Channel,accountId=''){return (this.db.prepare('SELECT body,draft,status FROM messages WHERE user_id=? AND account_id=? AND channel=? ORDER BY created_at DESC LIMIT 30').all(userId,accountId,visibility) as any[]).reverse().map(r=>({message:JSON.parse(r.body).text,reply:r.status==='confirmed'?JSON.parse(r.draft||'{}').text:undefined}));}
 summary(userId:string,visibility:Channel,summary:string,epoch:number,accountId=''){
  if(this.forgotten(userId,accountId)||this.epoch(userId,accountId)!==epoch)return false;
  this.db.prepare('INSERT INTO memory(account_id,user_id,visibility,summary,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id,user_id,visibility) DO UPDATE SET summary=excluded.summary,updated_at=excluded.updated_at').run(accountId,userId,visibility,summary,this.nextTimestamp());return true;
 }
 forget(userId:string,accountId=''){
  this.db.exec('BEGIN IMMEDIATE');try{
   const before=this.nextTimestamp();this.ignoreForgottenSources(userId,accountId);this.rememberCutoff(userId,accountId,before);this.updateLedger(userId,true,accountId);
   if(accountId)this.db.prepare('INSERT INTO account_users(account_id,id,forgot,epoch) VALUES(?,?,1,?) ON CONFLICT(account_id,id) DO UPDATE SET forgot=1,epoch=MAX(epoch+1,excluded.epoch)').run(accountId,userId,before);
   else this.db.prepare('INSERT INTO users(id,forgot,epoch) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET forgot=1,epoch=MAX(epoch+1,excluded.epoch)').run(userId,before);
   this.erase(userId,accountId);
   if(!accountId)for(const account of this.knownAccounts(userId)){this.db.prepare('INSERT INTO account_users(account_id,id,forgot,epoch) VALUES(?,?,1,?) ON CONFLICT(account_id,id) DO UPDATE SET forgot=1,epoch=MAX(epoch+1,excluded.epoch)').run(account,userId,before);this.erase(userId,account);}
   this.db.exec('COMMIT');this.log('forget','用户记忆已删除并停止记录');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 remember(userId:string,accountId=''){
  this.db.exec('BEGIN IMMEDIATE');try{
   if(this.forgotten(userId,accountId)||(!accountId&&this.db.prepare('SELECT 1 FROM account_users WHERE id=? AND forgot=1 LIMIT 1').get(userId)))this.resumeRecording(userId,accountId);
   this.updateLedger(userId,false,accountId);
   if(accountId)this.db.prepare('INSERT INTO account_users(account_id,id,epoch) VALUES(?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET forgot=0,epoch=MAX(epoch+1,excluded.epoch)').run(accountId,userId,this.replayEpoch(userId,accountId,false));
   else this.db.prepare('INSERT INTO users(id,epoch) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET forgot=0,epoch=MAX(epoch+1,excluded.epoch)').run(userId,this.replayEpoch(userId,'',false));
   if(!accountId)this.db.prepare('UPDATE account_users SET forgot=0,epoch=MAX(epoch+1,?) WHERE id=?').run(this.replayEpoch(userId,'',false),userId);
   this.db.exec('COMMIT');this.log('remember','用户已恢复记忆记录');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 sentCount(channel:Channel,accountId?:string){return Number((this.db.prepare("SELECT count(*) AS n FROM messages WHERE channel=? AND status IN ('confirmed','sending','unknown') AND updated_at>?"+(accountId===undefined?'':' AND account_id=?')).get(...(accountId===undefined?[channel,Date.now()-3600000]:[channel,Date.now()-3600000,accountId])) as any).n);}
 logs(limit=100){return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);}
 stats(){return {messages:this.db.prepare('SELECT channel,status,count(*) AS count FROM messages GROUP BY channel,status').all(),usage:this.db.prepare('SELECT SUM(input_tokens) AS input,SUM(output_tokens) AS output,SUM(cache_read) AS cache FROM usage').get(),oldestQueued:(this.db.prepare("SELECT MIN(created_at) AS at FROM messages WHERE status='queued'").get() as any)?.at};}
 usage(input:number,output:number,cache:number){this.db.prepare('INSERT INTO usage(at,input_tokens,output_tokens,cache_read) VALUES(?,?,?,?)').run(Date.now(),input,output,cache);}
 prune(days:number){this.db.prepare("DELETE FROM messages WHERE created_at<? AND status NOT IN ('sending','unknown')").run(Date.now()-days*86400000);this.db.prepare('DELETE FROM logs WHERE at<?').run(Date.now()-30*86400000);}
}
