import { replyOpening, expressionFlags } from './reply-hints.js';

/** 提示词与质量统计共用检测，避免两处把同一种风格算成不同结果。 */
export const opening = replyOpening;
export const expressions = expressionFlags;
export { replyOpening, expressionFlags };
export function hasSteps(text:string):boolean {
 return /(?:^|\n)\s*(?:\d{1,2}[.、)）]|[一二三四五六七八九十]+[、.)）]|[-*]\s+).+/m.test(text)
  || /第[一二三四五六七八九十\d]+步/.test(text)
  || /首先[\s\S]*然后[\s\S]*(?:最后|最终)/.test(text);
}
