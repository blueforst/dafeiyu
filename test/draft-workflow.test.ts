import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Outbox } from '../src/outbox.js';
import { MemoryService } from '../src/memory.js';
import { ActivityFeed,FeedError } from '../src/activity-feed.js';
import { ReplyTriage } from '../src/reply-triage.js';
import { validatePostingText } from '../src/posting-policy.js';
import { exampleConfig } from './config-fixture.js';
import type { Config,Draft,Event,Identity,Receipt } from '../src/types.js';
import type { Transport } from '../src/transport.js';

function fixture(mode:'draft'|'auto'='draft'){
 const dir=mkdtempSync(tmpdir()+'/draft-workflow-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(dir+'/workflow.sqlite'),c={...structuredClone(exampleConfig),mode} as Config;
 let identity:Identity={handle:'worker',loggedIn:true,needsHuman:false},received:Event[]=[],sends=0,generations=0,lookups=0;
 let sent:Receipt={status:'confirmed',id:'receipt-1'},lookedUp:Receipt={status:'unknown'};
 let output=JSON.stringify({action:'reply',text:'新的回复',reason:''});const sentIds:string[]=[];
 const transport:Transport={identity:async()=>identity,control:async()=>{},collect:async()=>({events:received,warnings:[]}),context:async()=> '对话资料',send:async e=>{sends++;sentIds.push(e.id);return sent;},lookup:async()=>{lookups++;return lookedUp;}};
 const callMetadata:any[]=[];
 const generator={complete:async(_c:any,_system:string,_user:string,_signal?:AbortSignal,_session?:string,meta?:any)=>{generations++;callMetadata.push(meta);return {text:output,input:10,output:8,cache:0};}};
 const workflow=new Workflow(store,transport,generator,()=>c),outbox=new Outbox(store),memory=new MemoryService(store,generator,()=>c);
 workflow.services={outbox,memory};store.set('activeAccount','worker');
 const feed=new ActivityFeed(store,()=>workflow.accountId(),()=>c.maxAgeHours);
 const event=(id='100',extra:Partial<Event>={}):Event=>({id:'x:'+id,platformId:id,targetId:id,channel:'public',userId:'x:alice',handle:'alice',text:'关于这件事情，你怎么看？',url:'https://x.com/alice/status/'+id,conversationId:id,timestamp:Date.now(),timestampReliable:true,...extra});
 const add=(e:Event,status='draft',draft:Draft={action:'reply',text:'原来的草稿',reason:''})=>{store.ingest(e,'worker');const row=store.getMessage(e.id,'worker');store.update(row.id,status,{draft});return store.getMessage(row.id);};
 const approve=(row:any,text=JSON.parse(row.draft).text)=>feed.mutate(row.id,'approve',{text,revision:row.updated_at});
 return {dir,store,c,transport,generator,workflow,outbox,memory,feed,event,add,approve,callMetadata,counts:()=>({sends,generations,lookups}),sentIds,
  setEvents:(value:Event[])=>received=value,setIdentity:(value:Identity)=>identity=value,setOutput:(value:string)=>output=value,setReceipt:(value:Receipt)=>sent=value,setLookup:(value:Receipt)=>lookedUp=value,
  close(){workflow.stop();store.db.close();rmSync(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}};
}
const notSubmitted:Receipt={status:'not_submitted',reason:'编辑器限制已变化',validation:validatePostingText('中'.repeat(141),'reply')};

test('旧记忆摘要 fallback 保留普通文本，不继承同用途的新 JSON 对象约束',async()=>{
 const f=fixture();try{
  delete f.workflow.services.memory;
  await f.workflow.resume();f.add(f.event('908'),'confirmed');f.setOutput('只根据原文保留的纯文本摘要');
  await f.workflow.summarize('x:alice','public');
  assert.equal(f.counts().generations,1);assert.equal(f.callMetadata[0].purpose,'memory-summary');assert.equal(f.callMetadata[0].jsonObject,undefined);assert.equal(f.counts().sends,0);
  assert.ok(f.store.context('x:alice','public','worker').memories.some(row=>row.summary==='只根据原文保留的纯文本摘要'));
 }finally{f.close();}
});

test('未遗忘用户的遗忘措辞走普通分级和生成，不改变遗忘状态',async()=>{
 for(const text of ['忘了我吧','忘记我吧','忘我吧','忘了我吧。！','@worker 忘了我吧']){
  const f=fixture();try{await f.workflow.resume();f.workflow.services.triage=new ReplyTriage(f.store);const event=f.event('901',{text}),epoch=f.store.epoch(event.userId,'worker');f.setEvents([event]);
   await f.workflow.tick();assert.equal(f.store.forgotten(event.userId,'worker'),false,text);assert.equal(f.store.epoch(event.userId,'worker'),epoch,text);const row=f.store.getMessage(event.id,'worker');assert.ok(row,text);assert.equal(row.status,'draft',text);assert.equal(row.tier,'priority');assert.equal(JSON.parse(row.draft).text,'新的回复');assert.equal(f.counts().generations,1);assert.equal(f.callMetadata[0].jsonObject,true);assert.equal(f.counts().sends,0);
  }finally{f.close();}
 }
});
test('未遗忘用户的恢复措辞也是普通消息，不写恢复状态或跳过回复',async()=>{
 const f=fixture();try{await f.workflow.resume();const event=f.event('902',{text:'重新记住我！'}),epoch=f.store.epoch(event.userId,'worker');f.setEvents([event]);await f.workflow.tick();assert.equal(f.store.forgotten(event.userId,'worker'),false);assert.equal(f.store.epoch(event.userId,'worker'),epoch);const row=f.store.getMessage(event.id,'worker');assert.ok(row);assert.equal(row.status,'draft');assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,0);
 }finally{f.close();}
});
test('管理员已遗忘用户不能通过消息恢复，仍不入库或生成',async()=>{
 for(const text of ['重新记住我','重新记住我！','忘了我吧']){
  const f=fixture();try{await f.workflow.resume();const event=f.event('903',{text});f.store.forget(event.userId,'worker');const epoch=f.store.epoch(event.userId,'worker');f.setEvents([event]);await f.workflow.tick();assert.equal(f.store.forgotten(event.userId,'worker'),true,text);assert.equal(f.store.epoch(event.userId,'worker'),epoch,text);assert.equal(f.store.getMessage(event.id,'worker'),undefined);assert.deepEqual(f.counts(),{sends:0,generations:0,lookups:0});assert.equal(f.outbox.source('worker','reply',event.id),undefined);
  }finally{f.close();}
 }
});

test('草稿模式仅发送人工批准项，未批准草稿保持原样且不额外生成',async()=>{
 const f=fixture();try{await f.workflow.resume();const approved=f.add(f.event('101')),untouched=f.add(f.event('102',{userId:'x:bob',handle:'bob'}));f.approve(approved,'人工确认的正文');
  await f.workflow.tick();assert.equal(f.store.getMessage(approved.id).status,'confirmed');assert.equal(f.store.getMessage(untouched.id).status,'draft');assert.equal(f.counts().sends,1);assert.equal(f.counts().generations,0);assert.deepEqual(f.sentIds,[approved.id]);assert.equal(f.outbox.source('worker','reply',approved.id)?.text,'人工确认的正文');
 }finally{f.close();}
});
test('取消先于主循环认领获胜，认领后取消返回冲突且不会重复提交',async()=>{
 const f=fixture();try{await f.workflow.resume();const cancelled=f.add(f.event('103'));f.approve(cancelled);f.feed.mutate(cancelled.id,'cancel',{});await f.workflow.tick();assert.equal(f.counts().sends,0);assert.equal(f.store.getMessage(cancelled.id).status,'draft');
  const sending=f.add(f.event('104'));f.approve(sending);const identity=f.transport.identity;let calls=0,conflicts=0;
  f.transport.identity=async()=>{if(++calls===2){assert.throws(()=>f.feed.mutate(sending.id,'cancel',{}),(e:unknown)=>e instanceof FeedError&&e.statusCode===409);conflicts++;}return identity();};
  await f.workflow.tick();await f.workflow.tick();assert.equal(conflicts,1);assert.equal(f.store.getMessage(sending.id).status,'confirmed');assert.equal(f.counts().sends,1);
 }finally{f.close();}
});
test('auto模式下人工重写仍停草稿，模型skip恢复前稿并保留复核标记',async()=>{
 for(const skip of [false,true]){const f=fixture('auto');try{await f.workflow.resume();const original=f.add(f.event(skip?'106':'105'));f.feed.mutate(original.id,'regenerate',{revision:original.updated_at});if(skip)f.setOutput(JSON.stringify({action:'skip',text:'',reason:'无需回复'}));
   await f.workflow.tick();const row=f.store.getMessage(original.id),draft=JSON.parse(row.draft);assert.equal(row.status,'draft');assert.equal(draft.review,true);assert.equal(draft.text,skip?'原来的草稿':'新的回复');if(skip)assert.equal(draft.regenNote,'无需回复');assert.equal(f.counts().sends,0);assert.equal(f.counts().generations,1);assert.equal(f.outbox.source('worker','reply',original.id),undefined);
  }finally{f.close();}}
});
test('暂停与人工接管下批准和重写只改数据库，不发送也不调用模型',async()=>{
 for(const control of ['paused','manual']){const f=fixture('auto');try{await f.workflow.resume();f.store.set('control',control);const approved=f.add(f.event('107')),rewrite=f.add(f.event('108',{userId:'x:bob',handle:'bob'}));f.approve(approved);f.feed.mutate(rewrite.id,'regenerate',{revision:rewrite.updated_at});await f.workflow.tick();assert.equal(f.counts().sends,0);assert.equal(f.counts().generations,0);assert.equal(f.store.getMessage(approved.id).status,'approved');assert.equal(f.store.getMessage(rewrite.id).status,'queued');assert.equal(f.workflow.control(),control);
  }finally{f.close();}}
});
test('已批准项受小时额度、通道退避与unknown阻挡，并显示等待原因',async()=>{
 for(const reason of ['quota','cooldown','unknown-pending']){const f=fixture();try{await f.workflow.resume();const row=f.add(f.event('109'));f.approve(row);
   if(reason==='quota')f.c.publicPerHour=0;
   if(reason==='cooldown')f.store.set('cooldown:public:worker',String(Date.now()+60000));
   if(reason==='unknown-pending'){const unknown=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'existing-unknown',text:'尚待确认'});f.outbox.begin(unknown.id);f.outbox.settle(unknown.id,{status:'unknown'});}
   await f.workflow.tick();assert.equal(f.counts().sends,0);const current=f.store.getMessage(row.id);assert.equal(current.status,'approved');assert.equal(JSON.parse(current.draft).waitReason,reason);
  }finally{f.close();}}
});
test('生成后与批准发送前切换账号均暂停，旧账号草稿不交给新账号',async()=>{
 const f=fixture();try{await f.workflow.resume();const row=f.add(f.event('110'));f.approve(row);const identity=f.transport.identity;let calls=0;f.transport.identity=async()=>++calls===2?{handle:'other',loggedIn:true,needsHuman:false}:identity();await f.workflow.tick();assert.equal(f.counts().sends,0);assert.equal(f.workflow.control(),'paused');assert.equal(f.store.getMessage(row.id).status,'approved');assert.equal(f.outbox.source('worker','reply',row.id),undefined);
 }finally{f.close();}
 const g=fixture('auto');try{await g.workflow.resume();g.setEvents([g.event('111')]);const complete=g.generator.complete;g.generator.complete=async()=>{g.setIdentity({handle:'other',loggedIn:true,needsHuman:false});return complete();};await g.workflow.tick();assert.equal(g.counts().sends,0);assert.equal(g.workflow.control(),'paused');assert.equal(g.store.getMessage('x:111','worker').status,'draft');
 }finally{g.close();}
});
test('公开超长输出保留有界草稿及校验信息，4000旧门槛不提前丢弃',async()=>{
 for(const length of [281,4001]){const f=fixture('auto');try{await f.workflow.resume();f.setEvents([f.event('112')]);f.setOutput(JSON.stringify({action:'reply',text:'a'.repeat(length),reason:''}));await f.workflow.tick();const row=f.store.getMessage('x:112','worker');assert.equal(row.status,'draft');const draft=JSON.parse(row.draft);assert.equal(draft.text.length,length);assert.equal(draft.validation.allowed,false);assert.equal(draft.validation.limit,280);assert.equal(f.counts().sends,0);assert.equal(f.counts().generations,1);assert.equal(f.outbox.source('worker','reply',row.id),undefined);
  }finally{f.close();}}
});
test('未提交首响应与丢失响应后的lookup都回到草稿，不冷却、不计额度、不重发',async()=>{
 for(const lost of [false,true]){const f=fixture('auto');try{await f.workflow.resume();f.setEvents([f.event('113')]);if(lost){f.transport.send=async()=>{f.sentIds.push('lost');throw new Error('响应丢失');};f.setLookup(notSubmitted);}else f.setReceipt(notSubmitted);
   await f.workflow.tick();let row=f.store.getMessage('x:113','worker');assert.equal(row.status,lost?'unknown':'draft');if(lost){await f.workflow.tick();row=f.store.getMessage('x:113','worker');}assert.equal(row.status,'draft');assert.equal(JSON.parse(row.receipt).status,'not_submitted');assert.equal(f.outbox.source('worker','reply',row.id)?.status,'cancelled');assert.equal(f.workflow.cooldown('public'),0);assert.equal(f.workflow.sentCount('public'),0);const calls=f.counts().sends;await f.workflow.tick();assert.equal(f.counts().sends,calls);assert.equal(f.counts().generations,1);assert.equal(f.sentIds.length,1);
  }finally{f.close();}}
});
test('confirmed初次响应和lookup确认都只写一次有来源角色经历',async()=>{
 for(const lost of [false,true]){const f=fixture('auto');try{await f.workflow.resume();f.setEvents([f.event('114')]);if(lost){f.setReceipt({status:'unknown'});f.setLookup({status:'confirmed',id:'receipt-after-loss'});}await f.workflow.tick();if(lost)await f.workflow.tick();await f.workflow.tick();const row=f.store.getMessage('x:114','worker');assert.equal(row.status,'confirmed');const experiences=f.store.db.prepare('SELECT * FROM role_experiences WHERE account_id=?').all('worker') as any[];assert.equal(experiences.length,1);assert.equal(experiences[0].source_message_id,row.id);assert.equal(JSON.parse(experiences[0].receipt).id,lost?'receipt-after-loss':'receipt-1');assert.equal(f.counts().sends,1);
  }finally{f.close();}}
});
test('丢失初次拒绝响应后lookup仍启动原通道四小时退避',async()=>{
 const f=fixture('auto');try{await f.workflow.resume();f.setEvents([f.event('115')]);f.setReceipt({status:'unknown'});f.setLookup({status:'rejected',reason:'平台明确拒绝'});await f.workflow.tick();await f.workflow.tick();assert.equal(f.store.getMessage('x:115','worker').status,'failed');assert.ok(f.workflow.cooldown('public')>Date.now()+3.9*3600000);assert.equal(f.counts().sends,1);
 }finally{f.close();}
});
test('最终身份复核等待期间遗忘用户后不创建孤儿出站或发送',async()=>{
 const f=fixture();try{await f.workflow.resume();const row=f.add(f.event('116'));f.approve(row);const identity=f.transport.identity;let calls=0;f.transport.identity=async()=>{if(++calls===2)f.store.forget('x:alice','worker');return identity();};await f.workflow.tick();assert.equal(f.store.getMessage(row.id),undefined);assert.equal(f.counts().sends,0);assert.equal(f.outbox.source('worker','reply',row.id),undefined);
 }finally{f.close();}
});

test('人工重写优先经过生成复核，普通分级不吞掉旧熟人招呼草稿',async()=>{
 const f=fixture('auto');try{await f.workflow.resume();f.workflow.services.triage=new ReplyTriage(f.store);f.add(f.event('117',{timestamp:Date.now()-1000}),'confirmed');const row=f.add(f.event('118',{text:'你好'}));f.feed.mutate(row.id,'regenerate',{revision:row.updated_at});await f.workflow.tick();const current=f.store.getMessage(row.id);assert.equal(current.status,'draft');assert.equal(JSON.parse(current.draft).review,true);assert.equal(JSON.parse(current.draft).text,'新的回复');assert.equal(f.counts().generations,1);assert.equal(f.counts().sends,0);
 }finally{f.close();}
});
test('过期批准草稿收束为超时跳过，不占用出站或模型',async()=>{
 const f=fixture();try{await f.workflow.resume();const row=f.add(f.event('119'));f.approve(row);const body=JSON.parse(row.body);body.timestamp=Date.now()-7*3600000;f.store.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(body),row.id);await f.workflow.tick();assert.equal(f.store.getMessage(row.id).status,'skipped');assert.match(f.store.getMessage(row.id).error,/超时/);assert.equal(f.counts().sends,0);assert.equal(f.counts().generations,0);assert.equal(f.outbox.source('worker','reply',row.id),undefined);
 }finally{f.close();}
});
test('批准项认领sending不提前占自己的最后小时或每日名额',async()=>{
 for(const boundary of ['hour','day']){const f=fixture();try{await f.workflow.resume();
   if(boundary==='hour')f.c.publicPerHour=2;else {f.c.publicPerDay=2;f.workflow.services.triage=new ReplyTriage(f.store);}
   const previous=f.outbox.prepare({accountId:'worker',kind:'post',sourceId:'prior-confirmed',text:'已确认的前一条'});assert.equal(f.outbox.begin(previous.id),true);f.outbox.settle(previous.id,{status:'confirmed',id:'prior-platform-receipt'});
   const last=f.add(f.event('130',{timestamp:Date.now()-1000})),excess=f.add(f.event('131',{userId:'x:bob',handle:'bob'}));f.approve(last);f.approve(excess);
   await f.workflow.tick();assert.equal(f.store.getMessage(last.id).status,'confirmed',boundary+'最后一个名额应允许发送');assert.equal(f.counts().sends,1);assert.equal(f.store.getMessage(excess.id).status,'approved');assert.equal(JSON.parse(f.store.getMessage(excess.id).draft).waitReason,'quota');assert.equal(f.workflow.sentCount('public'),2);
   if(boundary==='day')assert.equal(f.workflow.services.triage!.dailyCount('worker'),2);
  }finally{f.close();}}
});


test('完整RPC资源保护在begin之前停止，确定未提交不会卡成unknown',async()=>{
 const f=fixture('auto');try{await f.workflow.resume();f.setEvents([f.event('oversized-rpc',{text:'中'.repeat(100000)})]);await f.workflow.tick();const row=f.store.getMessage('x:oversized-rpc','worker');assert.equal(row.status,'draft');assert.equal(JSON.parse(row.draft).validation.code,'rpc-resource-limit');assert.equal(f.counts().sends,0);const outbox=f.outbox.source('worker','reply',row.id);assert.equal(outbox?.status,'cancelled');assert.equal(outbox?.submitted_at,null);assert.equal(JSON.parse(outbox!.validation_json!).code,'rpc-resource-limit');assert.equal(f.outbox.count('public','worker'),0);assert.equal(f.store.get('cooldown:public'),'');}finally{f.close();}
});

test('自动回复和私信含列表仍只生成及发送一次，保留格式标记而不写错误',async()=>{
 for(const channel of ['public','private'] as const){const f=fixture('auto');try{await f.workflow.resume();const event=f.event('format-auto-'+channel,{channel});f.setEvents([event]);f.setOutput(JSON.stringify({action:'reply',text:'1. 先喝水\n2. 再散步',reason:''}));await f.workflow.tick();const row=f.store.getMessage(event.id);assert.equal(row.status,'confirmed');assert.deepEqual(JSON.parse(row.draft).format,{issues:['list-or-steps']});assert.ok(!row.error);assert.deepEqual(f.counts(),{sends:1,generations:1,lookups:0});assert.deepEqual((f.feed.list({filter:channel==='public'?'reply':'dm'}).items[0] as any).draft.format,{issues:['list-or-steps']});}finally{f.close();}}
});

test('带格式草稿保持审批流程，批准原稿或人工去掉格式都重新记录标记',async()=>{
 for(const edit of [false,true]){const f=fixture();try{await f.workflow.resume();const event=f.event('format-draft-'+edit);f.setEvents([event]);f.setOutput(JSON.stringify({action:'reply',text:'**今天很适合散步**',reason:''}));await f.workflow.tick();let row=f.store.getMessage(event.id);assert.equal(row.status,'draft');assert.deepEqual(JSON.parse(row.draft).format,{issues:['markdown']});assert.equal(f.counts().sends,0);assert.ok(!row.error);f.approve(row,edit?'今天很适合散步':JSON.parse(row.draft).text);await f.workflow.tick();row=f.store.getMessage(event.id);assert.equal(row.status,'confirmed');assert.deepEqual(JSON.parse(row.draft).format,{issues:edit?[]:['markdown']});assert.deepEqual(f.counts(),{sends:1,generations:1,lookups:0});}finally{f.close();}}
});

test('人工重写生成的新正文重新计算格式，auto下仍待管理员审批',async()=>{
 const f=fixture('auto');try{await f.workflow.resume();const row=f.add(f.event('format-regenerate'),'draft',{action:'reply',text:'1. 先喝水\n2. 再散步',reason:'',format:{issues:['list-or-steps']}});f.feed.mutate(row.id,'regenerate',{revision:row.updated_at});f.setOutput(JSON.stringify({action:'reply',text:'那就一起走走吧',reason:''}));await f.workflow.tick();const current=f.store.getMessage(row.id);assert.equal(current.status,'draft');assert.deepEqual(JSON.parse(current.draft).format,{issues:[]});assert.equal(JSON.parse(current.draft).review,true);assert.equal(f.counts().sends,0);assert.equal(f.counts().generations,1);}finally{f.close();}
});
