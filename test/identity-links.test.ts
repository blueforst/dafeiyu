import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {IdentityLinks,PLATFORM_IDENTITY_LINKS} from '../src/identity-links.js';
import {privateOverlap} from '../src/reply-style.js';
import {privatePeerCandidate} from '../src/chat-dom.js';
function fixture(){const root=mkdtempSync(tmpdir()+'/identity-links-'),store=new Store(root+'/workflow.sqlite'),links=new IdentityLinks(store,()=>100);return {store,links,close(){store.db.close();rmSync(root,{recursive:true,force:true});}};}
test('schema 14 新库、升级与重复迁移只增加关联表，不改变原记录',()=>{const f=fixture();try{f.store.set('preserved','旧数据');f.store.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(?,?,?)').run(13,'参考补齐夹具',1);new IdentityLinks(f.store);assert.equal(f.store.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=14').get()!.n,1);assert.equal(f.store.get('preserved'),'旧数据');assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_links').get()!.n,0);}finally{f.close();}});
test('身份格式、平台冲突、管理员解除阻止自动恢复、覆盖与账号隔离',()=>{const f=fixture();try{
 for(const ids of [['dm:a','x:TOO'],['x:alice','x:alice'],['dm:','x:alice'],['dm:space here','x:alice']])assert.throws(()=>f.links.link('work',ids[0],ids[1],'admin'));
 assert.throws(()=>f.links.link('work','dm:a','x:alice','chat-test'));assert.throws(()=>f.links.unlink('work',undefined as any));
 assert.equal(f.links.link('work','dm:a','x:alice','platform').linked,true);assert.equal(f.links.link('work','dm:a','x:bob','platform').reason,'conflict');
 assert.equal(f.links.publicOf('work','dm:a')!.publicUserId,'x:alice');f.links.link('work','dm:b','x:alice','admin');assert.equal(f.links.privatesOf('work','x:alice').length,2);assert.equal(f.links.publicOf('other','dm:a'),undefined);
 f.links.unlink('work','dm:a');assert.equal(f.links.link('work','dm:a','x:alice','platform').reason,'admin-blocked');assert.equal(f.links.detail('work','dm:a').blocks.length,1);
 f.links.link('work','dm:a','x:alice','admin');assert.equal(f.links.detail('work','dm:a').blocks.length,0);assert.equal(f.links.publicOf('work','dm:a')!.source,'admin');
 f.links.link('work','dm:a','x:bob','admin');assert.equal(f.links.publicOf('work','dm:a')!.publicUserId,'x:bob');assert.equal(f.links.privatesOf('work','x:alice').length,1);assert.equal(PLATFORM_IDENTITY_LINKS,false);
 }finally{f.close();}});
test('八字重合按规范化码点处理边界、空白标点、全角与符号',()=>{
 assert.deepEqual(privateOverlap('甲乙丙丁戊己庚辛',['前甲乙丙丁戊己庚辛后']),{fragment:'甲乙丙丁戊己庚辛'});
 assert.equal(privateOverlap('甲乙丙丁戊己庚',['甲乙丙丁戊己庚']),null);
 assert.deepEqual(privateOverlap('ＡＢＣＤ， ef gh！',['abcdefgh']),{fragment:'abcdefgh'});
 assert.deepEqual(privateOverlap('去大阪看樱花的时候',['明年去大阪看樱花的时候要拍照']),{fragment:'去大阪看樱花的时候'});
 assert.equal(privateOverlap('😀😀😀😀😀😀😀😀',['😀😀😀😀😀😀😀😀']),null);assert.equal(privateOverlap('ordinary reply',[]),null);
});
test('私信对方候选唯一、多个、缺失、自己与截断时不猜测',()=>{
 assert.deepEqual(privatePeerCandidate({direct:true,handles:['Self','Alice','alice']},'self'),{peerHandle:'alice',code:'private-peer-verified'});
 for(const read of [{direct:false,handles:['alice']},{direct:true,handles:[]},{direct:true,handles:['self']},{direct:true,handles:['alice'],truncated:true}])assert.equal(privatePeerCandidate(read,'self').code,'private-peer-unverified');
 assert.equal(privatePeerCandidate({direct:true,handles:['alice','bob']},'self').code,'private-peer-ambiguous');
});

test('关联建立、改写与解除作废两侧回放快照，账号边界保持',()=>{const f=fixture();try{
 f.store.db.exec('CREATE TABLE generation_snapshots(message_id TEXT PRIMARY KEY,account_id TEXT,user_id TEXT,channel TEXT,body_json TEXT);CREATE TABLE replay_items(account_id TEXT,user_id TEXT,channel TEXT)');
 const seed=()=>{f.store.db.exec('DELETE FROM generation_snapshots;DELETE FROM replay_items');for(const [id,user,account]of [['pub','x:alice','work'],['private','dm:a','work'],['bob','x:bob','work'],['other','x:alice','other']]){f.store.db.prepare('INSERT INTO generation_snapshots VALUES(?,?,?,?,?)').run(id,account,user,user.startsWith('x:')?'public':'private',JSON.stringify({memory:{memories:[{text:'旧快照'}]}}));f.store.db.prepare('INSERT INTO replay_items VALUES(?,?,?)').run(account,user,user.startsWith('x:')?'public':'private');}};
 const invalid=(id:string)=>JSON.parse((f.store.db.prepare('SELECT body_json FROM generation_snapshots WHERE message_id=?').get(id) as any).body_json).memoryInvalidated===true;
 seed();f.links.link('work','dm:a','x:alice','admin');assert.equal(invalid('pub'),true);assert.equal(invalid('private'),true);assert.equal(invalid('other'),false);
 seed();f.links.link('work','dm:a','x:bob','admin');for(const id of ['pub','private','bob'])assert.equal(invalid(id),true);
 seed();f.links.unlink('work','dm:a');assert.equal(invalid('bob'),true);assert.equal(invalid('private'),true);assert.equal(invalid('other'),false);
}finally{f.close();}});
