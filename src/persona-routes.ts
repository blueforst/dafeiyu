import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { readPanelSettings } from './settings.js';
import { redact } from './config.js';
import { PersonaService, PersonaValidationError } from './persona.js';
import { DailyStateService } from './daily-state.js';
import { LlmStore } from './llm-store.js';

type Deps = {store:Store;persona:PersonaService;daily:DailyStateService;accountId:()=>string};
export function registerPersonaRoutes(app:FastifyInstance,deps:Deps):void {
 const ledger=new LlmStore(deps.store);
 const handle=(fn:(req:any)=>unknown)=>async(req:any,reply:any)=>{
  try{return await fn(req);}catch(err:any){const code=err?.statusCode??(err instanceof PersonaValidationError?400:500);if(code>=500)deps.store.log('persona-api-error','人设操作异常，详细信息仅在对应调用流水中读取','warn');return reply.code(code).send({error:code>=500?'人设操作失败，请查看日志':redact(err?.message??err)});}
 };
 const account=()=>{const id=deps.accountId();if(!id){const e=new PersonaValidationError('请先确认浏览器当前账号');e.statusCode=409;throw e;}return id;};
 const scheduleTime=()=>{
  const tasks=readPanelSettings().tasks as any;
  return tasks?.plans?.['daily-state']?.time??'06:00';
 };
 const cost=(interactionId:string|null|undefined,callId?:string|null)=>{
  const totals=interactionId?ledger.summary({interactionId}).totals:ledger.summaryForCallIds(callId?[callId]:[]);
  return {estimatedUsd:totals.costUSD,unpriced:totals.unpriced,unknown:totals.unknown,requests:totals.calls};
 };
 const history=(id:string)=>deps.daily.history(id,7).map(state=>({...state,fees:cost(state.interactionId,state.callId)}));
 const daily=()=>{
  const id=deps.accountId();if(!id||id==='unknown')return null;
  const result=deps.daily.describe(id),interactionId=result.interactionId??result.today?.interactionId,callId=result.callId??result.today?.callId;
  return {...result,history:history(id),fees:cost(interactionId,callId),calls:interactionId?ledger.calls({interactionId,limit:100}).items:[],scheduleTime:scheduleTime()};
 };
 app.get('/api/persona',handle(()=>({...deps.persona.get(),daily:daily(),scheduleTime:scheduleTime()})));
 app.put('/api/persona',{bodyLimit:128*1024},handle(req=>{
  const revision=req.body?.revision;
  if(!Number.isInteger(revision)||revision<0)throw new PersonaValidationError('保存时需要当前人设修订号');
  return {ok:true,...deps.persona.save(req.body?.persona,revision),daily:daily(),scheduleTime:scheduleTime()};
 }));
 app.post('/api/persona/preview',{bodyLimit:128*1024},handle(req=>deps.persona.preview(req.body)));
 app.get('/api/persona/daily',handle(()=>daily()??{today:null,history:[],status:'unavailable',error:'当前账号未确认',scheduleTime:scheduleTime()}));
 app.get('/api/persona/daily/history',handle(()=>({items:history(account())})));
 app.put('/api/persona/daily',{bodyLimit:128*1024},handle(req=>{
  if(!Number.isInteger(req.body?.revision)||req.body.revision<0)throw new PersonaValidationError('编辑日程需要当前修订号');
  return {ok:true,state:deps.daily.edit(account(),req.body?.date,req.body?.content,req.body.revision),daily:daily()};
 }));
 app.post('/api/persona/daily/generate',handle(req=>{
  if(req.body?.revision!==undefined&&(!Number.isInteger(req.body.revision)||req.body.revision<0))throw new PersonaValidationError('日程修订号无效');
  return deps.daily.ensure(account(),{manual:true,force:true,expectedRevision:req.body?.revision});
 }));
}
