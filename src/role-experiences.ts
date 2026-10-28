import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Event } from './types.js';
import { ensureReferenceGapMigration } from './reference-gap-schema.js';

export class ExperienceError extends Error {constructor(message:string,public statusCode=400){super(message);}}
export type ExperienceInput={text:string;occurredAt:number|string;url?:string;revision:number};
export type ExperienceInspector=(url:string,handle:string,options?:{signal?:AbortSignal})=>Promise<{event?:Event;target?:Event}>;
const parse=(raw:any,fallback:any=null)=>{try{return JSON.parse(raw??'null')??fallback;}catch{return fallback;}};
const hasMeta=(store:Store)=>!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_experience_meta'").get();
const CONFIRMED_POST="r.kind='post' AND r.channel='public' AND json_valid(r.receipt) AND json_extract(r.receipt,'$.status')='confirmed' AND json_type(r.receipt,'$.id')='text' AND length(json_extract(r.receipt,'$.id'))>0";
const labels=(r:any)=>({id:r.id,type:r.kind,kind:r.kind,origin:r.meta_origin??(r.kind==='manual'?'manual':'automatic'),accountId:r.account_id,text:r.text,occurredAt:r.occurred_at??r.created_at,declaredOccurredAt:r.declared_at??null,url:r.url??(r.kind==='post'?parse(r.receipt)?.url??null:null),verifyStatus:r.verify_status??(r.kind==='post'?'verified':'failed'),verifyReason:r.verify_reason??(r.kind==='manual'&&!r.verify_status?'人工经历缺少核对元信息':null),hidden:!!r.hidden,revision:r.meta_updated_at??r.created_at,createdAt:r.created_at,updatedAt:r.meta_updated_at??r.created_at,sourceMessageId:r.source_message_id,receipt:parse(r.receipt),channel:r.channel});
const SELECT="SELECT r.*,m.origin AS meta_origin,m.occurred_at,m.declared_at,m.url,m.verify_status,m.verify_reason,m.hidden,m.updated_at AS meta_updated_at FROM role_experiences r LEFT JOIN role_experience_meta m ON m.experience_id=r.id AND m.account_id=r.account_id";

/** 给生产与试聊共用的只读召回；互动记录保留在原表，永不进入角色经历段。 */
export function recallRoleExperiences(store:Store,accountId:string){
 if(!accountId)return [];
 const rows=hasMeta(store)
  ?store.db.prepare(SELECT+` WHERE r.account_id=? AND r.channel='public' AND COALESCE(m.hidden,0)=0 AND ((${CONFIRMED_POST} AND COALESCE(m.verify_status,'verified')='verified') OR (r.kind='manual' AND r.user_id='role' AND m.origin='manual' AND m.verify_status='verified')) ORDER BY COALESCE(m.occurred_at,r.created_at) DESC,r.id DESC LIMIT 10`).all(accountId) as any[]
  :store.db.prepare(`SELECT r.* FROM role_experiences r WHERE r.account_id=? AND (${CONFIRMED_POST}) ORDER BY r.created_at DESC,r.id DESC LIMIT 10`).all(accountId) as any[];
 return rows.map(r=>{const item=labels(r);return {id:item.id,type:item.kind,text:item.text,sourceMessageId:item.sourceMessageId,receipt:item.receipt,createdAt:item.occurredAt,occurredAt:item.occurredAt,channel:item.channel,origin:item.origin};});
}

function declaredDate(value:unknown):number {
 if(typeof value==='string'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new ExperienceError('发生日期格式应为 YYYY-MM-DD');
  const at=Date.parse(value+'T00:00:00+08:00');if(!Number.isFinite(at)||new Date(at+28800000).toISOString().slice(0,10)!==value)throw new ExperienceError('发生日期无效');return at;
 }
 if(typeof value!=='number'||!Number.isSafeInteger(value)||!Number.isFinite(new Date(value).getTime()))throw new ExperienceError('发生时间无效');return value;
}
export function experiencePostUrl(raw:unknown,accountId:string):{url:string;platformId:string}|null {
 if(raw===undefined||raw==='')return null;
 if(typeof raw!=='string'||raw.length>2000)throw new ExperienceError('经历链接无效');
 let u:URL;try{u=new URL(raw);}catch{throw new ExperienceError('经历链接无效');}
 const match=u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/);
 if(u.origin!=='https://x.com'||u.username||u.password||u.search||u.hash||!match||match[1].toLowerCase()!==accountId.toLowerCase())throw new ExperienceError('经历链接必须是当前账号的 https://x.com/账号/status/帖子ID');
 return {url:'https://x.com/'+match[1].toLowerCase()+'/status/'+match[2],platformId:match[2]};
}
function input(raw:any,accountId:string){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['text','occurredAt','url','revision'].includes(k)))throw new ExperienceError('经历登记参数无效');
 if(typeof raw.text!=='string'||!raw.text.trim()||raw.text.trim().length>1200)throw new ExperienceError('经历正文应为 1 至 1,200 字符');
 if(!Number.isSafeInteger(raw.revision)||raw.revision<0)throw new ExperienceError('经历操作需要当前修订号');
 return {text:raw.text.trim(),at:declaredDate(raw.occurredAt),link:experiencePostUrl(raw.url,accountId),revision:raw.revision};
}

export class RoleExperienceService {
 constructor(public store:Store,public account:()=>string,public now:()=>number=Date.now){ensureReferenceGapMigration(store.db);}
 private scope(){const account=this.account();if(typeof account!=='string'||!account||account==='unknown'||account.length>200)throw new ExperienceError('当前工作账号尚未确认',409);return account;}
 private transaction<T>(fn:()=>T):T{this.store.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.store.db.exec('COMMIT');return result;}catch(e){this.store.db.exec('ROLLBACK');throw e;}}
 private row(id:string,accountId=this.scope()){
  if(typeof id!=='string'||!id||id.length>300)throw new ExperienceError('经历标识无效');
  const row=this.store.db.prepare(SELECT+" WHERE r.id=? AND r.account_id=? AND r.channel='public' AND r.kind IN ('post','manual')").get(id,accountId) as any;
  if(!row)throw new ExperienceError('角色经历不存在',404);return row;
 }
 private revision(accountId:string){return Number((this.store.db.prepare("SELECT MAX(MAX(r.created_at,COALESCE(m.updated_at,0))) AS revision FROM role_experiences r LEFT JOIN role_experience_meta m ON m.experience_id=r.id AND m.account_id=r.account_id WHERE r.account_id=? AND r.kind IN ('post','manual') AND r.channel='public'").get(accountId) as any).revision??0);}
 private expected(raw:unknown,row:any){if(!Number.isSafeInteger(raw)||(raw as number)<0)throw new ExperienceError('经历操作需要当前修订号');if(raw!==(row.meta_updated_at??row.created_at))throw new ExperienceError('经历已变化，请重新读取',409);}
 list(query:{cursor?:string;limit?:number}={}){
  const accountId=this.scope(),limit=Number(query.limit??30);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ExperienceError('经历分页数量必须为 1 至 100');
  const args:any[]=[accountId];let after='';
  if(query.cursor){try{if(typeof query.cursor!=='string'||query.cursor.length>1000)throw Error();const c=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(!Number.isSafeInteger(c.at)||typeof c.id!=='string'||!c.id||c.id.length>300)throw Error();after=' AND (COALESCE(m.occurred_at,r.created_at)<? OR (COALESCE(m.occurred_at,r.created_at)=? AND r.id<?))';args.push(c.at,c.at,c.id);}catch{throw new ExperienceError('经历分页游标无效');}}
  const rows=this.store.db.prepare(SELECT+" WHERE r.account_id=? AND r.channel='public' AND r.kind IN ('post','manual')"+after+' ORDER BY COALESCE(m.occurred_at,r.created_at) DESC,r.id DESC LIMIT ?').all(...args,limit+1) as any[],page=rows.slice(0,limit),last=page.at(-1);
  return {accountId,items:page.map(labels),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.occurred_at??last.created_at,id:last.id})).toString('base64url'):null,revision:this.revision(accountId)};
 }
 create(raw:ExperienceInput){
  const accountId=this.scope(),value=input(raw,accountId);
  return this.transaction(()=>{
   if(value.revision!==this.revision(accountId))throw new ExperienceError('经历列表已变化，请重新读取',409);
   const count=Number((this.store.db.prepare("SELECT COUNT(*) AS n FROM role_experiences WHERE account_id=? AND kind='manual'").get(accountId) as any).n);if(count>=200)throw new ExperienceError('每个账号最多登记 200 条人工经历',409);
   const id=randomUUID(),at=this.store.nextTimestamp(this.now());
   this.store.db.prepare('INSERT INTO role_experiences VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,accountId,'role','public','manual',value.text,'manual:'+id,null,null,at);
   this.store.db.prepare('INSERT INTO role_experience_meta VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,accountId,'manual',value.at,value.at,value.link?.url??null,value.link?'pending':'verified',value.link?null:'无链接的管理员登记，无需平台核对',0,at);
   this.store.log('role-experience-create',JSON.stringify({id,accountId,linked:!!value.link,result:value.link?'pending':'verified'}));
   return {ok:true,item:labels(this.row(id,accountId)),revision:this.revision(accountId)};
  });
 }
 edit(id:string,raw:ExperienceInput){
  const accountId=this.scope(),value=input(raw,accountId);
  return this.transaction(()=>{
   const row=this.row(id,accountId);this.expected(value.revision,row);if(row.kind!=='manual')throw new ExperienceError('自动发帖经历仅可隐藏，不能编辑正文或日期',409);
   const at=this.store.nextTimestamp(this.now());this.store.db.prepare('UPDATE role_experiences SET text=? WHERE id=? AND account_id=?').run(value.text,id,accountId);
   this.store.db.prepare('INSERT INTO role_experience_meta VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(experience_id) DO UPDATE SET occurred_at=excluded.occurred_at,declared_at=excluded.declared_at,url=excluded.url,verify_status=excluded.verify_status,verify_reason=excluded.verify_reason,updated_at=excluded.updated_at').run(id,accountId,'manual',value.at,value.at,value.link?.url??null,value.link?'pending':'verified',value.link?null:'无链接的管理员登记，无需平台核对',row.hidden?1:0,at);
   this.store.log('role-experience-edit',JSON.stringify({id,accountId,linked:!!value.link,result:value.link?'pending':'verified'}));return {ok:true,item:labels(this.row(id,accountId)),revision:this.revision(accountId)};
  });
 }
 setHidden(id:string,hidden:boolean,revision:number){
  const accountId=this.scope();if(typeof hidden!=='boolean')throw new ExperienceError('隐藏状态无效');
  return this.transaction(()=>{
   const row=this.row(id,accountId);this.expected(revision,row);const at=this.store.nextTimestamp(this.now());
   this.store.db.prepare('INSERT INTO role_experience_meta VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(experience_id) DO UPDATE SET hidden=excluded.hidden,updated_at=excluded.updated_at').run(id,accountId,row.kind==='manual'?'manual':'automatic',row.occurred_at??row.created_at,row.declared_at??null,row.url??null,row.verify_status??(row.kind==='post'?'verified':'failed'),row.verify_reason??null,hidden?1:0,at);
   this.store.log(hidden?'role-experience-hide':'role-experience-unhide',JSON.stringify({id,accountId}));return {ok:true,item:labels(this.row(id,accountId)),revision:this.revision(accountId)};
  });
 }
 /** 只能由主循环在既有浏览器互斥内调用；暂停/接管/切号或旧修订结果均不写回。 */
 async verifyPending(inspectPost:ExperienceInspector,options:{signal?:AbortSignal;canProcess?:()=>boolean;limit?:number}={}){
  const accountId=this.scope(),canProcess=()=>!options.signal?.aborted&&this.store.get('control')==='running'&&this.account()===accountId&&(options.canProcess?.()??true);
  if(!canProcess())return {processed:0,verified:0,failed:0};
  const limit=Math.max(1,Math.min(3,Math.trunc(options.limit??3))),rows=this.store.db.prepare(SELECT+" WHERE r.account_id=? AND r.kind='manual' AND m.verify_status='pending' AND m.hidden=0 ORDER BY m.updated_at,r.id LIMIT ?").all(accountId,limit) as any[];
  let processed=0,verified=0,failed=0;
  for(const row of rows){
   if(!canProcess())break;let status:'verified'|'failed'='failed',reason='帖子页面核对失败',occurredAt=row.occurred_at;
   try{
    const link=experiencePostUrl(row.url,accountId);if(!link)throw new Error();const result=await inspectPost(link.url,accountId,{signal:options.signal}),event=result.event??result.target;
    if(!event||event.platformId!==link.platformId)reason='帖子平台标识不一致';
    else if(typeof event.handle!=='string'||event.handle.toLowerCase()!==accountId.toLowerCase())reason='帖子作者不是当前工作账号';
    else if(event.timestampReliable!==true||!Number.isSafeInteger(event.timestamp)||event.timestamp<=0)reason='帖子缺少可靠发布时间';
    else {status='verified';reason='已按当前账号与平台帖子核对';occurredAt=event.timestamp;}
   }catch(error){if((error as any)?.browserPaused||(error as any)?.restricted)throw error;reason='帖子页面不可读或核对请求失败';}
   if(!canProcess())break;
   const changed=this.store.db.prepare("UPDATE role_experience_meta SET occurred_at=?,verify_status=?,verify_reason=?,updated_at=? WHERE experience_id=? AND account_id=? AND verify_status='pending' AND updated_at=? AND hidden=0 AND EXISTS(SELECT 1 FROM role_experiences r WHERE r.id=experience_id AND r.account_id=? AND r.kind='manual')").run(occurredAt,status,reason,this.store.nextTimestamp(this.now()),row.id,accountId,row.meta_updated_at,accountId).changes;
   if(changed){processed++;if(status==='verified')verified++;else failed++;this.store.log('role-experience-verify',JSON.stringify({id:row.id,accountId,result:status}));}
  }
  return {processed,verified,failed};
 }
}
