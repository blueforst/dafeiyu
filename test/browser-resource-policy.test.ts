import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserResourceGuard,BROWSER_RECOVERY_POLICY} from '../src/unattended-health.js';
const identity={handle:'worker',loggedIn:true,needsHuman:false};
function fixture(){let now=0,ratio=.8,restarts=0;const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:ratio*2000,limitBytes:2000,ratio,source:'cgroup'}),identity:async()=>identity,restart:async()=>{restarts++;return identity;}});return {guard,get now(){return now;},advance:(ms:number)=>{now+=ms;},ratio:(value:number)=>{ratio=value;},get restarts(){return restarts;}};}
const safe={safePoint:true};

test('瞬时超过75%仅观察；持续30秒两采样且显式轮次安全边界才恢复',async()=>{
 const f=fixture();await f.guard.before('prepare-round','auto','worker',safe);assert.equal(f.restarts,0);assert.equal(f.guard.snapshot().recoveryDeferredReason,'pressure-observation');f.advance(31000);
 await f.guard.before('context','auto','worker',safe);assert.equal(f.restarts,0);assert.equal(f.guard.snapshot().recoveryDeferredReason,'unsafe-point');await f.guard.before('prepare-round','auto','worker');assert.equal(f.restarts,0);
 await f.guard.before('prepare-round','auto','worker',safe);assert.equal(f.restarts,1);assert.equal(f.guard.snapshot().memoryPressureSamples,1);
});

test('压力消退重置确认窗口，不把两个短峰值拼成持续压力',async()=>{
 const f=fixture();await f.guard.before('prepare-round','auto','worker',safe);f.advance(31000);f.ratio(.4);f.guard.sample();f.ratio(.8);await f.guard.before('prepare-round','auto','worker',safe);assert.equal(f.restarts,0);assert.equal(f.guard.snapshot().memoryPressureSince,f.now);f.advance(31000);await f.guard.before('prepare-round','auto','worker',safe);assert.equal(f.restarts,1);
});

test('恢复后一分种压力再次持续出现明确暂停故障，不每轮重复close',async()=>{
 const f=fixture();await f.guard.before('prepare-round','auto','worker',safe);f.advance(31000);await f.guard.before('prepare-round','auto','worker',safe);assert.equal(f.restarts,1);f.advance(60000);
 await assert.rejects(f.guard.before('prepare-round','auto','worker',safe),error=>(error as any).code==='browser-resource-pressure'&&(error as any).resourceReason==='memory-pressure-recurred');assert.equal(f.restarts,1);assert.equal(f.guard.snapshot().resourceFault,'memory-pressure-recurred');assert.equal(f.guard.snapshot().businessBlocked,true);await assert.rejects(f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlocked']}),error=>(error as any).resourceReason==='memory-pressure-recurred');assert.equal(f.restarts,1);
});

test('私信已解锁或解锁中仅记录待恢复，持续95%时暂停且不关闭会话',async()=>{
 const f=fixture();await f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlocked']});f.advance(31000);await f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlocked']});assert.equal(f.restarts,0);assert.equal(f.guard.snapshot().recoveryDeferredReason,'protected-session');
 await f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlock-pending']});assert.equal(f.restarts,0);f.ratio(.96);await assert.rejects(f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlocked']}),error=>(error as any).resourceReason==='protected-session-pressure');assert.equal(f.restarts,0);
});

test('未收束出站保持可回查并阻止新业务，发送与回查边界永不重启',async()=>{
 const f=fixture();f.ratio(.99);await f.guard.before('prepare-round','auto','worker',safe);f.advance(31000);
 const result=await f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['unsettled-outbox','chat-unlocked']});assert.equal(result.businessBlocked,true);assert.equal(result.recoveryDeferredReason,'protected-session');
 for(const operation of ['send','post','lookup','lookupPost','lookup-post'])await f.guard.before(operation,'auto','worker',safe);assert.equal(f.restarts,0);
});

test('一小时最多两次实际恢复，间隔满足也不能无限重启掩盖资源问题',async()=>{
 let now=0,ratio=.8,restarts=0;const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:ratio*2000,limitBytes:2000,ratio,source:'cgroup'}),identity:async()=>identity,restart:async()=>{restarts++;ratio=.3;return identity;}});
 for(let attempt=0;attempt<2;attempt++){ratio=.8;await guard.before('prepare-round','auto','worker',safe);now+=31000;await guard.before('prepare-round','auto','worker',safe);now+=BROWSER_RECOVERY_POLICY.minRestartIntervalMs+1000;}
 ratio=.8;await guard.before('prepare-round','auto','worker',safe);now+=31000;await assert.rejects(guard.before('prepare-round','auto','worker',safe),error=>(error as any).resourceReason==='recovery-budget-exhausted');assert.equal(restarts,2);
});
