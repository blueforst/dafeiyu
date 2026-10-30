import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startApp } from '../src/app.js';
import { LlmStore } from '../src/llm-store.js';
import { exampleConfig } from './config-fixture.js';

// 完整注册真实 app 与其管理鉴权；浏览器仅连接下面的临时 HTTP stub。
test('整体管理 API：鉴权、请求体边界、配置修订及计费口径',async t=>{
 const path=mkdtempSync(tmpdir()+'/role-app-integration-');
 const envNames=['DATA_DIR','CONFIG_PATH','SECRETS_DIR','PORT','BROWSER_ENDPOINT','MAINTENANCE_DIR'] as const;
 const previous=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));
 const previousSigterm=new Set(process.listeners('SIGTERM'));
 const ingress='integration-ingress-secret',browserKey='integration-browser-secret',requests:string[]=[];
 const browser=createServer((req,res)=>{
  const respond=(code:number,value:unknown)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  requests.push(req.method+' '+req.url);
  if(req.headers['x-browser-key']!==browserKey){req.resume();respond(401,{error:'浏览器测试凭据不符'});return;}
  req.resume();req.on('end',()=>{
   if(req.method==='GET'&&req.url==='/identity')return respond(200,{handle:'IntegrationBot',loggedIn:true,needsHuman:false});
   if(req.method==='POST'&&req.url==='/control')return respond(200,{ok:true});
   respond(503,{error:'集成测试禁止采集、发送或访问真实平台'});
  });
 });
 let running:Awaited<ReturnType<typeof startApp>>|undefined;
 await new Promise<void>(resolve=>browser.listen(0,'127.0.0.1',resolve));
 const browserPort=(browser.address() as {port:number}).port;
 try{
  mkdirSync(path+'/secrets');
  writeFileSync(path+'/secrets/ingress_key',ingress,{mode:0o600});
  writeFileSync(path+'/secrets/browser_key',browserKey,{mode:0o600});
  writeFileSync(path+'/config.json',JSON.stringify(exampleConfig));
  Object.assign(process.env,{DATA_DIR:path+'/data',CONFIG_PATH:path+'/config.json',SECRETS_DIR:path+'/secrets',PORT:'0',BROWSER_ENDPOINT:'http://127.0.0.1:'+browserPort,MAINTENANCE_DIR:path+'/absent-host-bridge'});
  running=await startApp();
  const {app,store,workflow}=running;
  const authenticated={host:'panel.test','x-ingress-key':ingress};
  const writable={...authenticated,'x-workflow-control':'1',origin:'https://panel.test'};
  const reads=[
   '/api/persona','/api/persona/daily','/api/persona/daily/history',
   '/api/memory/policy','/api/memory/users','/api/memory/users/x%3Aalice?channel=public',
   '/api/program','/api/program/logs','/api/messages','/api/messages/missing-id',
   '/api/tasks','/api/tasks/runs','/api/tasks/runs/missing-id',
   '/api/billing/summary','/api/billing/calls',
  ];
  const writes:Array<{method:'PUT'|'POST'|'DELETE';url:string}>=[
   {method:'PUT',url:'/api/persona'},{method:'POST',url:'/api/persona/preview'},
   {method:'PUT',url:'/api/persona/daily'},{method:'POST',url:'/api/persona/daily/generate'},
   {method:'PUT',url:'/api/memory/policy'},{method:'PUT',url:'/api/memory/items/missing-id'},{method:'DELETE',url:'/api/memory/items/missing-id'},
   ...['summarize','forget','remember','preview'].map(action=>({method:'POST' as const,url:'/api/memory/users/x%3Aalice/'+action})),
   {method:'PUT',url:'/api/program/settings'},{method:'PUT',url:'/api/tasks/morning-post'},{method:'POST',url:'/api/tasks/health/run'},
  ];

  await t.test('新 GET 均要求入口凭据，所有新写入口要求控制标记和同源',async()=>{
   assert.equal((await app.inject({url:'/healthz'})).statusCode,200);
   for(const url of reads){
    assert.equal((await app.inject({url})).statusCode,401,url+' 未授权');
    assert.equal((await app.inject({url,headers:{...authenticated,origin:'https://other.invalid'}})).statusCode,403,url+' 跨来源');
   }
   for(const request of writes){
    assert.equal((await app.inject({...request,payload:{}})).statusCode,401,request.url+' 未授权');
    assert.equal((await app.inject({...request,headers:authenticated,payload:{}})).statusCode,403,request.url+' 缺控制标记');
    assert.equal((await app.inject({...request,headers:{...writable,origin:'https://other.invalid'},payload:{}})).statusCode,403,request.url+' 跨来源');
   }
   assert.equal(workflow.control(),'paused');
  });

  await t.test('最终提交授权只接受浏览器凭据，其他管理接口仍要求入口及控制鉴权',async()=>{
   const request={method:'POST' as const,url:'/internal/submission-authority',payload:{}};
   for(const headers of [{},authenticated,writable,{'x-browser-key':'wrong'}])assert.equal((await app.inject({...request,headers})).statusCode,401);
   const authorized=await app.inject({...request,headers:{'x-browser-key':browserKey}});
   assert.equal(authorized.statusCode,200);assert.deepEqual(authorized.json(),{allowed:false});
   assert.equal((await app.inject({url:request.url,headers:{'x-browser-key':browserKey}})).statusCode,401);
   assert.equal((await app.inject({method:'POST',url:'/api/control/resume',headers:{'x-browser-key':browserKey},payload:{}})).statusCode,401);
   assert.equal(workflow.control(),'paused');
  });

  await t.test('授权后的十三组新 GET 正常读取，默认开关与暂停一致',async()=>{
   const status=await app.inject({url:'/api/status',headers:authenticated});assert.equal(status.statusCode,200);assert.equal(status.json().accountId,'integrationbot');
   const allowed=reads.filter(url=>!url.endsWith('/missing-id'));
   assert.equal(allowed.length,13);
   for(const url of allowed){const result=await app.inject({url,headers:authenticated});assert.equal(result.statusCode,200,url+' '+result.body);}
   const tasks=(await app.inject({url:'/api/tasks',headers:authenticated})).json();
   assert.equal(tasks.control,'paused');
   for(const id of ['morning-post','evening-post','backup'])assert.equal(tasks.tasks.find((x:any)=>x.id===id).enabled,false,id+' 初始关闭');
   assert.equal(tasks.tasks.find((x:any)=>x.id==='daily-state').time,'06:00');
   assert.equal(tasks.tasks.find((x:any)=>x.id==='memory-summary').time,'03:00');
   assert.equal(workflow.control(),'paused');
  });

  await t.test('人设路由允许有效大于全局限制的正文，超过 128 KiB 明确返回 413',async()=>{
   const current=(await app.inject({url:'/api/persona',headers:authenticated})).json();
   const persona=structuredClone(current.persona);persona.sections[0].content='测'.repeat(17000);
   const payload={persona,revision:current.revision};assert.ok(Buffer.byteLength(JSON.stringify(payload))>16384);assert.ok(Buffer.byteLength(JSON.stringify(payload))<128*1024);
   const saved=await app.inject({method:'PUT',url:'/api/persona',headers:writable,payload});assert.equal(saved.statusCode,200,saved.body);assert.equal(workflow.control(),'paused');
   for(const request of [{method:'PUT' as const,url:'/api/persona'},{method:'POST' as const,url:'/api/persona/preview'}]){
    const oversized=await app.inject({...request,headers:writable,payload:{padding:'x'.repeat(128*1024)}});assert.equal(oversized.statusCode,413,request.url+' '+oversized.body);assert.match(oversized.json().error,/大小限制/);
   }
   const global=await app.inject({method:'PUT',url:'/api/program/settings',headers:writable,payload:{settings:{mode:'draft'},padding:'x'.repeat(20000)}});assert.equal(global.statusCode,413);
   assert.equal(workflow.control(),'paused');
  });

  await t.test('运行配置 CAS 拒绝过期修订，跨域保存不覆盖且仍暂停',async()=>{
   const prior=(await app.inject({url:'/api/program',headers:authenticated})).json();
   const saved=await app.inject({method:'PUT',url:'/api/program/settings',headers:writable,payload:{settings:{maxPerRound:3},revision:prior.revision}});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().revision,prior.revision+1);
   const stale=await app.inject({method:'PUT',url:'/api/program/settings',headers:writable,payload:{settings:{maxPerRound:4},revision:prior.revision}});assert.equal(stale.statusCode,409,stale.body);
   const policy=(await app.inject({url:'/api/memory/policy',headers:authenticated})).json();
   assert.equal((await app.inject({method:'PUT',url:'/api/memory/policy',headers:writable,payload:{policy:{...policy.policy,recentCount:4},revision:policy.revision}})).statusCode,200);
   const tasks=(await app.inject({url:'/api/tasks',headers:authenticated})).json();
   assert.equal((await app.inject({method:'PUT',url:'/api/tasks/daily-state',headers:writable,payload:{time:'06:10',revision:tasks.revision}})).statusCode,200);
   const persona=(await app.inject({url:'/api/persona',headers:authenticated})).json();assert.equal(persona.persona.sections[0].content.length,17000);assert.equal(persona.scheduleTime,'06:10');
   const after=(await app.inject({url:'/api/program',headers:authenticated})).json();assert.equal(after.settings.maxPerRound,3);assert.equal(after.control,'paused');assert.equal(workflow.control(),'paused');
  });

  await t.test('status 与计费汇总共享旧 usage 和新流水口径，不双计未知价格',async()=>{
   store.usage(2,3,4);
   const ledger=new LlmStore(store);
   const id=ledger.start({provider:'custom',id:'integration-model'},{purpose:'persona-preview',source:'integration',accountId:'integrationbot'});
   ledger.finish(id,'completed',{usage:{input:11,output:5,cacheRead:2,cacheWrite:3,totalTokens:21,reasoning:2},pricingStatus:'unpriced'});
   const aborted=ledger.start({provider:'custom',id:'integration-model'},{purpose:'model-test',source:'integration',accountId:'integrationbot'});ledger.finish(aborted,'aborted',{pricingStatus:'unknown'});
   const status=(await app.inject({url:'/api/status',headers:authenticated})).json();
   const summary=(await app.inject({url:'/api/billing/summary',headers:authenticated})).json();
   assert.deepEqual(status.stats.usage,summary.totals);assert.equal(summary.totals.calls,3);assert.equal(summary.totals.legacyRows,1);assert.equal(summary.totals.input,13);assert.equal(summary.totals.output,8);assert.equal(summary.totals.cacheRead,6);assert.equal(summary.totals.cacheWrite,3);assert.equal(summary.totals.reasoning,2);assert.equal(summary.totals.unpriced,1);assert.equal(summary.totals.unknown,2);assert.equal(summary.totals.costUSD,null);
   const calls=(await app.inject({url:'/api/billing/calls?limit=2',headers:authenticated})).json();assert.equal(calls.items.length,2);assert.ok(calls.nextCursor);
   const serialized=JSON.stringify(calls);assert.ok(!serialized.includes(ingress));assert.ok(!serialized.includes(browserKey));assert.ok(!serialized.includes('测'.repeat(100)));assert.ok(!serialized.includes('apiKey'));
   assert.equal(workflow.control(),'paused');
  });
  await t.test('SSE 继续发送旧日志数组，并增加独立程序与任务事件',async()=>{
   const abort=new AbortController(),address=app.server.address() as {port:number};
   const response=await fetch('http://127.0.0.1:'+address.port+'/api/events',{headers:authenticated,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(3000)])});
   const reader=response.body!.getReader();
   try{let text='';while(!text.includes('event: tasks\ndata:')&&text.length<100000){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}assert.match(text,/event: logs\ndata: \[/);assert.match(text,/event: program\ndata:/);assert.match(text,/event: tasks\ndata:/);}finally{abort.abort();await reader.cancel().catch(()=>{});}
  });
  assert.ok(requests.every(value=>value==='POST /control'||value==='GET /identity'),'测试期间不得采集、发送或调用平台：'+requests.join(','));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n,0);
 }finally{
  if(running)await running.app.close();
  await new Promise<void>(resolve=>browser.close(()=>resolve()));
  for(const listener of process.listeners('SIGTERM'))if(!previousSigterm.has(listener))process.removeListener('SIGTERM',listener);
  for(const name of envNames){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
  rmSync(path,{recursive:true,force:true});
 }
});
