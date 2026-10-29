import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Workflow} from '../src/workflow.js';
import {Outbox} from '../src/outbox.js';
import {Program} from '../src/program.js';
import {RuntimeHealth,type BrowserResourceHealth} from '../src/unattended-health.js';
import type {Transport} from '../src/transport.js';
import type {Config,Event,Receipt} from '../src/types.js';
import type {CollectionResult} from '../src/collection-health.js';
import {exampleConfig} from './config-fixture.js';

function fixture(mode:'draft'|'auto'='auto'){
 const directory=mkdtempSync(tmpdir()+'/role-workflow-safe-point-'),store=new Store(directory+'/workflow.sqlite'),outbox=new Outbox(store),health=new RuntimeHealth(store),program=new Program(store),config={...structuredClone(exampleConfig),mode} as Config;
 const trace:string[]=[],prepared:Array<{handle:string;unsettledOutbox?:boolean;signal?:AbortSignal}>=[];let collections=0,sends=0,generations=0,lookups=0;
 const resource:BrowserResourceHealth={at:Date.now(),startedAt:Date.now(),memory:{bytes:10,limitBytes:100,ratio:.1,source:'cgroup'},lastRestartAt:null,lastRestartReason:null,restarts:0,restartError:null,businessBlocked:false};
 let publicResult:CollectionResult={events:[],warnings:[],diagnostics:[{channel:'public',status:'empty',code:'public-confirmed-empty',eventCount:0}]};
 let lookupReceipt:Receipt={status:'unknown'};
 const transport:Transport={identity:async()=>{trace.push('identity');return {handle:'worker',loggedIn:true,needsHuman:false};},control:async next=>{trace.push('control:'+next);},prepareRound:async(handle,options)=>{prepared.push({handle,unsettledOutbox:options?.unsettledOutbox,signal:options?.signal});trace.push('prepare');return resource;},collect:async()=>{throw Error('本测试要求独立通道采集');},collectPublic:async()=>{collections++;trace.push('collect-public');return publicResult;},collectPrivate:async()=>{collections++;trace.push('collect-private');return {events:[],warnings:[],diagnostics:[{channel:'private',status:'empty',code:'private-inbox-empty',eventCount:0}]};},context:async()=>{trace.push('context');return '';},send:async()=>{sends++;trace.push('send');return {status:'confirmed',id:'sent-'+sends};},lookup:async()=>{lookups++;trace.push('lookup');return lookupReceipt;}};
 const workflow=new Workflow(store,transport,{async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async()=>{generations++;trace.push('generate');return {text:JSON.stringify({action:'reply',text:'安全点后的测试回复',reason:''}),input:0,output:0,cache:0};}},()=>config);workflow.services={outbox,health,program};
 const event=(id:string,channel:'public'|'private'='public'):Event=>({id:channel==='public'?'x:'+id:'dm:1-2:'+id,platformId:id,targetId:channel==='public'?id:'1-2',channel,userId:channel==='public'?'x:alice':'dm:1-2',handle:channel==='public'?'alice':'',text:'合成入站资料',url:channel==='public'?'https://x.com/alice/status/'+id:'https://x.com/messages/1-2',conversationId:channel==='public'?id:'1-2',timestamp:Date.now(),timestampReliable:true});
 const add=(value:Event,status:string)=>{store.ingest(value,'worker');const row=store.getMessage(value.id,'worker');store.update(row.id,status,{draft:{action:'reply',text:'已经批准的固定正文',reason:''}});return store.getMessage(row.id,'worker');};
 return {store,outbox,health,program,workflow,transport,resource,trace,prepared,event,add,publicEvents(events:Event[]){publicResult={events,warnings:[],diagnostics:[{channel:'public',status:events.length?'ok':'empty',code:events.length?'public-ready':'public-confirmed-empty',eventCount:events.length}]};},lookup(receipt:Receipt){lookupReceipt=receipt;},counts:()=>({collections,sends,generations,lookups}),async begin(){await workflow.resume();trace.length=0;},close(){workflow.stop();store.db.close();rmSync(directory,{recursive:true,force:true});}};
}

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

test('prepare返回browserPaused错误则安全暂停，不进入回查后面的任何新业务',async()=>{
 const f=fixture();try{f.add(f.event('401'),'approved');f.transport.prepareRound=async()=>{f.trace.push('prepare-error');throw Object.assign(new Error('固定资源故障'),{browserPaused:true,code:'browser-resource-pressure'});};await f.begin();await assert.rejects(f.workflow.tick(),/固定资源故障/);assert.equal(f.workflow.control(),'paused');assert.ok(f.trace.includes('control:paused'));assert.equal(f.counts().collections,0);assert.equal(f.counts().sends,0);assert.equal(f.counts().generations,0);assert.equal(f.workflow.busy,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n,0);assert.ok(f.program.list().some(row=>row.status==='failed'));}finally{f.close();}
});

test('私信普通RPC失败保留已读公开消息，并记录明确私信失败而非全局崩溃',async()=>{
 const f=fixture('draft');try{const event=f.event('501');f.publicEvents([event]);f.transport.collectPrivate=async()=>{f.trace.push('private-error');throw Error('原始私信异常 https://private.invalid/?token=do-not-log');};await f.begin();await f.workflow.tick();assert.equal(f.store.getMessage(event.id,'worker')?.status,'draft');assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,0);const snapshot=f.health.get('worker');assert.equal(snapshot.metrics.find(row=>row.key==='collection-public')?.level,'normal');assert.equal(snapshot.metrics.find(row=>row.key==='collection-private')?.detail?.status,'failed');assert.equal(snapshot.metrics.find(row=>row.key==='collection-failures')?.level,'normal');assert.ok(!JSON.stringify(f.store.logs()).includes('do-not-log'));assert.equal(f.workflow.control(),'running');}finally{f.close();}
});

test('私信RPC身份/资源暂停错误仍中止整轮，不用已读public绕过安全暂停',async()=>{
 const f=fixture('draft');try{const event=f.event('601');f.publicEvents([event]);f.transport.collectPrivate=async()=>{throw Object.assign(new Error('固定浏览器暂停'),{browserPaused:true});};await f.begin();await assert.rejects(f.workflow.tick(),/固定浏览器暂停/);assert.equal(f.workflow.control(),'paused');assert.equal(f.store.getMessage(event.id,'worker'),undefined);assert.equal(f.counts().generations,0);assert.equal(f.counts().sends,0);assert.equal(f.workflow.busy,false);}finally{f.close();}
});
