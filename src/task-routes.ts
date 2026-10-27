import type { FastifyInstance } from 'fastify';
import { LlmStore } from './llm-store.js';
import { TASK_IDS,type TaskId,type TaskScheduler } from './scheduler.js';

type Deps={scheduler:TaskScheduler;workflow?:{pause:()=>Promise<unknown>;resume:()=>Promise<unknown>;control:()=>string}};
export function registerTaskRoutes(app:FastifyInstance,{scheduler,workflow}:Deps){
 const route=(fn:(request:any)=>Promise<unknown>|unknown)=>async(request:any,reply:any)=>{try{return await fn(request);}catch(error:any){return reply.code(Number(error?.statusCode)||400).send({error:error instanceof Error?error.message:'任务请求无效'});}};
 const id=(request:any):TaskId=>{const value=String(request.params.id);if(!(TASK_IDS as readonly string[]).includes(value))throw new Error('未知任务');return value as TaskId;};
 app.get('/api/tasks',route(()=>scheduler.list()));
 app.get('/api/tasks/runs',route(request=>scheduler.history(request.query??{})));
 app.get('/api/tasks/runs/:id',route(request=>{const run=scheduler.getRun(String(request.params.id));if(!run)throw Object.assign(new Error('任务记录不存在'),{statusCode:404});const row=run.outboxId?scheduler.store.db.prepare('SELECT id,kind,status,receipt,validation_json FROM outbox WHERE id=? AND account_id=?').get(run.outboxId,run.accountId) as any:undefined;let validation=null;try{validation=row?.validation_json?JSON.parse(row.validation_json):null;}catch{}const ledger=new LlmStore(scheduler.store);return {run:{...run,validation},calls:run.callIds.map(id=>ledger.get(id)).filter(Boolean),outbox:row?[row]:[]};}));
 app.put('/api/tasks/:id',route(async request=>{
  const task=id(request),body=request.body??{}, {revision,...patch}=body;
  if(revision!==undefined&&(!Number.isInteger(revision)||revision<0))throw new Error('设置修订无效');
  if(task==='main'&&patch.enabled!==undefined){
   if(!workflow||typeof patch.enabled!=='boolean')throw new Error('主循环控制不可用');
   // 间隔保存完成后才改变全局控制，保存其他计划不会隐式恢复。
   const {enabled,...configuration}=patch;
   if(Object.keys(configuration).length)scheduler.configure(task,configuration,revision);
   else if(revision!==undefined&&revision!==scheduler.revision())throw Object.assign(new Error('任务设置已被修改，请重新读取'),{statusCode:409});
   if(enabled)await workflow.resume();else await workflow.pause();
   return scheduler.list();
  }
  return scheduler.configure(task,patch,revision);
 }));
 app.post('/api/tasks/:id/run',route(async request=>({run:await scheduler.runNow(id(request))})));
}
