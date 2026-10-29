import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startApp } from '../src/app.js';
import { defaultPersona,PERSONA_PRESETS,PERSONA_PRESETS_VERSION } from '../src/persona-presets.js';
import { legacyPersona,FIXED_SYSTEM_RULES,type Persona } from '../src/persona.js';
import { readPanelSettings } from '../src/settings.js';
import type { DailyContent } from '../src/daily-state.js';
import type { Event } from '../src/types.js';
import type { Generator } from '../src/model.js';
import { exampleConfig } from './config-fixture.js';

const sectionsText=(persona:Persona)=>[...persona.sections.map(section=>section.content),...persona.triggers.filter(t=>t.enabled).map(t=>'【'+t.title+'】\n'+t.content)].join('\n\n');
function dailyContent(date:string):DailyContent {
 return {date,fictional:true,periods:[{start:'06:00',end:'24:00',activity:'读书与休息'}],meals:{breakfast:'粥',lunch:'米饭',dinner:'面条'},activities:['读书'],mood:'平静'};
}
function publicEvent(platformId:string):Event {
 return {id:'x:'+platformId,platformId,targetId:platformId,channel:'public',userId:'x:alice',handle:'alice',text:'这一轮的人设有什么变化？',url:'https://x.com/alice/status/'+platformId,conversationId:platformId,timestamp:Date.now(),timestampReliable:true};
}

// 使用真实应用注册、全局 hook、面板设置、日程及工作流；外部依赖只连接临时 HTTP 浏览器和确定性模型。
async function fixture(){
 const path=mkdtempSync(tmpdir()+'/persona-presets-integration-');
 const envNames=['DATA_DIR','CONFIG_PATH','SECRETS_DIR','PORT','BROWSER_ENDPOINT','MAINTENANCE_DIR'] as const;
 const previous=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));
 const previousSigterm=new Set(process.listeners('SIGTERM'));
 const ingress='presets-isolated-ingress',browserKey='presets-isolated-browser';
 const requests:string[]=[],unexpected:string[]=[];
 let events:Event[]=[];
 const browser=createServer((req,res)=>{
  const respond=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  requests.push(req.method+' '+req.url);
  if(req.headers['x-browser-key']!==browserKey){req.resume();respond(401,{error:'隔离浏览器凭据不符'});return;}
  req.resume();req.on('end',()=>{
   if(req.method==='GET'&&req.url==='/identity')return respond(200,{handle:'PresetBot',loggedIn:true,needsHuman:false});
   if(req.method==='POST'&&req.url==='/control')return respond(200,{ok:true});
   if(req.method==='POST'&&req.url==='/prepare-round')return respond(200,{ready:true,mode:'auto',businessBlocked:false});
   if(req.method==='POST'&&req.url==='/collect/public')return respond(200,{events,warnings:[]});
   if(req.method==='POST'&&req.url==='/collect/private')return respond(200,{events:[],warnings:[]});
   if(req.method==='POST'&&req.url==='/context')return respond(200,{text:''});
   unexpected.push(req.method+' '+req.url);respond(503,{error:'隔离测试未允许此平台操作'});
  });
 });
 let running:Awaited<ReturnType<typeof startApp>>|undefined;
 await new Promise<void>(resolve=>browser.listen(0,'127.0.0.1',resolve));
 try {
  mkdirSync(path+'/secrets');
  writeFileSync(path+'/secrets/ingress_key',ingress,{mode:0o600});
  writeFileSync(path+'/secrets/browser_key',browserKey,{mode:0o600});
  const config={...structuredClone(exampleConfig)};
  const writeConfig=()=>writeFileSync(path+'/config.json',JSON.stringify(config));writeConfig();
  Object.assign(process.env,{DATA_DIR:path+'/data',CONFIG_PATH:path+'/config.json',SECRETS_DIR:path+'/secrets',PORT:'0',BROWSER_ENDPOINT:'http://127.0.0.1:'+(browser.address() as {port:number}).port,MAINTENANCE_DIR:path+'/absent-host-bridge'});
  running=await startApp();running.workflow.stop();
  const current=running;
  const calls:Array<{system:string;user:string;purpose:string}>=[];
  let replyHook:(()=>Promise<void>)|undefined;
  const complete:Generator['complete']=async(_config,system,user,_signal,_session,meta)=>{
   const purpose=meta?.purpose??'';calls.push({system,user,purpose});
   if(purpose==='daily-state')return {text:JSON.stringify(dailyContent(JSON.parse(user).date)),input:1,output:1,cache:0};
   if(purpose==='reply')await replyHook?.();
   if(!['reply','persona-preview'].includes(purpose))throw new Error('隔离测试不允许额外模型用途：'+purpose);
   return {text:JSON.stringify({action:'reply',text:'这一轮已收到。',reason:'回应当前消息'}),input:1,output:1,cache:0};
  };
  current.workflow.generator.complete=complete;current.workflow.generator.converse=(...args)=>fakeConverse({complete},...args as [any,string,any[],any[]]);
  const readHeaders={host:'presets.test','x-ingress-key':ingress};
  const writeHeaders={...readHeaders,'x-workflow-control':'1',origin:'https://presets.test'};
  return {...current,calls,requests,unexpected,readHeaders,writeHeaders,
   setConfigPersona(text:string){config.persona=text;writeConfig();},
   events(value:Event[]){events=value;},
   onReply(hook:()=>Promise<void>){replyHook=hook;},
   async close(){
    await current.app.close();await new Promise<void>(resolve=>browser.close(()=>resolve()));
    for(const listener of process.listeners('SIGTERM'))if(!previousSigterm.has(listener))process.removeListener('SIGTERM',listener);
    for(const name of envNames){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
    rmSync(path,{recursive:true,force:true});
   },
  };
 }catch(error){
  if(running)await running.app.close();await new Promise<void>(resolve=>browser.close(()=>resolve()));
  for(const listener of process.listeners('SIGTERM'))if(!previousSigterm.has(listener))process.removeListener('SIGTERM',listener);
  for(const name of envNames){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
  rmSync(path,{recursive:true,force:true});throw error;
 }
}

test('真实应用预设 GET 沿用鉴权和来源检查、免写标记，嵌套数据与后续请求隔离',async()=>{
 const f=await fixture();try{
  const url='/api/persona/presets';
  assert.equal((await f.app.inject({url})).statusCode,401);
  assert.equal((await f.app.inject({url,headers:{...f.readHeaders,'x-ingress-key':'wrong'}})).statusCode,401);
  assert.equal((await f.app.inject({url,headers:{...f.readHeaders,origin:'https://other.invalid'}})).statusCode,403);
  const response=await f.app.inject({url,headers:{...f.readHeaders,origin:'https://presets.test'}});
  assert.equal(response.statusCode,200,response.body);
  const snapshot=response.json();
  assert.equal(snapshot.version,3);assert.equal(snapshot.version,PERSONA_PRESETS_VERSION);
  assert.deepEqual(snapshot.items.map((item:any)=>item.id),['default','deepseek','gpt','claude','kimi','glm']);
  assert.deepEqual(snapshot.items,PERSONA_PRESETS);
  snapshot.items[0].persona.sections[0].content='客户端修改';
  snapshot.items[0].persona.triggers[0].condition='客户端条件';
  snapshot.items[1].bioSuggestion='客户端简介';
  const again=await f.app.inject({url,headers:f.readHeaders});
  assert.deepEqual(again.json(),{version:PERSONA_PRESETS_VERSION,items:PERSONA_PRESETS,fixedRules:FIXED_SYSTEM_RULES});
  assert.equal(JSON.stringify(PERSONA_PRESETS).includes('客户端'),false);
  const current=(await f.app.inject({url:'/api/persona',headers:f.readHeaders})).json();
  assert.equal(current.revision,0);assert.deepEqual(current.persona,defaultPersona());
  assert.equal(readPanelSettings().persona,undefined);assert.equal(f.calls.length,0);
  assert.equal(f.workflow.control(),'paused');assert.deepEqual(f.unexpected,[]);
 }finally{await f.close();}
});

test('真实应用未定制人设可用修订零保存，旧修订冲突且保存不改变暂停或接管',async()=>{
 const f=await fixture();try{
  const preset=structuredClone(PERSONA_PRESETS.find(item=>item.id==='deepseek')!.persona);
  const request={method:'PUT' as const,url:'/api/persona',payload:{persona:preset,revision:0}};
  assert.equal((await f.app.inject({...request,headers:f.readHeaders})).statusCode,403);
  assert.equal((await f.app.inject({...request,headers:{...f.writeHeaders,origin:'https://other.invalid'}})).statusCode,403);
  const saved=await f.app.inject({...request,headers:f.writeHeaders});
  assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().revision,1);assert.deepEqual(saved.json().persona,preset);
  assert.equal(f.workflow.control(),'paused');
  const stale=await f.app.inject({...request,headers:f.writeHeaders});assert.equal(stale.statusCode,409,stale.body);
  assert.deepEqual(readPanelSettings().persona,preset);
  const takeover=await f.app.inject({method:'POST',url:'/api/control/takeover',headers:f.writeHeaders});assert.equal(takeover.statusCode,200,takeover.body);
  const second=await f.app.inject({...request,headers:f.writeHeaders,payload:{persona:legacyPersona('接管时保存的人设'),revision:1}});
  assert.equal(second.statusCode,200,second.body);assert.equal(second.json().revision,2);assert.equal(f.workflow.control(),'manual');
  assert.equal(f.calls.length,0);assert.deepEqual(f.unexpected,[]);
 }finally{await f.close();}
});

test('真实应用日程共用默认、自定义及已保存人设，只发送分区正文且不自动重写今日',async()=>{
 const f=await fixture();try{
  const status=await f.app.inject({url:'/api/status',headers:f.readHeaders});assert.equal(status.json().accountId,'presetbot');
  const generate=(revision:number)=>f.app.inject({method:'POST',url:'/api/persona/daily/generate',headers:f.writeHeaders,payload:{revision}});
  const first=await generate(0);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().state.revision,1);assert.equal(first.json().state.configRevision,0);
  assert.equal(JSON.parse(f.calls[0].user).persona,sectionsText(defaultPersona()));
  for(const card of defaultPersona().triggers)assert.equal(JSON.parse(f.calls[0].user).persona.includes(card.content),true);
  const custom='  管理员自定义角色\n保留原文与空白。\n';f.setConfigPersona(custom);
  const second=await generate(1);assert.equal(second.json().state.revision,2);assert.equal(second.json().state.configRevision,0);
  assert.equal(JSON.parse(f.calls[1].user).persona,custom);
  const selected=structuredClone(PERSONA_PRESETS.find(item=>item.id==='gpt')!.persona);
  selected.triggers[0].content='本条触发正文不能进入日程';
  const saved=await f.app.inject({method:'PUT',url:'/api/persona',headers:f.writeHeaders,payload:{persona:selected,revision:0}});assert.equal(saved.statusCode,200,saved.body);
  const before=(await f.app.inject({url:'/api/persona/daily',headers:f.readHeaders})).json();assert.equal(before.today.revision,2);assert.equal(f.calls.length,2);
  const third=await generate(2);assert.equal(third.statusCode,200,third.body);assert.equal(third.json().state.revision,3);assert.equal(third.json().state.configRevision,1);
  assert.equal(JSON.parse(f.calls[2].user).persona,sectionsText(selected));
  assert.equal(JSON.parse(f.calls[2].user).persona.includes('本条触发正文不能进入日程'),true);
  assert.deepEqual(f.calls.map(call=>call.purpose),['daily-state','daily-state','daily-state']);
  assert.equal(f.workflow.control(),'paused');assert.deepEqual(f.unexpected,[]);
 }finally{await f.close();}
});

test('真实生产工作流保留本轮人设快照，保存后的下一轮使用预设且无语义判定调用',async()=>{
 const f=await fixture();let release:()=>void=()=>{};let pending:Promise<void>|undefined;
 try{
  // 只关闭可能额外访问浏览器或模型的应用任务，宿主健康任务不属于此测试范围。
  for(const id of ['daily-report','account-check','memory-summary'] as const)f.workflow.services.scheduler!.configure(id,{enabled:false});
  let entered!:()=>void;const generating=new Promise<void>(resolve=>entered=resolve);
  const gate=new Promise<void>(resolve=>release=resolve);
  f.onReply(async()=>{if(f.calls.filter(call=>call.purpose==='reply').length===1){entered();await gate;}});
  f.events([publicEvent('7001')]);await f.workflow.resume();pending=f.workflow.tick();
  await Promise.race([generating,pending.then(()=>{throw new Error('工作流未进入回复生成：'+JSON.stringify({logs:f.store.logs(10),requests:f.requests,calls:f.calls}));})]);
  const chosen=structuredClone(PERSONA_PRESETS.find(item=>item.id==='claude')!.persona);
  const saved=await f.app.inject({method:'PUT',url:'/api/persona',headers:f.writeHeaders,payload:{persona:chosen,revision:0}});assert.equal(saved.statusCode,200,saved.body);assert.equal(f.workflow.control(),'running');
  release();await pending;pending=undefined;
  f.events([publicEvent('7002')]);await f.workflow.tick();
  const replies=f.calls.filter(call=>call.purpose==='reply');assert.equal(replies.length,2);
  assert.ok(replies[0].system.includes(defaultPersona().sections[0].content));assert.equal(replies[0].system.includes(chosen.sections[0].content),false);
  for(const section of chosen.sections)assert.ok(replies[1].system.includes(section.content),section.id);
  assert.deepEqual(f.calls.map(call=>call.purpose),['daily-state','reply','reply']);
  assert.equal(f.store.getMessage('x:7001','presetbot').status,'draft');assert.equal(f.store.getMessage('x:7002','presetbot').status,'draft');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n,0);
  assert.equal(f.workflow.services.daily!.get('presetbot')!.configRevision,0);
  assert.equal(f.workflow.control(),'running');assert.deepEqual(f.unexpected,[]);
  assert.equal(f.requests.some(request=>/\/(?:send|post|lookup)/.test(request)),false);
 }finally{release();try{if(pending)await pending;}finally{await f.close();}}
});
