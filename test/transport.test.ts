import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {createServer} from 'node:http';
import { TransportJournal,matchTweetReceipt,platformTweets,platformId,validateOutboundText } from '../src/browser.js';
import {BrowserTransport} from '../src/transport.js';
import type { Event } from '../src/types.js';

test('轮首和轮末RPC使用POST，分别传未收束保护和精确审核ID且不把signal写入body',async()=>{
 const requests:Array<{path:string;method:string;key:string;body:any}>=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({path:req.url??'',method:req.method??'',key:String(req.headers['x-browser-key']??''),body:JSON.parse(body)});res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,mode:'auto'}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const transport=new BrowserTransport('http://127.0.0.1:'+(server.address() as {port:number}).port,'fixture-round-key'),abort=new AbortController();
  const roundId='48312874-1511-4e96-9450-a8de6d94aa1a';
  await transport.prepareRound('worker',{signal:abort.signal,roundId,unsettledOutbox:false,reviewedUnknownOutboxIds:['exact-reviewed-old']});
  await transport.finishRound('worker',{signal:abort.signal,timeoutMs:120000,roundId,unsettledOutbox:true,reviewedUnknownOutboxIds:['exact-reviewed-old']});
  await transport.finishRound('worker');
  assert.deepEqual(requests.map(row=>[row.path,row.method,row.key]),[['/prepare-round','POST','fixture-round-key'],['/finish-round','POST','fixture-round-key'],['/finish-round','POST','fixture-round-key']]);
  for(const [index,row] of requests.entries()){const {runtimeHealth,...body}=row.body;assert.ok(runtimeHealth&&typeof runtimeHealth==='object');assert.deepEqual(body,{handle:'worker',unsettledOutbox:index===1,reviewedUnknownOutboxIds:index===2?[]:['exact-reviewed-old'],...(index===1?{roundId}:{})});}
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('轮末RPC保留browserPaused错误和用户中止信号，均不自动重试',async()=>{
 let calls=0,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const server=createServer(async(req,res)=>{for await(const _chunk of req){}calls++;if(calls===1){res.statusCode=409;res.setHeader('content-type','application/json');res.end(JSON.stringify({browserPaused:true,browserMode:'paused',error:'合成恢复失败'}));}else entered();});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const transport=new BrowserTransport('http://127.0.0.1:'+(server.address() as {port:number}).port,'fixture-round-key');await assert.rejects(transport.finishRound('worker'),(error:any)=>error.browserPaused===true&&error.browserMode==='paused');assert.equal(calls,1);
  const abort=new AbortController(),pending=transport.finishRound('worker',{signal:abort.signal,timeoutMs:120000});await waiting;abort.abort();await assert.rejects(pending);assert.equal(calls,2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

function hiddenReply(body='你好，听一首喜欢的歌吧。',targetHandle='guest1'){
 const at=Date.now()-1000,prefix='@'+targetHandle+' ',text=prefix+body;
 const raw:any={rest_id:'456',legacy:{id_str:'456',conversation_id_str:'100',in_reply_to_status_id_str:'123',in_reply_to_user_id_str:'9001',in_reply_to_screen_name:targetHandle,full_text:text,created_at:new Date(at).toUTCString(),truncated:false,display_text_range:[prefix.length,text.length],entities:{user_mentions:[{id_str:'9001',screen_name:targetHandle,indices:[0,prefix.length-1]}]}},core:{user_results:{result:{legacy:{screen_name:'Worker'}}}}};
 return {raw,at,body,text,targetHandle};
}
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
test('单目标隐藏mention由原生range、实体和回复账号共同证明，原文保留且需传冻结目标handle',()=>{
 for(const body of ['你好，今天听一首轻松的歌吧。','中文🙂和🚀都完整保留。','第一行🙂\n第二行继续放松。']){
  const f=hiddenReply(body),rows=platformTweets(f.raw);assert.equal(rows.length,1);assert.equal(rows[0].text,f.text);assert.equal(rows[0].replyDisplay?.text,body);assert.deepEqual(rows[0].replyDisplay?.range,[8,f.text.length]);assert.deepEqual(rows[0].replyDisplay?.mentionRange,[0,7]);
  assert.equal(matchTweetReceipt(rows,'worker',body,'123',f.at,'guest1').status,'confirmed');assert.equal(matchTweetReceipt(rows,'worker',body,'123',f.at,'GUEST1').status,'confirmed');
  for(const target of [undefined,'other','@guest1','guest1_extra'])assert.equal(matchTweetReceipt(rows,'worker',body,'123',f.at,target).status,'unknown');
  assert.equal(matchTweetReceipt(rows,'worker',f.text,'123',f.at).status,'confirmed');
  assert.equal(matchTweetReceipt([{...rows[0],replyTo:null}],'worker',body,null,f.at,'guest1').status,'unknown');
 }
});
test('隐藏前缀不允许缺字段、错账号ID、范围矛盾、额外mention或隐藏后缀',()=>{
 const cases:Array<{name:string;mutate:(raw:any)=>void}>=[
  {name:'缺显示范围',mutate:r=>{delete r.legacy.display_text_range;}},
  {name:'缺回复账号ID',mutate:r=>{delete r.legacy.in_reply_to_user_id_str;}},
  {name:'回复账号ID与实体不同',mutate:r=>{r.legacy.in_reply_to_user_id_str='9002';}},
  {name:'实体账号ID与回复不同',mutate:r=>{r.legacy.entities.user_mentions[0].id_str='9002';}},
  {name:'缺回复账号handle',mutate:r=>{delete r.legacy.in_reply_to_screen_name;}},
  {name:'回复handle与实体不同',mutate:r=>{r.legacy.in_reply_to_screen_name='other';}},
  {name:'实体handle与前缀不同',mutate:r=>{r.legacy.entities.user_mentions[0].screen_name='other';}},
  {name:'缺实体',mutate:r=>{delete r.legacy.entities;}},
  {name:'实体列表为空',mutate:r=>{r.legacy.entities.user_mentions=[];}},
  {name:'额外实体',mutate:r=>{r.legacy.entities.user_mentions.push({id_str:'9002',screen_name:'other',indices:[10,16]});}},
  {name:'实体起点错位',mutate:r=>{r.legacy.entities.user_mentions[0].indices=[1,7];}},
  {name:'实体终点错位',mutate:r=>{r.legacy.entities.user_mentions[0].indices=[0,8];}},
  {name:'范围包含隐藏字符',mutate:r=>{r.legacy.display_text_range[0]=7;}},
  {name:'范围漏掉显示字符',mutate:r=>{r.legacy.display_text_range[0]=9;}},
  {name:'显示后缀未覆盖',mutate:r=>{r.legacy.display_text_range[1]--;}},
  {name:'范围越界',mutate:r=>{r.legacy.display_text_range[1]++;}},
  {name:'范围不是整数',mutate:r=>{r.legacy.display_text_range[0]=8.5;}},
  {name:'范围类型不符',mutate:r=>{r.legacy.display_text_range=['8',r.legacy.full_text.length];}},
  {name:'多余范围维度',mutate:r=>{r.legacy.display_text_range.push(1);}},
  {name:'隐藏后缀',mutate:r=>{r.legacy.full_text+=' hidden';}},
  {name:'换行不能冒充原生单空格',mutate:r=>{r.legacy.full_text=r.legacy.full_text.replace('@guest1 ','@guest1\n');}},
  {name:'双空格不是已验收前缀',mutate:r=>{r.legacy.full_text=r.legacy.full_text.replace('@guest1 ','@guest1  ');r.legacy.display_text_range=[9,r.legacy.full_text.length];}},
 ];
 for(const scenario of cases){const f=hiddenReply();scenario.mutate(f.raw);const rows=platformTweets(f.raw);assert.equal(rows[0].replyDisplay,undefined,scenario.name);assert.equal(matchTweetReceipt(rows,'worker',f.body,'123',f.at,'guest1').status,'unknown',scenario.name);}
 const other=hiddenReply('原冻结正文','other');assert.ok(platformTweets(other.raw)[0].replyDisplay);assert.equal(matchTweetReceipt(platformTweets(other.raw),'worker',other.body,'123',other.at,'guest1').status,'unknown');
});
test('可见切片必须逐字等于冻结正文，不能顺便trim正文或删除正文里的@',()=>{
 const f=hiddenReply('  中文🙂正文  '),rows=platformTweets(f.raw);assert.equal(matchTweetReceipt(rows,'worker',f.body,'123',f.at,'guest1').status,'confirmed');
 assert.equal(matchTweetReceipt(rows,'worker',f.body.trim(),'123',f.at,'guest1').status,'unknown');
 const visible=hiddenReply('正文里的@符号照原样保留。');assert.equal(matchTweetReceipt(platformTweets(visible.raw),'worker',visible.body,'123',visible.at,'guest1').status,'confirmed');assert.equal(matchTweetReceipt(platformTweets(visible.raw),'worker','正文里的符号照原样保留。','123',visible.at,'guest1').status,'unknown');
});
test('同ID显示证据缺失或矛盾不能挑有利副本，但完整原文匹配不依赖可选显示元数据',()=>{
 const f=hiddenReply(),good=platformTweets(f.raw),missing=structuredClone(f.raw),changed=structuredClone(f.raw);delete missing.legacy.display_text_range;changed.legacy.in_reply_to_user_id_str='9002';changed.legacy.entities.user_mentions[0].id_str='9002';
 for(const other of [missing,changed]){
  const separate=platformTweets(other),variants=[[...good,...separate],[...separate,...good],platformTweets([f.raw,other]),platformTweets([other,f.raw]),[...platformTweets([f.raw,other]),...good]];
  for(const rows of variants){assert.equal(matchTweetReceipt(rows,'worker',f.body,'123',f.at,'guest1').status,'unknown');assert.equal(matchTweetReceipt(rows,'worker',f.text,'123',f.at).status,'confirmed');}
 }
 assert.equal(matchTweetReceipt([...good,...good],'worker',f.body,'123',f.at,'guest1').status,'confirmed');
});
test('隐藏前缀证明不放宽作者、父目标、时效、完整性、唯一性及原始ID冲突',()=>{
 const f=hiddenReply(),rows=platformTweets(f.raw);assert.equal(matchTweetReceipt(rows,'other',f.body,'123',f.at,'guest1').status,'unknown');assert.equal(matchTweetReceipt(rows,'worker',f.body,'999',f.at,'guest1').status,'unknown');assert.equal(matchTweetReceipt(rows,'worker',f.body,'123',f.at+5000,'guest1').status,'unknown');assert.equal(matchTweetReceipt(rows,'worker',f.body,'123',0,'guest1').status,'unknown');
 const old=structuredClone(f.raw);old.legacy.created_at=new Date(f.at-60000).toUTCString();const clipped=structuredClone(f.raw);clipped.legacy.truncated=true;const idConflict=structuredClone(f.raw);idConflict.legacy.id_str='999';
 for(const raw of [old,clipped,idConflict,{...f.raw,note_tweet:{note_tweet_results:{result:{text:f.text}}}}])assert.equal(matchTweetReceipt(platformTweets(raw),'worker',f.body,'123',f.at,'guest1').status,'unknown');
 const second=structuredClone(f.raw);second.rest_id='457';second.legacy.id_str='457';assert.equal(matchTweetReceipt([...rows,...platformTweets(second)],'worker',f.body,'123',f.at,'guest1').status,'unknown');
});
test('平台 ID 来自显式字段或规范地址，不从内部事件字符串猜测；正文统一校验',()=>{
 const event={id:'account:channel:any-internal',url:'https://x.com/alice/status/123',channel:'public'} as Event;
 assert.equal(platformId(event),'123');assert.throws(()=>platformId({...event,channel:'private'}),/平台 ID/);
 assert.throws(()=>validateOutboundText('中'.repeat(141),true));assert.throws(()=>validateOutboundText('https://example.org',false));validateOutboundText('正常正文',true);
});
