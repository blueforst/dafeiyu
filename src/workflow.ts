import { Store } from './store.js';
import { createHash,randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { parseDraft,type Generator } from './model.js';
import type { Transport } from './transport.js';
import type { Config,Event,Receipt,Identity,Channel } from './types.js';
import type { Program } from './program.js';
import type { PersonaService } from './persona.js';
import type { DailyStateService } from './daily-state.js';
import type { MemoryService } from './memory.js';
import type { Outbox } from './outbox.js';
import type { TaskScheduler } from './scheduler.js';

import { beijingDayStart,type ReplyTriage } from './reply-triage.js';
import type { PostingCapabilitiesService } from './posting-capabilities.js';
import { normalizePublicText,validatePostingText,postingLimitPrompt,rpcResourceOK } from './posting-policy.js';
import { recentReplySamples } from './reply-hints.js';
import { assembleReplyPrompt } from './reply-prompt.js';
import { captureGenerationSnapshot,pruneReplayData } from './persona-replay.js';
import { RoundBudget,WorkflowWatchdog,healthSettings,type RuntimeHealth } from './unattended-health.js';
import {safeBrowserDiagnostic} from './browser-operation.js';
import {failureSummary} from './failure-summary.js';
import type {ManualImportsService} from './manual-imports.js';
import type {RoleExperienceService} from './role-experiences.js';

export function loggedInHandle(identity:Identity):string {
 const handle=String(identity.handle||'').trim().replace(/^@/,'').toLowerCase();
 return identity.loggedIn&&!identity.needsHuman&&!identity.restricted&&/^[a-z0-9_]{1,15}$/.test(handle)?handle:'';
}
type Services={program?:Program;persona?:PersonaService;daily?:DailyStateService;memory?:MemoryService;outbox?:Outbox;scheduler?:TaskScheduler;triage?:ReplyTriage;posting?:PostingCapabilitiesService;health?:RuntimeHealth;manualImports?:ManualImportsService;experiences?:RoleExperienceService};
export class Workflow {
 busy=false;abort?:AbortController;lastTick=0;nextTick=0;timer?:ReturnType<typeof setTimeout>;services:Services={};
 private startedAt=0;private watchdogTimer?:ReturnType<typeof setInterval>;private wakeRequested=false;
 private activeHandle='';private stopped=false;private schedulerActive=false;private roundCalls=new Set<string>();private roundId='';
 constructor(public store:Store,public transport:Transport,public generator:Generator,public config:()=>Config=loadConfig){}
 accountId(){return this.activeHandle||this.store.get('activeAccount');}
 modelSession(userId:string,visibility:Channel){
  let namespace=this.store.get('model:sessionNamespace');if(!namespace){namespace=randomUUID();this.store.set('model:sessionNamespace',namespace);}
  return 'role-workflow-'+createHash('sha256').update(JSON.stringify([namespace,this.activeHandle,userId,visibility,this.store.epoch(userId,this.activeHandle)])).digest('hex');
 }
 control(){return this.store.get('control','paused');}
 start(){
  if(this.timer)return;this.stopped=false;
  const loop=async()=>{this.timer=undefined;this.nextTick=0;try{await this.tick();}catch{this.store.log('tick-error','工作轮次异常，详见阶段状态','error');}if(!this.stopped){const ms=this.wakeRequested?1000:this.configSafeInterval();this.wakeRequested=false;this.nextTick=Date.now()+ms;this.timer=setTimeout(loop,ms);}};
  this.nextTick=Date.now()+2000;this.timer=setTimeout(loop,2000);
  if(!this.watchdogTimer){const watchdog=new WorkflowWatchdog({snapshot:()=>({control:this.control(),busy:this.busy,startedAt:this.startedAt,nextTick:this.nextTick,hasTimer:!!this.timer,stopped:this.stopped}),restoreSchedule:()=>{if(!this.busy&&!this.timer)this.start();},abortCurrent:()=>this.abort?.abort(),safetyPause:r=>{this.store.set('watchdogFailure:'+this.accountId(),'1');return this.safetyPause(r);},log:(e,d)=>this.store.log(e,d,'warn'),hardTimeoutMs:()=>healthSettings(this.config().health).hardTimeoutMinutes*60000});this.watchdogTimer=setInterval(()=>{void watchdog.check().catch(()=>{});void this.services.scheduler?.tickObservability().catch(()=>{});void this.sampleHealth(true);},30000);this.watchdogTimer.unref?.();}
 }
 wake(){if(this.control()!=='running'||this.stopped)return;if(this.busy){this.wakeRequested=true;return;}clearTimeout(this.timer);this.timer=undefined;this.nextTick=0;this.start();}
 configSafeInterval(){try{return this.config().pollSeconds*1000;}catch{return 60000;}}
 stop(){this.stopped=true;clearInterval(this.watchdogTimer);this.watchdogTimer=undefined;clearTimeout(this.timer);this.timer=undefined;this.services.scheduler?.cancelBusiness();this.abort?.abort();}
 async waitIdle(){const until=Date.now()+100000;while(this.busy||this.services.scheduler?.busy){if(Date.now()>until)throw new Error('当前操作尚未结束，继续保持暂停');await new Promise(r=>setTimeout(r,100));}}
 private async drain(target:'paused'|'manual'){
  this.store.set('control','draining');this.services.scheduler?.cancelBusiness();this.abort?.abort();
  try{await this.waitIdle();await this.transport.control(target);this.store.set('control',target);this.services.health?.recordControl(target,this.accountId());}
  catch(e){this.store.set('control','paused');await this.transport.control('paused').catch(()=>{});this.store.log('control-error','控制操作失败，已保持暂停，可重新尝试','error');throw e;}
 }
 async pause(){await this.drain('paused');this.store.log('pause','自动处理已暂停');}
 async takeover(){await this.drain('manual');this.store.log('takeover','已移交人工；自动任务停止');}
 async release(){if(this.control()!=='manual')throw new Error('当前不处于人工接管');try{await this.transport.control('paused');}finally{this.store.set('control','paused');}this.services.posting?.invalidate('人工接管已释放，能力需重新确认');this.services.health?.recordControl('paused',this.accountId());this.store.log('release','人工连接已关闭，等待显式恢复');}
 async resume(){
  if(this.control()==='manual')throw new Error('请先释放人工接管');if(this.control()==='draining')throw new Error('正在排空，请稍后重试');
  await this.waitIdle();const c=this.config(),handle=loggedInHandle(await this.transport.identity());if(!handle)throw new Error('请先登录 X 并完成人工验证');
  await this.transport.control('auto');this.store.set('watchdogFailure:'+handle,'0');this.activeHandle=handle;this.store.set('activeAccount',handle);this.store.set('control','running');this.services.health?.recordControl('running',handle);this.store.log('resume',JSON.stringify({accountId:handle,mode:c.mode}));
 }
 async safetyPause(reason:string){this.store.set('control','paused');this.services.posting?.invalidate(reason);this.services.health?.recordControl('paused',this.accountId());await this.transport.control('paused').catch(()=>{});this.store.log('safety-pause',reason,'error');}
 cooldown(channel:Channel){return Number(this.store.get('cooldown:'+channel+':'+this.accountId(),this.store.get('cooldown:'+channel,'0')));}
 sentCount(channel:Channel){
  const account=this.accountId();if(!this.services.outbox)return this.store.sentCount(channel,account);
  const legacy=Number((this.store.db.prepare("SELECT COUNT(*) n FROM messages m WHERE m.account_id=? AND m.channel=? AND m.status IN ('confirmed','sending','unknown') AND m.updated_at>? AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.account_id=m.account_id AND o.source_id=m.id)").get(account,channel,Date.now()-3600000) as any).n);
  return this.services.outbox.count(channel,account)+legacy;
 }
 rejectChannel(channel:Channel){const until=String(Date.now()+4*3600000);this.store.set('cooldown:'+channel+':'+this.accountId(),until);this.store.set('cooldown:'+channel,until);this.store.log('cooldown',JSON.stringify({channel,accountId:this.accountId(),until:Number(until)}),'warn');}
 async taskOperation<T>(source:'automatic'|'manual',fn:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.busy){if(source==='automatic'&&this.schedulerActive)return fn(this.abort!.signal);throw new Error('主程序正在处理，请稍后执行任务');}
  this.busy=true;this.abort=new AbortController();try{return await fn(this.abort.signal);}finally{this.busy=false;this.abort=undefined;}
 }
 private async stage<T>(name:string,roundId:string,fn:()=>Promise<T>,event?:Event):Promise<T>{
  try{const value=this.services.program?await this.services.program.run(name,{roundId,messageId:event?.id,channel:event?.channel,accountId:this.accountId()},fn,this.abort?.signal):await fn();const result=value as any;if(result?.callId)this.roundCalls.add(result.callId);for(const call of result?.calls??[])if(call.callId)this.roundCalls.add(call.callId);if(result?.state?.interactionId===this.roundId&&result.state.callId)this.roundCalls.add(result.state.callId);return value;}
  catch(error){if(typeof (error as any)?.callId==='string')this.roundCalls.add((error as any).callId);throw error;}
 }
 private async reconcile(handle:string,roundId:string){
  for(const row of this.store.unknown(handle)){
   const e=JSON.parse(row.body) as Event,d=JSON.parse(row.draft||'{}');if(!d.text)continue;
   if(this.services.outbox?.source(handle,e.channel==='public'?'reply':'dm',e.id))continue;
   const r=await this.stage('lookup',roundId,()=>this.transport.lookup(e,d.text,handle),e);
   if(r.status==='confirmed')this.store.update(e.id,'confirmed',{receipt:r});else if(r.status==='rejected'){this.store.update(e.id,'failed',{receipt:r,error:r.reason});this.rejectChannel(e.channel);}else if(r.status==='not_submitted')this.store.update(e.id,'draft',{receipt:r,error:r.reason});
  }
  for(const row of this.services.outbox?.pendingUnknown(handle)??[]){
   let r:Receipt={status:'unknown'};
   if(row.kind==='post'&&this.transport.lookupPost)r=await this.stage('lookup',roundId,()=>this.transport.lookupPost!(row.text,handle,row.id));
   else if(row.event){const e={...JSON.parse(row.event),outboxId:row.id};r=await this.stage('lookup',roundId,()=>this.transport.lookup(e,row.text,handle),e);}
   this.services.outbox!.settle(row.id,r);if(r.status==='rejected')this.rejectChannel(row.channel);
   if(row.kind!=='post'&&r.status!=='unknown'){this.store.update(row.source_id,r.status==='confirmed'?'confirmed':r.status==='not_submitted'?'draft':'failed',{receipt:r,error:r.reason});if(r.status==='confirmed'&&row.event)try{const e=JSON.parse(row.event);this.services.memory?.recordExperience({accountId:handle,userId:e.userId,channel:e.channel,text:row.text.slice(0,1200),kind:'interaction',sourceMessageId:row.source_id,receipt:r});}catch{}}else if(row.kind==='post'&&r.status==='confirmed')try{this.services.memory?.recordExperience({accountId:handle,userId:'role',channel:'public',text:row.text.slice(0,1200),kind:'post',receipt:r});}catch{}
  }
 }
 async sampleHealth(readBrowser=false){
  if(!this.services.health)return;
  try{
   const c=this.config(),host=this.services.scheduler?.host,hostHealth=host?.latest('health'),result=hostHealth?.result as any;
   const browser=readBrowser&&this.transport.health?await this.transport.health().catch(()=>null):this.services.health.get(this.accountId()).browser;
   if(this.stopped&&readBrowser)return;
   this.services.health.evaluate({accountId:this.accountId(),control:this.control(),mode:c.mode,identity:JSON.parse(this.store.get('identity','null'))??undefined,cooldown:{public:this.cooldown('public'),private:this.cooldown('private')},publicPerHour:c.publicPerHour,privatePerHour:c.privatePerHour,publicPerDay:c.publicPerDay,maxAgeHours:c.maxAgeHours,pendingByChannel:this.services.triage?.healthQueue(this.accountId(),c.maxAgeHours),sendableChannels:{public:!this.channelWaitReason('public',c),private:!this.channelWaitReason('private',c)},watchdogFailure:this.store.get('watchdogFailure:'+this.accountId())==='1',backup:host?.latest('backup'),certificateHoursRemaining:typeof result?.certificateHoursRemaining==='number'?result.certificateHoursRemaining:null,browser});
  }catch{if(!this.stopped)this.store.log('health-evaluation-error','健康快照计算失败','warn');}
 }
 channelWaitReason(channel:Channel,c=this.config(),sending=true,excludeUnsubmittedId?:string):string|null {
  if(this.cooldown(channel)>Date.now())return 'cooldown';
  if(this.store.db.prepare("SELECT 1 FROM messages WHERE account_id=? AND channel=? AND status='unknown' LIMIT 1").get(this.accountId(),channel)||(this.services.outbox&&this.store.db.prepare("SELECT 1 FROM outbox WHERE account_id=? AND channel=? AND status IN ('submitting','unknown') LIMIT 1").get(this.accountId(),channel)))return 'unknown-pending';
  const excluded=excludeUnsubmittedId?this.store.getMessage(excludeUnsubmittedId,this.accountId()):undefined;
  const reserved=excluded?.status==='sending'&&!this.services.outbox?.source(this.accountId(),channel==='public'?'reply':'dm',excluded.id);
  const hourlyAdjustment=reserved&&excluded.updated_at>Date.now()-3600000?1:0,dailyAdjustment=reserved&&excluded.updated_at>=beijingDayStart(Date.now())?1:0;
  if(sending&&(this.sentCount(channel)-hourlyAdjustment>=(channel==='public'?c.publicPerHour:c.privatePerHour)||(channel==='public'&&this.services.triage&&this.services.triage.dailyCount(this.accountId())-dailyAdjustment>=(c.publicPerDay??180))))return 'quota';
  return null;
 }
 private async generateDraft(e:Event,c:Config,persona:any,memoryPolicy:any,daily:any,roundId:string,merged:Event[]=[]){
  const rawContext=await this.stage('context',roundId,()=>this.transport.context(e,this.accountId(),{signal:this.abort?.signal}),e);
  const conversation=merged.length?{current:rawContext,previousMessages:merged.map(x=>({id:x.platformId,text:x.text,timestamp:x.timestamp}))}:rawContext;
  const memory=await this.stage('memory',roundId,async()=>this.services.memory?this.services.memory.context(e.userId,e.channel,this.accountId(),Date.now(),memoryPolicy):this.store.context(e.userId,e.channel,this.accountId()),e);
  const session=this.modelSession(e.userId,e.channel),recentReplies=recentReplySamples(this.store,this.accountId(),e.channel,e.conversationId);
  const input={config:c,persona,message:e.text,channel:e.channel,accountId:this.accountId(),conversation,memory,dailyState:daily?.state?.content??'暂无当日日程',mediaUnavailable:e.mediaUnavailable,quote:e.quote,card:e.card,signal:this.abort!.signal,sessionId:session,interactionId:e.id,now:Date.now(),timestamp:e.timestamp,timestampReliable:e.timestampReliable===true,conversationId:e.conversationId,recentReplies,promptHints:c.promptHints,lengthRule:postingLimitPrompt(e.channel==='public'?'reply':'dm',this.services.posting?.get().reply,this.accountId())};
  const assembled=this.services.persona?await this.stage(persona?.triggers.some((t:any)=>t.enabled&&t.match!=='keywords')?'semantic-trigger':'prompt',roundId,()=>this.services.persona!.assemble(input),e):assembleReplyPrompt({...input,staticText:c.persona,settings:c.promptHints});
  captureGenerationSnapshot(this.store,e,{conversation,memory,hintMeta:assembled.meta,dailySlot:input.dailyState,personaRevision:this.services.persona?.get().revision});
  const result=await this.stage('generation',roundId,()=>this.generator.complete(c,assembled.system,assembled.user,this.abort!.signal,session,{purpose:'reply',source:'workflow',accountId:this.accountId(),channel:e.channel,interactionId:e.id}),e);
  const draft=parseDraft(result.text,{channel:e.channel});if(e.channel==='public')draft.text=normalizePublicText(draft.text);
  draft.meta={...assembled.meta,callId:result.callId};
  const validation=draft.action==='reply'?validatePostingText(draft.text,e.channel==='public'?'reply':'dm',{accountId:this.accountId(),capability:this.services.posting?.get().reply}):undefined;
  if(validation)draft.validation=validation;
  return {draft,result,validation};
 }
 private async sendDraft(e:Event,text:string,handle:string,roundId:string,c:Config,callId?:string,approved=false){
  const epoch=this.store.epoch(e.userId,handle);
  const restore=()=>{if(approved&&this.store.getMessage(e.id)?.status==='sending')this.store.update(e.id,'approved');};
  if(this.control()!=='running'||this.abort?.signal.aborted){restore();return;}
  if(e.timestampReliable===false||!Number.isFinite(e.timestamp)||!e.timestamp||(this.services.outbox&&!e.platformId)){restore();this.store.log('message-validation',JSON.stringify({id:e.id,channel:e.channel,reason:'缺少可靠时间或平台标识'}),'warn');return;}
  if(Date.now()-e.timestamp>c.maxAgeHours*3600000){this.store.update(e.id,'skipped',{error:'超时未发送'});return;}
  const waitReason=this.channelWaitReason(e.channel,c,true,approved?e.id:undefined);if(waitReason){restore();return;}
  if(loggedInHandle(await this.transport.identity())!==handle){restore();await this.safetyPause('生成期间登录状态或账号已变化，草稿未发送');return;}
  if(this.control()!=='running'||this.abort?.signal.aborted){restore();return;}
  if(!this.store.getMessage(e.id,handle)||this.store.forgotten(e.userId,handle)||this.store.epoch(e.userId,handle)!==epoch){restore();return;}
  const capability=this.services.posting?.get().reply,validation=validatePostingText(text,e.channel==='public'?'reply':'dm',{accountId:handle,capability});
  if(!validation.allowed){const row=this.store.getMessage(e.id);this.store.update(e.id,'draft',{draft:{...JSON.parse(row.draft),validation},error:validation.reason});return;}
  const kind=e.channel==='public'?'reply':'dm',existing=this.services.outbox?.source(handle,kind,e.id);
  if(existing?.status==='prepared'&&existing.text!==text)this.services.outbox!.retext(existing.id,text);
  const outbox=this.services.outbox?.prepare({accountId:handle,kind,sourceId:e.id,targetId:e.platformId,event:e,text,capability});
  const sending={...e,...(outbox?{outboxId:outbox.id}:{})};
  if(!rpcResourceOK({event:sending,text,handle,requestId:outbox?.id??e.id,runtimeHealth:healthSettings(c.health)})){const invalid={...validation,allowed:false,code:'rpc-resource-limit',reason:'完整浏览器请求超过资源保护边界'};if(outbox){this.store.db.prepare("UPDATE outbox SET validation_json=? WHERE id=? AND status='prepared'").run(JSON.stringify(invalid),outbox.id);this.services.outbox!.cancel(outbox.id);}const row=this.store.getMessage(e.id);if(row)this.store.update(e.id,'draft',{draft:{...JSON.parse(row.draft??'{}'),validation:invalid},error:'完整浏览器请求超过资源保护边界，未提交'});return;}
  if(outbox){if(outbox.status==='prepared'&&outbox.text!==text)this.services.outbox!.retext(outbox.id,text);this.services.outbox!.validate(outbox.id,capability);if(!this.services.outbox!.begin(outbox.id,capability)){restore();return;}}
  this.store.update(e.id,'sending');let receipt:Receipt;
  try{receipt=await this.stage('sending',roundId,()=>this.transport.send(sending,text,handle,{signal:this.abort?.signal}),e);}catch(error){receipt={status:'unknown',reason:'提交结果未知，等待回查；'+failureSummary(error,'未取得可靠提交回执')};if((error as any)?.browserPaused)await this.safetyPause('浏览器已安全暂停，请检查后显式恢复');}
  if(outbox){const settled=this.services.outbox!.settle(outbox.id,receipt);receipt=settled.receipt?JSON.parse(settled.receipt):{status:'unknown'};}
  this.store.update(e.id,receipt.status==='confirmed'?'confirmed':receipt.status==='rejected'?'failed':receipt.status==='not_submitted'?'draft':'unknown',{receipt,error:receipt.reason});
  if(receipt.status==='confirmed'&&this.services.memory)try{this.services.memory.recordExperience({accountId:handle,userId:e.userId,channel:e.channel,text:text.slice(0,1200),kind:'interaction',sourceMessageId:e.id,receipt});}catch{}
  if(receipt.browserPaused||receipt.restricted)await this.safetyPause(receipt.restricted?'工作账号受到平台限制，请人工检查':'浏览器已安全暂停，请检查后显式恢复');
  if(receipt.status==='rejected'){this.rejectChannel(e.channel);if(/automat|自动化/i.test(receipt.reason??''))this.services.health?.recordAutomationBlock(handle,e.channel);}
  this.store.log('processed',JSON.stringify({id:e.id,channel:e.channel,status:receipt.status,roundId,callId,outboxId:outbox?.id}));
 }
 private async sendApproved(c:Config,handle:string,roundId:string){
  const rows=this.store.db.prepare("SELECT * FROM messages WHERE account_id=? AND status='approved' ORDER BY created_at,id LIMIT 100").all(handle) as any[];
  for(const row of rows){
   if(this.control()!=='running'||this.abort?.signal.aborted)break;
   const e=JSON.parse(row.body) as Event,draft=JSON.parse(row.draft??'{}');
   if(this.store.forgotten(e.userId,handle))continue;
   if(Date.now()-e.timestamp>c.maxAgeHours*3600000){this.store.update(e.id,'skipped',{error:'超时未发送'});continue;}
   const reason=this.channelWaitReason(e.channel,c);if(reason){if(draft.waitReason!==reason)this.store.update(e.id,'approved',{draft:{...draft,waitReason:reason}});continue;}
   const claimed=this.store.db.prepare("UPDATE messages SET status='sending',updated_at=? WHERE id=? AND account_id=? AND status='approved' AND updated_at=?").run(Math.max(Date.now(),row.updated_at+1),row.id,handle,row.updated_at).changes;
   if(!claimed)continue;
   try{await this.sendDraft(e,draft.text,handle,roundId,c,undefined,true);}catch{if(this.store.getMessage(row.id)?.status==='sending')this.store.update(row.id,'draft',{error:'批准发送预检失败，等待人工检查'});}
  }
 }
 async tick(){
  if(this.busy)return;this.busy=true;this.abort=new AbortController();const roundId=randomUUID(),startedAt=Date.now();this.startedAt=startedAt;const budget=new RoundBudget(this.abort,(()=>{try{return this.config().health;}catch{return {};}})());this.roundId=roundId;this.roundCalls=new Set();let mainStarted=false,roundFailed=false;
  try{
   if(this.control()==='running'){
    const c=structuredClone(this.config()),persona=this.services.persona?.get().persona,memoryPolicy=this.services.memory?.policy().policy;
    const identity=await this.stage('identity',roundId,()=>this.transport.identity());this.store.set('identity',JSON.stringify(identity));const handle=loggedInHandle(identity);
    if(!handle||(this.activeHandle&&handle!==this.activeHandle)){await this.safetyPause('登录状态或账号已变化，请检查浏览器后重新恢复');return;}
    this.activeHandle=handle;this.store.set('activeAccount',handle);
    if(this.services.scheduler){this.services.scheduler.recordMainStart(roundId,handle,startedAt);mainStarted=true;}
    const unsettledOutbox=!!this.store.db.prepare("SELECT 1 FROM messages WHERE account_id=? AND status IN ('sending','unknown') LIMIT 1").get(handle)||!!(this.services.outbox&&this.store.db.prepare("SELECT 1 FROM outbox WHERE account_id=? AND status IN ('submitting','unknown') LIMIT 1").get(handle));
    const prepared=this.transport.prepareRound?await this.stage('browser-prepare',roundId,()=>this.transport.prepareRound!(handle,{signal:this.abort!.signal,unsettledOutbox})):undefined;
    await this.reconcile(handle,roundId);if(this.control()!=='running')return;
    if(prepared?.businessBlocked){this.lastTick=Date.now();this.store.set('lastTick',String(this.lastTick));this.store.log('browser-resource-wait',JSON.stringify({roundId,accountId:handle,reason:'pending-recovery-with-protected-session'}),'warn');return;}
    await this.sendApproved(c,handle,roundId);if(!budget.check()||this.control()!=='running')return;
    const daily=this.services.daily?await this.stage('daily-state',roundId,()=>this.services.daily!.ensure(handle,{signal:this.abort!.signal,interactionId:roundId})):null;
    const collected=this.transport.collectPublic&&this.transport.collectPrivate?await (async()=>{
     const publicDeadline=budget.collectionDeadline('public',c.health);
     if(this.services.manualImports)await this.stage('manual-import',roundId,()=>this.services.manualImports!.processRound({signal:this.abort!.signal,deadline:publicDeadline,limit:3}));
     if(this.services.experiences&&this.transport.inspectPost)await this.stage('experience-verify',roundId,()=>this.services.experiences!.verifyPending((url,account,options)=>this.transport.inspectPost!(url,account,{...options,deadline:publicDeadline}),{signal:this.abort!.signal,limit:3,canProcess:()=>budget.check()&&this.control()==='running'&&this.accountId()===handle&&Date.now()<publicDeadline}));
     const publicResult=await this.stage('collect-public',roundId,()=>this.transport.collectPublic!(handle,{signal:this.abort!.signal,deadline:publicDeadline}));
     this.services.health?.recordCollectionResult(handle,roundId,publicResult,'public');
     if(!budget.check()||this.control()!=='running')return publicResult;
     const privateResult=await this.stage('collect-private',roundId,()=>this.transport.collectPrivate!(handle,{signal:this.abort!.signal,deadline:budget.collectionDeadline('private',c.health)})).catch(error=>{
      if((error as any)?.browserPaused||(error as any)?.restricted||this.abort?.signal.aborted)throw error;
      return {events:[] as Event[],warnings:['私信页面读取失败，保留已采集公开消息'],diagnostics:[{channel:'private' as const,source:'chat' as const,status:'failed' as const,code:'private-navigation-failed',eventCount:0}]};
     });
     this.services.health?.recordCollectionResult(handle,roundId,privateResult,'private');
     return {events:[...publicResult.events,...privateResult.events],warnings:[...publicResult.warnings,...privateResult.warnings]};
    })():await this.stage('collect',roundId,async()=>{const result=await this.transport.collect(handle,{signal:this.abort!.signal,deadline:budget.collectionDeadline('public',c.health)});this.services.health?.recordCollectionResult(handle,roundId,result);return result;});
    for(const _warning of collected.warnings)this.store.log('collection-warning',JSON.stringify({roundId,accountId:handle,reason:'页面采集存在异常，请检查浏览器结构'}),'warn');
    await this.stage('queue',roundId,async()=>{for(const e of collected.events){
     if(/^忘(了|记)?我吧[。！!\s]*$/.test(e.text.trim())){this.store.forget(e.userId,handle);continue;}
     if(/^重新记住我[。！!\s]*$/.test(e.text.trim())){this.store.remember(e.userId,handle);continue;}
     if(this.services.triage)this.services.triage.ingest(e,handle,c.maxAgeHours);else this.store.ingest(e,handle);
    }});
    this.services.triage?.refreshQueued(handle,c.maxAgeHours);
    const channels=(['public','private'] as Channel[]).filter(channel=>!this.channelWaitReason(channel,c,c.mode==='auto'));
    const pending=this.services.triage?this.services.triage.pending(c.maxPerRound,handle,channels,c.maxAgeHours):this.store.pending(c.maxPerRound,handle);
    for(const candidate of pending){
     if(!budget.check())break;
     const merged=this.services.triage?.merge(candidate,handle),row=merged?.row??candidate;
     if(this.store.getMessage(row.id)?.status!=='queued')continue;
     if(this.control()!=='running'||this.abort.signal.aborted)break;
     const e=JSON.parse(row.body) as Event;
     if(this.store.forgotten(e.userId,handle))continue;
     if(Date.now()-e.timestamp>c.maxAgeHours*3600000){this.store.update(e.id,'skipped',{error:'普通消息超过处理时效'});continue;}
     if(this.channelWaitReason(e.channel,c,c.mode==='auto'))continue;
     const epoch=this.store.epoch(e.userId,handle);this.services.triage?.consumed(e.id);this.store.update(e.id,'generating');
     try{
      const {draft,result,validation}=await this.generateDraft(e,c,persona,memoryPolicy,daily,roundId,merged?.context??[]);
      if(this.store.forgotten(e.userId,handle)||this.store.epoch(e.userId,handle)!==epoch)continue;
      const previous=JSON.parse(row.draft??'{}'),review=!!previous.review;
      if(draft.action==='skip'){
       this.services.triage?.recordSkip(e,handle,draft.category);
       if(review)this.store.update(e.id,'draft',{draft:{...(previous.previous??previous),review:true,regenNote:draft.reason},error:undefined});
       else this.store.update(e.id,'skipped',{draft});continue;
      }
      if(review)draft.review=true;
      this.store.update(e.id,'draft',{draft,error:validation?.allowed===false?validation.reason:undefined});
      if(c.mode==='draft'&&!this.store.get('observationStartedAt'))this.store.set('observationStartedAt',new Date().toISOString());
      if(review||!validation?.allowed||c.mode!=='auto'||this.control()!=='running'||this.abort.signal.aborted)continue;
      await this.sendDraft(e,draft.text,handle,roundId,c,result.callId);
     }catch(error){
      if((error as any)?.browserPaused)await this.safetyPause('浏览器已安全暂停，请检查后显式恢复');
      roundFailed=true;
      if(this.services.program){const failure=this.services.program.begin('error',{roundId,messageId:e.id,accountId:handle,channel:e.channel});this.services.program.end(failure,this.abort.signal.aborted?'aborted':'failed',error);}
      if(this.store.getMessage(e.id)?.status==='generating')this.store.update(e.id,this.abort.signal.aborted?'queued':'failed',{error:this.abort.signal.aborted?'生成已取消':failureSummary(error,'生成或输出校验失败，请检查调用与阶段记录')});
      this.store.log('generation-error',JSON.stringify({id:e.id,channel:e.channel,roundId,aborted:this.abort.signal.aborted,diagnostic:safeBrowserDiagnostic(error,'request')}),'warn');
     }
    }
    if(this.control()==='running'&&!this.abort.signal.aborted){
     if(this.services.memory){for(const row of this.services.memory.due(handle,5,1))await this.stage('summary',roundId,()=>this.services.memory!.summarize(row.userId,row.channel,handle,{signal:this.abort!.signal,sessionId:this.modelSession(row.userId,row.channel),config:c})).catch(()=>this.store.log('summary-error',JSON.stringify({roundId}),'warn'));}
     else {const due=this.store.db.prepare("SELECT m.user_id,m.channel,count(*) AS n FROM messages m WHERE m.account_id=? AND m.processed_seq>COALESCE((SELECT value FROM runtime WHERE key='summary-seq:'||m.account_id||':'||m.user_id||':'||m.channel),0) GROUP BY m.user_id,m.channel HAVING count(*)>=5 LIMIT 1").get(handle) as any;if(due)await this.summarize(due.user_id,due.channel).catch(()=>this.store.log('summary-error','摘要整理失败','warn'));}
    }
    this.lastTick=Date.now();this.store.set('lastTick',String(this.lastTick));this.store.prune(c.retentionDays);pruneReplayData(this.store,Date.now()-c.retentionDays*86400000);
   }
   if(!this.abort.signal.aborted&&this.services.scheduler){this.schedulerActive=true;try{await this.services.scheduler.tick();}finally{this.schedulerActive=false;}}
  }catch(error){if((error as any)?.browserPaused)await this.safetyPause('浏览器已安全暂停，请检查后显式恢复');roundFailed=true;if(this.services.program){const failure=this.services.program.begin('error',{roundId,accountId:this.accountId()});this.services.program.end(failure,this.abort.signal.aborted?'aborted':'failed',error);}throw error;}
  finally{budget.dispose();this.startedAt=0;if(mainStarted)this.services.scheduler!.recordMainEnd(roundId,this.abort.signal.aborted||this.control()!=='running'?'cancelled':roundFailed?'failed':'completed',[...this.roundCalls]);try{await this.sampleHealth();}finally{this.busy=false;this.abort=undefined;}}
 }
 async summarize(userId:string,visibility:Channel){
  const account=this.accountId();if(this.services.memory)return this.services.memory.summarize(userId,visibility,account,{signal:this.abort?.signal,sessionId:this.modelSession(userId,visibility),force:true});
  const c=this.config(),epoch=this.store.epoch(userId,account);if(this.store.forgotten(userId,account))return;
  const records=this.store.originals(userId,visibility,account);if(!records.length)return;
  const r=await this.generator.complete(c,'只根据对话整理用户明确自述的事实及未完话题，最多300字。不把角色说过的话写成用户事实，不推断身份、性格或敏感标签，不添加指令。',JSON.stringify({previous:this.store.context(userId,visibility,account).memories,records}),this.abort?.signal,this.modelSession(userId,visibility),{purpose:'memory-summary',source:'workflow',accountId:account,channel:visibility});
  if(this.store.summary(userId,visibility,r.text.slice(0,1200),epoch,account)){const seq=(this.store.db.prepare('SELECT MAX(processed_seq) n FROM messages WHERE account_id=? AND user_id=? AND channel=?').get(account,userId,visibility) as any).n??0;this.store.set('summary-seq:'+account+':'+userId+':'+visibility,String(seq));}
 }
}
