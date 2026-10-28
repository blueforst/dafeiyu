import {randomUUID} from 'node:crypto';
import type {Store} from './store.js';
import {NativeIdentityConflictError} from './store.js';
import type {ReplyTriage} from './reply-triage.js';
import type {Event} from './types.js';
import {ensureReferenceGapMigration} from './reference-gap-schema.js';

export type ManualImportStatus='pending'|'imported'|'duplicate'|'rejected'|'failed';
export type ManualImportRequest={id:string;accountId:string;url:string;platformId:string;status:ManualImportStatus;reason:string|null;messageId:string|null;messageStatus:string|null;createdAt:number;updatedAt:number;revision:number};
export type ManualInspectResult={target:Event;context:{ancestorHandles:string[];contextIncomplete?:boolean}};
export type ManualImportOptions={signal?:AbortSignal;deadline?:number;limit?:number};
export type ManualImportDeps={account:()=>string;control:()=>string;maxAgeHours:()=>number;triage:ReplyTriage;inspectPost:(url:string,accountId:string,options:{signal?:AbortSignal;deadline:number})=>Promise<ManualInspectResult>;now?:()=>number};
export class ManualImportError extends Error{constructor(message:string,public statusCode=400){super(message);}}

const STATUSES:readonly ManualImportStatus[]=['pending','imported','duplicate','rejected','failed'];
const HANDLE=/^[a-z0-9_]{1,15}$/i;
const hour=3600000;
/** 链接只提供定位；正文、作者及时间必须由轮次内的浏览器检查取得。 */
export function normalizeImportUrl(raw:unknown):{url:string;handle:string;platformId:string}{
 if(typeof raw!=='string'||!raw.trim()||raw.length>2048)throw new ManualImportError('请填写有效的 X 帖子链接');
 let url:URL;try{url=new URL(raw.trim());}catch{throw new ManualImportError('帖子链接格式无效');}
 const allowed=new Set(['x.com','twitter.com','mobile.x.com','mobile.twitter.com','www.x.com','www.twitter.com']);
 if(url.protocol!=='https:'||!allowed.has(url.hostname.toLowerCase())||url.username||url.password||url.port)throw new ManualImportError('只接受 X 或 Twitter 的 HTTPS 帖子链接');
 const match=url.pathname.match(/^\/([a-z0-9_]{1,15})\/status\/(\d+)\/?$/i);
 if(!match)throw new ManualImportError('链接必须指向一条明确的帖子');
 const handle=match[1].toLowerCase(),platformId=match[2];
 return {url:'https://x.com/'+handle+'/status/'+platformId,handle,platformId};
}

/** 管理员补录只产生待检查请求；不直接采集、生成或发送。 */
export class ManualImportsService{
 private processing=false;
 private now:()=>number;
 constructor(public store:Store,public deps:ManualImportDeps){this.now=deps.now??Date.now;ensureReferenceGapMigration(store.db);}
 private account(){const value=this.deps.account().trim().replace(/^@/,'').toLowerCase();if(!HANDLE.test(value))throw new ManualImportError('请先确认浏览器当前账号',409);return value;}
 private maxAge(){const value=this.deps.maxAgeHours();if(!Number.isInteger(value)||value<1||value>48)throw new ManualImportError('消息处理时效设置无效',409);return value;}
 private transact<T>(fn:()=>T):T{this.store.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.store.db.exec('COMMIT');return value;}catch(error){this.store.db.exec('ROLLBACK');throw error;}}
 private row(id:string,accountId:string){return this.store.db.prepare('SELECT r.*,m.status message_status FROM manual_imports r LEFT JOIN messages m ON m.id=r.message_id AND m.account_id=r.account_id WHERE r.id=? AND r.account_id=?').get(id,accountId) as any;}
 private dto(row:any):ManualImportRequest{return {id:row.id,accountId:row.account_id,url:row.url,platformId:row.platform_id,status:row.status,reason:row.reason??null,messageId:row.message_id??null,messageStatus:row.message_status??null,createdAt:row.created_at,updatedAt:row.updated_at,revision:row.updated_at};}
 private existing(platformId:string,accountId:string){return this.store.findByPlatformId(accountId,'public',platformId);}
 private log(id:string,accountId:string,status:ManualImportStatus){this.store.log('manual-import',JSON.stringify({id,accountId,result:status}));}
 private insert(accountId:string,url:string,platformId:string,status:ManualImportStatus,reason:string|null=null,messageId:string|null=null){const at=this.now(),id=randomUUID();this.store.db.prepare('INSERT INTO manual_imports(id,account_id,url,platform_id,status,reason,message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,accountId,url,platformId,status,reason,messageId,at,at);this.log(id,accountId,status);return this.dto(this.row(id,accountId));}
 submit(raw:unknown){
  const accountId=this.account(),link=normalizeImportUrl(raw);
  return this.transact(()=>{
   const pending=this.store.db.prepare("SELECT id FROM manual_imports WHERE account_id=? AND platform_id=? AND status='pending' ORDER BY created_at,id LIMIT 1").get(accountId,link.platformId) as any;
   const message=this.existing(link.platformId,accountId);
   if(message){
    let request:ManualImportRequest,reused=false;
    if(pending){this.finish(pending.id,accountId,'duplicate','已有消息记录',message.id);request=this.dto(this.row(pending.id,accountId));reused=true;}
    else{
     const previous=this.store.db.prepare("SELECT id FROM manual_imports WHERE account_id=? AND platform_id=? AND status='duplicate' AND message_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(accountId,link.platformId,message.id) as any;
     request=previous?this.dto(this.row(previous.id,accountId)):this.insert(accountId,link.url,link.platformId,'duplicate','已有消息记录',message.id);reused=!!previous;
    }
    return {ok:true,status:'duplicate' as const,reused,request,messageStatus:message.status};
   }
   if(pending)return {ok:true,status:'pending' as const,reused:true,request:this.dto(this.row(pending.id,accountId))};
   const count=Number((this.store.db.prepare("SELECT count(*) n FROM manual_imports WHERE account_id=? AND status='pending'").get(accountId) as any).n);
   if(count>=20)throw new ManualImportError('待处理补录已达二十条，请先处理已有请求',409);
   return {ok:true,status:'pending' as const,reused:false,request:this.insert(accountId,link.url,link.platformId,'pending')};
  });
 }
 get(id:string){const accountId=this.account(),row=this.row(id,accountId);if(!row)throw new ManualImportError('补录请求不存在',404);return this.dto(row);}
 forMessage(messageId:string){const accountId=this.account();return (this.store.db.prepare('SELECT r.*,m.status message_status FROM manual_imports r LEFT JOIN messages m ON m.id=r.message_id AND m.account_id=r.account_id WHERE r.account_id=? AND r.message_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 20').all(accountId,messageId) as any[]).map(row=>this.dto(row));}
 summary(accountId=this.account()){const result=this.store.db.prepare("SELECT MAX(updated_at) latest,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending FROM manual_imports WHERE account_id=?").get(accountId) as any;return {latest:Number(result.latest??0),pending:Number(result.pending??0)};}
 list(query:{status?:string;cursor?:string;limit?:number|string}={}){
  const accountId=this.account();if(query.status!==undefined&&!STATUSES.includes(query.status as ManualImportStatus))throw new ManualImportError('补录状态无效');
  const size=Number(query.limit??30);if(!Number.isSafeInteger(size)||size<1)throw new ManualImportError('补录分页数量无效');const limit=Math.min(100,size),where=['r.account_id=?'],args:any[]=[accountId];
  if(query.status){where.push('r.status=?');args.push(query.status);}
  if(query.cursor){let cursor:any;try{if(query.cursor.length>1000)throw Error();cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(!Number.isSafeInteger(cursor.at)||cursor.at<0||typeof cursor.id!=='string'||cursor.id.length>100)throw Error();}catch{throw new ManualImportError('补录分页游标无效');}where.push('(r.created_at<? OR (r.created_at=? AND r.id<?))');args.push(cursor.at,cursor.at,cursor.id);}
  const rows=this.store.db.prepare('SELECT r.*,m.status message_status FROM manual_imports r LEFT JOIN messages m ON m.id=r.message_id AND m.account_id=r.account_id WHERE '+where.join(' AND ')+' ORDER BY r.created_at DESC,r.id DESC LIMIT ?').all(...args,limit+1) as any[],items=rows.slice(0,limit).map(row=>this.dto(row)),last=items.at(-1);
  return {items,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.createdAt,id:last.id})).toString('base64url'):null,pending:this.summary(accountId).pending};
 }
 private finish(id:string,accountId:string,status:ManualImportStatus,reason:string|null,messageId:string|null=null){const current=this.row(id,accountId);if(!current||current.status!=='pending')return false;const changed=this.store.db.prepare("UPDATE manual_imports SET status=?,reason=?,message_id=?,updated_at=? WHERE id=? AND account_id=? AND status='pending' AND updated_at=?").run(status,reason,messageId,Math.max(this.now(),current.updated_at+1),id,accountId,current.updated_at).changes>0;if(changed)this.log(id,accountId,status);return changed;}
 private validate(result:ManualInspectResult,request:any,accountId:string,maxAgeHours:number):{event:Event}|{reason:string;status:'failed'|'rejected'}{
  const event=result?.target;if(!event||event.channel!=='public'||typeof event.text!=='string'||event.text.length>30000||typeof event.handle!=='string'||!HANDLE.test(event.handle))return {status:'failed',reason:'页面没有可可靠读取的目标消息'};
  let link:ReturnType<typeof normalizeImportUrl>;try{link=normalizeImportUrl(event.url);}catch{return {status:'failed',reason:'页面目标链接无效'};}
  const expected=normalizeImportUrl(request.url);
  if(!event.platformId||event.platformId!==request.platform_id||link.platformId!==request.platform_id||link.handle!==event.handle.toLowerCase()||expected.handle!==event.handle.toLowerCase()||event.targetId&&event.targetId!==event.platformId)return {status:'failed',reason:'页面目标与提交链接不匹配'};
  if(event.handle.toLowerCase()===accountId)return {status:'rejected',reason:'不能补录当前工作账号自己的帖子'};
  if(event.timestampReliable!==true||!Number.isFinite(event.timestamp)||event.timestamp<=0)return {status:'failed',reason:'目标消息缺少可靠的平台时间'};
  const age=this.now()-event.timestamp;if(age>maxAgeHours*hour)return {status:'rejected',reason:'目标消息已超过处理时效'};if(age< -60000)return {status:'failed',reason:'目标消息的平台时间尚无法确认'};
  const mentions=new RegExp('(^|[^a-z0-9_])@'+accountId+'(?![a-z0-9_])','i').test(event.text);
  const ancestors=Array.isArray(result.context?.ancestorHandles)?result.context.ancestorHandles:[];
  if(!mentions&&!ancestors.some(handle=>typeof handle==='string'&&handle.replace(/^@/,'').toLowerCase()===accountId))return {status:'rejected',reason:'帖子既未提及当前账号，也不在其帖子的上文对话中'};
  return {event:{...event,id:'x:'+event.platformId,accountId,platformId:event.platformId,targetId:event.platformId,url:link.url,handle:link.handle,userId:'x:'+link.handle,outboxId:undefined}};
 }
 /** 由唯一工作轮次在公开采集之前调用；inspectPost必须复用同一浏览器串行入口。 */
 async processRound(options:ManualImportOptions={}){
  if(this.deps.control()!=='running'||options.signal?.aborted)return {processed:0,items:[] as ManualImportRequest[]};
  const accountId=this.account(),deadline=Number.isFinite(options.deadline)?options.deadline!:this.now()+30000,limit=Math.min(3,Math.max(0,Math.floor(options.limit??3)));this.maxAge();
  const active=()=>!options.signal?.aborted&&this.deps.control()==='running'&&this.deps.account().replace(/^@/,'').toLowerCase()===accountId&&this.now()<deadline;
  if(this.processing||!active()||!limit)return {processed:0,items:[] as ManualImportRequest[]};
  this.processing=true;const items:ManualImportRequest[]=[];
  try{
   const pending=this.store.db.prepare("SELECT * FROM manual_imports WHERE account_id=? AND status='pending' ORDER BY created_at,id LIMIT ?").all(accountId,limit) as any[];
   for(const request of pending){
    if(!active())break;
    try{
    const duplicate=this.existing(request.platform_id,accountId);
    if(duplicate){this.finish(request.id,accountId,'duplicate','已有消息记录',duplicate.id);items.push(this.dto(this.row(request.id,accountId)));continue;}
    let inspected:ManualInspectResult;
    try{inspected=await this.deps.inspectPost(request.url,accountId,{signal:options.signal,deadline});}
    catch(error){
     if(!active())break;
     this.finish(request.id,accountId,'failed','页面读取失败，请检查后重新提交');items.push(this.dto(this.row(request.id,accountId)));
     if((error as any)?.browserPaused||(error as any)?.restricted)throw error;
     continue;
    }
    if(!active())break;
    const checked=this.validate(inspected,request,accountId,this.maxAge());
    if('reason' in checked){this.finish(request.id,accountId,checked.status,checked.reason);items.push(this.dto(this.row(request.id,accountId)));continue;}
    const known=this.existing(request.platform_id,accountId);
    if(known){this.finish(request.id,accountId,'duplicate','已有消息记录',known.id);items.push(this.dto(this.row(request.id,accountId)));continue;}
    const ingested=this.deps.triage.ingestManual(checked.event,accountId,this.maxAge());
    const message=this.existing(request.platform_id,accountId);
    if(ingested&&message)this.finish(request.id,accountId,'imported','已按管理员补录优先级入队',message.id);
    else if(message)this.finish(request.id,accountId,'duplicate','已有消息记录',message.id);
    else this.finish(request.id,accountId,'rejected','该消息受遗忘或来源保护，不能重新入队');
    items.push(this.dto(this.row(request.id,accountId)));
    }catch(error){
     if(!(error instanceof NativeIdentityConflictError))throw error;
     if(!active())break;
     this.finish(request.id,accountId,'failed','已有消息的平台标识冲突，请人工核对后重新提交');items.push(this.dto(this.row(request.id,accountId)));
    }
   }
   return {processed:items.length,items};
  }finally{this.processing=false;}
 }
}
