import twitterText from 'twitter-text';
/** 与平台短帖相同的解析器覆盖裸域名；保留旧的显式链接及提及保护。 */
export function outboundContent(text:string){
 // twitter-text旧TLD表未完整覆盖Unicode域名；转换候选的IDN主机后再交回同一解析器。
 const idn=(text.match(/[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:[.．][\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+(?:\/[^\s<>]*)?/gu)??[]).some(value=>{try{const url=new URL('https://'+value.replace(/[．]/g,'.'));return /[^\x00-\x7f]/.test(value)&&twitterText.extractUrlsWithIndices(url.hostname).length>0;}catch{return false;}});
 return {links:idn||twitterText.extractUrlsWithIndices(text).length>0||/https?:\/\/|www\./i.test(text),mentions:twitterText.extractMentions(text).length>0||/@[a-z0-9_]{1,15}/i.test(text)};
}
export function forbiddenOutboundContent(text:string){const found=outboundContent(text);return found.links||found.mentions;}
