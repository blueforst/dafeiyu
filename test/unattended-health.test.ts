import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {Store} from '../src/store.js';
import {LlmStore} from '../src/llm-store.js';
import {TaskScheduler,plannedAt} from '../src/scheduler.js';
import {RuntimeHealth,RoundBudget,WorkflowWatchdog,BrowserResourceGuard,readBrowserMemory,detectAccountRestriction,classifyPlatformRejection,assessCompliance,healthSettings} from '../src/unattended-health.js';
import {registerHealthRoutes} from '../src/health-routes.js';
import {Serial} from '../src/browser.js';

function fixture(){const root=mkdtempSync(tmpdir()+'/role-health-'),store=new Store(root+'/workflow.sqlite');let now=Date.parse('2026-10-28T11:00:00+08:00');const health=new RuntimeHealth(store,()=>now);return {store,health,at:(value:number)=>{now=value;},get now(){return now;},close(){store.db.close();rmSync(root,{recursive:true,force:true});}};}
function message(f:ReturnType<typeof fixture>,id:string,channel:'public'|'private'='public'){f.store.ingest({id,channel,userId:'alice',handle:'alice',text:'含有私密正文',url:'https://x.com/alice/status/'+id,conversationId:id,timestamp:f.now-30*60000,timestampReliable:true,platformId:id},'worker');}

test('健康设置有界，轮次软超时保留排队，硬超时仅中止现有controller',()=>{
 let now=1000;const abort=new AbortController(),budget=new RoundBudget(abort,{},()=>now);
 try{assert.equal(budget.softExpired,false);now=1000+8*60000;assert.equal(budget.check(),false);assert.equal(abort.signal.aborted,false);now=1000+12*60000;assert.equal(budget.check(),false);assert.equal(abort.signal.aborted,true);assert.throws(()=>healthSettings({softTimeoutMinutes:12,hardTimeoutMinutes:13}),/至少多两分钟/);assert.throws(()=>healthSettings({memoryRatio:1}),/范围无效/);}finally{budget.dispose();}
});

test('看门狗恢复丢失定时器且不会并发；连续两次失败后安全暂停',async()=>{
 let now=100000,paused=0,restores=0;const state={control:'running',busy:false,startedAt:0,nextTick:0};let release:(()=>void)|undefined;
 const watchdog=new WorkflowWatchdog({snapshot:()=>state,clock:()=>now,restoreSchedule:async()=>{restores++;await new Promise<void>(resolve=>{release=resolve;});},abortCurrent:()=>{},safetyPause:()=>{paused++;}});
 const first=watchdog.check();await Promise.resolve();await watchdog.check();assert.equal(restores,1);release!();await first;
 now+=30000;const second=watchdog.check();await Promise.resolve();release!();await second;assert.equal(restores,2);now+=30000;await watchdog.check();assert.equal(paused,1);
});

test('看门狗对超时忙轮次只请求中止，不另起并发轮次',async()=>{
 let now=1000000,aborts=0,restores=0;const state={control:'running',busy:true,startedAt:1,nextTick:0};const watchdog=new WorkflowWatchdog({snapshot:()=>state,clock:()=>now,abortCurrent:()=>{aborts++;},restoreSchedule:()=>{restores++;state.nextTick=now+1000;},safetyPause:()=>{}});
 await watchdog.check();assert.equal(aborts,1);assert.equal(restores,0);state.busy=false;await watchdog.check();assert.equal(restores,1);
});

test('停滞只计可发送队列，暂停/空队列/额度满/退避/unknown均不误报',()=>{
 const f=fixture();try{
  const input={accountId:'worker',control:'running',mode:'auto',sendableChannels:{public:true,private:true}};
  assert.equal(f.health.evaluate(input).metrics.find(m=>m.key==='send-stall')?.level,'normal');message(f,'1');
  assert.equal(f.health.evaluate(input).metrics.find(m=>m.key==='send-stall')?.level,'error');
  assert.equal(f.health.evaluate({...input,control:'paused'}).metrics.find(m=>m.key==='send-stall')?.level,'normal');
  assert.equal(f.health.evaluate({...input,sendableChannels:{public:false,private:true}}).metrics.find(m=>m.key==='send-stall')?.level,'normal');
  assert.equal(f.health.evaluate({...input,sendableChannels:undefined,cooldown:{public:f.now+1}}).metrics.find(m=>m.key==='send-stall')?.level,'normal');
  f.store.update('1','unknown',{},'worker');assert.equal(f.health.evaluate({...input,sendableChannels:undefined}).metrics.find(m=>m.key==='send-stall')?.level,'normal');
 }finally{f.close();}
});

test('告警按账号去重和恢复，自动化拦截三次告警与普通额度分开',()=>{
 const f=fixture();try{
  message(f,'1');const input={accountId:'worker',control:'running',mode:'auto',sendableChannels:{public:true}};
  const first=f.health.evaluate(input).activeAlerts.find(a=>a.key==='send-stall')!;f.at(f.now+1000);assert.equal(f.health.evaluate(input).activeAlerts.find(a=>a.key==='send-stall')?.id,first.id);
  const stamp=f.now;f.health.evaluate({...input,control:'paused'});assert.equal(f.health.activeAlerts('worker').length,0);assert.equal(f.health.alerts('worker').items[0].resolvedAt,stamp);
  for(let i=0;i<3;i++)f.store.db.prepare('INSERT INTO logs(at,level,event,detail) VALUES(?,?,?,?)').run(f.now,'warn','automation-block',JSON.stringify({accountId:'worker',channel:'public'}));
  assert.equal(f.health.evaluate({...input,control:'paused',publicPerHour:10,publicPerDay:180}).metrics.find(m=>m.key==='automation-public')?.level,'error');
  assert.equal(f.health.activeAlerts('other').length,0);assert.ok(!JSON.stringify(f.health.get('worker')).includes('含有私密正文'));
 }finally{f.close();}
});

test('账号检查缺少或损坏的开关状态不能冒充已关闭或明确缺失',()=>{
 for(const value of [undefined,'false',0,{},[]]){
  const result=assessCompliance({accountId:'worker',profileReliable:false,automatedLabel:value,qualityFilter:value} as any,['AI'],123);
  assert.equal(result.automatedLabel,'unknown');assert.equal(result.qualityFilter,'unknown');assert.equal(result.disclosure,'unknown');
  const unreliable=assessCompliance({accountId:'worker',profileReliable:value,name:'AI 角色',bio:'AI 自动回复',automatedLabel:null,qualityFilter:null} as any,['AI'],123);
  assert.equal(unreliable.disclosure,'unknown');assert.deepEqual(unreliable.missingPhrases,[]);
 }
 assert.equal(assessCompliance({accountId:'worker',profileReliable:true,name:'AI 角色',automatedLabel:null,qualityFilter:null},['AI'],123).disclosure,'unknown');
 const known=assessCompliance({accountId:'worker',profileReliable:true,name:'AI 角色',bio:'AI 自动回复',automatedLabel:false,qualityFilter:false},['AI'],123);
 assert.equal(known.automatedLabel,'missing');assert.equal(known.qualityFilter,'off');assert.equal(known.disclosure,'confirmed');
});

test('cgroup与进程树RSS读取保持只读，无法确认时返回unknown',()=>{
 const files:Record<string,string>={'/cg/memory.current':'800','/cg/memory.max':'1000'};
 assert.equal(readBrowserMemory({cgroupRoot:'/cg',read:p=>{if(!(p in files))throw Error();return files[p];}}).ratio,.8);
 const proc:Record<string,string>={'/p/10/status':'Name:\tcamoufox\nPPid:\t1\nVmRSS:\t100 kB','/p/11/status':'Name:\tchild\nPPid:\t10\nVmRSS:\t50 kB','/p/12/status':'Name:\tother\nPPid:\t1\nVmRSS:\t900 kB'};
 const rss=readBrowserMemory({cgroupRoot:'/missing',procRoot:'/p',read:p=>{if(!(p in proc))throw Error();return proc[p];},list:()=>['10','11','12'],fallbackLimitBytes:300*1024});assert.equal(rss.bytes,150*1024);assert.equal(rss.ratio,.5);
 assert.equal(readBrowserMemory({read:()=>{throw Error();},list:()=>[]}).source,'unavailable');
});

test('资源恢复只在操作之间，manual及send/lookup保护；重启身份变化明确失败',async()=>{
 let now=1,restarts=0;const logged={handle:'worker',loggedIn:true,needsHuman:false};const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:800,limitBytes:1000,ratio:.8,source:'cgroup'}),identity:async()=>logged,restart:async stage=>{stage?.('close-context');restarts++;return logged;}});
 for(const operation of ['send','post','lookup','lookupPost'])await guard.before(operation,'auto','worker');await guard.before('collect/public','manual','worker');assert.equal(restarts,0);await guard.before('collect/public','auto','worker');assert.equal(restarts,0);now+=31000;await guard.before('prepare-round','auto','worker',{safePoint:true});assert.equal(restarts,0);await guard.before('finish-round','auto','worker',{safePoint:true});assert.equal(restarts,1);assert.equal(guard.snapshot().lastRestartReason,'memory-threshold');
 const bad=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:800,limitBytes:1000,ratio:.8,source:'cgroup'}),identity:async()=>logged,restart:async stage=>{stage?.('close-context');return {...logged,handle:'other'};}});await bad.before('prepare-round','auto','worker',{safePoint:true});now+=31000;await bad.before('prepare-round','auto','worker',{safePoint:true});assert.equal(bad.snapshot().restarts,0);await assert.rejects(bad.before('finish-round','auto','worker',{safePoint:true}),/资源恢复失败/);assert.ok(bad.snapshot().restartError);
});

test('受限判定绑定自身账号，未知页面和其他用户提示不误认；合规不存资料正文',()=>{
 assert.equal(detectAccountRestriction({url:'https://x.com/home',ownAccount:true,text:'Your account is suspended'}),'suspended');
 assert.equal(detectAccountRestriction({url:'https://x.com/other',ownAccount:false,text:'Your account is suspended'}),undefined);
 assert.equal(detectAccountRestriction({url:'https://x.com/account/access',ownAccount:false,text:''}),'locked');
 assert.equal(detectAccountRestriction({url:'https://example.com/account/access',ownAccount:false,text:''}),undefined);
 assert.equal(classifyPlatformRejection('This request looks like it might be automated'),'automation');assert.equal(classifyPlatformRejection('daily post limit'),'quota');
 const result=assessCompliance({accountId:'worker',profileReliable:true,name:'AI角色',bio:'机密简介',automatedLabel:false,qualityFilter:true},['AI']);assert.equal(result.disclosure,'confirmed');assert.equal(result.automatedLabel,'missing');assert.equal(result.qualityFilter,'on');assert.ok(!JSON.stringify(result).includes('机密简介'));
 assert.equal(assessCompliance({accountId:'worker',profileReliable:false,automatedLabel:null,qualityFilter:null}).disclosure,'unknown');
});

test('账号检查诊断只用于本次DOM排查，不进入公共合规结果、持久记录或日志',()=>{
 const f=fixture();try{
  const sample={stable:false,sampleCount:2,readAttempts:3,sampledAt:Date.parse('2026-10-28T13:10:00+08:00')};
  const diagnostics={profile:{...sample,mainCount:1,nameCount:0,handleCount:0,editCount:0,bioCount:0,locationMatches:true,handleMatches:false,expectedHandleMatches:false,detailsComplete:false,loading:true,failed:false},filters:{...sample,mainCount:1,visibleEntryCount:0,locationMatches:true,loading:true,failed:false},quality:{...sample,mainCount:1,matchedControlCount:0,associationValidCount:0,nativeStateCount:0,ariaStateCount:0,locationMatches:true,loading:true,failed:false}};
  const result=f.health.saveCompliance({accountId:'worker',profileReliable:false,automatedLabel:null,qualityFilter:null,diagnostics});
  assert.equal(Object.hasOwn(result,'diagnostics'),false);assert.equal(result.disclosure,'unknown');assert.equal(result.automatedLabel,'unknown');assert.equal(result.qualityFilter,'unknown');
  for(const serialized of [JSON.stringify(result),f.store.get('health:compliance:worker'),JSON.stringify(f.store.logs())])assert.doesNotMatch(serialized,/sampleCount|sampledAt|expectedHandleMatches|matchedControlCount/);
 }finally{f.close();}
});

test('日报09点补一次，全天暂停及未知usage保持可见，不调用模型且不含正文',()=>{
 const f=fixture();try{
  f.at(Date.parse('2026-10-27T12:00:00+08:00'));message(f,'1');f.store.update('1','filtered',{},'worker');
  f.store.db.prepare('UPDATE messages SET updated_at=? WHERE source_id=?').run(f.now,'1');
  const llm=new LlmStore(f.store),id=llm.start({provider:'custom',id:'mock'},{accountId:'worker'},f.now);llm.finish(id,'completed',{usage:{input:10,output:5,cacheRead:20,cacheWrite:0,totalTokens:35},pricingStatus:'unpriced'},f.now+1);
  f.at(Date.parse('2026-10-28T08:59:59+08:00'));assert.equal(f.health.catchUpReport('worker'),null);f.at(Date.parse('2026-10-28T11:00:00+08:00'));const report=f.health.catchUpReport('worker') as any;
  assert.equal(report.date,'2026-10-27');assert.equal(report.pausedMs,86400000);assert.equal(report.channels.public.filtered,1);assert.equal(report.model.cacheReadRatio,2/3);assert.equal(report.model.costUSD,null);assert.equal(report.model.unpriced,1);assert.ok(!JSON.stringify(report).includes('含有私密正文'));assert.deepEqual(f.health.catchUpReport('worker'),report);
  new RuntimeHealth(f.store);assert.equal(f.health.reports('worker').length,1);
 }finally{f.close();}
});

test('日报任务暂停仍补生成，合规任务暂停不自动运行，手动检查不恢复控制',async()=>{
 const f=fixture();let control='paused',checks=0;const old=process.env.DATA_DIR;const dir=mkdtempSync(tmpdir()+'/role-health-settings-');process.env.DATA_DIR=dir;
 try{
  const scheduler=new TaskScheduler(f.store,{account:()=>'',control:()=>control,clock:()=>f.now,execute:async()=>{throw Error('不得调用业务模型');},observe:async(id)=>{if(id==='daily-report'){f.health.catchUpReport('');return {status:'completed'};}checks++;return {status:'completed'};}});
  await scheduler.tickObservability();await scheduler.tickObservability();assert.equal(f.health.reports('').length,1);assert.equal(checks,0);assert.equal(control,'paused');
  assert.equal(scheduler.list().tasks.find(t=>t.id==='daily-report')?.time,'09:00');assert.equal(scheduler.list().tasks.find(t=>t.id==='account-check')?.time,'10:00');
 }finally{f.close();if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});}
});

test('健康GET只读缓存，无浏览器/模型副作用；告警和日报查询账号隔离',async()=>{
 const f=fixture(),app=Fastify();try{registerHealthRoutes(app,{health:f.health,accountId:()=> 'worker'});f.health.evaluate({accountId:'worker',control:'paused',mode:'draft'});const before=f.store.logs().length;const response=await app.inject('/api/health');assert.equal(response.statusCode,200);assert.equal(response.json().accountId,'worker');assert.equal(f.store.logs().length,before);assert.equal((await app.inject('/api/health/reports/not-a-date')).statusCode,400);}finally{await app.close();f.close();}
});

test('串行操作超时先返回，旧操作未释放前下一项不能并发',async()=>{
 const serial=new Serial();let release:()=>void=()=>{},started=false,timedOut=0;
 const first=serial.run(async()=>{await new Promise<void>(r=>{release=r;});},{timeoutMs:5,onTimeout:()=>{timedOut++;}});
 const second=serial.run(async()=>{started=true;});await assert.rejects(first,/时间上限/);assert.equal(timedOut,1);assert.equal(started,false);release();await second;assert.equal(started,true);
});

test('健康设置保存受域修订和边界约束，保存不产生业务控制或浏览器调用',async()=>{
 const f=fixture(),app=Fastify(),old=process.env.DATA_DIR;const dir=mkdtempSync(tmpdir()+'/role-health-api-');process.env.DATA_DIR=dir;
 try{registerHealthRoutes(app,{health:f.health,accountId:()=> 'worker'});const initial=(await app.inject('/api/health/settings')).json();assert.equal(initial.revision,0);assert.deepEqual(initial.settings.requiredPhrases,['AI']);
  const saved=await app.inject({method:'PUT',url:'/api/health/settings',payload:{revision:0,requiredPhrases:['AI','非官方'],memoryRatio:.8}});assert.equal(saved.statusCode,200);assert.equal(saved.json().revision,1);
  assert.equal((await app.inject({method:'PUT',url:'/api/health/settings',payload:{revision:0,requiredPhrases:['AI']}})).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:'/api/health/settings',payload:{revision:1,runCommand:'touch /tmp/no'}})).statusCode,400);
  assert.equal((await app.inject('/api/health/reports?limit=abc')).statusCode,400);assert.equal((await app.inject('/api/health/alerts?limit=0')).statusCode,400);
  assert.equal(f.store.get('control','paused'),'paused');assert.equal(f.store.logs().length,0);
 }finally{await app.close();f.close();if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});}
});

test('回复时段关闭覆盖可发送输入，开放后停滞从实际开放点起算',()=>{
 const f=fixture();try{
  message(f,'hours');const base={accountId:'worker',control:'running',mode:'auto',sendableChannels:{public:true},replyHours:{open:false,reason:'reply-hours-closed',opensAt:f.now+3600000,closeTime:'23:30',openTime:'08:00',closures:[]}} as any;
  const closed=f.health.evaluate(base);assert.equal(closed.metrics.find(m=>m.key==='send-stall')?.level,'normal');assert.equal(closed.metrics.find(m=>m.key==='reply-hours')?.level,'normal');assert.match(closed.metrics.find(m=>m.key==='reply-hours')?.summary??'',/回复时段已关闭/);
  const openedAt=f.now-19*60000;assert.equal(f.health.evaluate({...base,replyHours:{...base.replyHours,open:true,reason:null,openedAt}}).metrics.find(m=>m.key==='send-stall')?.level,'normal');
  f.at(f.now+60000);assert.equal(f.health.evaluate({...base,replyHours:{...base.replyHours,open:true,reason:null,openedAt}}).metrics.find(m=>m.key==='send-stall')?.level,'error');
 }finally{f.close();}
});

test('私信滚动额度满时健康回退不判停滞，拒绝记录不占二十四小时额度',()=>{
 const f=fixture();try{
  f.store.db.exec('CREATE TABLE outbox(id TEXT PRIMARY KEY,account_id TEXT,channel TEXT,kind TEXT,source_id TEXT,status TEXT,submitted_at INTEGER,updated_at INTEGER)');
  message(f,'quota-private','private');const insert=f.store.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?)');
  for(let i=0;i<400;i++)insert.run('daily-'+i,'worker','private','dm','history-'+i,'confirmed',f.now-2*3600000,f.now-2*3600000);
  const input={accountId:'worker',control:'running',mode:'auto',privatePerHour:30,privatePerDay:400};
  assert.equal(f.health.evaluate(input).metrics.find(m=>m.key==='send-stall')?.level,'normal');
  f.store.db.prepare("UPDATE outbox SET status='rejected' WHERE id='daily-0'").run();assert.equal(f.health.evaluate(input).metrics.find(m=>m.key==='send-stall')?.level,'error');
  for(let i=0;i<3;i++)f.health.recordAutomationBlock('worker','private');
  const warning=f.health.evaluate({...input,control:'paused'}).metrics.find(m=>m.key==='automation-private')?.summary??'';assert.match(warning,/最近 24 小时 400/);assert.doesNotMatch(warning,/未设置/);
 }finally{f.close();}
});

test('日报延迟扣除回复关闭时长，时段查询只用只读输入',()=>{
 const f=fixture();try{
  const received=Date.parse('2026-10-28T02:00:00+08:00'),sent=Date.parse('2026-10-28T08:05:00+08:00');f.at(sent);
  f.store.ingest({id:'night',channel:'public',userId:'alice',handle:'alice',text:'日报不得保存的正文',url:'https://x.com/alice/status/night',conversationId:'night',timestamp:received,timestampReliable:true,platformId:'night'},'worker');
  const row=f.store.db.prepare("SELECT id FROM messages WHERE account_id='worker'").get() as any;f.store.update(row.id,'confirmed',{},'worker');f.store.db.prepare('UPDATE messages SET updated_at=? WHERE id=?').run(sent,row.id);
  let reads=0;const health=new RuntimeHealth(f.store,()=>f.now,()=>{reads++;return {open:true,reason:null,closeTime:'23:30',openTime:'08:00',closures:[{start:Date.parse('2026-10-27T23:30:00+08:00'),end:Date.parse('2026-10-28T08:00:00+08:00')}]};});
  const report=health.generateReport('2026-10-28','worker') as any;assert.equal(report.responseLatencyMs.samples,1);assert.equal(report.responseLatencyMs.median,5*60000);assert.equal(reads,1);assert.doesNotMatch(JSON.stringify(report),/日报不得保存的正文/);
 }finally{f.close();}
});
