import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserResourceGuard,BrowserRecoveryFailure,browserRecoveryCode,readBrowserMemory,waitForIdentityReady} from '../src/unattended-health.js';
import type {Identity} from '../src/types.js';
const logged:Identity={handle:'worker',loggedIn:true,needsHuman:false};
const high={bytes:1800,rawBytes:1900,inactiveFileBytes:100,limitBytes:2000,ratio:.9,source:'cgroup' as const,measurement:'working-set' as const};
const approved={safePoint:true,allowSessionRecovery:true,protectedReasons:['chat-unlocked','reviewed-unsettled-outbox'] as const};
const recoveryGate=()=>({...approved,protectedReasons:[...approved.protectedReasons]});

test('cgroup以current-inactive_file计压力，保留原始口径且不扣活动file或slab',async()=>{
 const files:Record<string,string>={'/cg/memory.current':'1900','/cg/memory.max':'2000','/cg/memory.stat':'file 1500\ninactive_file 700\nactive_file 800\nslab_reclaimable 100\n'};
 const memory=()=>readBrowserMemory({cgroupRoot:'/cg',read:path=>{if(!(path in files))throw Error('missing');return files[path];}});let restarts=0,now=0;
 assert.deepEqual(memory(),{bytes:1200,rawBytes:1900,inactiveFileBytes:700,measurement:'working-set',limitBytes:2000,ratio:.6,source:'cgroup'});
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:memory,identity:async()=>logged,restart:async stage=>{stage?.('close-context');restarts++;return logged;}});await guard.before('context','auto','worker');assert.equal(restarts,0);
 files['/cg/memory.stat']='file 1500\ninactive_file 100\nactive_file 1400\nslab_reclaimable 700\n';assert.equal(memory().bytes,1800);await guard.before('prepare-round','auto','worker',{safePoint:true});now+=31000;await guard.before('finish-round','auto','worker',{safePoint:true});assert.equal(restarts,1);
 delete files['/cg/memory.stat'];assert.equal(memory().measurement,'cgroup-current');assert.equal(memory().bytes,1900);assert.equal(memory().ratio,.95);
 files['/cg/memory.stat']='inactive_file 3000\n';assert.equal(memory().bytes,0);
});

test('SPA DOMContentLoaded后短暂无账号和evaluate导航抖动可有界等待同一身份',async()=>{
 let now=0,reads=0;const waited:number[]=[];
 const identity=await waitForIdentityReady(async()=>{reads++;if(reads===1)throw Error('Execution context was destroyed, most likely because of a navigation');if(reads<4)return {handle:'',loggedIn:false,needsHuman:false};return logged;},'worker',{clock:()=>now,timeoutMs:100,intervalMs:10,wait:async ms=>{waited.push(ms);now+=ms;}});
 assert.deepEqual(identity,logged);assert.equal(reads,4);assert.deepEqual(waited,[10,10,10]);
});

test('身份等待遇异号、人工验证或账号受限立即失败，不把登录问题当水合延迟',async()=>{
 for(const [identity,code] of [[{...logged,handle:'other'},'identity-mismatch'],[{...logged,needsHuman:true},'needs-human'],[{...logged,restricted:'suspended'},'account-restricted']] as const){
  let waits=0;await assert.rejects(waitForIdentityReady(async()=>identity,'worker',{wait:async()=>{waits++;}}),error=>error instanceof BrowserRecoveryFailure&&error.recoveryCode===code);assert.equal(waits,0);
 }
});

test('始终未就绪在截止时间收束，保留固定身份原因码',async()=>{
 let now=0,reads=0;await assert.rejects(waitForIdentityReady(async()=>{reads++;return {handle:'',loggedIn:false,needsHuman:false};},'worker',{clock:()=>now,timeoutMs:30,intervalMs:10,wait:async ms=>{now+=ms;}}),error=>error instanceof BrowserRecoveryFailure&&error.recoveryCode==='identity-not-ready'&&error.recoveryStage==='wait-identity');assert.equal(now,30);assert.equal(reads,4);
});

test('恢复失败保留阶段、原因码、耗时与内存，日志不包含底层URL或异常正文',async()=>{
 let now=1;const events:unknown[]=[];const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>high,identity:async()=>logged,restart:async stage=>{stage?.('close-context');now+=2;stage?.('launch-context');now+=3;stage?.('navigate-home');throw Error('navigation failed https://x.com/private?token=secret-value');},onRestart:event=>events.push(event)});
 await guard.before('prepare-round','auto','worker',{safePoint:true});now+=31000;await assert.rejects(guard.before('finish-round','auto','worker',{safePoint:true}),error=>(error as any).recoveryStage==='navigate-home'&&(error as any).recoveryCode==='navigation-failed');
 const state=guard.snapshot();assert.equal(state.lastRestartStage,'navigate-home');assert.equal(state.lastRestartFailureCode,'navigation-failed');assert.equal(state.lastRestartDurationMs,5);assert.equal(state.lastRestartReason,'memory-threshold');assert.equal(state.lastRestartAttemptAt,31001);assert.equal(state.restarts,0);assert.equal((events[0] as any).memory.measurement,'working-set');
 assert.ok(!JSON.stringify(events).includes('secret-value'));assert.ok(!JSON.stringify(events).includes('https://'));assert.ok(!JSON.stringify(state).includes('token'));
});

test('资源guard先绑定原账号再关闭，恢复回调使用同一预期身份等待SPA',async()=>{
 let now=0,restarts=0,reads=0;const events:any[]=[];
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>high,identity:async()=>logged,restart:async(stage,expected)=>{restarts++;assert.equal(expected,'worker');stage?.('close-context');stage?.('launch-context');stage?.('navigate-home');stage?.('wait-identity');return waitForIdentityReady(async()=>++reads<3?{handle:'',loggedIn:false,needsHuman:false}:logged,expected!,{clock:()=>now,timeoutMs:100,intervalMs:10,wait:async ms=>{now+=ms;}});},onRestart:info=>events.push(info)});
 await guard.before('prepare-round','auto','worker',{safePoint:true});now+=31000;await guard.before('finish-round','auto','worker',{safePoint:true});assert.equal(restarts,1);assert.equal(reads,3);assert.equal(guard.snapshot().lastRestartStage,'completed');assert.equal(guard.snapshot().lastRestartFailureCode,null);assert.equal(events[0].durationMs,20);
 let mismatchNow=0;const mismatch=new BrowserResourceGuard({clock:()=>mismatchNow,readMemory:()=>high,identity:async()=>({...logged,handle:'other'}),restart:async()=>{throw Error('不得关闭不同账号的上下文');}});await mismatch.before('prepare-round','auto','worker',{safePoint:true});mismatchNow+=31000;await assert.rejects(mismatch.before('finish-round','auto','worker',{safePoint:true}),error=>(error as any).recoveryCode==='identity-mismatch'&&(error as any).recoveryStage==='precheck-identity');
});


test('单次identity读取卡住也受同一个readiness截止约束',async()=>{
 let reads=0;await assert.rejects(waitForIdentityReady(async()=>{reads++;return new Promise<Identity>(()=>{});},'worker',{timeoutMs:5}),error=>error instanceof BrowserRecoveryFailure&&error.recoveryCode==='timeout'&&error.recoveryStage==='wait-identity');assert.equal(reads,1);
});

test('Chat恢复前缺少持久检查点时保留固定失败阶段，不能关闭上下文或计为成功',async()=>{
 let now=0;const events:any[]=[];
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>high,identity:async()=>logged,restart:async stage=>{stage?.('precheck-chat');throw new BrowserRecoveryFailure('chat-checkpoint-missing','precheck-chat');},onRestart:event=>events.push(event)});
 await guard.before('prepare-round','auto','worker',recoveryGate());now=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',recoveryGate()),error=>(error as any).recoveryCode==='chat-checkpoint-missing'&&(error as any).recoveryStage==='precheck-chat');
 const state=guard.snapshot();assert.equal(state.restarts,0);assert.equal(state.lastRestartAt,null);assert.equal(state.businessBlocked,true);assert.ok(state.restartError);assert.equal(events.length,1);assert.equal(events[0].failureCode,'chat-checkpoint-missing');
});

test('Chat验证失败只保留当前失败上下文，后续轮首轮末与回查均不能清除故障或重复关闭',async()=>{
 let now=0,ratio=.9,closes=0;const events:any[]=[];
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({...high,ratio}),identity:async()=>logged,restart:async stage=>{stage?.('precheck-chat');stage?.('close-context');closes++;stage?.('launch-context');stage?.('verify-identity');stage?.('verify-chat');throw new BrowserRecoveryFailure('chat-recovery-unverified','verify-chat');},onRestart:event=>events.push(event)});
 await guard.before('prepare-round','auto','worker',recoveryGate());now=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',recoveryGate()),error=>(error as any).recoveryCode==='chat-recovery-unverified'&&(error as any).recoveryStage==='verify-chat');
 const failure=guard.snapshot();assert.equal(closes,1);assert.equal(failure.restarts,0);assert.equal(failure.lastRestartAt,null);assert.ok(failure.restartError);assert.equal(failure.businessBlocked,true);
 now+=2*3600000;ratio=.3;
 for(const operation of ['lookup','lookupPost','health']){const state=await guard.before(operation,'auto','worker',recoveryGate());assert.equal(state.restartError,failure.restartError);assert.equal(state.businessBlocked,true);assert.deepEqual(state.protectedReasons,approved.protectedReasons);}
 for(const operation of ['prepare-round','finish-round'])await assert.rejects(guard.before(operation,'auto','worker',recoveryGate()),error=>(error as any).recoveryCode==='chat-recovery-unverified');
 assert.equal(closes,1);assert.equal(events.length,1);assert.equal(guard.snapshot().lastRestartFailureCode,'chat-recovery-unverified');
});

test('关闭前控制取消不消耗真实关闭额度，恢复auto后仍需重新走同账号和Chat验证',async()=>{
 let now=0,calls=0,closes=0;const events:any[]=[];
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>high,identity:async()=>logged,restart:async(stage,expected)=>{assert.equal(expected,'worker');calls++;stage?.('precheck-chat');if(calls===1)throw new BrowserRecoveryFailure('control-changed','precheck-chat');stage?.('close-context');closes++;stage?.('verify-identity');stage?.('verify-chat');return logged;},onRestart:event=>events.push(event)});
 await guard.before('prepare-round','auto','worker',recoveryGate());now=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',recoveryGate()),error=>(error as any).recoveryCode==='control-changed');
 const cancelled=guard.snapshot();assert.equal(closes,0);assert.equal(cancelled.restartError,null);assert.equal(cancelled.businessBlocked,false);assert.equal(cancelled.lastRestartAt,null);assert.equal(cancelled.lastRestartFailureCode,'control-changed');
 await guard.before('finish-round','paused','worker',recoveryGate());assert.equal(calls,1);
 await guard.before('finish-round','auto','worker',recoveryGate());assert.equal(calls,2);assert.equal(closes,1);assert.equal(guard.snapshot().restarts,1);assert.equal(events.length,2);assert.equal(events[0].ok,false);assert.equal(events[1].ok,true);
});

test('已开始关闭后的控制取消保留失败，不用恢复auto再关一次逃过间隔',async()=>{
 let now=0,closes=0;
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>high,identity:async()=>logged,restart:async stage=>{stage?.('close-context');closes++;stage?.('launch-context');throw new BrowserRecoveryFailure('control-changed','launch-context');}});
 await guard.before('prepare-round','auto','worker',recoveryGate());now=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',recoveryGate()),error=>(error as any).recoveryCode==='control-changed'&&(error as any).recoveryStage==='launch-context');
 assert.ok(guard.snapshot().restartError);assert.equal(guard.snapshot().businessBlocked,true);assert.equal(guard.snapshot().restarts,0);
 now+=3600000;await assert.rejects(guard.before('finish-round','auto','worker',recoveryGate()),error=>(error as any).recoveryCode==='control-changed');assert.equal(closes,1);
});

test('同一次回调重复报告close阶段只占一个实际恢复预算，成功计数包含Chat验证',async()=>{
 let now=0,ratio=.9,closes=0;
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({...high,ratio}),identity:async()=>logged,restart:async stage=>{stage?.('close-context');stage?.('close-context');closes++;stage?.('verify-identity');stage?.('verify-chat');ratio=.3;return logged;}});
 for(let attempt=0;attempt<2;attempt++){ratio=.9;await guard.before('prepare-round','auto','worker',recoveryGate());now+=31000;await guard.before('finish-round','auto','worker',recoveryGate());now+=300000;}
 assert.equal(closes,2);assert.equal(guard.snapshot().restarts,2);assert.equal(guard.snapshot().lastRestartStage,'completed');
 ratio=.9;await guard.before('prepare-round','auto','worker',recoveryGate());now+=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',recoveryGate()),error=>(error as any).resourceReason==='recovery-budget-exhausted');assert.equal(closes,2);
});

test('Chat阶段和控制变化只暴露有界原因码，不把底层页面与认证内容作为原因',()=>{
 for(const stage of ['precheck-chat','verify-chat'] as const)assert.equal(browserRecoveryCode(Error('https://x.com/messages?token=secret-session'),stage),'chat-recovery-unverified');
 assert.equal(browserRecoveryCode(new BrowserRecoveryFailure('chat-checkpoint-missing','precheck-chat'),'precheck-chat'),'chat-checkpoint-missing');
 assert.equal(browserRecoveryCode(new BrowserRecoveryFailure('control-changed','verify-chat'),'verify-chat'),'control-changed');
});
