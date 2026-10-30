import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { TransportJournal,matchTweetReceipt,platformTweets,platformId,validateOutboundText } from '../src/browser.js';
import type { Event } from '../src/types.js';
test('浏览器日志按同一出站标识冻结正文与目标，重启保留 unknown',()=>{
 const dir=mkdtempSync(tmpdir()+'/role-journal-');try{
  const journal=new TransportJournal(dir+'/journal.json');const intent=journal.intent('request-1','reply','Worker','123','你好');
  assert.equal(intent.receipt.status,'unknown');assert.throws(()=>journal.intent('request-1','reply','worker','999','你好'),/不能改变/);
  assert.throws(()=>journal.intent('request-1','reply','worker','123','另一正文'),/不能改变/);
  assert.equal(new TransportJournal(dir+'/journal.json').get('request-1')?.at,intent.at);
  journal.settle('request-1',{status:'confirmed',id:'124'});journal.settle('request-1',{status:'unknown'});assert.equal(journal.get('request-1')?.receipt.status,'confirmed');
  writeFileSync(dir+'/bad.json','{');assert.throws(()=>new TransportJournal(dir+'/bad.json'),/日志损坏/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('平台回执必须匹配作者、目标、正文、提交时间和唯一 ID',()=>{
 const at=Date.now()-1000;const tweet={id:'456',handle:'worker',text:'你好',timestamp:at,replyTo:'123',url:'https://x.com/worker/status/456'};
 assert.equal(matchTweetReceipt([tweet],'worker','你好','123',at).status,'confirmed');
 for(const rows of [[{...tweet,replyTo:'other'}],[{...tweet,handle:'other'}],[{...tweet,timestamp:at-10000}],[tweet,{...tweet,id:'457'}]])assert.equal(matchTweetReceipt(rows,'worker','你好','123',at).status,'unknown');
 assert.equal(matchTweetReceipt([tweet],'worker','你好',null,at).status,'unknown');
 assert.equal(matchTweetReceipt([tweet],'worker','你好','123',0).status,'unknown');
 assert.equal(matchTweetReceipt([tweet,tweet],'worker','你好','123',at).status,'confirmed');
});
test('仅从平台真实返回结构提取作者与回复目标，缺失信息不补造',()=>{
 const data={data:{create_tweet:{tweet_results:{result:{rest_id:'456',legacy:{full_text:'你好',created_at:new Date().toUTCString(),in_reply_to_status_id_str:'123'},core:{user_results:{result:{legacy:{screen_name:'Worker'}}}}}}}}};
 assert.equal(platformTweets(data)[0].replyTo,'123');assert.equal(platformTweets(data)[0].handle,'worker');
 const partial=structuredClone(data);delete (partial.data.create_tweet.tweet_results.result.legacy as any).in_reply_to_status_id_str;
 assert.equal(platformTweets(partial)[0].replyTo,undefined);assert.equal(matchTweetReceipt(platformTweets(partial),'worker','你好',null,Date.now()-2000).status,'unknown');
 assert.equal(platformTweets({rest_id:'456',legacy:{full_text:'你好'}}).length,0);
});
test('原生CreateTweet省略父字段时，仅自身conversation和一致ID证明根帖',()=>{
 const at=Date.now()-1000,result={rest_id:'456',legacy:{id_str:'456',conversation_id_str:'456',full_text:'下午好，留十分钟听一首喜欢的歌。',created_at:new Date(at).toUTCString(),truncated:false},core:{user_results:{result:{core:{screen_name:'Worker'}}}}};
 const rows=platformTweets({data:{create_tweet:{tweet_results:{result}}}});assert.equal(rows.length,1);assert.equal(rows[0].replyTo,null);assert.equal(rows[0].complete,true);
 assert.equal(matchTweetReceipt(rows,'worker',result.legacy.full_text,null,at).status,'confirmed');assert.equal(matchTweetReceipt(rows,'worker',result.legacy.full_text,'123',at).status,'unknown');
 const explicit={...result,legacy:{...result.legacy,in_reply_to_status_id_str:null}};assert.equal(matchTweetReceipt(platformTweets(explicit),'worker',result.legacy.full_text,null,at).status,'confirmed');
 const reply={...result,legacy:{...result.legacy,conversation_id_str:'100',in_reply_to_status_id_str:'123',in_reply_to_screen_name:'guest'}};assert.equal(matchTweetReceipt(platformTweets(reply),'worker',result.legacy.full_text,'123',at).status,'confirmed');assert.equal(matchTweetReceipt(platformTweets(reply),'worker',result.legacy.full_text,null,at).status,'unknown');
});
test('根关系缺证据、线程矛盾、自指和原生ID冲突均保持未知',()=>{
 const at=Date.now()-1000,base={rest_id:'456',legacy:{id_str:'456',conversation_id_str:'456',full_text:'原生根关系合成正文',created_at:new Date(at).toUTCString()},core:{user_results:{result:{legacy:{screen_name:'Worker'}}}}};
 for(const patch of [
  {conversation_id_str:undefined},{conversation_id_str:'other'},{conversation_id_str:'123'},{conversation_id_str:456},{id_str:'999'},
  {in_reply_to_status_id_str:'456'},{in_reply_to_status_id_str:'123'},{in_reply_to_status_id_str:''},{in_reply_to_status_id_str:undefined},
  {conversation_id_str:'123',in_reply_to_status_id_str:null},{in_reply_to_screen_name:'guest'},{in_reply_to_user_id_str:'999'},
 ]){
  const raw={...base,legacy:{...base.legacy,...patch}},rows=platformTweets(raw);assert.equal(rows[0].replyTo,undefined,JSON.stringify(patch));
  assert.equal(matchTweetReceipt(rows,'worker',base.legacy.full_text,null,at).status,'unknown',JSON.stringify(patch));assert.equal(matchTweetReceipt(rows,'worker',base.legacy.full_text,'456',at).status,'unknown',JSON.stringify(patch));
 }
 const absent=structuredClone(base);delete (absent.legacy as any).conversation_id_str;assert.equal(platformTweets(absent)[0].replyTo,undefined);
});
test('同ID矛盾在单响应及跨响应均不能挑选有利证据，一致重复仍可确认',()=>{
 const at=Date.now()-1000,root={rest_id:'456',legacy:{id_str:'456',conversation_id_str:'456',full_text:'合成唯一根帖',created_at:new Date(at).toUTCString()},core:{user_results:{result:{legacy:{screen_name:'Worker'}}}}};
 const good=platformTweets(root);assert.equal(matchTweetReceipt([...good,...good],'worker',root.legacy.full_text,null,at).status,'confirmed');
 const conflicts=[
  {...root,legacy:{...root.legacy,conversation_id_str:'100',in_reply_to_status_id_str:'123'}},
  {...root,legacy:{...root.legacy,full_text:'另一个正文'}},
  {...root,legacy:{...root.legacy,created_at:new Date(at+2000).toUTCString()}},
  {...root,core:{user_results:{result:{legacy:{screen_name:'Other'}}}}},
  {...root,legacy:{...root.legacy,truncated:true}},
 ];
 for(const conflict of conflicts){
  const separate=platformTweets(conflict);for(const rows of [[...good,...separate],[...separate,...good],platformTweets([root,conflict]),platformTweets([conflict,root]),[...platformTweets([root,conflict]),...good]])assert.equal(matchTweetReceipt(rows,'worker',root.legacy.full_text,null,at).status,'unknown');
 }
 const reply={...good[0],replyTo:'123'};assert.equal(matchTweetReceipt([reply,{...reply,replyTo:'999'}],'worker',root.legacy.full_text,'123',at).status,'unknown');
});
test('根帖补充关系证明不放宽作者、正文、时间、完整性和唯一性',()=>{
 const at=Date.now()-1000,root={rest_id:'456',legacy:{conversation_id_str:'456',full_text:'完整根帖正文',created_at:new Date(at).toUTCString(),truncated:false},core:{user_results:{result:{legacy:{screen_name:'Worker'}}}}},rows=platformTweets(root);
 for(const altered of [platformTweets({...root,legacy:{...root.legacy,truncated:true}}),platformTweets({...root,note_tweet:{note_tweet_results:{result:{text:root.legacy.full_text}}}})])assert.equal(matchTweetReceipt(altered,'worker',root.legacy.full_text,null,at).status,'unknown');
 assert.equal(matchTweetReceipt(rows,'other',root.legacy.full_text,null,at).status,'unknown');assert.equal(matchTweetReceipt(rows,'worker','不同正文',null,at).status,'unknown');assert.equal(matchTweetReceipt(rows,'worker',root.legacy.full_text,null,at+5000).status,'unknown');assert.equal(matchTweetReceipt(rows,'worker',root.legacy.full_text,null,0).status,'unknown');
 const second=platformTweets({...root,rest_id:'457',legacy:{...root.legacy,conversation_id_str:'457'}});assert.equal(matchTweetReceipt([...rows,...second],'worker',root.legacy.full_text,null,at).status,'unknown');
});
test('平台 ID 来自显式字段或规范地址，不从内部事件字符串猜测；正文统一校验',()=>{
 const event={id:'account:channel:any-internal',url:'https://x.com/alice/status/123',channel:'public'} as Event;
 assert.equal(platformId(event),'123');assert.throws(()=>platformId({...event,channel:'private'}),/平台 ID/);
 assert.throws(()=>validateOutboundText('中'.repeat(141),true));assert.throws(()=>validateOutboundText('https://example.org',false));validateOutboundText('正常正文',true);
});
