// 仅用于服务器 --network none 隔离验收；所有资料、Key、模型响应和桌面均为临时合成数据。
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const json=(response,status,body)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(body));};
function serverWithSockets(handler){
 const server=http.createServer(handler),sockets=new Set();
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 return {server,sockets};
}
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});return 'http://127.0.0.1:'+server.address().port;}
async function closeServer(holder){if(!holder)return;for(const socket of holder.sockets)socket.destroy();holder.server.closeAllConnections?.();if(holder.server.listening)await new Promise(resolve=>holder.server.close(()=>resolve()));}
async function requestBody(request){let size=0,body='';for await(const part of request){size+=part.length;if(size>1048576)throw new Error('隔离夹具请求体过大');body+=part;}try{return body?JSON.parse(body):{};}catch{throw new Error('隔离夹具请求体不是JSON');}}
function loopback(url){return url.protocol==='http:'&&(url.hostname==='localhost'||url.hostname==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(url.hostname))&&!url.username&&!url.password;}
async function waitUntil(check,description,processes=[],timeoutMs=12000){const until=Date.now()+timeoutMs;while(!await check()){for(const child of processes)if(child.fixtureError||child.exitCode!==null)throw child.fixtureError??new Error(description+'：进程提前退出');if(Date.now()>=until)throw new Error(description+'超时');await delay(50);}}
async function portReady(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});const end=ok=>{socket.destroy();resolve(ok);};socket.once('connect',()=>end(true));socket.once('error',()=>end(false));socket.setTimeout(300,()=>end(false));});}

const DESKTOP_HTML='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本地隔离桌面</title><style>html,body{margin:0;min-height:100%;background:#182b53;color:#fff;font:28px sans-serif}header{padding:36px;background:linear-gradient(100deg,#135,#864,#385)}main{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;padding:28px}.cell{height:125px;border-radius:16px;display:grid;place-items:center;box-shadow:inset 0 0 40px #ffffff30}footer{padding:24px;background:#243b68}</style><header>服务器隔离 noVNC 验收 · 本地合成桌面</header><main>'+Array.from({length:20},(_,i)=>'<div class="cell" style="background:hsl('+i*17+' 64% '+(35+i%5*7)+'%)">'+String(i+1).padStart(2,'0')+'</div>').join('')+'</main><footer>全新临时 profile · 不访问 X · 无真实账号资料</footer></html>';

/** 启动真实 dist app；返回值中的 state 仅控制本地浏览器 stub。 */
export async function startPanelFixture({desktop=false}={}){
 const directory=mkdtempSync(tmpdir()+'/role-panel-fixture-');
 const envNames=['DATA_DIR','CONFIG_PATH','SECRETS_DIR','PORT','BROWSER_ENDPOINT','MAINTENANCE_DIR','DISPLAY'];
 const previousEnv=Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
 const oldFetch=globalThis.fetch,previousSignals=new Set(process.listeners('SIGTERM'));
 const ingress='fixture-ingress-'+randomUUID(),browserKey='fixture-browser-'+randomUUID(),modelKey='staging-key-0001';
 const requests=[],externalAttempts=[],children=[];
 const state={loggedIn:false,handle:'Current_User',needsHuman:false,takeoverFails:false,modelFails:false,mode:'paused'};
 let browserHolder,modelHolder,proxyHolder,running,visibleContext,closed=false,baseURL,modelURL,bigModelURL;
 const aliases=new Map();
 const launchChild=(command,args)=>{const child=spawn(command,args,{stdio:'ignore',env:{...process.env}});child.fixtureError=null;child.once('error',error=>{child.fixtureError=error;});children.push(child);return child;};
 const close=async()=>{
  if(closed)return;closed=true;
  try{await visibleContext?.close();}catch{}
  await closeServer(proxyHolder).catch(()=>{});
  try{await running?.app.close();}catch{}
  await closeServer(browserHolder).catch(()=>{});await closeServer(modelHolder).catch(()=>{});
  for(const child of children.reverse())if(child.exitCode===null)child.kill('SIGTERM');
  const deadline=Date.now()+2000;while(children.some(child=>child.exitCode===null&&!child.fixtureError)&&Date.now()<deadline)await delay(30);
  for(const child of children)if(child.exitCode===null&&!child.fixtureError)child.kill('SIGKILL');
  globalThis.fetch=oldFetch;
  for(const listener of process.listeners('SIGTERM'))if(!previousSignals.has(listener))process.removeListener('SIGTERM',listener);
  for(const name of envNames)if(previousEnv[name]===undefined)delete process.env[name];else process.env[name]=previousEnv[name];
  rmSync(directory,{recursive:true,force:true});
 };
 try{
  browserHolder=serverWithSockets(async(request,response)=>{
   try{
    const body=await requestBody(request);requests.push({service:'browser',method:request.method,path:request.url});
    if(request.headers['x-browser-key']!==browserKey)return json(response,401,{error:'隔离浏览器凭据错误'});
    if(request.method==='GET'&&request.url==='/identity')return json(response,200,{handle:state.loggedIn?state.handle:'',loggedIn:state.loggedIn,needsHuman:state.needsHuman,...(!state.loggedIn?{reason:'隔离浏览器尚未登录'}:{})});
    if(request.method==='POST'&&request.url==='/control'){
     if(!['paused','manual','auto'].includes(body.mode))return json(response,400,{error:'控制状态无效'});
     if(body.mode==='manual'&&state.takeoverFails)return json(response,409,{error:'隔离夹具注入接管失败',browserPaused:true,browserMode:'paused'});
     state.mode=body.mode;return json(response,200,{mode:state.mode});
    }
    if(request.method==='GET'&&request.url==='/health')return json(response,200,{ready:true,mode:state.mode,engine:'fixture',at:Date.now(),startedAt:Date.now(),memory:{bytes:null,limitBytes:null,ratio:null,source:'unavailable'},lastRestartAt:null,lastRestartReason:null,restarts:0,restartError:null});
    if(request.method==='GET'&&request.url==='/collection-sources')return json(response,200,{sources:[{id:'public',label:'公开消息',enabled:false,status:'unavailable',reason:'隔离夹具不采集X'},{id:'private',label:'私信',enabled:false,status:'unavailable',reason:'隔离夹具不采集X'}]});
    return json(response,503,{error:'隔离夹具禁止采集、平台页面读取和发送'});
   }catch{return json(response,400,{error:'隔离浏览器请求无效'});}
  });
  const browserURL=await listen(browserHolder.server);
  modelHolder=serverWithSockets(async(request,response)=>{
   try{
    const url=new URL(request.url,'http://fixture'),big=url.pathname.startsWith('/big/'),path=big?url.pathname.slice(4):url.pathname;
    const body=await requestBody(request);requests.push({service:'model',method:request.method,path:url.pathname,stream:body.stream===true});
    if(state.modelFails||request.headers.authorization!=='Bearer '+modelKey)return json(response,401,{error:{message:'invalid api key'}});
    if(request.method==='GET'&&path==='/v1/models')return json(response,200,{object:'list',data:big?Array.from({length:1500},(_,i)=>({id:'m-'+String(i).padStart(4,'0'),object:'model'})):[{id:'deepseek-flash',object:'model'},{id:'my-finetune-v2',object:'model'}]});
    if(request.method==='POST'&&path==='/v1/chat/completions'){
     const meta={id:'fixture-completion',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:typeof body.model==='string'?body.model:'my-finetune-v2'};
     if(body.stream===false)return json(response,200,{...meta,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'MODEL_OK'},finish_reason:'stop'}],usage:{prompt_tokens:18,completion_tokens:4,total_tokens:22}});
     response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
     response.write('data: '+JSON.stringify({...meta,choices:[{index:0,delta:{role:'assistant',content:'MODEL_OK'},finish_reason:null}]})+'\n\n');
     response.write('data: '+JSON.stringify({...meta,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:18,completion_tokens:4,total_tokens:22}})+'\n\n');
     response.end('data: [DONE]\n\n');return;
    }
    return json(response,404,{error:{message:'隔离模型接口不存在'}});
   }catch{return json(response,400,{error:{message:'隔离模型请求无效'}});}
  });
  const modelLoopback=await listen(modelHolder.server),modelPort=modelHolder.server.address().port;
  modelURL='http://model.fixture.test:'+modelPort+'/v1';bigModelURL='http://model.fixture.test:'+modelPort+'/big/v1';
  aliases.set(new URL(modelURL).origin,modelLoopback);aliases.set('http://second.fixture.test:'+modelPort,modelLoopback);
  // 仅这两个精确合成 origin 在进程内重写为回环；不发送 DNS 或公网请求。
  globalThis.fetch=async(input,init)=>{
   const original=new URL(input instanceof Request?input.url:String(input));let target=original;
   if(aliases.has(original.origin))target=new URL(original.pathname+original.search,aliases.get(original.origin));
   if(!loopback(target)){externalAttempts.push(original.host);throw new Error('隔离验收禁止外部HTTP请求：'+original.host);}
   const request=input instanceof Request?new Request(target,input):target;
   return oldFetch(request,{...init,redirect:'error'});
  };
  mkdirSync(directory+'/secrets',{recursive:true,mode:0o700});mkdirSync(directory+'/data',{recursive:true,mode:0o700});
  writeFileSync(directory+'/secrets/ingress_key',ingress,{mode:0o600});writeFileSync(directory+'/secrets/browser_key',browserKey,{mode:0o600});
  writeFileSync(directory+'/config.json',JSON.stringify({mode:'draft',pollSeconds:60,maxAgeHours:6,maxPerRound:2,publicPerHour:10,privatePerHour:30,publicPerDay:180,persona:'你是明确说明自己是 AI 的友善中文角色。简短自然回应，不编造真实经历。',dailyState:'暂无虚构日程',retentionDays:30,model:{provider:'custom',api:'openai-completions',baseUrl:modelURL,id:'my-finetune-v2',reasoning:false,reasoningLevel:'off',vision:false,maxTokens:4096,timeoutMs:60000,custom:{contextWindow:128000,reasoning:false}}}),{mode:0o600});
  Object.assign(process.env,{DATA_DIR:directory+'/data',CONFIG_PATH:directory+'/config.json',SECRETS_DIR:directory+'/secrets',PORT:'0',BROWSER_ENDPOINT:browserURL,MAINTENANCE_DIR:directory+'/missing-maintenance'});
  const settings=await import('../dist/settings.js');
  settings.mergePanelSettings('model',{provider:'custom',baseUrl:modelURL,api:'openai-completions',id:'my-finetune-v2',reasoningLevel:'off',maxTokens:4096,timeoutMs:60000,custom:{contextWindow:128000,reasoning:false}},0);
  settings.writeModelKey(settings.keySlot('custom',modelURL),modelKey);
  const {startApp}=await import('../dist/app.js');running=await startApp();running.workflow.stop();
  Object.defineProperty(state,'control',{enumerable:true,get:()=>running.store.get('control','paused'),set:value=>running.store.set('control',value)});
  const appPort=running.app.server.address().port;
  function proxyHeaders(request){const headers={...request.headers,'x-ingress-key':ingress};delete headers.origin;delete headers.authorization;return headers;}
  proxyHolder=serverWithSockets((request,response)=>{
   requests.push({service:'panel',method:request.method,path:request.url});
   if(request.url==='/fixture-desktop'){response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(DESKTOP_HTML);return;}
   const upstream=http.request({host:'127.0.0.1',port:appPort,method:request.method,path:request.url,headers:proxyHeaders(request)},result=>{response.writeHead(result.statusCode||502,result.headers);result.pipe(response);});
   upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});response.on('close',()=>upstream.destroy());request.pipe(upstream);
  });
  proxyHolder.server.on('upgrade',(request,socket,head)=>{
   if(request.url?.split('?')[0]!=='/desktop/websockify')return socket.destroy();
   const upstream=net.connect(appPort,'127.0.0.1',()=>{
    const headers=Object.entries(proxyHeaders(request)).flatMap(([name,value])=>Array.isArray(value)?value.map(item=>name+': '+item):value===undefined?[]:[name+': '+value]);
    upstream.write(request.method+' '+request.url+' HTTP/1.1\r\n'+headers.join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(socket);socket.pipe(upstream);
   });
   upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
  });
  baseURL=await listen(proxyHolder.server);
  if(desktop){
   // 端口和显示器只在全新隔离容器使用，不接入任何已有桌面或生产 profile。
   if(existsSync('/tmp/.X11-unix/X75')||await portReady(5900)||await portReady(6080))throw new Error('隔离桌面端口或显示器已占用，拒绝连接现有桌面');
   process.env.DISPLAY=':75';const xvfb=launchChild('Xvfb',[':75','-screen','0','1440x900x24','-ac','-nolisten','tcp']);
   await waitUntil(()=>existsSync('/tmp/.X11-unix/X75'),'隔离Xvfb启动',[xvfb]);
   const openbox=launchChild('openbox',['--sm-disable']);
   const vnc=launchChild('x11vnc',['-display',':75','-forever','-shared','-repeat','-noxdamage','-rfbport','5900','-localhost','-nopw']);
   await waitUntil(()=>portReady(5900),'隔离VNC启动',[xvfb,openbox,vnc]);
   const websocket=launchChild('websockify',['--web=/usr/share/novnc','6080','127.0.0.1:5900']);
   await waitUntil(()=>portReady(6080),'隔离noVNC启动',[xvfb,openbox,vnc,websocket]);
   const {launch}=await import('/opt/role-camoufox/launch.mjs');visibleContext=await launch(directory+'/visible-profile');
   await visibleContext.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===baseURL)return route.continue();externalAttempts.push(url.host);return route.abort();});
   const page=visibleContext.pages()[0]||await visibleContext.newPage();await page.goto(baseURL+'/fixture-desktop',{waitUntil:'domcontentloaded',timeout:30000});await page.locator('.cell').last().waitFor();
  }
  return {baseURL,modelURL,bigModelURL,modelKey,state,running,requests,externalAttempts,close};
 }catch(error){await close();throw error;}
}
