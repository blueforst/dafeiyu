import { randomUUID } from 'node:crypto';
import type { TaskContext,TaskOutcome,TaskRun,TaskId } from './scheduler.js';
import type { Workflow } from './workflow.js';
import { loggedInHandle } from './workflow.js';
import { parseDraft } from './model.js';
import { postingLimitPrompt,validatePostingText } from './posting-policy.js';
import { recentReplySamples } from './reply-hints.js';
import { recallRoleExperiences } from './role-experiences.js';
import { formatIssues } from './reply-style.js';
import { healthDate,healthSettings } from './unattended-health.js';

/** 任务和入站回复共享同一个工作流、身份校验、公开额度及浏览器串行入口。 */
export function productionTaskHandlers(workflow:Workflow){
 const {store,transport,generator}=workflow;
 const recordFormat=(runId:string,text:string)=>{const format={issues:formatIssues(text)};store.set('task-result:'+runId,JSON.stringify({format}));return format;};
 const postSideEffects=(row:{id:string;account_id:string;text:string},receipt:any)=>{
  if(receipt?.status==='confirmed')try{workflow.services.memory?.recordExperience({accountId:row.account_id,userId:'role',channel:'public',kind:'post',text:row.text.slice(0,1200),receipt});}catch{/* 遗忘或来源变更不改变平台回执。 */}
  if(receipt?.status==='rejected'&&!store.get('post-rejection-effects:'+row.id)){
   workflow.rejectChannel('public');if(receipt.rejectionKind==='automation'||/自动化|automat/i.test(receipt.reason??''))workflow.services.health?.recordAutomationBlock(row.account_id,'public');
   store.set('post-rejection-effects:'+row.id,String(Date.now()));
  }
 };

 const execute=async(id:TaskId,ctx:TaskContext):Promise<TaskOutcome>=>workflow.taskOperation(ctx.source,async(signal)=>{
  const {daily,memory,persona,outbox,program}=workflow.services;
  const abort=AbortSignal.any([signal,ctx.signal]);
  const allowed=()=>!abort.aborted&&ctx.ensureEnabled();
  if(!allowed())return {status:'cancelled'};
  if(id==='daily-state'){
   if(!daily)throw new Error('日程服务不可用');
   const result=await daily.ensure(ctx.accountId,{manual:ctx.source==='manual',signal:abort,interactionId:ctx.runId});
   if(!result.state)throw new Error('当日日程尚未生成：'+result.status);
   return {status:'completed',callIds:result.state.callId&&result.state.interactionId===ctx.runId?[result.state.callId]:[],detail:result.status};
  }
  if(id==='memory-summary'){
   if(!memory)throw new Error('记忆服务不可用');
   for(const row of memory.due(ctx.accountId,1,20)){
    if(!allowed())break;
    await memory.summarize(row.userId,row.channel,ctx.accountId,{signal:abort,sessionId:workflow.modelSession(row.userId,row.channel),interactionId:ctx.runId});
   }
   const rows=store.db.prepare('SELECT id FROM llm_calls WHERE interaction_id=?').all(ctx.runId) as any[];
   const calls=rows.map(row=>row.id);
   return {status:allowed()?'completed':'cancelled',callIds:calls,detail:calls.length?'已整理存在新增的记忆':'没有新增待整理记录'};
  }
  if(!['morning-post','evening-post'].includes(id))throw new Error('不支持的应用任务');
  if(!persona||!daily||!outbox||!transport.post||!transport.lookupPost)throw new Error('发帖服务不可用');
  const c=structuredClone(workflow.config()),snapshot=persona.get().persona;
  const valid=()=>allowed()&&workflow.control()==='running'&&c.mode==='auto'&&workflow.accountId()===ctx.accountId&&Date.now()>=ctx.scheduledAt&&Date.now()-ctx.scheduledAt<=5*60000;
  if(!valid())return {status:'cancelled'};
  const identity=await transport.identity();if(loggedInHandle(identity)!==ctx.accountId){await workflow.safetyPause('任务执行时登录身份发生变化');return {status:'cancelled'};}
  const existing=outbox.source(ctx.accountId,'post',ctx.runId);
  if(existing){
   const format=recordFormat(ctx.runId,existing.text);
   if(existing.status==='confirmed'){const receipt=existing.receipt?JSON.parse(existing.receipt):null;postSideEffects(existing,receipt);return {status:'completed',outboxId:existing.id,receipt,format};}
   if(existing.status==='rejected'){const receipt=existing.receipt?JSON.parse(existing.receipt):{status:'rejected',reason:'平台已拒绝原出站'};postSideEffects(existing,receipt);return {status:'skipped',outboxId:existing.id,receipt,format};}
   if(existing.status==='cancelled')return {status:'skipped',outboxId:existing.id,format,detail:'出站已取消，保留冻结正文和校验结果'};
   if(existing.status!=='prepared'){const receipt=await transport.lookupPost(existing.text,ctx.accountId,existing.id,{signal:abort});const settled=outbox.settle(existing.id,receipt),final=settled.receipt?JSON.parse(settled.receipt):receipt;postSideEffects(settled,final);return {status:final.status==='confirmed'?'completed':final.status==='not_submitted'||final.status==='rejected'?'skipped':'unknown',outboxId:existing.id,receipt:final,format};}
  }
  if(workflow.channelWaitReason('public',c))return {status:'skipped',detail:'公开通道小时／每日额度、退避或待回查限制'};
  const interactionId=ctx.runId||randomUUID(),callIds:string[]=[];
  const state=await daily.ensure(ctx.accountId,{signal:abort,interactionId:ctx.runId});if(state.state?.callId&&state.state.interactionId===ctx.runId)callIds.push(state.state.callId);
  const assembled=await persona.assemble({config:c,persona:snapshot,message:id==='morning-post'?'请生成一条符合人格和当日虚构日程的简短早安公开帖子。':'请生成一条符合人格和当日虚构日程的简短晚安公开帖子。',channel:'public',accountId:ctx.accountId,experiences:recallRoleExperiences(store,ctx.accountId),postVariety:true,dailyState:state.state?.content??'暂无当日日程',signal:abort,interactionId,now:Date.now(),recentReplies:recentReplySamples(store,ctx.accountId,'public'),promptHints:c.promptHints,lengthRule:postingLimitPrompt('post',workflow.services.posting?.get().post,ctx.accountId)});
  for(const call of assembled.calls)if(call.callId)callIds.push(call.callId);
  const result=await generator.complete(c,assembled.system,assembled.user,abort,undefined,{purpose:id,source:'task',accountId:ctx.accountId,channel:'public',interactionId});if(result.callId)callIds.push(result.callId);
  const draft=parseDraft(result.text,{channel:'public'});
  if(draft.action==='skip')return {status:'skipped',callIds,format:recordFormat(ctx.runId,existing?.text??draft.text),detail:'模型选择跳过'};
  const capability=workflow.services.posting?.get().post,validation=validatePostingText(draft.text,'post',{accountId:ctx.accountId,capability});
  let format=recordFormat(ctx.runId,existing?.text??draft.text);
  if(!validation.allowed){const candidate=outbox.prepare({accountId:ctx.accountId,kind:'post',sourceId:ctx.runId,text:draft.text,capability});format=recordFormat(ctx.runId,candidate.text);outbox.cancel(candidate.id);return {status:'skipped',callIds,format,outboxId:candidate.id,detail:validation.reason??'帖子超过当前账号字数限制'};}
  if(!valid())return {status:'cancelled',callIds,format};
  if(loggedInHandle(await transport.identity())!==ctx.accountId){await workflow.safetyPause('帖子生成期间登录身份变化');return {status:'cancelled',callIds,format};}
  if(!valid()||workflow.channelWaitReason('public',c))return {status:'cancelled',callIds,format};
  const row=outbox.prepare({accountId:ctx.accountId,kind:'post',sourceId:ctx.runId,text:draft.text,capability});
  format=recordFormat(ctx.runId,row.text);
  // 调度记录先关联出站，再跨越浏览器提交边界，重启可找到冻结正文。
  store.db.prepare('UPDATE task_runs SET outbox_id=?,call_ids=? WHERE id=?').run(row.id,JSON.stringify(callIds),ctx.runId);
  if(!valid()){outbox.cancel(row.id);return {status:'cancelled',callIds,format,outboxId:row.id};}
  if(!outbox.begin(row.id,capability))return {status:'unknown',callIds,format,outboxId:row.id};
  let receipt;
  try{receipt=program?await program.run('sending',{taskId:ctx.runId,accountId:ctx.accountId,channel:'public'},()=>transport.post!(row.text,ctx.accountId,row.id,{signal:abort}),abort):await transport.post(row.text,ctx.accountId,row.id,{signal:abort});}catch{receipt={status:'unknown' as const,reason:'帖子提交结果未知，等待回查'};}
  const settled=outbox.settle(row.id,receipt);receipt=settled.receipt?JSON.parse(settled.receipt):{status:'unknown'};
  postSideEffects(settled,receipt);
  return {status:receipt.status==='confirmed'?'completed':receipt.status==='rejected'||receipt.status==='not_submitted'?'skipped':'unknown',callIds,outboxId:row.id,receipt,format};
 });
 const lookup=async(run:TaskRun,source:'automatic'|'manual'='manual'):Promise<TaskOutcome>=>workflow.taskOperation(source,async()=>{
  const outbox=workflow.services.outbox,row=run.outboxId?outbox?.get(run.outboxId):undefined;
  if(!row||row.account_id!==workflow.accountId()||!transport.lookupPost)return {status:'unknown'};
  if(loggedInHandle(await transport.identity())!==row.account_id)return {status:'unknown'};
  const format=recordFormat(run.id,row.text);
  if(row.status==='rejected'){const receipt=row.receipt?JSON.parse(row.receipt):{status:'rejected',reason:'平台已拒绝原出站'};postSideEffects(row,receipt);return {status:'skipped',outboxId:row.id,receipt,format};}
  if(row.status==='cancelled')return {status:'skipped',outboxId:row.id,format,detail:'出站已取消，不能重新提交'};
  if(row.status==='confirmed'){const receipt=row.receipt?JSON.parse(row.receipt):null;postSideEffects(row,receipt);return {status:'completed',outboxId:row.id,receipt,format};}
  let receipt=await transport.lookupPost(row.text,row.account_id,row.id);const settled=outbox!.settle(row.id,receipt);receipt=settled.receipt?JSON.parse(settled.receipt):receipt;postSideEffects(settled,receipt);
  return {status:receipt.status==='confirmed'?'completed':receipt.status==='not_submitted'||receipt.status==='rejected'?'skipped':'unknown',outboxId:row.id,receipt,format};
 });
 const observe=async(id:'daily-report'|'account-check',ctx:TaskContext):Promise<TaskOutcome>=>{
  const health=workflow.services.health;if(!health)throw new Error('健康服务不可用');
  if(id==='daily-report'){
   if(!ctx.ensureEnabled())return {status:'cancelled'};
   const account=ctx.accountId==='system'?'':ctx.accountId,report=health.generateReport(healthDate(ctx.scheduledAt-86400000),account);
   return {status:'completed',detail:'已生成 '+report.date+' 运行日报（不调用模型）'};
  }
  return workflow.taskOperation(ctx.source,async signal=>{
   if(workflow.control()==='manual'||workflow.control()==='draining')return {status:'cancelled',detail:'人工接管或排空期间推迟账号检查'};
   if(ctx.source==='automatic'&&workflow.control()!=='running')return {status:'cancelled'};
   if(!transport.compliance)throw new Error('浏览器尚未提供只读合规接口');
   const abort=AbortSignal.any([signal,ctx.signal]);if(abort.aborted||!ctx.ensureEnabled())return {status:'cancelled'};
   const current=await transport.identity({signal:abort});if(current.restricted){await workflow.safetyPause('当前工作账号受限：'+current.restricted);return {status:'cancelled',detail:'账号受限，需要人工处理'};}
   if(loggedInHandle(current)!==ctx.accountId)throw new Error('检查账号与当前登录身份不符');
   const observation=await transport.compliance(ctx.accountId,{signal:abort});if(observation.accountId!==ctx.accountId)throw new Error('合规检查响应账号不符');
   if(abort.aborted||!ctx.ensureEnabled())return {status:'cancelled'};
   const result=health.saveCompliance(observation,healthSettings(workflow.config().health).requiredPhrases);
   await workflow.sampleHealth(true);
   return {status:'completed',detail:result.disclosure==='confirmed'&&result.automatedLabel==='confirmed'&&result.qualityFilter==='off'?'只读合规检查通过':'只读检查完成，请查看账号披露、标签及过滤提示'};
  });
 };
 return {execute,lookup,observe};
}
