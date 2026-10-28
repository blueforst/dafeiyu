import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { PiGenerator,parseDraft,publicLengthOK } from '../src/model.js';
import { safeEvent,Serial,browserProxy } from '../src/browser.js';
import type { Config,Event,Receipt } from '../src/types.js';
import type { Transport } from '../src/transport.js';
// 本组验证工作流安全边界，作息由独立测试覆盖；避免夜间运行绕过生成与接管断言。
const config:Config={mode:'draft',pollSeconds:60,maxAgeHours:6,maxPerRound:2,publicPerHour:10,privatePerHour:30,replyHours:{enabled:false,closeDelayMinutes:30},retentionDays:30,persona:'测试 AI',dailyState:'无',model:{provider:'custom',api:'openai-completions',baseUrl:'',id:'',reasoning:false,reasoningLevel:'low',vision:false,maxTokens:1000,timeoutMs:1000}};
const event:Event={id:'x:123',channel:'public',userId:'x:alice',handle:'alice',text:'你好',url:'https://x.com/alice/status/123',conversationId:'123',timestamp:Date.now()};
function nativeMessage(platformId:string,over:Partial<Event>={}):Event{
 const channel=over.channel??event.channel,handle=over.handle??event.handle,conversationId=channel==='private'?'100-200':platformId;
 return {...event,id:'x:'+platformId,...over,channel,platformId,targetId:platformId,conversationId,url:channel==='private'?'https://x.com/messages/'+conversationId:'https://x.com/'+handle+'/status/'+platformId};
}
test('代理配置错误时拒绝启动，不静默回退或暴露凭据',()=>{
 assert.equal(browserProxy(),undefined);
 assert.deepEqual(browserProxy('http://x-egress:7890'),{server:'http://x-egress:7890'});
 for(const value of ['invalid','file:///etc/passwd','http://user:secret@proxy:7890','http://proxy:7890/path'])assert.throws(()=>browserProxy(value),/浏览器代理地址无效/);
});
function fixture(c:Config=structuredClone(config)){
 const path=mkdtempSync(tmpdir()+'/role-test-'),store=new Store(path+'/db.sqlite');
 let sends=0;let received:Event[]=[event];let receipt:Receipt={status:'confirmed',id:'x:124'};
 const t:Transport={identity:async()=>({loggedIn:true,needsHuman:false,handle:'tester'}),collect:async()=>({events:received,warnings:[]}),context:async()=>event.text,send:async()=>{sends++;return receipt;},lookup:async()=>({status:'unknown'}),control:async()=>{}};
 const generator={complete:async()=>({text:'{"action":"reply","text":"你好呀","reason":""}',input:10,output:10,cache:0})};
 const workflow=new Workflow(store,t,generator,()=>c);store.set('control','running');
 return {store,t,generator,workflow,c,sends:()=>sends,setReceipt:(r:Receipt)=>receipt=r,setReceived:(r:Event[])=>received=r,close:()=>{store.db.close();rmSync(path,{recursive:true,force:true});}};
}
test('草稿流程去重，绝不触发发送',async()=>{const f=fixture();try{await f.workflow.tick();await f.workflow.tick();assert.equal(f.sends(),0);assert.equal(f.store.getMessage(event.id).status,'draft');assert.equal(f.store.stats().messages.length,1);}finally{f.close();}});
test('模型会话跨轮次及工作流实例保持稳定，隔离账号、用户、通道及遗忘前后',async()=>{
 const f=fixture(),sessions:Array<string|undefined>=[];
 f.generator.complete=async(_c?:any,_s?:any,_u?:any,_signal?:AbortSignal,sessionId?:string)=>{sessions.push(sessionId);return {text:'{"action":"reply","text":"你好呀","reason":""}',input:1,output:1,cache:0};};
 let platformSequence=1000;
 const next=async(id:string,over:Partial<Event>={},workflow=f.workflow)=>{f.setReceived([nativeMessage(String(++platformSequence),{id,...over})]);await workflow.tick();};
 try{
  await next('x:session-1');await next('x:session-2');
  await f.workflow.summarize(event.userId,'public');
  assert.match(sessions[0]??'',/^role-workflow-[a-f0-9]{64}$/);
  assert.equal(sessions[1],sessions[0]);assert.equal(sessions[2],sessions[0]);
  await next('dm:session-1',{channel:'private'});assert.notEqual(sessions[3],sessions[0]);
  await next('x:session-bob',{userId:'x:bob',handle:'bob'});assert.notEqual(sessions[4],sessions[0]);
  const restarted=new Workflow(f.store,f.t,f.generator,()=>f.c);
  await next('x:session-3',{},restarted);assert.equal(sessions[5],sessions[0]);
  f.store.forget(event.userId);f.store.remember(event.userId);
  await next('x:session-4',{timestamp:f.store.recordingAfter(event.userId,'tester')+1},restarted);assert.notEqual(sessions[6],sessions[0]);
  f.t.identity=async()=>({loggedIn:true,needsHuman:false,handle:'another_account'});
  await next('x:session-5',{timestamp:f.store.recordingAfter(event.userId,'another_account')+1},new Workflow(f.store,f.t,f.generator,()=>f.c));assert.notEqual(sessions[7],sessions[6]);
  assert.equal(sessions.length,8);assert.equal(f.sends(),0);
 }finally{f.close();}
});
test('发送回执未知后保持回查，不重复发送',async()=>{const f=fixture();f.c.mode='auto';f.setReceipt({status:'unknown'});try{await f.workflow.tick();await f.workflow.tick();assert.equal(f.sends(),1);assert.equal(f.store.getMessage(event.id).status,'unknown');}finally{f.close();}});
test('服务重启将 sending 转为 unknown，并保持暂停',()=>{const f=fixture();try{f.store.ingest(event);f.store.update(event.id,'sending');f.store.boot();assert.equal(f.store.getMessage(event.id).status,'unknown');assert.equal(f.workflow.control(),'paused');}finally{f.close();}});
test('公开上下文隔离私信原文和摘要',()=>{const f=fixture();try{f.store.ingest(event);f.store.summary(event.userId,'public','公开爱好',0);f.store.summary(event.userId,'private','秘密工作',0);f.store.ingest({...event,id:'dm:123',channel:'private',text:'私信秘密'});f.store.update('dm:123','confirmed',{draft:{action:'reply',text:'已知',reason:''}});const p=JSON.stringify(f.store.context(event.userId,'public'));assert.ok(!p.includes('秘密'));assert.ok(p.includes('公开爱好'));assert.ok(JSON.stringify(f.store.context(event.userId,'private')).includes('秘密工作'));}finally{f.close();}});
test('遗忘使后台旧摘要失效并禁止继续记录',()=>{const f=fixture();try{f.store.ingest(event);const epoch=f.store.epoch(event.userId);f.store.forget(event.userId);assert.equal(f.store.summary(event.userId,'public','迟到的摘要',epoch),false);assert.equal(f.store.ingest(event),false);assert.equal(f.store.getMessage(event.id),undefined);f.store.remember(event.userId);assert.equal(f.store.ingest(event),false);assert.equal(f.store.ingest(nativeMessage('124',{id:'x:future-after-forget',timestamp:f.store.recordingAfter(event.userId)+1})),true);}finally{f.close();}});
test('人工接管中止生成；释放后继续暂停',async()=>{const f=fixture();f.c.mode='auto';let started!:()=>void;const ready=new Promise<void>(r=>started=r);f.generator.complete=async(_c?:any,_s?:any,_u?:any,signal?:AbortSignal)=>{started();await new Promise((resolve,reject)=>signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));throw Error('unreachable');};try{const tick=f.workflow.tick();await ready;await f.workflow.takeover();await tick;assert.equal(f.sends(),0);assert.equal(f.workflow.control(),'manual');await f.workflow.release();assert.equal(f.workflow.control(),'paused');}finally{f.close();}});
test('不配置账号即可恢复，采集、上下文、发送和回查均使用当前登录账号',async()=>{
 const f=fixture();f.c.mode='auto';const seen:Array<[string,string]>=[];
 f.t.identity=async()=>({loggedIn:true,needsHuman:false,handle:'Current_User'});
 f.t.collect=async handle=>{seen.push(['collect',handle]);return {events:[event],warnings:[]};};
 f.t.context=async(_e,handle)=>{seen.push(['context',handle]);return event.text;};
 f.t.send=async(_e,_text,handle)=>{seen.push(['send',handle]);return {status:'unknown'};};
 f.t.lookup=async(_e,_text,handle)=>{seen.push(['lookup',handle]);return {status:'confirmed'};};
 try{f.store.set('control','paused');await f.workflow.resume();await f.workflow.tick();await f.workflow.tick();assert.deepEqual(seen,[['collect','current_user'],['context','current_user'],['send','current_user'],['lookup','current_user'],['collect','current_user']]);assert.equal(f.workflow.control(),'running');}finally{f.close();}
});
test('未登录、需要验证或无法识别账号时不恢复',async()=>{
 for(const identity of [{loggedIn:false,needsHuman:false,handle:''},{loggedIn:true,needsHuman:true,handle:'tester'},{loggedIn:true,needsHuman:false,handle:''}]){
  const f=fixture();f.t.identity=async()=>identity;
  try{f.store.set('control','paused');await assert.rejects(f.workflow.resume(),/请先登录 X/);assert.equal(f.workflow.control(),'paused');f.store.set('control','running');await f.workflow.tick();assert.equal(f.workflow.control(),'paused');assert.equal(f.store.stats().messages.length,0);assert.equal(f.sends(),0);}finally{f.close();}
 }
});
test('恢复后切换账号，在采集前暂停',async()=>{const f=fixture();try{f.store.set('control','paused');await f.workflow.resume();f.t.identity=async()=>({loggedIn:true,needsHuman:false,handle:'other'});await f.workflow.tick();assert.equal(f.workflow.control(),'paused');assert.equal(f.store.stats().messages.length,0);assert.equal(f.sends(),0);}finally{f.close();}});
test('生成期间退出登录或切换账号，保留草稿并暂停，不触发发送',async()=>{
 for(const identity of [{loggedIn:false,needsHuman:false,handle:''},{loggedIn:true,needsHuman:false,handle:'other'}]){
  const f=fixture();f.c.mode='auto';const complete=f.generator.complete;
  f.generator.complete=async()=>{f.t.identity=async()=>identity;return complete();};
  try{await f.workflow.tick();assert.equal(f.workflow.control(),'paused');assert.equal(f.store.getMessage(event.id).status,'draft');assert.equal(f.sends(),0);}finally{f.close();}
 }
});
test('无效模型输出和超长公开回复禁止发送',async()=>{assert.throws(()=>parseDraft('这不是JSON'));assert.throws(()=>parseDraft('{"action":"reply","text":"看 https://example.org","reason":""}'));assert.equal(publicLengthOK('中'.repeat(141)),false);const f=fixture();f.c.mode='auto';f.generator.complete=async()=>({text:'坏输出',input:1,output:1,cache:0});try{await f.workflow.tick();assert.equal(f.sends(),0);assert.equal(f.store.getMessage(event.id).status,'failed');}finally{f.close();}});
test('平台拒绝触发通道四小时退避',async()=>{const f=fixture();f.c.mode='auto';f.setReceipt({status:'rejected',reason:'平台限额'});try{await f.workflow.tick();assert.ok(Number(f.store.get('cooldown:public'))>Date.now()+3.9*3600000);f.setReceived([{...event,id:'x:125'}]);await f.workflow.tick();assert.equal(f.sends(),1);}finally{f.close();}});
test('浏览器串行互斥和导航白名单',async()=>{const serial=new Serial(),steps:number[]=[];await Promise.all([serial.run(async()=>{steps.push(1);await new Promise(r=>setTimeout(r,10));steps.push(2);}),serial.run(async()=>{steps.push(3);})]);assert.deepEqual(steps,[1,2,3]);assert.throws(()=>safeEvent({...event,url:'http://169.254.169.254/latest/meta-data'}));assert.throws(()=>safeEvent({...event,url:'https://x.com/i/settings'}));});
test('Pi 适配器经过真实本地兼容接口完成请求与用量解析',async()=>{
 const path=mkdtempSync(tmpdir()+'/role-pi-');mkdirSync(path+'/secrets');writeFileSync(path+'/secrets/model_api_key','unit-test-key');const previous=process.env.SECRETS_DIR;process.env.SECRETS_DIR=path+'/secrets';
 let authorized=false;
 const server=createServer((req,res)=>{authorized=req.headers.authorization==='Bearer unit-test-key';req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'text/event-stream'});const chunk={id:'chatcmpl-test',object:'chat.completion.chunk',created:1,model:'unit-model',choices:[{index:0,delta:{role:'assistant',content:'{"action":"reply","text":"测试通过","reason":""}'},finish_reason:null}]};res.write('data: '+JSON.stringify(chunk)+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}})+'\n\n');res.end('data: [DONE]\n\n');});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as any;const c=structuredClone(config);c.model.baseUrl='http://127.0.0.1:'+address.port+'/v1';c.model.id='unit-model';c.model.timeoutMs=10000;
 try{const result=await new PiGenerator().complete(c,'系统规则','测试消息');assert.equal(parseDraft(result.text).text,'测试通过');assert.ok(authorized);assert.equal(result.input,12);assert.equal(result.output,8);}finally{await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.SECRETS_DIR;else process.env.SECRETS_DIR=previous;rmSync(path,{recursive:true,force:true});}
});

test('从旧数据库恢复后重放独立遗忘记录',()=>{const f=fixture();try{f.store.ingest(event);f.store.forget(event.userId);assert.equal(f.store.forgotten(event.userId),true);f.store.db.prepare("UPDATE users SET forgot=0 WHERE id=?").run(event.userId);f.store.db.close();const restored=new Store(f.store.ledgerPath.replace('/forget-ledger.json','/db.sqlite'));assert.equal(restored.forgotten(event.userId),true);assert.equal(restored.ingest(event),false);restored.db.close();}finally{rmSync(f.store.ledgerPath.replace('/forget-ledger.json',''),{recursive:true,force:true});}});

test('私信时间戳不可靠时只保留草稿',async()=>{const f=fixture();f.c.mode='auto';f.setReceived([{...event,id:'dm:unknown-time',channel:'private',timestampReliable:false}]);try{await f.workflow.tick();assert.equal(f.sends(),0);assert.equal(f.store.getMessage('dm:unknown-time').status,'draft');}finally{f.close();}});
