import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { applyMigration } from './migrations.js';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { mergePanelSettings, readPanelSettings } from './settings.js';
import { LlmStore } from './llm-store.js';
import {failureDetail} from './failure-summary.js';
import {replyWindow,type ReplyWindow} from './reply-hours.js';

export type StageMeta = { roundId?:string; messageId?:string; callId?:string; taskId?:string; channel?:string; accountId?:string };
export class Program {
 constructor(public store:Store) {
  applyMigration(store.db,7,'工作流阶段',`CREATE TABLE IF NOT EXISTS program_stages(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,round_id TEXT,message_id TEXT,call_id TEXT,task_id TEXT,channel TEXT,account_id TEXT,error TEXT); CREATE INDEX IF NOT EXISTS program_stages_time ON program_stages(started_at);`);
 }
 recover() { this.store.db.prepare("UPDATE program_stages SET status='interrupted',ended_at=? WHERE status='running'").run(Date.now()); }
 begin(name:string,meta:StageMeta={}) {
  const id=randomUUID();this.store.db.prepare('INSERT INTO program_stages(id,name,status,started_at,round_id,message_id,call_id,task_id,channel,account_id) VALUES(?,?,\'running\',?,?,?,?,?,?,?)').run(id,name,Date.now(),meta.roundId??null,meta.messageId??null,meta.callId??null,meta.taskId??null,meta.channel??null,meta.accountId??null);return id;
 }
 end(id:string,status='completed',error?:unknown) { this.store.db.prepare("UPDATE program_stages SET status=?,ended_at=?,error=? WHERE id=? AND status='running'").run(status,Date.now(),error?failureDetail(error):null,id); }
 async run<T>(name:string,meta:StageMeta,fn:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  const id=this.begin(name,meta);try { const value=await fn();const result=value as any,callId=result?.callId??result?.calls?.[0]?.callId;if(typeof callId==='string')this.store.db.prepare('UPDATE program_stages SET call_id=? WHERE id=?').run(callId,id);this.end(id,signal?.aborted?'aborted':'completed');return value; } catch(e) {if(typeof (e as any)?.callId==='string')this.store.db.prepare('UPDATE program_stages SET call_id=? WHERE id=?').run((e as any).callId,id);this.end(id,signal?.aborted?'aborted':'failed',e);throw e;}
 }
 list(limit=60) {return (this.store.db.prepare('SELECT * FROM program_stages ORDER BY started_at DESC,rowid DESC LIMIT ?').all(limit) as any[]).map(r=>({id:r.id,name:r.name,status:r.status,startedAt:r.started_at,endedAt:r.ended_at,durationMs:(r.ended_at??Date.now())-r.started_at,roundId:r.round_id,messageId:r.message_id,callId:r.call_id,taskId:r.task_id,channel:r.channel,accountId:r.account_id,error:r.error}));}
}

function pageSize(raw:any) {const n=Number(raw??50);return Number.isInteger(n)?Math.min(100,Math.max(1,n)):50;}
export function registerProgramRoutes(app:FastifyInstance,deps:{store:Store;program:Program;accountId?:()=>string;manualImports?:{forMessage:(id:string)=>unknown[]};workflow:{control:()=>string;busy:boolean;lastTick:number;nextTick:number;accountId:()=>string;sentCount:(channel:'public'|'private')=>number;replyHours?:()=>ReplyWindow}}) {
 const {store,program,workflow}=deps;
 const currentAccount=()=>deps.accountId?.()??workflow.accountId();
 const settings=()=>{const c=loadConfig();return {mode:c.mode,maxAgeHours:c.maxAgeHours,maxPerRound:c.maxPerRound,publicPerHour:c.publicPerHour,privatePerHour:c.privatePerHour,publicPerDay:c.publicPerDay??180,privatePerDay:c.privatePerDay??400,replyHours:c.replyHours??{enabled:true,closeDelayMinutes:30}};};
 app.get('/api/program',async()=>{
  const c=settings(),accountId=workflow.accountId(),stages=program.list();
  const items=(store.db.prepare("SELECT id,channel,status,account_id,created_at,error FROM messages WHERE account_id=? AND status IN ('queued','generating','sending','unknown') ORDER BY created_at LIMIT 50").all(accountId) as any[]).map(r=>({...r,accountId:r.account_id,createdAt:r.created_at}));
  const cooldown={public:Number(store.get('cooldown:public:'+accountId,store.get('cooldown:public','0'))),private:Number(store.get('cooldown:private:'+accountId,store.get('cooldown:private','0')))};
  const plans=readPanelSettings().tasks?.plans??{},window=workflow.replyHours?.()??replyWindow({now:Date.now(),...c.replyHours,morning:{enabled:plans['morning-post']?.enabled??false,time:plans['morning-post']?.time??'08:00'},eveningTime:plans['evening-post']?.time??'23:00'});
  return {control:workflow.control(),busy:workflow.busy,stage:stages.find(x=>x.status==='running')??{name:Object.values(cooldown).some(v=>v>Date.now())?'cooldown':'waiting',status:workflow.control(),startedAt:Number(store.get('lastTick','0'))||Date.now(),durationMs:0},stages,queue:{items,counts:store.db.prepare('SELECT channel,status,count(*) AS count FROM messages WHERE account_id=? GROUP BY channel,status').all(accountId)},lastTick:Number(store.get('lastTick','0')),nextTick:workflow.nextTick,cooldown,settings:c,replyHours:window,revision:readPanelSettings().revisions?.program??0,limits:{public:{used:workflow.sentCount('public'),limit:c.publicPerHour},private:{used:workflow.sentCount('private'),limit:c.privatePerHour}}};
 });
 app.put('/api/program/settings',async(req:any,reply)=>{
  const b=req.body??{},value=b.settings;
  if(!value||typeof value!=='object'||Array.isArray(value))return reply.code(400).send({error:'运行设置无效'});
  const allowed=['mode','maxAgeHours','maxPerRound','publicPerHour','privatePerHour','publicPerDay','privatePerDay','replyHours'];
  if(Object.keys(value).some(k=>!allowed.includes(k)))return reply.code(400).send({error:'运行设置包含不支持字段；轮询间隔请到定时任务页设置'});
  if(value.mode!==undefined&&!['draft','auto'].includes(value.mode))return reply.code(400).send({error:'运行模式无效'});
  for(const [key,min,max] of [['maxAgeHours',1,48],['maxPerRound',1,4],['publicPerHour',1,25],['privatePerHour',1,100],['publicPerDay',1,1000],['privatePerDay',1,500]] as const)if(value[key]!==undefined&&(!Number.isInteger(value[key])||value[key]<min||value[key]>max))return reply.code(400).send({error:key+' 超出范围'});
  if(value.replyHours!==undefined){const h=value.replyHours;if(!h||typeof h!=='object'||Array.isArray(h)||Object.keys(h).some(key=>!['enabled','closeDelayMinutes'].includes(key))||typeof h.enabled!=='boolean'||!Number.isInteger(h.closeDelayMinutes)||h.closeDelayMinutes<0||h.closeDelayMinutes>180)return reply.code(400).send({error:'回复时段设置无效'});}
  try {const r=mergePanelSettings('program',value,b.revision);return {ok:true,settings:settings(),revision:r.revision};}catch(e:any){return reply.code(e.statusCode===409?409:400).send({error:e.message});}
 });
 app.get('/api/messages',async(req:any)=>{
  const q=req.query??{},args:any[]=[currentAccount()],where=['account_id=?'];
  for(const k of ['status','channel'])if(q[k]){where.push(k+'=?');args.push(String(q[k]));}
  if(q.cursor){where.push('rowid<?');args.push(Number(q.cursor)||0);}
  const limit=pageSize(q.limit);args.push(limit+1);
  const rows=store.db.prepare('SELECT rowid AS cursor,id,channel,user_id,status,created_at,updated_at,error FROM messages WHERE '+where.join(' AND ')+' ORDER BY rowid DESC LIMIT ?').all(...args) as any[];
  return {items:rows.slice(0,limit),nextCursor:rows.length>limit?String(rows[limit-1].cursor):null};
 });
 app.get('/api/messages/:id',async(req:any,reply)=>{
  const row=store.getMessage(String(req.params.id),currentAccount());if(!row)return reply.code(404).send({error:'消息不存在'});
  const calls=new LlmStore(store).calls({interactionId:row.id,limit:100}).items;
  const outbox=store.db.prepare('SELECT id,kind,status,receipt,created_at,submitted_at,validation_json FROM outbox WHERE source_id=? AND account_id=?').all(row.id,row.account_id);
  let generation:any={};
  if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_snapshots'").get()){
   const snapshot=store.db.prepare('SELECT body_json FROM generation_snapshots WHERE message_id=? AND account_id=?').get(row.id,row.account_id) as {body_json:string}|undefined;
   try{generation=JSON.parse(snapshot?.body_json??'{}');}catch{/* 旧派生快照损坏时保留原消息的只读详情。 */}
  }
  const persona={id:generation.personaId??null,name:generation.personaName??'未记录',revision:generation.personaRevision??null};
  return {message:{...row,tier:row.tier??null,tierReason:row.tier_reason??null,persona,body:JSON.parse(row.body),draft:row.draft?JSON.parse(row.draft):null,receipt:row.receipt?JSON.parse(row.receipt):null},calls,outbox,manualImports:deps.manualImports?.forMessage(row.id)??[]};
 });
 app.get('/api/program/logs',async(req:any)=>{
  const q=req.query??{},where:string[]=[],args:any[]=[];
  if(q.level){where.push('level=?');args.push(String(q.level));}
  if(q.from&&Number.isFinite(Number(q.from))){where.push('at>=?');args.push(Number(q.from));}
  if(q.to&&Number.isFinite(Number(q.to))){where.push('at<?');args.push(Number(q.to));}
  if(q.cursor){where.push('id<?');args.push(Number(q.cursor)||0);}
  if(q.channel){where.push('detail LIKE ?');args.push('%"channel":"'+String(q.channel).replace(/[%_]/g,'')+'"%');}
  if(q.correlationId){where.push('detail LIKE ?');args.push('%'+String(q.correlationId).replace(/[%_]/g,'')+'%');}
  const limit=pageSize(q.limit);args.push(limit+1);const rows=store.db.prepare('SELECT * FROM logs'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY id DESC LIMIT ?').all(...args) as any[];
  return {items:rows.slice(0,limit).map(row=>{let meta:any={};try{const parsed=JSON.parse(row.detail);if(parsed&&typeof parsed==='object')meta=parsed;}catch{}return {...row,channel:meta.channel,correlationId:meta.id??meta.interactionId??meta.callId??meta.taskId??meta.roundId};}),nextCursor:rows.length>limit?String(rows[limit-1].id):null};
 });
}
