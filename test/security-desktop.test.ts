import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {registerDesktopProxy} from '../src/desktop-proxy.js';
import {Workflow} from '../src/workflow.js';
import {Store} from '../src/store.js';
import {exampleConfig} from './config-fixture.js';
const require=createRequire(import.meta.url),WebSocket=require('ws');

test('真实代理在释放开始关闭旧连接，并拒绝释放窗口及恢复后的新连接',async()=>{
 const dir=mkdtempSync(tmpdir()+'/security-desktop-'),store=new Store(dir+'/workflow.sqlite'),upstream=createServer(),wss=new WebSocket.WebSocketServer({server:upstream});wss.on('connection',(socket:any)=>socket.on('message',(data:any)=>socket.send(data)));
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),barrier=new Promise<void>(resolve=>finish=resolve);
 const workflow=new Workflow(store,{identity:async()=>({handle:'worker',loggedIn:true,needsHuman:false}),control:async(mode:string)=>{if(mode==='paused'){enter();await barrier;}}} as any,{} as any,()=>structuredClone(exampleConfig));store.set('activeAccount','worker');store.set('control','manual');
 const app=Fastify();await registerDesktopProxy(app,workflow,'http://127.0.0.1:'+(upstream.address() as any).port);await app.listen({host:'127.0.0.1',port:0});const url='ws://127.0.0.1:'+(app.server.address() as any).port+'/desktop/websockify';
 const connect=()=>new Promise<any>((resolve,reject)=>{const socket=new WebSocket(url);socket.once('open',()=>resolve({status:101,socket}));socket.once('unexpected-response',(_req:any,response:any)=>{response.resume();resolve({status:response.statusCode});});socket.once('error',reject);});let old:any;
 try{old=(await connect()).socket;const echo=once(old,'message');old.send('before');assert.equal(String((await echo)[0]),'before');const closed=once(old,'close');const releasing=workflow.release();assert.equal(workflow.control(),'draining');await entered;assert.equal((await connect()).status,423);await closed;finish();await releasing;assert.equal(workflow.control(),'paused');assert.equal((await connect()).status,423);await workflow.resume();assert.equal((await connect()).status,423);assert.notEqual(old.readyState,WebSocket.OPEN);}finally{finish();old?.terminate();workflow.stop();for(const socket of wss.clients)socket.terminate();await app.close();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));store.db.close();rmSync(dir,{recursive:true,force:true});}
});
