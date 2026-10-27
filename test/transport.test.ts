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
test('平台 ID 来自显式字段或规范地址，不从内部事件字符串猜测；正文统一校验',()=>{
 const event={id:'account:channel:any-internal',url:'https://x.com/alice/status/123',channel:'public'} as Event;
 assert.equal(platformId(event),'123');assert.throws(()=>platformId({...event,channel:'private'}),/平台 ID/);
 assert.throws(()=>validateOutboundText('中'.repeat(141),true));assert.throws(()=>validateOutboundText('https://example.org',false));validateOutboundText('正常正文',true);
});
