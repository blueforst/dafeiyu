import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserResourceGuard,BROWSER_RECOVERY_POLICY,type BrowserProtectionReason} from '../src/unattended-health.js';

const identity={handle:'worker',loggedIn:true,needsHuman:false};
function fixture(){
 let now=0,ratio=.8,restarts=0;
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:ratio*2000,limitBytes:2000,ratio,source:'cgroup'}),identity:async()=>identity,restart:async stage=>{stage?.('close-context');restarts++;return identity;}});
 return {guard,get now(){return now;},advance:(ms:number)=>{now+=ms;},ratio:(value:number)=>{ratio=value;},get restarts(){return restarts;}};
}
const safe={safePoint:true};
const soft:BrowserProtectionReason[]=['chat-unlocked','reviewed-unsettled-outbox'];
const approved={...safe,allowSessionRecovery:true,protectedReasons:soft};

test('prepare只采样和准入，即使压力持续且显式授权也不能提前重启',async()=>{
 const f=fixture();
 await f.guard.before('prepare-round','auto','worker',safe);
 assert.equal(f.restarts,0);
 assert.equal(f.guard.snapshot().recoveryDeferredReason,'pressure-observation');
 f.advance(31000);
 for(const gate of [safe,approved,{...approved,protectedReasons:[]}]){
  await f.guard.before('prepare-round','auto','worker',gate);
  assert.equal(f.restarts,0);
  assert.equal(f.guard.snapshot().pendingRecoveryReason,'memory-threshold');
 }
 await f.guard.before('finish-round','auto','worker',safe);
 assert.equal(f.restarts,1);
 assert.equal(f.guard.snapshot().memoryPressureSamples,1);
});

test('轮末恢复仍需持续30秒且至少两个有间隔采样，不以调用次数凑压力',async()=>{
 const f=fixture();
 await f.guard.before('prepare-round','auto','worker',safe);
 for(let n=0;n<4;n++)await f.guard.before('finish-round','auto','worker',safe);
 assert.equal(f.restarts,0);
 assert.equal(f.guard.snapshot().memoryPressureSamples,1);
 f.advance(29000);
 await f.guard.before('finish-round','auto','worker',safe);
 assert.equal(f.restarts,0);
 f.advance(1000);
 await f.guard.before('finish-round','auto','worker',safe);
 assert.equal(f.restarts,1);
});

test('压力消退重置确认窗口，不把两个短峰值拼成持续压力',async()=>{
 const f=fixture();
 await f.guard.before('prepare-round','auto','worker',safe);
 f.advance(31000);f.ratio(.4);f.guard.sample();f.ratio(.8);
 await f.guard.before('finish-round','auto','worker',safe);
 assert.equal(f.restarts,0);
 assert.equal(f.guard.snapshot().memoryPressureSince,f.now);
 f.advance(31000);
 await f.guard.before('finish-round','auto','worker',safe);
 assert.equal(f.restarts,1);
});

test('恢复后一分钟压力再次持续出现只在轮末明确暂停，不每轮重复close',async()=>{
 const f=fixture();
 await f.guard.before('prepare-round','auto','worker',safe);
 f.advance(31000);
 await f.guard.before('finish-round','auto','worker',safe);
 assert.equal(f.restarts,1);
 f.advance(60000);
 await f.guard.before('prepare-round','auto','worker',approved);
 assert.equal(f.restarts,1);
 await assert.rejects(f.guard.before('finish-round','auto','worker',safe),error=>(error as any).code==='browser-resource-pressure'&&(error as any).resourceReason==='memory-pressure-recurred');
 assert.equal(f.restarts,1);
 assert.equal(f.guard.snapshot().resourceFault,'memory-pressure-recurred');
 assert.equal(f.guard.snapshot().businessBlocked,true);
 await assert.rejects(f.guard.before('prepare-round','auto','worker',approved),error=>(error as any).resourceReason==='memory-pressure-recurred');
 assert.equal(f.restarts,1);
});

test('无新授权的私信会话仍受保护，持续95%时暂停但不关闭',async()=>{
 const f=fixture();
 await f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlocked']});
 f.advance(31000);
 await f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlocked']});
 assert.equal(f.restarts,0);
 assert.equal(f.guard.snapshot().recoveryDeferredReason,'protected-session');
 await f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlock-pending']});
 f.ratio(.96);
 await assert.rejects(f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['chat-unlocked']}),error=>(error as any).resourceReason==='protected-session-pressure');
 assert.equal(f.restarts,0);
});

test('已授权soft保护在临界prepare继续完整轮，仅显式轮末才实际恢复',async()=>{
 const f=fixture();f.ratio(.96);
 for(const elapsed of [0,31000]){
  f.advance(elapsed);
  const state=await f.guard.before('prepare-round','auto','worker',approved);
  assert.equal(state.businessBlocked,false);
  assert.equal(f.restarts,0);
 }
 const state=await f.guard.before('finish-round','auto','worker',approved);
 assert.equal(f.restarts,1);
 assert.equal(state.restarts,1);
 assert.equal(state.lastRestartStage,'completed');
});

test('只有精确true可解除轮末soft保护，缺授权和非布尔真值不能放行',async()=>{
 for(const allowSessionRecovery of [undefined,false,'true',1]){
  const f=fixture(),gate={...approved,allowSessionRecovery:allowSessionRecovery as any};
  await f.guard.before('prepare-round','auto','worker',gate);
  f.advance(31000);
  const state=await f.guard.before('finish-round','auto','worker',gate);
  assert.equal(state.recoveryDeferredReason,'protected-session');
  assert.equal(f.restarts,0);
 }
 const f=fixture();f.ratio(.96);
 const gate={...safe,allowSessionRecovery:'true' as any,protectedReasons:['chat-unlocked' as const]};
 await f.guard.before('prepare-round','auto','worker',gate);f.advance(31000);
 await assert.rejects(f.guard.before('prepare-round','auto','worker',gate),error=>(error as any).resourceReason==='protected-session-pressure');
 assert.equal(f.restarts,0);
});

test('单独Chat或已审核旧项均仅在授权轮末可轮换，所有硬保护及混合保护均不解除',async()=>{
 for(const reason of soft){
  const f=fixture(),gate={...approved,protectedReasons:[reason]};
  await f.guard.before('prepare-round','auto','worker',gate);f.advance(31000);
  await f.guard.before('finish-round','auto','worker',gate);
  assert.equal(f.restarts,1,reason);
 }
 const hard:BrowserProtectionReason[]=['unsettled-outbox','chat-unlock-pending','needs-human','active-round'];
 for(const reason of hard)for(const protectedReasons of [[reason],[...soft,reason]]){
  const f=fixture(),gate={...approved,protectedReasons};
  await f.guard.before('prepare-round','auto','worker',gate);f.advance(31000);
  const state=await f.guard.before('finish-round','auto','worker',gate);
  assert.equal(state.recoveryDeferredReason,'protected-session',reason);
  assert.equal(f.restarts,0,reason);
 }
});

test('错时机、缺安全点及提交和回查操作永不借soft授权重启',async()=>{
 const f=fixture();
 await f.guard.before('prepare-round','auto','worker',approved);f.advance(31000);
 for(const operation of ['prepare-round','context','send','post','lookup','lookupPost','lookup-post','control','health','finishRound']){
  await f.guard.before(operation,'auto','worker',approved);
  assert.equal(f.restarts,0,operation);
 }
 for(const safePoint of [undefined,false,'true',1]){
  await f.guard.before('finish-round','auto','worker',{...approved,safePoint:safePoint as any});
  assert.equal(f.restarts,0);
 }
 await f.guard.before('finish-round','auto','worker',approved);
 assert.equal(f.restarts,1);
});

test('暂停、接管或draining即使有轮末授权也不恢复，不隐式恢复控制',async()=>{
 for(const control of ['paused','manual','draining']){
  const f=fixture();
  await f.guard.before('prepare-round',control,'worker',approved);f.advance(31000);
  const state=await f.guard.before('finish-round',control,'worker',approved);
  assert.equal(state.recoveryDeferredReason,'control-not-auto');
  assert.equal(f.restarts,0,control);
 }
});

test('无内存或时长压力时每个轮末都不重启，授权不等于强制命令',async()=>{
 const f=fixture();f.ratio(.4);
 for(let round=0;round<5;round++){
  await f.guard.before('prepare-round','auto','worker',approved);
  const state=await f.guard.before('finish-round','auto','worker',approved);
  assert.equal(state.pendingRecoveryReason,null);
  assert.equal(f.restarts,0);
  f.advance(60000);
 }
});

test('未收束出站临界时保持只回查，轮末授权不能关闭或重发',async()=>{
 const f=fixture();f.ratio(.99);
 await f.guard.before('prepare-round','auto','worker',safe);f.advance(31000);
 const gate={...approved,protectedReasons:['unsettled-outbox' as const,...soft]};
 for(const operation of ['prepare-round','finish-round']){
  const state=await f.guard.before(operation,'auto','worker',gate);
  assert.equal(state.businessBlocked,true);
  assert.equal(state.recoveryDeferredReason,'protected-session');
 }
 for(const operation of ['send','post','lookup','lookupPost','lookup-post'])await f.guard.before(operation,'auto','worker',approved);
 assert.equal(f.restarts,0);
});

test('75%以上非临界unknown只延后轮换，不全局阻塞其他通道',async()=>{
 const f=fixture();
 for(const elapsed of [0,31000]){
  f.advance(elapsed);
  const state=await f.guard.before('prepare-round','auto','worker',{...safe,protectedReasons:['unsettled-outbox','chat-unlocked']});
  assert.equal(state.businessBlocked,false);
  assert.equal(state.recoveryDeferredReason,'protected-session');
  assert.equal(state.pendingRecoveryReason,'memory-threshold');
  assert.equal(f.restarts,0);
 }
});

test('低内存时长到期也等完整轮末，未审核unknown继续保护会话',async()=>{
 const f=fixture();f.ratio(.4);f.advance(25*3600000);
 const hardGate={...approved,protectedReasons:['unsettled-outbox' as const,...soft]};
 for(const operation of ['prepare-round','finish-round']){
  const state=await f.guard.before(operation,'auto','worker',hardGate);
  assert.equal(state.pendingRecoveryReason,'runtime-threshold');
  assert.equal(state.businessBlocked,false);
  assert.equal(state.recoveryDeferredReason,'protected-session');
  assert.equal(f.restarts,0);
 }
 const prepared=await f.guard.before('prepare-round','auto','worker',approved);
 assert.equal(prepared.businessBlocked,false);
 assert.equal(f.restarts,0);
 await f.guard.before('finish-round','auto','worker',approved);
 assert.equal(f.restarts,1);
});

test('unknown在95%立即只回查，压力消退后其他通道可继续且不提前重启',async()=>{
 const f=fixture();f.ratio(.95);
 const gate={...approved,protectedReasons:['unsettled-outbox' as const,...soft]};
 let state=await f.guard.before('prepare-round','auto','worker',gate);
 assert.equal(state.businessBlocked,true);f.advance(31000);
 state=await f.guard.before('prepare-round','auto','worker',gate);
 assert.equal(state.businessBlocked,true);f.ratio(.8);
 state=await f.guard.before('prepare-round','auto','worker',gate);
 assert.equal(state.businessBlocked,false);
 assert.equal(f.restarts,0);
});

test('已有资源故障不能由soft授权或非临界unknown变成可发送',async()=>{
 const f=fixture();
 await f.guard.before('prepare-round','auto','worker',safe);f.advance(31000);
 await f.guard.before('finish-round','auto','worker',safe);f.advance(60000);
 await assert.rejects(f.guard.before('finish-round','auto','worker',safe),error=>(error as any).resourceReason==='memory-pressure-recurred');
 await assert.rejects(f.guard.before('prepare-round','auto','worker',approved),error=>(error as any).resourceReason==='memory-pressure-recurred');
 assert.equal(f.guard.snapshot().businessBlocked,true);
 const state=await f.guard.before('prepare-round','auto','worker',{...approved,protectedReasons:['unsettled-outbox',...soft]});
 assert.equal(state.businessBlocked,true);
 assert.equal(state.resourceFault,'memory-pressure-recurred');
 assert.equal(f.restarts,1);
});

test('可测低压仅在auto安全轮首恢复准入，保留真实关闭间隔与小时额度历史',async()=>{
 let now=0,ratio:number|null=.8,restarts=0;
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:ratio===null?null:ratio*2000,limitBytes:2000,ratio,source:ratio===null?'unavailable':'cgroup'}),identity:async()=>identity,restart:async stage=>{stage?.('close-context');restarts++;ratio=.3;return identity;}});
 await guard.before('prepare-round','auto','worker',approved);now=31000;
 await guard.before('finish-round','auto','worker',approved);
 ratio=.8;await guard.before('prepare-round','auto','worker',approved);now+=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',approved),error=>(error as any).resourceReason==='memory-pressure-recurred');
 ratio=.3;
 for(const [operation,control,gate] of [
  ['prepare-round','paused',approved],['prepare-round','manual',approved],['finish-round','auto',approved],['lookup','auto',approved],['health','auto',approved],
  ...[undefined,false,'true',1].map(safePoint=>['prepare-round','auto',{...approved,safePoint:safePoint as any}] as const),
 ] as const){
  const state=await guard.before(operation,control,'worker',gate);
  assert.equal(state.businessBlocked,true);assert.equal(state.resourceFault,'memory-pressure-recurred');assert.equal(restarts,1);
 }
 ratio=null;
 const unmeasured=await guard.before('prepare-round','auto','worker',approved);
 assert.equal(unmeasured.resourceFault,'memory-pressure-recurred');assert.equal(unmeasured.businessBlocked,true);
 ratio=.3;
 const resumed=await guard.before('prepare-round','auto','worker',approved);
 assert.equal(resumed.resourceFault,null);assert.equal(resumed.businessBlocked,false);assert.equal(resumed.restartError,null);assert.deepEqual(resumed.protectedReasons,soft);assert.equal(restarts,1);
 ratio=.8;await guard.before('prepare-round','auto','worker',approved);now+=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',approved),error=>(error as any).resourceReason==='memory-pressure-recurred');assert.equal(restarts,1);
 ratio=.3;await guard.before('prepare-round','auto','worker',approved);now+=300000;
 ratio=.8;await guard.before('prepare-round','auto','worker',approved);now+=31000;
 await guard.before('finish-round','auto','worker',approved);assert.equal(restarts,2);
 now+=300000;ratio=.8;await guard.before('prepare-round','auto','worker',approved);now+=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',approved),error=>(error as any).resourceReason==='recovery-budget-exhausted');
 ratio=.3;await guard.before('prepare-round','auto','worker',approved);
 assert.equal(guard.snapshot().resourceFault,null);assert.equal(guard.snapshot().businessBlocked,false);
 ratio=.8;await guard.before('prepare-round','auto','worker',approved);now+=31000;
 await assert.rejects(guard.before('finish-round','auto','worker',approved),error=>(error as any).resourceReason==='recovery-budget-exhausted');assert.equal(restarts,2);assert.equal(guard.snapshot().restarts,2);
});

test('时长到期且内存无法测量时未审核unknown仍只回查，不以授权掩盖',async()=>{
 let restarts=0,now=0;
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:null,limitBytes:null,ratio:null,source:'unavailable'}),identity:async()=>identity,restart:async()=>{restarts++;return identity;}});
 now=25*3600000;
 for(const operation of ['prepare-round','finish-round']){
  const state=await guard.before(operation,'auto','worker',{...approved,protectedReasons:['unsettled-outbox',...soft]});
  assert.equal(state.businessBlocked,true);
  assert.equal(state.recoveryDeferredReason,'protected-session');
  assert.equal(restarts,0);
 }
});

test('一小时最多两次真实轮末恢复，间隔满足也不能无限重启',async()=>{
 let now=0,ratio=.8,restarts=0;
 const guard=new BrowserResourceGuard({clock:()=>now,readMemory:()=>({bytes:ratio*2000,limitBytes:2000,ratio,source:'cgroup'}),identity:async()=>identity,restart:async stage=>{stage?.('close-context');restarts++;ratio=.3;return identity;}});
 for(let attempt=0;attempt<2;attempt++){
  ratio=.8;await guard.before('prepare-round','auto','worker',approved);now+=31000;
  await guard.before('finish-round','auto','worker',approved);
  now+=BROWSER_RECOVERY_POLICY.minRestartIntervalMs+1000;
 }
 ratio=.8;await guard.before('prepare-round','auto','worker',approved);now+=31000;
 await guard.before('prepare-round','auto','worker',approved);
 assert.equal(restarts,2);
 await assert.rejects(guard.before('finish-round','auto','worker',approved),error=>(error as any).resourceReason==='recovery-budget-exhausted');
 assert.equal(restarts,2);
 assert.equal(guard.snapshot().restarts,2);
 assert.equal(guard.snapshot().businessBlocked,true);
});
