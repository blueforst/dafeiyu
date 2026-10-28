import type { FastifyInstance } from 'fastify';
import { redact } from './config.js';
import { ChatTestService } from './chat-test.js';

export function registerChatTestRoutes(app:FastifyInstance,deps:{service:ChatTestService}){
 const {service}=deps;
 const route=(fn:(request:any)=>unknown)=>async(request:any,reply:any)=>{try{return await fn(request);}catch(error:any){const code=Number.isInteger(error?.statusCode)?error.statusCode:500;return reply.code(code).send({error:code>=500?(code===503?'试聊数据无法读取，请保留 chat-test 目录并检查':'试聊操作失败，请查看对应调用记录'):redact(error instanceof Error?error.message:error)});}};
 const body={bodyLimit:64*1024};
 app.get('/api/chat-test/status',route(()=>service.status()));
 app.get('/api/chat-test/users',route(()=>service.users()));
 app.post('/api/chat-test/users',body,route(req=>service.createUser(req.body)));
 app.patch('/api/chat-test/users/:id',body,route(req=>service.updateUser(req.params.id,req.body)));
 app.delete('/api/chat-test/users/:id',body,route(req=>service.reset(req.params.id,true)));
 app.post('/api/chat-test/users/:id/reset',body,route(req=>service.reset(req.params.id)));
 app.post('/api/chat-test/users/:id/clear-cooldown',body,route(req=>service.clearCooldown(req.params.id)));
 app.get('/api/chat-test/users/:id/turns',route(req=>service.turns(req.params.id,req.query)));
 app.post('/api/chat-test/users/:id/messages',body,route(req=>service.addMessage(req.params.id,req.body)));
 app.post('/api/chat-test/users/:id/process',body,route(async req=>({turn:await service.process(req.params.id,req.body)})));
 app.post('/api/chat-test/users/:id/turns/:turnId/retry',body,route(req=>service.retry(req.params.id,req.params.turnId,req.body)));
 app.post('/api/chat-test/users/:id/turns/:turnId/cancel',body,route(req=>service.cancel(req.params.id,req.params.turnId)));
 app.get('/api/chat-test/users/:id/memory',route(req=>service.memory(req.params.id)));
 app.post('/api/chat-test/users/:id/memory/summarize',body,route(req=>service.summarize(req.params.id,req.body)));
}
