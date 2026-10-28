import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Program,registerProgramRoutes} from '../src/program.js';
import {Outbox} from '../src/outbox.js';

test('暂停后观察到切号，消息列表与详情沿用面板当前账号而非旧工作轮次',async()=>{
 const path=mkdtempSync(tmpdir()+'/role-program-scope-'),store=new Store(path+'/db.sqlite'),app=Fastify();
 let observed='first',details=0;new Outbox(store);
 const workflow={control:()=> 'paused',busy:false,lastTick:0,nextTick:0,accountId:()=> 'first',sentCount:()=>0};
 registerProgramRoutes(app,{store,program:new Program(store),workflow,accountId:()=>observed,manualImports:{forMessage:()=>{details++;return [];}}});
 const event={id:'source',channel:'public' as const,userId:'x:visitor',handle:'visitor',text:'合成正文',url:'https://x.com/visitor/status/123',conversationId:'123',platformId:'123',timestamp:Date.now()};
 store.ingest(event,'first');store.ingest(event,'second');
 const first=store.getMessage('source','first')!,second=store.getMessage('source','second')!;
 try{
  assert.equal((await app.inject('/api/messages/'+encodeURIComponent(first.id))).statusCode,200);assert.equal(details,1);
  observed='second';
  assert.equal((await app.inject('/api/messages/'+encodeURIComponent(first.id))).statusCode,404);assert.equal(details,1);
  const listed=(await app.inject('/api/messages')).json();assert.deepEqual(listed.items.map((row:any)=>row.id),[second.id]);
  const current=await app.inject('/api/messages/'+encodeURIComponent(second.id));assert.equal(current.statusCode,200);assert.equal(current.json().message.account_id,'second');assert.equal(details,2);
  observed='';assert.equal((await app.inject('/api/messages')).json().items.length,0);assert.equal((await app.inject('/api/messages/'+encodeURIComponent(second.id))).statusCode,404);
 }finally{await app.close();store.db.close();rmSync(path,{recursive:true,force:true});}
});
