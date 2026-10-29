import {createHash} from 'node:crypto';
import type {Store} from './store.js';
import {memoryPrivacyRevision} from './persona-replay.js';

/** 浏览器仅在最终点击前查询；不授予新的账号、正文或出站标识。 */
export function submissionAllowed(store:Store,control:string,accountId:string,input:any):boolean {
 if(control!=='running'||!input||input.handle!==accountId||typeof input.requestId!=='string'||typeof input.textHash!=='string'||typeof input.privacyRevision!=='string')return false;
 const row=store.db.prepare("SELECT * FROM outbox WHERE id=? AND account_id=? AND status='submitting'").get(input.requestId,accountId) as any;
 if(!row?.event||!['reply','dm'].includes(row.kind)||createHash('sha256').update(row.text).digest('hex')!==input.textHash)return false;
 let event:any;try{event=JSON.parse(row.event);}catch{return false;}
 const message=store.getMessage(row.source_id,accountId);
 return !!message&&message.status==='sending'&&message.user_id===event.userId&&message.channel===event.channel&&row.channel===event.channel&&input.channel===event.channel&&input.sourceId===row.source_id&&input.targetId===(row.kind==='dm'?event.conversationId:row.target_id)&&!store.forgotten(event.userId,accountId)&&event.privacyRevision===input.privacyRevision&&memoryPrivacyRevision(store,accountId,event.userId,event.channel)===input.privacyRevision;
}
