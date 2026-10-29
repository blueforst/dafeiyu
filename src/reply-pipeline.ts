import {runReplyLoop} from './reply-tools.js';
import {parseDraft,type Generator} from './model.js';
import type {CallMetadata} from './llm-store.js';
import type {Config,Event} from './types.js';
import type {Persona,PersonaService} from './persona.js';
import type {SnapshotInput} from './persona-replay.js';
import {assembleReplyPrompt} from './reply-prompt.js';
import type {ReplySample} from './reply-hints.js';
import {formatIssues,privateOverlap} from './reply-style.js';
import {normalizePublicText,validatePostingText,postingLimitPrompt,type PostingCapability} from './posting-policy.js';

/** 生产和独立试聊共用的生成步骤。调度、额度、收发及状态均留给调用方。 */
export type ReplySources={
 config:Config;
 accountId:string;
 persona?:Persona;
 personaService?:Pick<PersonaService,'assemble'>;
 generator:Generator;
 conversation:(event:Event)=>unknown|Promise<unknown>;
 memory:(event:Event)=>unknown|Promise<unknown>;
 recentReplies:(event:Event)=>ReplySample[]|Promise<ReplySample[]>;
 dailyState?:unknown;
 posting?:()=>PostingCapability|undefined;
 signal?:AbortSignal;
 sessionId:string|(()=>string);
 personaIdentity?:()=>{id?:string;name?:string;revision?:number};
 snapshot?:(event:Event,data:SnapshotInput)=>unknown;
 metadata?:(step:'reply')=>CallMetadata;
 stage?:<T>(name:string,fn:()=>Promise<T>)=>Promise<T>;
};
export type ReplyOptions={merged?:Event[];now?:number;sampleSource?:string;experiences?:unknown};

export async function generateReply(sources:ReplySources,event:Event,options:ReplyOptions={}){
 const stage=<T>(name:string,fn:()=>Promise<T>):Promise<T>=>sources.stage?sources.stage(name,fn):fn();
 const config=sources.config,accountId=sources.accountId;
 const identity=sources.personaIdentity?.();
 const rawContext=await stage('context',async()=>sources.conversation(event));
 const merged=options.merged??[];
 const conversation=merged.length?{current:rawContext,previousMessages:merged.map(item=>({id:item.platformId,text:item.text,timestamp:item.timestamp}))}:rawContext;
 const memory=await stage('memory',async()=>sources.memory(event));
 const sessionId=typeof sources.sessionId==='function'?sources.sessionId():sources.sessionId;
 const recentReplies=await sources.recentReplies(event);
 const metadata=sources.metadata?.('reply')??{purpose:'reply',source:'workflow',accountId,channel:event.channel,interactionId:event.id,jsonObject:true};
 const input={config,persona:sources.persona,message:event.text,channel:event.channel,accountId,conversation,memory,
  dailyState:sources.dailyState??'暂无当日日程',mediaUnavailable:event.mediaUnavailable,quote:event.quote,card:event.card,
  signal:sources.signal,sessionId,interactionId:metadata.interactionId??event.id,now:options.now??Date.now(),
  timestamp:event.timestamp,timestampReliable:event.timestampReliable===true,conversationId:event.conversationId,recentReplies,
  promptHints:config.promptHints,lengthRule:postingLimitPrompt(event.channel==='public'?'reply':'dm',sources.posting?.(),accountId),
  ...(options.sampleSource===undefined?{}:{sampleSource:options.sampleSource}),...(options.experiences===undefined?{}:{experiences:options.experiences})};
 const prompt=sources.personaService?await sources.personaService.assemble(input):assembleReplyPrompt({...input,staticText:config.persona,settings:config.promptHints});
 const assembled={cards:[],hits:[],calls:[],warning:undefined,interactionId:event.id,...prompt};
 sources.snapshot?.(event,{conversation,memory,hintMeta:assembled.meta,dailySlot:input.dailyState,
  ...(identity?.revision===undefined?{}:{personaRevision:identity.revision}),...(identity?.id===undefined?{}:{personaId:identity.id}),...(identity?.name===undefined?{}:{personaName:identity.name})});
 const result=await stage('generation',()=>runReplyLoop({generator:sources.generator,config,system:assembled.system,user:assembled.user,cards:assembled.cards,signal:sources.signal,sessionId,metadata})).catch(error=>{
  const reads=(error as any)?.reads??[];
  if(error&&typeof error==='object')error.replyDiagnostics={hits:reads.map(({id,title,reason}:any)=>({id,title,reason})),meta:{...assembled.meta,toolCalls:error.toolCalls??0,toolAttempts:error.toolAttempts??0,toolLimit:20,callIds:error.callIds??[],reads},segments:[...assembled.segments,...reads.map((r:any)=>({kind:'card-read',title:'读取：'+r.title,content:r.content,role:'tool',stable:false}))]};
  throw error;
 });
 assembled.calls=result.calls;assembled.hits=result.hits;
 Object.assign(assembled.meta,{triggerHits:result.hits,toolCalls:result.toolCalls,toolAttempts:result.toolAttempts,toolLimit:result.toolLimit,callIds:result.calls.flatMap(c=>c.callId?[c.callId]:[]),reads:result.reads,finalTool:result.finalTool,finalToolCallId:result.finalToolCallId});
 assembled.segments.push(...result.reads.map(read=>({kind:'card-read',title:'读取：'+read.title,content:read.content,role:'tool' as const,stable:false})));
 let draft:ReturnType<typeof parseDraft>;
 try{draft=parseDraft(result.text,{channel:event.channel});}catch(error){if(error&&typeof error==='object')Object.assign(error,{replyDiagnostics:{hits:assembled.hits,meta:assembled.meta,segments:assembled.segments}});throw error;}
 if(event.channel==='public')draft.text=normalizePublicText(draft.text);
 draft.meta={...assembled.meta,callId:result.callId};
 let validation=draft.action==='reply'?validatePostingText(draft.text,event.channel==='public'?'reply':'dm',{accountId,capability:sources.posting?.()}):undefined;
 const background=(memory as any)?.privateBackground;
 if(event.channel==='public'&&draft.action==='reply'&&Array.isArray(background)&&background.length){const overlap=privateOverlap(draft.text,background.map((item:any)=>item.text).filter((text:unknown):text is string=>typeof text==='string'));if(overlap){draft.privacy={overlap:overlap.fragment};if(validation)validation={...validation,allowed:false,code:'private-overlap',reason:'可能提及私信内容'};}}
 if(validation)draft.validation=validation;
 draft.format={issues:formatIssues(draft.text)};
 return {draft,result,validation,assembled,conversation,memory};
}
