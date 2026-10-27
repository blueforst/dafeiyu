import twitterText from 'twitter-text';

export type PostingOperation='post'|'reply';
export type PostingUnit='weighted-characters'|'unicode-codepoints'|'javascript-characters';
export type PostingCapability={
 accountId:string;userId?:string;operation:PostingOperation;sessionId:string;
 status:'confirmed'|'unknown'|'stale';limit:number;countingMode:PostingUnit;adapterRevision?:string;
 source:string;checkedAt:number;expiresAt:number;revision:string;reason?:string;
};
export type PostingValidation={
 allowed:boolean;operation:PostingOperation|'dm';measuredLength:number;limit:number;unit:PostingUnit;
 policyRevision:string;capabilityRevision:string|null;reason?:string;code?:string;checkedAt:number;
};
export const POSTING_POLICY_REVISION='posting-policy-v1';
export const PUBLIC_RESOURCE_CODEPOINTS=25000;
export const BROWSER_RPC_BODY_LIMIT=262144;
export const CAPABILITY_TTL_MS=15*60*1000;
/** 实际平台长帖计数样本尚未验收。不得由请求参数、订阅名或蓝标填入此表。 */
const verifiedLongAdapters:ReadonlyMap<string,{unit:PostingUnit;count:(text:string)=>number}>=new Map();
export function normalizePublicText(text:string):string{return text.normalize('NFC');}
export function publicResourceOK(text:unknown):text is string{return typeof text==='string'&&Array.from(text).length<=PUBLIC_RESOURCE_CODEPOINTS;}
export function rpcResourceOK(data:unknown):boolean{try{return Buffer.byteLength(JSON.stringify(data),'utf8')<=BROWSER_RPC_BODY_LIMIT;}catch{return false;}}
export function capabilityUsable(capability:PostingCapability|undefined,accountId:string,operation:PostingOperation,now=Date.now(),sessionId?:string):boolean{
 return !!capability&&capability.status==='confirmed'&&capability.accountId===accountId.toLowerCase()&&capability.operation===operation&&!!capability.sessionId&&(!sessionId||capability.sessionId===sessionId)&&capability.checkedAt<=now&&capability.expiresAt>now&&capability.expiresAt-capability.checkedAt<=CAPABILITY_TTL_MS&&Number.isSafeInteger(capability.limit)&&capability.limit>280&&capability.limit<=PUBLIC_RESOURCE_CODEPOINTS&&!!capability.adapterRevision&&verifiedLongAdapters.get(capability.adapterRevision)?.unit===capability.countingMode;
}
export function effectivePostingLimit(operation:PostingOperation,capability?:PostingCapability,accountId='',now=Date.now(),sessionId?:string){
 if(capabilityUsable(capability,accountId,operation,now,sessionId))return {operation,limit:capability!.limit,unit:capability!.countingMode,capabilityRevision:capability!.revision,status:'confirmed' as const,source:capability!.source,checkedAt:capability!.checkedAt,reason:undefined};
 return {operation,limit:280,unit:'weighted-characters' as PostingUnit,capabilityRevision:capability?.revision??null,status:capability?.status==='confirmed'?'unknown' as const:capability?.status??'unknown' as const,source:capability?.source??'短帖默认规则',checkedAt:capability?.checkedAt??0,reason:capability?.reason??(capability?.status==='confirmed'?'长帖计数适配器尚未通过真实样本验收':'未取得当前账号的可靠长帖能力证据')};
}
/** 冻结正文之后只校验，不再规范化或截断。 */
export function validatePostingText(text:unknown,operation:PostingOperation|'dm',options:{accountId?:string;capability?:PostingCapability;now?:number;sessionId?:string}={}):PostingValidation{
 const now=options.now??Date.now();const value=typeof text==='string'?text:'';
 const policy=operation==='dm'?{limit:4000,unit:'javascript-characters' as PostingUnit,capabilityRevision:null}:effectivePostingLimit(operation,options.capability,options.accountId??'',now,options.sessionId);
 const base:PostingValidation={allowed:false,operation,measuredLength:0,limit:policy.limit,unit:policy.unit,policyRevision:POSTING_POLICY_REVISION,capabilityRevision:policy.capabilityRevision,checkedAt:now};
 const fail=(code:string,reason:string):PostingValidation=>({...base,code,reason});
 if(typeof text!=='string'||!value.trim())return fail('empty','正文为空');
 base.measuredLength=operation==='dm'?value.length:twitterText.parseTweet(value).weightedLength;
 if(operation!=='dm'&&!publicResourceOK(value))return fail('resource-limit','公开正文超过 25,000 个 Unicode 码点的输入保护边界');
 if(operation==='dm'&&value.length>4000)return fail('length-limit','私信超过 4,000 个 JavaScript 字符');
 if(/https?:\/\/|www\.|@[a-z0-9_]{1,15}/i.test(value))return fail('forbidden-content','正文包含禁用链接或额外账号提及');
 if(operation!=='dm'){
  if(value!==normalizePublicText(value))return fail('normalization-required','公开正文须在冻结前统一为 NFC');
  const adapter=options.capability?.adapterRevision?verifiedLongAdapters.get(options.capability.adapterRevision):undefined;
  if(policy.unit!=='weighted-characters'&&adapter)base.measuredLength=adapter.count(value);
  if(base.measuredLength>base.limit)return fail('length-limit','公开正文超过当前账号的生效字数限制');
  if(policy.unit==='weighted-characters'&&!twitterText.parseTweet(value).valid)return fail('invalid-public-text','公开正文未通过短帖完整有效性校验');
 }
 return {...base,allowed:true};
}
export function postingLimitPrompt(operation:PostingOperation|'dm',capability?:PostingCapability,accountId=''):string{
 const policy=operation==='dm'?{limit:4000,unit:'javascript-characters'}:effectivePostingLimit(operation,capability,accountId);
 const unit=policy.unit==='weighted-characters'?'加权字符（普通汉字通常算 2，emoji 依平台短帖规则计数）':policy.unit==='unicode-codepoints'?'Unicode 码点':'JavaScript 字符';
 return `本次${operation==='post'?'原创帖子':operation==='reply'?'公开回复':'私信'}最多 ${policy.limit} ${unit}；这是上限，不要求写满。禁止链接及额外 @ 提及。`;
}
