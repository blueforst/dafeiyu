import type { FastifyInstance } from 'fastify';
import { MemoryError, type MemoryService } from './memory.js';
import type { Channel } from './types.js';

type Deps={memory:MemoryService;account:()=>string};
function scope(req:any,deps:Deps){
 const b=req.body??{},q=req.query??{};
 const accountId=String(b.accountId??q.accountId??deps.account()??'');
 const userId=String(req.params?.id??'');
 const channel=String(b.channel??q.channel??'public')||'public';
 if(accountId.length>200||userId.length>300||!['public','private'].includes(channel))throw new MemoryError('记忆范围无效');
 return {accountId,userId,channel:channel as Channel};
}
export function registerMemoryRoutes(app:FastifyInstance,deps:Deps){
 const handle=(fn:(req:any)=>any)=>async(req:any,reply:any)=>{try{return await fn(req);}catch(e:any){if(e instanceof MemoryError||Number.isInteger(e?.statusCode))return reply.code(e.statusCode??400).send({error:e.message});throw e;}};
 app.get('/api/memory/links',handle(req=>{const s=scope(req,deps);return deps.memory.links.detail(s.accountId,String(req.query?.userId??''));}));
 app.put('/api/memory/links',handle(req=>{const s=scope(req,deps),b=req.body??{};if(typeof b.publicHandle!=='string'||!/^@?[a-zA-Z0-9_]{1,15}$/.test(b.publicHandle))throw new MemoryError('公开 handle 无效');return deps.memory.links.link(s.accountId,b.privateUserId,'x:'+b.publicHandle.replace(/^@/,'').toLowerCase(),'admin');}));
 app.delete('/api/memory/links',handle(req=>{const s=scope(req,deps);return deps.memory.links.unlink(s.accountId,req.body?.privateUserId);}));
 app.get('/api/memory/policy',handle(()=>deps.memory.policy()));
 app.put('/api/memory/policy',handle(req=>deps.memory.savePolicy(req.body?.policy,req.body?.revision)));
 app.get('/api/memory/users',handle(req=>{
  const s=scope(req,deps),q=req.query??{};
  const channel=q.channel===undefined||q.channel===''?undefined:s.channel;
  const cursor=q.cursor===undefined?0:Number(q.cursor),limit=q.limit===undefined?30:Number(q.limit);
  if(!Number.isInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>100||String(q.q??'').length>200)throw new MemoryError('记忆分页参数无效');
  return deps.memory.listUsers({accountId:s.accountId,channel,q:String(q.q??''),cursor,limit});
 }));
 app.get('/api/memory/users/:id',handle(req=>{const s=scope(req,deps);return deps.memory.detail(s.userId,s.channel,s.accountId);}));
 app.put('/api/memory/items/:id',handle(req=>{const s=scope(req,deps);return deps.memory.edit(s.userId,s.accountId,req.body?.text,req.body?.revision);}));
 app.delete('/api/memory/items/:id',handle(req=>{const s=scope(req,deps);return deps.memory.remove(s.userId,s.accountId,req.body?.revision);}));
 app.post('/api/memory/users/:id/summarize',handle(req=>{const s=scope(req,deps);return deps.memory.summarize(s.userId,s.channel,s.accountId,{force:true});}));
 app.post('/api/memory/users/:id/forget',handle(req=>{const s=scope(req,deps);return deps.memory.forget(s.userId,s.accountId);}));
 app.post('/api/memory/users/:id/remember',handle(req=>{const s=scope(req,deps);return deps.memory.remember(s.userId,s.accountId);}));
 app.post('/api/memory/users/:id/preview',handle(req=>{const s=scope(req,deps);return {...deps.memory.context(s.userId,s.channel,s.accountId),readonly:true};}));
}
