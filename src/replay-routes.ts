import type { FastifyInstance } from 'fastify';
import { redact } from './config.js';
import { ReplayRunner, ReplayError, REPLAY_ISSUES } from './persona-replay.js';
import type { Store } from './store.js';

/** 统一入口鉴权与控制请求标记由 app 的 onRequest hook 执行。 */
export function registerReplayRoutes(app:FastifyInstance,deps:{store:Store;replay:ReplayRunner}):void {
 const handle=(fn:(req:any)=>unknown)=>async(req:any,reply:any)=>{
  try{return await fn(req);}catch(error:any){const code=error?.statusCode??(error instanceof ReplayError?400:500);if(code>=500)deps.store.log('persona-replay-api-error','人设回放操作失败，请查看对应调用流水','warn');return reply.code(code).send({error:code>=500?'回放操作失败，请查看日志':redact(error instanceof Error?error.message:error)});}
 };
 const filter=(query:any)=>({from:query?.from,to:query?.to,channel:query?.channel,tier:query?.tier,includePrivate:query?.includePrivate===true||query?.includePrivate==='true',order:query?.order,limit:query?.limit===undefined?undefined:Number(query.limit)});
 app.get('/api/persona/replay/samples',handle(req=>deps.replay.samples(filter(req.query))));
 app.post('/api/persona/replay/estimate',{bodyLimit:128*1024},handle(req=>deps.replay.estimate(req.body)));
 app.delete('/api/persona/replay/estimates/:id',handle(req=>deps.replay.cancelEstimate(req.params.id)));
 app.post('/api/persona/replay/runs',handle(req=>deps.replay.start(req.body?.estimateId,req.body?.confirmed)));
 app.get('/api/persona/replay/runs',handle(()=>({...deps.replay.list(),issues:REPLAY_ISSUES})));
 app.get('/api/persona/replay/runs/:id',handle(req=>deps.replay.detail(req.params.id)));
 app.get('/api/persona/replay/runs/:id/items/:messageId',handle(req=>deps.replay.item(req.params.id,req.params.messageId)));
 app.put('/api/persona/replay/runs/:id/items/:messageId/label',handle(req=>deps.replay.label(req.params.id,req.params.messageId,req.body?.label,req.body?.issues??[])));
 app.post('/api/persona/replay/runs/:id/abort',handle(req=>deps.replay.abort(req.params.id)));
 app.post('/api/persona/replay/runs/:id/adopt',handle(req=>({ok:true,...deps.replay.adopt(req.params.id)})));
 app.delete('/api/persona/replay/runs/:id',handle(req=>deps.replay.delete(req.params.id)));
 app.get('/api/persona/quality',handle(req=>deps.replay.quality(filter(req.query))));
}
