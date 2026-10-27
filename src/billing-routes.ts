import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { billingRange,LlmStore,type BillingFilter } from './llm-store.js';

export function registerBillingRoutes(app:FastifyInstance,deps:{store:Store}):void {
 const ledger=new LlmStore(deps.store);
 const read=(req:any)=>{const q=req.query||{};const range=billingRange(q.from,q.to);const filter:BillingFilter={start:range.start,end:range.end};for(const key of ['provider','model','purpose','accountId','interactionId'] as const)if(q[key]!==undefined){if(typeof q[key]!=='string'||q[key].length>250)throw new Error('筛选参数无效');filter[key]=q[key];}return {range,filter};};
 app.get('/api/billing/activity',async(req,reply)=>{try{const q=req.query as any;const raw=q.weeks??'52';if(typeof raw!=='string'||!/^\d+$/.test(raw))throw new Error('活动周数必须为1至52');return ledger.activity(Number(raw));}catch(e){return reply.code(400).send({error:(e as Error).message});}});
 app.get('/api/billing/summary',async(req,reply)=>{try{const {range,filter}=read(req);return {range,...ledger.summary(filter)};}catch(e){return reply.code(400).send({error:(e as Error).message});}});
 app.get('/api/billing/calls',async(req,reply)=>{try{const {range,filter}=read(req);const q=req.query as any;if(q.limit!==undefined&&(!/^\d+$/.test(q.limit)||Number(q.limit)<1||Number(q.limit)>100))throw new Error('分页数量必须为1至100');filter.limit=Number(q.limit)||30;if(q.cursor!==undefined){if(typeof q.cursor!=='string'||q.cursor.length>500)throw new Error('流水游标无效');filter.cursor=q.cursor;}return {range,...ledger.calls(filter)};}catch(e){return reply.code(400).send({error:(e as Error).message});}});
}
