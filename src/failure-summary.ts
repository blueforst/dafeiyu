import {safeBrowserDiagnostic} from './browser-operation.js';

const summaries:Record<string,string>={
 'invalid-request':'浏览器请求参数无效',
 'control-unavailable':'浏览器已暂停或正在人工接管',
 'identity-unavailable':'工作账号尚未就绪或身份已变化',
 'account-restricted':'工作账号受到平台限制',
 'browser-recovery-failed':'浏览器资源恢复未完成',
 'public-target-timeout':'原消息尚未加载完成',
 'public-target-unavailable':'原消息已删除或暂时不可访问',
 'public-target-ambiguous':'无法唯一确认原消息',
 'public-target-mismatch':'当前页面与原消息不匹配',
 'public-context-incomplete':'原消息上下文尚不完整',
 'editor-unavailable':'平台编辑器尚未允许提交',
 'pre-submit-failed':'发送前检查未完成',
 'operation-timeout':'浏览器操作超时',
 'preflight-persistence-failed':'未提交结果尚未可靠保存',
 'submission-incomplete':'提交结果尚未确认'
};

/** 产品提示只采用程序定义的原因，不显示页面正文、URL或底层异常。 */
export function failureSummary(error:unknown,fallback='阶段执行失败'):string {
 const diagnostic=safeBrowserDiagnostic(error,'request');
 return summaries[diagnostic.code]??fallback;
}

/** 仅排查详情展示固定代码与阶段；普通异常继续使用通用提示。 */
export function failureDetail(error:unknown):string {
 const diagnostic=safeBrowserDiagnostic(error,'request');
 return diagnostic.code==='unknown-error'?'阶段执行失败，请检查关联记录':failureSummary(error)+'（'+diagnostic.stage+' / '+diagnostic.code+'）';
}
