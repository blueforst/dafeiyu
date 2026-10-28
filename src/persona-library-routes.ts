import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import type { PersonaService } from './persona.js';
import { PersonaValidationError } from './persona.js';
import { redact } from './config.js';

/** 鉴权、同源与控制请求标记由 app 的共同入口处理。 */
export function registerPersonaLibraryRoutes(app:FastifyInstance,deps:{store:Store;persona:PersonaService}):void {
 const handle=(fn:(req:any)=>unknown)=>async(req:any,reply:any)=>{try{return await fn(req);}catch(error:any){const code=error?.statusCode??(error instanceof PersonaValidationError?400:500);if(code>=500)deps.store.log('persona-library-api-error','人设库操作失败，原设置保持不变','warn');return reply.code(code).send({error:code>=500?'人设库操作失败，请检查设置文件':redact(error?.message??error)});}};
 app.get('/api/personas',handle(()=>deps.persona.library.list()));
 app.get('/api/personas/:id',handle(req=>deps.persona.library.detail(req.params.id)));
 app.post('/api/personas',{bodyLimit:128*1024},handle(req=>deps.persona.library.create(req.body)));
 app.put('/api/personas/:id',{bodyLimit:128*1024},handle(req=>deps.persona.library.save(req.params.id,req.body)));
 app.post('/api/personas/:id/activate',{bodyLimit:128*1024},handle(req=>deps.persona.library.activate(req.params.id,req.body?.libraryRevision)));
 app.delete('/api/personas/:id',{bodyLimit:128*1024},handle(req=>deps.persona.library.delete(req.params.id,req.body?.revision)));
}
