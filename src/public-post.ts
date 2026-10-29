import type {Page} from 'playwright-core';
import type {Event} from './types.js';

export type PublicQuote={handle:string;platformId:string;text:string;media:boolean;truncated?:boolean}|{unreadable:true};
export type PublicCard={domain:string;title:string;truncated?:boolean}|{unreadable:true};
export type PublicExtras={quote?:PublicQuote;card?:PublicCard};
/** 供真实采集、RPC 与试聊共用。只保留有限字段，不继承外部对象原型或任意属性。 */
export function validatePublicExtras(raw:unknown={}):PublicExtras {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('引用与卡片字段格式无效');
 const value=raw as Record<string,unknown>,out:PublicExtras={};
 const object=(input:unknown,label:string)=>{if(!input||typeof input!=='object'||Array.isArray(input))throw new Error(label+'格式无效');return input as Record<string,unknown>;};
 const keys=(input:Record<string,unknown>,allowed:string[],label:string)=>{if(Object.keys(input).some(key=>!allowed.includes(key)))throw new Error(label+'包含未知字段');};
 if(value.quote!==undefined){
  const quote=object(value.quote,'引用');
  if(quote.unreadable===true){keys(quote,['unreadable'],'不可读引用');out.quote={unreadable:true};}
  else {keys(quote,['handle','platformId','text','media','truncated'],'引用');if(typeof quote.handle!=='string'||!/^[A-Za-z0-9_]{1,15}$/.test(quote.handle)||typeof quote.platformId!=='string'||!/^\d{1,40}$/.test(quote.platformId)||typeof quote.text!=='string'||!quote.text.trim()||quote.text.length>1000||typeof quote.media!=='boolean'||quote.truncated!==undefined&&typeof quote.truncated!=='boolean')throw new Error('引用字段或长度无效');out.quote={handle:quote.handle,platformId:quote.platformId,text:quote.text,media:quote.media,...(quote.truncated!==undefined?{truncated:quote.truncated}:{})};}
 }
 if(value.card!==undefined){
  const card=object(value.card,'卡片');
  if(card.unreadable===true){keys(card,['unreadable'],'不可读卡片');out.card={unreadable:true};}
  else {keys(card,['domain','title','truncated'],'卡片');if(typeof card.domain!=='string'||!card.domain.trim()||card.domain.length>253||!/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.test(card.domain)||!card.domain.includes('.')||typeof card.title!=='string'||!card.title.trim()||card.title.length>300||card.truncated!==undefined&&typeof card.truncated!=='boolean')throw new Error('卡片字段或长度无效');out.card={domain:card.domain,title:card.title,...(card.truncated!==undefined?{truncated:card.truncated}:{})};}
 }
 return out;
}

/** 作者正文、引用与卡片分别读取；从不打开引用、卡片或任何外部网页。 */
export async function readPublicPosts(page:Page):Promise<Event[]> {
 const rows=await page.locator('article[data-testid="tweet"]').evaluateAll(articles=>articles.slice(0,60).flatMap(article=>{
  const excluded='[data-testid="quoteTweet"],[data-testid="card.wrapper"],div[role="link"]',owned=(node:Element)=>node.closest('article[data-testid="tweet"]')===article&&!node.closest(excluded);
  const ownText=(node:HTMLElement|undefined)=>{if(!node)return '';if(!node.querySelector(excluded))return node.innerText;const copy=node.cloneNode(true) as HTMLElement;copy.querySelectorAll(excluded).forEach(child=>child.remove());return copy.textContent||'';};
  const time=Array.from(article.querySelectorAll('time')).find(owned),link=time?.closest('a'),match=link?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:[/?#]|$)/);if(!match)return [];
  const text=ownText(Array.from(article.querySelectorAll('[data-testid="tweetText"]')).find(owned) as HTMLElement|undefined),parsed=Date.parse(time?.getAttribute('datetime')||''),reliable=Number.isFinite(parsed)&&parsed>0;
  const clipped=(value:string,max:number)=>{let part=value.slice(0,max);if(part.length&&/[\ud800-\udbff]/.test(part.at(-1)!)&&/[\udc00-\udfff]/.test(value.charAt(part.length)))part=part.slice(0,-1);return part;};
  const inArticle=(node:Element)=>node.closest('article[data-testid="tweet"]')===article;
  const explicit=Array.from(article.querySelectorAll('[data-testid="quoteTweet"]')).find(inArticle);
  const quote=explicit??Array.from(article.querySelectorAll('div[role="link"]')).find(node=>inArticle(node)&&!node.closest('[data-testid="card.wrapper"]')&&(!!node.querySelector('a[href*="/status/"]')||/quoted|引用/i.test(node.getAttribute('aria-label')||'')));
  let quoteData:any;
  if(quote){
   const quoteOwned=(node:Element)=>inArticle(node)&&!node.closest('[data-testid="card.wrapper"]')&&(quote.matches('[data-testid="quoteTweet"]')?node.closest('[data-testid="quoteTweet"]')===quote:node.closest('div[role="link"]')===quote);
   const quoteLink=Array.from(quote.querySelectorAll('a[href]')).find(node=>quoteOwned(node)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:[/?#]|$)/.test(node.getAttribute('href')||''));
   const target=quoteLink?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:[/?#]|$)/),content=ownText(Array.from(quote.querySelectorAll('[data-testid="tweetText"]')).find(quoteOwned) as HTMLElement|undefined);
   quoteData=target&&/^[A-Za-z0-9_]{1,15}$/.test(target[1])&&/^\d{1,40}$/.test(target[2])&&content?.trim()?{handle:target[1],platformId:target[2],text:clipped(content,1000),media:Array.from(quote.querySelectorAll('[data-testid="tweetPhoto"],video')).some(quoteOwned),...(content.length>1000?{truncated:true}:{})}:{unreadable:true};
  }
  const card=Array.from(article.querySelectorAll('[data-testid="card.wrapper"]')).find(node=>inArticle(node)&&!node.closest('[data-testid="quoteTweet"]')&&(!quote||!quote.contains(node)));
  let cardData:any;
  if(card){
   const lines=((card as HTMLElement).innerText||'').split('\n').map(line=>line.trim()).filter(Boolean),domainNode=card.querySelector('[data-testid="card.domain"],[data-testid="card.domainName"],[data-testid="cardUrl"],[data-card-domain]') as HTMLElement|null,titleNode=card.querySelector('[data-testid="card.title"],[data-testid="cardTitle"],[data-card-title]') as HTMLElement|null;
   const domain=(domainNode?.innerText||lines.find(line=>/^(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(line))||'').trim().replace(/^www\./i,''),title=(titleNode?.innerText||lines.find(line=>line.replace(/^www\./i,'')!==domain)||'').trim();
   cardData=domain&&domain.length<=253&&/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.test(domain)&&domain.includes('.')&&title?{domain,title:clipped(title,300),...(title.length>300?{truncated:true}:{})}:{unreadable:true};
  }
  return [{id:'x:'+match[2],platformId:match[2],targetId:match[2],channel:'public' as const,userId:'x:'+match[1].toLowerCase(),handle:match[1],text,url:'https://x.com/'+match[1]+'/status/'+match[2],conversationId:match[2],timestamp:reliable?parsed:0,timestampReliable:reliable,mediaUnavailable:Array.from(article.querySelectorAll('[data-testid="tweetPhoto"],video')).some(owned),...(quoteData?{quote:quoteData}:{}),...(cardData?{card:cardData}:{})}];
 }));
 return rows.map(row=>({...row,conversationIdReliable:false,...validatePublicExtras(row)}));
}
