import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Outbox} from '../src/outbox.js';
import {MemoryService} from '../src/memory.js';
import {RuntimeHealth} from '../src/unattended-health.js';
import {productionTaskHandlers} from '../src/production-tasks.js';
import type {TaskContext,TaskRun} from '../src/scheduler.js';

function fixture(){
 const root=mkdtempSync(tmpdir()+'/role-post-recovery-'),store=new Store(root+'/workflow.sqlite'),outbox=new Outbox(store),health=new RuntimeHealth(store);
 let cools=0,lookups=0,models=0,receipt:any={status:'unknown'};
 const generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async()=>{models++;throw new Error('回查禁止重新生成');}},memory=new MemoryService(store,generator as any);
 const workflow:any={store,generator,services:{outbox,memory,health,persona:{get:()=>({persona:{}})},daily:{}},transport:{identity:async()=>({handle:'worker',loggedIn:true,needsHuman:false}),lookupPost:async()=>{lookups++;return receipt;},post:async()=>{throw Error('回查禁止重新发送');}},taskOperation:async(_source:any,fn:any)=>fn(new AbortController().signal),config:()=>({mode:'auto'}),control:()=> 'running',accountId:()=> 'worker',rejectChannel:()=>{cools++;},safetyPause:async()=>{throw Error('身份应保持不变');}};
 const handlers=productionTaskHandlers(workflow),row=outbox.prepare({accountId:'worker',kind:'post',sourceId:'run-one',text:'冻结的早安正文'});outbox.begin(row.id);outbox.settle(row.id,{status:'unknown'});
 const run={id:'run-one',taskId:'morning-post',accountId:'worker',outboxId:row.id} as TaskRun;
 const ctx={runId:'run-one',taskId:'morning-post',accountId:'worker',scheduledAt:Date.now(),source:'manual',signal:new AbortController().signal,ensureEnabled:()=>true} as TaskContext;
 return {store,outbox,handlers,row,run,ctx,setReceipt:(r:any)=>{receipt=r;},get counts(){return {cools,lookups,models};},close(){store.db.close();rmSync(root,{recursive:true,force:true});}};
}

test('问候回查confirmed补写角色经历且幂等，不重新生成或发送',async()=>{
 const f=fixture();try{f.setReceipt({status:'confirmed',id:'123',url:'https://x.com/worker/status/123'});const result=await f.handlers.lookup(f.run);assert.equal(result.status,'completed');await f.handlers.lookup(f.run);const rows=f.store.db.prepare("SELECT * FROM role_experiences WHERE account_id='worker'").all();assert.equal(rows.length,1);assert.equal(f.counts.models,0);assert.equal(f.counts.lookups,1);assert.equal(f.counts.cools,0);}finally{f.close();}
});

test('问候execute已有unknown仅回查，confirmed恢复经历',async()=>{
 const f=fixture();try{f.setReceipt({status:'confirmed',id:'124'});const result=await f.handlers.execute('morning-post',f.ctx);assert.equal(result.status,'completed');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM role_experiences').get()?.n,1);assert.equal(f.counts.models,0);assert.equal(f.counts.lookups,1);}finally{f.close();}
});

test('已由主循环settle的rejected仍恢复一次冷却/自动化计数，not_submitted不冷却',async()=>{
 const f=fixture();try{f.outbox.settle(f.row.id,{status:'rejected',reason:'平台自动化拦截',rejectionKind:'automation'});assert.equal((await f.handlers.lookup(f.run)).status,'skipped');assert.equal((await f.handlers.lookup(f.run)).status,'skipped');assert.equal(f.counts.cools,1);assert.equal(f.counts.lookups,0);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM logs WHERE event='automation-block'").get()?.n,1);}finally{f.close();}
 const other=fixture();try{other.outbox.settle(other.row.id,{status:'not_submitted',reason:'权限已失效'});assert.equal((await other.handlers.lookup(other.run)).status,'skipped');assert.equal(other.counts.cools,0);assert.equal(other.counts.lookups,0);assert.equal(other.counts.models,0);}finally{other.close();}
});
