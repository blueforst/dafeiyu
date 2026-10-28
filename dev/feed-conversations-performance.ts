/** 仅在服务器执行；自建临时库，不读取生产数据。 */
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';
import { TaskScheduler } from '../src/scheduler.js';
import { ReplyTriage } from '../src/reply-triage.js';
import { ActivityFeed } from '../src/activity-feed.js';

if(process.env.ALLOW_ISOLATED_PERF!=='1')throw new Error('请只在服务器隔离环境设置 ALLOW_ISOLATED_PERF=1 执行');
const dir=mkdtempSync(tmpdir()+'/feed-conversation-perf-'),store=new Store(dir+'/workflow.sqlite'),at=Date.now();
try{
 new Outbox(store);new TaskScheduler(store,{account:()=> 'worker',control:()=> 'paused',execute:async()=>{}});
 const triage=new ReplyTriage(store),feed=new ActivityFeed(store,()=> 'worker',()=>6,undefined,triage);
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
 // 首次读取单独记录，随后五次分别计时，不把热身结果混成冷读。
 let begin=performance.now();const first=feed.conversations({limit:30});const coldMs=performance.now()-begin,samples:number[]=[];
 for(let i=0;i<5;i++){begin=performance.now();feed.conversations({limit:30});samples.push(performance.now()-begin);}
 const sorted=[...samples].sort((a,b)=>a-b),tables=store.db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
 process.stdout.write(JSON.stringify({rows:10000,identities:1000,pageSize:first.items.length,coldMs,samplesMs:samples,medianMs:sorted[2],maxMs:Math.max(...samples),goalMs:100,indexAdded:false,trialIndex,schemaMigrationAdded:false,queryPlan:plan,migrations:tables},null,2)+'\n');
}finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
