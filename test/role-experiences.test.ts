import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { MemoryService } from '../src/memory.js';
import { Outbox } from '../src/outbox.js';
import { RoleExperienceService,ExperienceError,recallRoleExperiences } from '../src/role-experiences.js';
import { registerRoleExperienceRoutes } from '../src/role-experience-routes.js';
import { ensureReferenceGapMigration } from '../src/reference-gap-schema.js';
import type { Generator } from '../src/model.js';
import type { Config,Event } from '../src/types.js';
import { exampleConfig } from './config-fixture.js';

function fixture(){
 const dir=mkdtempSync(tmpdir()+'/role-experiences-'),store=new Store(dir+'/workflow.sqlite');store.boot();let account='worker',clock=Date.parse('2026-10-28T12:00:00+08:00');
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async()=>{throw new Error('角色经历不得调用模型');}},memory=new MemoryService(store,generator,()=>exampleConfig as Config,()=>clock),outbox=new Outbox(store),experiences=new RoleExperienceService(store,()=>account,()=>clock);
 const create=(raw:any={})=>experiences.create({text:'管理员登记的真实经历',occurredAt:'2026-10-27',revision:experiences.list().revision,...raw});
 const post=(id:string,text='确认发布的角色帖子',scope=account)=>memory.recordExperience({accountId:scope,userId:'role',channel:'public',kind:'post',text,receipt:{status:'confirmed',id,url:'https://x.com/'+scope+'/status/'+id}}).id;
 const inspected=(url:string,over:Partial<Event>={})=>({event:{id:'fixture-post',platformId:new URL(url).pathname.split('/').at(-1)!,userId:'role',channel:'public',handle:account,text:'页面正文',url,conversationId:'thread',timestamp:clock-3600000,timestampReliable:true,...over} as Event});
 return {store,memory,outbox,experiences,create,post,inspected,now:()=>clock,setNow:(at:number)=>{clock=at;},setAccount:(value:string)=>{account=value;},close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('大量普通互动不挤走角色发帖、不跨用户召回，连续生成经历字节稳定',()=>{
 const f=fixture();try{
  const id=f.post('101'),before=JSON.stringify(f.memory.context('alice','public','worker').experiences);
  for(let i=0;i<50;i++)f.memory.recordExperience({accountId:'worker',userId:'user-'+i,channel:i%2?'private':'public',kind:'interaction',text:'普通互动 '+i,receipt:{status:'confirmed',id:'interaction-'+i}});
  assert.equal(f.memory.context('bob','public','worker').experiences[0].id,id);assert.equal(JSON.stringify(f.memory.context('bob','private','worker').experiences),before);assert.equal(JSON.stringify(f.memory.context('alice','public','worker').experiences),before);
  assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM role_experiences WHERE kind='interaction'").get() as any).n,50);assert.equal(f.memory.detail('user-1','private','worker').experiences.length,1);
  assert.deepEqual(recallRoleExperiences(f.store,'other'),[]);
 }finally{f.close();}
});

test('人工经历按发生日期取最近十条，登记数据不伪造平台回执',()=>{
 const f=fixture();try{
  for(let i=1;i<=12;i++)f.create({text:'发生日期条目 '+i,occurredAt:'2026-10-'+String(i).padStart(2,'0')});
  const recalled=recallRoleExperiences(f.store,'worker');assert.equal(recalled.length,10);assert.equal(recalled[0].text,'发生日期条目 12');assert.equal(recalled.at(-1)?.text,'发生日期条目 3');assert.equal(recalled[0].receipt,null);
  const page=f.experiences.list({limit:5}),second=f.experiences.list({limit:5,cursor:page.nextCursor!});assert.equal(new Set([...page.items,...second.items].map(r=>r.id)).size,10);assert.equal(page.items[0].origin,'manual');assert.equal(page.items[0].declaredOccurredAt,page.items[0].occurredAt);
 }finally{f.close();}
});

test('当前账号隔离，输入上限和列表/条目修订冲突均不覆盖已保存记录',()=>{
 const f=fixture();try{
  const first=f.create({text:'不写入日志的唯一经历正文'});assert.throws(()=>f.experiences.create({text:'旧列表',occurredAt:'2026-10-28',revision:0}),e=>e instanceof ExperienceError&&e.statusCode===409);
  const changed=f.experiences.edit(first.item.id,{text:'新修订内容',occurredAt:'2026-10-28',url:'',revision:first.item.revision});assert.ok(changed.item.revision>first.item.revision);
  assert.throws(()=>f.experiences.edit(first.item.id,{text:'过期编辑',occurredAt:'2026-10-28',revision:first.item.revision}),e=>e instanceof ExperienceError&&e.statusCode===409);
  for(const raw of [{text:''},{text:'x'.repeat(1201)},{occurredAt:'2026-02-30'},{occurredAt:'bad'},{url:'https://x.com/other/status/123'},{url:'https://evil.invalid/worker/status/123'},{url:'https://x.com/worker/status/123?x=1'},{accountId:'other'}])assert.throws(()=>f.create(raw));
  assert.equal(f.create({text:'x'.repeat(1200)}).item.text.length,1200);
  f.setAccount('other');assert.deepEqual(f.experiences.list().items,[]);assert.throws(()=>f.experiences.setHidden(first.item.id,true,changed.item.revision),e=>e instanceof ExperienceError&&e.statusCode===404);
  f.setAccount('');assert.throws(()=>f.experiences.list(),e=>e instanceof ExperienceError&&e.statusCode===409);assert.ok(!JSON.stringify(f.store.logs()).includes('不写入日志的唯一经历正文'));
 }finally{f.close();}
});

test('每账号两百条人工经历上限包含隐藏项，不占其他账号额度',()=>{
 const f=fixture();try{
  const hidden=f.create();f.experiences.setHidden(hidden.item.id,true,hidden.item.revision);
  const statement=f.store.db.prepare('INSERT INTO role_experiences VALUES(?,?,?,?,?,?,?,?,?,?)');for(let i=1;i<200;i++)statement.run('limit-'+i,'worker','role','public','manual','保留的人工条目','manual:limit-'+i,null,null,f.now()+i);
  assert.throws(()=>f.create(),e=>e instanceof ExperienceError&&e.statusCode===409);assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM role_experiences WHERE kind='manual'").get() as any).n,200);
  f.setAccount('other');assert.equal(f.create().item.accountId,'other');
 }finally{f.close();}
});

test('隐藏自动发帖只改变召回，平台回执、冻结出站和旧十值表结构原样保留',()=>{
 const f=fixture();try{
  const id=f.post('201'),before=f.store.db.prepare('SELECT * FROM role_experiences WHERE id=?').get(id),out=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'greeting',text:'原冻结正文'}),frozen=f.outbox.get(out.id);
  const original=f.experiences.list().items.find(r=>r.id===id)!;const hidden=f.experiences.setHidden(id,true,original.revision);assert.equal(hidden.item.hidden,true);assert.deepEqual(recallRoleExperiences(f.store,'worker'),[]);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM role_experiences WHERE id=?').get(id),before);assert.deepEqual(f.outbox.get(out.id),frozen);
  assert.throws(()=>f.experiences.edit(id,{text:'伪改发帖',occurredAt:'2026-10-28',revision:hidden.item.revision}),e=>e instanceof ExperienceError&&e.statusCode===409);
  f.experiences.setHidden(id,false,hidden.item.revision);assert.equal(recallRoleExperiences(f.store,'worker')[0].id,id);
  assert.equal(f.store.db.prepare('PRAGMA table_info(role_experiences)').all().length,10);ensureReferenceGapMigration(f.store.db);f.store.db.prepare('INSERT INTO role_experiences VALUES(?,?,?,?,?,?,?,?,?,?)').run('old-insert','worker','role','public','post','旧版按位置写入','receipt:202',null,'{"status":"confirmed","id":"202"}',f.now());
  assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=13').get() as any).n,1);
 }finally{f.close();}
});

test('无链接立即可用，带链接暂停时不核对，通过后使用可靠平台时间并保留登记日期',async()=>{
 const f=fixture();try{
  const noLink=f.create({text:'无链接经历'}),pending=f.create({text:'有链接经历',url:'https://x.com/worker/status/301'});assert.equal(noLink.item.verifyStatus,'verified');assert.equal(pending.item.verifyStatus,'pending');assert.equal(recallRoleExperiences(f.store,'worker').length,1);
  let calls=0;const inspect=async(url:string)=>{calls++;return f.inspected(url);};assert.equal((await f.experiences.verifyPending(inspect)).processed,0);assert.equal(calls,0);
  f.store.set('control','manual');await f.experiences.verifyPending(inspect);assert.equal(calls,0);f.store.set('control','draining');await f.experiences.verifyPending(inspect);assert.equal(calls,0);
  f.store.set('control','running');const checked=await f.experiences.verifyPending(inspect);assert.deepEqual(checked,{processed:1,verified:1,failed:0});assert.equal(calls,1);
  const item=f.experiences.list().items.find(r=>r.id===pending.item.id)!;assert.equal(item.occurredAt,f.now()-3600000);assert.equal(item.declaredOccurredAt,pending.item.declaredOccurredAt);assert.equal(item.receipt,null);assert.equal(recallRoleExperiences(f.store,'worker').length,2);
 }finally{f.close();}
});

test('核对错误作者、平台ID、可靠时间和页面失败只影响经历，不写平台退避',async()=>{
 for(const variant of ['author','id','time','page']){
  const f=fixture();try{
   f.create({url:'https://x.com/worker/status/401'});f.store.set('control','running');
   const result=await f.experiences.verifyPending(async(url)=>{if(variant==='page')throw new Error('页面可能含不应写入日志的正文');return f.inspected(url,variant==='author'?{handle:'other'}:variant==='id'?{platformId:'999'}:{timestamp:0,timestampReliable:false});});
   assert.deepEqual(result,{processed:1,verified:0,failed:1});assert.equal(f.experiences.list().items[0].verifyStatus,'failed');assert.deepEqual(recallRoleExperiences(f.store,'worker'),[]);assert.equal(f.store.get('cooldown:public'), '');assert.ok(!JSON.stringify(f.store.logs()).includes('页面可能含'));
  }finally{f.close();}
 }
});

test('核对期间编辑、隐藏、切号、暂停或取消不会把旧结果写入新经历',async()=>{
 for(const action of ['edit','hide','account','pause','abort']){
  const f=fixture();try{
   const item=f.create({url:'https://x.com/worker/status/501'}).item;f.store.set('control','running');const abort=new AbortController();
   let release!:(value:any)=>void;const waiting=f.experiences.verifyPending(async()=>new Promise(resolve=>{release=resolve;}),{signal:abort.signal});
   if(action==='edit')f.experiences.edit(item.id,{text:'新版本经历',occurredAt:'2026-10-28',url:'https://x.com/worker/status/502',revision:item.revision});
   if(action==='hide')f.experiences.setHidden(item.id,true,item.revision);if(action==='account')f.setAccount('other');if(action==='pause')f.store.set('control','paused');if(action==='abort')abort.abort();
   release(f.inspected('https://x.com/worker/status/501'));assert.equal((await waiting).processed,0);f.setAccount('worker');const current=f.experiences.list().items[0];assert.equal(current.verifyStatus,'pending');if(action==='edit'){assert.equal(current.text,'新版本经历');assert.equal(current.url,'https://x.com/worker/status/502');}
  }finally{f.close();}
 }
});

test('隐藏不会解除核对边界，每轮最多三个，浏览器安全暂停错误向主循环传播',async()=>{
 const f=fixture();try{
  const first=f.create({url:'https://x.com/worker/status/601'}).item;const hidden=f.experiences.setHidden(first.id,true,first.revision);for(let i=2;i<=5;i++)f.create({url:'https://x.com/worker/status/'+(600+i)});f.store.set('control','running');
  let calls=0;await f.experiences.verifyPending(async(url)=>{calls++;return f.inspected(url);});assert.equal(calls,3);assert.equal(f.experiences.list().items.filter(r=>r.verifyStatus==='verified').length,3);
  f.experiences.setHidden(first.id,false,hidden.item.revision);assert.equal(recallRoleExperiences(f.store,'worker').length,3);
  await assert.rejects(f.experiences.verifyPending(async()=>{throw Object.assign(new Error('浏览器已暂停'),{browserPaused:true});}),/浏览器已暂停/);assert.equal(f.experiences.list().items.find(r=>r.id===first.id)?.verifyStatus,'pending');
 }finally{f.close();}
});

test('人工经历不属于用户事实与遗忘范围，普通互动仍按用户遗忘删除',()=>{
 const f=fixture();try{
  const item=f.create().item;f.memory.recordExperience({accountId:'worker',userId:'alice',channel:'public',text:'关联互动',receipt:{status:'confirmed',id:'alice-reply'}});f.memory.forget('alice','worker');f.memory.forget('role','worker');
  assert.ok(f.experiences.list().items.some(r=>r.id===item.id));assert.equal(recallRoleExperiences(f.store,'worker')[0].id,item.id);assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM role_experiences WHERE user_id='alice'").get() as any).n,0);assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM memory_items').get() as any).n,0);
 }finally{f.close();}
});

test('角色经历接口沿用管理鉴权和控制标记，外部账号参数不能覆盖当前范围',async()=>{
 const f=fixture(),app=Fastify();try{
  app.addHook('onRequest',async(req,reply)=>{if(req.headers['x-ingress-key']!=='fixture')return reply.code(401).send({error:'未授权'});if(req.method!=='GET'&&req.headers['x-workflow-control']!=='1')return reply.code(403).send({error:'缺少控制标记'});});registerRoleExperienceRoutes(app,{experiences:f.experiences});
  const headers={'x-ingress-key':'fixture','x-workflow-control':'1'},url='/api/memory/experiences';assert.equal((await app.inject(url)).statusCode,401);assert.equal((await app.inject({method:'POST',url,headers:{'x-ingress-key':'fixture'},payload:{}})).statusCode,403);
  const created=await app.inject({method:'POST',url,headers,payload:{text:'界面登记',occurredAt:'2026-10-28',url:'',revision:0}});assert.equal(created.statusCode,200);const item=created.json().item;
  assert.equal((await app.inject({url:url+'?accountId=other',headers})).json().items[0].accountId,'worker');
  assert.equal((await app.inject({method:'PUT',url:url+'/'+item.id,headers,payload:{text:'过期',occurredAt:'2026-10-28',revision:0}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:url+'/'+item.id+'/hide',headers,payload:{revision:item.revision}})).json().item.hidden,true);assert.equal(f.store.get('control'),'paused');
  assert.equal((await app.inject({url:url+'?cursor=bad',headers})).statusCode,400);assert.equal((await app.inject({method:'POST',url,headers,payload:{accountId:'other',text:'覆盖',occurredAt:'2026-10-28',revision:0}})).statusCode,400);
 }finally{await app.close();f.close();}
});
