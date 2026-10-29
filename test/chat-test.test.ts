import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { PersonaService } from '../src/persona.js';
import { MemoryService } from '../src/memory.js';
import { LlmStore } from '../src/llm-store.js';
import { ChatTestService } from '../src/chat-test.js';
import { registerChatTestRoutes } from '../src/chat-test-routes.js';
import type { Generator } from '../src/model.js';
import type { Config } from '../src/types.js';
import { exampleConfig } from './config-fixture.js';

async function until(check:()=>boolean,label:string){const deadline=Date.now()+2000;while(!check()){if(Date.now()>deadline)throw new Error('等待超时：'+label);await new Promise(resolve=>setTimeout(resolve,5));}}
function fixture(){
 const data=mkdtempSync(join(tmpdir(),'chat-test-service-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=data;
 const store=new Store(join(data,'workflow.sqlite')),ledger=new LlmStore(store),config=structuredClone(exampleConfig) as Config;
 store.set('activeAccount','work');store.set('control','manual');
 let at=Date.now(),produce:(system:string,user:string,signal?:AbortSignal)=>any=()=>({action:'reply',text:'记住了，继续聊。',reason:''});
 const requests:any[]=[];
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(c,system,user,signal,sessionId,metadata){
  const id=ledger.start(c.model,metadata),request={system,user,signal,sessionId,metadata};requests.push(request);
  let cancel:(()=>void)|undefined;
  try{const pending=Promise.resolve(produce(system,user,signal)),output=signal?await Promise.race([pending,new Promise((_resolve,reject)=>{cancel=()=>reject(new Error('模型请求已取消'));if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});})]):await pending;ledger.finish(id,'completed',{usage:{input:10,output:4,cacheRead:0,cacheWrite:0,totalTokens:14},cost:{input:0.001,output:0.001,cacheRead:0,cacheWrite:0,total:0.002},pricingStatus:'priced'});return {text:JSON.stringify(output),input:10,output:4,cache:0,callId:id,pricingStatus:'priced',cost:{input:0.001,output:0.001,cacheRead:0,cacheWrite:0,total:0.002}};}
  catch(error){ledger.finish(id,signal?.aborted?'aborted':'failed',{});throw error;}
  finally{if(cancel)signal?.removeEventListener('abort',cancel);}
 }};
 new MemoryService(store,generator,()=>config);const persona=new PersonaService(store,generator,()=>config),service=new ChatTestService({dataDir:data,store,generator,persona,config:()=>config,now:()=>at});
 const user=(name='测试用户',handle?:string)=>service.createUser({name,...(handle?{handle}:{})}).user;
 return {data,store,ledger,service,requests,user,config,setNow:(n:number)=>at=n,setProduce:(fn:typeof produce)=>produce=fn,async close(){await service.close();store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(data,{recursive:true,force:true});}};
}

test('试聊用户只在首次使用时建独立目录，支持修改名称和handle，五十人上限',{timeout:10000},async()=>{
 const f=fixture();try{
  assert.equal(existsSync(join(f.data,'chat-test')),false);assert.equal(f.service.status().accountConfirmed,true);assert.equal(existsSync(join(f.data,'chat-test')),false);
  const user=f.user('小林','lin');assert.ok(existsSync(join(f.data,'chat-test','workflow.sqlite')));assert.equal(f.service.users().items.length,1);
  await f.service.addMessage(user.id,{channel:'public',text:'项目下周上线。'});
  f.service.updateUser(user.id,{name:'小林改名',handle:'new_lin'});
  await f.service.addMessage(user.id,{channel:'public',text:'你还记得我的项目吗？'});
  const memory=f.service.memory(user.id);assert.ok(memory.public.recent.some((row:any)=>row.message==='项目下周上线。'));assert.equal(f.service.users().items[0].handle,'new_lin');
  assert.throws(()=>f.service.createUser({name:'重复',handle:'new_lin'}),{statusCode:409});
  const reused=f.user('复用旧handle','lin');assert.equal(f.service.memory(reused.id).public.recent.length,0);assert.notEqual(f.service.memory(reused.id).public.userId,memory.public.userId);
  for(let n=2;n<50;n++)f.user('用户'+n);assert.throws(()=>f.user('第51人'),{statusCode:409});
  assert.throws(()=>f.service.updateUser(user.id,{handle:'INVALID'}),{statusCode:400});
 }finally{await f.close();}
});

test('私信先攒两条只处理末条，公开各自线程分别处理，同一用户保留近期往来',{timeout:10000},async()=>{
 const f=fixture();try{
  const user=f.user();await f.service.addMessage(user.id,{channel:'private',text:'第一句在吗',hold:true});await f.service.addMessage(user.id,{channel:'private',text:'第二句今天很忙？',hold:true});
  const held=f.service.turns(user.id);assert.equal(held.queued.length,2);assert.equal(f.requests.length,0);
  const privateTurn=await f.service.process(user.id);assert.equal(privateTurn.status,'completed');assert.equal(privateTurn.messages.length,2);assert.equal(privateTurn.messages[0].status,'context');assert.equal(privateTurn.messages[1].status,'confirmed');
  assert.ok(f.requests[0].user.includes('第一句在吗'));assert.ok(f.requests[0].user.includes('第二句今天很忙？'));assert.equal(f.requests.length,1);
  await f.service.addMessage(user.id,{channel:'public',text:'这是公开第一条？',hold:true});await f.service.addMessage(user.id,{channel:'public',text:'这是公开第二条？',hold:true});
  const a=await f.service.process(user.id),b=await f.service.process(user.id);assert.equal(a.messages.length,1);assert.equal(b.messages.length,1);assert.equal(a.diagnostics.mergedCount,0);assert.equal(b.diagnostics.mergedCount,0);assert.notEqual(a.messages[0].event.conversationId,b.messages[0].event.conversationId);
  assert.equal(f.service.turns(user.id).queued.length,0);assert.equal(f.requests.length,3);assert.ok(!JSON.stringify(f.service.memory(user.id).public.recent).includes('第一句在吗'));
 }finally{await f.close();}
});

test('三个骚扰跳过触发单渠道冷却，清除冷却后恢复，不跨用户污染',{timeout:10000},async()=>{
 const f=fixture();try{
  f.setProduce(()=>({action:'skip',text:'',reason:'重复骚扰',category:'harassment'}));const user=f.user();
  for(let n=0;n<3;n++)await f.service.addMessage(user.id,{channel:'private',text:'这是骚扰消息'+n});
  assert.equal(f.requests.length,3);assert.ok(f.service.memory(user.id).private.cooldown);assert.equal(f.service.memory(user.id).public.cooldown,null);
  const ignored=await f.service.addMessage(user.id,{channel:'private',text:'冷却里的新消息'});assert.equal(ignored.turn.result.status,'ignored');assert.equal(f.requests.length,3);
  f.service.clearCooldown(user.id);await f.service.addMessage(user.id,{channel:'private',text:'解除后重新提问？'});assert.equal(f.requests.length,4);
  const second=f.user('另一个用户');assert.equal(f.service.memory(second.id).private.cooldown,null);
 }finally{await f.close();}
});

test('单用户一轮、全局两轮，取消保留失败费用并可重试',{timeout:10000},async()=>{
 const f=fixture();try{
  let started=0;f.setProduce((_s,_u,signal)=>new Promise((_resolve,reject)=>{started++;signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});}));
  const a=f.user('A'),b=f.user('B'),c=f.user('C'),runA=f.service.addMessage(a.id,{channel:'public',text:'A的问题？'}),runB=f.service.addMessage(b.id,{channel:'private',text:'B的问题？'});
  await until(()=>started>=2,'两轮模型请求开始；'+JSON.stringify(f.service.users()));
  await assert.rejects(f.service.addMessage(a.id,{channel:'public',text:'并发再问？'}),{statusCode:429});
  await assert.rejects(f.service.addMessage(c.id,{channel:'public',text:'第三个用户？'}),{statusCode:429});assert.equal(f.service.turns(c.id).queued.length,0);
  const turnA=f.service.turns(a.id).processing!,turnB=f.service.turns(b.id).processing!;f.service.cancel(a.id,turnA);f.service.cancel(b.id,turnB);
  assert.equal((await runA).turn.status,'cancelled');assert.equal((await runB).turn.status,'cancelled');assert.equal(f.service.status().concurrency.active,0);
  assert.equal(f.service.turns(a.id).queued.length,1);assert.equal(f.service.users().items.find((row:any)=>row.id===a.id)!.fees.unknown,1);
  f.setProduce(()=>({action:'reply',text:'重新回复。',reason:''}));const retried=await f.service.retry(a.id,turnA);assert.equal(retried.turn.status,'completed');assert.notEqual(retried.turn.id,turnA);assert.equal(f.service.users().items.find((row:any)=>row.id===a.id)!.fees.requests,2);
 }finally{await f.close();}
});

test('模型失败后消息回队，重置和删除阻止在途旧回复写回',{timeout:10000},async()=>{
 const f=fixture();try{
  const user=f.user();f.setProduce(()=>{throw new Error('供应商故障');});const failed=await f.service.addMessage(user.id,{channel:'public',text:'失败的问题？'});assert.equal(failed.turn.status,'failed');assert.equal(f.service.turns(user.id).queued.length,1);
  let finish!:(value:any)=>void;f.setProduce(()=>new Promise(resolve=>finish=resolve));const work=f.service.retry(user.id,failed.turn.id);await until(()=>!!finish,'重试模型请求开始');
  f.service.reset(user.id);finish({action:'reply',text:'旧请求不应恢复。',reason:''});assert.equal((await work).turn.status,'cancelled');assert.equal(f.service.turns(user.id).items.length,0);assert.equal(f.service.memory(user.id).public.recent.length,0);
  f.setProduce(()=>({action:'reply',text:'新的对话。',reason:''}));await f.service.addMessage(user.id,{channel:'private',text:'重置后的新问题？'});assert.equal(f.service.memory(user.id).private.recent.length,1);
  f.service.reset(user.id,true);assert.equal(f.service.users().items.length,0);assert.throws(()=>f.service.memory(user.id),{statusCode:404});
 }finally{await f.close();}
});

test('轮次分页稳定、路由返回控制参数错误与用户CRUD',{timeout:10000},async()=>{
 const f=fixture(),app=Fastify();registerChatTestRoutes(app,{service:f.service});try{
  const created=await app.inject({method:'POST',url:'/api/chat-test/users',payload:{name:'路由用户'}});assert.equal(created.statusCode,200);const id=created.json().user.id;
  for(let n=0;n<3;n++)await f.service.addMessage(id,{channel:'public',text:'问题'+n+'？'});
  const first=f.service.turns(id,{limit:2}),second=f.service.turns(id,{limit:2,before:first.nextCursor});assert.equal(first.items.length,2);assert.equal(second.items.length,1);assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,3);
  assert.equal((await app.inject('/api/chat-test/users/'+id+'/turns?before=bad')).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/chat-test/users/'+id+'/messages',payload:{channel:'bad',text:'问题'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/chat-test/users/'+id+'/messages',payload:{channel:'public',text:'x'.repeat(4001)}})).statusCode,400);
  assert.equal((await app.inject({method:'DELETE',url:'/api/chat-test/users/'+id})).statusCode,200);assert.equal((await app.inject('/api/chat-test/users/'+id+'/memory')).statusCode,404);
 }finally{await app.close();await f.close();}
});

test('close中止并等待进行中的轮次结束，不在SQLite关闭后写回',{timeout:10000},async()=>{
 const f=fixture();try{
  let begun=false;f.setProduce((_s,_u,signal)=>new Promise((_resolve,reject)=>{begun=true;signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});}));const user=f.user(),work=f.service.addMessage(user.id,{channel:'private',text:'还没完成的问题？'});await until(()=>begun,'关闭前模型请求开始');await f.service.close();assert.equal((await work).turn.status,'cancelled');
 }finally{await f.close();}
});

test('试聊在360秒达到截止时间时取消，消息回队且已落账用量保留',{timeout:10000},async context=>{
 const f=fixture();context.mock.timers.enable({apis:['setTimeout']});try{
  let began=false;f.setProduce(()=>{began=true;return new Promise(()=>{});});const user=f.user(),work=f.service.addMessage(user.id,{channel:'private',text:'等待超时的问题？'}),deadline=Date.now()+2000;
  while(!began){if(Date.now()>deadline)throw new Error('等待超时测试的模型请求未开始');await new Promise(resolve=>setImmediate(resolve));}
  context.mock.timers.tick(359999);assert.equal(f.service.status().concurrency.active,1);assert.equal(f.service.turns(user.id).items[0].status,'running');
  context.mock.timers.tick(1);const result=await work;assert.equal(result.turn.status,'cancelled');assert.equal(f.service.status().concurrency.active,0);assert.equal(f.service.turns(user.id).queued.length,1);assert.equal(f.service.users().items[0].fees.requests,1);assert.equal(f.service.users().items[0].fees.unknown,1);
 }finally{context.mock.timers.reset();await f.close();}
});

test('人设删除后旧轮次仍保留名称修订并标注已删除，待处理消息拒绝使用已删除人设',{timeout:10000},async()=>{
 const f=fixture();try{
  const library=f.service.deps.persona.library,created=library.create({from:'copy',sourceId:f.service.deps.persona.activeIdentity().id,name:'可删除的人设'}).item,user=f.user();
  await f.service.addMessage(user.id,{channel:'public',text:'人设删除前的一轮？',personaId:created.id});await f.service.addMessage(user.id,{channel:'private',text:'人设删除后再处理？',personaId:created.id,hold:true});library.delete(created.id,created.revision);
  const old=f.service.turns(user.id).items[0];assert.equal(old.persona.name,'可删除的人设');assert.equal(old.persona.deleted,true);await assert.rejects(f.service.process(user.id),{statusCode:409});
 }finally{await f.close();}
});

test('同一测试用户跨渠道关联，新建与补写、重置保留、删除移除',{timeout:10000},async()=>{
 const f=fixture();try{
  const user=f.user();await f.service.addMessage(user.id,{channel:'public',text:'你好呀'});
  const turn=(await f.service.addMessage(user.id,{channel:'private',text:'你还记得我吗?'})).turn;
  assert.ok(turn.diagnostics.memory.recent.some((r:any)=>r.channel==='public'&&r.message==='你好呀'));
  const identities=f.service.memory(user.id);assert.equal(identities.public.links.links.length,1);assert.equal(identities.private.links.links[0].source,'chat-test');
  assert.equal((f.store.db.prepare('SELECT count(*) n FROM identity_links').get() as any).n,0);
  f.service.reset(user.id);assert.equal(f.service.memory(user.id).public.links.links.length,1);
  await f.service.close();const {DatabaseSync:RestartDb}=await import('node:sqlite'),legacy=new RestartDb(join(f.data,'chat-test','workflow.sqlite'));legacy.exec('DELETE FROM identity_links');legacy.close();
  const restarted=new ChatTestService(f.service.deps);try{assert.equal(restarted.memory(user.id).public.links.links.length,1);assert.equal(restarted.memory(user.id).public.links.links.length,1);restarted.reset(user.id,true);assert.equal(restarted.users().items.length,0);}finally{await restarted.close();}
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(f.data,'chat-test','workflow.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM identity_links').get()!.n,0);}finally{db.close();}
 }finally{await f.close();}
});

test('试聊时间注入覆盖最终提示词，晨间与深夜各用自己的时段',async()=>{
 const f=fixture();try{for(const [time,label]of [['2026-10-29T08:15:00+08:00','08:15（早上'],['2026-10-29T03:53:00+08:00','03:53（深夜']]){f.setNow(Date.parse(time));const user=f.user('时钟'+label),turn=(await f.service.addMessage(user.id,{channel:'public',text:'你好，想聊点轻松的 '+label})).turn;assert.ok(turn.segments.find((s:any)=>s.kind==='now').content.includes(label));}}finally{await f.close();}
});
