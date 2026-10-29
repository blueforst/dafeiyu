import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { MemoryService } from '../src/memory.js';
import { PersonaService,legacyPersona } from '../src/persona.js';
import { LlmStore,type PricingStatus } from '../src/llm-store.js';
import { Outbox } from '../src/outbox.js';
import { ReplyTriage } from '../src/reply-triage.js';
import { ChatTestService } from '../src/chat-test.js';
import type { Config } from '../src/types.js';
import type { Generator } from '../src/model.js';
import { exampleConfig } from './config-fixture.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'chat-recovery-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=root;
 const store=new Store(join(root,'workflow.sqlite')),ledger=new LlmStore(store),config=structuredClone(exampleConfig) as Config;
 let at=Date.parse('2026-10-28T12:00:00+08:00'),requests=0;
 const charge=(interactionId:string,purpose='chat-test',pricingStatus:PricingStatus='priced',cost=.002)=>{const id=ledger.start(config.model,{purpose,source:'chat-test:reply',accountId:'real_bot',channel:'public',interactionId},++at);ledger.finish(id,'completed',{usage:{input:5,output:3,cacheRead:0,cacheWrite:0,totalTokens:8},pricingStatus,cost:pricingStatus==='priced'?{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost}:null},at+1);return id;};
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(c,_system,_user,_signal,_session,meta={}){requests++;const callId=charge(meta.interactionId!,String(meta.purpose));return {text:JSON.stringify({action:'reply',text:'继续聊你的项目吧。',reason:'回应'}),input:5,output:3,cache:0,callId,pricingStatus:'priced',cost:{input:.002,output:0,cacheRead:0,cacheWrite:0,total:.002}};}};
 new MemoryService(store,generator,()=>config,()=>at);new Outbox(store);new ReplyTriage(store);const persona=new PersonaService(store,generator,()=>config);persona.save(legacyPersona('明确自己是AI，简短回应当前话题。'),0);store.set('activeAccount','real_bot');store.set('control','manual');
 const deps={dataDir:root,store,generator,persona,config:()=>config,now:()=>at};let service=new ChatTestService(deps);
 const snapshot=()=>JSON.stringify(Object.fromEntries((store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'llm_calls' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,store.db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()])));
 return {root,store,ledger,charge,get service(){return service;},get requests(){return requests;},snapshot,async restart(mutate?:(db:DatabaseSync)=>void){await service.close();const db=new DatabaseSync(join(root,'chat-test/workflow.sqlite'));try{mutate?.(db);}finally{db.close();}service=new ChatTestService(deps);return service;},async close(){await service.close();store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(root,{recursive:true,force:true});}};
}
const fees=(service:ChatTestService,id:string)=>service.users().items.find(user=>user.id===id)!.fees;

test('已落供应商流水但轮次调用ID尚未保存，重启后的累计费用仍完整',{timeout:10000},async()=>{
 const f=fixture();try{
  const before=f.snapshot(),user=f.service.createUser({name:'恢复会话'}).user,{turn}=await f.service.addMessage(user.id,{channel:'public',text:'我的项目在继续，今天来聊一下进展。'});
  assert.equal(f.requests,1);assert.equal(fees(f.service,user.id).requests,1);const calls=f.ledger.calls({purpose:'chat-test',interactionId:turn.id}).items;assert.equal(calls.length,1);
  // 重放断电边界的持久快照：供应商流水已提交，而本地轮次仍 running、尚未回填调用ID。
  await f.restart(db=>{db.prepare("UPDATE chat_test_turns SET status='running',call_ids_json='[]',diagnostics_json='{}',finished_at=NULL WHERE id=?").run(turn.id);});
  const recovered=fees(f.service,user.id);assert.equal(recovered.requests,1);assert.ok(Math.abs(recovered.estimatedUsd!-.002)<1e-12);assert.equal(recovered.unknown,0);assert.equal(f.service.turns(user.id).items[0].status,'failed');assert.equal(f.requests,1,'恢复不应重调模型');assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.ledger.calls({purpose:'chat-test',interactionId:turn.id}).items,calls);
 }finally{await f.close();}
});

test('恢复超过一页的未回填调用时，不因流水100条分页截断漏计',{timeout:15000},async()=>{
 const f=fixture();try{
  const user=f.service.createUser({name:'多页恢复'}).user,{turn}=await f.service.addMessage(user.id,{channel:'public',text:'这段项目进度请记下来。'});f.store.db.exec('BEGIN IMMEDIATE');try{for(let i=0;i<1000;i++)f.charge(turn.id);f.store.db.exec('COMMIT');}catch(error){f.store.db.exec('ROLLBACK');throw error;}
  f.charge(turn.id,'reply', 'priced',100); // 同 interaction 的其他用途不属于试聊费用。
  await f.restart(db=>{db.prepare("UPDATE chat_test_turns SET status='running',call_ids_json='[]',diagnostics_json='{}',finished_at=NULL WHERE id=?").run(turn.id);});
  const recovered=fees(f.service,user.id),all=f.ledger.totals({purpose:'chat-test',interactionId:turn.id});assert.equal(all.calls,1001);assert.equal(recovered.requests,all.calls);assert.ok(Math.abs(recovered.estimatedUsd!-all.costUSD!)<1e-9);assert.equal(f.requests,1);
 }finally{await f.close();}
});

test('已保存调用ID跨1000分块去重统计，未定价和未知分别保留',{timeout:15000},async()=>{
 const f=fixture();try{
  const user=f.service.createUser({name:'大调用历史'}).user,{turn}=await f.service.addMessage(user.id,{channel:'public',text:'这条作为已完成的历史样本。'}),ids=[...turn.callIds] as string[];
  f.store.db.exec('BEGIN IMMEDIATE');try{for(let i=0;i<1004;i++)ids.push(f.charge(turn.id));ids.push(f.charge(turn.id,'chat-test','unpriced'));ids.push(f.charge(turn.id,'chat-test','unknown'));f.store.db.exec('COMMIT');}catch(error){f.store.db.exec('ROLLBACK');throw error;}
  await f.restart(db=>{db.prepare('UPDATE chat_test_turns SET call_ids_json=? WHERE id=?').run(JSON.stringify([...ids,...ids.slice(0,3)]),turn.id);});
  const actual=fees(f.service,user.id),all=f.ledger.totals({purpose:'chat-test',interactionId:turn.id});assert.equal(actual.requests,1007);assert.equal(actual.requests,all.calls);assert.equal(actual.unpriced,1);assert.equal(actual.unknown,1);assert.ok(Math.abs(actual.estimatedUsd!-all.costUSD!)<1e-9);
 }finally{await f.close();}
});

test('有缺失调用ID时明确计未知，不把未知当免费或吞掉已知费用',{timeout:10000},async()=>{
 const f=fixture();try{
  const user=f.service.createUser({name:'缺失引用'}).user,{turn}=await f.service.addMessage(user.id,{channel:'public',text:'请保留这轮的实际费用。'});
  await f.restart(db=>{db.prepare('UPDATE chat_test_turns SET call_ids_json=? WHERE id=?').run(JSON.stringify([...turn.callIds,'missing-call-id','missing-call-id']),turn.id);});
  const actual=fees(f.service,user.id);assert.equal(actual.requests,1);assert.equal(actual.unknown,1);assert.ok(Math.abs(actual.estimatedUsd!-.002)<1e-12);assert.equal(f.store.get('control'),'manual');
 }finally{await f.close();}
});
