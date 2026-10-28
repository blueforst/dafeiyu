import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import type {Generator} from '../src/model.js';
import type {CallMetadata} from '../src/llm-store.js';
import type {Event,Config} from '../src/types.js';
import {exampleConfig} from './config-fixture.js';

test('记忆整理可只覆盖统一流水用途与账号，记忆仍留在原scope；生产默认用途不变',{timeout:10000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-purpose-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=root;
 const store=new Store(join(root,'workflow.sqlite')),calls:CallMetadata[]=[];
 const generator:Generator={async complete(_c,_s,user,_a,_session,meta){
  calls.push(meta??{});const input=JSON.parse(user),sourceId=input.incoming[0].id;
  return {text:JSON.stringify({items:[{type:'fact',text:'测试用户下周上线项目',sourceIds:[sourceId]}]}),input:1,output:1,cache:0};
 }};
 try{
  const memory=new MemoryService(store,generator,()=>structuredClone(exampleConfig) as Config);
  const event:Event={id:'x:70001',platformId:'70001',channel:'public',userId:'x:test_user',handle:'test_user',text:'我的项目下周上线',url:'https://x.com/test_user/status/70001',conversationId:'70001',timestamp:Date.now(),timestampReliable:true,accountId:'chat_test'};
  store.ingest(event,'chat_test');store.update(event.id,'confirmed',{draft:{action:'reply',text:'记下了',reason:''}});
  await memory.summarize(event.userId,'public','chat_test',{force:true,purpose:'chat-test',source:'chat-test:memory-summary',accountId:'real_bot',interactionId:'manual-summary-fixture'});
  assert.equal(calls[0].purpose,'chat-test');assert.equal(calls[0].source,'chat-test:memory-summary');assert.equal(calls[0].accountId,'real_bot');assert.equal(calls[0].interactionId,'manual-summary-fixture');assert.equal(calls[0].jsonObject,true);
  assert.equal(memory.items(event.userId,'public','chat_test').length,1);assert.equal(memory.items(event.userId,'public','real_bot').length,0);
  await memory.summarize(event.userId,'public','chat_test',{force:true});
  assert.equal(calls[1].purpose,'memory-summary');assert.equal(calls[1].source,'memory-manual');assert.equal(calls[1].accountId,'chat_test');
 }finally{store.db.close();rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}
});
