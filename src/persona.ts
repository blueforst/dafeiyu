import { randomUUID } from 'node:crypto';
import { loadConfig, redact } from './config.js';
import { readPanelSettings, SettingsConflictError } from './settings.js';
import { PersonaLibraryService,type PersonaIdentity } from './persona-library.js';
import { parseDraft, type Generator } from './model.js';
import {cardDirectory,runReplyLoop} from './reply-tools.js';
import { LlmStore } from './llm-store.js';
import type { Channel, Config,Event } from './types.js';
import type { Store } from './store.js';
import { assembleReplyPrompt,FIXED_SYSTEM_RULES,type PromptSegment } from './reply-prompt.js';
import { validatePromptHints,type PromptHintSettings,type ReplySample,type ReplyHint } from './reply-hints.js';
import { postingLimitPrompt,validatePostingText,type PostingCapability } from './posting-policy.js';
import { validatePublicExtras } from './public-post.js';
import { resolvePersona } from './persona-presets.js';
import { formatIssues,type ReplyFormat } from './reply-style.js';
export { FIXED_SYSTEM_RULES } from './reply-prompt.js';
export type { PromptSegment } from './reply-prompt.js';

export type PersonaSection = { id:string; title:string; content:string };
export type PersonaTrigger = { id:string; title:string; condition:string; content:string; enabled:boolean; order:number };
export type Persona = { sections:PersonaSection[]; triggers:PersonaTrigger[] };
export type TriggerHit = { id:string; title:string; reason:string };
export type PersonaCall = { callId?:string; purpose:string; input?:number; output?:number; cache?:number; cost?:{total?:number}|null; pricingStatus?:string };
export type PersonaFees = { estimatedUsd:number|null; unpriced:number; unknown:number; requests:number };

export class PersonaValidationError extends Error { statusCode=400; }
function object(v:unknown):v is Record<string,any> { return !!v && typeof v==='object' && !Array.isArray(v); }
function string(v:unknown, label:string, max:number, empty=true):string {
 if(typeof v!=='string'||v.length>max||(!empty&&!v.trim()))throw new PersonaValidationError(label+'无效');
 return v;
}
function id(v:unknown):string { const s=string(v,'标识',64,false);if(!/^[A-Za-z0-9_-]+$/.test(s))throw new PersonaValidationError('标识只能包含字母、数字、下划线和连字符');return s; }
function publicExtras(value:{quote?:unknown;card?:unknown}):Pick<Event,'quote'|'card'>{try{return validatePublicExtras(value);}catch{throw new PersonaValidationError('引用或链接卡片格式、类型或长度无效');}}

export function legacyPersona(text:string):Persona {
 return {sections:[{id:'role',title:'角色定义',content:text},{id:'style',title:'说话风格',content:''},{id:'memory',title:'记忆与承诺',content:''},{id:'boundaries',title:'互动边界',content:''}],triggers:[]};
}

export function validatePersona(raw:unknown,options:{stored?:boolean}={}):Persona {
 if(!object(raw)||!Array.isArray(raw.sections)||!Array.isArray(raw.triggers)||raw.sections.length<1||raw.sections.length>20||raw.triggers.length>(options.stored?120:100))throw new PersonaValidationError('人设需要静态分区及触发规则数组');
 const used=new Set<string>();
 const unique=(value:unknown)=>{const v=id(value);if(used.has(v))throw new PersonaValidationError('人设标识不能重复');used.add(v);return v;};
 const sections=raw.sections.map((s:any)=>{if(!object(s))throw new PersonaValidationError('静态分区无效');return {id:unique(s.id),title:string(s.title,'分区名称',100,false),content:string(s.content,'分区正文',20000)};});
 const triggers=raw.triggers.map((t:any,index:number)=>{
  if(!object(t)||typeof t.enabled!=='boolean'||!Number.isInteger(t.order)||t.order<0||t.order>10000)throw new PersonaValidationError('触发规则开关或顺序无效');
  if(t.match==='keywords'||Object.hasOwn(t,'keywords'))throw new PersonaValidationError('关键词触发已取消，请改写为什么时候用');
  if(t.match!==undefined&&t.match!=='semantic')throw new PersonaValidationError('触发卡格式无效');
  return {id:unique(t.id),title:string(t.title,'规则名称',100,false),condition:string(t.condition,'触发条件',2000,false),content:string(t.content,'规则正文',20000,false),enabled:t.enabled,order:t.order,index};
 }).sort((a:any,b:any)=>a.order-b.order||a.index-b.index).map(({index,...t}:any)=>t as PersonaTrigger);
 const length=sections.reduce((n,s)=>n+s.content.length,0)+triggers.reduce((n,t)=>n+t.condition.length+t.content.length,0);
 if(!options.stored&&length>20000)throw new PersonaValidationError('人设全部分区、条件、正文及关键词合计不能超过 20,000 字符');
 return {sections,triggers};
}

// 调用者仍应只传入当前账号的召回结果。这里再次排除有明确私信标记的结构，防止公开试聊意外引入它。
export function visibleContext(value:unknown,channel:Channel):unknown {
 if(Array.isArray(value))return value.map(v=>visibleContext(v,channel)).filter(v=>v!==undefined);
 if(object(value)){
  if(channel==='public'&&(value.visibility==='private'||value.channel==='private'))return undefined;
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visibleContext(v,channel)]).filter(([,v])=>v!==undefined));
 }
 return value;
}
function json(raw:string):any { return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); }
function fees(calls:PersonaCall[]):PersonaFees {
 let total=0,priced=0,unpriced=0,unknown=0;
 for(const c of calls){if(c.pricingStatus==='priced'&&Number.isFinite(c.cost?.total)){total+=c.cost!.total!;priced++;}else if(c.pricingStatus==='unpriced')unpriced++;else unknown++;}
 return {estimatedUsd:priced?total:null,unpriced,unknown,requests:calls.length};
}
function call(r:any,purpose:string):PersonaCall { return {callId:r.callId,purpose,input:r.input,output:r.output,cache:r.cache,cost:r.cost??null,pricingStatus:r.pricingStatus??'unknown'}; }

function simulatedMemory(raw:unknown):unknown {
 if(raw===undefined)return {simulated:true,items:[]};
 if(typeof raw==='string')return {simulated:true,items:string(raw,'模拟记忆',8000)};
 if(!object(raw))throw new PersonaValidationError('模拟记忆需要文字或对象');
 let serialized:string|undefined;try{serialized=JSON.stringify(raw);}catch{throw new PersonaValidationError('模拟记忆对象无效');}
 if(typeof serialized!=='string')throw new PersonaValidationError('模拟记忆对象无效');
 if(serialized.length>8000)throw new PersonaValidationError('模拟记忆不能超过 8,000 字符');
 const value=JSON.parse(serialized);
 if(value.recent!==undefined&&(!Array.isArray(value.recent)||value.recent.length>30||value.recent.some((item:any)=>!object(item)||typeof item.message!=='string'||(item.reply!==undefined&&typeof item.reply!=='string')||(item.channel!==undefined&&!['public','private'].includes(item.channel))||(item.timestamp!==undefined&&!Number.isFinite(item.timestamp)))))throw new PersonaValidationError('模拟近期往来需要至多三十条有效消息');
 return {...value,simulated:true};
}

export type AssembleInput = { cards?:'all'; config?:Config; persona?:Persona; message:string; channel:Channel; accountId:string; conversationId?:string; conversation?:unknown; memory?:unknown; dailyState?:unknown; experiences?:unknown; mediaUnavailable?:boolean; quote?:Event['quote']; card?:Event['card']; signal?:AbortSignal; sessionId?:string; interactionId?:string; contextLimit?:number; now?:number; timestamp?:number; timestampReliable?:boolean; recentReplies?:ReplySample[]; promptHints?:Partial<PromptHintSettings>; sampleSource?:string; postVariety?:boolean; lengthRule?:string; routingPurpose?:string; routingSource?:string; routingSide?:'baseline'|'candidate'|'shared'; generator?:Generator };
export type AssembledPrompt = { cards:PersonaTrigger[]; system:string; user:string; segments:PromptSegment[]; hits:TriggerHit[]; hints:ReplyHint[]; meta:{hintKinds:string[];promptVersion:string;sampleSource:string;sampleCount:number;triggerHits:TriggerHit[]}; warning?:string; interactionId:string; calls:PersonaCall[] };

export class PersonaService {
 postingPolicy?:()=>{accountId:string;reply?:PostingCapability;simulation?:boolean};
 library:PersonaLibraryService;
 constructor(public store:Store,public generator:Generator,public config:()=>Config=loadConfig){this.library=new PersonaLibraryService(store,this);}
 get(){
  const settings=readPanelSettings();
  const persona=resolvePersona(settings.persona,settings.persona===undefined?this.config().persona:'');
  return {persona,revision:settings.revisions?.persona??0,fixedRules:FIXED_SYSTEM_RULES};
 }
 save(raw:unknown,expectedRevision?:number){
  const persona=validatePersona(raw);
  const current=this.get();if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision!==current.revision))throw new SettingsConflictError('persona',current.revision);
  const active=this.library.getActive(),saved=this.library.save(active.id,{revision:active.revision,persona},{expectedPersonaRevision:expectedRevision});
  return {persona,revision:saved.personaRevision,fixedRules:FIXED_SYSTEM_RULES};
 }
 /** 元数据失效不能阻断继续使用已验证的兼容人设镜像。 */
 activeIdentity():PersonaIdentity {try{return this.library.activeIdentity();}catch{const current=this.get();return {id:'current',name:'当前人设',revision:current.revision};}}
 async assemble(input:AssembleInput):Promise<AssembledPrompt>{
  const c=structuredClone(input.config??this.config()),p=validatePersona(input.persona??this.get().persona,{stored:true}),interactionId=input.interactionId??randomUUID();
  const now=input.now??Date.now(),promptHints=validatePromptHints(input.promptHints??c.promptHints??{}),recentReplies=structuredClone(input.recentReplies??[]),extras=publicExtras(input);
  if(!['public','private'].includes(input.channel))throw new PersonaValidationError('请选择公开或私信场景');
  const message=string(input.message,'当前消息',30000,false);
  const memory=visibleContext(input.memory??[],input.channel),conversation=visibleContext(input.conversation??[],input.channel);
  if(input.contextLimit&&JSON.stringify({message,memory,conversation,quote:input.quote,card:input.card}).length>input.contextLimit)throw new PersonaValidationError('试聊上下文不能超过 '+input.contextLimit.toLocaleString('en-US')+' 字符');
  const enabled=p.triggers.filter(t=>t.enabled),calls:PersonaCall[]=[],hits:TriggerHit[]=[];
  const staticText=[...p.sections.map(s=>'【'+s.title+'】\n'+s.content),...(input.cards==='all'?enabled.map(t=>'【'+t.title+'】\n'+t.content):[])].join('\n\n');
  const directory=input.cards==='all'?'':cardDirectory(enabled);
  const layered=assembleReplyPrompt({...input,...extras,now,recentReplies,message,memory,conversation,staticText,directory,experiences:visibleContext(input.experiences??(object(memory)?memory.experiences:undefined)??[],input.channel),settings:promptHints,lengthRule:input.lengthRule??postingLimitPrompt(input.channel==='public'?'reply':'dm')});
  return {...layered,cards:input.cards==='all'?[]:enabled,meta:{...layered.meta,triggerHits:hits.map(({id,title,reason})=>({id,title,reason}))},hits,interactionId,calls};
 }
 async preview(raw:any){
  if(!object(raw)||!['public','private'].includes(raw.channel)||!Array.isArray(raw.messages)||!raw.messages.length||raw.messages.length>30)throw new PersonaValidationError('试聊需要场景及一至三十条对话');
  const messages=raw.messages.map((m:any)=>{if(!object(m)||!['user','assistant'].includes(m.role))throw new PersonaValidationError('试聊消息角色无效');return {role:m.role as 'user'|'assistant',text:string(m.text,'试聊消息',12000,false),...publicExtras(m)};});
  if(messages.at(-1)!.role!=='user')throw new PersonaValidationError('试聊最后一条必须是用户消息');
  if(JSON.stringify(messages).length>40000)throw new PersonaValidationError('试聊上下文不能超过 40,000 字符');
  const c=structuredClone(this.config()),persona=validatePersona(raw.persona??this.get().persona),started=Date.now();
  const memory=simulatedMemory(raw.memory);
  const dailyState=raw.dailyState===undefined?'模拟场景：暂无当日日程':string(raw.dailyState,'模拟日程',8000);
  const policy=this.postingPolicy?.()??{accountId:this.store.get('activeAccount'),reply:undefined},accountId=policy.accountId||'preview';
  const now=Date.now(),previewReplies:ReplySample[]=messages.slice(0,-1).filter(m=>m.role==='assistant').reverse().map(m=>({text:m.text,channel:raw.channel,conversationId:'preview',accountId}));
  const promptHints=raw.promptHints===undefined?validatePromptHints(c.promptHints??{}):validatePromptHints(raw.promptHints);
  const current=messages.at(-1)!;
  const assembled=await this.assemble({config:c,persona,message:current.text,channel:raw.channel,accountId,conversationId:'preview',conversation:messages.slice(0,-1),memory,dailyState,interactionId:randomUUID(),contextLimit:40000,now,recentReplies:previewReplies,promptHints,sampleSource:'preview-dialogue',lengthRule:postingLimitPrompt(raw.channel==='public'?'reply':'dm',policy.reply,policy.accountId),quote:current.quote,card:current.card});
  let draft:ReturnType<typeof parseDraft>|null=null,error:string|undefined,format:ReplyFormat|null=null;
  try{
   const result=await runReplyLoop({generator:this.generator,config:c,system:assembled.system,user:assembled.user,cards:assembled.cards,metadata:{purpose:'persona-preview',source:'panel-preview',accountId:'preview',channel:raw.channel,interactionId:assembled.interactionId,jsonObject:true}});
   assembled.calls.push(...result.calls);assembled.hits=result.hits;assembled.segments.push(...result.reads.map(read=>({kind:'card-read',title:'读取：'+read.title,content:read.content,role:'tool' as const,stable:false})));Object.assign(assembled.meta,{triggerHits:result.hits,toolCalls:result.toolCalls,toolAttempts:result.toolAttempts,toolLimit:result.toolLimit,callIds:result.calls.map(c=>c.callId),reads:result.reads,finalTool:result.finalTool,finalToolCallId:result.finalToolCallId});
   draft=parseDraft(result.text,{channel:raw.channel});
   if(draft.action==='reply'){const validation=validatePostingText(draft.text,raw.channel==='public'?'reply':'dm',{accountId:policy.accountId,capability:policy.reply});if(!validation.allowed)throw new Error(validation.reason);}
   format={issues:formatIssues(draft.text)};draft.format=format;
  }catch(err){if(Array.isArray((err as any)?.calls))assembled.calls.push(...(err as any).calls);draft=null;error=redact(err instanceof Error?err.message:err);}
  // 失败或中止的调用也已持久计量，不能只汇总成功返回给业务层的结果。
  const ledger=new LlmStore(this.store),persisted=ledger.calls({interactionId:assembled.interactionId,limit:100}).items;
  const persistedCalls:PersonaCall[]=persisted.map(r=>({callId:r.id,purpose:r.purpose,input:r.usage?.input??undefined,output:r.usage?.output??undefined,cache:r.usage?.cacheRead??undefined,cost:r.cost,pricingStatus:r.pricingStatus}));
  const allCalls=persistedCalls.length?persistedCalls:assembled.calls;
  return {draft,error,format,segments:assembled.segments,hits:assembled.hits,hints:assembled.hints,meta:assembled.meta,postingPolicy:{accountId:policy.accountId||null,simulation:!policy.accountId,rule:postingLimitPrompt(raw.channel==='public'?'reply':'dm',policy.reply,policy.accountId)},warning:assembled.warning,interactionId:assembled.interactionId,calls:allCalls,fees:fees(allCalls),latencyMs:Date.now()-started};
 }
}
