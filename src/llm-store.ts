import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { applyMigration } from './migrations.js';
import type { Store } from './store.js';

export type LlmPurpose = 'reply'|'semantic-trigger'|'daily-state'|'memory-summary'|'model-test'|'persona-preview'|'morning-post'|'evening-post'|string;
export type ReplaySide='baseline'|'candidate'|'shared';
export type CallMetadata = { purpose?:LlmPurpose; source?:string; accountId?:string; channel?:string; interactionId?:string; maxTokens?:number; reasoning?:string;jsonObject?:boolean;side?:ReplaySide };
export type CostSnapshot = { input:number; output:number; cacheRead:number; cacheWrite:number; total:number };
export type FullUsage = { input:number|null; output:number|null; cacheRead:number|null; cacheWrite:number|null; cacheWrite1h?:number|null; totalTokens:number|null; reasoning?:number|null };
export type PricingStatus = 'priced'|'unpriced'|'unknown';
export type CallStatus = 'started'|'completed'|'failed'|'aborted'|'interrupted';
export type CallResult = { usage?:FullUsage|null; cost?:CostSnapshot|null; pricingStatus?:PricingStatus; stopReason?:string; latencyMs?:number; actualModel?:string };
export type BillingFilter = { start?:number; end?:number; provider?:string; model?:string; purpose?:string; accountId?:string; interactionId?:string; cursor?:string; limit?:number };
export type BillingTotals = {calls:number;input:number;output:number;cache:number;cacheRead:number;cacheWrite:number;totalTokens:number;reasoning:number;costUSD:number|null;priced:number;unpriced:number;unknown:number;legacyRows:number};

const DAY_MS=86400000;
const BEIJING_DATE_SQL="date((started_at + 28800000)/1000, 'unixepoch')";
const PRICED_SQL="pricing_status='priced' AND cost_total IS NOT NULL";
const TOTALS_SQL=`COUNT(*) AS calls,
 COALESCE(SUM(input_tokens),0) AS input,COALESCE(SUM(output_tokens),0) AS output,
 COALESCE(SUM(cache_read),0) AS cache,COALESCE(SUM(cache_read),0) AS cacheRead,
 COALESCE(SUM(cache_write),0) AS cacheWrite,COALESCE(SUM(total_tokens),0) AS totalTokens,
 COALESCE(SUM(reasoning_tokens),0) AS reasoning,
 SUM(CASE WHEN ${PRICED_SQL} THEN cost_total END) AS costUSD,
 COALESCE(SUM(CASE WHEN ${PRICED_SQL} THEN 1 ELSE 0 END),0) AS priced,
 COALESCE(SUM(CASE WHEN pricing_status='unpriced' THEN 1 ELSE 0 END),0) AS unpriced,
 COALESCE(SUM(CASE WHEN pricing_status<>'unpriced' AND NOT (${PRICED_SQL}) THEN 1 ELSE 0 END),0) AS unknown,
 COALESCE(SUM(legacy),0) AS legacyRows`;

/** 数据库内归一和分组，结果大小取决于分组数量，而非调用总数。 */
function billingSource(filter:BillingFilter):{sql:string;args:(string|number)[]} {
 const {where,args}=whereFilter(filter);
 const legacy=includesLegacy(filter)?` UNION ALL SELECT at AS started_at,'legacy-unknown' AS purpose,NULL AS provider,'历史用量' AS model,NULL AS account_id,NULL AS interaction_id,input_tokens,output_tokens,cache_read,0 AS cache_write,input_tokens+output_tokens+cache_read AS total_tokens,0 AS reasoning_tokens,1 AS usage_known,NULL AS cost_total,'unknown' AS pricing_status,1 AS legacy FROM usage`:'';
 return {sql:`WITH billing_rows AS (SELECT started_at,purpose,provider,model,account_id,interaction_id,input_tokens,output_tokens,cache_read,cache_write,total_tokens,reasoning_tokens,usage_known,
  CASE WHEN json_valid(cost_json) THEN CASE WHEN json_type(cost_json,'$.total') IN ('integer','real') AND json_extract(cost_json,'$.total')>=0 THEN json_extract(cost_json,'$.total') END END AS cost_total,pricing_status,0 AS legacy FROM llm_calls${legacy}),
  filtered AS (SELECT * FROM billing_rows WHERE ${where})`,args};
}

export function initLlmSchema(db:DatabaseSync):void {
 applyMigration(db,2,'统一模型调用与价格快照',`
 CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
  purpose TEXT NOT NULL, source TEXT NOT NULL, account_id TEXT, channel TEXT, interaction_id TEXT,
  provider TEXT NOT NULL, model TEXT NOT NULL, actual_model TEXT,
  status TEXT NOT NULL, stop_reason TEXT, latency_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
  cache_write_1h INTEGER, total_tokens INTEGER, reasoning_tokens INTEGER,
  usage_known INTEGER NOT NULL DEFAULT 0, cost_json TEXT, pricing_status TEXT NOT NULL DEFAULT 'unknown',
  price_source TEXT
 );
 CREATE INDEX IF NOT EXISTS llm_calls_started ON llm_calls(started_at,id);
 CREATE INDEX IF NOT EXISTS llm_calls_interaction ON llm_calls(interaction_id,started_at);
 `);
}

function finite(v:unknown):number|null { return typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null; }
export function usageSnapshot(value:any, reliable=true):FullUsage|null {
 if(!value||!reliable)return null;
 const fields:FullUsage={input:finite(value.input),output:finite(value.output),cacheRead:finite(value.cacheRead),cacheWrite:finite(value.cacheWrite),totalTokens:finite(value.totalTokens)};
 if(value.reasoning!==undefined)fields.reasoning=finite(value.reasoning);
 if(value.cacheWrite1h!==undefined)fields.cacheWrite1h=finite(value.cacheWrite1h);
 return Object.values(fields).some(v=>v!==null)?fields:null;
}
export function costSnapshot(value:any):CostSnapshot|null {
 if(!value)return null;
 const input=finite(value.input),output=finite(value.output),cacheRead=finite(value.cacheRead),cacheWrite=finite(value.cacheWrite),total=finite(value.total);
 return [input,output,cacheRead,cacheWrite,total].every(v=>v!==null)?{input:input!,output:output!,cacheRead:cacheRead!,cacheWrite:cacheWrite!,total:total!}:null;
}

export class LlmStore {
 readonly db:DatabaseSync;
 constructor(store:Store|DatabaseSync){this.db='db' in store?store.db:store;initLlmSchema(this.db);}
 start(model:{provider:string;id:string},meta:CallMetadata={},now=Date.now()):string {
  const id=randomUUID();
  const source=meta.side&&['baseline','candidate','shared'].includes(meta.side)&&meta.purpose==='persona-replay'?(meta.source||'panel-replay').replace(/:(baseline|candidate|shared)$/,'')+':'+meta.side:meta.source||'workflow';
  this.db.prepare('INSERT INTO llm_calls(id,started_at,purpose,source,account_id,channel,interaction_id,provider,model,status) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,now,meta.purpose||'reply',source,meta.accountId||null,meta.channel||null,meta.interactionId||null,model.provider,model.id,'started');
  return id;
 }
 finish(id:string,status:Exclude<CallStatus,'started'>,result:CallResult={},now=Date.now()):void {
  const u=result.usage,c=result.cost;
  this.db.prepare(`UPDATE llm_calls SET finished_at=?,status=?,stop_reason=?,latency_ms=COALESCE(?,?-started_at),actual_model=?,input_tokens=?,output_tokens=?,cache_read=?,cache_write=?,cache_write_1h=?,total_tokens=?,reasoning_tokens=?,usage_known=?,cost_json=?,pricing_status=?,price_source=? WHERE id=? AND status='started'`).run(now,status,result.stopReason||null,result.latencyMs??null,now,result.actualModel||null,u?.input??null,u?.output??null,u?.cacheRead??null,u?.cacheWrite??null,u?.cacheWrite1h??null,u?.totalTokens??null,u?.reasoning??null,u?1:0,c?JSON.stringify(c):null,result.pricingStatus||'unknown',c?'pi-builtin-snapshot':null,id);
 }
 recoverInterrupted(now=Date.now()):number {
  return Number(this.db.prepare("UPDATE llm_calls SET status='interrupted',finished_at=?,latency_ms=?-started_at,stop_reason='process-restart' WHERE status='started'").run(now,now).changes);
 }
 get(id:string){const row=this.db.prepare('SELECT * FROM llm_calls WHERE id=?').get(id) as any;return row?callRow(row):null;}
 calls(filter:BillingFilter={}) {
  const {where,args}=whereFilter(filter);
  const limit=Math.max(1,Math.min(100,Math.trunc(filter.limit||30)));
  let extra='';
  if(filter.cursor){const decoded=decodeCursor(filter.cursor);extra=' AND (started_at<? OR (started_at=? AND id<?))';args.push(decoded.at,decoded.at,decoded.id);}
  const legacy=includesLegacy(filter);
  const source=legacy?`(SELECT * FROM llm_calls UNION ALL SELECT 'legacy-'||id,at,NULL,'legacy-unknown','legacy',NULL,NULL,NULL,'','',NULL,'completed',NULL,NULL,input_tokens,output_tokens,cache_read,NULL,NULL,input_tokens+output_tokens+cache_read,NULL,1,NULL,'unknown',NULL FROM usage)`:'llm_calls';
  const rows=this.db.prepare('SELECT * FROM '+source+' WHERE '+where+extra+' ORDER BY started_at DESC,id DESC LIMIT ?').all(...args,limit+1) as any[];
  const more=rows.length>limit;if(more)rows.pop();
  const last=rows.at(-1);
  return {items:rows.map(callRow),nextCursor:more&&last?Buffer.from(JSON.stringify({at:last.started_at,id:last.id})).toString('base64url'):null};
 }
 summary(filter:BillingFilter={}) {
  return {
   totals:this.totals(filter),
   daily:this.grouped(filter,BEIJING_DATE_SQL+' AS date','date','date'),
   models:this.grouped(filter,'provider,model','provider,model','totalTokens DESC,provider,model'),
   purposes:this.grouped(filter,'purpose','purpose','totalTokens DESC,purpose'),
   dailyModels:this.grouped(filter,BEIJING_DATE_SQL+' AS date,provider,model','date,provider,model','date,provider,model'),
   cache:this.cacheSummary(filter),priceSource:'Pi 内置目录估算',
  };
 }
 totals(filter:BillingFilter={}):BillingTotals {
  const {sql,args}=billingSource(filter);
  return {...this.db.prepare(sql+' SELECT '+TOTALS_SQL+' FROM filtered').get(...args)} as BillingTotals;
 }
 private grouped(filter:BillingFilter,labels:string,group:string,order:string):any[] {
  const {sql,args}=billingSource(filter);
  return this.db.prepare(sql+' SELECT '+labels+','+TOTALS_SQL+' FROM filtered GROUP BY '+group+' ORDER BY '+order).all(...args).map(row=>({...row}));
 }
 cacheSummary(filter:BillingFilter={}):{read:number;input:number;ratio:number|null} {
  const {sql,args}=billingSource(filter);
  // 缓存字段未返回时不能从输入 token 推导为零命中；只比较两字段均已知的调用。
  const row=this.db.prepare(sql+` SELECT COUNT(*) AS known,COALESCE(SUM(cache_read),0) AS read,COALESCE(SUM(input_tokens),0) AS input FROM filtered WHERE usage_known=1 AND cache_read IS NOT NULL AND input_tokens IS NOT NULL`).get(...args) as any;
  const denominator=row.input+row.read;
  return {read:row.read,input:row.input,ratio:row.known&&denominator>0?row.read/denominator:null};
 }
 activity(weeks=52,now=Date.now()) {
  if(!Number.isSafeInteger(weeks)||weeks<1||weeks>52)throw new Error('活动周数必须为1至52');
  if(!Number.isSafeInteger(now)||now<0)throw new Error('活动时间无效');
  const day=billingRange(beijingDate(now)),weekDay=new Date(day.start+28800000).getUTCDay();
  const end=day.start+(7-weekDay)*DAY_MS,start=end-weeks*7*DAY_MS;
  const range={from:beijingDate(start),to:beijingDate(end),start,end,timeZone:'Asia/Shanghai' as const,weeks,weekStartsOn:0};
  const all={end:day.end},recent={start:day.start-6*DAY_MS,end:day.end};
  const {sql,args}=billingSource(all);
  const peak=this.db.prepare(sql+' SELECT COALESCE(MAX(tokens),0) AS n FROM (SELECT SUM(COALESCE(total_tokens,0)) AS tokens FROM filtered GROUP BY '+BEIJING_DATE_SQL+')').get(...args) as any;
  const reply=this.totals({...recent,purpose:'reply'});
  return {
   range,daily:this.grouped({start,end:day.end},BEIJING_DATE_SQL+' AS date','date','date'),
   totals:this.totals(all),peakDailyTokens:peak.n,
   last7:{from:beijingDate(recent.start),to:beijingDate(recent.end),cache:this.cacheSummary(recent),reply:{calls:reply.priced,totalCalls:reply.calls,costUSD:reply.costUSD,averageCostUSD:reply.priced&&reply.costUSD!==null?reply.costUSD/reply.priced:null,unpriced:reply.unpriced,unknown:reply.unknown}},
   priceSource:'Pi 内置目录估算',
  };
 }
 summaryForCallIds(ids:string[]){
  const rows=[...new Set(ids)].slice(0,1000).map(id=>this.db.prepare('SELECT * FROM llm_calls WHERE id=?').get(id) as any).filter(Boolean);
  const totals=emptyTotals();for(const row of rows)addCall(totals,row);const result=finalTotals(totals);
  return {...result,missing:Math.max(0,new Set(ids).size-rows.length)};
 }
}

function callRow(r:any){const side=r.purpose==='persona-replay'?String(r.source).match(/^panel-replay:(baseline|candidate|shared)$/)?.[1]:undefined;return {id:r.id,startedAt:r.started_at,finishedAt:r.finished_at,purpose:r.purpose,source:r.source,...(side?{side:side as ReplaySide}:{}),accountId:r.account_id,channel:r.channel,interactionId:r.interaction_id,provider:r.provider,model:r.model,actualModel:r.actual_model,status:r.status,stopReason:r.stop_reason,latencyMs:r.latency_ms,usage:r.usage_known?{input:r.input_tokens,output:r.output_tokens,cacheRead:r.cache_read,cacheWrite:r.cache_write,cacheWrite1h:r.cache_write_1h,totalTokens:r.total_tokens,reasoning:r.reasoning_tokens}:null,cost:r.cost_json?JSON.parse(r.cost_json):null,pricingStatus:r.pricing_status,priceSource:r.price_source};}
function includesLegacy(f:BillingFilter):boolean{return !f.provider&&!f.model&&(!f.purpose||f.purpose==='legacy-unknown')&&!f.accountId&&!f.interactionId;}
function whereFilter(f:BillingFilter):{where:string;args:(string|number)[]}{let where='started_at>=? AND started_at<?';const args:(string|number)[]=[f.start??0,f.end??Number.MAX_SAFE_INTEGER];for(const [key,col] of [['provider','provider'],['model','model'],['purpose','purpose'],['accountId','account_id'],['interactionId','interaction_id']] as const)if(f[key]){where+=' AND '+col+'=?';args.push(f[key]!);}return {where,args};}
function decodeCursor(value:string):{at:number;id:string}{try{const r=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(Number.isSafeInteger(r.at)&&typeof r.id==='string'&&r.id.length<=100)return r;}catch{}throw new Error('流水游标无效');}
export function beijingDate(at:number):string{return new Date(at+8*3600000).toISOString().slice(0,10);}
export function billingRange(from?:string,to?:string,now=Date.now()){
 const date=beijingDate(now);const parse=(value:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('日期格式应为 YYYY-MM-DD');const n=Date.parse(value+'T00:00:00+08:00');if(!Number.isFinite(n)||beijingDate(n)!==value)throw new Error('日期无效');return n;};
 const start=parse(from||date);const end=to?parse(to):start+86400000;if(end<=start)throw new Error('结束日期必须晚于开始日期');if(end-start>3660*86400000)throw new Error('日期范围最多十年');
 return {from:beijingDate(start),to:beijingDate(end),start,end,timeZone:'Asia/Shanghai' as const};
}
function emptyTotals(){return {calls:0,input:0,output:0,cache:0,cacheRead:0,cacheWrite:0,totalTokens:0,reasoning:0,costUSD:0 as number|null,priced:0,unpriced:0,unknown:0,legacyRows:0};}
function addCall(t:any,r:any){t.calls++;for(const [key,col] of [['input','input_tokens'],['output','output_tokens'],['cacheRead','cache_read'],['cacheWrite','cache_write'],['totalTokens','total_tokens'],['reasoning','reasoning_tokens']])t[key]+=r[col]??0;t.cache=t.cacheRead;if(r.pricing_status==='priced'&&r.cost_json){t.priced++;t.costUSD+=JSON.parse(r.cost_json).total;}else if(r.pricing_status==='unpriced')t.unpriced++;else t.unknown++;}
function finalTotals(t:any){if(!t.priced)t.costUSD=null;return t;}
export function billingTotals(db:DatabaseSync){return new LlmStore(db).totals();}
