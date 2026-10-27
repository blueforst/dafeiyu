import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { applyMigration } from './migrations.js';
import { mergePanelSettings,readPanelSettings } from './settings.js';
import { HostMaintenance } from './host-maintenance.js';
import { LlmStore } from './llm-store.js';
import { redact } from './config.js';

export const TASK_IDS=['main','daily-state','memory-summary','morning-post','evening-post','backup','health','daily-report','account-check'] as const;
export type TaskId=typeof TASK_IDS[number];
export type TaskPlan={enabled:boolean;time?:string;intervalSeconds?:number};
export type TaskStatus='running'|'completed'|'failed'|'interrupted'|'unknown'|'missed'|'skipped'|'cancelled';
export type MainRunStatus='completed'|'failed'|'cancelled'|'interrupted';
export type TaskRun={id:string;taskId:TaskId;accountId:string;scheduledAt:number;source:'automatic'|'manual';status:TaskStatus;startedAt:number;finishedAt:number|null;durationMs:number|null;error:string|null;callIds:string[];outboxId:string|null;receipt:unknown;detail:string;attempts:number;hostRequestId:string|null;cost?:ReturnType<LlmStore['summaryForCallIds']>};
export type TaskOutcome={status?:'completed'|'unknown'|'skipped'|'cancelled';callIds?:string[];outboxId?:string;receipt?:unknown;detail?:string};
export type TaskContext={runId:string;taskId:TaskId;accountId:string;scheduledAt:number;source:'automatic'|'manual';signal:AbortSignal;ensureEnabled:()=>boolean};
export type SchedulerDeps={account:()=>string;control:()=>string;mode?:()=>string;nextTick?:()=>number;businessBusy?:()=>boolean;execute:(id:TaskId,ctx:TaskContext)=>Promise<TaskOutcome|void>;lookup?:(run:TaskRun,source?:'automatic'|'manual')=>Promise<TaskOutcome|void>;observe?:(id:'daily-report'|'account-check',ctx:TaskContext)=>Promise<TaskOutcome|void>;clock?:()=>number;host?:HostMaintenance};
export const BACKUP_SCOPE='仅业务 SQLite 数据库，保留最近七份；不包含面板配置、密钥、源码或浏览器 profile。恢复时必须保留并重放独立遗忘账本。';
export const DEFAULT_TASK_PLANS:Record<TaskId,TaskPlan>={main:{enabled:false,intervalSeconds:60},'daily-state':{enabled:true,time:'06:00'},'memory-summary':{enabled:true,time:'03:00'},'morning-post':{enabled:false,time:'08:00'},'evening-post':{enabled:false,time:'23:00'},backup:{enabled:false,time:'02:30'},health:{enabled:true,intervalSeconds:300},'daily-report':{enabled:true,time:'09:00'},'account-check':{enabled:true,time:'10:00'}};
const TITLES:Record<TaskId,string>={main:'主循环','daily-state':'虚构日程','memory-summary':'记忆补整理','morning-post':'早安帖','evening-post':'晚安帖',backup:'数据库备份',health:'宿主健康检查','daily-report':'每日日报','account-check':'账号合规检查'};
const HOST=new Set<TaskId>(['backup','health']);
const OBSERVE=new Set<TaskId>(['daily-report','account-check']);
const GREETING=new Set<TaskId>(['morning-post','evening-post']);
const TIME=/^([01]\d|2[0-3]):[0-5]\d$/;

export function shanghaiDate(now:number){return new Date(now+8*3600000).toISOString().slice(0,10);}
export function plannedAt(time:string,now:number){return Date.parse(shanghaiDate(now)+'T'+time+':00+08:00');}
function safeText(value:unknown){return redact(value??'').slice(0,500);}
function fromRow(r:any):TaskRun {return {id:r.id,taskId:r.task_id,accountId:r.account_id,scheduledAt:r.scheduled_at,source:r.source,status:r.status,startedAt:r.started_at,finishedAt:r.finished_at,durationMs:r.finished_at===null?null:Math.max(0,r.finished_at-r.started_at),error:r.error,callIds:JSON.parse(r.call_ids||'[]'),outboxId:r.outbox_id,receipt:r.receipt?JSON.parse(r.receipt):null,detail:r.detail||'',attempts:r.attempts,hostRequestId:r.host_request_id};}

export class TaskScheduler {
 private active=new Map<string,AbortController>();
 private now:()=>number;
 private billing:LlmStore;
 readonly host:HostMaintenance;
 constructor(readonly store:Store,readonly deps:SchedulerDeps){
  this.now=deps.clock??Date.now;this.host=deps.host??new HostMaintenance();this.billing=new LlmStore(store);
  applyMigration(store.db,5,'统一任务实例与历史',`
   CREATE TABLE IF NOT EXISTS task_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,account_id TEXT NOT NULL,scheduled_at INTEGER NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,error TEXT,call_ids TEXT NOT NULL DEFAULT '[]',outbox_id TEXT,receipt TEXT,detail TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 1,host_request_id TEXT,UNIQUE(task_id,account_id,scheduled_at));
   CREATE INDEX IF NOT EXISTS task_runs_history ON task_runs(started_at DESC,id DESC);
  `);
  store.db.prepare("UPDATE task_runs SET status=CASE WHEN outbox_id IS NOT NULL THEN 'unknown' ELSE 'interrupted' END,finished_at=?,error='进程重启中断' WHERE status='running' AND host_request_id IS NULL").run(this.now());
 }
 plans():Record<TaskId,TaskPlan>{
  const saved=(readPanelSettings().tasks as any)?.plans??{};
  const result={} as Record<TaskId,TaskPlan>;
  for(const id of TASK_IDS)result[id]={...DEFAULT_TASK_PLANS[id],...(saved[id]??{})};
  result.main.enabled=this.deps.control()==='running';
  return result;
 }
 revision(){return Number(readPanelSettings().revisions?.tasks??0);}
 /** 仅观察唯一工作流的真实轮次，不从调度器执行主循环。 */
 recordMainStart(runId:string,accountId:string,startedAt:number):TaskRun {
  if(typeof runId!=='string'||!runId||runId.length>200||typeof accountId!=='string'||accountId.length>200||!Number.isSafeInteger(startedAt)||startedAt<0)throw new Error('主循环记录无效');
  const existing=this.getRun(runId);
  if(existing){if(existing.taskId!=='main'||existing.accountId!==accountId)throw new Error('主循环标识已被使用');return existing;}
  this.store.db.prepare("INSERT INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at,detail) VALUES(?,'main',?,?,'automatic','running',?,'唯一工作流实际轮次')").run(runId,accountId,startedAt,startedAt);
  return this.getRun(runId)!;
 }
 recordMainEnd(runId:string,status:MainRunStatus,callIds:string[]=[]):TaskRun|null {
  if(!['completed','failed','cancelled','interrupted'].includes(status)||!Array.isArray(callIds)||callIds.length>1000||callIds.some(id=>typeof id!=='string'||!id||id.length>200))throw new Error('主循环结束记录无效');
  const run=this.getRun(runId);if(!run)return null;
  if(run.taskId!=='main')throw new Error('该记录不是主循环');
  if(run.status!=='running')return run;
  const ids=[...new Set([...run.callIds,...callIds])],finishedAt=Math.max(this.now(),run.startedAt);
  const error=status==='failed'?'本轮处理失败，请查看关联程序日志':status==='cancelled'?'本轮处理已中止':status==='interrupted'?'主循环中断':null;
  this.store.db.prepare("UPDATE task_runs SET status=?,finished_at=?,call_ids=?,error=? WHERE id=? AND task_id='main' AND status='running'").run(status,finishedAt,JSON.stringify(ids),error,runId);
  return this.getRun(runId);
 }
 get busy(){return this.active.size>0;}
 cancelBusiness(){for(const [id,abort] of this.active){if(!HOST.has(this.getRun(id)?.taskId??'health')&&this.getRun(id)?.taskId!=='daily-report')abort.abort();}}
 async waitIdle(){while(this.active.size){await new Promise(resolve=>setTimeout(resolve,20));}}
 private decorate(run:TaskRun){
  const linked=this.store.db.prepare('SELECT id FROM llm_calls WHERE interaction_id=? ORDER BY started_at,id LIMIT 1000').all(run.id) as {id:string}[];
  const callIds=[...new Set([...run.callIds,...linked.map(row=>row.id)])];
  return {...run,callIds,cost:this.billing.summaryForCallIds(callIds)};
 }
 list(){
  this.refreshHostRuns();const plans=this.plans(),now=this.now(),effectiveHostPlans=this.host.plans()??{};
  return {timezone:'Asia/Shanghai',revision:this.revision(),control:this.deps.control(),backupScope:BACKUP_SCOPE,hostAvailable:this.host.available(),tasks:TASK_IDS.map(id=>{
   const plan=plans[id],accountId=HOST.has(id)?'host':id==='daily-report'?(this.deps.account()||'system'):this.deps.account();
   const last=this.store.db.prepare('SELECT * FROM task_runs WHERE task_id=? AND account_id=? ORDER BY started_at DESC LIMIT 1').get(id,accountId) as any;
   let nextRunAt:number|null=null;
   if(plan.enabled){if(plan.time){const at=plannedAt(plan.time,now);nextRunAt=at>now?at:!last||last.scheduled_at!==at?at:at+86400000;if(id==='daily-state'&&last?.scheduled_at===at&&['failed','interrupted'].includes(last.status)&&last.attempts<3)nextRunAt=Math.max(now,(last.finished_at??last.started_at)+30*60000);}else if(plan.intervalSeconds)nextRunAt=(last?.finished_at??now)+plan.intervalSeconds*1000;}
   if(id==='main'&&plan.enabled&&this.deps.nextTick){const actual=this.deps.nextTick();nextRunAt=Number.isFinite(actual)&&actual>0?actual:null;}
   if(plan.enabled&&plan.time&&['daily-state','memory-summary'].includes(id)&&last?.status==='cancelled'&&last.scheduled_at===plannedAt(plan.time,now))nextRunAt=now;
   const latest=HOST.has(id)?this.host.latest(id as 'backup'|'health'):null;
   const effectiveHostPlan=HOST.has(id)?effectiveHostPlans[id]??null:null;
   return {id,title:TITLES[id],...plan,kind:id==='main'?'main':HOST.has(id)?'host':id==='daily-report'?'observation':'business',lastRun:last?this.decorate(fromRow(last)):null,nextRunAt,hostResult:latest,effectiveHostPlan,hostSource:effectiveHostPlan&&typeof effectiveHostPlan==='object'?'source' in effectiveHostPlan?effectiveHostPlan.source:null:null};
  })};
 }
 configure(id:TaskId,patch:Partial<TaskPlan>,expectedRevision?:number){
  this.assertTask(id);
  if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!['enabled','time','intervalSeconds'].includes(k)))throw new Error('任务配置字段无效');
  if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw new Error('任务开关无效');
  if(patch.time!==undefined&&(!TIME.test(patch.time)||!DEFAULT_TASK_PLANS[id].time))throw new Error('任务时间无效');
  if(patch.intervalSeconds!==undefined&&(id!=='main'||!Number.isInteger(patch.intervalSeconds)||patch.intervalSeconds<30||patch.intervalSeconds>3600))throw new Error('主循环间隔应为30至3600秒');
  if(id==='main'&&patch.enabled!==undefined)throw new Error('主循环启停需通过全局运行控制');
  const current=readPanelSettings(),saved=(current.tasks as any)?.plans??{},plan={...DEFAULT_TASK_PLANS[id],...(saved[id]??{}),...patch};
  if(HOST.has(id)){
   // 先检查修订再投递。宿主结果会明确区分已提交配置与已生效计划。
   if(expectedRevision!==undefined&&expectedRevision!==this.revision())throw Object.assign(new Error('任务设置已被修改，请重新读取'),{statusCode:409});
   this.host.request(id as 'backup'|'health','configure',{enabled:plan.enabled,...(plan.time?{time:plan.time}:{})});
  }
  const result=mergePanelSettings('tasks',{...(current.tasks as any??{}),plans:{...saved,[id]:plan}},expectedRevision);
  if(patch.enabled===false){for(const [runId,abort] of this.active){const run=this.getRun(runId);if(run?.taskId===id)abort.abort();}}
  return {...this.list(),revision:result.revision};
 }
 history(query:{taskId?:string;cursor?:string;limit?:number;accountId?:string}={}){
  const limit=Math.max(1,Math.min(100,Number(query.limit)||30));
  const where:string[]=[],args:(string|number)[]=[];
  if(query.taskId){this.assertTask(query.taskId);where.push('task_id=?');args.push(query.taskId);}
  if(query.accountId){where.push('account_id=?');args.push(query.accountId);}
  if(query.cursor){const cursor=this.getRun(query.cursor);if(!cursor)throw new Error('任务历史游标无效');where.push('(started_at<? OR (started_at=? AND id<?))');args.push(cursor.startedAt,cursor.startedAt,cursor.id);}
  const rows=this.store.db.prepare('SELECT * FROM task_runs'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY started_at DESC,id DESC LIMIT ?').all(...args,limit+1) as any[];
  return {items:rows.slice(0,limit).map(row=>this.decorate(fromRow(row))),nextCursor:rows.length>limit?rows[limit-1].id:null};
 }
 getRun(id:string):TaskRun|null {const row=this.store.db.prepare('SELECT * FROM task_runs WHERE id=?').get(id);return row?this.decorate(fromRow(row)):null;}
 /** 日报不涉及浏览器和模型，暂停期间仍可补生成；由独立 app 周期调用。 */
 async tickObservability(){
  if(!this.deps.observe)return;
  const now=this.now();
  for(const id of ['daily-report','account-check'] as const){
   if(id==='account-check'&&(this.deps.control()!=='running'||!this.deps.account()||this.deps.businessBusy?.()))continue;
   const plan=this.plans()[id];if(!plan.enabled||!plan.time)continue;
   const at=plannedAt(plan.time,now);if(now<at)continue;
   await this.run(id,'automatic',at,false);
  }
 }
 async tick(){
  this.refreshHostRuns();
  await this.tickObservability();
  if(this.deps.control()!=='running'||!this.deps.account())return;
  const unknown=this.store.db.prepare("SELECT * FROM task_runs WHERE status='unknown' AND account_id=? ORDER BY started_at LIMIT 20").all(this.deps.account()) as any[];
  for(const row of unknown){
   if(this.deps.control()!=='running')return;
   try{await this.reconcileRun(fromRow(row),'automatic');}catch(error){this.store.db.prepare('UPDATE task_runs SET error=? WHERE id=?').run(safeText(error instanceof Error?error.message:error),row.id);}
  }
  const now=this.now();
  for(const id of ['daily-state','memory-summary','morning-post','evening-post'] as TaskId[]){
   if(this.deps.control()!=='running')return;
   // 前一任务可能等待模型；下一项必须重读开关及时间，不复用旧计划快照。
   const plan=this.plans()[id];if(!plan.enabled||!plan.time)continue;
   const at=plannedAt(plan.time,now);if(now<at)continue;
   await this.run(id,'automatic',at,false);
  }
 }
 async runNow(id:TaskId){
  this.assertTask(id);
  if(id==='main'){
   if(this.deps.control()!=='running')throw new Error('主循环当前暂停，请先恢复处理');
   throw new Error('主循环由唯一工作流运行器执行，请使用全局运行控制');
  }
  const plan=this.plans()[id],now=this.now();
  const at=plan.time?plannedAt(plan.time,now):Math.floor(now/(plan.intervalSeconds??300)/1000)*(plan.intervalSeconds??300)*1000;
  return this.run(id,'manual',at);
 }
 private async run(id:TaskId,source:'automatic'|'manual',scheduledAt:number,lookup=true):Promise<TaskRun>{
  const accountId=HOST.has(id)?'host':id==='daily-report'?(this.deps.account()||'system'):this.deps.account();
  if(!accountId)throw new Error('无法确认当前工作账号');
  if(source==='automatic'&&(!this.plans()[id].enabled||(id!=='daily-report'&&this.deps.control()!=='running')))return this.createTerminal(id,accountId,scheduledAt,source,'cancelled','任务已关闭或业务已暂停');
  const existingRow=this.store.db.prepare('SELECT * FROM task_runs WHERE task_id=? AND account_id=? AND scheduled_at=?').get(id,accountId,scheduledAt);
  if(existingRow){
   const existing=fromRow(existingRow);
   if(existing.status==='unknown'&&lookup)await this.reconcileRun(existing,source);
   if(id==='daily-state'&&['failed','interrupted'].includes(existing.status)&&!this.active.has(existing.id)){
    const automaticRetry=existing.attempts<3&&this.now()-(existing.finishedAt??existing.startedAt)>=30*60000;
    if(source==='manual'||automaticRetry){
     const claimed=this.store.db.prepare("UPDATE task_runs SET status='running',finished_at=NULL,error=NULL,attempts=attempts+1 WHERE id=? AND status IN ('failed','interrupted')").run(existing.id);
     if(claimed.changes)return this.executeRun(existing.id,id,accountId,source,scheduledAt);
    }
   }
   // 暂停或关闭发生在提交前时，恢复只补当前日期的可重入维护工作。
   if(['daily-state','memory-summary'].includes(id)&&existing.status==='cancelled'&&!existing.outboxId&&!this.active.has(existing.id)){
    const claimed=this.store.db.prepare("UPDATE task_runs SET status='running',finished_at=NULL,error=NULL,attempts=attempts+1 WHERE id=? AND status='cancelled' AND outbox_id IS NULL").run(existing.id);
    if(claimed.changes)return this.executeRun(existing.id,id,accountId,source,scheduledAt);
   }
   return this.getRun(existing.id)!;
  }
  const now=this.now();
  if(GREETING.has(id)&&(this.deps.control()!=='running'||this.deps.mode?.()!=='auto')){
   if(source==='manual')throw new Error('发帖需要恢复处理并使用自动模式');
   return this.createTerminal(id,accountId,scheduledAt,source,'skipped','当前不是自动发帖模式');
  }
  if(GREETING.has(id)&&(now<scheduledAt||now-scheduledAt>5*60000))return this.createTerminal(id,accountId,scheduledAt,source,'missed','已错过计划后的五分钟窗口');
  const runId=randomUUID();
  const inserted=this.store.db.prepare("INSERT OR IGNORE INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at) VALUES(?,?,?,?,?,'running',?)").run(runId,id,accountId,scheduledAt,source,now);
  if(!inserted.changes)return this.decorate(fromRow(this.store.db.prepare('SELECT * FROM task_runs WHERE task_id=? AND account_id=? AND scheduled_at=?').get(id,accountId,scheduledAt)));
  return this.executeRun(runId,id,accountId,source,scheduledAt);
 }
 private async executeRun(runId:string,id:TaskId,accountId:string,source:'automatic'|'manual',scheduledAt:number):Promise<TaskRun>{
  const abort=new AbortController();this.active.set(runId,abort);
  const startedEnabled=this.plans()[id].enabled;
  const ensureEnabled=()=>!abort.signal.aborted&&(source==='automatic'?this.plans()[id].enabled&&(id==='daily-report'||this.deps.control()==='running'):!startedEnabled||this.plans()[id].enabled);
  try{
   if(!ensureEnabled()){this.finish(runId,{status:'cancelled',detail:'任务已关闭或业务已暂停'});return this.getRun(runId)!;}
   if(HOST.has(id)){
    const request=this.host.request(id as 'backup'|'health','run');
    this.store.db.prepare('UPDATE task_runs SET host_request_id=?,detail=? WHERE id=?').run(request.id,'请求已提交，等待独立宿主执行',runId);
   }else{
    const context={runId,taskId:id,accountId,scheduledAt,source,signal:abort.signal,ensureEnabled};
    if(OBSERVE.has(id)&&!this.deps.observe)throw new Error('健康观察任务尚未接入');
    const outcome=OBSERVE.has(id)?await this.deps.observe!(id as 'daily-report'|'account-check',context):await this.deps.execute(id,context);
    this.finish(runId,outcome??{status:abort.signal.aborted?'cancelled':'completed'});
   }
  }catch(error){this.store.db.prepare("UPDATE task_runs SET status=?,finished_at=?,error=? WHERE id=?").run(abort.signal.aborted?'cancelled':'failed',this.now(),safeText(error instanceof Error?error.message:error),runId);}
  finally{this.active.delete(runId);}
  return this.getRun(runId)!;
 }
 private createTerminal(id:TaskId,accountId:string,scheduledAt:number,source:'automatic'|'manual',status:TaskStatus,detail:string){
  const runId=randomUUID(),now=this.now();
  this.store.db.prepare('INSERT OR IGNORE INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at,finished_at,detail) VALUES(?,?,?,?,?,?,?,?,?)').run(runId,id,accountId,scheduledAt,source,status,now,now,detail);
  return this.decorate(fromRow(this.store.db.prepare('SELECT * FROM task_runs WHERE task_id=? AND account_id=? AND scheduled_at=?').get(id,accountId,scheduledAt)));
 }
 private finish(runId:string,outcome:TaskOutcome){
  const old=this.getRun(runId);if(!old)return;
  const callIds=[...new Set([...old.callIds,...(outcome.callIds??[])])];
  this.store.db.prepare('UPDATE task_runs SET status=?,finished_at=?,call_ids=?,outbox_id=COALESCE(?,outbox_id),receipt=COALESCE(?,receipt),detail=?,error=NULL WHERE id=?').run(outcome.status??'completed',this.now(),JSON.stringify(callIds),outcome.outboxId??null,outcome.receipt?JSON.stringify(outcome.receipt):null,safeText(outcome.detail??''),runId);
 }
 private async reconcileRun(run:TaskRun,source:'automatic'|'manual'){
  if(!this.deps.lookup||this.active.has(run.id))return;
  const lock=new AbortController();this.active.set(run.id,lock);
  try{const result=await this.deps.lookup(this.getRun(run.id)??run,source);if(result)this.finish(run.id,result);}finally{this.active.delete(run.id);}
 }
 private refreshHostRuns(){
  const rows=this.store.db.prepare("SELECT id,host_request_id FROM task_runs WHERE status='running' AND host_request_id IS NOT NULL").all() as any[];
  for(const row of rows){const result=this.host.result(row.host_request_id);if(!result)continue;const success=result.ok===true||result.status==='completed';this.store.db.prepare('UPDATE task_runs SET status=?,finished_at=?,error=?,receipt=?,detail=? WHERE id=?').run(success?'completed':'failed',this.now(),success?null:safeText(result.error??'宿主维护失败'),JSON.stringify(result),'独立宿主维护结果',row.id);}
  for(const task of ['backup','health'] as const){
   const result=this.host.latest(task) as any;if(!result?.id||!Number.isSafeInteger(result.startedAt)||!Number.isSafeInteger(result.endedAt))continue;
   const known=this.store.db.prepare("SELECT id FROM task_runs WHERE id=? OR host_request_id=? OR json_extract(receipt,'$.instanceId')=?").get(result.id,result.id,result.id);if(known)continue;
   const success=result.status==='completed';
   const scheduledAt=task==='health'?Math.floor(result.startedAt/300000)*300000:plannedAt(this.plans().backup.time??'02:30',result.startedAt);
   this.store.db.prepare('INSERT OR IGNORE INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at,finished_at,error,host_request_id,receipt,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(result.id,task,'host',scheduledAt,'automatic',success?'completed':'failed',result.startedAt,result.endedAt,success?null:safeText(result.error??'宿主维护失败'),result.id,JSON.stringify(result),'独立宿主定时维护结果');
  }
 }
 private assertTask(id:string):asserts id is TaskId {if(!(TASK_IDS as readonly string[]).includes(id))throw new Error('未知任务');}
}
