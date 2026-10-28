import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNativeChatRows,NATIVE_CHAT_CONTRACT,type NativeChatRow} from '../src/chat-dom.js';
const uuid='11111111-1111-4111-8111-111111111111';
const row=(patch:Partial<NativeChatRow>={}):NativeChatRow=>({nativeId:uuid,testId:'message-'+uuid,articleRole:'article',focusTarget:uuid+':content',bodyUnique:true,contentTestId:'message-text-'+uuid,contentLinked:true,text:'合成正文',sender:'You',senderLinked:true,displayTime:'1:10 PM',dateBoundary:'Today',sendStatus:'sent',media:false,...patch});
const inspect=(rows:NativeChatRow[],url='https://x.com/i/chat/111-222')=>inspectNativeChatRows(rows,'111-222',url);
test('新Chat原生UUID和You可以被观察，但分钟时间不伪装为可靠时间或自动事件',()=>{
 const result=inspect([row()]);assert.equal(result.contract,NATIVE_CHAT_CONTRACT);assert.equal(result.events.length,0);assert.equal(result.all.length,1);assert.equal(result.all[0].id,uuid);assert.equal(result.all[0].direction,'out');assert.equal(result.all[0].timestamp,0);assert.equal(result.all[0].timestampReliable,false);assert.equal(result.all[0].displayTime,'1:10 PM');assert.equal(result.all[0].dateBoundary,'Today');assert.ok(result.diagnostics.some(d=>d.code==='chat-native-time-unverified'));assert.equal(result.chatProtection.hasUnlockedSession,true);
});
test('非You、缺失sender引用及正文出现You均不反推入站或出站',()=>{
 for(const message of [row({sender:'Peer'}),row({sender:'You',senderLinked:false}),row({sender:'Peer',text:'You 是正文片段'})]){const result=inspect([message]);assert.equal(result.all[0].direction,'unknown');assert.equal(result.events.length,0);assert.ok(result.all[0].blockedCodes.includes('chat-native-sender-unverified'));}
});
test('会话地址或数字双参与者关系无法绑定时不读取其他会话',()=>{
 for(const url of ['https://x.com/i/chat/999-222','https://evil.example/i/chat/111-222','https://x.com/i/chat/requests']){const result=inspect([row()],url);assert.equal(result.all.length,0);assert.equal(result.events.length,0);assert.equal(result.diagnostics[0].code,'chat-native-conversation-mismatch');assert.equal(result.chatProtection.unlockPending,true);}
});
test('原生row UUID、testid与content引用冲突时明确诊断',()=>{
 for(const message of [row({nativeId:''}),row({testId:'message-different'}),row({contentLinked:false}),row({contentTestId:'message-text-other'})]){const result=inspect([message]);assert.equal(result.events.length,0);assert.equal(result.all[0].text,'');assert.ok(result.diagnostics.some(d=>d.code==='chat-native-id-conflict'));}
});
test('重复同原生ID去重，不同正文复用同ID标记冲突，最新未知不退回挑选',()=>{
 assert.equal(inspect([row(),row()]).all.length,1);const conflict=inspect([row(),row({text:'另一正文'})]);assert.ok(conflict.diagnostics.some(d=>d.code==='chat-native-id-conflict'));assert.equal(conflict.events.length,0);const latest=inspect([row(),row({nativeId:'22222222-2222-4222-8222-222222222222',testId:'message-22222222-2222-4222-8222-222222222222',contentTestId:'message-text-22222222-2222-4222-8222-222222222222',focusTarget:'22222222-2222-4222-8222-222222222222:content',sender:'Peer'})]);assert.equal(latest.all.at(-1)?.direction,'unknown');assert.equal(latest.events.length,0);
});
test('空native log不宣称没有消息，诊断无正文或sender显示信息',()=>{
 const result=inspect([]);assert.ok(result.diagnostics.some(d=>d.status==='unknown'&&d.code==='chat-native-messages-unavailable'));assert.equal(result.diagnostics.some(d=>d.status==='empty'),false);assert.equal(result.chatProtection.unlockPending,true);const observed=inspect([row({sender:'机密显示名',text:'机密消息正文'})]);assert.ok(!JSON.stringify(observed.diagnostics).includes('机密'));assert.ok(!observed.warnings.join().includes('机密'));
});

test('role article和focus target必须绑定当前UUID，旧标签假设不被接受',()=>{
 for(const message of [row({articleRole:''}),row({focusTarget:'other:content'})]){const result=inspect([message]);assert.equal(result.all[0].text,'');assert.equal(result.all[0].direction,'unknown');assert.ok(result.diagnostics.some(d=>d.code==='chat-native-message-structure-unverified'));assert.equal(result.events.length,0);assert.equal(result.chatProtection.unlockPending,true);}
});
test('正文必须唯一dir auto子树，缺失/多候选/资源超界均不猜正文',()=>{
 for(const message of [row({bodyUnique:false}),row({text:''}),row({text:'字'.repeat(30001)})]){const result=inspect([message]);assert.equal(result.all[0].text,'');assert.ok(result.diagnostics.some(d=>d.code==='chat-native-body-unverified'));assert.equal(result.events.length,0);assert.equal(result.chatProtection.unlockPending,true);}
});
