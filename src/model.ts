import type { Api, Model, Context } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { readSecret } from './config.js';
import { keySlot, readModelKey } from './settings.js';
import { resolveRuntimeModel } from './model-catalog.js';
import type { Config, Draft,Channel } from './types.js';
import type { Store } from './store.js';
import { LlmStore,usageSnapshot,costSnapshot,type CallMetadata,type FullUsage,type CostSnapshot,type PricingStatus } from './llm-store.js';
export type { CallMetadata,FullUsage,CostSnapshot,PricingStatus } from './llm-store.js';
import { normalizePublicText,publicResourceOK,validatePostingText } from './posting-policy.js';
export function parseDraftStructure(raw:string):Draft {
 const s=raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'');
 const x=JSON.parse(s);
 if(!x||!['reply','skip'].includes(x.action)||typeof x.text!=='string'||typeof x.reason!=='string')throw new Error('模型输出未通过结构校验');
 if(x.action==='reply'&&(!x.text.trim()||/https?:\/\/|www\.|@[a-z0-9_]{1,15}/i.test(x.text)))throw new Error('回复为空或包含禁用链接及账号提及');
 const category=['harassment','spam','no_reply','other'].includes(x.category)?x.category:'other';
 return {action:x.action,text:x.text.trim(),reason:x.reason.slice(0,300),...(x.action==='skip'?{category}:{})};
}
export function parseDraft(raw:string,options:{channel?:Channel}={}):Draft {
 const draft=parseDraftStructure(raw);if(draft.action!=='reply')return draft;
 if(options.channel==='public'){
  draft.text=normalizePublicText(draft.text);
  if(!publicResourceOK(draft.text))throw new Error('公开正文超过 25,000 个 Unicode 码点的输入保护边界');
 }else if(draft.text.length>4000)throw new Error('私信回复超过 4,000 个 JavaScript 字符');
 return draft;
}
export function publicLengthOK(text:string){return validatePostingText(text,'reply').allowed;}
export type GenerationResult={text:string;input:number;output:number;cache:number;callId?:string;usage?:FullUsage|null;cost?:CostSnapshot|null;pricingStatus?:PricingStatus;latencyMs?:number};
export interface Generator { complete(c:Config,system:string,user:string,signal?:AbortSignal,sessionId?:string,metadata?:CallMetadata):Promise<GenerationResult>; }

// Thinking budget added on top of the visible-reply cap. Budget-based APIs get it from pi itself.
export const THINKING_BUDGET:Record<string,number> = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 16384 };
const PI_ADDS_BUDGET = new Set(['anthropic-messages', 'bedrock-converse-stream']);

export function requestMaxTokens(cap:number, model:Model<Api>, level:string):number {
 const extra = level !== 'off' && model.reasoning && !PI_ADDS_BUDGET.has(model.api) ? THINKING_BUDGET[level] ?? 0 : 0;
 return Math.min(cap + extra, model.maxTokens);
}

export type CompletionResult = GenerationResult & { stopReason:string; errorMessage?:string; latencyMs:number; actualModel?:string };
export type ResolvedCompletionModel=Awaited<ReturnType<typeof resolveRuntimeModel>>;
export type CompletionOptions = {signal?:AbortSignal; maxTokens?:number; reasoning?:string; sessionId?:string;resolvedModel?:ResolvedCompletionModel;jsonObject?:boolean};
/** 内部回放冻结目录模型与真实 Pi 价格；Models 仅在内存使用，绝不序列化到配置。 */
export async function freezeCompletionModel(model:Config['model']):Promise<ResolvedCompletionModel>{const resolved=await resolveRuntimeModel(model);return {...resolved,model:structuredClone(resolved.model)};}

export async function runCompletion(m:Config['model'], key:string, system:string, user:string, opts:CompletionOptions = {}):Promise<CompletionResult> {
 const { model, models,pricingKnown } = opts.resolvedModel??await resolveRuntimeModel(m);
 const level = opts.reasoning ?? (m.reasoning ? m.reasoningLevel : 'off');
 const maxTokens = requestMaxTokens(opts.maxTokens ?? m.maxTokens, model, level);
 const timeout = AbortSignal.timeout(m.timeoutMs);
 const context:Context = { systemPrompt: system, messages: [{ role: 'user', content: user, timestamp: Date.now() }] };
 const started = Date.now();
 // 只有调用方明确要求对象JSON、且协议为Chat Completions时才使用原生格式约束。
 // 其他协议保持已有行为；Chat端点拒绝参数时正常失败，不降级或重发。
 const onPayload=opts.jsonObject===true&&model.api==='openai-completions'?(payload:unknown)=>{
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('模型请求结构无法施加 JSON 输出约束');
  return {...payload,response_format:{type:'json_object'}};
 }:undefined;
 // 工作流传入稳定会话；独立连接测试使用新会话。pi 按服务商和地址添加对应会话头。
 const r = await models.completeSimple(model, context, { apiKey: key, sessionId: opts.sessionId || 'role-workflow-' + randomUUID(), identity: { userAgent: { custom: 'role-workflow/0.1' } }, headers: m.provider === 'commandcode' ? { Authorization: 'Bearer ' + key } : undefined, maxTokens, reasoning: level === 'off' ? undefined : level as any, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,onPayload,maxRetries:0 });
 // Pi 的错误占位 usage 可能全为零；没有实际返回的用量不视为免费。
 const meaningful=Object.entries(r.usage||{}).some(([k,v])=>k!=='cost'&&typeof v==='number'&&v>0);
 // Pi 在成功但上游没有 usage 时也保留初始化零值，无法以 stopReason 证明返回过用量。
 const usage=usageSnapshot(r.usage,meaningful);
 const cost=pricingKnown&&usage?costSnapshot(r.usage.cost):null;
 return { text: r.content.filter(x => x.type === 'text').map(x => (x as any).text).join(''), input: usage?.input??0, output: usage?.output??0, cache: usage?.cacheRead??0, usage,cost,pricingStatus:!usage?'unknown':pricingKnown?(cost?'priced':'unknown'):'unpriced',actualModel:r.responseModel||r.model,stopReason: r.stopReason, errorMessage: r.errorMessage, latencyMs: Date.now() - started };
}

export function modelKey(m:Config['model']):string {
 if (m.source !== 'panel') return readSecret('model_api_key');
 try { return readModelKey(keySlot(m.provider, m.baseUrl)); } catch { return ''; }
}

export class ModelService implements Generator {
 readonly ledger?:LlmStore;
 constructor(store?:Store,private run:typeof runCompletion=runCompletion){if(store)this.ledger=new LlmStore(store);}
 async request(m:Config['model'],key:string,system:string,user:string,opts:CompletionOptions={},metadata:CallMetadata={}):Promise<CompletionResult>{
  const id=this.ledger?.start(m,metadata),started=Date.now();
  try{
   const r=await this.run(m,key,system,user,{...opts,maxTokens:metadata.maxTokens??opts.maxTokens,reasoning:metadata.reasoning??opts.reasoning,jsonObject:metadata.jsonObject??opts.jsonObject});
   // 注入的测试实现可只返回旧版三个 token 字段，未知分项保留 null。
   const partialUsage=r.usage??{input:r.input,output:r.output,cacheRead:r.cache};
   const meaningful=Object.values(partialUsage).some(v=>typeof v==='number'&&v>0);
   const usage=r.usage===null?null:usageSnapshot(partialUsage,meaningful);
   const cost=usage&&r.pricingStatus==='priced'?costSnapshot(r.cost):null;
   const pricingStatus:PricingStatus=!usage?'unknown':r.pricingStatus==='unknown'?'unknown':cost?'priced':'unpriced';
   const result={...r,usage,cost,pricingStatus,callId:id};
   const status=r.stopReason==='aborted'?'aborted':r.stopReason==='error'?'failed':'completed';
   if(id)this.ledger!.finish(id,status,result);
   return result;
  }catch(err){
   const e=err as any;
   const meaningful=Object.entries(e?.usage||{}).some(([k,v])=>k!=='cost'&&typeof v==='number'&&v>0);
   const usage=usageSnapshot(e?.usage,meaningful),cost=usage&&e?.pricingStatus==='priced'?costSnapshot(e?.cost||e?.usage?.cost):null;
   if(id)this.ledger!.finish(id,opts.signal?.aborted||e?.name==='AbortError'?'aborted':'failed',{usage,cost,pricingStatus:cost?'priced':usage?'unpriced':'unknown',stopReason:opts.signal?.aborted?'aborted':'error',latencyMs:Date.now()-started});
   if(e&&typeof e==='object'&&id){try{e.callId=id;}catch{}}
   throw err;
  }
 }
 async complete(c:Config,system:string,user:string,signal?:AbortSignal,sessionId?:string,metadata:CallMetadata={}){
  const key = modelKey(c.model);
  if(!key||!c.model.id||!c.model.baseUrl)throw new Error('模型未配置：请在面板的模型页填写服务商、模型和 API Key');
  const r = await this.request(c.model, key, system, user, { signal, sessionId },metadata);
  if(['error','aborted','length','toolUse','deferred','pending'].includes(r.stopReason)){
   const error=new Error(r.errorMessage||'模型返回不完整或不支持的响应：'+r.stopReason) as Error&{callId?:string;usage?:FullUsage|null;cost?:CostSnapshot|null};
   error.callId=r.callId;error.usage=r.usage;error.cost=r.cost;throw error;
  }
  return r;
 }
}
export class PiGenerator extends ModelService {}
