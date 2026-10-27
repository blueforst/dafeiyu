import type { FastifyInstance } from 'fastify';
import type { PostingCapabilitiesService,PostingCapabilities } from './posting-capabilities.js';
type Deps={capabilities:PostingCapabilitiesService;control:()=>string;busy:()=>boolean;refresh:()=>Promise<PostingCapabilities>;operation:<T>(fn:()=>Promise<T>)=>Promise<T>};
export function registerPostingRoutes(app:FastifyInstance,deps:Deps){
 app.get('/api/account/posting-limits',async()=>deps.capabilities.get());
 app.post('/api/account/posting-limits/refresh',async(_req,reply)=>{
  if(['manual','draining'].includes(deps.control())||deps.busy())return reply.code(409).send({error:'人工接管、排空或当前业务操作期间不能刷新能力'});
  try{return await deps.operation(async()=>deps.capabilities.accept(await deps.refresh()));}catch{return reply.code(409).send({error:'能力刷新失败，继续使用短帖默认限制'});}
 });
}
