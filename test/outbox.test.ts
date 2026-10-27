import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';

function fixture(){const dir=mkdtempSync(tmpdir()+'/role-outbox-');const store=new Store(dir+'/db.sqlite');const outbox=new Outbox(store);return {store,outbox,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
test('出站同来源正文冻结、原子提交，unknown 与重启不能再次开始',()=>{
 const f=fixture();try{
  const input={accountId:'worker',kind:'reply' as const,sourceId:'message-1',targetId:'123',text:'你好'};
  const row=f.outbox.prepare(input);assert.equal(f.outbox.prepare(input).id,row.id);
  assert.throws(()=>f.outbox.prepare({...input,text:'改写'}),/冻结/);
  assert.equal(f.outbox.begin(row.id),true);assert.equal(f.outbox.begin(row.id),false);
  assert.equal(f.outbox.recover(),1);assert.equal(f.outbox.get(row.id)?.status,'unknown');
  assert.equal(f.outbox.begin(row.id),false);assert.equal(f.outbox.cancel(row.id),false);
  assert.equal(f.outbox.pendingUnknown('worker').length,1);assert.equal(f.outbox.pendingUnknown('other').length,0);
  f.outbox.settle(row.id,{status:'confirmed',id:'124'});assert.equal(f.outbox.get(row.id)?.status,'confirmed');
  f.outbox.settle(row.id,{status:'unknown'});assert.equal(f.outbox.get(row.id)?.status,'confirmed');
 }finally{f.close();}
});
test('帖子和回复共享公开额度，私信与账号单独计数，未提交不计数',()=>{
 const f=fixture();try{
  for(const input of [
   {accountId:'a',kind:'reply' as const,sourceId:'r',targetId:'1',text:'回复'},
   {accountId:'a',kind:'post' as const,sourceId:'p',text:'早安'},
   {accountId:'a',kind:'dm' as const,sourceId:'d',targetId:'m1',text:'私信'},
   {accountId:'b',kind:'post' as const,sourceId:'b',text:'其他账号'},
  ]){const row=f.outbox.prepare(input);f.outbox.begin(row.id);}
  f.outbox.prepare({accountId:'a',kind:'post',sourceId:'unused',text:'尚未提交'});
  assert.equal(f.outbox.count('public','a'),2);assert.equal(f.outbox.count('private','a'),1);assert.equal(f.outbox.count('public','b'),1);
 }finally{f.close();}
});
test('无唯一平台 ID 的所谓确认保留 unknown，取消只允许未提交任务',()=>{
 const f=fixture();try{
  const row=f.outbox.prepare({accountId:'a',kind:'post',sourceId:'p',text:'正文'});
  assert.throws(()=>f.outbox.settle(row.id,{status:'confirmed',id:'1'}),/尚未/);
  f.outbox.begin(row.id);f.outbox.settle(row.id,{status:'confirmed'});assert.equal(f.outbox.get(row.id)?.status,'unknown');
  const unsent=f.outbox.prepare({accountId:'a',kind:'post',sourceId:'cancel',text:'正文'});
  assert.equal(f.outbox.cancel(unsent.id),true);assert.equal(f.outbox.begin(unsent.id),false);
 }finally{f.close();}
});
