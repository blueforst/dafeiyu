import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Outbox} from '../src/outbox.js';
import {UnknownReviews,UnknownReviewError,hasBlockingUnknown} from '../src/unknown-reviews.js';
import type {Event} from '../src/types.js';

function fixture(withOutbox=true){
 const dir=mkdtempSync(tmpdir()+'/role-unknown-reviews-'),path=dir+'/db.sqlite',store=new Store(path),outbox=withOutbox?new Outbox(store):null;
 let account='worker',control='paused',busy=false,now=Date.now();
 const environment=()=>({accountId:account,control,busy}),reviews=new UnknownReviews(store,environment,()=>now);
 function add(id='101',opts:{account?:string;kind?:'reply'|'dm'|'post';messageStatus?:string;outboxStatus?:string}={}){
  const owner=opts.account??'worker',kind=opts.kind??'reply',channel=kind==='dm'?'private' as const:'public' as const;
  const event:Event={id:'x:'+id,platformId:id,targetId:id,channel,userId:'x:guest',handle:'guest',text:'@'+owner+' 下午好，十分钟如何放松？',url:'https://x.com/guest/status/'+id,conversationId:id,timestamp:now-1000,timestampReliable:true,accountId:owner};
  store.ingest(event,owner);const message=store.findByPlatformId(owner,channel,id)!;
  store.update(message.id,opts.messageStatus??'unknown',{draft:{action:'reply',text:'听一首喜欢的歌。',reason:''},receipt:{status:'unknown',reason:'缺少原意图'}},owner);
  if(!outbox)return {messageId:message.id,id:''};
  const row=outbox.prepare({accountId:owner,kind,sourceId:message.id,targetId:id,event:JSON.parse(store.getMessage(message.id,owner).body),text:'听一首喜欢的歌。'});
  if(opts.outboxStatus!=='prepared'){assert.equal(outbox.begin(row.id),true);if(opts.outboxStatus!=='submitting')outbox.settle(row.id,{status:'unknown',reason:'缺少原意图'});}
  return {messageId:message.id,id:row.id};
 }
 const approve=(id:string)=>reviews.approve(id,{action:'allow-other-public-items',confirmed:true,revision:reviews.preview(id).revision});
 return {dir,path,store,outbox,reviews,environment,add,approve,setAccount:(value:string)=>{account=value;},setControl:(value:string)=>{control=value;},setBusy:(value:boolean)=>{busy=value;},advance:()=>{now+=1000;},close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('审核仅解除精确旧项的通道阻塞，原状态、正文、回查和额度完全不变',()=>{
 const f=fixture();try{
  const row=f.add(),before=JSON.stringify({message:f.store.getMessage(row.messageId),outbox:f.outbox!.get(row.id)}),count=f.outbox!.count('public','worker');
  assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);assert.equal(f.reviews.list().items.length,1);
  const result=f.approve(row.id);assert.equal(result.reviewed,true);assert.equal(hasBlockingUnknown(f.store,'worker','public'),false);
  assert.equal(JSON.stringify({message:f.store.getMessage(row.messageId),outbox:f.outbox!.get(row.id)}),before);
  assert.equal(f.outbox!.pendingUnknown('worker')[0].id,row.id);assert.equal(f.store.unknown('worker')[0].id,row.messageId);assert.equal(f.outbox!.count('public','worker'),count);
  assert.equal(f.outbox!.begin(row.id),false);assert.equal(f.outbox!.cancel(row.id),false);
  assert.throws(()=>f.outbox!.prepare({accountId:'worker',kind:'reply',sourceId:row.messageId,targetId:'101',text:'试图重发不同内容'}),/冻结/);
  const raw=JSON.stringify(f.store.db.prepare("SELECT * FROM runtime WHERE key LIKE 'unknown-review-v1:%'").all());assert.ok(!raw.includes('听一首喜欢的歌')&&!raw.includes('下午好'));
 }finally{f.close();}
});

test('新增unknown、孤立unknown及提交中仍阻塞，审核不能变为渠道白名单',()=>{
 const f=fixture();try{
  const row=f.add();f.approve(row.id);assert.equal(hasBlockingUnknown(f.store,'worker','public'),false);
  const next=f.add('102');assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);f.approve(next.id);assert.equal(hasBlockingUnknown(f.store,'worker','public'),false);
  const inFlight=f.add('103',{outboxStatus:'submitting',messageStatus:'sending'});assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);assert.equal(f.reviews.preview(inFlight.id).reviewable,false);assert.throws(()=>f.approve(inFlight.id),UnknownReviewError);
 }finally{f.close();}
 const orphan=fixture(false);try{orphan.add();assert.equal(hasBlockingUnknown(orphan.store,'worker','public'),true);assert.equal(hasBlockingUnknown(orphan.store,'other','public'),false);assert.equal(orphan.reviews.list().items.length,0);}finally{orphan.close();}
});

test('超过五十条未知记录时仍扫描完整集合，最后一条未审核或任意撤销继续阻塞',()=>{
 const f=fixture();try{
  const rows=Array.from({length:51},(_,index)=>f.add(String(1000+index)));
  for(const row of rows.slice(0,50))f.approve(row.id);
  assert.equal(f.reviews.list().items.length,51);assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);
  f.approve(rows[50].id);assert.equal(hasBlockingUnknown(f.store,'worker','public'),false);
  const middle=rows[24];f.reviews.revoke(middle.id,{revision:f.reviews.preview(middle.id).revision,confirmed:true,action:'restore-public-block'});
  assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);
  assert.equal(f.outbox!.pendingUnknown('worker').length,50);assert.equal((f.store.db.prepare("SELECT count(*) n FROM outbox WHERE status='unknown'").get() as any).n,51);
 }finally{f.close();}
});

test('审核要求暂停空闲、明确动作和确认，账号隔离且不接受过期修订',()=>{
 const f=fixture();try{
  const row=f.add(),revision=f.reviews.preview(row.id).revision;
  for(const control of ['running','manual','draining']){f.setControl(control);assert.throws(()=>f.approve(row.id),/暂停/);}f.setControl('paused');
  f.setBusy(true);assert.throws(()=>f.approve(row.id),/暂停/);f.setBusy(false);
  for(const input of [{revision,confirmed:false,action:'allow-other-public-items'},{revision,confirmed:true,action:'mark-sent'},{revision:'old',confirmed:true,action:'allow-other-public-items'},null])assert.throws(()=>f.reviews.approve(row.id,input as any),e=>(e as any).statusCode===400);
  f.setAccount('other');assert.equal(f.reviews.list().items.length,0);assert.throws(()=>f.reviews.preview(row.id),e=>(e as any).statusCode===404);f.setAccount('worker');
  f.store.db.prepare('UPDATE outbox SET updated_at=updated_at+1 WHERE id=?').run(row.id);
  assert.throws(()=>f.reviews.approve(row.id,{revision,confirmed:true,action:'allow-other-public-items'}),/已变化/);assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);
 }finally{f.close();}
});

test('审核精确绑定关联、冻结正文与提交标识，变化后自动恢复阻塞',()=>{
 const changes=[
  ['UPDATE outbox SET text=? WHERE id=?','另一个出站正文'],
  ['UPDATE outbox SET target_id=? WHERE id=?','999'],
  ['UPDATE outbox SET event=? WHERE id=?','{}'],
  ['UPDATE outbox SET submitted_at=? WHERE id=?',1],
  ['UPDATE messages SET body=? WHERE id=?','{}'],
  ['UPDATE messages SET draft=? WHERE id=?',JSON.stringify({text:'另一个草稿'})],
  ['UPDATE messages SET source_id=? WHERE id=?','another-source'],
  ['UPDATE messages SET platform_id=? WHERE id=?','999'],
  ['UPDATE messages SET target_id=? WHERE id=?','999'],
 ] as const;
 for(const [sql,value] of changes){const f=fixture();try{const row=f.add();f.approve(row.id);f.store.db.prepare(sql).run(value,sql.includes('messages')?row.messageId:row.id);assert.equal(hasBlockingUnknown(f.store,'worker','public'),true,sql);assert.equal(f.reviews.preview(row.id).reviewed,false,sql);}finally{f.close();}}
 for(const options of [{kind:'dm' as const},{kind:'post' as const},{messageStatus:'confirmed'},{outboxStatus:'prepared'}]){const f=fixture();try{const row=f.add('101',options);assert.equal(f.reviews.preview(row.id).reviewable,false);assert.throws(()=>f.approve(row.id),UnknownReviewError);}finally{f.close();}}
});

test('旧空原生身份列可审核，非空冲突与来源别名歧义必须拒绝',()=>{
 const legacy=fixture();try{const row=legacy.add();legacy.store.db.prepare("UPDATE messages SET source_id='',platform_id='',target_id='' WHERE id=?").run(row.messageId);assert.equal(legacy.reviews.preview(row.id).reviewable,true);legacy.approve(row.id);assert.equal(hasBlockingUnknown(legacy.store,'worker','public'),false);}finally{legacy.close();}
 for(const column of ['platform_id','target_id']){const f=fixture();try{const row=f.add();f.store.db.prepare('UPDATE messages SET '+column+'=? WHERE id=?').run('999',row.messageId);assert.equal(f.reviews.preview(row.id).reviewable,false);assert.throws(()=>f.approve(row.id),/原生身份列/);}finally{f.close();}}
 const ambiguous=fixture();try{const first=ambiguous.add('101'),second=ambiguous.add('102');ambiguous.store.db.prepare('UPDATE messages SET source_id=? WHERE id=?').run('x:101',second.messageId);assert.equal(ambiguous.reviews.preview(first.id).reviewable,false);assert.throws(()=>ambiguous.approve(first.id),/采集来源/);}finally{ambiguous.close();}
 const canonical=fixture();try{const first=canonical.add('101'),second=canonical.add('102');canonical.store.db.prepare('UPDATE messages SET source_id=? WHERE id=?').run(first.messageId,second.messageId);assert.equal(canonical.reviews.preview(second.id).reviewable,false);assert.throws(()=>canonical.approve(second.id),/采集来源/);}finally{canonical.close();}
});

test('只更新回查时间和未知原因不撤销审核，新真实回执仍能正常收束',()=>{
 const f=fixture();try{
  const row=f.add();f.approve(row.id);
  f.outbox!.settle(row.id,{status:'unknown',reason:'再次读取仍无唯一回执'});f.store.db.prepare('UPDATE messages SET updated_at=updated_at+1,error=? WHERE id=?').run('仍待回查',row.messageId);
  assert.equal(hasBlockingUnknown(f.store,'worker','public'),false);assert.equal(f.reviews.preview(row.id).reviewed,true);
  f.outbox!.settle(row.id,{status:'confirmed',id:'999',url:'https://x.com/worker/status/999'});f.store.update(row.messageId,'confirmed',{receipt:{status:'confirmed',id:'999'}});
  assert.equal(hasBlockingUnknown(f.store,'worker','public'),false);assert.equal(f.outbox!.get(row.id)!.status,'confirmed');assert.equal(f.reviews.preview(row.id).reviewed,false);
 }finally{f.close();}
});

test('审核持久、重复请求幂等且可撤销，撤销前的请求不能再次放行',()=>{
 const f=fixture();try{
  const row=f.add(),input={revision:f.reviews.preview(row.id).revision,confirmed:true as const,action:'allow-other-public-items' as const};
  f.reviews.approve(row.id,input);const after=JSON.stringify(f.store.db.prepare("SELECT * FROM runtime WHERE key LIKE 'unknown-review-v1:%'").all()),logs=f.store.db.prepare("SELECT count(*) n FROM logs WHERE event='unknown-review-approved'").get() as any;
  f.reviews.approve(row.id,input);assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM runtime WHERE key LIKE 'unknown-review-v1:%'").all()),after);assert.equal((f.store.db.prepare("SELECT count(*) n FROM logs WHERE event='unknown-review-approved'").get() as any).n,logs.n);
  const reopened=new Store(f.path);try{assert.equal(hasBlockingUnknown(reopened,'worker','public'),false);}finally{reopened.db.close();}
  const revoke={revision:f.reviews.preview(row.id).revision,confirmed:true as const,action:'restore-public-block' as const};f.advance();f.reviews.revoke(row.id,revoke);assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);f.reviews.revoke(row.id,revoke);
  assert.throws(()=>f.reviews.approve(row.id,input),/已变化/);assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);
 }finally{f.close();}
});

test('损坏或伪造审核KV继续阻塞，不能覆盖损坏记录来默默放行',()=>{
 for(const corrupt of ['{','{}',JSON.stringify({version:1,state:'active',accountId:'other'})]){const f=fixture();try{
  const row=f.add();f.approve(row.id);f.store.db.prepare("UPDATE runtime SET value=? WHERE key LIKE 'unknown-review-v1:%'").run(corrupt);
  assert.equal(hasBlockingUnknown(f.store,'worker','public'),true);assert.equal(f.reviews.preview(row.id).reviewable,false);assert.throws(()=>f.approve(row.id),/损坏/);
 }finally{f.close();}}
});
