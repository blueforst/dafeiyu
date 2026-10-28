import type { FastifyInstance } from 'fastify';
import { ExperienceError,type RoleExperienceService } from './role-experiences.js';

export function registerRoleExperienceRoutes(app:FastifyInstance,deps:{experiences:RoleExperienceService}){
 const wrap=(fn:(req:any)=>unknown)=>async(req:any,reply:any)=>{try{return await fn(req);}catch(error){if(error instanceof ExperienceError)return reply.code(error.statusCode).send({error:error.message});throw error;}};
 app.get('/api/memory/experiences',wrap(req=>deps.experiences.list(req.query)));
 app.post('/api/memory/experiences',{bodyLimit:16*1024},wrap(req=>deps.experiences.create(req.body)));
 app.put('/api/memory/experiences/:id',{bodyLimit:16*1024},wrap(req=>deps.experiences.edit(String(req.params.id),req.body)));
 for(const [action,hidden] of [['hide',true],['unhide',false]] as const)app.post('/api/memory/experiences/:id/'+action,wrap(req=>{
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).some(k=>k!=='revision'))throw new ExperienceError('隐藏操作参数无效');
  return deps.experiences.setHidden(String(req.params.id),hidden,req.body.revision);
 }));
}
