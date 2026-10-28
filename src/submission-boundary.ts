import type {Receipt} from './types.js';
import {validatePostingText,type PostingValidation} from './posting-policy.js';
import {BrowserOperationError,browserOperationReason,safeBrowserDiagnostic,type BrowserDiagnostic,type BrowserOperationCode,type BrowserOperationStage} from './browser-operation.js';

export type SubmissionBinding={requestId:string;kind:'reply'|'dm'|'post';handle:string;targetId:string;text:string};
type Intent={kind:'reply'|'dm'|'post';handle:string;targetId:string;textHash:string;at:number;receipt:Receipt};
type Dependencies={intent:(id:string)=>Intent|undefined;previous:(binding:SubmissionBinding)=>Receipt|undefined;block:(binding:SubmissionBinding,validation:PostingValidation)=>Receipt};
export type DiagnosticValidation=PostingValidation&{diagnostic:BrowserDiagnostic};
/** 只跟踪这一次已经绑定的新调用。不能通过缺少 journal 为历史 unknown 补造“未提交”。 */
export class SubmissionAttempt {
 stage:BrowserOperationStage='request';intentStarted=false;timedOut=false;finished=false;
 readonly historical:boolean;readonly previous?:Receipt;private persistenceFailed=false;
 constructor(readonly binding:SubmissionBinding,private deps:Dependencies){
  if(!/^[A-Za-z0-9:_-]{1,250}$/.test(binding.requestId)||!/^[A-Za-z0-9_]{1,15}$/.test(binding.handle)||!['reply','dm','post'].includes(binding.kind)||typeof binding.text!=='string'||binding.kind!=='post'&&!binding.targetId)throw new BrowserOperationError('invalid-request','request');
  this.historical=!!deps.intent(binding.requestId);this.intentStarted=this.historical;
  // 原提交意图优先；已有 intent 的请求不得读取另一终态，更不能重新校验后改写它。
  if(!this.historical)this.previous=deps.previous(binding);
 }
 setStage(stage:BrowserOperationStage){this.stage=stage;}
 beforeIntent(){this.stage='intent-save';this.intentStarted=true;}
 markTimedOut(){this.timedOut=true;}
 markFinished(){this.finished=true;}
 private diagnostic(error:unknown):BrowserDiagnostic {
  const known=safeBrowserDiagnostic(error,this.stage);if(known.code!=='unknown-error')return known;
  const restricted=(error as any)?.restricted;
  const code:BrowserOperationCode=restricted?'account-restricted':this.timedOut?'operation-timeout':this.intentStarted?'submission-incomplete':this.stage==='control'?'control-unavailable':this.stage==='identity'?'identity-unavailable':'pre-submit-failed';
  return {code,stage:this.stage};
 }
 private persist(diagnostic:BrowserDiagnostic,original?:PostingValidation):Receipt {
  if(this.persistenceFailed)throw new BrowserOperationError('preflight-persistence-failed',this.stage);
  if(this.historical||this.intentStarted||this.deps.intent(this.binding.requestId))throw new BrowserOperationError('submission-incomplete',this.stage);
  const current=this.deps.previous(this.binding);if(current)return current;
  const validation:DiagnosticValidation={...(original??validatePostingText(this.binding.text,this.binding.kind,{accountId:this.binding.handle})),allowed:false,code:diagnostic.code,reason:browserOperationReason(diagnostic.code),diagnostic};
  try{return this.deps.block(this.binding,validation);}catch{this.persistenceFailed=true;throw new BrowserOperationError('preflight-persistence-failed',this.stage);}
 }
 block(validation:PostingValidation):Receipt {
  if(this.timedOut)throw new BrowserOperationError('operation-timeout',this.stage);
  const recognized=safeBrowserDiagnostic(validation,this.stage),diagnostic=recognized.code==='unknown-error'?{code:'pre-submit-failed' as const,stage:this.stage}:recognized;
  // 既有长度/内容错误保留原计数与错误码；新增阶段诊断单独写入有限字段。
  const current=this.deps.previous(this.binding);if(current)return current;
  if(this.intentStarted||this.historical||this.deps.intent(this.binding.requestId))throw new BrowserOperationError('submission-incomplete',this.stage);
  try{return this.deps.block(this.binding,{...validation,diagnostic} as DiagnosticValidation);}catch{this.persistenceFailed=true;throw new BrowserOperationError('preflight-persistence-failed',this.stage);}
 }
 /** 普通前置异常在当前 await 已退出后收束；超时分支必须等整个旧操作结束。 */
 fail(error:unknown):Receipt|undefined {
  if(this.timedOut||this.historical||this.intentStarted||this.deps.intent(this.binding.requestId))return;
  return this.persist(this.diagnostic(error));
 }
 safeFailure(error:unknown):BrowserDiagnostic {return this.persistenceFailed?{code:'preflight-persistence-failed',stage:this.stage}:this.diagnostic(error);}
 /** Serial.afterTimeout 调用；只有旧 fn 已退出且从未开始保存 intent 才能写终态。 */
 finishTimedOut():Receipt|undefined {
  if(!this.timedOut||!this.finished||this.historical||this.intentStarted||this.deps.intent(this.binding.requestId))return;
  return this.persist({code:'operation-timeout',stage:this.stage});
 }
}
