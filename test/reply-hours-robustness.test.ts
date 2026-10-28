// 仅由根代理在服务器隔离环境执行；可控时钟，不读取生产配置、模型或平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {replyWindow,effectiveAge,type ReplyClosure,type ReplyAgeSource} from '../src/reply-hours.js';
import {ReplyTriage,DEFAULT_TRIAGE_SETTINGS} from '../src/reply-triage.js';
import {Store} from '../src/store.js';
import {Program,registerProgramRoutes} from '../src/program.js';
import {exampleConfig} from './config-fixture.js';
import type {Event} from '../src/types.js';

const minute=60000,hour=60*minute,day=24*hour;
const at=(time:string)=>Date.parse(time+'+08:00');
const windowAt=(now:number,patch:Partial<Parameters<typeof replyWindow>[0]>={})=>replyWindow({now,enabled:true,closeDelayMinutes:30,morning:{enabled:false,time:'08:00'},eveningTime:'23:00',...patch});
const sourceOf=(window:ReturnType<typeof replyWindow>):ReplyAgeSource=>(window as any).agePolicy??window.closures;
function dbFixture(now:number,closures:()=>ReplyAgeSource=()=>[]){const dir=mkdtempSync(tmpdir()+'/reply-hours-robust-'),store=new Store(dir+'/workflow.sqlite'),triage=new ReplyTriage(store,()=>DEFAULT_TRIAGE_SETTINGS,()=>now,closures);return {store,triage,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}

test('最大48小时有效时效跨三个关闭夜晚时不误判超时',()=>{
 const now=at('2026-10-28T09:00:00'),received=at('2026-10-25T09:00:00'),window=windowAt(now);
 // 墙钟72小时，三夜各8.5小时，真正开放等待46.5小时。
 assert.equal(effectiveAge(received,now,sourceOf(window)),46.5*hour);
 const f=dbFixture(now,()=>sourceOf(window));try{assert.equal(f.triage.age(received),46.5*hour);}finally{f.close();}
});

test('每天仅开放一分钟时七天积压只累计七分钟有效等待',()=>{
 const now=at('2026-10-28T08:00:00'),received=now-7*day,window=windowAt(now,{closeDelayMinutes:0,morning:{enabled:false,time:'08:00'},eveningTime:'08:01'});
 assert.equal(window.open,true);
 assert.equal(effectiveAge(received,now,sourceOf(window)),7*minute);
});

test('分级SQL与发送边界对跨三天的优先排队消息保持一致且仍可处理',()=>{
 const now=at('2026-10-28T09:00:00'),received=at('2026-10-25T09:00:00'),window=windowAt(now),f=dbFixture(now,()=>sourceOf(window));
 try{
  const event:Event={id:'x:100001',platformId:'100001',channel:'public',userId:'x:alice',handle:'alice',text:'一条持续等待的明确问题',conversationId:'100001',timestamp:received,timestampReliable:true};
  assert.equal(f.store.ingest(event,'worker'),true);const row=f.store.getMessage(event.id,'worker');assert.ok(row);f.store.db.prepare("UPDATE messages SET tier='priority',tier_reason='重点账号' WHERE id=?").run(row.id);
  const q=f.triage.queuedEligibility(48),eligible=f.store.db.prepare('SELECT m.id FROM messages m WHERE m.account_id=? AND '+q.sql).all('worker',...q.params);
  assert.equal(eligible.length,1);assert.equal(f.triage.healthQueue('worker',48).public?.count,1);
  assert.equal(f.triage.pending(1,'worker',['public'],48)[0]?.id,row.id);assert.equal(f.store.getMessage(row.id).status,'queued');
 }finally{f.close();}
});

test('历史资格查询显式使用传入时刻而不偷用当前时刻',()=>{
 const now=at('2026-10-28T12:00:00'),past=now-2*hour,f=dbFixture(now);try{
  const event:Event={id:'x:100002',platformId:'100002',channel:'public',userId:'x:bob',handle:'bob',text:'普通排队消息',conversationId:'100002',timestamp:now-4*hour,timestampReliable:true};
  f.store.ingest(event,'worker');const row=f.store.getMessage(event.id,'worker');f.store.db.prepare("UPDATE messages SET tier='normal' WHERE id=?").run(row.id);
  const current=f.triage.queuedEligibility(6),historical=(f.triage.queuedEligibility as any)(6,{},past);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages m WHERE '+current.sql).get(...current.params)?.n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages m WHERE '+historical.sql).get(...historical.params)?.n,1);
 }finally{f.close();}
});

test('关闭区间重叠、相邻、零长和未来项在1000个时刻下SQL与纯函数一致',()=>{
 const intervals:ReplyClosure[]=[{start:20,end:150},{start:80,end:190},{start:190,end:240},{start:300,end:300},{start:400,end:550},{start:900,end:1200}];
 const f=dbFixture(1000,()=>intervals);try{
  f.store.db.exec('CREATE TABLE controlled_age_samples(id INTEGER PRIMARY KEY,received_at INTEGER NOT NULL)');const insert=f.store.db.prepare('INSERT INTO controlled_age_samples VALUES(?,?)');
  f.store.db.exec('BEGIN');for(let i=0;i<1000;i++)insert.run(i,i-100);f.store.db.exec('COMMIT');
  const q=f.triage.ageSql('m.received_at',700),rows=f.store.db.prepare('SELECT m.id,'+q.sql+' age FROM controlled_age_samples m ORDER BY m.id').all(...q.params) as {id:number;age:number}[];
  assert.equal(rows.length,1000);for(const row of rows)assert.equal(row.age,effectiveAge(row.id-100,700,intervals),'样本 '+row.id);
 }finally{f.close();}
});

test('跨零点与早安延迟边界使用半开区间，零长作息不额外等待早安',()=>{
 const morning=at('2026-10-28T08:00:00'),ended=morning+2*minute;
 const options={eveningTime:'23:30',closeDelayMinutes:60,morning:{enabled:true,time:'08:00'},morningRunEnded:()=>ended};
 assert.equal(windowAt(morning-1,options).open,false);assert.equal(windowAt(morning,options).reason,'waiting-morning-post');assert.equal(windowAt(ended-1,options).open,false);assert.equal(windowAt(ended,options).open,true);
 const zero=windowAt(morning,{eveningTime:'07:30',closeDelayMinutes:30,morning:{enabled:true,time:'08:00'},morningRunEnded:()=>null});assert.equal(zero.open,true);assert.deepEqual(zero.closures,[]);
 const cap={morning:{enabled:true,time:'08:00'},morningRunEnded:()=>morning+day};assert.equal(windowAt(morning+15*minute-1,cap).open,false);assert.equal(windowAt(morning+15*minute,cap).open,true);
});

test('十年周期等待与1000个SQL样本一致，跨度不增加SQL参数',()=>{
 const now=at('2026-10-28T08:00:00'),received=at('2016-10-28T08:00:00'),days=(now-received)/day;
 const window=windowAt(now,{closeDelayMinutes:0,morning:{enabled:false,time:'08:00'},eveningTime:'08:01'}),source=sourceOf(window),f=dbFixture(now,()=>source);
 try{
  assert.equal(effectiveAge(received,now,source),days*minute);
  f.store.db.exec('CREATE TABLE decade_samples(id INTEGER PRIMARY KEY,received_at REAL NOT NULL)');const insert=f.store.db.prepare('INSERT INTO decade_samples VALUES(?,?)');
  f.store.db.exec('BEGIN');for(let i=0;i<1000;i++)insert.run(i,received+i*1234567.25);f.store.db.exec('COMMIT');
  const q=f.triage.ageSql('m.received_at',now);assert.ok(q.params.length<=4,'不能按天展开上千参数');
  const rows=f.store.db.prepare('SELECT m.received_at,'+q.sql+' age FROM decade_samples m ORDER BY m.id').all(...q.params) as {received_at:number;age:number}[];
  for(const row of rows)assert.equal(row.age,effectiveAge(row.received_at,now,source));
 }finally{f.close();}
});

test('历史早安实际终态补回等待差量，短开放间隙与重复终态不重复计时',()=>{
 const now=at('2026-10-28T08:00:00'),received=now-7*day,ends=[0,2,4].map(i=>({scheduledAt:received+i*day,endedAt:received+i*day+2*minute}));
 const normal=windowAt(now,{morning:{enabled:true,time:'08:00'},morningRunEnds:ends}),normalSource=sourceOf(normal),f=dbFixture(now,()=>normalSource);
 try{
  const expected=7*(day-8.75*hour)+3*13*minute;assert.equal(effectiveAge(received,now,normalSource),expected);
  f.store.db.exec('CREATE TABLE morning_sample(received_at INTEGER NOT NULL)');f.store.db.prepare('INSERT INTO morning_sample VALUES(?)').run(received);const q=f.triage.ageSql('m.received_at',now);
  assert.ok(q.params.length<=4);assert.equal(f.store.db.prepare('SELECT '+q.sql+' age FROM morning_sample m').get(...q.params)?.age,expected);
  const early=[0,4].map(i=>({scheduledAt:received+i*day,endedAt:received+i*day+30000})),short=windowAt(now,{closeDelayMinutes:0,morning:{enabled:true,time:'08:00'},eveningTime:'08:01',morningRunEnds:[...early,...early]});
  assert.equal(effectiveAge(received,now,sourceOf(short)),minute);
 }finally{f.close();}
});

test('差量JSON只在可能相交时读取，前后与半开精确边界保持SQL和纯函数一致',()=>{
 const firstScheduled=at('2026-10-26T08:00:00'),lastScheduled=firstScheduled+day,firstStart=firstScheduled+2*minute,lastEnd=lastScheduled+15*minute;
 const window=windowAt(lastEnd+hour,{morning:{enabled:true,time:'08:00'},morningRunEnds:[{scheduledAt:firstScheduled,endedAt:firstStart},{scheduledAt:lastScheduled,endedAt:lastScheduled+3*minute}]}),source=sourceOf(window),f=dbFixture(lastEnd+hour,()=>source);
 try{
  f.store.db.exec('CREATE TABLE overlap_sample(received_at REAL NOT NULL)');f.store.db.prepare('INSERT INTO overlap_sample VALUES(?)').run(firstStart-hour);
  let jsonReads=0;f.store.db.function('json_extract',(value,path)=>{jsonReads++;const item=JSON.parse(String(value));return item[String(path).slice(2)]??null;});
  const check=(received:number,end:number)=>{jsonReads=0;f.store.db.prepare('UPDATE overlap_sample SET received_at=?').run(received);const q=f.triage.ageSql('m.received_at',end),row=f.store.db.prepare('SELECT '+q.sql+' age FROM overlap_sample m').get(...q.params);assert.ok(q.params.length<=4);assert.equal(row?.age,effectiveAge(received,end,source),'received='+received+', at='+end);return {reads:jsonReads,params:q.params};};
  for(const end of [firstStart-1,firstStart]){const sample=check(firstStart-hour,end);assert.equal(sample.reads,0);assert.equal(sample.params.length,2);}
  const overlap=check(firstStart+1,firstScheduled+10*minute);assert.ok(overlap.reads>0,'相交时仍读取实际历史差量');assert.equal(overlap.params.length,4);
  for(const received of [lastEnd,lastEnd+.5,lastEnd+minute]){const sample=check(received,lastEnd+hour);assert.equal(sample.reads,0);assert.equal(sample.params.length,4);}
  for(const end of [firstStart+1,lastEnd-1,lastEnd,lastEnd+hour])for(const received of [firstStart-hour,firstStart,firstStart+.5,lastScheduled+3*minute,lastEnd-1,lastEnd])check(received,end);
 }finally{f.close();}
});

test('程序接口保留近期时段展示但不泄漏内部周期策略及全历史早安记录',async()=>{
 const dir=mkdtempSync(tmpdir()+'/reply-hours-dto-'),previous={DATA_DIR:process.env.DATA_DIR,CONFIG_PATH:process.env.CONFIG_PATH};process.env.DATA_DIR=dir;process.env.CONFIG_PATH=dir+'/config.json';writeFileSync(process.env.CONFIG_PATH,JSON.stringify(exampleConfig));
 const store=new Store(dir+'/workflow.sqlite'),app=Fastify(),program=new Program(store),window=windowAt(at('2026-10-28T09:00:00'),{morning:{enabled:true,time:'08:00'},morningRunEnds:[{scheduledAt:at('2016-10-28T08:00:00'),endedAt:at('2016-10-28T08:02:00')}]});
 try{
  assert.ok(window.agePolicy?.overrides.length);registerProgramRoutes(app,{store,program,workflow:{control:()=> 'paused',busy:false,lastTick:0,nextTick:0,accountId:()=> 'worker',sentCount:()=>0,replyHours:()=>window}});
  const response=await app.inject('/api/program');assert.equal(response.statusCode,200);const dto=response.json().replyHours;
  assert.equal(dto.closeTime,'23:30');assert.deepEqual(dto.closures,window.closures);assert.equal(Object.hasOwn(dto,'agePolicy'),false);assert.doesNotMatch(JSON.stringify(dto),/overrides|periodMs|2016/);
 }finally{await app.close();store.db.close();rmSync(dir,{recursive:true,force:true});for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
