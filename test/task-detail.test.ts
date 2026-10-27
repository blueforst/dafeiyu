import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Outbox} from '../src/outbox.js';
import {LlmStore} from '../src/llm-store.js';
import {TaskScheduler} from '../src/scheduler.js';
import {registerTaskRoutes} from '../src/task-routes.js';

test('任务详情关联原调用缓存与字数校验，不复制出站正文',async()=>{
 const root=mkdtempSync(tmpdir()+'/task-detail-'),store=new Store(root+'/workflow.sqlite'),app=Fastify();
 try{
  const outbox=new Outbox(store),scheduler=new TaskScheduler(store,{account:()=> 'worker',control:()=> 'paused',execute:async()=>{}}),ledger=new LlmStore(store);
  const row=outbox.prepare({accountId:'worker',kind:'post',sourceId:'detail-run',text:'详情测试正文'});
  const id=ledger.start({provider:'custom',id:'detail-model'},{purpose:'morning-post',source:'task',accountId:'worker',interactionId:'detail-run'});
  ledger.finish(id,'completed',{usage:{input:10,output:3,cacheRead:7,cacheWrite:0,totalTokens:20},pricingStatus:'unpriced'});
  scheduler.recordMainStart('detail-run','worker',Date.now());
  store.db.prepare("UPDATE task_runs SET outbox_id=?,call_ids=?,status='completed' WHERE id=?").run(row.id,JSON.stringify([id]),'detail-run');
  registerTaskRoutes(app,{scheduler});
  const response=await app.inject('/api/tasks/runs/detail-run');assert.equal(response.statusCode,200,response.body);
  const data=response.json();assert.equal(data.calls[0].id,id);assert.equal(data.calls[0].usage.cacheRead,7);assert.equal(data.run.validation.allowed,true);assert.equal(data.run.validation.limit,280);assert.equal(data.outbox[0].id,row.id);
  assert.ok(!response.body.includes('详情测试正文'));
 }finally{await app.close();store.db.close();rmSync(root,{recursive:true,force:true});}
});
