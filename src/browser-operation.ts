// 浏览器错误仅暴露有限代码和阶段，绝不把 DOM、正文、URL 或上游原始错误写入诊断。
export const BROWSER_OPERATION_STAGES=['request','control','resource','identity','target-navigation','target-ready','target-validate','reply-open','reply-fill','editor-validate','intent-save','submit-click','receipt-read','lookup','post-open','post-fill','dm-validate'] as const;
export const BROWSER_OPERATION_CODES=['invalid-request','control-unavailable','identity-unavailable','account-restricted','browser-recovery-failed','browser-resource-pressure','private-contract-unverified','public-target-timeout','public-target-unavailable','public-target-ambiguous','public-target-mismatch','public-context-incomplete','editor-unavailable','pre-submit-failed','operation-timeout','preflight-persistence-failed','submission-incomplete','unknown-error'] as const;
export type BrowserOperationStage=typeof BROWSER_OPERATION_STAGES[number];
export type BrowserOperationCode=typeof BROWSER_OPERATION_CODES[number];
export type BrowserDiagnostic={code:BrowserOperationCode;stage:BrowserOperationStage};
const REASONS:Record<BrowserOperationCode,string>={
 'invalid-request':'浏览器请求缺少可可靠绑定的账号、目标或出站标识',
 'control-unavailable':'浏览器已暂停或正在人工接管',
 'identity-unavailable':'工作账号身份尚未可靠确认或已变化',
 'account-restricted':'当前工作账号受限，已保持暂停',
 'browser-recovery-failed':'浏览器恢复失败，已保持暂停',
 'browser-resource-pressure':'浏览器资源或恢复预算不足，已保持暂停',
 'private-contract-unverified':'当前私信的可靠时间或入站身份尚未验收，未提交',
 'public-target-timeout':'目标公开消息未在限定时间内完成加载',
 'public-target-unavailable':'目标公开消息已删除或当前不可用',
 'public-target-ambiguous':'页面存在多个无法唯一确认的目标消息',
 'public-target-mismatch':'当前公开目标的身份、时间或正文与采集记录不符',
 'public-context-incomplete':'公开目标缺少可验证的正文或媒体上下文',
 'editor-unavailable':'编辑器未允许提交',
 'pre-submit-failed':'浏览器在提交意图之前执行失败',
 'operation-timeout':'浏览器操作超过限定时间，等待旧操作退出后收束',
 'preflight-persistence-failed':'预提交结果未完成持久确认，继续保持未知',
 'submission-incomplete':'已开始保存提交意图，结果只能继续回查',
 'unknown-error':'浏览器操作失败，请检查关联记录',
};
export function browserOperationReason(code:BrowserOperationCode):string{return REASONS[code];}
export function safeBrowserDiagnostic(error:unknown,fallbackStage:BrowserOperationStage='request'):BrowserDiagnostic {
 const raw=error as any,value=raw?.diagnostic&&typeof raw.diagnostic==='object'?raw.diagnostic:raw;
 const code=BROWSER_OPERATION_CODES.includes(value?.code)?value.code:'unknown-error';
 const fallback=BROWSER_OPERATION_STAGES.includes(fallbackStage)?fallbackStage:'request';
 const stage=BROWSER_OPERATION_STAGES.includes(value?.stage)?value.stage:fallback;
 return {code,stage};
}
export class BrowserOperationError extends Error {
 constructor(public code:BrowserOperationCode,public stage:BrowserOperationStage){super(browserOperationReason(code));}
 get diagnostic():BrowserDiagnostic{return {code:this.code,stage:this.stage};}
}
