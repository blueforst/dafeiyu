import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Workflow} from '../src/workflow.js';
import type {Transport} from '../src/transport.js';
import type {Generator} from '../src/model.js';
import {exampleConfig} from './config-fixture.js';
function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){const path=mkdtempSync(tmpdir()+'/control-order-'),store=new Store(path+'/workflow.sqlite'),controls:string[]=[];const transport={identity:async()=>({handle:'worker',loggedIn:true,needsHuman:false}),control:async(mode:string)=>{controls.push(mode);}};const workflow=new Workflow(store,transport as Transport,{} as Generator,()=>structuredClone(exampleConfig) as any);return {store,workflow,transport,controls,close(){workflow.stop();store.db.close();rmSync(path,{recursive:true,force:true});}};}
for(const action of ['pause','takeover','safetyPause','stop'] as const)test('身份慢返回的旧启动不能覆盖 '+action,async()=>{
 const f=fixture(),entered=deferred(),identity=deferred<any>();f.transport.identity=()=>{entered.resolve();return identity.promise;};
 try{const old=f.workflow.resume().catch(e=>e);await entered.promise;if(action==='safetyPause')await f.workflow.safetyPause('合成安全暂停');else await f.workflow[action]();const status=f.workflow.control();identity.resolve({handle:'other',loggedIn:true,needsHuman:false});assert.match((await old).message,/替代/);assert.equal(f.workflow.control(),status);assert.equal(f.workflow.accountId(),'');assert.ok(!f.controls.includes('auto'));}finally{f.close();}
});
for(const action of ['pause','takeover'] as const)test('浏览器auto慢返回时 '+action+' 保持后发有效且不并发控制',async()=>{
 const f=fixture(),entered=deferred(),auto=deferred();let active=0,maxActive=0;f.transport.control=async mode=>{maxActive=Math.max(maxActive,++active);f.controls.push(mode);try{if(mode==='auto'){entered.resolve();await auto.promise;}}finally{active--;}};
 try{const old=f.workflow.resume().catch(e=>e);await entered.promise;const latest=f.workflow[action]();assert.equal(f.workflow.control(),'draining');auto.resolve();assert.match((await old).message,/替代/);await latest;assert.equal(f.workflow.control(),action==='pause'?'paused':'manual');assert.deepEqual(f.controls,['auto',action==='pause'?'paused':'manual']);assert.equal(maxActive,1);}finally{f.close();}
});
test('旧暂停失败不补写paused覆盖新接管',async()=>{const f=fixture(),entered=deferred(),paused=deferred();f.transport.control=async mode=>{f.controls.push(mode);if(mode==='paused'){entered.resolve();await paused.promise;}};try{const old=f.workflow.pause().catch(e=>e);await entered.promise;const latest=f.workflow.takeover();paused.reject(new Error('合成旧请求失败'));assert.match((await old).message,/合成旧请求失败/);await latest;assert.equal(f.workflow.control(),'manual');assert.deepEqual(f.controls,['paused','manual']);}finally{f.close();}});
test('普通启动、暂停、接管、释放保持原语义，错误后仍可再操作',async()=>{const f=fixture();try{await f.workflow.resume();assert.equal(f.workflow.control(),'running');await f.workflow.pause();await f.workflow.takeover();await assert.rejects(()=>f.workflow.resume(),/先释放/);await f.workflow.release();assert.equal(f.workflow.control(),'paused');await f.workflow.resume();assert.deepEqual(f.controls,['auto','paused','manual','paused','auto']);}finally{f.close();}});
