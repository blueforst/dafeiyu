import type { Channel } from './types.js';
import type { Store } from './store.js';

export type PromptHintSettings = {
 lateEnabled:boolean; lateMinutes:number; languageEnabled:boolean; openingEnabled:boolean;
 openingCount:number; expressionEnabled:boolean; kaomojiPer10:number; emojiPer10:number;
 tildePer10:number; replyCheckEnabled:boolean;
};
export const DEFAULT_PROMPT_HINTS:Readonly<PromptHintSettings> = Object.freeze({lateEnabled:true,lateMinutes:60,languageEnabled:true,openingEnabled:true,openingCount:12,expressionEnabled:true,kaomojiPer10:1,emojiPer10:2,tildePer10:1,replyCheckEnabled:true});
export class PromptHintValidationError extends Error { statusCode=400; }
export function validatePromptHints(raw:unknown={}):PromptHintSettings {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new PromptHintValidationError('动态提醒设置无效');
 const input=raw as Record<string,unknown>,result={...DEFAULT_PROMPT_HINTS};
 const ranges:Record<string,[number,number]>={lateMinutes:[30,360],openingCount:[1,12],kaomojiPer10:[0,10],emojiPer10:[0,10],tildePer10:[0,10]};
 for(const [key,value] of Object.entries(input)){
  if(!Object.hasOwn(result,key))throw new PromptHintValidationError('动态提醒字段无效：'+key);
  if(Object.hasOwn(ranges,key)){const [min,max]=ranges[key];if(!Number.isInteger(value)||(value as number)<min||(value as number)>max)throw new PromptHintValidationError('动态提醒 '+key+' 必须在 '+min+'–'+max+' 范围内');}
  else if(typeof value!=='boolean')throw new PromptHintValidationError('动态提醒开关无效：'+key);
  (result as any)[key]=value;
 }
 return result;
}

export type ReplySample = { text:string; channel:Channel; conversationId?:string; accountId?:string; at?:number };
export type ReplyHintKind = 'late'|'language'|'expression'|'reply-check'|'post-variety';
export type ReplyHint = {kind:ReplyHintKind;text:string;reason:string};
export type ReplyHints = {hints:ReplyHint[];meta:{hintKinds:ReplyHintKind[];sampleSource:string;sampleCount:number}};
export type ReplyHintInput = {message:string;channel:Channel;accountId:string;conversationId?:string;timestamp?:number;timestampReliable?:boolean;now?:number;recentReplies?:ReplySample[];settings?:Partial<PromptHintSettings>;sampleSource?:string;postVariety?:boolean};

// 常用繁体特有字形。只作有把握时的书写系统提醒，不推测用户身份。
const TRADITIONAL = new Set(Array.from('這們個說來為會對時國過還麼後開關問題實與從無將應經讓愛學習書體語話頭發現當於進動點總電車門風馬長見聽認識記憶歡樂親覺樣裡邊處號聲氣際選擇優質達資訊網絡線連傳統複雜單雙廣東華麗適區別葉夢遠輕鬆壓該寫讀買賣價錢幣濟產業標準條據稱萬億數幾歲鐘醫療藥養鍛鍊藝術畫劇響願禮義觀協調歷環衛護證訊郵尋導師領專職責權運輸陸聯繫張輝燈廠廳樓層構設計劃組織編輯續約結論紅綠藍黃銀鐵銅鋼屬驗檢測確備舊歸齊類獨暫斷盡盤鹽廚飯餅麵魚鳥雞豬貓龍龜烏鄉園場勢務勞勵奮鬥獲獎賞賽謝請諒謙虛負幫執討講説談評詞詩節慶顏嘗試寬隱顯隨機轉換簡監錄緩啟閉預覽規則觸額費擴緣喲嗎嘍嚕獻擁寶貝稱靈興榮誤誇僅嚴肅溫熱鬧順暢貴賤捨變導欄閱顧慮儲踐紀險隊隻彙龐儀態員擾騷衞帳補償擔憂傷懷難離裝碼'));
export type ReplyLanguage='traditional'|'japanese'|'korean'|'latin'|'unknown';
export function detectLanguage(text:string):ReplyLanguage {
 const kana=(text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)??[]).length;
 if(kana>=2)return 'japanese';
 if((text.match(/\p{Script=Hangul}/gu)??[]).length>=2)return 'korean';
 const letters=text.match(/\p{L}/gu)??[],latin=text.match(/\p{Script=Latin}/gu)??[];
 if(latin.length>=8&&latin.length/Math.max(1,letters.length)>=.6)return 'latin';
 const han=text.match(/\p{Script=Han}/gu)??[],traditional=han.filter(c=>TRADITIONAL.has(c)).length;
 return traditional>=2&&traditional/Math.max(1,han.length)>=.1?'traditional':'unknown';
}

export function replyOpening(text:string,max=8):string {
 const first=text.trim().split(/[，。！？…～~!?,.\s]/u,1)[0]??'';
 return Array.from(first).slice(0,max).join('');
}
export function expressionFlags(text:string):{kaomoji:boolean;emoji:boolean;tilde:boolean} {
 return {kaomoji:/(?:[（(][^()（）\n]{0,24}[ω∀▽・´`°∠⌒ﾉヮ‿╥ಥ][^()（）\n]{0,24}[)）]|(?:[>T^;OoQxX][_.＿-][<T^;OoQxX])|[oOｏＯ][rRｒＲ][zZｚＺ]|[≧≦][▽ω◡][≦≧])/u.test(text),emoji:/\p{Extended_Pictographic}/u.test(text),tilde:/[～~]/u.test(text)};
}

/** 表情统计使用有界样本。私信只允许公开和同一会话，公开绝不读取私信。 */
export function recentReplySamples(store:Store,accountId:string,channel:Channel,conversationId?:string):ReplySample[] {
 if(!accountId||accountId==='unknown')return [];
 const rows=store.db.prepare("SELECT account_id,channel,body,draft,updated_at FROM messages WHERE account_id=? AND status IN ('confirmed','draft','sending','unknown') AND (channel='public' OR (?='private' AND ?<>'' AND channel='private' AND json_extract(body,'$.conversationId')=?)) ORDER BY updated_at DESC,id DESC LIMIT 20").all(accountId,channel,conversationId??'',conversationId??'') as any[];
 return rows.flatMap(row=>{try{const draft=JSON.parse(row.draft??'{}'),body=JSON.parse(row.body);return draft.action==='reply'&&typeof draft.text==='string'?[{text:draft.text,channel:row.channel,conversationId:body.conversationId,accountId:row.account_id,at:row.updated_at}]:[];}catch{return [];}});
}
export function scopedReplies(samples:ReplySample[],accountId:string,channel:Channel,conversationId?:string):ReplySample[] {
 return samples.filter(s=>(!s.accountId||s.accountId===accountId)&&(s.channel==='public'||channel==='private'&&s.channel==='private'&&!!conversationId&&s.conversationId===conversationId)).slice(0,20);
}

export function buildReplyHints(input:ReplyHintInput):ReplyHints {
 const settings=validatePromptHints(input.settings??{}),now=input.now??Date.now(),hints:ReplyHint[]=[];
 const recent=scopedReplies(input.recentReplies??[],input.accountId,input.channel,input.conversationId);
 if(settings.lateEnabled&&input.timestampReliable===true&&Number.isFinite(input.timestamp)&&(input.timestamp as number)>0&&now-(input.timestamp as number)>=settings.lateMinutes*60000){
  const hours=Math.max(1,Math.round((now-input.timestamp!)/3600000));
  hints.push({kind:'late',text:'对方约 '+hours+' 小时前发来消息；自然地为迟到致歉一次，并按现在的时段问候。',reason:'可靠平台时间早于本轮 '+settings.lateMinutes+' 分钟阈值'});
 }
 if(settings.languageEnabled){
  const language=detectLanguage(input.message),texts:Partial<Record<ReplyLanguage,string>>={traditional:'請以繁體中文回覆，不混入簡體字形。',japanese:'请使用对方的日文回复。',korean:'请使用对方的韩文回复。',latin:'请使用对方消息所用的语言回复，不要擅自切换为中文。'};
  if(texts[language])hints.push({kind:'language',text:texts[language]!,reason:'消息的主要书写系统：'+({traditional:'繁体中文',japanese:'日文',korean:'韩文',latin:'拉丁字母语言'} as any)[language]});
 }
 // openingEnabled/openingCount 仅兼容旧设置；不再把给其他人的开头提供给模型。
 if(settings.expressionEnabled){
  // 表情频率只统计当前渠道，避免跨渠道额度互相挤占。
  const sameChannel=recent.filter(s=>s.channel===input.channel).slice(0,10),flags=sameChannel.map(s=>expressionFlags(s.text));
  const types=['kaomoji','emoji','tilde'] as const,limits={kaomoji:settings.kaomojiPer10,emoji:settings.emojiPer10,tilde:settings.tildePer10},names={kaomoji:'颜文字',emoji:'emoji',tilde:'“～”或“~”'};
  const blocked=types.filter(t=>flags.filter(f=>f[t]).length>=limits[t]||(t==='kaomoji'&&flags[0]?.kaomoji));
  const allowed=types.filter(t=>!blocked.includes(t));
  hints.push({kind:'expression',text:(blocked.length?'本条不要使用'+blocked.map(t=>names[t]).join('、')+'。':'')+(allowed.length?'如有必要，可少量使用'+allowed.map(t=>names[t]).join('、')+'；无需刻意添加。':''),reason:'同渠道最近 '+flags.length+' 条回复的频率统计；颜文字不连续使用'});
 }
 if(settings.replyCheckEnabled)hints.push({kind:'reply-check',text:'先按系统规则判断这条消息是否值得回复；不适合回复时返回 skip。',reason:'回复判断提醒已启用'});
 if(input.postVariety===true)hints.push({kind:'post-variety',text:'角色经历里有你最近发过的帖子。这条帖子不要重复它们的开头、句式和切入点；今天的内容以今日日程为准，不要把以前帖子里的事当成今天又发生一次。',reason:'早晚安帖使用已召回的角色经历，不额外调用模型'});
 return {hints,meta:{hintKinds:hints.map(h=>h.kind),sampleSource:input.sampleSource??'production',sampleCount:recent.length}};
}
