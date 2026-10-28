import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store,NativeIdentityConflictError} from '../src/store.js';
import {Outbox} from '../src/outbox.js';
import {ReplyTriage} from '../src/reply-triage.js';
import {ManualImportsService} from '../src/manual-imports.js';
import type {Event,Channel} from '../src/types.js';
function fixture(){
 const dir=mkdtempSync(tmpdir()+'/native-dedup-'),store=new Store(dir+'/workflow.sqlite'),outbox=new Outbox(store),triage=new ReplyTriage(store);let inspections=0;
 const imports=new ManualImportsService(store,{account:()=> 'worker',control:()=> 'running',maxAgeHours:()=>6,triage,inspectPost:async()=>{inspections++;throw new Error('去重不得调用浏览器或模型');}});
 const event=(id='123',channel:Channel='public',patch:Partial<Event>={}):Event=>({id:'x:new-'+id,platformId:id,targetId:id,channel,userId:channel==='public'?'x:alice':'dm:111-222',handle:channel==='public'?'alice':'',text:'合成入站正文',url:channel==='public'?'https://x.com/alice/status/'+id:'https://x.com/i/chat/111-222',conversationId:channel==='public'?id:'111-222',timestamp:Date.now(),timestampReliable:true,...patch});
 const seed=(id:string,body:any,status='confirmed',account='worker',channel:Channel='public',columnPlatform='')=>{
  const at=Date.now()-1000;store.db.prepare('INSERT INTO messages(id,account_id,source_id,platform_id,target_id,channel,user_id,body,status,draft,receipt,created_at,updated_at,ingested_at,processed_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,account,'legacy-source-'+id,columnPlatform,'',channel,body.userId??'x:alice',JSON.stringify(body),status,JSON.stringify({action:'reply',text:'旧冻结正文',reason:''}),JSON.stringify({status}),at,at,at,status==='confirmed'?1:0);return store.getMessage(id);
 };
 const snapshot=()=>JSON.stringify({messages:store.db.prepare('SELECT * FROM messages ORDER BY id').all(),outbox:store.db.prepare('SELECT * FROM outbox ORDER BY id').all()});
 return {dir,store,outbox,imports,event,seed,snapshot,get inspections(){return inspections;},close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('旧空platform列的confirmed/unknown按canonical URL去重，普通采集与补录不新增出站或改旧字段',async()=>{
 for(const status of ['confirmed','unknown']){const f=fixture();try{const legacy=f.seed('legacy-'+status,{...f.event(),platformId:undefined,id:'opaque-old',accountId:'worker'},status);const out=f.outbox.prepare({accountId:'worker',kind:'reply',sourceId:legacy.id,targetId:'123',event:JSON.parse(legacy.body),text:'旧冻结正文'});f.outbox.begin(out.id);f.outbox.settle(out.id,status==='confirmed'?{status:'confirmed',id:'old-platform-receipt'}:{status:'unknown'});
   const before=f.snapshot(),changes=f.store.db.prepare('SELECT total_changes() n').get()!.n;assert.equal(f.store.findByPlatformId('worker','public','123')?.id,legacy.id);assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(f.store.ingest(f.event(),'worker'),false);assert.equal(f.snapshot(),before);assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,changes);
   const submitted=f.imports.submit('https://x.com/alice/status/123');assert.equal(submitted.status,'duplicate');assert.equal(submitted.messageStatus,status);assert.equal(submitted.request.messageId,legacy.id);assert.equal((await f.imports.processRound()).processed,0);assert.equal(f.inspections,0);assert.equal(f.snapshot(),before);assert.equal(f.store.getMessage(legacy.id).platform_id,'');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n,1);
  }finally{f.close();}}
});
test('body显式原生字段独立去重，不从私信会话URL或内部source id推导消息ID',()=>{
 const f=fixture();try{const publicRow=f.seed('body-native',{...f.event('456'),id:'unrelated',url:'',accountId:'worker'});assert.equal(f.store.findByPlatformId('worker','public','456')?.id,publicRow.id);assert.equal(f.store.ingest(f.event('456'),'worker'),false);
  const dm=f.seed('private-native',{...f.event('native-message-uuid','private'),accountId:'worker'},'unknown','worker','private');assert.equal(f.store.findByPlatformId('worker','private','native-message-uuid')?.id,dm.id);assert.equal(f.store.ingest(f.event('native-message-uuid','private'),'worker'),false);assert.equal(f.store.findByPlatformId('worker','private','111-222'),undefined);
  f.seed('x:999',{...f.event('999'),id:'x:999',platformId:undefined,url:'https://evil.invalid/alice/status/999'},'confirmed');assert.equal(f.store.findByPlatformId('worker','public','999'),undefined);assert.equal(f.store.findByPlatformId('worker','public','x:999'),undefined);
 }finally{f.close();}
});
test('账号与渠道严格隔离，未知归属旧行不迁移或阻挡当前账号新事件',()=>{
 const f=fixture();try{const unknown=f.seed('unknown-owner',{...f.event(),platformId:undefined,accountId:''},'confirmed','');const another=f.seed('other-owner',{...f.event(),accountId:'other'},'unknown','other');assert.equal(f.store.findByPlatformId('worker','public','123'),undefined);assert.equal(f.store.findByPlatformId('','public','123')?.id,unknown.id);assert.equal(f.store.findByPlatformId('other','public','123')?.id,another.id);assert.equal(f.store.ingest(f.event(),'worker'),true);assert.equal(f.store.getMessage(unknown.id).account_id,'');
  const dm=f.seed('same-id-private',{...f.event('123','private'),accountId:'worker'},'confirmed','worker','private');assert.equal(f.store.findByPlatformId('worker','private','123')?.id,dm.id);assert.notEqual(f.store.findByPlatformId('worker','public','123')?.id,dm.id);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n,0);
 }finally{f.close();}
});
test('官方HTTPS规范URL变体只提供明确status ID，不读取内部事件标识或正文散列',()=>{
 const f=fixture();try{let index=0;for(const host of ['x.com','www.x.com','twitter.com','www.twitter.com','mobile.x.com','mobile.twitter.com']){const id=String(2000+index++),row=f.seed('alias-'+host,{...f.event(id),platformId:undefined,url:'https://'+host+'/Alice/status/'+id+'/?s=20#context',id:'arbitrary-internal'});assert.equal(f.store.findByPlatformId('worker','public',id)?.id,row.id);assert.equal(f.store.ingest(f.event(id),'worker'),false);}
  assert.equal(f.store.findByPlatformId('worker','public','arbitrary-internal'),undefined);
 }finally{f.close();}
});
test('恶意或非帖子URL、非原生内部id均不能伪造可靠平台ID',()=>{
 for(const url of ['https://evil.invalid/alice/status/123','http://x.com/alice/status/123','https://x.com.evil.invalid/alice/status/123','https://x.com@evil.invalid/alice/status/123','https://user:password@x.com/alice/status/123','https://x.com:444/alice/status/123','https://x.com/alice/status/123/photo/1','https://x.com/alice%2fother/status/123','https://x.com/i/chat/123','https://evil.invalid/?next=https://x.com/alice/status/123']){const f=fixture();try{const row=f.seed('legacy-opaque-x:123',{...f.event(),platformId:undefined,url,id:'x:123',text:'body-hash-cannot-identify'});assert.equal(f.store.findByPlatformId('worker','public','123'),undefined,url);assert.equal(f.store.findByPlatformId('worker','public','x:123'),undefined);assert.equal(f.store.ingest(f.event(),'worker'),true);assert.notEqual(f.store.findByPlatformId('worker','public','123')?.id,row.id);assert.equal(f.store.getMessage(row.id).platform_id,'');
  }finally{f.close();}}
});
test('字段ID冲突、同原生ID多旧行、body归属冲突一律拒绝，不自动选行归并',()=>{
 for(const scenario of ['fields','opaque-field','column','multiple','account','channel']){const f=fixture();try{const body:any={...f.event(),accountId:'worker'};
   if(scenario==='fields')body.url='https://x.com/alice/status/456';if(scenario==='opaque-field')body.platformId='not-a-native-id';if(scenario==='account')body.accountId='other';if(scenario==='channel')body.channel='private';f.seed('conflict-one',body,'unknown','worker','public',scenario==='column'?'456':'');if(scenario==='multiple')f.seed('conflict-two',{...f.event(),platformId:undefined,accountId:'worker'},'confirmed');
   const before=f.snapshot();assert.throws(()=>f.store.findByPlatformId('worker','public','123'),NativeIdentityConflictError);assert.equal(f.store.ingest(f.event(),'worker'),false);assert.throws(()=>f.imports.submit('https://x.com/alice/status/123'),(e:any)=>e.code==='native-identity-conflict'&&e.statusCode===409);assert.equal(f.snapshot(),before);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM manual_imports').get()!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n,0);
  }finally{f.close();}}
});
test('新入站自身native字段与canonical URL冲突时拒绝，且不增加时钟或用户记录',()=>{
 const f=fixture();try{const before=f.store.db.prepare('SELECT total_changes() n').get()!.n;assert.equal(f.store.ingest(f.event('123','public',{url:'https://x.com/alice/status/456'}),'worker'),false);assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,before);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM account_users').get()!.n,0);
 }finally{f.close();}
});
test('遗忘空列旧消息时保留已验证native来源键，换内部ID或恢复旧库都不能复活',()=>{
 const f=fixture();try{const body={...f.event(),platformId:undefined,accountId:'worker'},old=f.seed('old-forget',body,'confirmed');f.store.forget('x:alice','worker');assert.equal(f.store.getMessage(old.id),undefined);const ledger=JSON.parse(readFileSync(f.dir+'/forgotten-sources.json','utf8'));assert.equal(ledger[JSON.stringify(['worker','public','platform','123'])],true);f.store.remember('x:alice','worker');const after=f.store.recordingAfter('x:alice','worker');assert.equal(f.store.ingest(f.event('123','public',{id:'brand-new-internal-id',timestamp:after+1000}),'worker'),false);assert.equal(f.store.ingest(f.event('124','public',{timestamp:after+1000}),'worker'),true);
  const restored=f.seed('restored-old',body,'confirmed');f.store.db.prepare('UPDATE messages SET ingested_at=1 WHERE id=?').run(restored.id);f.store.replayForgetLedger();assert.equal(f.store.getMessage(restored.id),undefined);assert.equal(f.store.ingest(f.event('123','public',{timestamp:after+2000}),'worker'),false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n,0);
 }finally{f.close();}
});

test('合法账号handle按大小写规整比较，真正跨账号、非法和未知归属不自动归并',()=>{
 for(const spelling of ['John2q1u','JOHN2Q1U','@John2q1u']){const f=fixture();try{const row=f.seed('historical-case',{...f.event(),platformId:undefined,accountId:spelling},'confirmed','john2q1u');const before=f.snapshot();assert.equal(f.store.findByPlatformId('john2q1u','public','123')?.id,row.id);assert.equal(f.store.ingest(f.event('123','public',{accountId:'JOHN2Q1U'}),'john2q1u'),false);assert.equal(f.snapshot(),before);assert.equal(f.store.getMessage(row.id).account_id,'john2q1u');assert.equal(JSON.parse(f.store.getMessage(row.id).body).accountId,spelling);
  }finally{f.close();}}
 for(const accountId of ['other_user','John2q1u/evil','@@John2q1u',{}]){const f=fixture();try{f.seed('conflicting-case',{...f.event(),platformId:undefined,accountId},'unknown','john2q1u');assert.throws(()=>f.store.findByPlatformId('john2q1u','public','123'),NativeIdentityConflictError);assert.equal(f.store.ingest(f.event(),'john2q1u'),false);
  }finally{f.close();}}
 const f=fixture();try{const unknown=f.seed('unknown-case',{...f.event(),platformId:undefined,accountId:'John2q1u'},'unknown','');assert.equal(f.store.findByPlatformId('john2q1u','public','123'),undefined);assert.equal(f.store.ingest(f.event(),'john2q1u'),true);assert.equal(f.store.getMessage(unknown.id).account_id,'');assert.throws(()=>f.store.findByPlatformId('','public','123'),NativeIdentityConflictError);
 }finally{f.close();}
});
