// 在服务器限额、无外网容器中运行真实 Xvfb → x11vnc → websockify；不启动浏览器或挂载生产数据。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import Fastify from 'fastify';
import {registerDesktopProxy} from '../dist/desktop-proxy.js';
const require=createRequire(import.meta.url),WebSocket=require('ws'),out=process.env.ARTIFACT_DIR||'/artifacts/security-desktop-vnc';
mkdirSync(out,{recursive:true});
const report={checks:[],errors:[]},children=[],listeners=new Set(),clients=new Set();
let mode='manual',epoch=1,unlock,entered;
const control={control:()=>mode,controlEpoch:()=>epoch,onControlRevision:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
function change(next){mode=next;epoch++;for(const listener of listeners)listener();}
function start(command,args){const child=spawn(command,args,{stdio:'ignore'});children.push(child);child.on('error',error=>report.errors.push({command,error:String(error)}));return child;}
async function portReady(port){for(let attempt=0;attempt<50;attempt++){const ready=await new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});if(ready)return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('隔离 VNC 未就绪：'+port);}
function connect(url){return new Promise((resolve,reject)=>{const socket=new WebSocket(url);clients.add(socket);socket.once('close',()=>clients.delete(socket));socket.once('message',data=>resolve({status:101,socket,greeting:String(data)}));socket.once('unexpected-response',(_request,response)=>{response.resume();resolve({status:response.statusCode});});socket.once('error',reject);socket.once('close',()=>reject(new Error('连接在 VNC 握手前关闭')));});}
async function check(name,fn){try{await fn();report.checks.push(name);}catch(error){report.errors.push({name,error:error.stack||String(error)});}}
const app=Fastify();
try{
 start('Xvfb',[':101','-screen','0','800x600x24','-ac','-nolisten','tcp']);
 for(let attempt=0;!existsSync('/tmp/.X11-unix/X101');attempt++){if(attempt>=50)throw new Error('隔离Xvfb未就绪');await new Promise(resolve=>setTimeout(resolve,100));}
 start('x11vnc',['-display',':101','-listen','127.0.0.1','-rfbport','5907','-nopw','-forever','-shared','-wait','100']);
 await portReady(5907);
 start('websockify',['127.0.0.1:6087','127.0.0.1:5907']);await portReady(6087);
 app.addHook('onRequest',async request=>{if(request.url.includes('delayed=1')){entered();await new Promise(resolve=>unlock=resolve);}});
 await registerDesktopProxy(app,control,'http://127.0.0.1:6087');await app.listen({host:'127.0.0.1',port:0});
 const url='ws://127.0.0.1:'+app.server.address().port+'/desktop/websockify';let old;
 await check('人工接管连接实际VNC并收到RFB握手',async()=>{const connection=await connect(url);assert.equal(connection.status,101);assert.match(connection.greeting,/^RFB 003\./);old=connection.socket;});
 await check('释放开始立即关闭真实VNC旧通道并拒绝新通道',async()=>{assert.ok(old);const closed=once(old,'close');change('draining');await closed;assert.equal((await connect(url)).status,423);});
 await check('暂停和自动运行均不能重连桌面',async()=>{for(const state of ['paused','running']){change(state);assert.equal((await connect(url)).status,423);}});
 await check('新接管代次可建立新的真实VNC连接',async()=>{change('manual');const current=await connect(url);assert.equal(current.status,101);assert.match(current.greeting,/^RFB 003\./);current.socket.terminate();});
 await check('鉴权等待中的连接在释放时关闭，不能在下个代次复活',async()=>{const barrier=new Promise(resolve=>entered=resolve);let opened=false;const pending=connect(url+'?delayed=1').then(result=>{opened=result.status===101;},()=>{});await barrier;change('draining');unlock();await pending;assert.equal(opened,false);change('manual');const fresh=await connect(url);assert.equal(fresh.status,101);fresh.socket.terminate();});
}catch(error){report.errors.push({name:'启动或验收',error:error.stack||String(error)});}finally{
 unlock?.();for(const socket of clients)socket.terminate();await app.close();
 for(const child of children)child.kill('SIGTERM');
 await Promise.all(children.filter(child=>child.exitCode===null).map(child=>Promise.race([once(child,'exit').catch(()=>{}),new Promise(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve();},1000))])));
 writeFileSync(out+'/report.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));if(report.errors.length)process.exitCode=1;
