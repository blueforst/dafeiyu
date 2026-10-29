import type { FastifyInstance } from 'fastify';
import { ReplyTriage,TriageError,normalizeTriageSettings,type TriageSettings } from './reply-triage.js';
import type { Channel } from './types.js';

type Deps={triage:ReplyTriage;accountId:()=>string;publicPerDay?:()=>number;privatePerDay?:()=>number;maxAgeHours?:()=>number;settings?:()=>{settings:TriageSettings;maxAgeHours?:number;revision:number;programRevision?:number};saveSettings?:(settings:TriageSettings,revision:number,maxAgeHours?:number,programRevision?:number)=>unknown;wake?:()=>void};
export function registerTriageRoutes(app:FastifyInstance,deps:Deps){
 const route=(fn:(request:any)=>unknown)=>async(request:any,reply:any)=>{try{return await fn(request);}catch(error:any){const code=error?.statusCode??400;return reply.code(code).send({error:code>=500?'分级操作失败，请查看日志':error instanceof Error?error.message:'分级参数无效'});}};
 const account=()=>{const id=deps.accountId();if(!id)throw new TriageError('请先确认浏览器当前账号',409);return id;};
 const scope=(request:any)=>{const raw=request.body??request.query??{},userId=String(raw.userId??request.params?.userId??'');if(!userId||userId.length>300||!['public','private'].includes(raw.channel))throw new TriageError('用户或渠道无效');return {userId,channel:raw.channel as Channel,accountId:account()};};
 app.get('/api/triage/summary',route(()=>deps.triage.summary(account(),deps.publicPerDay?.()??180,deps.privatePerDay?.()??400)));
 app.post('/api/messages/:id/requeue',route(request=>{const result=deps.triage.requeue(String(request.params.id),account());deps.wake?.();return result;}));
 app.get('/api/triage/ignores',route(()=>({items:deps.triage.ignores(account())})));
 app.delete('/api/triage/ignores',route(request=>{const value=scope(request);return deps.triage.clearIgnore(value.userId,value.channel,value.accountId);}));
 app.delete('/api/triage/ignores/:userId',route(request=>{const value=scope(request);return deps.triage.clearIgnore(value.userId,value.channel,value.accountId);}));
 if(deps.settings)app.get('/api/triage/settings',route(()=>{const res=deps.settings!();return {maxAgeHours:deps.maxAgeHours?.()??3,programRevision:0,...res};}));
 if(deps.saveSettings)app.put('/api/triage/settings',{bodyLimit:64*1024},route(request=>{
  const body=request.body??{};
  if(!Number.isSafeInteger(body.revision)||body.revision<0)throw new TriageError('保存分级设置需要当前修订号');
  const rawMaxAge=body.maxAgeHours!==undefined?body.maxAgeHours:body.settings?.maxAgeHours;
  if(rawMaxAge!==undefined&&(!Number.isInteger(rawMaxAge)||rawMaxAge<1||rawMaxAge>48))throw new TriageError('分级设置范围无效：maxAgeHours');
  return deps.saveSettings!(normalizeTriageSettings(body.settings,rawMaxAge??deps.maxAgeHours?.()??3),body.revision,rawMaxAge,body.programRevision);
 }));
}
