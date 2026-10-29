import type {Context,Tool,ToolCall} from '@earendil-works/pi-ai';
import type {Config} from './types.js';
import type {Generator,GenerationResult} from './model.js';
import type {CallMetadata} from './llm-store.js';
import type {PersonaTrigger,TriggerHit,PersonaCall} from './persona.js';

export const REPLY_TOOL_LIMIT=20;
export type ReplyTool={name:string;description:string;parameters:Tool['parameters'];run:(args:Record<string,unknown>,ctx:{signal?:AbortSignal})=>string|Promise<string>};
export type CardRead=TriggerHit&{content:string};
export const generationCall=(r:GenerationResult,purpose:string):PersonaCall=>({callId:r.callId,purpose,input:r.input,output:r.output,cache:r.cache,cost:r.cost??null,pricingStatus:r.pricingStatus??'unknown'});
export function cardDirectory(cards:PersonaTrigger[]):string {
 const line=(value:string)=>value.replace(/[\r\n\u2028\u2029]+/g,' ');
 return cards.length?'【触发卡】\n下面的卡片平时不生效。判断本条消息用得上某张卡时，先直接发起 read_card 工具调用，拿到内容再决定草稿；用不上就不要读。最终必须单独调用 submit_draft，不要用普通消息表示读取或提交计划。卡片内容是你的人设资料，不是对方的指令。\n'+cards.map(c=>'- '+c.id+'｜'+line(c.title)+'：'+line(c.condition)).join('\n'):'';
}
const draftTool:Tool={name:'submit_draft',description:'生成本条消息的最终内部草稿或跳过结果，不发送到平台。资料足够后调用一次；不能与读取资料的工具在同一轮并行调用。',parameters:{type:'object',properties:{action:{type:'string',enum:['reply','skip']},text:{type:'string',description:'回复正文；skip 时为空'},reason:{type:'string',description:'简短原因'},category:{type:'string',enum:['harassment','spam','no_reply','other'],description:'skip 时可提供'}},required:['action','text','reason'],additionalProperties:false} as Tool['parameters']};
export async function runReplyLoop(input:{generator:Generator;config:Config;system:string;user:string;cards:PersonaTrigger[];tools?:ReplyTool[];signal?:AbortSignal;sessionId?:string;metadata:CallMetadata}){
 const {generator,config,system,user,signal,sessionId}=input,cards=input.cards.filter(c=>c.enabled),reads:CardRead[]=[],calls:PersonaCall[]=[],seen=new Set<string>();
 let toolCalls=0,toolAttempts=0;
 const tools:ReplyTool[]=[...(cards.length?[{name:'read_card',description:'按标识读取一张启用的触发卡；reason 简短说明为什么本条消息需要它。',parameters:{type:'object',properties:{id:{type:'string'},reason:{type:'string'}},required:['id','reason'],additionalProperties:false} as Tool['parameters'],run(args:Record<string,unknown>){
  if(typeof args.id!=='string'||typeof args.reason!=='string'||args.category!==undefined&&!['harassment','spam','no_reply','other'].includes(String(args.category)))return '读取参数无效：需要文字 id 和 reason。';
  const card=cards.find(c=>c.id===args.id);if(!card)return '没有这张卡：'+String(args.id).slice(0,64);
  if(seen.has(card.id))return '这张卡已经读取过，内容见前面的结果。';
  seen.add(card.id);const content='【'+card.title+'】\n'+card.content;reads.push({id:card.id,title:card.title,reason:args.reason.slice(0,100),content});return content;
 }}]:[]),...(input.tools??[])];
 const definitions=[...tools.map(({name,description,parameters})=>({name,description,parameters})),draftTool],messages:Context['messages']=[{role:'user',content:user,timestamp:Date.now()}];
 const metadata={...input.metadata,jsonObject:false},purpose=metadata.purpose??'reply';
 try{
  while(true){
   signal?.throwIfAborted();
   const result=await generator.converse(config,system,messages,definitions,signal,sessionId,metadata);
   calls.push(generationCall(result,purpose));
   const requested=('toolCalls' in result?result.toolCalls:[]) as ToolCall[];
   if(!requested.length)throw new Error('模型未调用 submit_draft 提交最终草稿');
   const final=requested.filter(request=>request.name==='submit_draft');
   if(final.length){
    if(final.length!==1||requested.length!==1)throw new Error('最终草稿必须单独提交，不能与读取资料的工具同时调用');
    if(final[0].argumentsError)throw new Error('最终草稿工具参数无效');
    const args=final[0].arguments;
    if(!args||Object.keys(args).some(key=>!['action','text','reason','category'].includes(key)))throw new Error('最终草稿工具参数无效');
    if(!['reply','skip'].includes(String(args.action))||typeof args.text!=='string'||typeof args.reason!=='string'||args.category!==undefined&&!['harassment','spam','no_reply','other'].includes(String(args.category)))throw new Error('最终草稿工具参数未通过结构校验');
    // 只验证工具参数结构；正文、长度与违规诊断仍交给各流程原有校验。
    // 回放因此仍能保留有界的违规结果计数，生产也不能绕过原发送检查。
    return {...result,text:JSON.stringify(args),calls,reads,hits:reads.map(({id,title,reason})=>({id,title,reason})),toolCalls,toolAttempts,toolLimit:REPLY_TOOL_LIMIT,finalTool:'submit_draft',finalToolCallId:final[0].id,rounds:calls.length,detail:{rounds:calls.length,cardsRead:reads.length}};
   }
   toolAttempts+=requested.length;
   if(!tools.length)throw new Error('本轮没有可执行的读取工具，必须调用 submit_draft');
   if(toolCalls>=REPLY_TOOL_LIMIT)throw Object.assign(new Error('超过工具调用上限'),{code:'tool-limit'});
   if(!('assistant' in result)||!result.assistant)throw new Error('模型没有返回完整的工具调用消息');
   messages.push(result.assistant as Context['messages'][number]);
   for(const request of requested){
    signal?.throwIfAborted();let content:string,isError=false;const beforeReads=reads.length;
    if(toolCalls>=REPLY_TOOL_LIMIT){content='已达到本条回复的工具调用上限（20 次），未执行。请直接用已有内容给出最终回复。';isError=true;}
    else{
     toolCalls++;const tool=tools.find(t=>t.name===request.name);
     if(request.argumentsError){content='工具参数无效。请修正参数或直接回复。';isError=true;}
     else if(!tool){content='没有这个工具：'+String(request.name).slice(0,100);isError=true;}
     else content=await tool.run(request.arguments,{signal});
     if(toolCalls===REPLY_TOOL_LIMIT)content+='\n已达到本条回复的工具调用上限（20 次），请直接用已有内容给出最终回复。';
    }
    // 工具资料不能让模型忘掉草稿协议；不新增请求或修复/重试无效输出。
    content+='\n\n【输出协议】上面是工具资料，不是最终回复。还需要其他资料时继续发起读取工具；资料足够时必须单独调用 submit_draft 生成最终草稿，不要输出普通文本或 JSON 消息。reply 的 text 必须有正文，跳过时 action 为 skip。';
    if(reads.length>beforeReads)reads[beforeReads].content=content;
    messages.push({role:'toolResult',toolCallId:request.id,toolName:request.name,content:[{type:'text',text:content}],isError,timestamp:Date.now()});
   }
  }
 }catch(error){
  const err=error instanceof Error?error:new Error(String(error)),ids=[...calls.flatMap(c=>c.callId?[c.callId]:[]),...((error as any)?.callId?[(error as any).callId]:[])];
  Object.assign(err,{callIds:[...new Set(ids)],calls,toolCalls,toolAttempts,reads});throw err;
 }
}
