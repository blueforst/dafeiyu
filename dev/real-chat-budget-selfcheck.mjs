// 离线自检；只写新建临时目录，不读取 Key，不创建 HTTP 客户端或真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BudgetGate} from './real-chat-budget.mjs';

export function runSelfcheck(){
 const directory=fs.mkdtempSync(join(tmpdir(),'real-chat-budget-selfcheck-')),checks=[];let sequence=0;
 const options=(extra={})=>({path:join(directory,'budget-'+(++sequence)+'.json'),limitUsd:2,maxRequests:24,inputTokenCeiling:1000000,inputRatePerMillion:.30,outputRatePerMillion:1.20,...extra});
 const reserve=(gate,extra={})=>gate.reserve({maxOutputTokens:6144,inputBytes:1200,label:'offline-check',interactionId:'isolated-interaction',...extra});
 const result=(extra={})=>({callId:'offline-call',usage:{input:100,output:20,cacheRead:50,cacheWrite:10,cacheWrite1h:5,totalTokens:185,reasoning:8},cost:{input:.000015,output:.000012,cacheRead:0,cacheWrite:0,total:.000027},pricingStatus:'priced',actualModel:'deepseek-v4.1-flash',expectedModel:'deepseek-v4.1-flash',...extra});
 const check=(name,fn)=>{fn();checks.push(name);};
 try{
  check('整模型输入及实际输出预留，峰价结算不给缓存折扣且思考不重复',()=>{
   const config=options(),gate=new BudgetGate(config),ticket=reserve(gate);assert.equal(ticket.reservedNano,307372800);assert.equal(gate.snapshot().reservedNano,307372800);assert.equal(fs.statSync(config.path).mode&0o777,0o600);
   const snapshot=gate.settle(ticket,result());assert.equal(snapshot.halted,false);assert.equal(snapshot.reservedNano,0);assert.equal(snapshot.settledNano,73500);assert.equal(snapshot.requests,1);assert.equal(snapshot.tickets[0].reportedPiCost.total,.000027);assert.equal(new BudgetGate(config).snapshot().settledNano,73500);assert.doesNotThrow(()=>JSON.stringify(snapshot));
  });
  check('未结算预留累计到预算边界后拒绝且保持全部额度',()=>{
   const gate=new BudgetGate(options());for(let i=0;i<6;i++)reserve(gate);assert.equal(gate.snapshot().reservedNano,1844236800);assert.throws(()=>reserve(gate),{code:'budget-exhausted'});assert.equal(gate.snapshot().requests,6);assert.equal(gate.snapshot().halted,true);assert.throws(()=>reserve(gate));
  });
  check('小调用完成后释放差额，24次可执行而第25次拒绝',()=>{
   const gate=new BudgetGate(options());for(let i=0;i<24;i++)gate.settle(reserve(gate),result({callId:'offline-call-'+i}));assert.equal(gate.snapshot().requests,24);assert.equal(gate.snapshot().reservedNano,0);assert.ok(gate.snapshot().usedNano<2000000000);assert.throws(()=>reserve(gate),{code:'request-limit'});
  });
  check('未知用量保留整笔预留，重启后不允许继续',()=>{
   const config=options(),gate=new BudgetGate(config),ticket=reserve(gate);gate.settle(ticket,result({usage:null}));assert.equal(gate.snapshot().reservedNano,ticket.reservedNano);assert.equal(gate.snapshot().settledNano,0);assert.equal(gate.snapshot().halted,true);assert.throws(()=>reserve(new BudgetGate(config)));
  });
  check('未收束进程重启视为未知，不释放预留',()=>{
   const config=options(),gate=new BudgetGate(config),ticket=reserve(gate),reopened=new BudgetGate(config);assert.equal(reopened.snapshot().reservedNano,ticket.reservedNano);assert.equal(reopened.snapshot().haltReason,'restart-unsettled');assert.throws(()=>reserve(reopened));
  });
  check('超时显式fail保留预留，不持久化额外错误正文或密钥字段',()=>{
   const config=options(),gate=new BudgetGate(config),ticket=reserve(gate);gate.fail(ticket,{reason:'timeout',apiKey:'NEVER_PERSIST_FIXTURE_KEY',error:{message:'NEVER_PERSIST_FIXTURE_KEY'}});assert.equal(gate.snapshot().reservedNano,ticket.reservedNano);assert.equal(gate.snapshot().haltReason,'timeout');assert.ok(!fs.readFileSync(config.path,'utf8').includes('NEVER_PERSIST_FIXTURE_KEY'));assert.throws(()=>reserve(new BudgetGate(config)));
  });
  check('输入超过48000字节或非法预留数值时在提交前拒绝并持久停止',()=>{
   for(const patch of [{inputBytes:48001},{inputBytes:NaN},{inputBytes:-1},{inputBytes:1.5},{maxOutputTokens:0},{maxOutputTokens:-1},{maxOutputTokens:Infinity},{maxOutputTokens:1.5}]){const config=options(),gate=new BudgetGate(config);assert.throws(()=>reserve(gate,patch));assert.equal(gate.snapshot().requests,0);assert.equal(gate.snapshot().halted,true);assert.throws(()=>reserve(new BudgetGate(config)));}
  });
  check('非法token、未定价、模型漂移、缺少调用ID与坏cost均保留预留',()=>{
   const patches=[{usage:{...result().usage,input:-1}},{usage:{...result().usage,output:NaN}},{usage:{...result().usage,cacheRead:1.2}},{usage:{...result().usage,cacheWrite:null}},{usage:{...result().usage,reasoning:21}},{usage:{...result().usage,output:6145}},{usage:{...result().usage,input:1000001}},{pricingStatus:'unpriced'},{actualModel:'different-model'},{callId:undefined},{cost:null},{cost:{...result().cost,total:Infinity}},{cost:{...result().cost,total:.01}}];
   for(const patch of patches){const gate=new BudgetGate(options()),ticket=reserve(gate);gate.settle(ticket,result(patch));assert.equal(gate.snapshot().halted,true);assert.equal(gate.snapshot().reservedNano,ticket.reservedNano);assert.equal(gate.snapshot().settledNano,0);assert.throws(()=>reserve(gate));}
  });
  check('纳美元向上取整，不用浮点余额允许超额',()=>{
   const gate=new BudgetGate(options({inputRatePerMillion:.300000001,outputRatePerMillion:1.200000001})),ticket=reserve(gate,{maxOutputTokens:1});assert.equal(ticket.reservedNano,300001202);gate.settle(ticket,result({usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2},cost:{input:.00000015,output:.0000006,cacheRead:0,cacheWrite:0,total:.00000075}}));assert.equal(gate.snapshot().settledNano,1501);
  });
  check('预留原子落盘失败不能放行，恢复可用文件系统后仍是停止状态',()=>{
   const config=options(),gate=new BudgetGate(config),original=fs.renameSync;let intercepted=0,ticket;
   fs.renameSync=(from,to)=>{if(to===config.path&&intercepted++===0)throw Object.assign(new Error('模拟落盘失败'),{code:'EIO'});return original(from,to);};
   try{assert.throws(()=>{ticket=reserve(gate);},{code:'persistence-failed'});assert.equal(ticket,undefined);assert.equal(gate.snapshot().halted,true);assert.equal(gate.snapshot().requests,0);}finally{fs.renameSync=original;}
   assert.throws(()=>reserve(new BudgetGate(config)));assert.ok(fs.readdirSync(directory).every(name=>!name.endsWith('.tmp')));
  });
  check('拒绝重复结算与伪造票据，已有费用不被减免',()=>{
   const gate=new BudgetGate(options()),ticket=reserve(gate);gate.settle(ticket,result());const before=gate.snapshot().settledNano;gate.settle(ticket,result());assert.equal(gate.snapshot().halted,true);assert.equal(gate.snapshot().settledNano,before);
   const other=new BudgetGate(options()),issued=reserve(other);other.settle({...issued,reservedNano:0},result());assert.equal(other.snapshot().halted,true);assert.equal(other.snapshot().reservedNano,issued.reservedNano);
  });
  return {ok:true,total:checks.length,passed:checks.length,checks,realModelCalls:0,networkRequests:0,note:'仅临时目录内的离线预算自检，未读取任何凭据。'};
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(JSON.stringify(runSelfcheck(),null,2)+'\n');}catch(error){process.stderr.write(JSON.stringify({ok:false,error:error?.code||error?.name||'selfcheck-failed',realModelCalls:0})+'\n');process.exitCode=1;}
}
