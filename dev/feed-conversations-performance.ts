/** 仅在服务器执行；自建临时库，不读取生产数据。 */
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';
import { TaskScheduler } from '../src/scheduler.js';
import { ReplyTriage } from '../src/reply-triage.js';
import { ActivityFeed } from '../src/activity-feed.js';
import {replyWindow,type ReplyAgeSource} from '../src/reply-hours.js';

if(process.env.ALLOW_ISOLATED_PERF!=='1')throw new Error('请只在服务器隔离环境设置 ALLOW_ISOLATED_PERF=1 执行');
const ageMode=process.env.FEED_PERF_AGE_MODE??'plain';if(!['plain','default','history'].includes(ageMode))throw new Error('FEED_PERF_AGE_MODE 只能是 plain、default 或 history');
const historyDays=Number(process.env.FEED_PERF_HISTORY_DAYS??30);if(!Number.isInteger(historyDays)||historyDays<1||historyDays>5000)throw new Error('历史终态样本天数应为1至5000');
const dir=mkdtempSync(tmpdir()+'/feed-conversation-perf-'),store=new Store(dir+'/workflow.sqlite'),at=Date.now();
try{
 new Outbox(store);new TaskScheduler(store,{account:()=> 'worker',control:()=> 'paused',execute:async()=>{}});
 if(ageMode==='history'){
  // 这些是自建临时库里的真实任务表样本；source每次与生产一样批量只读终态。
  const base=Math.floor((at+8*3600000)/86400000)*86400000-8*3600000,insertRun=store.db.prepare("INSERT INTO task_runs(id,task_id,account_id,scheduled_at,source,status,started_at,finished_at,detail) VALUES(?,'morning-post','worker',?,'automatic','completed',?,?,'隔离性能早安终态')");
  store.db.exec('BEGIN IMMEDIATE');for(let i=1;i<=historyDays;i++){const scheduledAt=base-i*86400000+8*3600000;insertRun.run('history-morning-'+i,scheduledAt,scheduledAt,scheduledAt+(2+i%3)*60000);}store.db.exec('COMMIT');
 }
 const ageSource=():ReplyAgeSource=>{
  if(ageMode==='plain')return [];
  const morningRunEnds=ageMode==='history'?(store.db.prepare("SELECT scheduled_at,COALESCE(finished_at,started_at) ended_at FROM task_runs WHERE account_id='worker' AND task_id='morning-post' AND status<>'running'").all() as {scheduled_at:number;ended_at:number}[]).map(r=>({scheduledAt:r.scheduled_at,endedAt:r.ended_at})):[];
  const window=replyWindow({now:at,enabled:true,closeDelayMinutes:30,morning:{enabled:ageMode==='history',time:'08:00'},eveningTime:'23:00',morningRunEnds});return window.agePolicy??window.closures;
 };
 const triage=new ReplyTriage(store,undefined,Date.now,ageSource),feed=new ActivityFeed(store,()=> 'worker',()=>6,undefined,triage);
 const insert=store.db.prepare('INSERT INTO messages(id,account_id,source_id,platform_id,target_id,channel,user_id,body,status,draft,created_at,updated_at,ingested_at,tier,tier_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
 store.db.exec('BEGIN IMMEDIATE');
 for(let i=0;i<10000;i++){
  const id=String(10000000+i),user='x:user'+(i%1000),timestamp=at-10000+i,body={id:'x:'+id,platformId:id,accountId:'worker',channel:'public',userId:user,handle:user.slice(2),text:'性能验证原话 '+i,timestamp,timestampReliable:true,conversationId:id};
  insert.run('row-'+id,'worker','x:'+id,id,'','public',user,JSON.stringify(body),i%5===0?'draft':'confirmed',JSON.stringify({action:'reply',text:'性能验证回复 '+i,reason:''}),timestamp,timestamp,timestamp,i%7===0?'priority':'normal','性能夹具');
 }
 store.db.exec('COMMIT');
 const trialIndex=process.env.FEED_PERF_TRIAL_INDEX==='1';
 if(trialIndex)store.db.exec('CREATE INDEX messages_conversation_trial ON messages(account_id,user_id,created_at)');
 const plan=feed.conversationQueryPlan();
 // 首次查询与后续五次分别记录；不是清空操作系统页缓存后的磁盘冷启动。
 const measure=(query:{changedSince?:number}={})=>{
  let begin=performance.now();const first=feed.conversations({limit:30,...query}),coldMs=performance.now()-begin,samples:number[]=[];
  for(let i=0;i<5;i++){begin=performance.now();feed.conversations({limit:30,...query});samples.push(performance.now()-begin);}
  const sorted=[...samples].sort((a,b)=>a-b);return {pageSize:first.items.length,pending:first.pending,serverTime:first.serverTime,coldMs,samplesMs:samples,medianMs:sorted[2],maxMs:Math.max(...samples)};
 };
 const controlledIncrement=()=>{
  const since=Date.now()-1,changedAt=since+1;
  // 100条不同身份的消息变更，保留所有当前／历史数据，不用空增量冒充刷新成本。
  const updatedRows=Number(store.db.prepare("UPDATE messages SET status=CASE status WHEN 'draft' THEN 'confirmed' ELSE 'draft' END,updated_at=? WHERE rowid<=100").run(changedAt).changes);
  const measured=measure({changedSince:since});if(measured.pageSize<100)throw new Error('性能增量夹具没有返回全部一百个变化身份');return {...measured,changedSince:since,updatedRows};
 };
 const current={currentRows:10000,historicalRows:0,historicalDraftRows:0,full:measure(),incremental:controlledIncrement()};
 // 与当前消息组保持相同总量、身份数及20%草稿比例，仅把20%的原话和入库时间移入真实历史范围。
 store.db.exec("UPDATE messages SET status=CASE WHEN CAST(platform_id AS INTEGER)%5=0 THEN 'draft' ELSE 'confirmed' END,updated_at=ingested_at");
 const base=Math.floor((at+8*3600000)/86400000)*86400000-8*3600000,updateHistory=store.db.prepare('UPDATE messages SET body=?,created_at=?,updated_at=?,ingested_at=? WHERE id=?');
 store.db.exec('BEGIN IMMEDIATE');
 for(let i=0;i<2000;i++){
  const id=String(10000000+i),user='x:user'+(i%1000),timestamp=base-(1+i%historyDays)*86400000+8*3600000+(i%2?10:1)*60000;
  const body={id:'x:'+id,platformId:id,accountId:'worker',channel:'public',userId:user,handle:user.slice(2),text:'性能验证历史原话 '+i,timestamp,timestampReliable:true,conversationId:id};
  updateHistory.run(JSON.stringify(body),timestamp,timestamp,timestamp,'row-'+id);
 }
 store.db.exec('COMMIT');
 const mixed={currentRows:8000,historicalRows:2000,historicalDraftRows:400,historicalDays:historyDays,full:measure(),incremental:controlledIncrement()};
 const tables=store.db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
 process.stdout.write(JSON.stringify({rows:10000,identities:1000,ageMode,morningEnabled:ageMode==='history',historySamples:ageMode==='history'?historyDays:0,ageSqlParams:triage.ageSql().params.length,...current.full,current,mixed,goalMs:100,indexAdded:false,trialIndex,schemaMigrationAdded:false,queryPlan:plan,migrations:tables},null,2)+'\n');
}finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
