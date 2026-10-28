import type { FastifyInstance } from 'fastify';
import { ActivityFeed,FeedError } from './activity-feed.js';
export function registerFeedRoutes(app:FastifyInstance,deps:{feed:ActivityFeed;wake:()=>void}){
 const wrap=(fn:(req:any)=>any)=>async(req:any,reply:any)=>{try{return await fn(req);}catch(e){if(e instanceof FeedError)return reply.code(e.statusCode).send({error:e.message,current:e.current});throw e;}};
 app.get('/api/feed',wrap(req=>deps.feed.list(req.query)));
 app.get('/api/feed/conversations',wrap(req=>deps.feed.conversations(req.query)));
 app.get('/api/feed/conversations/:key/items',wrap(req=>deps.feed.conversationItems(String(req.params.key),req.query)));
 for(const action of ['approve','cancel','regenerate'] as const)app.post('/api/messages/:id/'+action,{bodyLimit:128*1024},wrap(req=>{const result=deps.feed.mutate(String(req.params.id),action,req.body);deps.wake();return result;}));
}
