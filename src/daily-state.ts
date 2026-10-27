import { randomUUID } from 'node:crypto';
import { loadConfig, redact } from './config.js';
import type { Generator } from './model.js';
import { applyMigration } from './migrations.js';
import { readPanelSettings } from './settings.js';
import type { Store } from './store.js';
import type { Config } from './types.js';

export type DailyPeriod = { start:string; end:string; activity:string };
export type DailyContent = {
 date:string; fictional:true; periods:DailyPeriod[];
 meals:{breakfast:string;lunch:string;dinner:string}; activities:string[]; mood:string;
};
export type DailyRevision = {
 accountId:string; date:string; revision:number; content:DailyContent;
 source:'automatic'|'manual-generation'|'manual-edit'; generatedAt:number;
 configRevision:number; callId:string|null; interactionId:string|null;
};
export type DailyStatus = 'ready'|'generating'|'paused'|'backoff'|'exhausted'|'failed'|'superseded'|'missing';
export type DailyResult = {date:string;state:DailyRevision|null;status:DailyStatus;attempts:number;nextRetryAt:number|null;interactionId:string|null;callId:string|null;error?:string};
export type DailyEnsureOptions = {manual?:boolean;force?:boolean;signal?:AbortSignal;expectedRevision?:number;interactionId?:string};
export class DailyStateError extends Error {
 constructor(message:string,public statusCode=400){super(message);}
}

const DAY=86400000, RETRY=30*60000, LOCK=5*60000;
export function shanghaiDate(at:number=Date.now()):string {return new Date(at+8*3600000).toISOString().slice(0,10);}
function validDate(value:unknown):value is string {return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00+08:00').getTime()===Date.parse(value+'T00:00:00+08:00')&&shanghaiDate(Date.parse(value+'T00:00:00+08:00'))===value;}
function minute(value:unknown,allowEnd=false):number {
 if(typeof value!=='string'||!/^\d{2}:\d{2}$/.test(value))return -1;
 const [h,m]=value.split(':').map(Number);
 return h>=0&&h<24&&m>=0&&m<60?h*60+m:allowEnd&&value==='24:00'?1440:-1;
}
function text(value:unknown,label:string,max=500):string {
 if(typeof value!=='string'||!value.trim()||value.length>max)throw new DailyStateError(label+'无效');
 return value.trim();
}
export function validateDailyContent(raw:unknown,date:string):DailyContent {
 if(!validDate(date))throw new DailyStateError('日程日期无效');
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DailyStateError('日程内容无效');
 const v=raw as Record<string,any>;
 if(v.date!==date||v.fictional!==true)throw new DailyStateError('日程必须标记当前日期与虚构性质');
 if(!Array.isArray(v.periods)||!v.periods.length||v.periods.length>24)throw new DailyStateError('日程时段数量无效');
 let previousEnd=0;
 const periods=v.periods.map((p:any)=>{
  const start=minute(p?.start),end=minute(p?.end,true);
  if(start<0||end<=start||start<previousEnd)throw new DailyStateError('日程时段时间无效或重叠');
  previousEnd=end;
  return {start:p.start as string,end:p.end as string,activity:text(p.activity,'时段活动')};
 });
 if(!v.meals||typeof v.meals!=='object')throw new DailyStateError('三餐内容无效');
 const meals={breakfast:text(v.meals.breakfast,'早餐'),lunch:text(v.meals.lunch,'午餐'),dinner:text(v.meals.dinner,'晚餐')};
 if(!Array.isArray(v.activities)||!v.activities.length||v.activities.length>24)throw new DailyStateError('日程活动无效');
 const content:DailyContent={date,fictional:true,periods,meals,activities:v.activities.map((x:unknown)=>text(x,'日程活动')),mood:text(v.mood,'心情',300)};
 if(JSON.stringify(content).length>16000)throw new DailyStateError('日程内容超过长度限制');
 return content;
}
function parseJSON(raw:string):unknown {return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}
function account(value:string):string {
 const v=String(value||'').trim();if(!v||v==='unknown'||v.length>200)throw new DailyStateError('请先确认工作账号');return v;
}
function fromRow(row:any):DailyRevision|null {
 return row?{accountId:row.account_id,date:row.local_date,revision:Number(row.revision),content:JSON.parse(row.content),source:row.source,generatedAt:Number(row.generated_at),configRevision:Number(row.config_revision),callId:row.call_id??null,interactionId:row.interaction_id??null}:null;
}

export class DailyStateService {
 private inflight=new Map<string,Promise<DailyResult>>();
 constructor(public store:Store,public generator:Generator,public config:()=>Config=loadConfig,public now:()=>number=Date.now,public canAuto:()=>boolean=()=>store.get('control')==='running') {
  applyMigration(store.db,4,'daily-state',`
   CREATE TABLE IF NOT EXISTS daily_revisions (
    account_id TEXT NOT NULL, local_date TEXT NOT NULL, revision INTEGER NOT NULL,
    content TEXT NOT NULL, source TEXT NOT NULL, generated_at INTEGER NOT NULL,
    config_revision INTEGER NOT NULL, call_id TEXT, interaction_id TEXT,
    PRIMARY KEY(account_id,local_date,revision)
   );
   CREATE TABLE IF NOT EXISTS daily_attempts (
    account_id TEXT NOT NULL, local_date TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER, status TEXT NOT NULL DEFAULT 'missing', error TEXT,interaction_id TEXT,call_id TEXT,
    PRIMARY KEY(account_id,local_date)
   );
   CREATE TABLE IF NOT EXISTS daily_locks (
    account_id TEXT NOT NULL, local_date TEXT NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(account_id,local_date)
   );
   CREATE INDEX IF NOT EXISTS daily_history ON daily_revisions(account_id,local_date DESC,revision DESC);
  `);
 }
 get(accountId:string,date=shanghaiDate(this.now())):DailyRevision|null {
  if(!validDate(date))throw new DailyStateError('日程日期无效');
  return fromRow(this.store.db.prepare('SELECT * FROM daily_revisions WHERE account_id=? AND local_date=? ORDER BY revision DESC LIMIT 1').get(account(accountId),date));
 }
 history(accountId:string,limit=7):DailyRevision[] {
  const n=Math.max(1,Math.min(7,Math.floor(Number(limit)||7)));
  const start=shanghaiDate(this.now()-6*DAY),today=shanghaiDate(this.now());
  return (this.store.db.prepare(`SELECT d.* FROM daily_revisions d WHERE account_id=? AND local_date>=? AND local_date<=?
   AND revision=(SELECT MAX(x.revision) FROM daily_revisions x WHERE x.account_id=d.account_id AND x.local_date=d.local_date)
   ORDER BY local_date DESC LIMIT ?`).all(account(accountId),start,today,n) as any[]).map(row=>fromRow(row)!);
 }
 private result(accountId:string,date:string,status?:DailyStatus,error?:string):DailyResult {
  const state=this.get(accountId,date);
  const attempt=this.store.db.prepare('SELECT * FROM daily_attempts WHERE account_id=? AND local_date=?').get(accountId,date) as any;
  const active=this.store.db.prepare('SELECT owner FROM daily_locks WHERE account_id=? AND local_date=? AND expires_at>?').get(accountId,date,this.now());
  const attempts=Number(attempt?.attempts||0),last=Number(attempt?.last_attempt_at||0);
  const inferred:DailyStatus=active?'generating':state?'ready':attempts>=3?'exhausted':last&&last+RETRY>this.now()?'backoff':['failed','generating'].includes(attempt?.status)?'failed':'missing';
  return {date,state,status:status??inferred,attempts,nextRetryAt:!state&&attempts<3&&last?last+RETRY:null,interactionId:attempt?.interaction_id??null,callId:attempt?.call_id??null,...(error||attempt?.error?{error:error||String(attempt.error)}:{})};
 }
 describe(accountId:string) {
  const a=account(accountId),date=shanghaiDate(this.now()),result=this.result(a,date);
  const t=new Date(this.now()+8*3600000),at=t.getUTCHours()*60+t.getUTCMinutes();
  return {...result,today:result.state,currentPeriod:result.state?.content.periods.find(p=>minute(p.start)<=at&&minute(p.end,true)>at)??null,history:this.history(a),fictional:true as const};
 }
 ensure(accountId:string,opts:DailyEnsureOptions={}):Promise<DailyResult> {
  const a=account(accountId),date=shanghaiDate(this.now()),key=JSON.stringify([a,date]);
  const existing=this.inflight.get(key);if(existing)return existing;
  if(opts.force&&!opts.manual)return Promise.reject(new DailyStateError('自动任务不能覆盖当日日程'));
  if(opts.expectedRevision!==undefined&&(!Number.isInteger(opts.expectedRevision)||opts.expectedRevision<0))return Promise.reject(new DailyStateError('请提供有效日程修订号'));
  if(opts.interactionId!==undefined&&(typeof opts.interactionId!=='string'||!opts.interactionId.trim()||opts.interactionId.length>200))return Promise.reject(new DailyStateError('日程关联标识无效'));
  const state=this.get(a,date);if(state&&!opts.force)return Promise.resolve(this.result(a,date,'ready'));
  if(opts.expectedRevision!==undefined&&(state?.revision??0)!==opts.expectedRevision)return Promise.reject(new DailyStateError('日程已更新，请重新读取后再生成',409));
  if(!opts.manual&&!this.canAuto())return Promise.resolve(this.result(a,date,'paused'));
  const initial=this.result(a,date);
  if(initial.status==='generating')return Promise.resolve(initial);
  if(!opts.manual&&['backoff','exhausted'].includes(initial.status))return Promise.resolve(initial);
  const pending=this.generate(a,date,opts).finally(()=>this.inflight.delete(key));
  this.inflight.set(key,pending);return pending;
 }
 private async generate(accountId:string,date:string,opts:DailyEnsureOptions):Promise<DailyResult> {
  const started=this.now(),owner=randomUUID();let baseRevision=0;
  this.store.db.exec('BEGIN IMMEDIATE');
  let acquired=false;
  try {
   this.store.db.prepare('DELETE FROM daily_locks WHERE account_id=? AND local_date=? AND expires_at<=?').run(accountId,date,started);
   acquired=Number(this.store.db.prepare('INSERT OR IGNORE INTO daily_locks(account_id,local_date,owner,expires_at) VALUES(?,?,?,?)').run(accountId,date,owner,started+LOCK).changes)>0;
   if(acquired) {
    const current=this.get(accountId,date),attempt=this.store.db.prepare('SELECT * FROM daily_attempts WHERE account_id=? AND local_date=?').get(accountId,date) as any;
    baseRevision=current?.revision??0;
    if(opts.expectedRevision!==undefined&&baseRevision!==opts.expectedRevision)throw new DailyStateError('日程已更新，请重新读取后再生成',409);
    if((current&&!opts.force)||(!opts.manual&&(Number(attempt?.attempts||0)>=3||Number(attempt?.last_attempt_at||0)+RETRY>started))) {
     this.store.db.prepare('DELETE FROM daily_locks WHERE account_id=? AND local_date=? AND owner=?').run(accountId,date,owner);
     this.store.db.exec('COMMIT');return this.result(accountId,date);
    }
    this.store.db.prepare(`INSERT INTO daily_attempts(account_id,local_date,attempts,last_attempt_at,status,error) VALUES(?,?,?,?,?,NULL)
     ON CONFLICT(account_id,local_date) DO UPDATE SET attempts=daily_attempts.attempts+?,last_attempt_at=CASE WHEN ?=1 THEN excluded.last_attempt_at ELSE daily_attempts.last_attempt_at END,status='generating',error=NULL`).run(accountId,date,opts.manual?0:1,opts.manual?null:started,'generating',opts.manual?0:1,opts.manual?0:1);
   }
   this.store.db.exec('COMMIT');
  }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  if(!acquired)return this.result(accountId,date,'generating');
  const interactionId=opts.interactionId??'daily-'+randomUUID();
  this.store.db.prepare('UPDATE daily_attempts SET interaction_id=?,call_id=NULL WHERE account_id=? AND local_date=?').run(interactionId,accountId,date);
  try {
   if(opts.signal?.aborted)throw new DailyStateError('日程生成已中止',409);
   if(!opts.manual&&!this.canAuto())throw new DailyStateError('业务已暂停，日程未生成',409);
   const original=this.config(),c:Config={...original,model:{...original.model,maxTokens:Math.min(original.model.maxTokens,3072)}};
   const settings=readPanelSettings() as any;
   const sections=settings.persona?.sections;
   const persona=Array.isArray(sections)?sections.map((s:any)=>typeof s.content==='string'?s.content:'').join('\n\n'):c.persona;
   const configRevision=Number(settings.revisions?.persona??0);
   const historyStart=shanghaiDate(Date.parse(date+'T00:00:00+08:00')-7*DAY);
   const history=(this.store.db.prepare(`SELECT d.* FROM daily_revisions d WHERE account_id=? AND local_date>=? AND local_date<?
    AND revision=(SELECT MAX(x.revision) FROM daily_revisions x WHERE x.account_id=d.account_id AND x.local_date=d.local_date)
    ORDER BY local_date DESC LIMIT 7`).all(accountId,historyStart,date) as any[]).map(row=>({date:row.local_date,content:JSON.parse(row.content)}));
   const system='根据给定的人格设定和近七日虚构日程，创作今天一致的虚构生活日程。所有内容均为角色虚构设定，不是已发生的真实事件或用户事实。不要把历史日期的往事照搬成今天真实发生的事情。只输出 JSON，结构为 {"date":"YYYY-MM-DD","fictional":true,"periods":[{"start":"06:00","end":"09:00","activity":"活动"}],"meals":{"breakfast":"早餐","lunch":"午餐","dinner":"晚餐"},"activities":["活动"],"mood":"心情"}。时段按顺序且不重叠，覆盖合理的当日生活。';
   const response=await this.generator.complete(c,system,JSON.stringify({date,timezone:'Asia/Shanghai',persona,history}),opts.signal,'role-workflow-'+interactionId,{purpose:'daily-state',source:opts.manual?'panel':'task',accountId,interactionId});
   this.store.db.prepare('UPDATE daily_attempts SET call_id=? WHERE account_id=? AND local_date=?').run(response.callId??null,accountId,date);
   const content=validateDailyContent(parseJSON(response.text),date);
   if(opts.signal?.aborted)throw new DailyStateError('日程生成已中止',409);
   // 人工编辑、另一份修订或跨日都使旧生成快照失效。
   if(shanghaiDate(this.now())!==date||(this.get(accountId,date)?.revision??0)!==baseRevision)return this.result(accountId,date,'superseded');
   if(!opts.manual&&!this.canAuto())return this.result(accountId,date,'paused');
   this.store.db.prepare(`INSERT INTO daily_revisions(account_id,local_date,revision,content,source,generated_at,config_revision,call_id,interaction_id) VALUES(?,?,?,?,?,?,?,?,?)`).run(accountId,date,baseRevision+1,JSON.stringify(content),opts.manual?'manual-generation':'automatic',this.now(),configRevision,(response as any).callId??null,interactionId);
   this.store.db.prepare("UPDATE daily_attempts SET status='ready',error=NULL WHERE account_id=? AND local_date=?").run(accountId,date);
   return this.result(accountId,date,'ready');
  }catch(e) {
   const message=redact(e instanceof Error?e.message:e);
   this.store.db.prepare("UPDATE daily_attempts SET status='failed',error=?,call_id=COALESCE(?,call_id) WHERE account_id=? AND local_date=?").run(message,(e as any)?.callId??null,accountId,date);
   this.store.log('daily-state-error',JSON.stringify({accountId,date,interactionId,reason:e instanceof DailyStateError?'validation-or-control':'model-failure'}),'warn');
   const attempts=Number((this.store.db.prepare('SELECT attempts FROM daily_attempts WHERE account_id=? AND local_date=?').get(accountId,date) as any)?.attempts||0);
   return this.result(accountId,date,opts.manual?'failed':attempts>=3?'exhausted':'backoff',message);
  }finally {
   this.store.db.prepare('DELETE FROM daily_locks WHERE account_id=? AND local_date=? AND owner=?').run(accountId,date,owner);
  }
 }
 edit(accountId:string,date:string,raw:unknown,expectedRevision:number):DailyRevision {
  const a=account(accountId),content=validateDailyContent(raw,date);
  if(!Number.isInteger(expectedRevision)||expectedRevision<0)throw new DailyStateError('请提供有效日程修订号');
  this.store.db.exec('BEGIN IMMEDIATE');
  try {
   const previous=this.get(a,date);
   if((previous?.revision??0)!==expectedRevision)throw new DailyStateError('日程已更新，请重新读取后再保存',409);
   const settings=readPanelSettings() as any;
   this.store.db.prepare(`INSERT INTO daily_revisions(account_id,local_date,revision,content,source,generated_at,config_revision,call_id,interaction_id) VALUES(?,?,?,?,?,?,?,?,?)`).run(a,date,expectedRevision+1,JSON.stringify(content),'manual-edit',this.now(),Number(settings.revisions?.persona??0),null,null);
   this.store.db.exec('COMMIT');
  }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  return this.get(a,date)!;
 }
}
