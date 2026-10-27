import type {FastifyInstance,FastifyReply} from 'fastify';
import {ModelLibraryError,ModelLibraryService} from './model-library.js';

/** 沿用应用级鉴权与 x-workflow-control 保护；路由本身不恢复工作流。 */
export function registerModelLibraryRoutes(app:FastifyInstance,library:ModelLibraryService):void {
 let busy=false;
 const handle=(fn:(req:any)=>Promise<unknown>,exclusive=false)=>async(req:any,reply:FastifyReply)=>{
  if(exclusive&&busy)return reply.code(409).send({error:'已有模型库请求进行中'});
  if(exclusive)busy=true;
  try{return await fn(req);}catch(error:any){if(error instanceof ModelLibraryError||error?.statusCode===409)return reply.code(error.statusCode).send({error:error.message,...error.extra});throw error;}finally{if(exclusive)busy=false;}
 };
 app.post('/api/model/library',handle(req=>library.add(req.body||{}),true));
 app.put('/api/model/library/:key',handle(req=>library.update(String(req.params.key),req.body||{}),true));
 app.delete('/api/model/library/:key',handle(req=>library.remove(String(req.params.key),req.body?.revision??req.query?.revision),true));
 app.post('/api/model/library/:key/refresh',handle(req=>library.refresh(String(req.params.key),req.body?.revision),true));
 app.put('/api/model/library/:key/models/:id',handle(req=>library.updateModel(String(req.params.key),String(req.params.id),req.body||{}),true));
 app.post('/api/model/library/:key/models/:id/test',handle(req=>library.test(String(req.params.key),String(req.params.id),req.body?.revision),true));
 app.put('/api/model/active',handle(req=>library.activate(req.body||{}),true));
}
