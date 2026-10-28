import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { MemoryService } from '../src/memory.js';
import { registerMemoryRoutes } from '../src/memory-routes.js';
import type { Config, Event } from '../src/types.js';
import type { Generator } from '../src/model.js';
import { exampleConfig } from './config-fixture.js';

function fixture(){
 const path=mkdtempSync(tmpdir()+'/memory-test-'),prior=process.env.DATA_DIR;process.env.DATA_DIR=path;
 const store=new Store(path+'/workflow.sqlite');
 let at=Date.now(),calls=0,produce:(system:string,user:string)=>any=(_system,user)=>{const r=JSON.parse(user);return {items:r.incoming.map((x:any)=>({type:'fact',text:'事实'+x.id,sourceIds:[x.id]}))};};
 const metadata:any[]=[];
 const generator:Generator={complete:async(_c,system,user,_signal,_session,meta)=>{calls++;metadata.push(meta);return {text:JSON.stringify(await produce(system,user)),input:10,output:5,cache:0};}};
 const memory=new MemoryService(store,generator,()=>exampleConfig as Config,()=>at);
 const add=(n:number,over:Partial<Event>={},accountId='work',status='confirmed')=>{
  const e:Event={id:'x:'+n,platformId:String(n),channel:'public',userId:'x:alice',handle:'alice',text:'用户自述'+n,url:'https://x.com/alice/status/'+n,conversationId:String(n),timestamp:at,...over};
  store.ingest(e,accountId);const row=store.db.prepare('SELECT id FROM messages WHERE account_id=? AND user_id=? ORDER BY rowid DESC LIMIT 1').get(accountId,e.userId) as any;
  if(row)store.update(row.id,status,{draft:{action:'reply',text:'角色回复'+n,reason:''}});
  return row?.id as string;
 };
 return {path,store,memory,add,generator,metadata,calls:()=>calls,setNow:(n:number)=>at=n,setProduce:(fn:typeof produce)=>produce=fn,close:()=>{store.db.close();if(prior===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=prior;rmSync(path,{recursive:true,force:true});}};
}

test('召回默认三次七天，草稿不冒充发送且公开不含私信',()=>{
 const f=fixture();try{
  f.add(1,{timestamp:Date.now()-8*86400000});f.add(2,{},'work','draft');f.add(3);f.add(4);f.add(5,{channel:'private',userId:'dm:thread',text:'私信秘密'});
  const context=f.memory.context('x:alice','public','work');
  assert.equal(context.recent.length,3);assert.equal(context.recent[0].reply,undefined);assert.equal(context.recent[1].reply,'角色回复3');assert.ok(!JSON.stringify(context).includes('秘密'));assert.ok(!JSON.stringify(context).includes('用户自述1'));
  assert.deepEqual(f.memory.context('x:alice','public','another').recent,[]);
 }finally{f.close();}
});

test('旧摘要原文保留且来源不完整，未知归属不交给当前账号',()=>{
 const f=fixture();try{
  f.store.summary('x:alice','public','旧用户事实原文',0);
  const migrated=new MemoryService(f.store,f.generator,()=>exampleConfig as Config);
  const old=migrated.items('x:alice','public','');assert.equal(old.length,1);assert.equal(old[0].text,'旧用户事实原文');assert.equal(old[0].sourceStatus,'incomplete');assert.deepEqual(old[0].sources,[]);
  assert.deepEqual(migrated.context('x:alice','public','work').memories,[]);
  new MemoryService(f.store,f.generator,()=>exampleConfig as Config);assert.equal(migrated.items('x:alice','public','').length,1);
 }finally{f.close();}
});

test('处理游标计入早平台时间，整理合并旧事实且无新增不调用',async()=>{
 const f=fixture();try{
  for(let i=1;i<=5;i++)f.add(i,{timestamp:Date.now()-86400000});
  assert.equal(f.memory.due('work')[0].newCount,5);await f.memory.summarize('x:alice','public','work');assert.equal(f.calls(),1);assert.equal(f.metadata[0].jsonObject,true);assert.equal(f.memory.items('x:alice','public','work').length,5);
  assert.deepEqual(f.memory.due('work'),[]);assert.equal((await f.memory.summarize('x:alice','public','work')).written,false);assert.equal(f.calls(),1);
  f.add(6,{timestamp:Date.now()-2*86400000});assert.equal(f.memory.due('work',1)[0].newCount,1);
  f.setProduce((_s,user)=>{const p=JSON.parse(user);assert.equal(p.existing.length,5);return {items:[{type:'preference',text:'新的偏好',sourceIds:[p.incoming[0].id]}]};});
  await f.memory.summarize('x:alice','public','work');assert.equal(f.memory.items('x:alice','public','work').length,6);
 }finally{f.close();}
});

test('手工编辑使旧后台整理失效',async()=>{
 const f=fixture();try{
  f.add(1);await f.memory.summarize('x:alice','public','work');f.add(2);
  let finish!:(value:any)=>void;let started!:()=>void;const ready=new Promise<void>(r=>started=r);
  f.setProduce((_s,user)=>{const p=JSON.parse(user);started();return new Promise(r=>finish=r);});
  const work=f.memory.summarize('x:alice','public','work');await ready;
  const item=f.memory.items('x:alice','public','work')[0];f.memory.edit(item.id,'work','人工修订事实',item.revision);
  finish({items:[{id:item.id,type:'fact',text:'旧请求错误覆盖',sourceIds:[f.store.db.prepare("SELECT id FROM messages WHERE account_id='work' ORDER BY rowid DESC LIMIT 1").get()!.id]}]});
  assert.equal((await work).stale,true);assert.equal(f.memory.items('x:alice','public','work')[0].text,'人工修订事实');
 }finally{f.close();}
});

test('删除忽略旧来源，独立删除账本在恢复旧条目后重放',async()=>{
 const f=fixture();try{
  const source=f.add(1);await f.memory.summarize('x:alice','public','work');
  const item=f.memory.items('x:alice','public','work')[0];f.memory.remove(item.id,'work',item.revision);
  assert.equal((await f.memory.summarize('x:alice','public','work',{force:true})).written,false);assert.equal(f.calls(),1);
  // 模拟恢复数据库中的旧条目与旧来源，保留当前独立删除账本。
  f.store.db.prepare('INSERT INTO memory_items(id,account_id,user_id,channel,kind,text,source_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(item.id,'work','x:alice','public','fact',item.text,'complete',Date.now(),Date.now());
  f.store.db.prepare('INSERT INTO memory_sources VALUES(?,?,?)').run(item.id,source,Date.now());
  new MemoryService(f.store,f.generator,()=>exampleConfig as Config);assert.equal(f.memory.items('x:alice','public','work').length,0);
 }finally{f.close();}
});

test('遗忘阻止后台写回，恢复仅记录未来内容',async()=>{
 const f=fixture();try{
  const source=f.add(1);let finish!:(value:any)=>void;let started!:()=>void;const ready=new Promise<void>(r=>started=r);
  f.setProduce(()=>{started();return new Promise(r=>finish=r);});const work=f.memory.summarize('x:alice','public','work');await ready;
  f.memory.forget('x:alice','work');finish({items:[{type:'fact',text:'迟到事实',sourceIds:[source]}]});assert.equal((await work).written,false);assert.deepEqual(f.memory.context('x:alice','public','work').memories,[]);
  f.memory.remember('x:alice','work');assert.equal(f.memory.context('x:alice','public','work').recent.length,0);f.setNow(f.store.recordingAfter('x:alice','work')+1000);f.add(2);assert.equal(f.memory.context('x:alice','public','work').recent.length,1);
 }finally{f.close();}
});

test('遗忘后恢复记录仍在恢复旧库时清除历史条目并保留新的记录',async()=>{
 const f=fixture();try{
  f.add(1);await f.memory.summarize('x:alice','public','work');
  const old=f.store.db.prepare("SELECT * FROM memory_items WHERE account_id='work'").get() as any;
  f.memory.forget('x:alice','work');f.memory.remember('x:alice','work');f.setNow(f.store.recordingAfter('x:alice','work')+1000);
  f.add(2);await f.memory.summarize('x:alice','public','work');
  f.store.db.prepare('INSERT INTO memory_items(id,account_id,user_id,channel,kind,text,revision,source_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(old.id,old.account_id,old.user_id,old.channel,old.kind,old.text,old.revision,old.source_status,old.created_at,old.updated_at);
  new MemoryService(f.store,f.generator,()=>exampleConfig as Config);
  const texts=f.memory.items('x:alice','public','work').map(i=>i.text);assert.equal(texts.length,1);assert.ok(!texts.includes(old.text));assert.equal(f.memory.context('x:alice','public','work').recent.length,1);
 }finally{f.close();}
});

test('同范围并发整理共用一次调用，未知来源不写入',async()=>{
 const f=fixture();try{
  f.add(1);let finish!:(value:any)=>void;let started!:()=>void;const ready=new Promise<void>(r=>started=r);
  f.setProduce(()=>{started();return new Promise(r=>finish=r);});const first=f.memory.summarize('x:alice','public','work');await ready;const second=f.memory.summarize('x:alice','public','work');
  finish({items:[{type:'fact',text:'没有依据的事实',sourceIds:['unknown']}]});await Promise.all([first,second]);assert.equal(f.calls(),1);assert.equal(f.memory.items('x:alice','public','work').length,0);
 }finally{f.close();}
});

test('超过五十条积压时手动整理也不跨过尚未消费的前缀',async()=>{
 const f=fixture();try{
  for(let i=1;i<=55;i++)f.add(i);
  const batches:string[][]=[];f.setProduce((_s,user)=>{const p=JSON.parse(user);batches.push(p.incoming.map((r:any)=>r.id));return {items:[]};});
  await f.memory.summarize('x:alice','public','work',{force:true});assert.equal(batches[0].length,50);assert.equal(f.memory.due('work')[0].newCount,5);
  await f.memory.summarize('x:alice','public','work');assert.equal(batches[1].length,5);assert.equal(new Set(batches.flat()).size,55);assert.deepEqual(f.memory.due('work'),[]);
 }finally{f.close();}
});

test('生产长期召回不重复来源原文，条目详情仍可检查来源',async()=>{
 const f=fixture();try{
  const source=f.add(1,{text:'长原文'.repeat(2500)});f.setProduce(()=>({items:[{type:'fact',text:'简短明确事实',sourceIds:[source]}]}));
  await f.memory.summarize('x:alice','public','work');const context=f.memory.context('x:alice','public','work');assert.equal(context.memories[0].sources[0].text,undefined);assert.ok(f.memory.detail('x:alice','public','work').items[0].sources[0].text?.startsWith('长原文'));
 }finally{f.close();}
});

test('清理原文后来源显示不可用并保留原始平台时间',async()=>{
 const f=fixture();try{
  const timestamp=Date.now()-2*86400000,source=f.add(1,{timestamp});f.setProduce(()=>({items:[{type:'fact',text:'有来源事实',sourceIds:[source]}]}));await f.memory.summarize('x:alice','public','work');
  f.store.db.prepare('DELETE FROM messages WHERE id=?').run(source);const item=f.memory.detail('x:alice','public','work').items[0];assert.equal(item.sources[0].available,false);assert.equal(item.sources[0].timestamp,timestamp);assert.equal(item.sources[0].text,undefined);
 }finally{f.close();}
});

test('角色经历必须有明确来源，不把虚构活动自动转为经历',()=>{
 const f=fixture();try{
  assert.throws(()=>f.memory.recordExperience({accountId:'work',userId:'x:alice',channel:'public',text:'虚构外出'}),/缺少明确来源/);
  const source=f.add(1);f.memory.recordExperience({accountId:'work',userId:'x:alice',channel:'public',text:'有原文依据的互动',sourceMessageId:source});
  f.memory.recordExperience({accountId:'work',userId:'x:alice',channel:'private',text:'私信互动',receipt:{status:'confirmed',id:'receipt-private'}});
  assert.equal(f.memory.context('x:alice','public','work').experiences.length,0);assert.equal(f.memory.context('x:alice','private','work').experiences.length,0);
  assert.equal(f.memory.detail('x:alice','public','work').experiences.length,1);assert.equal(f.memory.detail('x:alice','private','work').experiences.length,2);
  assert.deepEqual(f.memory.context('x:alice','private','another').experiences,[]);
 }finally{f.close();}
});

test('管理接口分页与只读预览不写回，策略修订冲突不改变控制',async()=>{
 const f=fixture(),app=Fastify();registerMemoryRoutes(app,{memory:f.memory,account:()=> 'work'});
 try{
  f.add(1);f.add(2,{userId:'dm:unknown',channel:'private'});f.store.set('control','paused');
  const listing=(await app.inject({url:'/api/memory/users?limit=1'})).json();assert.equal(listing.users.length,1);assert.equal(listing.nextCursor,1);
  const before=f.store.db.prepare('SELECT count(*) AS n FROM memory_items').get()!.n;
  const preview=await app.inject({method:'POST',url:'/api/memory/users/x%3Aalice/preview',payload:{channel:'public'}});assert.equal(preview.statusCode,200);assert.equal(preview.json().readonly,true);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM memory_items').get()!.n,before);assert.equal(f.calls(),0);
  const policy=(await app.inject({url:'/api/memory/policy'})).json();const update=await app.inject({method:'PUT',url:'/api/memory/policy',payload:{policy:{...policy.policy,recentCount:4},revision:policy.revision}});assert.equal(update.statusCode,200);
  const conflict=await app.inject({method:'PUT',url:'/api/memory/policy',payload:{policy:policy.policy,revision:policy.revision}});assert.equal(conflict.statusCode,409);assert.equal(f.store.get('control'),'paused');
  assert.equal((await app.inject({url:'/api/memory/users?limit=999'})).statusCode,400);
 }finally{await app.close();f.close();}
});
