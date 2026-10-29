import type {Event} from '../src/types.js';
/** 合成平台元数据由测试显式声明父子关系，不从页面顺序反推。 */
export function nativeRelation(event:Event,conversationId=event.platformId!,replyToId:string|null=null,replyToHandle?:string){return {rest_id:event.platformId,legacy:{id_str:event.platformId,created_at:new Date(event.timestamp||1000).toISOString(),conversation_id_str:conversationId,in_reply_to_status_id_str:replyToId,...(replyToHandle?{in_reply_to_screen_name:replyToHandle}:{})},core:{user_results:{result:{legacy:{screen_name:event.handle}}}}};}
