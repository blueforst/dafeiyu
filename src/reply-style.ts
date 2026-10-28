import { replyOpening, expressionFlags } from './reply-hints.js';

/** 提示词与质量统计共用检测，避免两处把同一种风格算成不同结果。 */
export const opening = replyOpening;
export const expressions = expressionFlags;
export { replyOpening, expressionFlags };
export type FormatIssue = 'list-or-steps'|'markdown';
export type ReplyFormat = {issues:FormatIssue[]};
export function hasSteps(text:string):boolean {
 const listLines=text.split(/\r?\n/).filter(line=>/^\s*(?:\d{1,2}[.、)）](?!\d)|[一二三四五六七八九十]+[、.)）]|[-*]\s+)\s*\S/.test(line));
 return listLines.length>=2
  || /第[一二三四五六七八九十\d]+步/.test(text)
  || /首先[\s\S]*然后[\s\S]*(?:最后|最终)/.test(text);
}

/** 只记录格式，发送与正文校验继续使用原有规则。 */
export function formatIssues(text:string):FormatIssue[] {
 const issues:FormatIssue[]=[];
 if(hasSteps(text))issues.push('list-or-steps');
 if(/(?:^|\n)[ \t]*#{1,6}[ \t]+\S/.test(text)||/\*\*[^\r\n]+?\*\*|__[^\r\n]+?__/.test(text)||/(?:^|\n)[ \t]*```/.test(text))issues.push('markdown');
 return issues;
}

/** 按 Unicode 码点比较；符号和空白不参与，返回最长的规范化重合片段。 */
export function privateOverlap(text:string,backgroundTexts:string[],min=8):{fragment:string}|null {
 const normalize=(value:string)=>Array.from(value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,''));
 const reply=normalize(text);if(reply.length<min||!backgroundTexts.length)return null;
 let longestLength=0,end=0;
 for(const raw of backgroundTexts){const chars=normalize(raw),lengths=new Uint32Array(reply.length+1);
  for(const char of chars)for(let i=reply.length;i>0;i--){lengths[i]=reply[i-1]===char?lengths[i-1]+1:0;if(lengths[i]>longestLength){longestLength=lengths[i];end=i;}}
 }
 return longestLength>=min?{fragment:reply.slice(end-longestLength,end).join('')}:null;
}
