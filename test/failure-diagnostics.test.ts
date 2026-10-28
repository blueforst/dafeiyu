import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {BrowserTransport} from '../src/transport.js';
import {Program} from '../src/program.js';
import {Store} from '../src/store.js';
import {failureSummary} from '../src/failure-summary.js';

test('浏览器HTTP错误的固定阶段原因进入程序详情，原始异常正文不进入日志',async()=>{
 let requests=0;
 const server=createServer((req,res)=>{requests++;req.resume();res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:'私密正文 https://example.test/?token=fixture-secret',diagnostic:{code:'public-target-unavailable',stage:'target-ready'},browserPaused:false,browserMode:'auto'}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=mkdtempSync(tmpdir()+'/role-failure-diagnostic-'),store=new Store(dir+'/workflow.sqlite'),program=new Program(store);
 try{
  const transport=new BrowserTransport('http://127.0.0.1:'+(server.address() as {port:number}).port,'fixture-browser-key');
  await assert.rejects(program.run('context',{messageId:'synthetic-source',accountId:'fixture_worker'},()=>transport.context({id:'synthetic-source'} as any,'fixture_worker')),(error:any)=>{
   assert.deepEqual(error.diagnostic,{code:'public-target-unavailable',stage:'target-ready'});assert.equal(error.browserPaused,false);assert.equal(error.browserMode,'auto');assert.match(error.message,/原消息已删除或暂时不可访问/);return true;
  });
  const stage=program.list()[0];assert.equal(stage.status,'failed');assert.ok(stage.endedAt);assert.match(stage.error!,/target-ready \/ public-target-unavailable/);assert.equal(requests,1);
  const serialized=JSON.stringify(program.list());assert.ok(!serialized.includes('fixture-secret'));assert.ok(!serialized.includes('私密正文'));assert.ok(!serialized.includes('https://'));
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('不在白名单的浏览器错误不接受伪造阶段或复制异常正文',async()=>{
 const dir=mkdtempSync(tmpdir()+'/role-failure-private-'),store=new Store(dir+'/workflow.sqlite'),program=new Program(store);
 try{
  const error=Object.assign(new Error('secret body bearer fixture-token'),{diagnostic:{code:'fixture-token',stage:'https://private.invalid'}});
  await assert.rejects(program.run('context',{},async()=>{throw error;}));
  assert.equal(program.list()[0].error,'阶段执行失败，请检查关联记录');assert.equal(failureSummary(error,'待核对'),'待核对');
  assert.ok(!JSON.stringify(program.list()).includes('fixture-token'));
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
