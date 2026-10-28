import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserResourceGuard,BrowserRecoveryFailure,readBrowserMemory,waitForIdentityReady} from '../src/unattended-health.js';
import type {Identity} from '../src/types.js';
const logged:Identity={handle:'worker',loggedIn:true,needsHuman:false};
const high={bytes:1800,rawBytes:1900,inactiveFileBytes:100,limitBytes:2000,ratio:.9,source:'cgroup' as const,measurement:'working-set' as const};

test('cgroup以current-inactive_file计压力，保留原始口径且不扣活动file或slab',async()=>{
 const files:Record<string,string>={'/cg/memory.current':'1900','/cg/memory.max':'2000','/cg/memory.stat':'file 1500\ninactive_file 700\nactive_file 800\nslab_reclaimable 100\n'};
 const memory=()=>readBrowserMemory({cgroupRoot:'/cg',read:path=>{if(!(path in files))throw Error('missing');return files[path];}});let restarts=0;
 assert.deepEqual(memory(),{bytes:1200,rawBytes:1900,inactiveFileBytes:700,measurement:'working-set',limitBytes:2000,ratio:.6,source:'cgroup'});
 const guard=new BrowserResourceGuard({readMemory:memory,identity:async()=>logged,restart:async()=>{restarts++;return logged;}});await guard.before('context','auto','worker');assert.equal(restarts,0);
 files['/cg/memory.stat']='file 1500\ninactive_file 100\nactive_file 1400\nslab_reclaimable 700\n';assert.equal(memory().bytes,1800);await guard.before('context','auto','worker');assert.equal(restarts,1);
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
 await assert.rejects(guard.before('context','auto','worker'),error=>(error as any).recoveryStage==='navigate-home'&&(error as any).recoveryCode==='navigation-failed');
 const state=guard.snapshot();assert.equal(state.lastRestartStage,'navigate-home');assert.equal(state.lastRestartFailureCode,'navigation-failed');assert.equal(state.lastRestartDurationMs,5);assert.equal(state.lastRestartReason,'memory-threshold');assert.equal(state.lastRestartAttemptAt,1);assert.equal(state.restarts,0);assert.equal((events[0] as any).memory.measurement,'working-set');
 assert.ok(!JSON.stringify(events).includes('secret-value'));assert.ok(!JSON.stringify(events).includes('https://'));assert.ok(!JSON.stringify(state).includes('token'));
});

test('资源guard先绑定原账号再关闭，恢复回调使用同一预期身份等待SPA',async()=>{
 let now=0,restarts=0,reads=0;const events:any[]=[];
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>high,identity:async()=>logged,restart:async(stage,expected)=>{restarts++;assert.equal(expected,'worker');stage?.('close-context');stage?.('launch-context');stage?.('navigate-home');stage?.('wait-identity');return waitForIdentityReady(async()=>++reads<3?{handle:'',loggedIn:false,needsHuman:false}:logged,expected!,{clock:()=>now,timeoutMs:100,intervalMs:10,wait:async ms=>{now+=ms;}});},onRestart:info=>events.push(info)});
 await guard.before('context','auto','worker');assert.equal(restarts,1);assert.equal(reads,3);assert.equal(guard.snapshot().lastRestartStage,'completed');assert.equal(guard.snapshot().lastRestartFailureCode,null);assert.equal(events[0].durationMs,20);
 const mismatch=new BrowserResourceGuard({readMemory:()=>high,identity:async()=>({...logged,handle:'other'}),restart:async()=>{throw Error('不得关闭不同账号的上下文');}});await assert.rejects(mismatch.before('context','auto','worker'),error=>(error as any).recoveryCode==='identity-mismatch'&&(error as any).recoveryStage==='precheck-identity');
});


test('单次identity读取卡住也受同一个readiness截止约束',async()=>{
 let reads=0;await assert.rejects(waitForIdentityReady(async()=>{reads++;return new Promise<Identity>(()=>{});},'worker',{timeoutMs:5}),error=>error instanceof BrowserRecoveryFailure&&error.recoveryCode==='timeout'&&error.recoveryStage==='wait-identity');assert.equal(reads,1);
});
