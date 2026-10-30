import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Workflow} from '../src/workflow.js';
import {Outbox} from '../src/outbox.js';
import {UnknownReviews} from '../src/unknown-reviews.js';
import {Program} from '../src/program.js';
import {RuntimeHealth,BrowserResourceGuard,type BrowserResourceHealth} from '../src/unattended-health.js';
import type {Transport,TransportRoundOptions} from '../src/transport.js';
import type {Config,Event,Receipt} from '../src/types.js';
import type {CollectionResult} from '../src/collection-health.js';
import {exampleConfig} from './config-fixture.js';

function fixture(mode:'draft'|'auto'='auto'){
 const directory=mkdtempSync(tmpdir()+'/role-workflow-safe-point-'),store=new Store(directory+'/workflow.sqlite'),outbox=new Outbox(store),health=new RuntimeHealth(store),program=new Program(store),config={...structuredClone(exampleConfig),mode} as Config;
 const trace:string[]=[],prepared:Array<{handle:string}&TransportRoundOptions>=[],finished:Array<{handle:string}&TransportRoundOptions>=[];let collections=0,sends=0,generations=0,lookups=0;
 const resource:BrowserResourceHealth={at:Date.now(),startedAt:Date.now(),memory:{bytes:10,limitBytes:100,ratio:.1,source:'cgroup'},lastRestartAt:null,lastRestartReason:null,restarts:0,restartError:null,businessBlocked:false};
 let publicResult:CollectionResult={events:[],warnings:[],diagnostics:[{channel:'public',status:'empty',code:'public-confirmed-empty',eventCount:0}]};
 let lookupReceipt:Receipt={status:'unknown'};
 const transport:Transport={identity:async()=>{trace.push('identity');return {handle:'worker',loggedIn:true,needsHuman:false};},control:async next=>{trace.push('control:'+next);},prepareRound:async(handle,options)=>{prepared.push({handle,...options});trace.push('prepare');return resource;},finishRound:async(handle,options)=>{finished.push({handle,...options});trace.push('finish');return resource;},collect:async()=>{throw Error('本测试要求独立通道采集');},collectPublic:async()=>{collections++;trace.push('collect-public');return publicResult;},collectPrivate:async()=>{collections++;trace.push('collect-private');return {events:[],warnings:[],diagnostics:[{channel:'private',status:'empty',code:'private-inbox-empty',eventCount:0}]};},context:async()=>{trace.push('context');return '';},send:async()=>{sends++;trace.push('send');return {status:'confirmed',id:'sent-'+sends};},lookup:async()=>{lookups++;trace.push('lookup');return lookupReceipt;}};
 const workflow=new Workflow(store,transport,{async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async()=>{generations++;trace.push('generate');return {text:JSON.stringify({action:'reply',text:'安全点后的测试回复',reason:''}),input:0,output:0,cache:0};}},()=>config);workflow.services={outbox,health,program};
 const event=(id:string,channel:'public'|'private'='public'):Event=>({id:channel==='public'?'x:'+id:'dm:1-2:'+id,platformId:id,targetId:channel==='public'?id:'1-2',channel,userId:channel==='public'?'x:alice':'dm:1-2',handle:channel==='public'?'alice':'',text:'合成入站资料',url:channel==='public'?'https://x.com/alice/status/'+id:'https://x.com/messages/1-2',conversationId:channel==='public'?id:'1-2',timestamp:Date.now(),timestampReliable:true});
 const add=(value:Event,status:string)=>{store.ingest(value,'worker');const row=store.getMessage(value.id,'worker');store.update(row.id,status,{draft:{action:'reply',text:'已经批准的固定正文',reason:''}});return store.getMessage(row.id,'worker');};
 return {store,outbox,health,program,workflow,transport,resource,trace,prepared,finished,event,add,publicEvents(events:Event[]){publicResult={events,warnings:[],diagnostics:[{channel:'public',status:events.length?'ok':'empty',code:events.length?'public-ready':'public-confirmed-empty',eventCount:events.length}]};},lookup(receipt:Receipt){lookupReceipt=receipt;},counts:()=>({collections,sends,generations,lookups}),async begin(){await workflow.resume();trace.length=0;},close(){workflow.stop();store.db.close();rmSync(directory,{recursive:true,force:true});}};
}

function scheduler(f:ReturnType<typeof fixture>,tick:()=>Promise<void>=async()=>{f.trace.push('scheduler');}){
 const value={plans:()=>({'morning-post':{enabled:false},'evening-post':{enabled:false}}),recordMainStart:()=>{f.trace.push('main-start');},recordMainEnd:()=>{f.trace.push('main-end');},tick,cancelBusiness:()=>{f.trace.push('cancel-business');},busy:false};
 f.workflow.services.scheduler=value as any;return value;
}
function latch(){let release!:()=>void;return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};}

test('prepare必须在身份确认后且全部发送/采集前，等待prepare期间不开始业务',async()=>{
 const f=fixture();let entered:()=>void=()=>{},release:()=>void=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;}),allowed=new Promise<void>(resolve=>{release=resolve;});
 try{f.add(f.event('101'),'approved');const original=f.transport.prepareRound!;f.transport.prepareRound=async(handle,options)=>{const state=await original(handle,options);f.trace.push('prepare-wait');entered();await allowed;f.trace.push('prepare-ready');return state;};await f.begin();const tick=f.workflow.tick();await started;
  assert.equal(f.trace[0],'identity');assert.equal(f.counts().sends,0);assert.equal(f.counts().collections,0);assert.equal(f.counts().generations,0);assert.equal(f.prepared[0].handle,'worker');assert.equal(f.prepared[0].unsettledOutbox,false);assert.ok(f.prepared[0].signal instanceof AbortSignal);release();await tick;
  assert.ok(f.trace.indexOf('prepare-ready')<f.trace.indexOf('send'));assert.ok(f.trace.indexOf('send')<f.trace.indexOf('collect-public'));assert.equal(f.counts().sends,1);assert.equal(f.prepared.length,1);
 }finally{release();f.close();}
});

test('未收束出站传入保护且仍能回查，blocked不采集不发送并推进实际lastTick',async()=>{
 const f=fixture();try{const incoming=f.event('201'),source=f.add(incoming,'unknown');const row=f.outbox.prepare({accountId:'worker',kind:'reply',sourceId:source.id,targetId:incoming.platformId,event:{...incoming,id:source.id,accountId:'worker'},text:'已经批准的固定正文'});f.outbox.begin(row.id);f.outbox.settle(row.id,{status:'unknown'});
  const approved=f.add(f.event('dm202','private'),'approved');f.resource.businessBlocked=true;f.lookup({status:'confirmed',id:'looked-up-201'});await f.begin();await f.workflow.tick();assert.equal(f.prepared[0].unsettledOutbox,true);assert.equal(f.counts().lookups,1);assert.equal(f.outbox.get(row.id)?.status,'confirmed');assert.equal(f.store.getMessage(source.id,'worker')?.status,'confirmed');assert.equal(f.store.getMessage(approved.id,'worker')?.status,'approved');assert.equal(f.counts().sends,0);assert.equal(f.counts().collections,0);assert.equal(f.counts().generations,0);assert.ok(f.trace.indexOf('prepare')<f.trace.indexOf('lookup'));assert.ok(f.workflow.lastTick>0);assert.equal(Number(f.store.get('lastTick')),f.workflow.lastTick);assert.equal(f.workflow.busy,false);assert.equal(f.workflow.control(),'running');
 }finally{f.close();}
});

test('blocked时排队消息保留queued，不因保护跳过、生成或另建出站',async()=>{
 const f=fixture();try{const row=f.add(f.event('301'),'queued');f.resource.businessBlocked=true;await f.begin();await f.workflow.tick();assert.equal(f.store.getMessage(row.id,'worker')?.status,'queued');assert.equal(f.counts().generations,0);assert.equal(f.counts().sends,0);assert.equal(f.counts().collections,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n,0);assert.equal(f.workflow.control(),'running');}finally{f.close();}
});

test('真实资源guard配合旧公开unknown时，新私信正常生成发送一次且旧出站不重发',async()=>{
 const f=fixture();let restarts=0,now=0;const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:1600,limitBytes:2000,ratio:.8,source:'cgroup'}),identity:async()=>({handle:'worker',loggedIn:true,needsHuman:false}),restart:async()=>{restarts++;return {handle:'worker',loggedIn:true,needsHuman:false};}});
 try{const original=f.event('801'),source=f.add(original,'unknown'),old=f.outbox.prepare({accountId:'worker',kind:'reply',sourceId:source.id,targetId:original.platformId,event:{...original,id:source.id,accountId:'worker'},text:'不可重复的旧公开回复'});f.outbox.begin(old.id);f.outbox.settle(old.id,{status:'unknown'});const target=f.add(f.event('private802','private'),'queued');
  f.transport.prepareRound=async(handle,options)=>guard.before('prepare-round','auto',handle,{safePoint:true,protectedReasons:options?.unsettledOutbox?['unsettled-outbox','chat-unlocked']:['chat-unlocked']});await f.begin();await f.workflow.tick();
  assert.equal(f.store.getMessage(target.id,'worker')?.status,'confirmed');assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,1);assert.equal(f.counts().lookups,1);assert.equal(f.outbox.get(old.id)?.status,'unknown');assert.equal(f.outbox.get(old.id)?.text,'不可重复的旧公开回复');assert.equal(restarts,0);now=31000;await f.workflow.tick();assert.equal(f.counts().sends,1);assert.equal(f.counts().generations,1);assert.equal(f.outbox.get(old.id)?.status,'unknown');assert.equal(restarts,0);
 }finally{f.close();}
});

test('真实资源guard在临界内存下仍只回查旧unknown，私信不生成也不重启会话',async()=>{
 const f=fixture();let restarts=0;const guard=new BrowserResourceGuard({readMemory:()=>({bytes:1980,limitBytes:2000,ratio:.99,source:'cgroup'}),identity:async()=>({handle:'worker',loggedIn:true,needsHuman:false}),restart:async()=>{restarts++;return {handle:'worker',loggedIn:true,needsHuman:false};}});
 try{const original=f.event('901'),source=f.add(original,'unknown'),old=f.outbox.prepare({accountId:'worker',kind:'reply',sourceId:source.id,targetId:original.platformId,event:{...original,id:source.id,accountId:'worker'},text:'临界压力下仍不可重复的旧公开回复'});f.outbox.begin(old.id);f.outbox.settle(old.id,{status:'unknown'});const target=f.add(f.event('private902','private'),'queued');
  f.transport.prepareRound=async(handle,options)=>guard.before('prepare-round','auto',handle,{safePoint:true,protectedReasons:options?.unsettledOutbox?['unsettled-outbox','chat-unlocked']:['chat-unlocked']});await f.begin();await f.workflow.tick();assert.equal(f.store.getMessage(target.id,'worker')?.status,'queued');assert.equal(f.counts().generations,0);assert.equal(f.counts().sends,0);assert.equal(f.counts().collections,0);assert.equal(f.counts().lookups,1);assert.equal(f.outbox.get(old.id)?.status,'unknown');assert.equal(restarts,0);
 }finally{f.close();}
});

test('精确人工审核旧公开unknown后新公开回复发送一次，原项仍回查且新unknown重新阻塞',async()=>{
 const f=fixture();try{
  f.store.set('activeAccount','worker');
  const original=f.event('1001'),source=f.add(original,'unknown'),old=f.outbox.prepare({accountId:'worker',kind:'reply',sourceId:source.id,targetId:original.platformId,event:{...original,id:source.id,accountId:'worker'},text:'已经批准的固定正文'});f.outbox.begin(old.id);f.outbox.settle(old.id,{status:'unknown'});
  const reviews=new UnknownReviews(f.store,()=>({accountId:'worker',control:f.workflow.control(),busy:f.workflow.busy}));
  assert.equal(f.workflow.channelWaitReason('public'),'unknown-pending');
  reviews.approve(old.id,{revision:reviews.preview(old.id).revision,confirmed:true,action:'allow-other-public-items'});
  assert.equal(f.workflow.channelWaitReason('public'),null);const target=f.add(f.event('1002'),'queued');
  await f.begin();await f.workflow.tick();assert.equal(f.store.getMessage(target.id,'worker')?.status,'confirmed');assert.equal(f.counts().sends,1);assert.equal(f.counts().generations,1);assert.equal(f.counts().lookups,1);assert.equal(f.prepared[0].unsettledOutbox,false);assert.deepEqual(f.prepared[0].reviewedUnknownOutboxIds,[old.id]);assert.equal(f.finished[0].unsettledOutbox,false);assert.deepEqual(f.finished[0].reviewedUnknownOutboxIds,[old.id]);assert.equal(f.outbox.get(old.id)?.status,'unknown');assert.equal(f.store.getMessage(source.id,'worker')?.status,'unknown');
  await f.workflow.tick();assert.equal(f.counts().sends,1);assert.equal(f.counts().generations,1);assert.equal(f.counts().lookups,2);assert.equal(f.outbox.get(old.id)?.text,'已经批准的固定正文');assert.deepEqual(f.finished[1].reviewedUnknownOutboxIds,[old.id]);
  f.add(f.event('1003'),'unknown');assert.equal(f.workflow.channelWaitReason('public'),'unknown-pending');const blocked=f.add(f.event('1004'),'queued');await f.workflow.tick();assert.equal(f.store.getMessage(blocked.id,'worker')?.status,'queued');assert.equal(f.counts().sends,1);assert.equal(f.prepared[2].unsettledOutbox,true);assert.equal(f.finished[2].unsettledOutbox,true);assert.deepEqual(f.finished[2].reviewedUnknownOutboxIds,[old.id]);
 }finally{f.close();}
});

test('prepare返回browserPaused错误则安全暂停，不进入回查后面的任何新业务',async()=>{
 const f=fixture();try{f.add(f.event('401'),'approved');f.transport.prepareRound=async()=>{f.trace.push('prepare-error');throw Object.assign(new Error('固定资源故障'),{browserPaused:true,code:'browser-resource-pressure'});};await f.begin();await assert.rejects(f.workflow.tick(),/固定资源故障/);assert.equal(f.workflow.control(),'paused');assert.ok(f.trace.includes('control:paused'));assert.equal(f.counts().collections,0);assert.equal(f.counts().sends,0);assert.equal(f.counts().generations,0);assert.equal(f.workflow.busy,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n,0);assert.ok(f.program.list().some(row=>row.status==='failed'));}finally{f.close();}
});

test('私信普通RPC失败保留已读公开消息，并记录明确私信失败而非全局崩溃',async()=>{
 const f=fixture('draft');try{const event=f.event('501');f.publicEvents([event]);f.transport.collectPrivate=async()=>{f.trace.push('private-error');throw Error('原始私信异常 https://private.invalid/?token=do-not-log');};await f.begin();await f.workflow.tick();assert.equal(f.store.getMessage(event.id,'worker')?.status,'draft');assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,0);const snapshot=f.health.get('worker');assert.equal(snapshot.metrics.find(row=>row.key==='collection-public')?.level,'normal');assert.equal(snapshot.metrics.find(row=>row.key==='collection-private')?.detail?.status,'failed');assert.equal(snapshot.metrics.find(row=>row.key==='collection-failures')?.level,'normal');assert.ok(!JSON.stringify(f.store.logs()).includes('do-not-log'));assert.equal(f.workflow.control(),'running');}finally{f.close();}
});

test('私信RPC身份/资源暂停错误仍中止整轮，不用已读public绕过安全暂停',async()=>{
 const f=fixture('draft');try{const event=f.event('601');f.publicEvents([event]);f.transport.collectPrivate=async()=>{throw Object.assign(new Error('固定浏览器暂停'),{browserPaused:true});};await f.begin();await assert.rejects(f.workflow.tick(),/固定浏览器暂停/);assert.equal(f.workflow.control(),'paused');assert.equal(f.store.getMessage(event.id,'worker'),undefined);assert.equal(f.counts().generations,0);assert.equal(f.counts().sends,0);assert.equal(f.workflow.busy,false);}finally{f.close();}
});

test('完整轮次在入库、生成发送、摘要和scheduler后finish，维护结束前保持busy',async()=>{
 const f=fixture(),entered=latch(),allowed=latch();let tick:Promise<void>|undefined;
 try{
  for(let i=0;i<5;i++)f.add(f.event(String(2000+i)),'draft');f.publicEvents([f.event('2005')]);
  f.workflow.summarize=async()=>{f.trace.push('summary');};scheduler(f);
  const begin=f.program.begin.bind(f.program);f.program.begin=(name,meta)=>{f.trace.push('stage:'+name);return begin(name,meta);};
  const finish=f.transport.finishRound!;f.transport.finishRound=async(handle,options)=>{const result=await finish(handle,options);entered.release();await allowed.promise;return result;};
  await f.begin();tick=f.workflow.tick();await entered.promise;
  const ordered=['collect-public','collect-private','stage:queue','generate','send','summary','scheduler','finish'];for(let i=1;i<ordered.length;i++)assert.ok(f.trace.indexOf(ordered[i-1])<f.trace.indexOf(ordered[i]),ordered.join(' → '));
  assert.equal(f.workflow.busy,true);assert.equal(f.finished.length,1);assert.equal(f.finished[0].handle,'worker');assert.equal(f.finished[0].timeoutMs,120000);assert.equal(f.finished[0].signal,f.workflow.abort?.signal);assert.equal(f.finished[0].unsettledOutbox,false);assert.deepEqual(f.finished[0].reviewedUnknownOutboxIds,[]);const finishStage=f.program.list().find(row=>row.name==='browser-finish');assert.equal(finishStage?.status,'running');assert.match(f.finished[0].roundId??'',/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);assert.equal(f.finished[0].roundId,finishStage?.roundId);assert.equal(f.prepared[0].roundId,undefined);
  await f.workflow.tick();assert.equal(f.finished.length,1);allowed.release();await tick;assert.equal(f.workflow.busy,false);assert.equal(f.workflow.abort,undefined);assert.equal(f.program.list().find(row=>row.name==='browser-finish')?.status,'completed');assert.equal(f.store.getMessage('x:2005','worker')?.status,'confirmed');
  assert.equal(f.workflow.control(),'running');const beforeNext=f.counts();f.publicEvents([f.event('2006')]);await f.workflow.tick();assert.equal(f.workflow.control(),'running');assert.equal(f.counts().generations,beforeNext.generations+1);assert.equal(f.counts().sends,beforeNext.sends+1);assert.equal(f.store.getMessage('x:2006','worker')?.status,'confirmed');assert.equal(f.finished.length,2);assert.notEqual(f.finished[1].roundId,f.finished[0].roundId);assert.ok(!f.trace.includes('control:auto'));
 }finally{allowed.release();await tick?.catch(()=>{});f.close();}
});

test('未运行、资源早退、硬异常、中止和缺少可选接口均不finish',async()=>{
 for(const state of ['paused','manual','blocked','failed','aborted','optional'] as const){
  const f=fixture();try{
   if(state==='paused'||state==='manual')f.store.set('control',state);
   else {await f.begin();if(state==='blocked')f.resource.businessBlocked=true;if(state==='failed')f.transport.collectPublic=async()=>{throw Error('合成轮次失败');};if(state==='aborted'){const collect=f.transport.collectPublic!;f.transport.collectPublic=async(handle,options)=>{const result=await collect(handle,options);f.workflow.abort!.abort();return result;};}if(state==='optional')delete f.transport.finishRound;}
   if(state==='failed')await assert.rejects(f.workflow.tick(),/合成轮次失败/);else await f.workflow.tick();assert.equal(f.finished.length,0,state);assert.equal(f.workflow.busy,false,state);
  }finally{f.close();}
 }
});

test('scheduler结束后重新检查generating、sending、submitting和调度在途，不提前维护',async()=>{
 for(const state of ['generating','sending','submitting','scheduler'] as const){
  const f=fixture();try{
   const tasks=scheduler(f,async()=>{f.trace.push('scheduler');if(state==='scheduler')tasks.busy=true;else if(state==='submitting'){const row=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'task-active',text:'合成在途主动帖'});assert.equal(f.outbox.begin(row.id),true);}else f.add(f.event('2101'),state);});
   await f.begin();await f.workflow.tick();assert.ok(f.trace.includes('scheduler'));assert.equal(f.finished.length,0,state);assert.equal(f.workflow.busy,false,state);tasks.busy=false;
  }finally{f.close();}
 }
});

test('scheduler等待期间并发暂停或接管先中止本轮，finish不会启动',async()=>{
 for(const action of ['pause','takeover'] as const){
  const f=fixture(),entered=latch(),allowed=latch();let tick:Promise<void>|undefined,control:Promise<void>|undefined;
  try{
   scheduler(f,async()=>{entered.release();await allowed.promise;});await f.begin();tick=f.workflow.tick();await entered.promise;control=f.workflow[action]();assert.equal(f.workflow.control(),'draining');assert.equal(f.workflow.abort?.signal.aborted,true);allowed.release();await tick;await control;assert.equal(f.finished.length,0);assert.equal(f.workflow.control(),action==='pause'?'paused':'manual');assert.equal(f.workflow.busy,false);assert.ok(!f.trace.includes('control:auto'));
  }finally{allowed.release();await tick?.catch(()=>{});await control?.catch(()=>{});f.close();}
 }
});

test('finish期间用户暂停会中止同一RPC且不恢复running，busy释放后完成暂停',async()=>{
 const f=fixture(),entered=latch();let tick:Promise<void>|undefined,control:Promise<void>|undefined;
 try{
  f.transport.finishRound=async(_handle,options)=>{f.trace.push('finish');entered.release();await new Promise<void>((_resolve,reject)=>{const abort=()=>reject(new Error('合成维护已取消'));if(options?.signal?.aborted)abort();else options?.signal?.addEventListener('abort',abort,{once:true});});return f.resource;};
  await f.begin();tick=f.workflow.tick();const rejected=assert.rejects(tick,/合成维护已取消/);await entered.promise;assert.equal(f.workflow.busy,true);control=f.workflow.pause();await rejected;await control;assert.equal(f.workflow.control(),'paused');assert.equal(f.workflow.busy,false);assert.equal(f.program.list().find(row=>row.name==='browser-finish')?.status,'aborted');assert.ok(!f.trace.includes('control:auto'));
 }finally{f.workflow.abort?.abort();await tick?.catch(()=>{});await control?.catch(()=>{});f.close();}
});

test('finish返回browserPaused错误则安全暂停，下一轮不得再生成',async()=>{
 const f=fixture();try{
  f.publicEvents([f.event('2201')]);f.transport.finishRound=async()=>{f.trace.push('finish-error');throw Object.assign(new Error('合成维护恢复失败'),{browserPaused:true});};await f.begin();await assert.rejects(f.workflow.tick(),/合成维护恢复失败/);assert.equal(f.workflow.control(),'paused');assert.equal(f.workflow.busy,false);assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,1);assert.equal(f.program.list().find(row=>row.name==='browser-finish')?.status,'failed');assert.ok(f.trace.includes('control:paused'));
  f.add(f.event('2202'),'queued');await f.workflow.tick();assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,1);assert.equal(f.trace.filter(value=>value==='finish-error').length,1);
 }finally{f.close();}
});

test('finish普通HTTP错误、超时或断连也必须暂停，结果未确认时不开始下一轮',async()=>{
 for(const failure of [new Error('合成维护HTTP404'),Object.assign(new Error('合成维护请求超时'),{name:'TimeoutError'}),Object.assign(new Error('合成维护连接已断开'),{code:'ECONNRESET'})]){
  const f=fixture();try{
   f.publicEvents([f.event('2251')]);f.transport.finishRound=async()=>{f.trace.push('finish-error');throw failure;};await f.begin();await assert.rejects(f.workflow.tick(),(error:any)=>error.browserPaused===true&&error.message===failure.message);assert.equal(f.workflow.control(),'paused');assert.equal(f.workflow.busy,false);assert.equal(f.program.list().find(row=>row.name==='browser-finish')?.status,'failed');assert.ok(f.trace.includes('control:paused'));assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,1);
   f.add(f.event('2252'),'queued');await f.workflow.tick();assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,1);assert.equal(f.trace.filter(value=>value==='finish-error').length,1);
  }finally{f.close();}
 }
});

test('finish原有browserPaused错误不得覆盖较新的暂停、接管或恢复控制',async()=>{
 for(const action of ['pause','takeover','resume'] as const){
  const f=fixture(),entered=latch(),allowed=latch();let tick:Promise<void>|undefined,control:Promise<void>|undefined;
  try{
   f.transport.finishRound=async()=>{entered.release();await allowed.promise;throw Object.assign(new Error('合成旧轮次维护失败'),{browserPaused:true});};await f.begin();tick=f.workflow.tick();const rejected=assert.rejects(tick,/合成旧轮次维护失败/);await entered.promise;control=f.workflow[action]();assert.equal(f.workflow.control(),action==='resume'?'running':'draining');allowed.release();await rejected;await control;
   assert.equal(f.workflow.control(),action==='pause'?'paused':action==='takeover'?'manual':'running');assert.equal(f.workflow.busy,false);assert.equal(f.store.logs().some(row=>row.event==='safety-pause'),false);assert.equal(f.trace.filter(value=>value==='control:auto').length,action==='resume'?1:0);
  }finally{allowed.release();await tick?.catch(()=>{});await control?.catch(()=>{});f.close();}
 }
});

test('finish每次重算新unknown保护，不沿用轮首快照且不改未知记录',async()=>{
 const f=fixture();try{
  const collect=f.transport.collectPrivate!;let unknownId='';f.transport.collectPrivate=async(handle,options)=>{const result=await collect(handle,options);unknownId=f.add(f.event('2301'),'unknown').id;return result;};await f.begin();await f.workflow.tick();assert.equal(f.prepared[0].unsettledOutbox,false);assert.equal(f.finished[0].unsettledOutbox,true);assert.deepEqual(f.finished[0].reviewedUnknownOutboxIds,[]);assert.equal(f.store.getMessage(unknownId,'worker')?.status,'unknown');assert.equal(f.counts().sends,0);
 }finally{f.close();}
});

test('个别消息生成失败已收束且正常走完轮次时，允许轮末维护',async()=>{
 const f=fixture();try{
  const target=f.add(f.event('2401'),'queued');f.workflow.generator.complete=async()=>{throw Error('合成单条生成失败');};await f.begin();await f.workflow.tick();assert.equal(f.store.getMessage(target.id,'worker')?.status,'failed');assert.equal(f.finished.length,1);assert.equal(f.finished[0].unsettledOutbox,false);assert.equal(f.workflow.busy,false);
 }finally{f.close();}
});
