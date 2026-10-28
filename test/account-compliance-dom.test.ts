import test from 'node:test';
import assert from 'node:assert/strict';
import {
 inspectComplianceProfileSnapshot,
 inspectComplianceQualitySnapshot,
 inspectComplianceFiltersSnapshot,
 waitForStableComplianceSnapshot,
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
 let now=0,reads=0;const sleeps:number[]=[];
 const observed=await waitForStableComplianceSnapshot({
  read:async()=>({ready:++reads>1,value:reads>1?'完成':'加载'}),ready:snapshot=>snapshot.ready,
  timeoutMs:100,stableMs:20,intervalMs:10,now:()=>now,
  sleep:async ms=>{sleeps.push(ms);now+=ms;},
 });
 assert.equal(observed.stable,true);assert.deepEqual(observed.snapshot,{ready:true,value:'完成'});
 assert.equal(observed.reads,4);assert.equal(now,30);assert.deepEqual(sleeps,[10,10,10]);
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
