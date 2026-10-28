import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { eventIdentity } from './store.js';
import { applyMigration } from './migrations.js';
import type { Event,Channel } from './types.js';
import {effectiveAge,type ReplyClosure} from './reply-hours.js';

export type TriageTier='priority'|'normal'|'skip'|'filtered';
export type SkipCategory='harassment'|'spam'|'no_reply'|'other';
export type TriageSettings={normalMaxAgeHours:number;batchThreshold:number;advertisingKeywords:string[];greetings:string[];priorityPublicHandles:string[];priorityPrivateConversations:string[]};
export type TriageHistory={totalCount:number;processedCount:number;recentOtherConversation:boolean;batchCount?:number};
export type TriageResult={tier:TriageTier;reason:string};
export type TriageAgeOptions={ignoreAge?:boolean};
export const DEFAULT_TRIAGE_SETTINGS:TriageSettings={normalMaxAgeHours:3,batchThreshold:3,advertisingKeywords:['返利','代理','空投','airdrop','giveaway','加v','互关涨粉'],greetings:['hi','hello','hey','在吗','在么','你好','嗨','哈喽','早','早安','晚上好','晚安'],priorityPublicHandles:[],priorityPrivateConversations:[]};
export const TRIAGE_MIGRATION=`
 ALTER TABLE messages ADD COLUMN tier TEXT;
 ALTER TABLE messages ADD COLUMN tier_reason TEXT;
 ALTER TABLE messages ADD COLUMN merged_into TEXT;
 CREATE INDEX messages_account_triage ON messages(account_id,status,tier,created_at);
 CREATE INDEX messages_account_triage_history ON messages(account_id,user_id,channel,created_at);
 CREATE TABLE triage_ignores(account_id TEXT NOT NULL,user_id TEXT NOT NULL,channel TEXT NOT NULL,until INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL,strikes_json TEXT NOT NULL,PRIMARY KEY(account_id,user_id,channel));
 CREATE TABLE triage_text_hits(account_id TEXT NOT NULL,hash TEXT NOT NULL,user_id TEXT NOT NULL,at INTEGER NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(account_id,message_id));
 CREATE INDEX triage_text_window ON triage_text_hits(account_id,hash,at,user_id);
`;
const hour=3600000,day=24*hour;
const mentions=/@[a-z0-9_]+/gi;
const links=/(?:https?:\/\/|www\.)\S+/gi;
const stripMentions=(text:string)=>text.normalize('NFKC').replace(mentions,'').trim();
const normalized=(text:string)=>stripMentions(text).replace(links,'').replace(/[\s\p{P}\p{S}\p{M}\u200d\ufe0f]/gu,'').toLowerCase();
export function normalizeBatchText(text:string):string{return normalized(text);}
export function batchHash(text:string):string|null{const value=normalizeBatchText(text);return [...value].length<6?null:createHash('sha256').update(value).digest('hex').slice(0,32);}
export function normalizeSkipCategory(value:unknown):SkipCategory{return ['harassment','spam','no_reply','other'].includes(String(value))?value as SkipCategory:'other';}
export function normalizeTriageSettings(raw:Partial<TriageSettings>={},maxAgeHours=6):TriageSettings{
 const number=(key:'normalMaxAgeHours'|'batchThreshold',fallback:number,min:number,max:number)=>{const value=raw[key]??fallback;if(!Number.isInteger(value)||value<min||value>max)throw new Error('分级设置范围无效：'+key);return value;};
 const list=(key:'advertisingKeywords'|'greetings'|'priorityPublicHandles'|'priorityPrivateConversations')=>{const value=raw[key]??DEFAULT_TRIAGE_SETTINGS[key];if(!Array.isArray(value)||value.length>500||value.some(v=>typeof v!=='string'||!v.trim()||v.length>200))throw new Error('分级词表无效：'+key);return [...new Set(value.map(v=>key==='priorityPublicHandles'?v.trim().replace(/^@/,'').toLowerCase():key==='priorityPrivateConversations'?v.trim():v.normalize('NFKC').trim().toLowerCase()))];};
 const result={normalMaxAgeHours:number('normalMaxAgeHours',Math.min(3,maxAgeHours),1,maxAgeHours),batchThreshold:number('batchThreshold',3,2,20),advertisingKeywords:list('advertisingKeywords'),greetings:list('greetings'),priorityPublicHandles:list('priorityPublicHandles'),priorityPrivateConversations:list('priorityPrivateConversations')};
 if(result.priorityPublicHandles.some(v=>!/^\w{1,15}$/.test(v)))throw new Error('重点公开账号 handle 无效');return result;
}
export function classify(event:Event,history:TriageHistory,settings:TriageSettings=DEFAULT_TRIAGE_SETTINGS):TriageResult{
 const text=stripMentions(event.text),simple=text.replace(/[\s\p{P}\p{S}\p{M}\u200d\ufe0f]/gu,'').toLowerCase(),lower=text.toLowerCase();
 const keyword=settings.advertisingKeywords.some(k=>lower.includes(k.toLowerCase()));
 const advertisingText=normalized(text.replace(/#[^\s#]+/g,''));
 const keywordOnly=!!advertisingText&&settings.advertisingKeywords.some(k=>advertisingText===normalized(k));
 if((keyword&&/(?:https?:\/\/|www\.)\S+/i.test(text))||keywordOnly)return {tier:'filtered',reason:'广告关键词'};
 if((history.batchCount??0)>=settings.batchThreshold)return {tier:'filtered',reason:'批量刷量'};
 const priority=event.channel==='public'?settings.priorityPublicHandles.includes(event.handle.replace(/^@/,'').toLowerCase()):settings.priorityPrivateConversations.includes(event.conversationId);
 if(priority)return {tier:'priority',reason:'重点账号'};
 const greeting=!simple||([...simple].length<=6&&settings.greetings.some(g=>normalized(g)===simple));
 if(greeting)return history.totalCount>0?{tier:'skip',reason:'老面孔无内容招呼'}:{tier:'normal',reason:'新人招呼'};
 if(history.recentOtherConversation)return {tier:'normal',reason:'同一用户的后续消息'};
 if(history.processedCount>=3)return {tier:'priority',reason:'老朋友有内容的消息'};
 if(!history.totalCount)return {tier:'priority',reason:'首次来访'};
 if([...text].length>=20||/[?？]|怎么|为什么|如何|能不能|是不是|哪里|多少/.test(text))return {tier:'priority',reason:'较长或明确提问'};
 return {tier:'normal',reason:'普通交流'};
}
export function beijingDayStart(at:number):number{return Math.floor((at+8*hour)/day)*day-8*hour;}
function parseEvent(row:any):Event{return {...JSON.parse(row.body),id:row.id,accountId:row.account_id};}
function isReview(row:any):boolean{try{return JSON.parse(row.draft??'{}').review===true;}catch{return false;}}
export class TriageError extends Error{constructor(message:string,public statusCode=400){super(message);}}

/** 分级与调度只使用本地数据库，不触发模型或浏览器操作。 */
export class ReplyTriage{
 constructor(public store:Store,public settings:()=>TriageSettings=()=>DEFAULT_TRIAGE_SETTINGS,public now:()=>number=Date.now,public closures:()=>ReplyClosure[]=()=>[]){applyMigration(store.db,9,'回复分级与公平调度',TRIAGE_MIGRATION);}
 /** 与生产发送边界共享有效等待时间；独立试聊库默认没有关闭区间。 */
 age(receivedAt:number,at=this.now()){return effectiveAge(receivedAt,at,this.closures());}
 /** field 只能由内部只读查询提供，参数中保存时间边界，避免拼入外部输入。 */
 ageSql(field='m.created_at',at=this.now()):{sql:string;params:number[]}{
  const intervals=this.closures().filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end>x.start&&x.start<at).map(x=>({start:x.start,end:Math.min(at,x.end)})).sort((a,b)=>a.start-b.start),merged:ReplyClosure[]=[];
  for(const interval of intervals){const last=merged.at(-1);if(last&&interval.start<=last.end)last.end=Math.max(last.end,interval.end);else merged.push({...interval});}
  return {sql:'MAX(0,(? - '+field+')'+merged.map(()=>'- MAX(0,? - MAX('+field+',?))').join('')+')',params:[at,...merged.flatMap(x=>[x.end,x.start])]};
 }
 private transaction<T>(fn:()=>T):T{this.store.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.store.db.exec('COMMIT');return value;}catch(error){this.store.db.exec('ROLLBACK');throw error;}}
 private manualKey(id:string){return 'triage:manual:'+id;}
 private terminal(row:any,status:string,reason:string,extra:{mergedInto?:string}={}){
  const sequence=row.processed_seq||Math.max(Number(this.store.get('processedSequence','0')),Number((this.store.db.prepare('SELECT MAX(processed_seq) n FROM messages').get() as any).n??0))+1;
  this.store.set('processedSequence',String(Math.max(sequence,Number(this.store.get('processedSequence','0')))));
  this.store.db.prepare('UPDATE messages SET status=?,error=?,updated_at=?,processed_seq=?,merged_into=? WHERE id=? AND account_id=? AND status=\'queued\'').run(status,reason,this.now(),sequence,extra.mergedInto??null,row.id,row.account_id);
 }
 private history(event:Event,accountId:string):TriageHistory{
  const rows=this.store.db.prepare("SELECT id,status,created_at,body FROM messages WHERE account_id=? AND user_id=? AND channel=? AND id<>? AND created_at>=? AND status NOT IN ('filtered','ignored','merged')").all(accountId,event.userId,event.channel,event.id,this.now()-30*day) as any[];
  const other=event.channel==='public'&&rows.some(row=>{const prior=parseEvent(row);return prior.conversationId!==event.conversationId&&row.created_at>=this.now()-2*hour&&((row.status==='confirmed')||(row.status==='queued'&&row.created_at<event.timestamp));});
  return {totalCount:rows.length,processedCount:rows.filter(r=>['confirmed','draft','skipped','failed'].includes(r.status)).length,recentOtherConversation:other};
 }
 ignored(userId:string,channel:Channel,accountId:string):{until:number;reason:string}|null{
  const row=this.store.db.prepare('SELECT until,reason FROM triage_ignores WHERE account_id=? AND user_id=? AND channel=?').get(accountId,userId,channel) as any;return row&&row.until>this.now()?row:null;
 }
 private hit(event:Event,accountId:string,observedAt=Math.min(this.now(),event.timestamp)){
  this.store.db.prepare('DELETE FROM triage_text_hits WHERE at<?').run(this.now()-hour);
  const hash=batchHash(event.text);if(!hash||!Number.isFinite(observedAt)||observedAt<=0||event.timestampReliable===false||observedAt<this.now()-hour)return {hash:null,count:0};
  this.store.db.prepare('INSERT OR IGNORE INTO triage_text_hits(account_id,hash,user_id,at,message_id) VALUES(?,?,?,?,?)').run(accountId,hash,event.userId,observedAt,event.id);
  const count=Number((this.store.db.prepare('SELECT count(DISTINCT user_id) n FROM triage_text_hits WHERE account_id=? AND hash=? AND at>=?').get(accountId,hash,this.now()-hour) as any).n);return {hash,count};
 }
 private apply(row:any,maxAgeHours=6){
  row=this.store.getMessage(row.id,row.account_id);if(!row||row.status!=='queued')return;
  const event=parseEvent(row),accountId=row.account_id;
  if(this.store.get(this.manualKey(row.id))==='1'||isReview(row)){
   this.store.db.prepare("UPDATE messages SET tier='priority',tier_reason=?,merged_into=NULL WHERE id=? AND status='queued'").run(isReview(row)?'管理员请求重写':'管理员重新排队',row.id);return;
  }
  const ignored=this.ignored(event.userId,event.channel,accountId);
  if(ignored){this.store.db.prepare("UPDATE messages SET tier='skip',tier_reason='骚扰冷却' WHERE id=?").run(row.id);this.terminal(row,'ignored','骚扰冷却');return;}
  const settings=normalizeTriageSettings(this.settings(),maxAgeHours),hit=this.hit(event,accountId,Math.min(this.now(),row.created_at)),result=classify(event,{...this.history(event,accountId),batchCount:hit.count},settings);
  this.store.db.prepare('UPDATE messages SET tier=?,tier_reason=? WHERE id=? AND status=\'queued\'').run(result.tier,result.reason,row.id);
  if(result.tier==='filtered')this.terminal(row,'filtered',result.reason);
  else if(result.tier==='skip')this.terminal(row,'skipped',result.reason);
  if(hit.hash&&hit.count>=settings.batchThreshold){
   const matching=this.store.db.prepare("SELECT m.* FROM messages m JOIN triage_text_hits h ON h.message_id=m.id AND h.account_id=m.account_id WHERE h.account_id=? AND h.hash=? AND h.at>=? AND m.status='queued'").all(accountId,hit.hash,this.now()-hour) as any[];
   for(const other of matching){if(this.store.get(this.manualKey(other.id))==='1'||isReview(other))continue;this.store.db.prepare("UPDATE messages SET tier='filtered',tier_reason='批量刷量' WHERE id=?").run(other.id);this.terminal(other,'filtered','批量刷量');}
  }
 }
 ingest(event:Event,accountId=event.accountId??'',maxAgeHours=6):boolean{
  return this.transaction(()=>{if(!this.store.ingest(event,accountId))return false;const id=accountId?eventIdentity(accountId,event.channel,event.platformId||event.id):event.id;this.apply(this.store.getMessage(id,accountId),maxAgeHours);return true;});
 }
 /** 管理员补录与普通采集共用身份、遗忘和去重；优先标记与入库原子提交。 */
 ingestManual(event:Event,accountId=event.accountId??'',maxAgeHours=6):boolean{
  return this.transaction(()=>{
   if(event.channel!=='public'||!event.platformId||!/^\d+$/.test(event.platformId)||event.timestampReliable!==true||!Number.isFinite(event.timestamp)||event.timestamp<=0||event.timestamp>this.now()+60000||this.now()-event.timestamp>maxAgeHours*hour)return false;
   if(!this.store.ingest(event,accountId))return false;
   const id=accountId?eventIdentity(accountId,event.channel,event.platformId||event.id):event.id;
   this.store.set(this.manualKey(id),'1');
   this.store.db.prepare("UPDATE messages SET tier='priority',tier_reason='管理员补录',merged_into=NULL WHERE id=? AND account_id=? AND status='queued'").run(id,accountId);
   return true;
  });
 }
 refreshQueued(accountId:string,maxAgeHours=6,_options:TriageAgeOptions={}){
  // 先注册全部滑动窗口命中，再统一分类；旧库首轮与名单变动均可重新计算。
  this.transaction(()=>{const rows=this.store.db.prepare("SELECT * FROM messages WHERE status='queued' AND account_id=? ORDER BY created_at,id").all(accountId) as any[];for(const row of rows)this.hit(parseEvent(row),accountId,Math.min(this.now(),row.created_at));for(const row of rows)this.apply(row,maxAgeHours);});
 }
 private forgottenScopeSQL(){return "NOT EXISTS(SELECT 1 FROM account_users au WHERE au.account_id=m.account_id AND au.id=m.user_id AND au.forgot=1) AND (NOT EXISTS(SELECT 1 FROM users u WHERE u.id=m.user_id AND u.forgot=1) OR EXISTS(SELECT 1 FROM account_users au WHERE au.account_id=m.account_id AND au.id=m.user_id AND au.epoch>0 AND au.forgot=0))";}
 queuedEligibility(maxAgeHours:number,options:TriageAgeOptions={}){
  const now=this.now(),settings=normalizeTriageSettings(this.settings(),maxAgeHours),age=this.ageSql();
  return {sql:"m.created_at>0 AND "+(options.ignoreAge?'':age.sql+"<=(CASE m.tier WHEN 'priority' THEN ? ELSE ? END) AND ")+"NOT EXISTS(SELECT 1 FROM triage_ignores i WHERE i.account_id=m.account_id AND i.user_id=m.user_id AND i.channel=m.channel AND i.until>? AND NOT EXISTS(SELECT 1 FROM runtime r WHERE r.key='triage:manual:'||m.id AND r.value='1') AND NOT (CASE WHEN json_valid(m.draft) THEN COALESCE(json_extract(m.draft,'$.review'),0) ELSE 0 END)) AND "+this.forgottenScopeSQL(),params:[...(options.ignoreAge?[]:[...age.params,maxAgeHours*hour,settings.normalMaxAgeHours*hour]),now]};
 }
 /** 健康观察只读相同可处理范围；不清理过期行、不重分级、不触发模型。 */
 healthQueue(accountId:string,maxAgeHours=6,options:TriageAgeOptions={}):Partial<Record<Channel,{count:number;oldestAt:number|null}>>{
  const eligible=this.queuedEligibility(maxAgeHours,options),age=this.ageSql();
  const rows=this.store.db.prepare("SELECT m.channel,COUNT(*) AS count,MIN(m.created_at) AS oldestAt FROM messages m WHERE m.account_id=? AND ((m.status='queued' AND "+eligible.sql+") OR (m.status='approved' AND m.created_at>0 AND "+(options.ignoreAge?'':age.sql+'<=? AND ')+this.forgottenScopeSQL()+")) GROUP BY m.channel").all(accountId,...eligible.params,...(options.ignoreAge?[]:[...age.params,maxAgeHours*hour])) as Array<{channel:Channel;count:number;oldestAt:number|null}>;
  const result:Partial<Record<Channel,{count:number;oldestAt:number|null}>>={};for(const row of rows)if(row.channel==='public'||row.channel==='private')result[row.channel]={count:row.count,oldestAt:row.oldestAt};return result;
 }
 pending(limit:number,accountId:string,channels:Channel[],maxAgeHours=6,options:TriageAgeOptions={}):any[]{
  const selected=[...new Set(channels.filter(c=>c==='public'||c==='private'))];if(!selected.length||!Number.isFinite(limit)||limit<1)return [];
  const settings=normalizeTriageSettings(this.settings(),maxAgeHours),cap=Math.min(100,Math.floor(limit)),now=this.now();
  const base="FROM messages m WHERE m.status='queued' AND m.account_id=? AND m.channel IN ("+selected.map(()=>'?').join(',')+")";
  const age=this.ageSql('m.created_at',now),cutoff="(CASE m.tier WHEN 'priority' THEN ? ELSE ? END)",params=[accountId,...selected,...age.params,maxAgeHours*hour,settings.normalMaxAgeHours*hour];
  // 过期清理有界；查询直接排除全部过期条目，避免大量旧优先消息挡住有效普通消息。
  const expired=options.ignoreAge?[]:this.store.db.prepare('SELECT m.* '+base+' AND (m.created_at<=0 OR '+age.sql+'>'+cutoff+') ORDER BY m.created_at,m.id LIMIT ?').all(...params,cap*9) as any[];
  for(const row of expired)this.terminal(row,'skipped',row.tier==='priority'?'优先消息超过处理时效':'普通消息超过处理时效');
  const eligible=this.queuedEligibility(maxAgeHours,options);
  const rows=this.store.db.prepare('SELECT m.* '+base+' AND '+eligible.sql+" ORDER BY CASE WHEN json_valid(m.draft) THEN COALESCE(json_extract(m.draft,'$.review'),0) ELSE 0 END DESC,CASE m.tier WHEN 'priority' THEN 0 ELSE 1 END,m.created_at DESC,m.id DESC LIMIT ?").all(accountId,...selected,...eligible.params,cap) as any[];
  return rows;
 }
 /** 同一批候选在开始生成前调用；返回实际最新目标与其先前消息。 */
 merge(row:any,accountId:string):{row:any;context:Event[]}{
  row=this.store.getMessage(row.id,accountId)??row;
  if(row.channel!=='public'||row.status!=='queued'||isReview(row))return {row,context:[]};
  const event=parseEvent(row);if(!event.conversationId||event.timestampReliable===false||!Number.isFinite(event.timestamp)||event.timestamp<=0)return {row,context:[]};
  return this.transaction(()=>{
   const e=parseEvent(row),candidates=(this.store.db.prepare("SELECT * FROM messages WHERE account_id=? AND user_id=? AND channel='public' AND status='queued' AND created_at BETWEEN ? AND ? ORDER BY created_at DESC,id DESC").all(accountId,e.userId,e.timestamp-30*60000,e.timestamp+30*60000) as any[]).filter(r=>{const other=parseEvent(r);return !isReview(r)&&other.conversationId===e.conversationId&&other.timestampReliable!==false&&r.platform_id;});
   if(!candidates.length)return {row,context:[]};const latest=candidates[0],windowStart=latest.created_at-30*60000,earlier=candidates.filter(r=>r.id!==latest.id&&r.created_at>=windowStart);
   for(const old of earlier)this.terminal(old,'merged','同会话多条消息已合并',{mergedInto:latest.id});
   return {row:latest,context:earlier.reverse().map(parseEvent)};
  });
 }
 consumed(id:string){this.store.db.prepare('DELETE FROM runtime WHERE key=?').run(this.manualKey(id));}
 recordSkip(event:Event,accountId:string,category:unknown):{ignoredUntil:number|null;strikes:number}{
  if(normalizeSkipCategory(category)!=='harassment')return {ignoredUntil:null,strikes:0};
  const row=this.store.db.prepare('SELECT strikes_json,until FROM triage_ignores WHERE account_id=? AND user_id=? AND channel=?').get(accountId,event.userId,event.channel) as any;
  let old:unknown=[];try{old=JSON.parse(row?.strikes_json??'[]');}catch{}
  const strikes=Array.isArray(old)?old.filter(v=>Number.isFinite(v)&&v>this.now()-day&&v<=this.now()):[];strikes.push(this.now());const until=strikes.length>=3?this.now()+day:Number(row?.until??0);
  this.store.db.prepare('INSERT INTO triage_ignores(account_id,user_id,channel,until,reason,strikes_json) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,user_id,channel) DO UPDATE SET until=excluded.until,reason=excluded.reason,strikes_json=excluded.strikes_json').run(accountId,event.userId,event.channel,until,'骚扰冷却',JSON.stringify(strikes.slice(-3)));
  this.store.log('triage-harassment',JSON.stringify({accountId,userId:event.userId,channel:event.channel,strikes:strikes.length,until:until||null}));return {ignoredUntil:until>this.now()?until:null,strikes:strikes.length};
 }
 clearIgnore(userId:string,channel:Channel,accountId:string){this.store.db.prepare('DELETE FROM triage_ignores WHERE account_id=? AND user_id=? AND channel=?').run(accountId,userId,channel);this.store.log('triage-unignore',JSON.stringify({accountId,userId,channel}));return {ok:true};}
 ignores(accountId:string){return this.store.db.prepare('SELECT user_id AS userId,channel,until,reason FROM triage_ignores WHERE account_id=? AND until>? ORDER BY until DESC').all(accountId,this.now());}
 requeue(id:string,accountId:string){return this.transaction(()=>{
  const row=this.store.getMessage(id,accountId);if(!row)throw new TriageError('消息不存在',404);
  if(['sending','unknown','confirmed','approved','generating'].includes(row.status))throw new TriageError('该消息不可重新排队；发送结果未知时请先回查',409);
  const hasOutbox=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox'").get();
  if(hasOutbox&&this.store.db.prepare("SELECT 1 FROM outbox WHERE account_id=? AND source_id=? AND status IN ('submitting','unknown','confirmed','rejected','cancelled')").get(accountId,row.id))throw new TriageError('已有冻结出站记录，不能重新排队',409);
  if(this.store.forgotten(row.user_id,accountId))throw new TriageError('用户已遗忘，不能重新排队',409);
  this.store.set(this.manualKey(row.id),'1');this.store.db.prepare("UPDATE messages SET status='queued',tier='priority',tier_reason='管理员重新排队',merged_into=NULL,error=NULL,updated_at=? WHERE id=? AND account_id=?").run(this.now(),row.id,accountId);
  this.store.log('triage-requeue',JSON.stringify({id:row.id,accountId,channel:row.channel}));return {ok:true,id:row.id,status:'queued'};
 });}
 dailyCount(accountId:string,at=this.now()):number{
  const start=beijingDayStart(at),end=start+day,hasOutbox=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox'").get();
  const outbox=hasOutbox?Number((this.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE account_id=? AND channel='public' AND status IN ('confirmed','submitting','unknown') AND submitted_at>=? AND submitted_at<?").get(accountId,start,end) as any).n):0;
  const legacy=Number((this.store.db.prepare("SELECT COUNT(*) n FROM messages m WHERE account_id=? AND channel='public' AND status IN ('confirmed','sending','unknown') AND updated_at>=? AND updated_at<?"+(hasOutbox?' AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.account_id=m.account_id AND o.source_id=m.id)':'')).get(accountId,start,end) as any).n);return outbox+legacy;
 }
 privateRecentCount(accountId:string,at=this.now()):number{
  const start=at-day,hasOutbox=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox'").get();
  const outbox=hasOutbox?Number((this.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE account_id=? AND channel='private' AND status IN ('confirmed','submitting','unknown') AND submitted_at>? AND submitted_at<=?").get(accountId,start,at) as any).n):0;
  const legacy=Number((this.store.db.prepare("SELECT COUNT(*) n FROM messages m WHERE m.account_id=? AND m.channel='private' AND m.status IN ('confirmed','sending','unknown') AND m.updated_at>? AND m.updated_at<=?"+(hasOutbox?' AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.account_id=m.account_id AND o.source_id=m.id)':'')).get(accountId,start,at) as any).n);return outbox+legacy;
 }
 allowedChannels(input:{accountId:string;mode:'draft'|'auto';publicPerHour:number;privatePerHour:number;publicPerDay:number;privatePerDay?:number;privateRecentCount?:(accountId:string)=>number;cooldown:(channel:Channel)=>number;hourlyCount:(channel:Channel)=>number;unknown:(channel:Channel)=>boolean}):Channel[]{return (['public','private'] as Channel[]).filter(channel=>input.cooldown(channel)<=this.now()&&!input.unknown(channel)&&(input.mode==='draft'||(input.hourlyCount(channel)<(channel==='public'?input.publicPerHour:input.privatePerHour)&&(channel==='public'?this.dailyCount(input.accountId)<input.publicPerDay:(input.privateRecentCount?.(input.accountId)??this.privateRecentCount(input.accountId))<(input.privatePerDay??400)))));}
 summary(accountId:string,publicPerDay=180,privatePerDay=400){const start=beijingDayStart(this.now());return {queues:this.store.db.prepare("SELECT channel,COALESCE(tier,'normal') AS tier,COUNT(*) AS count,MIN(created_at) AS oldestAt FROM messages WHERE account_id=? AND status='queued' GROUP BY channel,tier").all(accountId),today:this.store.db.prepare("SELECT status,COUNT(*) AS count FROM messages WHERE account_id=? AND status IN ('filtered','merged','ignored') AND updated_at>=? GROUP BY status").all(accountId,start),reasons:this.store.db.prepare("SELECT status,COALESCE(tier_reason,error,'') AS reason,COUNT(*) AS count FROM messages WHERE account_id=? AND status IN ('filtered','merged','ignored','skipped') AND updated_at>=? GROUP BY status,reason").all(accountId,start),publicToday:this.dailyCount(accountId),publicPerDay,privateRecent:this.privateRecentCount(accountId),privatePerDay,ignores:this.ignores(accountId),now:this.now()};}
}
