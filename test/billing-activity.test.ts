import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { LlmStore,billingRange } from '../src/llm-store.js';
import { registerBillingRoutes } from '../src/billing-routes.js';

function fixture(){const dir=mkdtempSync(tmpdir()+'/role-billing-activity-'),store=new Store(dir+'/workflow.sqlite'),ledger=new LlmStore(store);return {store,ledger,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
const at=(date:string)=>Date.parse(date+'T12:00:00+08:00');
function record(ledger:LlmStore,time:number,options:{model?:string;purpose?:string;priced?:number;usage?:boolean;cache?:number|null;account?:string}={}){
 const id=ledger.start({provider:'fixture',id:options.model||'model-a'},{purpose:options.purpose||'reply',accountId:options.account},time);
 ledger.finish(id,'completed',{
  usage:options.usage===false?null:{input:80,output:10,cacheRead:options.cache===undefined?20:options.cache,cacheWrite:0,totalTokens:options.cache===null?90:110},
  cost:options.priced===undefined?null:{input:0,output:0,cacheRead:0,cacheWrite:0,total:options.priced},
  pricingStatus:options.usage===false?'unknown':options.priced===undefined?'unpriced':'priced',
 },time+1);return id;
}

test('SQL 汇总按北京日期与模型分组，旧用量只计一次并保留未知成本',()=>{
 const f=fixture();try{
  const boundary=billingRange('2026-10-28','2026-10-29');
  record(f.ledger,boundary.start-1,{priced:1});record(f.ledger,boundary.start,{priced:2});record(f.ledger,boundary.end-1,{model:'model-b'});record(f.ledger,boundary.end,{priced:4});
  f.store.db.prepare('INSERT INTO usage(at,input_tokens,output_tokens,cache_read) VALUES(?,?,?,?)').run(boundary.start,7,3,2);
  const result=f.ledger.summary({start:boundary.start,end:boundary.end});
  assert.equal(result.totals.calls,3);assert.equal(result.totals.totalTokens,232);assert.equal(result.totals.costUSD,2);assert.equal(result.totals.unpriced,1);assert.equal(result.totals.unknown,1);assert.equal(result.totals.legacyRows,1);
  assert.equal(result.daily.length,1);assert.equal(result.daily[0].date,'2026-10-28');assert.equal(result.daily[0].calls,3);
  assert.equal(result.dailyModels.length,3);assert.ok(result.dailyModels.some(r=>r.model==='历史用量'&&r.costUSD===null));
  assert.equal(result.dailyModels.reduce((n,r)=>n+r.totalTokens,0),result.totals.totalTokens);
  assert.equal(result.models.reduce((n,r)=>n+r.calls,0),result.totals.calls);assert.equal(result.purposes.reduce((n,r)=>n+r.calls,0),result.totals.calls);
  assert.equal(f.ledger.calls({start:boundary.start,end:boundary.end}).items.length,result.totals.calls);
  assert.equal(f.ledger.summary({purpose:'reply'}).totals.legacyRows,0);assert.equal(f.ledger.summary({purpose:'legacy-unknown'}).totals.calls,1);
 }finally{f.close();}
});

test('缓存字段全缺失显示未知，部分已知只使用相同调用的输入与缓存',()=>{
 const f=fixture();try{
  record(f.ledger,at('2026-10-28'),{cache:null});record(f.ledger,at('2026-10-28'),{usage:false});
  assert.deepEqual(f.ledger.summary().cache,{read:0,input:0,ratio:null});
  record(f.ledger,at('2026-10-28'),{cache:20});
  assert.deepEqual(f.ledger.summary().cache,{read:20,input:80,ratio:.2});
  assert.equal(f.ledger.totals().costUSD,null);
  const empty=f.ledger.summary({purpose:'none'});assert.equal(empty.totals.calls,0);assert.equal(empty.totals.costUSD,null);assert.equal(empty.cache.ratio,null);
 }finally{f.close();}
});

test('热力图含本周的52个周日自然周，累计峰值和均价遵循不同明确范围',()=>{
 const f=fixture();try{
  const now=at('2026-10-28');
  record(f.ledger,at('2024-01-01'),{priced:5});record(f.ledger,at('2024-01-01'),{priced:5});record(f.ledger,at('2024-01-01'),{priced:5});
  record(f.ledger,at('2026-10-21'),{priced:10}); // 近七日外。
  record(f.ledger,at('2026-10-22'),{priced:2});record(f.ledger,at('2026-10-28'),{priced:4});record(f.ledger,at('2026-10-28'),{});
  record(f.ledger,at('2026-10-28'),{purpose:'semantic-trigger',priced:100});
  const result=f.ledger.activity(52,now);
  assert.equal(result.range.from,'2025-11-02');assert.equal(result.range.to,'2026-11-01');assert.equal(result.range.weekStartsOn,0);
  assert.equal(result.range.end-result.range.start,52*7*86400000);
  assert.equal(result.totals.calls,8);assert.equal(result.daily.reduce((n,r)=>n+r.calls,0),5);assert.equal(result.peakDailyTokens,330);
  assert.equal(result.last7.from,'2026-10-22');assert.equal(result.last7.to,'2026-10-29');assert.equal(result.last7.reply.calls,2);assert.equal(result.last7.reply.totalCalls,3);assert.equal(result.last7.reply.averageCostUSD,3);assert.equal(result.last7.reply.unpriced,1);
  assert.equal(result.last7.cache.ratio,.2);assert.equal(result.totals.costUSD,131);
 }finally{f.close();}
});

test('仅未定价或已知免费费用分开，活动接口只读且拒绝无界周数',async()=>{
 const f=fixture(),app=Fastify();try{
  record(f.ledger,Date.now(),{});assert.equal(f.ledger.activity().last7.reply.averageCostUSD,null);
  record(f.ledger,Date.now(),{priced:0});assert.equal(f.ledger.activity().last7.reply.averageCostUSD,0);assert.equal(f.ledger.totals().unpriced,1);
  registerBillingRoutes(app,{store:f.store});
  const before=f.ledger.totals().calls;
  const response=await app.inject('/api/billing/activity?weeks=52');assert.equal(response.statusCode,200);assert.equal(response.json().totals.calls,before);
  assert.equal(f.ledger.totals().calls,before);assert.equal((await app.inject('/api/billing/activity?weeks=1')).json().range.weeks,1);
  for(const query of ['0','53','999999','1.5','bad','-1'])assert.equal((await app.inject('/api/billing/activity?weeks='+query)).statusCode,400);
 }finally{await app.close();f.close();}
});
