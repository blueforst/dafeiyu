import type { Store } from './store.js';
import { applyMigration } from './migrations.js';
import { Outbox } from './outbox.js';
import { normalizePublicText,validatePostingText } from './posting-policy.js';
import type { PostingCapabilitiesService } from './posting-capabilities.js';
import type { ReplyTriage } from './reply-triage.js';

export class FeedError extends Error {constructor(message:string,public statusCode=400,public current?:string){super(message);}}
const parse=(value:any,fallback:any={})=>{try{return JSON.parse(value??'null')??fallback;}catch{return fallback;}};
/** 读写均以当前工作账号为边界；时间游标不受后来入库的条目影响。 */
export class ActivityFeed {
 constructor(public store:Store,public account:()=>string,public maxAgeHours:()=>number,public capabilities?:PostingCapabilitiesService,public triage?:ReplyTriage){
  applyMigration(store.db,12,'动态时间线索引',`CREATE INDEX IF NOT EXISTS messages_account_created ON messages(account_id,created_at,id); CREATE INDEX IF NOT EXISTS messages_account_channel_updated ON messages(account_id,channel,updated_at); CREATE INDEX IF NOT EXISTS outbox_account_created ON outbox(account_id,kind,created_at,id);`);
 }
 expired(row:any,now=Date.now()){if(!['draft','approved'].includes(row.status))return false;const e=parse(row.body);return !Number.isFinite(e.timestamp)||now-e.timestamp>this.maxAgeHours()*3600000;}
 private pendingSql(now:number):{sql:string;params:number[]}{
  const cutoff=Math.floor(now-this.maxAgeHours()*3600000),fresh="json_valid(m.body) AND json_type(m.body,'$.timestamp') IN ('integer','real') AND json_extract(m.body,'$.timestamp')>=?";
  // 分级入队与动态待处理共享同一只读资格查询，避免复制普通/优先时效与忽略规则。
  const queued=this.triage?.queuedEligibility(this.maxAgeHours())??{sql:fresh+" AND json_valid(m.draft) AND json_extract(m.draft,'$.review')=1",params:[cutoff]};
  return {sql:`(m.status='unknown' OR (${fresh} AND m.status IN ('draft','approved','failed')) OR (m.status='queued' AND (${queued.sql})))`,params:[cutoff,...queued.params]};
 }
 private summaryFor(account:string,pending:{sql:string;params:number[]}){
  const m=this.store.db.prepare(`SELECT MAX(m.updated_at) latest,SUM(CASE WHEN ${pending.sql} THEN 1 ELSE 0 END) pending FROM messages m WHERE m.account_id=?`).get(...pending.params,account) as any;
  const p=this.store.db.prepare("SELECT MAX(updated_at) latest,SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) pending FROM outbox WHERE account_id=? AND kind='post'").get(account) as any;
  return {latest:Math.max(Number(m.latest??0),Number(p.latest??0)),pending:Number(m.pending??0)+Number(p.pending??0)};
 }
 summary(){const account=this.account();return account?this.summaryFor(account,this.pendingSql(Date.now())):{latest:0,pending:0};}
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
  const items=[...messages.map(r=>{const body=parse(r.body),draft=parse(r.draft),receipt=parse(r.receipt,null);return {id:'message:'+r.id,messageId:r.id,type:r.channel==='public'?'reply':'dm',at:r.created_at,status:r.status,revision:r.updated_at,expired:this.expired(r),handle:body.handle,userId:r.user_id,original:body.text,originalUrl:body.url,body,draft,text:draft.text??'',receipt,error:r.error,memory:{account:r.account_id,userId:r.user_id,channel:r.channel}};}),...posts.map(r=>({id:'post:'+r.id,outboxId:r.id,type:'post',at:r.created_at,status:r.status,revision:r.updated_at,expired:false,text:r.text,receipt:parse(r.receipt,null),validation:parse(r.validation_json,null),taskId:r.task_id,runId:r.run_id,memory:null}))].sort((a,b)=>b.at-a.at||(a.id<b.id?1:a.id>b.id?-1:0));
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
    next={...draft,text,action:'reply',edited:text!==draft.text,approvedAt:Date.now(),validation,waitReason:undefined};status='approved';
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
