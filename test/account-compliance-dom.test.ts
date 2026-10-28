import test from 'node:test';
import assert from 'node:assert/strict';
import {
 inspectComplianceProfileSnapshot,
 inspectComplianceQualitySnapshot,
 inspectComplianceFiltersSnapshot,
 complianceProfileDiagnostics,
 complianceFiltersDiagnostics,
 complianceQualityDiagnostics,
 waitForStableComplianceSnapshot,
 type ComplianceSnapshotWaitResult,
 type ComplianceProfileSnapshot,
 type ComplianceQualitySnapshot,
 type ComplianceFiltersSnapshot,
} from '../src/account-compliance-dom.js';

const profile=(patch:Partial<ComplianceProfileSnapshot>={}):ComplianceProfileSnapshot=>({
 url:'https://x.com/fixture_worker',mainCount:1,nameCount:1,handles:['fixture_worker'],ownEditLinks:1,
 detailsComplete:true,loading:false,failed:false,name:'AI 合成角色',bio:'非官方合成简介',bioCount:1,
 automatedLabels:1,automatedLabelConflict:false,...patch,
});
const quality=(patch:Partial<ComplianceQualitySnapshot>={}):ComplianceQualitySnapshot=>({
 url:'https://x.com/settings/notifications/filters',mainCount:1,loading:false,failed:false,
 matches:[{associationValid:true,nativeChecked:null,ariaChecked:'false'}],...patch,
});
const filters=(patch:Partial<ComplianceFiltersSnapshot>={}):ComplianceFiltersSnapshot=>({
 url:'https://x.com/settings/notifications',mainCount:1,loading:false,failed:false,
 links:['/settings/notifications/filters'],...patch,
});
const unknownProfile={reliable:false,name:'',bio:'',automatedLabel:null};

test('目标资料同时具有唯一账号、编辑入口和完成证据后才可靠，空简介可以明确读取',()=>{
 assert.deepEqual(inspectComplianceProfileSnapshot(profile(),'@FIXTURE_WORKER'),{
  reliable:true,name:'AI 合成角色',bio:'非官方合成简介',automatedLabel:true,
 });
 assert.deepEqual(inspectComplianceProfileSnapshot(profile({url:'https://x.com/FIXTURE_WORKER/'}),'fixture_worker'),{
  reliable:true,name:'AI 合成角色',bio:'非官方合成简介',automatedLabel:true,
 });
 assert.deepEqual(inspectComplianceProfileSnapshot(profile({bio:'',bioCount:0,automatedLabels:0}),'fixture_worker'),{
  reliable:true,name:'AI 合成角色',bio:'',automatedLabel:false,
 });
});

test('资料地址、目标账号和自身编辑入口必须共同匹配，歧义或未水合保持unknown且不泄露正文',()=>{
 const invalid:Partial<ComplianceProfileSnapshot>[]=[
  {url:'https://x.com/other_worker'},
  {url:'https://x.com/fixture_worker/status/123'},
  {url:'https://example.com/fixture_worker'},
  {url:'https://x.com@evil.example/fixture_worker'},
  {url:'https://user@x.com/fixture_worker'},
  {url:'https://x.com/fixture_worker?tab=posts'},
  {url:'https://x.com/fixture_worker#profile'},
  {url:'不是地址'},
  {mainCount:0},{mainCount:2},{nameCount:0},{nameCount:2},
  {handles:[]},{handles:['other_worker']},{handles:['fixture_worker','other_worker']},
  {ownEditLinks:0},{ownEditLinks:2},{detailsComplete:false},{loading:true},{failed:true},
  {name:' \n '},{bioCount:2},
 ];
 for(const patch of invalid){
  const actual=inspectComplianceProfileSnapshot(profile({...patch,bio:'不应输出的合成正文'}),'fixture_worker');
  assert.deepEqual(actual,unknownProfile,JSON.stringify(patch));
 }
 for(const handle of ['', 'worker/name', 'a'.repeat(16)])assert.deepEqual(inspectComplianceProfileSnapshot(profile(),handle),unknownProfile);
});

test('资料可可靠读取时标签证据冲突仍为unknown，不误记标签缺失',()=>{
 const observed=inspectComplianceProfileSnapshot(profile({automatedLabels:0,automatedLabelConflict:true}),'fixture_worker');
 assert.equal(observed.reliable,true);assert.equal(observed.automatedLabel,null);
 assert.equal(inspectComplianceProfileSnapshot(profile({automatedLabels:2,automatedLabelConflict:true}),'fixture_worker').automatedLabel,null);
 assert.equal(inspectComplianceProfileSnapshot(profile({automatedLabels:0}),'fixture_worker').automatedLabel,false);
});

test('唯一关联质量过滤控件接受明确原生或ARIA状态，false不会被当作未读取',()=>{
 for(const [nativeChecked,ariaChecked,expected] of [
  [null,'true',true],[null,'false',false],[true,null,true],[false,null,false],
  [true,'true',true],[false,'false',false],
 ] as const){
  assert.equal(inspectComplianceQualitySnapshot(quality({matches:[{associationValid:true,nativeChecked,ariaChecked}]})),expected);
 }
 assert.equal(inspectComplianceQualitySnapshot(quality({url:'https://x.com/settings/notifications'})),false);
});

test('质量过滤页面、加载、关联和控件数量不可靠时unknown，状态冲突不猜测',()=>{
 const control={associationValid:true,nativeChecked:null,ariaChecked:'true'};
 const invalid:Partial<ComplianceQualitySnapshot>[]=[
  {url:'https://x.com/settings/privacy_and_safety'},
  {url:'https://x.com/settings/notifications/filters/extra'},
  {url:'https://example.com/settings/notifications/filters'},
  {url:'https://user@x.com/settings/notifications/filters'},
  {url:'https://x.com/settings/notifications/filters?source=test'},
  {url:'https://x.com/settings/notifications/filters#quality'},
  {mainCount:0},{mainCount:2},{loading:true},{failed:true},
  {matches:[]},{matches:[control,control]},
  {matches:[{...control,associationValid:false}]},
  {matches:[{...control,ariaChecked:null}]},
  {matches:[{...control,ariaChecked:'mixed'}]},
  {matches:[{...control,nativeChecked:true,ariaChecked:'false'}]},
  {matches:[{...control,nativeChecked:false,ariaChecked:'true'}]},
  {matches:[{...control,nativeChecked:false,ariaChecked:'invalid'}]},
 ];
 for(const patch of invalid)assert.equal(inspectComplianceQualitySnapshot(quality(patch)),null,JSON.stringify(patch));
});

test('通知过滤导航只接受通知设置页唯一同源路径候选，不从多个链接挑第一条',()=>{
 assert.equal(inspectComplianceFiltersSnapshot(filters()),'/settings/notifications/filters');
 const invalid:Partial<ComplianceFiltersSnapshot>[]=[
  {url:'https://x.com/settings/notifications/filters'},
  {url:'https://example.com/settings/notifications'},
  {url:'https://user@x.com/settings/notifications'},
  {url:'https://x.com/settings/notifications?source=test'},
  {mainCount:0},{mainCount:2},{loading:true},{failed:true},
  {links:[]},{links:['/settings/notifications/filters','/settings/notifications/other']},
  {links:['/settings/notifications/filters','/settings/notifications/filters']},
  {links:['https://x.com/settings/notifications/filters']},
  {links:['//evil.example/settings/notifications/filters']},
  {links:['/settings/notifications/filters?source=test']},
  {links:['/settings/notifications/filters#quality']},
  {links:['/settings/profile']},
 ];
 for(const patch of invalid)assert.equal(inspectComplianceFiltersSnapshot(filters(patch)),null,JSON.stringify(patch));
});

test('稳定等待至少读取两次，并等待水合后的同一结构跨过完整稳定窗口',async()=>{
 let now=0,reads=0;const sleeps:number[]=[],wallStarted=Date.now();
 const observed=await waitForStableComplianceSnapshot({
  read:async()=>({ready:++reads>1,value:reads>1?'完成':'加载'}),ready:snapshot=>snapshot.ready,
  timeoutMs:100,stableMs:20,intervalMs:10,now:()=>now,
  sleep:async ms=>{sleeps.push(ms);now+=ms;},
 });
 assert.equal(observed.stable,true);assert.deepEqual(observed.snapshot,{ready:true,value:'完成'});
 assert.equal(observed.reads,4);assert.equal(now,30);assert.deepEqual(sleeps,[10,10,10]);
 assert.equal(observed.sampleCount,4);assert.ok(observed.sampledAt!==null&&observed.sampledAt>=wallStarted&&observed.sampledAt<=Date.now());
 let zeroReads=0;
 const zeroWindow=await waitForStableComplianceSnapshot({
  read:async()=>({ready:true,sequence:++zeroReads}),ready:()=>true,signature:()=> '固定结构',
  timeoutMs:10,stableMs:0,intervalMs:1,now:()=>now,sleep:async ms=>{now+=ms;},
 });
 assert.equal(zeroWindow.stable,true);assert.equal(zeroWindow.reads,2);
});

test('结构持续变化和始终未就绪均在预算内返回unknown，不接受最后一次瞬时快照',async()=>{
 for(const changing of [false,true]){
  let now=0,reads=0;
  const observed=await waitForStableComplianceSnapshot({
   read:async()=>({ready:changing,sequence:changing?++reads:0}),ready:snapshot=>snapshot.ready,
   timeoutMs:50,stableMs:20,intervalMs:10,now:()=>now,sleep:async ms=>{now+=ms;},
  });
  assert.equal(observed.stable,false);assert.ok(observed.snapshot);assert.ok(observed.reads>=2&&observed.reads<=6);
  assert.equal(now,50);
 }
});

test('注入时钟不前进或倒退也限制读取次数，不形成无限轮询',async()=>{
 for(const backwards of [false,true]){
  let now=0,reads=0;
  const observed=await waitForStableComplianceSnapshot({
   read:async()=>({ready:false,sequence:++reads}),ready:()=>false,
   timeoutMs:1000,stableMs:2,intervalMs:1000,now:()=>now,sleep:async()=>{if(backwards)now--;},
  });
  assert.equal(observed.stable,false);assert.equal(observed.reads,reads);assert.ok(reads>=2&&reads<=6);
 }
});

test('单次DOM读取永不完成也在总deadline内返回unknown，不让账号检查永久挂起',{timeout:1000},async()=>{
 const started=Date.now();let reads=0;
 const observed=await waitForStableComplianceSnapshot({
  read:()=>{reads++;return new Promise<{ready:boolean}>(()=>{});},ready:snapshot=>snapshot.ready,
  timeoutMs:40,stableMs:20,intervalMs:5,
 });
 assert.equal(observed.stable,false);assert.equal(observed.snapshot,null);assert.equal(observed.reads,1);assert.equal(reads,1);
 assert.equal(observed.sampleCount,0);assert.equal(observed.sampledAt,null);
 assert.ok(Date.now()-started<500,'总deadline不应被永不返回的读取阻塞');
});

test('第二次DOM读取越过总deadline后才完成时不采纳迟到结果，也不追认稳定',{timeout:1000},async()=>{
 const first={ready:true,value:'首次可读快照'},late={ready:true,value:'迟到的不同快照'};
 let reads=0,resolveLate!:(snapshot:typeof late)=>void;
 const pending=new Promise<typeof late>(resolve=>{resolveLate=resolve;});
 const started=Date.now();
 const observed=await waitForStableComplianceSnapshot({
  read:async()=>++reads===1?first:pending,ready:snapshot=>snapshot.ready,
  timeoutMs:40,stableMs:20,intervalMs:5,sleep:async()=>{},
 });
 assert.equal(observed.sampleCount,1);assert.ok(observed.sampledAt!==null&&observed.sampledAt>=started&&observed.sampledAt<=Date.now());
 const expected={snapshot:first,stable:false,reads:2,sampleCount:1,sampledAt:observed.sampledAt};
 assert.deepEqual(observed,expected);assert.equal(reads,2);assert.ok(Date.now()-started<500);
 resolveLate(late);await new Promise<void>(resolve=>setImmediate(resolve));
 assert.deepEqual(observed,expected,'deadline之后完成的旧读取不能修改已经返回的观察');
});

test('deadline内DOM读取明确拒绝时保留异常，不把操作失败包装成普通未知',{timeout:1000},async()=>{
 const failure=new Error('合成DOM读取故障');
 await assert.rejects(waitForStableComplianceSnapshot({
  read:async()=>{throw failure;},ready:()=>true,timeoutMs:40,stableMs:20,intervalMs:5,
 }),error=>error===failure);
});

test('资料诊断只投影最后已接收快照的计数和标志，不输出URL、账号或资料正文',()=>{
 const observed:ComplianceSnapshotWaitResult<ComplianceProfileSnapshot>={
  snapshot:profile({mainCount:2,nameCount:3,handles:['secret_worker','secret_other'],ownEditLinks:4,bioCount:5,
   url:'https://x.com/secret_worker',name:'不应输出的名字',bio:'不应输出的简介',detailsComplete:false,loading:true,failed:false}),
  stable:false,reads:3,sampleCount:2,sampledAt:123456,
 };
 const diagnostic=complianceProfileDiagnostics(observed,'secret_worker');
 assert.deepEqual(diagnostic,{stable:false,sampleCount:2,readAttempts:3,sampledAt:123456,
  mainCount:2,nameCount:3,handleCount:2,editCount:4,bioCount:5,locationMatches:true,handleMatches:false,expectedHandleMatches:false,
  detailsComplete:false,loading:true,failed:false});
 const serialized=JSON.stringify(diagnostic);
 for(const forbidden of ['secret_worker','secret_other','不应输出','https://','"url"','"name"','"bio"','"handles"'])assert.ok(!serialized.includes(forbidden),forbidden);
 const valid={...observed,snapshot:profile()};
 const matching=complianceProfileDiagnostics(valid,'@FIXTURE_WORKER');
 assert.equal(matching.locationMatches,true);assert.equal(matching.handleMatches,true);assert.equal(matching.expectedHandleMatches,true);
 const wrongLocation=complianceProfileDiagnostics({...valid,snapshot:profile({url:'https://x.com/another_worker'})},'fixture_worker');
 assert.equal(wrongLocation.locationMatches,false);assert.equal(wrongLocation.handleMatches,true);assert.equal(wrongLocation.expectedHandleMatches,false);
 const wrongHandle=complianceProfileDiagnostics({...valid,snapshot:profile({handles:['another_worker']})},'fixture_worker');
 assert.equal(wrongHandle.locationMatches,true);assert.equal(wrongHandle.handleMatches,false);assert.equal(wrongHandle.expectedHandleMatches,false);
});

test('过滤入口和质量控件诊断保留零计数及false状态，仅统计明确原生状态',()=>{
 const sampling={stable:false,reads:5,sampleCount:4,sampledAt:789012};
 const filterDiagnostic=complianceFiltersDiagnostics({...sampling,snapshot:filters({mainCount:1,links:['/秘密入口一','https://secret.example/秘密入口二'],loading:false,failed:true})});
 assert.deepEqual(filterDiagnostic,{stable:false,sampleCount:4,readAttempts:5,sampledAt:789012,locationMatches:true,mainCount:1,visibleEntryCount:2,loading:false,failed:true});
 assert.equal(complianceFiltersDiagnostics({...sampling,snapshot:filters({links:[]})}).visibleEntryCount,0);
 assert.equal(complianceFiltersDiagnostics({...sampling,snapshot:filters({url:'https://x.com/settings/profile'})}).locationMatches,false);
 const qualityDiagnostic=complianceQualityDiagnostics({...sampling,snapshot:quality({matches:[
  {associationValid:true,nativeChecked:false,ariaChecked:'false'},
  {associationValid:false,nativeChecked:true,ariaChecked:'mixed'},
  {associationValid:false,nativeChecked:null,ariaChecked:'true'},
  {associationValid:false,nativeChecked:null,ariaChecked:null},
 ]})});
 assert.deepEqual(qualityDiagnostic,{stable:false,sampleCount:4,readAttempts:5,sampledAt:789012,locationMatches:true,
  mainCount:1,matchedControlCount:4,associationValidCount:1,nativeStateCount:2,ariaStateCount:2,loading:false,failed:false});
 assert.deepEqual(complianceQualityDiagnostics({...sampling,snapshot:quality({matches:[]})}),{
  stable:false,sampleCount:4,readAttempts:5,sampledAt:789012,locationMatches:true,mainCount:1,matchedControlCount:0,
  associationValidCount:0,nativeStateCount:0,ariaStateCount:0,loading:false,failed:false,
 });
 assert.equal(complianceQualityDiagnostics({...sampling,snapshot:quality({url:'https://x.com/settings/privacy_and_safety'})}).locationMatches,false);
 for(const diagnostic of [filterDiagnostic,qualityDiagnostic]){
  const serialized=JSON.stringify(diagnostic);
  for(const forbidden of ['秘密','secret.example','"url"','"links"','"matches"','"nativeChecked"','"ariaChecked"'])assert.ok(!serialized.includes(forbidden),forbidden);
 }
});

test('读取尚无已接收快照时诊断保留尝试次数，采样数为零且全部结构字段为null',()=>{
 const unavailable={snapshot:null,stable:false,reads:1,sampleCount:0,sampledAt:null};
 assert.deepEqual(complianceProfileDiagnostics(unavailable,'fixture_worker'),{
  stable:false,sampleCount:0,readAttempts:1,sampledAt:null,mainCount:null,nameCount:null,handleCount:null,
  editCount:null,bioCount:null,locationMatches:null,handleMatches:null,expectedHandleMatches:null,detailsComplete:null,loading:null,failed:null,
 });
 assert.deepEqual(complianceFiltersDiagnostics(unavailable),{
  stable:false,sampleCount:0,readAttempts:1,sampledAt:null,locationMatches:null,mainCount:null,visibleEntryCount:null,loading:null,failed:null,
 });
 assert.deepEqual(complianceQualityDiagnostics(unavailable),{
  stable:false,sampleCount:0,readAttempts:1,sampledAt:null,locationMatches:null,mainCount:null,matchedControlCount:null,
  associationValidCount:null,nativeStateCount:null,ariaStateCount:null,loading:null,failed:null,
 });
});
