import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import {PersonaService} from '../src/persona.js';
import {LlmStore,type CallMetadata} from '../src/llm-store.js';
import {ChatTestService} from '../src/chat-test.js';
import type {Generator} from '../src/model.js';
import type {Config} from '../src/types.js';
import {exampleConfig} from './config-fixture.js';

async function until(check:()=>boolean,label:string){const deadline=Date.now()+2000;while(!check()){if(Date.now()>deadline)throw new Error('有界等待超时：'+label);await new Promise(resolve=>setTimeout(resolve,5));}}

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'chat-cancel-robustness-')),before=process.env.DATA_DIR;process.env.DATA_DIR=root;
 const production=new Store(join(root,'workflow.sqlite')),ledger=new LlmStore(production),config=structuredClone(exampleConfig) as Config;
 production.set('activeAccount','robust_bot');production.set('control','manual');
 let skip=false,holdSummary=false,respectAbort=true;const pending=new Set<()=>void>(),requests:Array<{metadata:CallMetadata;user:string}>=[];
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(c,_system,user,signal,_session,metadata={}){
  const callId=ledger.start(c.model,metadata);requests.push({metadata,user});
  try{
   let output:any;
   if(metadata.source==='chat-test:memory-summary'){
    const incoming=JSON.parse(user).incoming;output={items:[{type:'fact',text:'合成用户的项目下周上线',sourceIds:[incoming[0].id]}]};
    if(holdSummary)await new Promise<void>((resolve,reject)=>{
     const done=()=>{pending.delete(release);signal?.removeEventListener('abort',aborted);};
     const release=()=>{done();resolve();},aborted=()=>{if(respectAbort){done();reject(new Error('合成摘要请求已取消'));}};
     pending.add(release);if(signal?.aborted)aborted();else signal?.addEventListener('abort',aborted,{once:true});
    });
   }else output=skip?{action:'skip',text:'',reason:'合成骚扰跳过',category:'harassment'}:{action:'reply',text:'先按你现在的进度聊，不着急。',reason:'合成回复'};
   const usage={input:8,output:4,cacheRead:0,cacheWrite:0,totalTokens:12},cost={input:0.001,output:0.001,cacheRead:0,cacheWrite:0,total:0.002};
   ledger.finish(callId,'completed',{usage,cost,pricingStatus:'priced'});return {text:JSON.stringify(output),input:8,output:4,cache:0,callId,usage,cost,pricingStatus:'priced'};
  }catch(error){ledger.finish(callId,signal?.aborted?'aborted':'failed',{});throw error;}
 }};
 new MemoryService(production,generator,()=>config);const persona=new PersonaService(production,generator,()=>config),service=new ChatTestService({dataDir:root,store:production,generator,persona,config:()=>config});
 const read=<T>(fn:(db:DatabaseSync)=>T):T=>{const db=new DatabaseSync(join(root,'chat-test','workflow.sqlite'),{readOnly:true});try{return fn(db);}finally{db.close();}};
 return {root,production,ledger,service,requests,read,setSkip(value:boolean){skip=value;},blockSummary(value=true,abort=true){holdSummary=value;respectAbort=abort;},release(){for(const release of [...pending])release();},summaryStarted(){return requests.filter(call=>call.metadata.source==='chat-test:memory-summary').length;},
  async seedFour(id:string){for(let n=0;n<4;n++){const result=await service.addMessage(id,{channel:'private',text:'我的项目下周上线，第'+n+'项进度想与你聊聊？'});assert.equal(result.turn.status,'completed');assert.equal(result.turn.result.receipt.status,'confirmed');}assert.equal(service.memory(id).private.untilNext,1);assert.equal(this.summaryStarted(),0);},
  async close(){for(const release of [...pending])release();await service.close();production.db.close();if(before===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=before;rmSync(root,{recursive:true,force:true});}
 };
}

test('第五条骚扰跳过在自动摘要中取消后不保留strike，重试原消息只累加一次',{timeout:10000},async()=>{
 const f=fixture();try{
  const user=f.service.createUser({name:'骚扰取消会话'}).user;await f.seedFour(user.id);const beforeMemory=f.service.memory(user.id).private;f.setSkip(true);f.blockSummary();
  const work=f.service.addMessage(user.id,{channel:'private',text:'第五条合成骚扰需要跳过？'});await until(()=>f.summaryStarted()===1,'第五条消息进入自动摘要');const running=f.service.turns(user.id).processing;assert.ok(running);
  f.service.cancel(user.id,running);const cancelled=(await work).turn;assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.callIds.length,2,'回复和中止摘要的调用都留证');
  const after=f.service.memory(user.id).private;assert.equal(after.strikes,0,'取消整轮不得留下尚未提交的骚扰计数');assert.equal(after.cooldown,null);assert.equal(after.items.length,0);assert.equal(after.progress.cursor,0);assert.deepEqual(after.recent,beforeMemory.recent,'既有近期往来按现有召回上限保持');assert.equal(f.service.turns(user.id).queued.length,1);
  f.blockSummary(false);const retried=(await f.service.retry(user.id,cancelled.id)).turn;assert.equal(retried.status,'completed');assert.equal(retried.result.draft.action,'skip');const final=f.service.memory(user.id).private;assert.equal(final.strikes,1,'同一条消息取消后重试只算一次骚扰');assert.equal(final.cooldown,null);assert.equal(final.items.length,1);assert.equal(f.service.users().items[0].fees.requests,8);
 }finally{await f.close();}
});

test('第五条回复在自动摘要中取消后清除已发出派生状态，原有四轮记忆和费用仍可追溯',{timeout:10000},async()=>{
 const f=fixture();try{
  const user=f.service.createUser({name:'回复取消会话'}).user;await f.seedFour(user.id);const beforeMemory=f.service.memory(user.id).private;f.blockSummary();const work=f.service.addMessage(user.id,{channel:'private',text:'第五条新的项目进度？'});
  await until(()=>f.summaryStarted()===1,'第五条回复进入自动摘要');const id=f.service.turns(user.id).processing;assert.ok(id);f.service.cancel(user.id,id);const cancelled=(await work).turn;assert.equal(cancelled.status,'cancelled');
  const memory=f.service.memory(user.id).private;assert.deepEqual(memory.recent,beforeMemory.recent,'取消不得改变现有召回窗口');assert.ok(!memory.recent.some((row:any)=>row.message==='第五条新的项目进度？'));assert.equal(memory.items.length,0);assert.equal(memory.progress.cursor,0);assert.equal(memory.strikes,0);
  const queued=f.service.turns(user.id).queued;assert.equal(queued.length,1);assert.equal(queued[0].status,'queued');
  const rows=f.read(db=>db.prepare('SELECT status,receipt FROM messages WHERE id=?').get(queued[0].messageId) as any);assert.equal(rows.status,'queued');assert.equal(rows.receipt,null);assert.equal(f.read(db=>(db.prepare("SELECT count(*) n FROM role_experiences WHERE user_id=? AND kind='interaction'").get(memory.userId) as any).n),4);
  assert.equal(cancelled.callIds.length,2);assert.equal(f.service.users().items[0].fees.requests,6);assert.equal(f.service.users().items[0].fees.unknown,1);assert.equal(f.production.get('control'),'manual');
 }finally{await f.close();}
});

test('重置摘要中的会话后即使旧供应商迟到返回有效记忆也不能写回',{timeout:10000},async()=>{
 const f=fixture();try{
  const user=f.service.createUser({name:'重置摘要会话'}).user;await f.seedFour(user.id);f.blockSummary(true,false);const work=f.service.addMessage(user.id,{channel:'private',text:'第五条等待迟到摘要的项目进度？'});
  await until(()=>f.summaryStarted()===1,'摘要供应商请求已开始');f.service.reset(user.id);f.release();const outcome=(await work).turn;assert.equal(outcome.status,'cancelled');
  const memory=f.service.memory(user.id).private;assert.equal(memory.items.length,0);assert.equal(memory.recent.length,0);assert.equal(memory.progress.cursor,0);assert.equal(memory.strikes,0);assert.equal(memory.cooldown,null);assert.equal(f.service.turns(user.id).items.length,0);assert.equal(f.service.turns(user.id).queued.length,0);
  const summary=f.ledger.calls({purpose:'chat-test',limit:100}).items.filter(row=>row.source==='chat-test:memory-summary');assert.equal(summary.length,1);assert.equal(summary[0].status,'completed','迟到供应商的已花费用仍保留');assert.equal(f.read(db=>(db.prepare('SELECT count(*) n FROM memory_items').get() as any).n),0);
 }finally{await f.close();}
});
