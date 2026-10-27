import type { Api, Model, Context } from '@earendil-works/pi-ai';
import { readSecret } from './config.js';
import { keySlot, readModelKey } from './settings.js';
import { resolveRuntimeModel } from './model-catalog.js';
import type { Config, Draft } from './types.js';
import twitterText from 'twitter-text';
export function parseDraft(raw:string):Draft {
 const s=raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'');
 const x=JSON.parse(s);
 if(!x||!['reply','skip'].includes(x.action)||typeof x.text!=='string'||typeof x.reason!=='string')throw new Error('模型输出未通过结构校验');
 if(x.action==='reply'&&(!x.text.trim()||x.text.length>4000||/https?:\/\/|www\.|@[a-z0-9_]{1,15}/i.test(x.text)))throw new Error('回复为空、过长或包含禁用链接及账号提及');
 return {action:x.action,text:x.text.trim(),reason:x.reason.slice(0,300)};
}
export function publicLengthOK(text:string){return twitterText.parseTweet(text).valid;}
export interface Generator { complete(c:Config,system:string,user:string,signal?:AbortSignal):Promise<{text:string;input:number;output:number;cache:number}>; }

// Thinking budget added on top of the visible-reply cap. Budget-based APIs get it from pi itself.
export const THINKING_BUDGET:Record<string,number> = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 16384 };
const PI_ADDS_BUDGET = new Set(['anthropic-messages', 'bedrock-converse-stream']);

export function requestMaxTokens(cap:number, model:Model<Api>, level:string):number {
 const extra = level !== 'off' && model.reasoning && !PI_ADDS_BUDGET.has(model.api) ? THINKING_BUDGET[level] ?? 0 : 0;
 return Math.min(cap + extra, model.maxTokens);
}

export type CompletionResult = { text:string; input:number; output:number; cache:number; stopReason:string; errorMessage?:string; latencyMs:number };

export async function runCompletion(m:Config['model'], key:string, system:string, user:string, opts:{signal?:AbortSignal; maxTokens?:number; reasoning?:string} = {}):Promise<CompletionResult> {
 const { model, models } = await resolveRuntimeModel(m);
 const level = opts.reasoning ?? (m.reasoning ? m.reasoningLevel : 'off');
 const maxTokens = requestMaxTokens(opts.maxTokens ?? m.maxTokens, model, level);
 const timeout = AbortSignal.timeout(m.timeoutMs);
 const context:Context = { systemPrompt: system, messages: [{ role: 'user', content: user, timestamp: Date.now() }] };
 const started = Date.now();
 const r = await models.completeSimple(model, context, { apiKey: key, maxTokens, reasoning: level === 'off' ? undefined : level as any, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
 return { text: r.content.filter(x => x.type === 'text').map(x => (x as any).text).join(''), input: r.usage.input, output: r.usage.output, cache: r.usage.cacheRead, stopReason: r.stopReason, errorMessage: r.errorMessage, latencyMs: Date.now() - started };
}

export function modelKey(m:Config['model']):string {
 if (m.source !== 'panel') return readSecret('model_api_key');
 try { return readModelKey(keySlot(m.provider, m.baseUrl)); } catch { return ''; }
}

export class PiGenerator implements Generator {
 async complete(c:Config,system:string,user:string,signal?:AbortSignal){
  const key = modelKey(c.model);
  if(!key||!c.model.id||!c.model.baseUrl)throw new Error('模型未配置：请在面板的模型页填写服务商、模型和 API Key');
  const r = await runCompletion(c.model, key, system, user, { signal });
  if(['error','aborted','length','toolUse'].includes(r.stopReason))throw new Error(r.errorMessage||'模型返回不完整或不支持的响应：'+r.stopReason);
  return { text: r.text, input: r.input, output: r.output, cache: r.cache };
 }
}
