import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import {assembleReplyPrompt} from '../src/reply-prompt.js';
import type {Generator} from '../src/model.js';
import type {Config,Event} from '../src/types.js';
import {exampleConfig} from './config-fixture.js';

const now=Date.parse('2026-10-30T08:00:00Z'),policy={recentCount:30,recentDays:7,retentionDays:30};
function fixture(){
 const dir=mkdtempSync(tmpdir()+'/public-related-'),prior=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(dir+'/workflow.sqlite');
 const generator={complete:async()=>{throw Error('上下文召回不得调用模型');}} as unknown as Generator;
 const memory=new MemoryService(store,generator,()=>exampleConfig as Config,()=>now);
 const add=(n:number,status='queued',patch:Partial<Event>={},account='work')=>{
  const event:Event={id:'source-'+n,platformId:String(n),targetId:String(n),channel:'public',userId:'x:alice',handle:'alice',text:'公开来言'+n,url:'https://x.com/alice/status/'+n,conversationId:String(n),timestamp:now-100000+n,timestampReliable:true,...patch};
  store.ingest(event,account);const row=store.findByPlatformId(account,event.channel,event.platformId!);
  if(row&&status!=='queued')store.update(row.id,status,{draft:{action:'reply',text:'候选回复'+n,reason:''}});
  return {...event,id:row?.id??event.id};
 };
 const current=add(900,'generating');
 return {store,memory,add,current,context:(p=policy)=>memory.context('x:alice','public','work',now,p,current),close:()=>{store.db.close();rmSync(dir,{recursive:true,force:true});if(prior===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=prior;}};
}

test('不同帖子下同一人的可靠公开来言按有界近期往来注入，并标明来源与状态',()=>{
 const f=fixture();try{
  f.add(101,'confirmed');f.add(102);f.add(103,'draft');f.add(104,'unknown');f.add(105,'approved');f.add(106,'merged');
  const before=JSON.stringify(f.store.db.prepare('SELECT * FROM messages ORDER BY id').all());
  const recent=f.context().recent;
  assert.deepEqual(recent.map(row=>row.platformId),['101','102','103','104','105','106']);
  assert.ok(recent.every(row=>row.contextRelation==='other-public-thread'&&row.channel==='public'&&row.url==='https://x.com/alice/status/'+row.platformId&&row.conversationId===row.platformId&&Number.isSafeInteger(row.timestamp)));
  assert.equal(recent.find(row=>row.platformId==='101')!.reply,'候选回复101');
  for(const id of ['102','103','104','105','106'])assert.equal(recent.find(row=>row.platformId===id)!.reply,undefined);
  assert.ok(!recent.some(row=>row.platformId==='900'||row.id===f.current.id));
  assert.deepEqual(recent.map(row=>row.status),['confirmed','queued','draft','unknown','approved','merged']);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM messages ORDER BY id').all()),before);
 }finally{f.close();}
});

test('当前线程的排队前文不重复注入，已确认往来仍保留线程标记',()=>{
 const f=fixture();try{
  f.add(201,'queued',{conversationId:f.current.conversationId});
  f.add(202,'merged',{conversationId:f.current.conversationId});
  f.add(203,'confirmed',{conversationId:f.current.conversationId});
  const recent=f.context().recent;assert.equal(recent.length,1);assert.equal(recent[0].platformId,'203');assert.equal(recent[0].contextRelation,'same-public-thread');
 }finally{f.close();}
});

test('跨帖参考不跨账号、公开身份或私信，不包含过滤忽略与不可靠来源',()=>{
 const f=fixture();try{
  f.add(301,'confirmed',{},'other');
  f.add(302,'confirmed',{userId:'x:bob',handle:'bob',url:'https://x.com/bob/status/302'});
  f.add(303,'confirmed',{channel:'private',userId:'x:alice',text:'私信原文不得进入公开'});
  f.add(304,'filtered');f.add(305,'ignored');
  f.add(306,'queued',{timestampReliable:false});
  f.add(307,'queued',{conversationIdReliable:false});
  f.add(308,'queued',{publicRelationConflict:true});
  f.add(309,'queued',{url:'https://x.com/bob/status/309'});
  f.add(310,'queued',{url:'https://x.com/alice/status/310?unverified=1'});
  f.add(311,'queued',{conversationId:'unknown-thread'});
  f.add(312,'queued',{timestamp:now+1000});
  f.add(313,'queued',{timestamp:now-8*86400000});
  f.add(314,'queued',{handle:'bob'});
  const conflict=f.add(316);const conflicted=f.store.getMessage(conflict.id,'work'),body=JSON.parse(conflicted.body);body.accountId='other';
  f.store.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(body),conflict.id);
  assert.deepEqual(f.context().recent,[]);
  f.add(315,'queued');assert.deepEqual(f.context().recent.map(row=>row.platformId),['315']);
 }finally{f.close();}
});

test('近期条数和天数沿用现有策略，遗忘后不从其他帖子复活记录',()=>{
 const f=fixture();try{
  f.add(401,'confirmed');f.add(402,'queued');f.add(403,'queued');f.add(404,'queued');
  assert.deepEqual(f.context({...policy,recentCount:2}).recent.map(row=>row.platformId),['403','404']);
  f.memory.forget('x:alice','work');assert.deepEqual(f.context().recent,[]);
  f.memory.remember('x:alice','work');assert.deepEqual(f.context().recent,[]);
 }finally{f.close();}
});

test('公开身份以持久user_id绑定，改handle后的旧来言可参考而不同用户不混合',()=>{
 const f=fixture();try{
  const userId='stable-public-person',current=f.add(801,'generating',{userId,handle:'new_alice',url:'https://x.com/new_alice/status/801'});
  f.add(802,'confirmed',{userId,handle:'old_alice',url:'https://x.com/old_alice/status/802'});
  f.add(803,'queued',{userId,handle:'new_alice',url:'https://x.com/new_alice/status/803'});
  f.add(804,'confirmed',{userId:'different-person',handle:'old_alice',url:'https://x.com/old_alice/status/804'});
  const recent=f.memory.context(userId,'public','work',now,policy,current).recent;
  assert.deepEqual(recent.map(row=>row.platformId),['802','803']);assert.equal(recent[0].url,'https://x.com/old_alice/status/802');
 }finally{f.close();}
});

test('删除第一帖的记忆来源后，第二帖上下文不再注入被删来源原文',()=>{
 const f=fixture();try{
  const source=f.add(601,'confirmed',{text:'应从后续跨帖上下文移除的独特原文'}),itemId='removed-public-source';
  f.store.db.prepare('INSERT INTO memory_items(id,account_id,user_id,channel,kind,text,source_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(itemId,'work','x:alice','public','fact','应删除的记忆事实','complete',now,now);
  f.store.db.prepare('INSERT INTO memory_sources VALUES(?,?,?)').run(itemId,source.id,now);
  assert.ok(JSON.stringify(f.context()).includes('应从后续跨帖上下文移除的独特原文'));
  f.memory.remove(itemId,'work',1);
  assert.ok(f.store.getMessage(source.id,'work'),'原消息保留，不能靠删源消息让检查通过');
  assert.ok(f.store.db.prepare('SELECT 1 FROM memory_ignored WHERE account_id=? AND user_id=? AND channel=? AND message_id=?').get('work','x:alice','public',source.id));
  assert.ok(!JSON.stringify(f.context()).includes('应从后续跨帖上下文移除的独特原文'));
  assert.ok(!f.context().recent.some(row=>row.id===source.id));
 }finally{f.close();}
});

test('提示词将其他帖往来标为参考，未知和草稿不冒充已发回复且系统前缀不变',()=>{
 const f=fixture();try{
  f.add(501,'confirmed');f.add(502,'unknown');
  const input={staticText:'人格',message:'当前帖子的问题',channel:'public' as const,accountId:'work',now,conversation:{messages:[{text:'当前帖上文'}]},memory:f.context()};
  const prompt=assembleReplyPrompt(input),baseline=assembleReplyPrompt({...input,memory:{memories:[],recent:[]}});
  assert.equal(prompt.system,baseline.system);
  const recent=prompt.segments.find(segment=>segment.kind==='recent')!,current=prompt.segments.find(segment=>segment.kind==='conversation')!;
  assert.ok(recent.content.includes('只在与本次话题有关时参考'));assert.ok(recent.content.includes('不当作当前线程的直接上文'));
  assert.ok(recent.content.includes('https://x.com/alice/status/501'));assert.ok(recent.content.includes('other-public-thread'));
  assert.ok(recent.content.includes('候选回复501'));assert.ok(!recent.content.includes('候选回复502'));
  assert.ok(current.content.includes('当前帖上文'));assert.ok(!current.content.includes('公开来言501'));
 }finally{f.close();}
});
