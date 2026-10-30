import type {FastifyInstance} from 'fastify';
import type {UnknownReviews} from './unknown-reviews.js';

/** 沿用应用管理鉴权；审核只改变精确旧项对其他公开内容的阻塞。 */
export function registerUnknownReviewRoutes(app:FastifyInstance,reviews:UnknownReviews){
 const route=(fn:(request:any)=>unknown)=>async(request:any,reply:any)=>{
  try{return fn(request);}catch(error:any){return reply.code(Number(error?.statusCode)||400).send({error:error instanceof Error?error.message:'审核请求无效'});}
 };
 const body=(request:any,action:string)=>{
  const value=request.body;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['revision','confirmed','action'].includes(k))||typeof value.revision!=='string'||value.confirmed!==true||value.action!==action)throw Object.assign(new Error('审核需要当前修订、明确确认和指定动作'),{statusCode:400});
  return value;
 };
 app.get('/api/unknown-reviews',route(()=>reviews.list()));
 app.get('/api/outbox/:id/unknown-review',route(request=>reviews.preview(String(request.params.id))));
 app.post('/api/outbox/:id/unknown-review',route(request=>reviews.approve(String(request.params.id),body(request,'allow-other-public-items'))));
 app.post('/api/outbox/:id/unknown-review/revoke',route(request=>reviews.revoke(String(request.params.id),body(request,'restore-public-block'))));
}
