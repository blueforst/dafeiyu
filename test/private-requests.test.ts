import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {PrivateAcceptJournal,privateRequestDecision,privateRequestFingerprint,type PrivateRequestCandidate} from '../src/private-requests.js';
import type {Config} from '../src/types.js';
const id='11111111-1111-4111-8111-111111111111';
const candidate=(text='你好，想请教一个问题？'):PrivateRequestCandidate=>({source:'other',url:'https://x.com/i/chat/requests/other/111-222',event:{id:'dm:111-222:'+id,platformId:id,targetId:'111-222',channel:'private',userId:'dm:111-222',accountId:'worker',handle:'',conversationId:'111-222',url:'https://x.com/i/chat/111-222',text,timestamp:Date.now()-60000,timestampReliable:true,privateContract:'xchat-native-v2',senderId:'111',nativeSequence:'2115814771744473294'}});
const config={mode:'auto',maxAgeHours:3} as Config;
const input=()=>({accountId:'worker',config,control:'running',forgotten:false,ignored:false});
test('新用户正常请求和Other请求共用既有过滤，不将Other直接当广告',()=>{
 assert.equal(privateRequestDecision(candidate(),input()),'eligible');assert.equal(privateRequestDecision(candidate('hello'),input()),'eligible');
 assert.equal(privateRequestDecision(candidate('空投 https://example.test'),input()),'advertising');
 assert.equal(privateRequestDecision(candidate('自定义词 https://example.test'),{...input(),config:{...config,triage:{advertisingKeywords:['自定义词']}}}),'advertising');
});
test('接受保留运行模式、遗忘和骚扰保护，不使用回复时段与额度挡住收件',()=>{
 for(const [patch,reason] of [[{control:'manual'},'not-running'],[{control:'paused'},'not-running'],[{config:{...config,mode:'draft'}},'draft-mode'],[{forgotten:true},'forgotten'],[{ignored:true},'harassment-cooldown']] as const)assert.equal(privateRequestDecision(candidate(),{...input(),...patch} as any),reason);
 for(const patch of [{timestampReliable:false},{privateContract:undefined},{accountId:'other'},{senderId:'333'},{nativeSequence:''}]){const c=candidate();Object.assign(c.event,patch);assert.equal(privateRequestDecision(c,input()),'invalid-evidence');}
});
test('接受意图先落盘，重启保留unknown和原指纹；后续消息不能覆盖原意图',()=>{
 const dir=mkdtempSync(tmpdir()+'/private-accept-');try{
  const path=dir+'/journal.json',journal=new PrivateAcceptJournal(path),c=candidate(),first=journal.plan(c,'222');assert.equal(first.status,'unknown');assert.equal(first.fingerprint,privateRequestFingerprint(c,'222'));
  const restarted=new PrivateAcceptJournal(path);assert.deepEqual(restarted.get('worker','111-222'),first);const changed=candidate('后续正常消息');assert.equal(restarted.plan(changed,'222').fingerprint,first.fingerprint);
  restarted.accepted('worker','111-222');assert.equal(new PrivateAcceptJournal(path).get('worker','111-222')?.status,'accepted');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('落盘失败不发布可点击结果，同进程冻结，损坏日志与外账号意图拒绝继续',()=>{
 const dir=mkdtempSync(tmpdir()+'/private-accept-');try{
  const path=dir+'/journal.json',journal=new PrivateAcceptJournal(path,()=>{throw Error('模拟磁盘失败');});assert.throws(()=>journal.plan(candidate(),'222'),/磁盘失败/);assert.equal(journal.get('worker','111-222')?.status,'unknown');
  assert.throws(()=>journal.plan(candidate(),'333'),/无效/);writeFileSync(path,'{');assert.throws(()=>new PrivateAcceptJournal(path),/日志损坏/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
