import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserChatRecoveryError,captureBrowserChatCheckpoint,verifyBrowserChatCheckpoint,waitForBrowserChatCheckpointCapture,waitForBrowserChatCheckpointVerification,type BrowserChatRecoveryCode,type BrowserChatRecoveryObservation,type BrowserChatCheckpoint} from '../src/browser-round-recovery.js';
import type {ChatObservedMessage} from '../src/chat-dom.js';

const self='222',peer='111',conversationId=peer+'-'+self,url='https://x.com/i/chat/'+conversationId,at=Date.UTC(2026,9,30,9);
const row=(n:number,patch:Partial<ChatObservedMessage>={}):ChatObservedMessage=>({id:'11111111-1111-4111-8111-'+String(n).padStart(12,'0'),text:'私密正文 '+n,direction:n%2?'in':'out',timestamp:at+n,timestampReliable:true,media:false,contract:'xchat-native-v2',nativeSequence:String(n),senderId:n%2?peer:self,blockedCodes:[],...patch});
const observed=(all:ChatObservedMessage[]=[row(1),row(2)]):BrowserChatRecoveryObservation=>({selfUserId:self,url,inspection:{contract:'xchat-native-v2',conversationId,all,ui:{state:'ready',locationValid:true,loading:false,lockInputs:0},chatProtection:{hasUnlockedSession:true,unlockPending:false,needsHuman:false}},composer:{state:'ready'}});
const rejects=(fn:()=>unknown,code:BrowserChatRecoveryCode)=>assert.throws(fn,error=>error instanceof BrowserChatRecoveryError&&error.code===code);

test('已接受原生会话只保存摘要，最多保留最近三个检查点且不修改入参',()=>{
 const input=observed([row(1),row(2),row(3),row(4),row(5)]),before=structuredClone(input),checkpoint=captureBrowserChatCheckpoint(input);
 assert.deepEqual(input,before);assert.equal(checkpoint.messages.length,3);assert.deepEqual(checkpoint.messages.map(item=>item.nativeSequence),['3','4','5']);
 assert.equal(checkpoint.canonicalUrl,url);assert.equal(checkpoint.selfUserId,self);assert.equal(checkpoint.conversationId,conversationId);
 assert.doesNotMatch(JSON.stringify(checkpoint),/私密正文|"text"|senderLabel|displayTime/);assert.ok(Object.isFrozen(checkpoint));assert.ok(Object.isFrozen(checkpoint.messages));
});

test('摘要使用原始正文UTF8 SHA256，不借助空白或Unicode归一化认领另一条消息',()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed([row(1,{text:'abc'})]));assert.equal(checkpoint.messages[0].textHash,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 for(const text of ['abc ','abc\n','ABC'])rejects(()=>verifyBrowserChatCheckpoint(checkpoint,observed([row(1,{text})])),'checkpoint-mismatch');
 const unicode=captureBrowserChatCheckpoint(observed([row(1,{text:'中文🙂\n第二行é'})]));rejects(()=>verifyBrowserChatCheckpoint(unicode,observed([row(1,{text:'中文🙂\n第二行e\u0301'})])),'checkpoint-mismatch');
});

test('同账号同会话至少一个旧检查点匹配即可，新增可靠消息和显示顺序变化均允许',()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed([row(1),row(2),row(3)]));
 assert.deepEqual(verifyBrowserChatCheckpoint(checkpoint,observed([row(3),row(4),row(5)])),{restored:true,matchedMessages:1});
 assert.deepEqual(verifyBrowserChatCheckpoint(checkpoint,observed([row(3),row(1),row(2),row(4)])),{restored:true,matchedMessages:3});
});

test('账号数字身份、直接会话双方及严格canonical地址必须绑定',()=>{
 for(const invalidSelf of ['', '0','0222','222x','2'.repeat(26)]){const input=observed();input.selfUserId=invalidSelf;rejects(()=>captureBrowserChatCheckpoint(input),'identity-mismatch');}
 for(const invalidConversation of ['111-333','222-222','111-222-333','0111-222','group']){const input=observed();input.inspection.conversationId=invalidConversation;input.url='https://x.com/i/chat/'+invalidConversation;rejects(()=>captureBrowserChatCheckpoint(input),'identity-mismatch');}
 for(const invalidUrl of [url+'?token=secret',url+'#fragment',url+'/',url.replace('x.com','x.com.evil.example'),url.replace('https://','https://user@'),url.replace('/i/chat/','/i/chat/requests/'),url.replace('/i/chat/'+conversationId,'/i/chat')]){const input=observed();input.url=invalidUrl;rejects(()=>captureBrowserChatCheckpoint(input),'location-mismatch');}
});

test('恢复成另一个账号或另一直接会话时即使正文和序号相同也失败',()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed()),wrongSelf=observed();wrongSelf.selfUserId=peer;rejects(()=>verifyBrowserChatCheckpoint(checkpoint,wrongSelf),'identity-mismatch');
 const wrongConversation=observed();wrongConversation.inspection.conversationId='333-222';wrongConversation.url='https://x.com/i/chat/333-222';rejects(()=>verifyBrowserChatCheckpoint(checkpoint,wrongConversation),'location-mismatch');
});

test('native-v2、真实ready、解锁及已接受composer必须全部就绪',()=>{
 const cases:Array<(input:BrowserChatRecoveryObservation)=>void>=[
  input=>{input.inspection.contract='xchat-observation-v1';},input=>{input.inspection.ui=undefined;},input=>{input.inspection.ui!.state='empty';},input=>{input.inspection.ui!.state='locked';},input=>{input.inspection.ui!.locationValid=false;},input=>{input.inspection.ui!.loading=true;},input=>{input.inspection.ui!.lockInputs=1;},input=>{input.inspection.ui!.traversalTruncated=true;},input=>{input.inspection.chatProtection.hasUnlockedSession=false;},input=>{input.inspection.chatProtection.unlockPending=true;},input=>{input.inspection.chatProtection.needsHuman=true;},input=>{input.composer.state='unknown';},
 ];
 const checkpoint=captureBrowserChatCheckpoint(observed());for(const change of cases){const input=observed();change(input);rejects(()=>captureBrowserChatCheckpoint(input),'session-unready');rejects(()=>verifyBrowserChatCheckpoint(checkpoint,input),'session-unready');}
});

test('空收件箱或空会话绝不作为旧会话已恢复的证明',()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed()),empty=observed([]);rejects(()=>captureBrowserChatCheckpoint(empty),'session-unready');rejects(()=>verifyBrowserChatCheckpoint(checkpoint,empty),'session-unready');
 empty.inspection.ui!.state='empty';rejects(()=>verifyBrowserChatCheckpoint(checkpoint,empty),'session-unready');
});

test('所有当前可见行都须可靠，不因同时有一个好检查点而跳过异常新行',()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed([row(1)]));
 const changes:Partial<ChatObservedMessage>[]=[{id:'not-a-uuid'},{nativeSequence:'0'},{nativeSequence:'01'},{nativeSequence:''},{timestamp:0},{timestamp:Number.NaN},{timestamp:1.5},{timestampReliable:false},{direction:'unknown'},{senderId:self},{blockedCodes:['chat-native-model-unverified']},{media:true},{contract:'legacy'},{text:''},{text:' '},{text:'字'.repeat(30001)}];
 for(const change of changes){const input=observed([row(1),row(3,change)]);rejects(()=>captureBrowserChatCheckpoint(input),'message-unreliable');rejects(()=>verifyBrowserChatCheckpoint(checkpoint,input),'message-unreliable');}
 const wrongOut=observed([row(2,{senderId:peer})]);rejects(()=>captureBrowserChatCheckpoint(wrongOut),'message-unreliable');
});

test('重复UUID、重复序号以及超出有界检查行数均拒绝',()=>{
 for(const rows of [[row(1),row(1)], [row(1),row(3,{nativeSequence:'1'})], Array.from({length:101},(_,index)=>row(index+1)),new Array<ChatObservedMessage>(2)])rejects(()=>captureBrowserChatCheckpoint(observed(rows)),'message-unreliable');
});

test('旧UUID必须同时匹配序号、方向、发送者、机器时间和正文摘要',()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed([row(1)]));
 for(const change of [{id:row(3).id},{nativeSequence:'999'},{timestamp:at+999},{direction:'out' as const,senderId:self},{text:'不同正文'}])rejects(()=>verifyBrowserChatCheckpoint(checkpoint,observed([row(1,change)])),'checkpoint-mismatch');
});

test('检查点自身的版本、上限、摘要、地址及字段损坏均使用固定码失败',()=>{
 const valid=captureBrowserChatCheckpoint(observed([row(1)]));
 const changes:Array<(value:any)=>void>=[value=>{value.version=2;},value=>{value.selfUserId='333';},value=>{value.canonicalUrl+='?token=secret';},value=>{value.messages=[];},value=>{value.messages=Array.from({length:4},()=>value.messages[0]);},value=>{value.messages[0].textHash='bad';},value=>{value.messages[0].nativeSequence='0';},value=>{value.messages[0].senderId=self;},value=>{value.messages.push({...value.messages[0]});},value=>{value.messages[0].text='不应进入检查点的正文';}];
 for(const change of changes){const checkpoint=structuredClone(valid);change(checkpoint);rejects(()=>verifyBrowserChatCheckpoint(checkpoint as BrowserChatCheckpoint,observed()),'checkpoint-invalid');}
});

test('错误只暴露固定码和固定说明，不带正文、地址参数或传入异常内容',()=>{
 const input=observed([row(1,{text:'不应出现在错误中的正文'})]);input.url=url+'?secret=private';
 assert.throws(()=>captureBrowserChatCheckpoint(input),error=>{assert.ok(error instanceof BrowserChatRecoveryError);assert.equal(error.code,'location-mismatch');assert.doesNotMatch(error.message,/私密正文|不应出现在错误|secret|private|https:/);return true;});
});

function simulatedClock(){
 let time=0;const waits:number[]=[];
 return {now:()=>time,wait:async(milliseconds:number)=>{waits.push(milliseconds);time+=milliseconds;},advance:(milliseconds:number)=>{time+=milliseconds;},waits};
}

test('捕获等待较早行完成原生绑定，末行先可靠也不能提前取得检查点',async()=>{
 const clock=simulatedClock();let reads=0;
 const result=await waitForBrowserChatCheckpointCapture({...clock,deadline:2000,read:()=>{
  reads++;return observed([row(1,clock.now()<600?{timestampReliable:false,blockedCodes:['chat-native-model-unverified']}:{}),row(2)]);
 }});
 assert.equal(reads,5);assert.equal(result.attempts,5);assert.equal(result.elapsedMs,800);
 assert.deepEqual(result.value,captureBrowserChatCheckpoint(observed()));assert.deepEqual(clock.waits,[200,200,200,200]);
});

test('恢复验证等待已接受composer延后就绪，仍需两次完整的原消息证明',async()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed()),clock=simulatedClock();
 const result=await waitForBrowserChatCheckpointVerification(checkpoint,{...clock,deadline:2000,read:()=>{
  const input=observed();if(clock.now()<600)input.composer.state='unknown';return input;
 }});
 assert.deepEqual(result,{value:{restored:true,matchedMessages:2},attempts:5,elapsedMs:800});
});

test('首次完整证明不能直接成功，捕获与恢复均要求相隔一次等待的连续两次通过',async()=>{
 const captureClock=simulatedClock(),captured=await waitForBrowserChatCheckpointCapture({...captureClock,deadline:1000,read:observed});
 assert.equal(captured.attempts,2);assert.equal(captured.elapsedMs,200);assert.deepEqual(captureClock.waits,[200]);
 const verifyClock=simulatedClock(),verified=await waitForBrowserChatCheckpointVerification(captured.value,{...verifyClock,deadline:1000,read:observed});
 assert.deepEqual(verified,{value:{restored:true,matchedMessages:2},attempts:2,elapsedMs:200});
});

test('两次好观察之间出现新的不可靠行会重置连续成功次数，不能跳过该行',async()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed()),clock=simulatedClock();
 const result=await waitForBrowserChatCheckpointVerification(checkpoint,{...clock,deadline:2000,read:()=>observed(clock.now()===200?[row(1),row(2),row(3,{blockedCodes:['chat-native-time-unverified'],timestampReliable:false})]:[row(1),row(2)])});
 assert.deepEqual(result,{value:{restored:true,matchedMessages:2},attempts:4,elapsedMs:600});
});

test('新消息先出现而旧检查点稍后加载时重读，始终要求原消息完整匹配',async()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed([row(1)])),clock=simulatedClock();
 const result=await waitForBrowserChatCheckpointVerification(checkpoint,{...clock,deadline:2000,read:()=>observed(clock.now()<400?[row(3)]:[row(1),row(3)])});
 assert.deepEqual(result,{value:{restored:true,matchedMessages:1},attempts:4,elapsedMs:600});
});

test('持续找不到完全一致的旧消息只等待原预算，固定错误仅附尝试次数和耗时',async()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed([row(1)])),clock=simulatedClock();let reads=0;
 await assert.rejects(waitForBrowserChatCheckpointVerification(checkpoint,{...clock,deadline:550,read:()=>{reads++;return observed([row(1,{text:'已变化的私密正文'})]);}}),error=>{
  assert.ok(error instanceof BrowserChatRecoveryError);assert.equal(error.code,'checkpoint-mismatch');assert.equal(error.attempts,3);assert.equal(error.elapsedMs,550);
  assert.doesNotMatch(JSON.stringify(error)+error.message,/私密正文|https:|textHash|11111111/);return true;
 });
 assert.equal(reads,3);assert.deepEqual(clock.waits,[200,200,150]);
});

test('已到截止时间不读取，读取本身耗尽预算也不能接受完整结果',async()=>{
 const clock=simulatedClock();let reads=0;
 await assert.rejects(waitForBrowserChatCheckpointCapture({...clock,deadline:0,read:()=>{reads++;return observed();}}),error=>error instanceof BrowserChatRecoveryError&&error.code==='session-unready'&&error.attempts===0&&error.elapsedMs===0);
 assert.equal(reads,0);
 await assert.rejects(waitForBrowserChatCheckpointCapture({...clock,deadline:500,read:()=>{reads++;clock.advance(501);return observed();}}),error=>error instanceof BrowserChatRecoveryError&&error.code==='session-unready'&&error.attempts===1&&error.elapsedMs===501);
 assert.equal(reads,1);assert.deepEqual(clock.waits,[]);
});

test('PIN或人工解锁保护出现时立即失败，不把锁定状态当普通水合继续等',async()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed());
 const changes:Array<(input:BrowserChatRecoveryObservation)=>void>=[
  input=>{input.inspection.ui!.state='locked';},input=>{input.inspection.ui!.lockInputs=1;},input=>{input.inspection.chatProtection.unlockPending=true;},input=>{input.inspection.chatProtection.needsHuman=true;},
 ];
 for(const change of changes){
  const clock=simulatedClock();let reads=0;
  await assert.rejects(waitForBrowserChatCheckpointVerification(checkpoint,{...clock,deadline:2000,read:()=>{const input=observed();if(++reads===2)change(input);return input;}}),error=>error instanceof BrowserChatRecoveryError&&error.code==='session-unready'&&error.attempts===2&&error.elapsedMs===200);
  assert.equal(reads,2);assert.deepEqual(clock.waits,[200]);
 }
});

test('错账号、错地址及损坏检查点立即失败，不消耗重试预算',async()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed());
 for(const code of ['identity-mismatch','location-mismatch'] as const){
  const clock=simulatedClock();let reads=0;
  await assert.rejects(waitForBrowserChatCheckpointVerification(checkpoint,{...clock,deadline:2000,read:()=>{reads++;const input=observed();if(code==='identity-mismatch')input.selfUserId=peer;else input.url+='?private=secret';return input;}}),error=>error instanceof BrowserChatRecoveryError&&error.code===code&&error.attempts===1&&error.elapsedMs===0);
  assert.equal(reads,1);assert.deepEqual(clock.waits,[]);
 }
 const clock=simulatedClock();let reads=0;
 await assert.rejects(waitForBrowserChatCheckpointVerification({...checkpoint,messages:[]},{...clock,deadline:2000,read:()=>{reads++;return observed();}}),error=>error instanceof BrowserChatRecoveryError&&error.code==='checkpoint-invalid'&&error.attempts===0&&error.elapsedMs===0);
 assert.equal(reads,0);assert.deepEqual(clock.waits,[]);
});

test('控制中止等非helper异常原样传播，读取和等待阶段都不吞掉',async()=>{
 const checkpoint=captureBrowserChatCheckpoint(observed()),clock=simulatedClock(),controlError=Object.assign(new Error('受控取消'),{code:'control-changed'});let reads=0;
 await assert.rejects(waitForBrowserChatCheckpointVerification(checkpoint,{...clock,deadline:2000,read:()=>{if(++reads===2)throw controlError;return observed();}}),error=>error===controlError);
 assert.equal(reads,2);assert.deepEqual(clock.waits,[200]);
 const waitError=new Error('等待已取消');
 await assert.rejects(waitForBrowserChatCheckpointCapture({deadline:1000,now:()=>0,read:observed,wait:async()=>{throw waitError;}}),error=>error===waitError);
});
