// 仅供独立真实试聊验收使用；不读取 Key、不访问网络、不修改业务源码或生产设置。
import fs from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const MILLION=1000000n,NANO=1000000000n,MAX_BYTES=48000;
const REASONS=new Set(['budget-exhausted','request-limit','input-too-large','invalid-request','invalid-ticket','invalid-usage','invalid-cost','missing-call-id','not-priced','model-mismatch','usage-exceeds-reservation','cost-exceeds-reservation','cost-exceeds-peak','request-failed','timeout','aborted','restart-unsettled','persistence-failed']);
export class BudgetError extends Error {constructor(code){super('真实试聊预算门控停止：'+code);this.name='BudgetError';this.code=code;}}
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min=0)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
const reason=value=>REASONS.has(value)?value:'request-failed';
const now=()=>new Date().toISOString();
function decimal(value){
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new BudgetError('invalid-request');
 const match=String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);if(!match)throw new BudgetError('invalid-request');
 let numerator=BigInt(match[1]+(match[2]||'')),scale=(match[2]||'').length-Number(match[3]||0);
 if(Math.abs(scale)>100)throw new BudgetError('invalid-request');
 return scale>=0?{n:numerator,d:10n**BigInt(scale)}:{n:numerator*10n**BigInt(-scale),d:1n};
}
const ceil=(n,d)=>(n+d-1n)/d;
function money(value,up=true){const fraction=decimal(value),scaled=fraction.n*NANO;return up?ceil(scaled,fraction.d):scaled/fraction.d;}
function safeNumber(value){if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<0n)throw new BudgetError('invalid-request');return Number(value);}
function atomic(path,value){
 const directory=dirname(path);fs.mkdirSync(directory,{recursive:true,mode:0o700});const info=fs.lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('预算目录无效');
 if(fs.existsSync(path)){const current=fs.lstatSync(path);if(!current.isFile()||current.isSymbolicLink())throw new Error('预算文件无效');}
 const temporary=path+'.'+randomUUID()+'.tmp';let fd;
 try{
  fd=fs.openSync(temporary,'wx',0o600);fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(temporary,path);const directoryFd=fs.openSync(directory,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
 }finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(temporary);}catch{}}
}
function usageOf(value){
 if(!object(value)||!['input','output','cacheRead','cacheWrite'].every(key=>integer(value[key])))return null;
 if(value.totalTokens!==undefined&&value.totalTokens!==null&&(!integer(value.totalTokens)||value.totalTokens<value.output))return null;
 if(value.reasoning!==undefined&&value.reasoning!==null&&(!integer(value.reasoning)||value.reasoning>value.output))return null;
 if(value.cacheWrite1h!==undefined&&value.cacheWrite1h!==null&&!integer(value.cacheWrite1h))return null;
 const input=value.input+value.cacheRead+value.cacheWrite+(value.cacheWrite1h??0);
 if(!integer(input)||input+value.output<=0)return null;
 return {input:value.input,output:value.output,cacheRead:value.cacheRead,cacheWrite:value.cacheWrite,...(value.cacheWrite1h==null?{}:{cacheWrite1h:value.cacheWrite1h}),...(value.totalTokens==null?{}:{totalTokens:value.totalTokens}),...(value.reasoning==null?{}:{reasoning:value.reasoning}),conservativeInput:input};
}
function costOf(value){
 if(!object(value)||!['input','output','cacheRead','cacheWrite','total'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)||value.total<=0)return null;
 const sum=value.input+value.output+value.cacheRead+value.cacheWrite;if(Math.abs(sum-value.total)>Math.max(1e-12,value.total*1e-9))return null;
 return Object.fromEntries(['input','output','cacheRead','cacheWrite','total'].map(key=>[key,value[key]]));
}

export class BudgetGate {
 constructor(options){
  if(!object(options)||typeof options.path!=='string'||!options.path||!integer(options.maxRequests,1)||!integer(options.inputTokenCeiling,1))throw new BudgetError('invalid-request');
  const limit=money(options.limitUsd,false),inputRate=money(options.inputRatePerMillion),outputRate=money(options.outputRatePerMillion);
  if(limit<=0n||inputRate<=0n||outputRate<=0n)throw new BudgetError('invalid-request');
  this.path=resolve(options.path);this.inputRate=inputRate;this.outputRate=outputRate;
  this.config={limitNano:safeNumber(limit),limitUsd:options.limitUsd,maxRequests:options.maxRequests,inputTokenCeiling:options.inputTokenCeiling,inputBytesCeiling:MAX_BYTES,inputRatePerMillion:options.inputRatePerMillion,outputRatePerMillion:options.outputRatePerMillion,pricingBasis:'official-peak-no-cache-discount'};
  if(fs.existsSync(this.path)){
   const info=fs.lstatSync(this.path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new BudgetError('invalid-request');
   let state;try{state=JSON.parse(fs.readFileSync(this.path,'utf8'));}catch{throw new BudgetError('invalid-request');}
   if(!object(state)||state.version!==1||JSON.stringify(state.config)!==JSON.stringify(this.config)||typeof state.halted!=='boolean'||!Array.isArray(state.tickets)||state.tickets.length>this.config.maxRequests)throw new BudgetError('invalid-request');
   const ids=new Set(),calls=new Set();for(const ticket of state.tickets){if(!object(ticket)||!identifier(ticket.id)||ids.has(ticket.id)||!integer(ticket.maxOutputTokens,1)||!integer(ticket.inputBytes)||ticket.inputBytes>MAX_BYTES||!['reserved','unknown','settled'].includes(ticket.status)||!integer(ticket.reservedNano,1)||BigInt(ticket.reservedNano)!==this.maximum(ticket.maxOutputTokens)||ticket.status==='settled'&&(!integer(ticket.settledNano)||ticket.settledNano>ticket.reservedNano||!identifier(ticket.callId)))throw new BudgetError('invalid-request');ids.add(ticket.id);if(ticket.status==='settled'){const usage=usageOf(ticket.usage),cost=costOf(ticket.reportedPiCost);if(!usage||!cost||calls.has(ticket.callId)||!identifier(ticket.actualModel)||ticket.actualModel!==ticket.expectedModel||usage.conservativeInput>this.config.inputTokenCeiling||usage.output>ticket.maxOutputTokens||BigInt(ticket.settledNano)!==this.actual(usage.conservativeInput,usage.output))throw new BudgetError('invalid-request');calls.add(ticket.callId);}}
   this.state=state;if(this.total()>BigInt(this.config.limitNano))throw new BudgetError('invalid-request');
   if(state.tickets.some(ticket=>ticket.status!=='settled')){const next=structuredClone(state);for(const ticket of next.tickets)if(ticket.status!=='settled'){ticket.status='unknown';ticket.reason=ticket.reason||'restart-unsettled';}next.halted=true;next.haltReason=next.haltReason||'restart-unsettled';next.updatedAt=now();this.commit(next);}
  }else{this.state={version:1,config:this.config,createdAt:now(),updatedAt:now(),halted:false,haltReason:null,tickets:[]};this.commit(this.state);}
 }
 maximum(output){return ceil(BigInt(this.config.inputTokenCeiling)*this.inputRate+BigInt(output)*this.outputRate,MILLION);}
 actual(input,output){return ceil(BigInt(input)*this.inputRate+BigInt(output)*this.outputRate,MILLION);}
 total(){return this.state.tickets.reduce((sum,ticket)=>sum+BigInt(ticket.status==='settled'?ticket.settledNano:ticket.reservedNano),0n);}
 commit(next){
  try{atomic(this.path,next);this.state=next;}catch{
   this.state={...this.state,halted:true,haltReason:'persistence-failed',updatedAt:now()};try{atomic(this.path,this.state);}catch{}
   throw new BudgetError('persistence-failed');
  }
 }
 halt(code,ticket){const next=structuredClone(this.state);next.halted=true;next.haltReason=next.haltReason||reason(code);next.updatedAt=now();if(ticket){const item=next.tickets.find(value=>value.id===ticket.id);if(item&&item.status!=='settled'){item.status='unknown';item.reason=reason(code);}}this.commit(next);return this.snapshot();}
 reserve(input){
  if(this.state.halted)throw new BudgetError(this.state.haltReason||'request-failed');
  let code;if(!object(input)||!integer(input.maxOutputTokens,1)||!integer(input.inputBytes)||!identifier(input.label)||!identifier(input.interactionId))code='invalid-request';
  else if(input.inputBytes>MAX_BYTES)code='input-too-large';
  else if(this.state.tickets.length>=this.config.maxRequests)code='request-limit';
  let reservation;if(!code){reservation=this.maximum(input.maxOutputTokens);if(this.total()+reservation>BigInt(this.config.limitNano))code='budget-exhausted';}
  if(code){this.halt(code);throw new BudgetError(code);}
  const ticket={id:randomUUID(),reservedNano:safeNumber(reservation),maxOutputTokens:input.maxOutputTokens,inputBytes:input.inputBytes,label:input.label,interactionId:input.interactionId,status:'reserved',createdAt:now()};
  const next=structuredClone(this.state);next.tickets.push(ticket);next.updatedAt=now();this.commit(next);return structuredClone(ticket);
 }
 ticket(value){const ticket=object(value)&&this.state.tickets.find(item=>item.id===value.id);if(!ticket||ticket.status!=='reserved'||ticket.reservedNano!==value.reservedNano)return null;return ticket;}
 settle(value,result){
  const ticket=this.ticket(value);if(!ticket)return this.halt('invalid-ticket');
  if(!object(result))return this.halt('invalid-usage',ticket);
  if(!identifier(result.callId))return this.halt('missing-call-id',ticket);
  if(result.pricingStatus!=='priced')return this.halt('not-priced',ticket);
  if(!identifier(result.actualModel)||!identifier(result.expectedModel)||result.actualModel!==result.expectedModel)return this.halt('model-mismatch',ticket);
  const usage=usageOf(result.usage),cost=costOf(result.cost);if(!usage)return this.halt('invalid-usage',ticket);if(!cost)return this.halt('invalid-cost',ticket);
  if(usage.conservativeInput>this.config.inputTokenCeiling||usage.output>ticket.maxOutputTokens)return this.halt('usage-exceeds-reservation',ticket);
  const charged=this.actual(usage.conservativeInput,usage.output);if(cost.total>this.config.limitUsd||money(cost.total)>BigInt(ticket.reservedNano))return this.halt('cost-exceeds-reservation',ticket);
  if(money(cost.total)>charged+1n)return this.halt('cost-exceeds-peak',ticket);
  if(this.state.tickets.some(item=>item.id!==ticket.id&&item.callId===result.callId))return this.halt('invalid-ticket',ticket);
  const next=structuredClone(this.state),item=next.tickets.find(item=>item.id===ticket.id);Object.assign(item,{status:'settled',settledNano:safeNumber(charged),settledAt:now(),callId:result.callId,actualModel:result.actualModel,expectedModel:result.expectedModel,usage,reportedPiCost:cost});next.updatedAt=now();this.commit(next);return this.snapshot();
 }
 fail(value,details={}){const ticket=this.ticket(value);return ticket?this.halt(reason(details?.reason),ticket):this.halt('invalid-ticket');}
 snapshot(){
  const tickets=structuredClone(this.state.tickets),settledNano=tickets.filter(ticket=>ticket.status==='settled').reduce((n,ticket)=>n+ticket.settledNano,0),reservedNano=tickets.filter(ticket=>ticket.status!=='settled').reduce((n,ticket)=>n+ticket.reservedNano,0);
  return {version:1,...this.config,halted:this.state.halted,haltReason:this.state.haltReason,settledNano,reservedNano,usedNano:settledNano+reservedNano,remainingNano:this.config.limitNano-settledNano-reservedNano,requests:tickets.length,tickets,createdAt:this.state.createdAt,updatedAt:this.state.updatedAt};
 }
}
