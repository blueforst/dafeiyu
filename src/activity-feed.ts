import type { Store } from './store.js';
import { applyMigration } from './migrations.js';
import { Outbox } from './outbox.js';
import { normalizePublicText,validatePostingText } from './posting-policy.js';
import type { PostingCapabilitiesService } from './posting-capabilities.js';
import type { ReplyTriage } from './reply-triage.js';
import { formatIssues } from './reply-style.js';

export class FeedError extends Error {constructor(message:string,public statusCode=400,public current?:string){super(message);}}
const parse=(value:any,fallback:any={})=>{try{return JSON.parse(value??'null')??fallback;}catch{return fallback;}};
const sortTime="CASE WHEN m.ingested_at>0 THEN m.ingested_at ELSE m.created_at END";
type ConversationQuery={filter?:string;cursor?:string;limit?:number;changedSince?:number};
type ConversationItemsQuery={before?:string;limit?:number;changedSince?:number};
const encodeCursor=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(value:unknown,field:'key'|'id'):{at:number;key?:string;id?:string;snapshotAt?:number}|undefined {
 if(value===undefined)return undefined;
 try{if(typeof value!=='string'||!value||value.length>2000||!/^[\w-]+$/.test(value))throw Error();const result=JSON.parse(Buffer.from(value,'base64url').toString());if(!result||!Number.isSafeInteger(result.at)||result.at<0||typeof result[field]!=='string'||!result[field]||result[field].length>1000||result.snapshotAt!==undefined&&(!Number.isSafeInteger(result.snapshotAt)||result.snapshotAt<result.at))throw Error();return result;}catch{throw new FeedError('会话游标无效');}
}
function readLimit(value:unknown){if(value!==undefined&&(!['number','string'].includes(typeof value)||!Number.isSafeInteger(Number(value))||Number(value)<1))throw new FeedError('会话分页数量必须为正整数');return Math.min(100,Number(value??30));}
function changedTime(value:unknown){if(value===undefined)return undefined;if(!['number','string'].includes(typeof value)||value===''||!Number.isSafeInteger(Number(value))||Number(value)<0)throw new FeedError('会话变化时间无效');return Number(value);}
/** 读写均以当前工作账号为边界；时间游标不受后来入库的条目影响。 */
export class ActivityFeed {
 constructor(public store:Store,public account:()=>string,public maxAgeHours:()=>number,public capabilities?:PostingCapabilitiesService,public triage?:ReplyTriage,public importsSummary?:(account:string)=>{latest:number;pending:number}){
  applyMigration(store.db,12,'动态时间线索引',`CREATE INDEX IF NOT EXISTS messages_account_created ON messages(account_id,created_at,id); CREATE INDEX IF NOT EXISTS messages_account_channel_updated ON messages(account_id,channel,updated_at); CREATE INDEX IF NOT EXISTS outbox_account_created ON outbox(account_id,kind,created_at,id);`);
 }
 expired(row:any,now=Date.now()){if(!['draft','approved'].includes(row.status))return false;const e=parse(row.body);return !Number.isFinite(e.timestamp)||(this.triage?this.triage.age(e.timestamp,now):now-e.timestamp)>this.maxAgeHours()*3600000;}
 private freshness(now:number){const field="json_extract(m.body,'$.timestamp')",age=this.triage?.ageSql(field,now)??{sql:`(?-${field})`,params:[now]};return {sql:`json_valid(m.body) AND json_type(m.body,'$.timestamp') IN ('integer','real') AND ${age.sql}<=?`,params:[...age.params,this.maxAgeHours()*3600000]};}
 private pendingSql(now:number):{sql:string;params:Array<number|string>}{
  const fresh=this.freshness(now);
  // 分级入队与动态待处理共享同一只读资格查询，避免复制普通/优先时效与忽略规则。
  const queued=this.triage?.queuedEligibility(this.maxAgeHours(),{},now)??{sql:fresh.sql+" AND json_valid(m.draft) AND json_extract(m.draft,'$.review')=1",params:fresh.params};
  // 显式CASE保持懒计算：已确认等无待处理状态不重复计算周期或扫描历史差量。
  return {sql:`(CASE WHEN m.status='unknown' THEN 1 WHEN m.status IN ('draft','approved','failed') THEN CASE WHEN ${fresh.sql} THEN 1 ELSE 0 END WHEN m.status='queued' THEN CASE WHEN ${queued.sql} THEN 1 ELSE 0 END ELSE 0 END)=1`,params:[...fresh.params,...queued.params]};
 }
 private summaryFor(account:string,pending:{sql:string;params:Array<number|string>},messageSummary?:{latest:number;pending:number}){
  const m=messageSummary??this.store.db.prepare(`SELECT MAX(m.updated_at) latest,SUM(CASE WHEN ${pending.sql} THEN 1 ELSE 0 END) pending FROM messages m WHERE m.account_id=?`).get(...pending.params,account) as any;
  const p=this.store.db.prepare("SELECT MAX(updated_at) latest,SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) pending FROM outbox WHERE account_id=? AND kind='post'").get(account) as any;
  const imports=this.importsSummary?.(account)??{latest:0,pending:0};
  const task=this.hasTaskRuns()?this.store.db.prepare("SELECT MAX(MAX(started_at,COALESCE(finished_at,0))) latest FROM task_runs WHERE account_id=? AND task_id IN ('morning-post','evening-post')").get(account) as any:null;
  return {latest:Math.max(Number(m.latest??0),Number(p.latest??0),Number(task?.latest??0),imports.latest),pending:Number(m.pending??0)+Number(p.pending??0)+imports.pending};
 }
 summary(){const account=this.account();return account?this.summaryFor(account,this.pendingSql(Date.now())):{latest:0,pending:0};}
 private hasTaskRuns(){return !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_runs'").get();}
 private messageItem(r:any,now=Date.now()){
  const body=parse(r.body),draft=parse(r.draft),receipt=parse(r.receipt,null),sortAt=Number(r.ingested_at||r.created_at);
  return {id:'message:'+r.id,messageId:r.id,type:r.channel==='public'?'reply':'dm',at:r.created_at,sortAt,updatedAt:r.updated_at,submittedAt:r.submitted_at??null,status:r.status,revision:r.updated_at,expired:this.expired(r,now),handle:body.handle??'',userId:r.user_id,original:body.text,originalUrl:body.url,body,draft,text:draft.text??'',receipt,error:r.error,tier:r.tier??null,tierReason:r.tier_reason??null,memory:{account:r.account_id,userId:r.user_id,channel:r.channel}};
 }
 private postRows(account:string){
  const join=this.hasTaskRuns()?"LEFT JOIN task_runs t ON t.id=(SELECT id FROM task_runs WHERE outbox_id=o.id AND account_id=o.account_id ORDER BY started_at DESC,id DESC LIMIT 1)":"";
  const rows=this.store.db.prepare(`SELECT o.*${join?',t.id run_id,t.task_id':''} FROM outbox o ${join} WHERE o.account_id=? AND o.kind='post'`).all(account) as any[];
  return rows.map(r=>({id:'post:'+r.id,outboxId:r.id,type:'post',at:r.created_at,sortAt:r.created_at,updatedAt:r.updated_at,submittedAt:r.submitted_at??null,status:r.status,revision:r.updated_at,expired:false,text:r.text,receipt:parse(r.receipt,null),validation:parse(r.validation_json,null),taskId:r.task_id??null,runId:r.run_id??null,error:r.error??null,format:r.run_id?parse(this.store.get('task-result:'+r.run_id),null)?.format:undefined,memory:null,tier:null,tierReason:null}));
 }
 private taskItems(account:string){
  if(!this.hasTaskRuns())return [];
  const rows=this.store.db.prepare("SELECT * FROM task_runs WHERE account_id=? AND task_id IN ('morning-post','evening-post') AND outbox_id IS NULL").all(account) as any[];
  return rows.map(r=>({id:'task:'+r.id,type:'post',taskOnly:true,taskId:r.task_id,runId:r.id,at:r.started_at,sortAt:r.started_at,updatedAt:Math.max(r.started_at,r.finished_at??0),status:r.status,revision:Math.max(r.started_at,r.finished_at??0),expired:false,text:r.detail??'',error:r.error??null,receipt:parse(r.receipt,null),callIds:parse(r.call_ids,[]),memory:null,tier:null,tierReason:null}));
 }
 private conversationSource(account:string,now:number,snapshotAt?:number,changedSince?:number){
  const pending=this.pendingSql(now),fresh=this.freshness(now),previous=changedSince!==undefined&&changedSince<now?this.pendingSql(changedSince):undefined;
  // 时序是非负毫秒；固定宽度的前缀保留(时间,id)顺序，一次分组取两种优先条目。
  const sql=`WITH source AS MATERIALIZED (
   SELECT m.id,m.user_id,m.channel,m.updated_at,m.status,${sortTime} sort_at,CASE WHEN ${pending.sql} THEN 1 ELSE 0 END pending_item,
    CASE WHEN m.status='generating' OR (m.status='queued' AND (CASE WHEN json_valid(m.draft) THEN json_extract(m.draft,'$.review') ELSE 0 END)=1) THEN CASE WHEN ${fresh.sql} THEN 1 ELSE 0 END ELSE 0 END fresh_item,
    CASE WHEN m.status='queued' AND json_valid(m.draft) THEN COALESCE(json_extract(m.draft,'$.review'),0) ELSE 0 END review_item${previous?`,CASE WHEN ${previous.sql} THEN 1 ELSE 0 END previous_pending_item`:''}
   FROM messages m WHERE m.account_id=?${snapshotAt===undefined?'':` AND ${sortTime}<=?`}
  ), candidate AS MATERIALIZED (
   SELECT *,CASE WHEN status='unknown' THEN 1 WHEN status='failed' AND pending_item=1 THEN 2
    WHEN (status='draft' AND pending_item=1) OR (status='queued' AND review_item=1 AND fresh_item=1) THEN 3
    WHEN status='approved' AND pending_item=1 THEN 4 WHEN (status='queued' AND pending_item=1) OR (status='generating' AND fresh_item=1) THEN 5 ELSE 6 END attention_rank FROM source
  ), grouped AS (
   SELECT user_id,substr(MAX(printf('%020d:',sort_at)||id),22) latest_id,
    substr(MAX(printf('%02d%020d:',99-attention_rank,sort_at)||id),24) important_id,
    MAX(sort_at) sort_at,SUM(pending_item) pending_count,MAX(MAX(updated_at,sort_at)) changed_at,MAX(updated_at) latest_update,MIN(sort_at) first_at,COUNT(*) total,
    MAX(${previous?'CASE WHEN pending_item<>previous_pending_item THEN 1 ELSE 0 END':'0'}) temporal_changed
   FROM candidate GROUP BY user_id
  ) SELECT grouped.*,content.channel,content.body,content.draft,important.status important_status FROM grouped JOIN messages content ON content.id=grouped.latest_id JOIN messages important ON important.id=grouped.important_id`;
  return {sql,params:[...pending.params,...fresh.params,...(previous?.params??[]),account,...(snapshotAt===undefined?[]:[snapshotAt])]};
 }
 /** 服务器隔离性能验收使用与实际会话查询完全相同的语句。 */
 conversationQueryPlan(){const query=this.conversationSource(this.account(),Date.now());return this.store.db.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.params);}
 /** 会话列表只查询当前账号；状态和待处理口径与旧动态共享。 */
 conversations(query:ConversationQuery={}){
  const filter=query.filter??'all';if(!['all','pending','public','private','posts'].includes(filter))throw new FeedError('会话筛选无效');
  const limit=readLimit(query.limit),since=changedTime(query.changedSince),cursor=decodeCursor(query.cursor,'key'),serverTime=Date.now(),account=this.account();
  if(!account)return {items:[],nextCursor:null,pending:0,importsPending:0,serverTime,latest:0,removedKeys:[]};
  const pending=this.pendingSql(serverTime),snapshotAt=since===undefined?cursor?.snapshotAt:undefined,source=this.conversationSource(account,serverTime,snapshotAt,since),rows=this.store.db.prepare(source.sql).all(...source.params) as any[],temporalKeys=new Set(rows.filter(r=>r.temporal_changed===1).map(r=>r.user_id));
  const all:any[]=rows.map(r=>{const body=parse(r.body),draft=parse(r.draft),key=r.user_id,handle=body.handle??'',title=r.channel==='private'?'私信 · '+String(key).slice(-4):handle?'@'+handle:key;
   return {key,channel:r.channel,title,handle,latestAt:r.sort_at,status:r.important_status,pending:Number(r.pending_count),preview:String(draft.text||body.text||'').slice(0,80),avatar:title.replace(/^[@\s]+/,'').slice(0,1)||'聊',firstAt:r.first_at,total:r.total,changedAt:r.changed_at};});
  const posts=[...this.postRows(account),...this.taskItems(account)].filter(r=>snapshotAt===undefined||r.sortAt<=snapshotAt).sort((a,b)=>b.sortAt-a.sortAt||(a.id<b.id?1:a.id>b.id?-1:0));
  if(posts.length){const latest=posts[0];all.push({key:'posts',channel:'posts',title:'角色帖',handle:'',latestAt:latest.sortAt,status:posts.some(r=>r.status==='unknown')?'unknown':latest.status,pending:posts.filter(r=>!('taskOnly' in r)&&r.status==='unknown').length,preview:String(latest.text??'').slice(0,80),avatar:'角',firstAt:Math.min(...posts.map(r=>r.sortAt)),total:posts.length,changedAt:Math.max(...posts.map(r=>r.updatedAt))});}
  const changed=since===undefined?all:all.filter(r=>r.changedAt>=since||r.latestAt>=since||temporalKeys.has(r.key)),matches=(r:any)=>filter==='all'||filter==='pending'&&r.pending>0||filter==='posts'&&r.key==='posts'||filter===r.channel;
  // 时效流逝本身不更新 messages.updated_at；待处理增量仍须移除已自然过期的已加载会话。
  const removedKeys=since===undefined?[]:(filter==='pending'?all:changed).filter(r=>!matches(r)).map(r=>r.key);
  let filtered=changed.filter(matches).sort((a,b)=>b.latestAt-a.latestAt||(a.key<b.key?1:a.key>b.key?-1:0));
  if(cursor&&since===undefined)filtered=filtered.filter(r=>r.latestAt<cursor.at||r.latestAt===cursor.at&&r.key<cursor.key!);
  const messageSummary=snapshotAt===undefined?rows.reduce((value,row)=>({latest:Math.max(value.latest,Number(row.latest_update)),pending:value.pending+Number(row.pending_count)}),{latest:0,pending:0}):undefined;
  const page=since===undefined?filtered.slice(0,limit):filtered,last=page.at(-1),summary=this.summaryFor(account,pending,messageSummary),imports=this.importsSummary?.(account)??{pending:0};
  const pageSnapshot=snapshotAt??all.reduce((max,r)=>Math.max(max,r.latestAt),0);
  return {items:page,nextCursor:since===undefined&&filtered.length>limit&&last?encodeCursor({at:last.latestAt,key:last.key,snapshotAt:pageSnapshot}):null,pending:summary.pending,importsPending:imports.pending,serverTime,latest:summary.latest,removedKeys};
 }
 /** 单会话按稳定入库时间翻页，增量读取忽略分页游标，不写入任何业务记录。 */
 conversationItems(key:string,query:ConversationItemsQuery={}){
  if(typeof key!=='string'||key.length>1000||!(key==='posts'||/^x:[A-Za-z0-9_]{1,15}$/.test(key)||/^dm:[^\s\u0000-\u001f]{1,990}$/.test(key)))throw new FeedError('会话标识无效');
  const limit=readLimit(query.limit),since=changedTime(query.changedSince),before=decodeCursor(query.before,'id'),serverTime=Date.now(),account=this.account();
  if(!account)return {items:[],nextBefore:null,nextCursor:null,total:0,firstAt:null,serverTime,latest:0,conversation:null};
  let items:any[],total=0,firstAt:number|null=null;
  if(key==='posts'){
   items=[...this.postRows(account),...this.taskItems(account)];total=items.length;firstAt=total?Math.min(...items.map(r=>r.sortAt)):null;
   if(since!==undefined)items=items.filter(r=>r.updatedAt>=since||r.sortAt>=since);
   else if(before)items=items.filter(r=>r.sortAt<before.at||r.sortAt===before.at&&r.id<before.id!);
   items.sort((a,b)=>b.sortAt-a.sortAt||(a.id<b.id?1:a.id>b.id?-1:0));
  }else{
   const summary=this.store.db.prepare(`SELECT COUNT(*) total,MIN(${sortTime}) first_at FROM messages m WHERE m.account_id=? AND m.user_id=?`).get(account,key) as any;total=Number(summary.total);firstAt=summary.first_at??null;
   const args:any[]=[account,key],where=['m.account_id=?','m.user_id=?'];
   if(since!==undefined){
    const wasFresh=this.freshness(since),fresh=this.freshness(serverTime);
    // 草稿的自然过期不会推进 updated_at；增量仍返回刚越过时效边界的原条目。
    where.push(`(m.updated_at>=? OR ${sortTime}>=? OR (m.status IN ('draft','approved') AND (${wasFresh.sql}) AND NOT (${fresh.sql})))`);args.push(since,since,...wasFresh.params,...fresh.params);
   }
   else if(before){where.push(`(${sortTime}<? OR (${sortTime}=? AND ('message:'||m.id)<?))`);args.push(before.at,before.at,before.id);}
   const sql=`SELECT m.*,(SELECT o.submitted_at FROM outbox o WHERE o.account_id=m.account_id AND o.kind=CASE m.channel WHEN 'private' THEN 'dm' ELSE 'reply' END AND o.source_id=m.id) submitted_at FROM messages m WHERE ${where.join(' AND ')} ORDER BY ${sortTime} DESC,m.id DESC${since===undefined?' LIMIT ?':''}`;
   if(since===undefined)args.push(limit+1);
   items=(this.store.db.prepare(sql).all(...args) as any[]).map(r=>this.messageItem(r,serverTime));
  }
  const page=since===undefined?items.slice(0,limit):items,oldest=page.at(-1),nextBefore=since===undefined&&items.length>limit&&oldest?encodeCursor({at:oldest.sortAt,id:oldest.id}):null;
  const summary=this.summaryFor(account,this.pendingSql(serverTime));
  return {items:page.reverse(),nextBefore,nextCursor:nextBefore,total,firstAt,serverTime,latest:summary.latest,conversation:{key,channel:key==='posts'?'posts':key.startsWith('dm:')?'private':'public'}};
 }
 list(query:{filter?:string;cursor?:string;limit?:number}={}){
  const filter=query.filter??'all';if(!['all','pending','reply','dm','post'].includes(filter))throw new FeedError('动态筛选无效');
  if(query.limit!==undefined&&(!Number.isSafeInteger(Number(query.limit))||Number(query.limit)<1))throw new FeedError('动态分页数量必须为正整数');
  const limit=Math.min(100,Number(query.limit??30)),account=this.account();
  if(!account)return {items:[],nextCursor:null,pending:0};
  let cursor:{at:number;id:string}|undefined;
  if(query.cursor){try{if(typeof query.cursor!=='string'||query.cursor.length>2000)throw Error();cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(!cursor||!Number.isSafeInteger(cursor.at)||cursor.at<0||typeof cursor.id!=='string'||cursor.id.length>1000)throw Error();}catch{throw new FeedError('动态游标无效');}}
  const pending=this.pendingSql(Date.now()),args:any[]=[account],where=['m.account_id=?'];
  if(filter==='pending'){where.push(pending.sql);args.push(...pending.params);}
  if(filter==='reply'||filter==='dm'){where.push('m.channel=?');args.push(filter==='reply'?'public':'private');}
  if(cursor){where.push("(m.created_at<? OR (m.created_at=? AND ('message:'||m.id)<?))");args.push(cursor.at,cursor.at,cursor.id);}
  const messages=filter==='post'?[]:this.store.db.prepare('SELECT m.* FROM messages m WHERE '+where.join(' AND ')+' ORDER BY m.created_at DESC,m.id DESC LIMIT ?').all(...args,limit+1) as any[];
  const postArgs:any[]=[account],postWhere=["o.account_id=?","o.kind='post'"];
  if(filter==='pending')postWhere.push("o.status='unknown'");
  if(cursor){postWhere.push("(o.created_at<? OR (o.created_at=? AND ('post:'||o.id)<?))");postArgs.push(cursor.at,cursor.at,cursor.id);}
  const posts=['reply','dm'].includes(filter)?[]:this.store.db.prepare('SELECT o.*,t.id run_id,t.task_id FROM outbox o LEFT JOIN task_runs t ON t.id=(SELECT id FROM task_runs WHERE outbox_id=o.id ORDER BY started_at DESC,id DESC LIMIT 1) WHERE '+postWhere.join(' AND ')+' ORDER BY o.created_at DESC,o.id DESC LIMIT ?').all(...postArgs,limit+1) as any[];
  const items=[...messages.map(r=>{const body=parse(r.body),draft=parse(r.draft),receipt=parse(r.receipt,null);return {id:'message:'+r.id,messageId:r.id,type:r.channel==='public'?'reply':'dm',at:r.created_at,status:r.status,revision:r.updated_at,expired:this.expired(r),handle:body.handle,userId:r.user_id,original:body.text,originalUrl:body.url,body,draft,text:draft.text??'',receipt,error:r.error,memory:{account:r.account_id,userId:r.user_id,channel:r.channel}};}),...posts.map(r=>({id:'post:'+r.id,outboxId:r.id,type:'post',at:r.created_at,status:r.status,revision:r.updated_at,expired:false,text:r.text,receipt:parse(r.receipt,null),validation:parse(r.validation_json,null),taskId:r.task_id,runId:r.run_id,...(r.run_id?{format:parse(this.store.get('task-result:'+r.run_id),null)?.format}:{}),memory:null}))].sort((a,b)=>b.at-a.at||(a.id<b.id?1:a.id>b.id?-1:0));
  const page=items.slice(0,limit),last=page.at(-1);
  return {items:page,nextCursor:items.length>limit&&last?Buffer.from(JSON.stringify({at:last.at,id:last.id})).toString('base64url'):null,pending:this.summaryFor(account,pending).pending};
 }
 private row(id:string){const row=this.store.getMessage(id,this.account());if(!row||!this.account())throw new FeedError('消息不存在',404);return row;}
 private conflict(row:any):never{throw new FeedError('消息状态或修订已变化，请重新读取',409,row.status);}
 mutate(id:string,action:'approve'|'cancel'|'regenerate',body:any={}){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new FeedError('草稿操作参数无效');
  const row=this.row(id),draft=parse(row.draft);let next:any,status:string;
  if(action==='cancel'){if(row.status!=='approved')this.conflict(row);status='draft';next={...draft,waitReason:undefined,approvedAt:undefined};}
  else {
   if(row.status!=='draft'||!Number.isSafeInteger(body.revision)||body.revision!==row.updated_at)this.conflict(row);
   if(this.expired(row))throw new FeedError('草稿已过期，不能批准或重写',409,row.status);
   if(action==='approve'){
    const text=row.channel==='public'&&typeof body.text==='string'?normalizePublicText(body.text):body.text;
    const validation=validatePostingText(text,row.channel==='public'?'reply':'dm',{accountId:row.account_id,capability:this.capabilities?.get().reply});
    if(!validation.allowed)throw new FeedError(validation.reason??'正文校验失败');
    next={...draft,text,action:'reply',edited:text!==draft.text,approvedAt:Date.now(),validation,format:{issues:formatIssues(text)},waitReason:undefined};status='approved';
   }else {next={...draft,review:true,previous:{...draft,previous:undefined},waitReason:undefined};status='queued';}
  }
  // Outbox 初始化会执行迁移事务，必须在业务原子更新事务外完成。
  const outbox=new Outbox(this.store);
  this.store.db.exec('BEGIN IMMEDIATE');
  try {
   const existing=outbox.source(row.account_id,row.channel==='public'?'reply':'dm',row.id);
   if(existing&&existing.status!=='prepared')throw new FeedError('该出站已进入提交或终态，不能重新批准或重写',409,row.status);
   if(action==='approve'&&existing)outbox.retext(existing.id,next.text);
   const changed=this.store.db.prepare('UPDATE messages SET status=?,draft=?,error=NULL,updated_at=? WHERE id=? AND account_id=? AND status=?'+(action==='cancel'?'':' AND updated_at=?')).run(status,JSON.stringify(next),Math.max(Date.now(),row.updated_at+1),row.id,row.account_id,row.status,...(action==='cancel'?[]:[body.revision])).changes;
   if(!changed)this.conflict(this.row(id));
   this.store.db.exec('COMMIT');
  }catch(error){this.store.db.exec('ROLLBACK');throw error;}
  this.store.log('draft-'+action,JSON.stringify({id:row.id,channel:row.channel,result:status}));
  const current=this.row(id);return {ok:true,status:current.status,revision:current.updated_at};
 }
}
