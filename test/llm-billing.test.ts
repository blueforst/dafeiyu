import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { ModelService,type CompletionResult } from '../src/model.js';
import { LlmStore,billingRange,billingTotals } from '../src/llm-store.js';
import { registerBillingRoutes } from '../src/billing-routes.js';
import { resolveRuntimeModel } from '../src/model-catalog.js';
import type { Config } from '../src/types.js';

const model:Config['model']={provider:'custom',api:'openai-completions',baseUrl:'https://relay.example/v1',id:'my-model',reasoning:false,reasoningLevel:'off',vision:false,source:'panel'};
const full=(over:Partial<CompletionResult>={}):CompletionResult=>({text:'不保存的内容',input:100,output:100,cache:20,stopReason:'stop',latencyMs:12,usage:{input:100,output:100,cacheRead:20,cacheWrite:10,totalTokens:230,reasoning:60},cost:{input:.001,output:.002,cacheRead:.0001,cacheWrite:.0002,total:.0033},pricingStatus:'priced',...over});
function fixture(){const dir=mkdtempSync(tmpdir()+'/role-billing-');const store=new Store(dir+'/workflow.sqlite');return {store,dir,ledger:new LlmStore(store),close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}

test('实际请求独立计量，完整缓存和思考子集不会重复计算',async()=>{
 const f=fixture();try{
  const service=new ModelService(f.store,async()=>full());
  for(let i=0;i<2;i++)await service.request(model,'sk-never-store-key','不保存system','不保存user',{}, {purpose:'persona-preview',source:'test',interactionId:'same-interaction'});
  const result=f.ledger.summary({interactionId:'same-interaction'}).totals;
  assert.equal(result.calls,2);assert.equal(result.output,200);assert.equal(result.reasoning,120);assert.equal(result.totalTokens,460);assert.equal(result.cacheWrite,20);assert.equal(result.costUSD,.0066);
  const rows=f.store.db.prepare('SELECT * FROM llm_calls').all();const raw=JSON.stringify(rows);
  assert.ok(!raw.includes('不保存'));assert.ok(!raw.includes('sk-never-store-key'));assert.notEqual((rows[0] as any).id,(rows[1] as any).id);
 }finally{f.close();}
});

test('失败、中止和异常均结束同一流水并保留实际部分用量',async()=>{
 const f=fixture();try{
  const service=new ModelService(f.store,async()=>full({stopReason:'aborted',cost:null,pricingStatus:'unpriced',usage:{input:12,output:2,cacheRead:0,cacheWrite:0,totalTokens:14}}));
  const r=await service.request(model,'key','sys','user');
  const row=f.ledger.get(r.callId!);assert.equal(row!.status,'aborted');assert.equal(row!.usage!.input,12);assert.equal(row!.cost,null);
  const thrown=new ModelService(f.store,async()=>{throw new Error('无法连接');});
  await assert.rejects(thrown.request(model,'key','sys','user'),/无法连接/);
  const errors=f.ledger.calls().items.filter(r=>r.status==='failed');assert.equal(errors.length,1);assert.equal(errors[0].usage,null);assert.equal(errors[0].pricingStatus,'unknown');
  const placeholder=new ModelService(f.store,async()=>full({input:0,output:0,cache:0,stopReason:'error',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},cost:null,pricingStatus:'unknown'}));
  const zero=await placeholder.request(model,'key','sys','user');assert.equal(zero.usage,null);assert.equal(f.ledger.get(zero.callId!)!.pricingStatus,'unknown');
 }finally{f.close();}
});

test('输出解析失败前已完成计量，历史成本不会受后续对象修改影响',async()=>{
 const f=fixture();try{
  const response=full({text:'不是合法JSON'});const service=new ModelService(f.store,async()=>response);
  const r=await service.request(model,'key','sys','user');assert.throws(()=>JSON.parse(r.text));
  response.cost!.total=100;
  const row=f.ledger.get(r.callId!);assert.equal(row!.status,'completed');assert.equal(row!.cost!.total,.0033);
 }finally{f.close();}
});

test('进程恢复将未完成调用标记中断，不冒充零费用或完成',()=>{
 const f=fixture();try{
  const id=f.ledger.start(model,{purpose:'reply'},100);
  assert.equal(f.ledger.recoverInterrupted(250),1);assert.equal(f.ledger.recoverInterrupted(300),0);
  const r=f.ledger.get(id);assert.equal(r!.status,'interrupted');assert.equal(r!.usage,null);assert.equal(r!.cost,null);assert.equal(r!.latencyMs,150);
 }finally{f.close();}
});

test('未知型号、第三方地址、CommandCode及自定义同名模型不借用目录价格',async()=>{
 for(const input of [
  {...model,provider:'deepseek',id:'never-in-catalog',baseUrl:'https://api.deepseek.com'},
  {...model,provider:'deepseek',id:'deepseek-flash',baseUrl:'https://relay.example/v1'},
  {...model,provider:'commandcode',id:'claude-sonnet-4-6',baseUrl:'https://api.commandcode.ai/provider'},
  {...model,id:'deepseek-flash'},
 ]){
  const resolved=await resolveRuntimeModel(input);assert.equal(resolved.pricingKnown,false);assert.equal(resolved.model.cost.input,0);assert.equal(resolved.model.cost.output,0);
 }
 const known=await resolveRuntimeModel({...model,provider:'deepseek',id:'deepseek-flash',baseUrl:'https://api.deepseek.com'});assert.equal(known.pricingKnown,true);
});

test('旧usage和新流水汇总各计一次，筛选不伪造旧模型与用途，分页不漏项',async()=>{
 const f=fixture();try{
  f.store.usage(7,3,2);
  const service=new ModelService(f.store,async()=>full({cost:null,pricingStatus:'unpriced'}));
  await service.request(model,'key','sys','user',{}, {purpose:'reply'});
  await service.request(model,'key','sys','user',{}, {purpose:'model-test'});
  const totals=billingTotals(f.store.db);assert.equal(totals.calls,3);assert.equal(totals.legacyRows,1);assert.equal(totals.input,207);assert.equal(totals.costUSD,null);assert.equal(totals.unpriced,2);
  const filtered=f.ledger.summary({purpose:'reply'}).totals;assert.equal(filtered.calls,1);assert.equal(filtered.legacyRows,0);
  const historical=f.ledger.summary({purpose:'legacy-unknown'}).totals;assert.equal(historical.calls,1);assert.equal(historical.legacyRows,1);assert.equal(f.ledger.calls({purpose:'legacy-unknown'}).items[0].id.startsWith('legacy-'),true);
  const a=f.ledger.calls({limit:1});const b=f.ledger.calls({limit:1,cursor:a.nextCursor!});const c=f.ledger.calls({limit:1,cursor:b.nextCursor!});
  assert.equal(new Set([...a.items,...b.items,...c.items].map(r=>r.id)).size,3);assert.equal(c.nextCursor,null);
 }finally{f.close();}
});

test('北京时间半开范围在汇总、趋势与分页流水一致',async()=>{
 const f=fixture();const app=Fastify();try{
  const range=billingRange('2026-10-28','2026-10-29');assert.equal(range.start,Date.parse('2026-10-27T16:00:00Z'));
  for(const at of [range.start-1,range.start,range.end-1,range.end]){const id=f.ledger.start(model,{purpose:'reply'},at);f.ledger.finish(id,'completed',{usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2},pricingStatus:'unpriced'},at+1);}
  registerBillingRoutes(app,{store:f.store});
  const summary=await app.inject('/api/billing/summary?from=2026-10-28&to=2026-10-29');const calls=await app.inject('/api/billing/calls?from=2026-10-28&to=2026-10-29');
  assert.equal(summary.statusCode,200);assert.equal(summary.json().totals.calls,2);assert.equal(summary.json().daily.length,1);assert.equal(summary.json().daily[0].date,'2026-10-28');assert.equal(calls.json().items.length,2);
  assert.equal((await app.inject('/api/billing/calls?limit=101')).statusCode,400);assert.equal((await app.inject('/api/billing/calls?cursor=bad')).statusCode,400);assert.equal((await app.inject('/api/billing/summary?from=2026-02-30')).statusCode,400);
 }finally{await app.close();f.close();}
});
