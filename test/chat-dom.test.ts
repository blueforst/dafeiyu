import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNativeChatRows,NATIVE_CHAT_CONTRACT,type NativeChatRow,waitForPrivateUI,type PrivateUIState,inspectPrivateConversation} from '../src/chat-dom.js';
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
 for(const url of ['https://x.com/i/chat/999-222','https://evil.example/i/chat/111-222','https://x.com/i/chat/requests']){const result=inspect([row()],url);assert.equal(result.all.length,0);assert.equal(result.events.length,0);assert.equal(result.diagnostics[0].code,'chat-native-conversation-mismatch');assert.equal(result.chatProtection.unlockPending,false);}
});
test('原生row UUID、testid与content引用冲突时明确诊断',()=>{
 for(const message of [row({nativeId:''}),row({testId:'message-different'}),row({contentLinked:false}),row({contentTestId:'message-text-other'})]){const result=inspect([message]);assert.equal(result.events.length,0);assert.equal(result.all[0].text,'');assert.ok(result.diagnostics.some(d=>d.code==='chat-native-id-conflict'));}
});
test('重复同原生ID去重，不同正文复用同ID标记冲突，最新未知不退回挑选',()=>{
 assert.equal(inspect([row(),row()]).all.length,1);const conflict=inspect([row(),row({text:'另一正文'})]);assert.ok(conflict.diagnostics.some(d=>d.code==='chat-native-id-conflict'));assert.equal(conflict.events.length,0);const latest=inspect([row(),row({nativeId:'22222222-2222-4222-8222-222222222222',testId:'message-22222222-2222-4222-8222-222222222222',contentTestId:'message-text-22222222-2222-4222-8222-222222222222',focusTarget:'22222222-2222-4222-8222-222222222222:content',sender:'Peer'})]);assert.equal(latest.all.at(-1)?.direction,'unknown');assert.equal(latest.events.length,0);
});
test('空native log不宣称没有消息，诊断无正文或sender显示信息',()=>{
 const result=inspect([]);assert.ok(result.diagnostics.some(d=>d.status==='unknown'&&d.code==='chat-native-messages-unavailable'));assert.equal(result.diagnostics.some(d=>d.status==='empty'),false);assert.equal(result.chatProtection.unlockPending,false);const observed=inspect([row({sender:'机密显示名',text:'机密消息正文'})]);assert.ok(!JSON.stringify(observed.diagnostics).includes('机密'));assert.ok(!observed.warnings.join().includes('机密'));
});

test('role article和focus target必须绑定当前UUID，旧标签假设不被接受',()=>{
 for(const message of [row({articleRole:''}),row({focusTarget:'other:content'})]){const result=inspect([message]);assert.equal(result.all[0].text,'');assert.equal(result.all[0].direction,'unknown');assert.ok(result.diagnostics.some(d=>d.code==='chat-native-message-structure-unverified'));assert.equal(result.events.length,0);assert.equal(result.chatProtection.unlockPending,false);}
});
test('正文必须唯一dir auto子树，缺失/多候选/资源超界均不猜正文',()=>{
 for(const message of [row({bodyUnique:false}),row({text:''}),row({text:'字'.repeat(30001)})]){const result=inspect([message]);assert.equal(result.all[0].text,'');assert.ok(result.diagnostics.some(d=>d.code==='chat-native-body-unverified'));assert.equal(result.events.length,0);assert.equal(result.chatProtection.unlockPending,false);}
});

const ui=(patch:Partial<PrivateUIState>={}):PrivateUIState=>({state:'ready',code:'private-inbox-ready',contract:NATIVE_CHAT_CONTRACT,locationValid:true,nativeHosts:1,openShadowRoots:1,mainPresent:true,loading:false,loadingIndicators:0,lockInputs:0,emptyMarkers:0,conversationLinks:1,conversationLists:1,optionalEntries:0,validConversations:1,messageLogs:0,messageRows:0,legacyRows:0,...patch});
test('私信等待跨越延迟加载并满足稳定窗口，结构计数不包含正文',async()=>{
 let now=0,reads=0;const ready=await waitForPrivateUI({page:{} as any,kind:'inbox',deadline:1000,now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:10,stableMs:20,minimumObserveMs:20,timeoutMs:100,inspect:async()=>++reads<3?ui({state:'loading',code:'private-page-loading',loading:true,validConversations:0}):ui()});
 assert.equal(ready.state,'ready');assert.ok(ready.samples>=5);assert.ok(now>=40);assert.equal('text' in ready,false);
});
test('未挂载ShadowRoot在预算内继续等，超时后仅标结构不可读不推断锁定',async()=>{
 let now=0;const closed=await waitForPrivateUI({page:{} as any,kind:'conversation',conversationId:'111-222',now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:5,stableMs:0,minimumObserveMs:0,timeoutMs:20,inspect:async()=>ui({state:'loading',code:'private-page-loading',openShadowRoots:0,validConversations:0})});
 assert.equal(closed.state,'unsupported');assert.equal(closed.code,'chat-native-shadow-unavailable');assert.ok(closed.samples>=2);assert.equal(closed.lockInputs,0);
});
test('私信截止时间已过不再读取页面，晚到的ready不进入解析',async()=>{
 let reads=0;const expired=await waitForPrivateUI({page:{} as any,kind:'inbox',deadline:10,now:()=>10,inspect:async()=>{reads++;return ui();}});assert.equal(reads,0);assert.equal(expired.samples,0);assert.equal(expired.code,'private-collection-deadline');
 let now=0;const late=await waitForPrivateUI({page:{} as any,kind:'inbox',deadline:10,now:()=>now,stableMs:0,minimumObserveMs:0,inspect:async()=>{now=11;return ui();}});assert.equal(late.state,'unknown');assert.equal(late.code,'private-collection-deadline');
});
test('专用锁定证据稳定后给blocked所需状态，普通unknown不会自动变空或锁定',async()=>{
 let now=0;const options={page:{} as any,kind:'inbox' as const,now:()=>now,sleep:async(ms:number)=>{now+=ms;},intervalMs:5,stableMs:10,minimumObserveMs:10,timeoutMs:30};
 const locked=await waitForPrivateUI({...options,inspect:async()=>ui({state:'locked',code:'chat-native-locked',lockInputs:1,validConversations:0})});assert.equal(locked.state,'locked');assert.ok(locked.samples>=3);
 now=0;const unknown=await waitForPrivateUI({...options,inspect:async()=>ui({state:'unknown',code:'private-inbox-unverified',validConversations:0})});assert.equal(unknown.state,'unknown');assert.equal(unknown.code,'private-inbox-unverified');assert.ok(unknown.samples>=3);
});

test('就绪信号在超时前才出现但未稳定时不允许解析或确认空',async()=>{
 for(const state of ['ready','empty'] as const){let now=0;const value=await waitForPrivateUI({page:{} as any,kind:'inbox',now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:5,stableMs:15,minimumObserveMs:0,timeoutMs:20,inspect:async()=>now<15?ui({state:'loading',code:'private-page-loading',loading:true}):ui({state,code:state==='empty'?'private-inbox-empty':'private-inbox-ready'})});assert.equal(value.state,'loading');assert.equal(value.code,'private-page-loading');}
});

test('单次结构读取挂起也受墙钟上限约束，不能阻塞整个采集',async()=>{
 const value=await waitForPrivateUI({page:{} as any,kind:'inbox',timeoutMs:15,inspect:()=>new Promise(()=>{})});assert.equal(value.state,'loading');assert.equal(value.code,'private-page-loading');assert.equal(value.samples,1);
});
test('已确认native后host消失不降级legacy，即使document有可靠legacy残留',async()=>{
 let parsed=0;const page={locator:(selector:string)=>({count:async()=>0,evaluateAll:async()=>{parsed++;return [{id:'unsafe',text:'残留正文',direction:'in',timestamp:1,timestampReliable:true}];}})} as any;
 const value=await inspectPrivateConversation(page,'111-222',{stableMs:0,minimumObserveMs:0,inspect:async()=>ui({code:'chat-native-messages-ready',messageLogs:1,messageRows:1})});assert.equal(value.events.length,0);assert.equal(parsed,0);assert.equal(value.contract,NATIVE_CHAT_CONTRACT);
});
test('就绪后的legacy解析跨截止时间时丢弃新事件并保留预算诊断',async()=>{
 let now=0;const page={locator:(selector:string)=>({count:async()=>0,evaluateAll:async()=>{now=11;return [{id:'legacy',text:'不应排队',direction:'in',timestamp:1,timestampReliable:true}];}})} as any;
 const value=await inspectPrivateConversation(page,'111-222',{deadline:10,now:()=>now,stableMs:0,minimumObserveMs:0,inspect:async()=>ui({contract:'legacy',nativeHosts:0,openShadowRoots:0,messageLogs:0,legacyRows:1})});assert.equal(value.events.length,0);assert.equal(value.all.length,0);assert.ok(value.diagnostics.some(row=>row.code==='private-collection-deadline'));
});

const nativeLoadingUI=()=>ui({state:'loading',code:'private-page-loading',loading:true,nativeHosts:1,openShadowRoots:0,conversationLinks:0,conversationLists:0,validConversations:0,messageLogs:0,messageRows:0});
const legacyReadyUI=()=>ui({state:'ready',code:'private-legacy-readable',contract:'legacy',nativeHosts:0,openShadowRoots:0,conversationLinks:0,conversationLists:0,validConversations:0,messageLogs:0,messageRows:0,legacyRows:1});
test('等待见过native加载或host后，不接受随后legacy ready降级',async()=>{
 for(const first of [nativeLoadingUI(),ui({state:'loading',code:'private-page-loading',contract:'unknown',loading:true,nativeHosts:1,openShadowRoots:0,conversationLinks:0,conversationLists:0,validConversations:0})]){
  let now=0,reads=0;const value=await waitForPrivateUI({page:{} as any,kind:'conversation',conversationId:'111-222',deadline:1000,now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:5,stableMs:10,minimumObserveMs:0,timeoutMs:50,inspect:async()=>++reads===1?first:legacyReadyUI()});
  assert.equal(value.contract,NATIVE_CHAT_CONTRACT);assert.equal(value.state,'unknown');assert.equal(value.code,'chat-native-messages-unavailable');assert.equal(value.legacyRows,1);assert.ok(value.samples>=3);assert.ok(now>=50);
 }
});
test('native ready尚未稳定就变成legacy ready时不接受降级',async()=>{
 let now=0,reads=0;const value=await waitForPrivateUI({page:{} as any,kind:'conversation',conversationId:'111-222',deadline:1000,now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:5,stableMs:20,minimumObserveMs:0,timeoutMs:50,inspect:async()=>++reads===1?ui({code:'chat-native-messages-ready',conversationLinks:0,conversationLists:0,validConversations:0,messageLogs:1,messageRows:1}):legacyReadyUI()});
 assert.equal(value.contract,NATIVE_CHAT_CONTRACT);assert.equal(value.state,'unknown');assert.equal(value.code,'chat-native-messages-unavailable');assert.equal(value.legacyRows,1);assert.ok(value.samples>=3);
});
test('native加载到legacy残留后，重新出现native ready且稳定才恢复',async()=>{
 let now=0,reads=0;const value=await waitForPrivateUI({page:{} as any,kind:'conversation',conversationId:'111-222',deadline:1000,now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:5,stableMs:10,minimumObserveMs:0,timeoutMs:50,inspect:async()=>{reads++;return reads===1?nativeLoadingUI():reads<=3?legacyReadyUI():ui({code:'chat-native-messages-ready',conversationLinks:0,conversationLists:0,validConversations:0,messageLogs:1,messageRows:1});}});
 assert.equal(value.contract,NATIVE_CHAT_CONTRACT);assert.equal(value.state,'ready');assert.equal(value.code,'chat-native-messages-ready');assert.equal(value.legacyRows,0);assert.ok(value.samples>=6);assert.ok(now>=25);
});
test('全程只有legacy证据仍能按原契约稳定就绪',async()=>{
 let now=0;const value=await waitForPrivateUI({page:{} as any,kind:'conversation',conversationId:'111-222',deadline:1000,now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:5,stableMs:10,minimumObserveMs:0,timeoutMs:50,inspect:async()=>legacyReadyUI()});
 assert.equal(value.contract,'legacy');assert.equal(value.state,'ready');assert.equal(value.code,'private-legacy-readable');assert.equal(value.legacyRows,1);assert.ok(value.samples>=3);assert.ok(now>=10);
});
test('等待期间native降级legacy残留时，不读取残留正文也不产生事件',async()=>{
 let now=0,reads=0,queries=0,parsed=0;const page={url:()=> 'https://x.com/i/chat/111-222',locator:(_selector:string)=>{queries++;return {count:async()=>0,evaluateAll:async()=>{parsed++;return [{id:'legacy-residue',text:'不应读取的残留正文',direction:'in',timestamp:1,timestampReliable:true,media:false,contract:'legacy',blockedCodes:[]}];}};}} as any;
 const value=await inspectPrivateConversation(page,'111-222',{deadline:1000,now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:5,stableMs:10,minimumObserveMs:0,timeoutMs:50,inspect:async()=>++reads===1?nativeLoadingUI():legacyReadyUI()});
 assert.equal(value.contract,NATIVE_CHAT_CONTRACT);assert.equal(value.ui?.state,'unknown');assert.equal(value.ui?.code,'chat-native-messages-unavailable');assert.equal(value.all.length,0);assert.equal(value.events.length,0);assert.equal(queries,0);assert.equal(parsed,0);
});
