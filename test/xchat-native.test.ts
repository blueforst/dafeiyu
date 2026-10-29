import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNativeChatRows,type NativeChatRow} from '../src/chat-dom.js';
import {promoteNativeInspection,type XChatModelProof,type XChatModelSnapshot} from '../src/xchat-native.js';
const id='11111111-1111-4111-8111-111111111111',now=Date.UTC(2026,9,29,14,36),at=now-60000;
const row=(patch:Partial<NativeChatRow>={}):NativeChatRow=>({nativeId:id,testId:'message-'+id,articleRole:'article',focusTarget:id+':content',contentTestId:'message-text-'+id,contentLinked:true,bodyUnique:true,text:'正常合成消息',sender:'合成用户',senderLinked:true,displayTime:'2:35 PM',dateBoundary:'Today',sendStatus:'sent',media:false,...patch});
const proof=(patch:Partial<XChatModelProof>={}):XChatModelProof=>({rowId:id,id,contentType:'ReceivedMessageTextOnly',senderId:'111',seconds:String(at/1000),nanos:239000000,shownSeconds:String(at/1000),shownNanos:239000000,sequence:'2115814771744473294',fullText:'正常合成消息',textContent:'正常合成消息',oneToOne:true,fiberBound:true,isTextOnly:true,isTruncated:false,isUndecryptable:false,...patch});
const snapshot=(proofs=[proof()],patch:Partial<XChatModelSnapshot>={}):XChatModelSnapshot=>({path:'/i/chat/111-222',conversationId:'111-222',validLocation:true,atBottom:true,ready:true,proofs,...patch});
const inspect=(p=proof(),r=row(),s=snapshot([p]),self='222')=>promoteNativeInspection(inspectNativeChatRows([r],'111-222','https://x.com/i/chat/111-222'),s,self,now);
test('原生模型和同row正文相符时使用真实发送者与机器时间，不依赖显示标签',()=>{
 const result=inspect();assert.equal(result.contract,'xchat-native-v2');assert.equal(result.events.length,1);assert.equal(result.events[0].timestamp,at+239);assert.equal(result.events[0].senderId,'111');assert.equal(result.events[0].nativeSequence,'2115814771744473294');assert.equal(result.events[0].platformId,id);assert.equal(result.events[0].url,'https://x.com/i/chat/111-222');
 assert.equal(inspect(proof(),row({displayTime:'伪造显示时间',dateBoundary:'Yesterday'})).events.length,1);
 assert.equal(inspect(proof(),row({sender:'You'})).events.length,0);
});
test('外账号、错误会话、未到底部和未就绪的原生样本不能入队',()=>{
 for(const patch of [{validLocation:false},{conversationId:'111-333'},{ready:false},{atBottom:false}])assert.equal(inspect(proof(),row(),snapshot([proof()],patch)).events.length,0);
 assert.equal(inspect(proof(),row(),snapshot(),'333').events.length,0);assert.equal(inspect(proof(),row(),snapshot(),'').events.length,0);
});
test('UUID复用、fiber不绑定、群聊和正文冲突均保留明确阻断',()=>{
 for(const patch of [{id:'other'},{fiberBound:false},{oneToOne:false},{fullText:'不同正文'},{textContent:'部分正文'},{isTruncated:true},{isUndecryptable:true},{isTextOnly:false}]){const result=inspect(proof(patch));assert.equal(result.events.length,0);assert.equal(result.all[0].timestampReliable,false);}
 assert.equal(inspect(proof(),row(),snapshot([proof(),proof()])).events.length,0);
 assert.equal(inspect(proof(),row({contentLinked:false})).events.length,0);
});
test('时间必须有完整机器字段，不用分钟标签或采集时间填补',()=>{
 for(const patch of [{seconds:''},{nanos:-1},{nanos:1e9},{nanos:1.5},{seconds:String((now+120000)/1000)},{shownNanos:0},{shownSeconds:'broken'}])assert.equal(inspect(proof(patch)).events.length,0);
 assert.equal(inspect(proof({shownSeconds:'',shownNanos:-1})).events.length,1);
});
test('服务器序号缺失、Pending状态、发送者错配和非文本类型均不反推为入站',()=>{
 for(const patch of [{sequence:''},{sequence:'0'},{sequence:'-1'},{senderId:'333'},{senderId:'222'},{contentType:'PendingMessageTextOnly'},{contentType:'ReceivedMessageAttachmentOnly'}])assert.equal(inspect(proof(patch)).events.length,0);
 const outgoing=inspect(proof({contentType:'SentMessageTextOnly',senderId:'222'}),row({sender:'You'}));assert.equal(outgoing.all[0].direction,'out');assert.equal(outgoing.events.length,0);
});
test('最新一条证据不足时不回退较早入站，诊断不泄漏正文或发送者',()=>{
 const other='22222222-2222-4222-8222-222222222222';
 const observed=inspectNativeChatRows([row(),row({nativeId:other,testId:'message-'+other,focusTarget:other+':content',contentTestId:'message-text-'+other,text:'机密正文'})],'111-222','https://x.com/i/chat/111-222');
 const result=promoteNativeInspection(observed,snapshot([proof()]),'222',now);assert.equal(result.events.length,0);assert.ok(!JSON.stringify(result.diagnostics).includes('机密'));assert.ok(!result.warnings.join().includes('合成用户'));
});
test('连续可靠历史全部采集，历史只展示，由最新消息触发回复；不跨出站回捞',()=>{
 const second='22222222-2222-4222-8222-222222222222',last='33333333-3333-4333-8333-333333333333';
 const rows=[row(),row({nativeId:second,testId:'message-'+second,focusTarget:second+':content',contentTestId:'message-text-'+second}),row({nativeId:last,testId:'message-'+last,focusTarget:last+':content',contentTestId:'message-text-'+last})];
 const observed=inspectNativeChatRows(rows,'111-222','https://x.com/i/chat/111-222'),proofs=[proof(),proof({rowId:second,id:second}),proof({rowId:last,id:last})];
 const read=promoteNativeInspection(observed,snapshot(proofs),'222',now);assert.equal(read.events.length,3);assert.deepEqual(read.events.map(e=>e.privateHistoryOf),[last,last,undefined]);
 const outgoing=inspectNativeChatRows([rows[0],{...rows[1],sender:'You'},rows[2]],'111-222','https://x.com/i/chat/111-222');const after=promoteNativeInspection(outgoing,snapshot([proofs[0],{...proofs[1],contentType:'SentMessageTextOnly',senderId:'222'},proofs[2]]),'222',now);assert.equal(after.events.length,1);assert.equal(after.events[0].platformId,last);
});
