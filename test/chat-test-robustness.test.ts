import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import {PersonaService} from '../src/persona.js';
import {LlmStore} from '../src/llm-store.js';
import {ChatTestService} from '../src/chat-test.js';
import type {Generator} from '../src/model.js';
import type {Channel,Config} from '../src/types.js';
import {exampleConfig} from './config-fixture.js';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'chat-retry-robustness-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=directory;
 const store=new Store(join(directory,'workflow.sqlite')),ledger=new LlmStore(store),config=structuredClone(exampleConfig) as Config;
 const calls:Array<{message:string;interactionId?:string;callId:string}>=[];let failNext=true;
 const generator:Generator={async complete(c,_system,user,_signal,_session,meta={}){
  const marker='【本次消息】\n',message=JSON.parse(user.slice(user.indexOf(marker)+marker.length).split('\n\n【')[0]).message;
  const callId=ledger.start(c.model,meta);calls.push({message,interactionId:meta.interactionId,callId});
  if(failNext){failNext=false;ledger.finish(callId,'failed',{pricingStatus:'unknown'});throw new Error('隔离模型首次失败，原消息需要重试');}
  const cost={input:0.001,output:0.001,cacheRead:0,cacheWrite:0,total:0.002};
  ledger.finish(callId,'completed',{usage:{input:4,output:3,cacheRead:0,cacheWrite:0,totalTokens:7},cost,pricingStatus:'priced'});
  return {text:JSON.stringify({action:'reply',text:'处理的是：'+message,reason:'仅验证目标消息'}),input:4,output:3,cache:0,callId,cost,pricingStatus:'priced'};
 }};
 new MemoryService(store,generator,()=>config);const persona=new PersonaService(store,generator,()=>config),service=new ChatTestService({dataDir:directory,store,generator,persona,config:()=>config});store.set('activeAccount','robust_bot');store.set('control','paused');
 return {service,store,ledger,calls,async close(){await service.close();store.db.close();rmSync(directory,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}};
}

for(const channel of ['public','private'] as Channel[])test(channel+'：失败后新消息入队，重试仍只处理原轮目标而不消费较新的消息',{timeout:10000},async()=>{
 const f=fixture();try{
  const user=f.service.createUser({name:'重试模拟用户'}).user,original='原问题：项目第一轮需要你回应？',newer='新问题：留到下一轮再处理好吗？';
  const failed=(await f.service.addMessage(user.id,{channel,text:original})).turn;assert.equal(failed.status,'failed');assert.equal(f.calls.length,1);
  const held=(await f.service.addMessage(user.id,{channel,text:newer,hold:true})).message;assert.ok(held.id);assert.equal(f.calls.length,1);
  const retry=(await f.service.retry(user.id,failed.id)).turn;assert.equal(retry.status,'completed');assert.equal(retry.messages.length,1,'重试不能把后来加入的私信吸为上文或目标');assert.equal(retry.messages[0].text,original,'重试必须定位原轮消息，不能使用最新排队消息');assert.equal(f.calls[1].message,original);assert.ok(retry.result.draft.text.includes(original));assert.notEqual(retry.id,failed.id);
  const pending=f.service.turns(user.id).queued;assert.deepEqual(pending.map((message:any)=>message.id),[held.id]);assert.equal(pending[0].text,newer);assert.equal(f.service.users().items[0].fees.requests,2,'失败和重试各计一次请求');
  const next=await f.service.process(user.id,{channel});assert.equal(next.status,'completed');assert.equal(next.messages[0].id,held.id);assert.equal(f.calls[2].message,newer);assert.equal(f.service.turns(user.id).queued.length,0);assert.equal(f.store.get('control'),'paused');
 }finally{await f.close();}
});
