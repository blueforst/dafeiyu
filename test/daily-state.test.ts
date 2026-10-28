import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DailyStateService,shanghaiDate,validateDailyContent,type DailyContent } from '../src/daily-state.js';
import type { Config } from '../src/types.js';
import type { Generator } from '../src/model.js';
import { exampleConfig } from './config-fixture.js';

function content(date:string,mood='平静'):DailyContent{return {date,fictional:true,periods:[{start:'06:00',end:'12:00',activity:'读书'},{start:'12:00',end:'24:00',activity:'休息'}],meals:{breakfast:'粥',lunch:'饭',dinner:'面'},activities:['读书'],mood};}
function fixture(run?:(user:string)=>Promise<string>) {
 const dir=mkdtempSync(join(tmpdir(),'role-daily-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(join(dir,'workflow.sqlite'));store.set('control','running');
 let at=Date.parse('2026-10-28T07:00:00+08:00'),calls=0;
 const generator:Generator={async complete(c,system,user){calls++;return {text:run?await run(user):JSON.stringify(content(JSON.parse(user).date)),input:10,output:20,cache:0,callId:'call-'+calls};}};
 const service=new DailyStateService(store,generator,()=>structuredClone(exampleConfig) as Config,()=>at);
 return {store,service,generator,get calls(){return calls;},get now(){return at;},set now(v:number){at=v;},close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(dir,{recursive:true,force:true});}};
}

test('日程按北京时间校验日期、虚构标记、三餐与不重叠时段',()=>{
 assert.equal(shanghaiDate(Date.parse('2026-10-27T16:00:00Z')),'2026-10-28');
 assert.deepEqual(validateDailyContent(content('2026-10-28'),'2026-10-28'),content('2026-10-28'));
 assert.throws(()=>validateDailyContent({...content('2026-10-28'),fictional:false},'2026-10-28'),/虚构/);
 assert.throws(()=>validateDailyContent(content('2026-10-28'),'2026-02-30'),/日期/);
 assert.throws(()=>validateDailyContent({...content('2026-10-28'),periods:[{start:'12:00',end:'10:00',activity:'读书'}]},'2026-10-28'),/时间/);
});

test('首次使用与定时并发只调用一次，当天成功状态不会在06点或新人格保存后重写',async()=>{
 let finish!:(s:string)=>void;
 const f=fixture(async user=>new Promise(resolve=>{finish=resolve;}));
 try {
  const first=f.service.ensure('worker-a'),second=f.service.ensure('worker-a');
  assert.equal(f.calls,1);assert.equal(f.service.describe('worker-a').status,'generating');
  finish(JSON.stringify(content('2026-10-28')));
  const [a,b]=await Promise.all([first,second]);assert.deepEqual(a.state,b.state);assert.equal(a.state?.revision,1);
  f.now+=3600000;await f.service.ensure('worker-a');assert.equal(f.calls,1);assert.equal(f.service.describe('worker-a').currentPeriod?.activity,'读书');
 }finally{f.close();}
});

test('暂停自动调用为零，明确手动生成允许且与其他工作账号隔离',async()=>{
 const f=fixture();try{
  f.store.set('control','paused');assert.equal((await f.service.ensure('worker-a')).status,'paused');assert.equal(f.calls,0);
  const manual=await f.service.ensure('worker-a',{manual:true});assert.equal(manual.status,'ready');assert.equal(f.calls,1);assert.equal(manual.state?.source,'manual-generation');
  assert.equal(f.service.get('worker-b'),null);assert.deepEqual(f.service.history('worker-b'),[]);
 }finally{f.close();}
});

test('失败自动生成间隔三十分钟，当天最多三次，重启保留尝试状态',async()=>{
 const f=fixture(async()=>{throw new Error('临时失败');});try{
  assert.equal((await f.service.ensure('worker-a')).status,'backoff');assert.equal(f.calls,1);
  assert.equal((await f.service.ensure('worker-a')).status,'backoff');assert.equal(f.calls,1);
  f.now+=30*60000;await f.service.ensure('worker-a');assert.equal(f.calls,2);
  f.now+=30*60000;const third=await f.service.ensure('worker-a');assert.equal(third.status,'exhausted');assert.equal(third.attempts,3);assert.equal(f.calls,3);
  const restarted=new DailyStateService(f.store,f.generator,()=>structuredClone(exampleConfig) as Config,()=>f.now);
  f.now+=30*60000;assert.equal((await restarted.ensure('worker-a')).status,'exhausted');assert.equal(f.calls,3);
 }finally{f.close();}
});

test('人工编辑提升修订，旧生成不覆盖，陈旧修订保存被拒绝',async()=>{
 let finish!:(s:string)=>void;const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));try{
  const pending=f.service.ensure('worker-a');
  const manual=f.service.edit('worker-a','2026-10-28',content('2026-10-28','开心'),0);assert.equal(manual.revision,1);
  finish(JSON.stringify(content('2026-10-28','疲惫')));assert.equal((await pending).status,'superseded');assert.equal(f.service.get('worker-a')?.content.mood,'开心');
  assert.throws(()=>f.service.edit('worker-a','2026-10-28',content('2026-10-28'),0),/已更新/);
 }finally{f.close();}
});

test('跨日无今日状态时不冒用昨日，跨日返回的旧生成结果也不写回',async()=>{
 const f=fixture();try{
  await f.service.ensure('worker-a');f.now+=86400000;
  assert.equal(f.service.describe('worker-a').today,null);assert.equal(f.service.describe('worker-a').currentPeriod,null);assert.equal(f.service.history('worker-a')[0]?.date,'2026-10-28');
  let finish!:(v:any)=>void;
  const slow:Generator={complete:async(c,system,user)=>new Promise(resolve=>{finish=resolve;})};
  const service=new DailyStateService(f.store,slow,()=>structuredClone(exampleConfig) as Config,()=>f.now);
  const pending=service.ensure('worker-a');f.now+=86400000;
  finish({text:JSON.stringify(content('2026-10-29')),input:1,output:1,cache:0});assert.equal((await pending).status,'superseded');assert.equal(service.get('worker-a'),null);assert.equal(service.get('worker-a','2026-10-29'),null);
 }finally{f.close();}
});

test('多个服务实例共享持久账号日期锁，活动调用不被第二入口重复执行',async()=>{
 let finish!:(v:string)=>void;const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));try{
  const first=f.service.ensure('worker-a');
  const other=new DailyStateService(f.store,f.generator,()=>structuredClone(exampleConfig) as Config,()=>f.now);
  assert.equal((await other.ensure('worker-a')).status,'generating');assert.equal(f.calls,1);
  finish(JSON.stringify(content('2026-10-28')));await first;
  assert.equal((await other.ensure('worker-a')).status,'ready');assert.equal(f.calls,1);
 }finally{f.close();}
});

test('生成后业务暂停不把自动结果写入当天状态，仍保留请求尝试',async()=>{
 let finish!:(v:string)=>void;const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));try{
  const pending=f.service.ensure('worker-a');f.store.set('control','paused');finish(JSON.stringify(content('2026-10-28')));
  assert.equal((await pending).status,'paused');assert.equal(f.service.get('worker-a'),null);assert.equal(f.service.describe('worker-a').attempts,1);
 }finally{f.close();}
});

test('手动强制生成校验预期修订，冲突时不产生模型调用',async()=>{
 const f=fixture();try{
  await f.service.ensure('worker-a');assert.equal(f.calls,1);
  await assert.rejects(f.service.ensure('worker-a',{manual:true,force:true,expectedRevision:0}),/已更新/);assert.equal(f.calls,1);
  const next=await f.service.ensure('worker-a',{manual:true,force:true,expectedRevision:1});assert.equal(next.state?.revision,2);assert.equal(next.state?.source,'manual-generation');assert.equal(f.calls,2);
 }finally{f.close();}
});

test('生成输入包含之前完整七日最新修订，不把第八日或他账号历史混入',async()=>{
 let input:any;
 const f=fixture(async user=>{input=JSON.parse(user);return JSON.stringify(content(input.date));});try{
  for(let day=20;day<=27;day++)f.service.edit('worker-a','2026-10-'+day,content('2026-10-'+day),0);
  f.service.edit('worker-b','2026-10-27',content('2026-10-27','另一账号'),0);
  f.service.edit('worker-a','2026-10-27',content('2026-10-27','最新修订'),1);
  await f.service.ensure('worker-a');assert.equal(input.history.length,7);assert.equal(input.history[0].date,'2026-10-27');assert.equal(input.history[0].content.mood,'最新修订');assert.equal(input.history.at(-1).date,'2026-10-21');assert.equal(input.history.some((d:any)=>d.content.mood==='另一账号'),false);
 }finally{f.close();}
});

test('任务关联标识贯穿成功与失败日程调用，失败详情保留费用回查标识',async()=>{
 const f=fixture();try{
  let observed:any;
  const linked:Generator={async complete(c,system,user,signal,session,meta){observed=meta;return {text:JSON.stringify(content(JSON.parse(user).date)),input:1,output:1,cache:0,callId:'task-call-success'};}};
  const success=new DailyStateService(f.store,linked,()=>structuredClone(exampleConfig) as Config,()=>f.now);
  const ready=await success.ensure('worker-a',{interactionId:'task-run-success'});
  assert.equal(observed.interactionId,'task-run-success');assert.equal(observed.purpose,'daily-state');assert.equal(observed.jsonObject,true);assert.equal(ready.interactionId,'task-run-success');assert.equal(ready.state?.interactionId,'task-run-success');assert.equal(ready.callId,'task-call-success');
  const failing:Generator={async complete(c,system,user,signal,session,meta){observed=meta;throw Object.assign(new Error('模型失败'),{callId:'task-call-failed'});}};
  const service=new DailyStateService(f.store,failing,()=>structuredClone(exampleConfig) as Config,()=>f.now);
  const failed=await service.ensure('worker-b',{interactionId:'task-run-failure'});
  assert.equal(observed.interactionId,'task-run-failure');assert.equal(observed.jsonObject,true);assert.equal(failed.interactionId,'task-run-failure');assert.equal(failed.callId,'task-call-failed');assert.equal(service.describe('worker-b').interactionId,'task-run-failure');assert.equal(service.describe('worker-b').callId,'task-call-failed');
  await assert.rejects(service.ensure('worker-c',{interactionId:''}),/关联标识/);
 }finally{f.close();}
});
