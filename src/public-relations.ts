import type {Event} from './types.js';

const ID=/^\d{1,40}$/,HANDLE=/^[A-Za-z0-9_]{1,15}$/;
type NativeRelation={id:string;handle:string;timestamp:number;conversationId:string;replyToId:string|null;replyToHandle?:string};
/** 仅当前导航的原生证据；正文、引用和DOM排列均不能建立回复关系。 */
export class PublicRelations {
 private rows=new Map<string,NativeRelation|null>();
 clear(){this.rows.clear();}
 observe(data:unknown){
  let visited=0;const seen=new Set<object>();
  const walk=(value:any,depth:number)=>{
   if(!value||typeof value!=='object'||depth>35||visited++>=50000||seen.has(value))return;seen.add(value);
   const legacy=value.legacy,id=value.rest_id??legacy?.id_str;
   if(legacy&&typeof id==='string'&&ID.test(id)&&(value.core?.user_results||Object.hasOwn(legacy,'conversation_id_str'))){
    const user=value.core?.user_results?.result,handle=user?.legacy?.screen_name??user?.core?.screen_name,timestamp=Date.parse(legacy.created_at??''),conversationId=legacy.conversation_id_str;
    const parent=legacy.in_reply_to_status_id_str,replyToId=parent===undefined&&conversationId===id?null:parent,parentHandle=legacy.in_reply_to_screen_name;
    const valid=typeof handle==='string'&&HANDLE.test(handle)&&Number.isFinite(timestamp)&&timestamp>0&&typeof conversationId==='string'&&ID.test(conversationId)&&(legacy.id_str===undefined||legacy.id_str===id)&&(replyToId===null?conversationId===id:typeof replyToId==='string'&&ID.test(replyToId)&&replyToId!==id&&conversationId!==id)&&(parentHandle===undefined||parentHandle===null||typeof parentHandle==='string'&&HANDLE.test(parentHandle));
    const relation:NativeRelation|null=valid?{id,handle:handle.toLowerCase(),timestamp,conversationId,replyToId,...(typeof parentHandle==='string'?{replyToHandle:parentHandle.toLowerCase()}:{})}:null;
    if(this.rows.has(id)){
     const old=this.rows.get(id);
     if(!old||!relation||old.handle!==relation.handle||old.timestamp!==relation.timestamp||old.conversationId!==relation.conversationId||old.replyToId!==relation.replyToId||old.replyToHandle&&relation.replyToHandle&&old.replyToHandle!==relation.replyToHandle)this.rows.set(id,null);
     else if(!old.replyToHandle&&relation.replyToHandle)this.rows.set(id,relation);
    }else if(this.rows.size<1000)this.rows.set(id,relation);
   }
   for(const child of Object.values(value))if(child&&typeof child==='object')Array.isArray(child)?child.slice(0,1000).forEach(item=>walk(item,depth+1)):walk(child,depth+1);
  };walk(data,0);
 }
 enrich(events:Event[]):Event[]{return events.map(event=>{
  const relation=event.platformId?this.rows.get(event.platformId):undefined;
  if(relation&&event.channel==='public'&&event.handle.toLowerCase()===relation.handle&&event.timestampReliable===true&&Math.abs(event.timestamp-relation.timestamp)<1000)return {...event,conversationId:relation.conversationId,conversationIdReliable:true,publicRelationConflict:false,replyToId:relation.replyToId,replyToHandle:relation.replyToHandle};
  // 无证据时不继承外部标记；调用方的DOM读取始终只生成未确认消息。
  const conflict=!!event.platformId&&this.rows.has(event.platformId)&&(!relation||event.handle.toLowerCase()!==relation.handle||event.timestampReliable===true&&Math.abs(event.timestamp-relation.timestamp)>=1000);
  const {replyToId,replyToHandle,...rest}=event;return {...rest,conversationId:event.platformId??event.conversationId,conversationIdReliable:false,publicRelationConflict:conflict};
 });}
}

export function hasPublicRelation(event:Event):boolean{return event.channel==='public'&&event.conversationIdReliable===true&&ID.test(event.platformId??'')&&ID.test(event.conversationId)&&(event.replyToId===null?event.conversationId===event.platformId:typeof event.replyToId==='string'&&ID.test(event.replyToId)&&event.replyToId!==event.platformId&&event.conversationId!==event.platformId);}
export function mentionsAccount(text:string,handle:string):boolean{return HANDLE.test(handle)&&new RegExp('(^|[^a-z0-9_])@'+handle+'(?![a-z0-9_])','i').test(text);}
function uniqueEvents(events:Event[]){const rows=new Map<string,Event|null>();for(const event of events){if(!event.platformId)continue;if(rows.has(event.platformId))rows.set(event.platformId,null);else rows.set(event.platformId,event);}return rows;}
/** 返回最近可验证父链；缺父、循环、冲突和不同线程都明确不完整。 */
export function publicAncestors(target:Event,events:Event[]){
 const rows=uniqueEvents(events),chain=[target],seen=new Set([target.platformId]),handles=new Set<string>();let current=target,incomplete=false;
 for(let steps=0;steps<1000;steps++){
  if(!hasPublicRelation(current)){incomplete=true;break;}
  if(current.replyToId===null)break;
  const parentId=current.replyToId!;if(seen.has(parentId)){incomplete=true;break;}
  const parent=rows.get(parentId);
  if(!parent){if(!rows.has(parentId)&&current.replyToHandle&&HANDLE.test(current.replyToHandle))handles.add(current.replyToHandle.toLowerCase());incomplete=true;break;}
  if(!hasPublicRelation(parent)||parent.conversationId!==target.conversationId||current.replyToHandle&&current.replyToHandle.toLowerCase()!==parent.handle.toLowerCase()){incomplete=true;break;}
  seen.add(parentId);handles.add(parent.handle.toLowerCase());chain.push(parent);current=parent;
  if(steps===999)incomplete=true;
 }
 return {context:chain.slice(0,12).reverse(),contextIncomplete:incomplete,omittedEarlier:chain.length>12,ancestorHandles:[...handles]};
}
export function repliesToPost(event:Event,target:Event,events:Event[]):boolean {
 if(!hasPublicRelation(event)||event.platformId===target.platformId||target.publicRelationConflict||target.conversationIdReliable===true&&!hasPublicRelation(target))return false;
 if(event.replyToId===target.platformId&&event.replyToHandle&&event.replyToHandle.toLowerCase()!==target.handle.toLowerCase())return false;
 // 原生conversation_id等于可见目标ID时，目标就是该线程根；不把旁支误归到某条中间回复。
 if(event.conversationId===target.platformId)return true;
 const rows=uniqueEvents(events),seen=new Set<string>();let current=event;
 while(hasPublicRelation(current)&&current.replyToId&&!seen.has(current.platformId!)){
  seen.add(current.platformId!);if(current.replyToId===target.platformId)return !current.replyToHandle||current.replyToHandle.toLowerCase()===target.handle.toLowerCase();
  const parent=rows.get(current.replyToId);if(!parent||parent.conversationId!==event.conversationId||current.replyToHandle&&current.replyToHandle.toLowerCase()!==parent.handle.toLowerCase())return false;current=parent;
 }return false;
}
export function relevantPublicMessage(event:Event,handle:string,events:Event[]):boolean {
 if(event.handle.toLowerCase()===handle.toLowerCase())return false;
 return mentionsAccount(event.text,handle)||publicAncestors(event,events).ancestorHandles.includes(handle.toLowerCase())||[...uniqueEvents(events).values()].some(target=>target&&target.handle.toLowerCase()===handle.toLowerCase()&&repliesToPost(event,target,events));
}
