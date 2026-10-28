import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {startApp} from '../src/app.js';
import {mergePanelSettings,writeModelKey,keySlot,readPanelSettings} from '../src/settings.js';
import {exampleConfig} from './config-fixture.js';

// 完整 app 只连接临时浏览器 stub；所有非 stub HTTP 出站请求都在本测试中拒绝。
test('剩余提案整体 API：注册、管理鉴权、只读缓存与暂停保存',async t=>{
 const directory=mkdtempSync(tmpdir()+'/role-proposals-app-'),names=['DATA_DIR','CONFIG_PATH','SECRETS_DIR','PORT','BROWSER_ENDPOINT','MAINTENANCE_DIR'] as const,previous=Object.fromEntries(names.map(name=>[name,process.env[name]])),listeners=new Set(process.listeners('SIGTERM'));
 const ingress='proposals-ingress-secret',browserKey='proposals-browser-secret',modelKey='proposals-model-key-87654321',requests:string[]=[],external:string[]=[];
 const nativeFetch=globalThis.fetch;
 const browser=createServer((req,res)=>{
  requests.push(req.method+' '+req.url);req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');if(req.headers['x-browser-key']!==browserKey){res.writeHead(401);res.end(JSON.stringify({error:'测试凭据不符'}));return;}if(req.method==='POST'&&req.url==='/control'){res.end(JSON.stringify({ok:true}));return;}if(req.method==='GET'&&req.url==='/identity'){res.end(JSON.stringify({handle:'ProposalsBot',loggedIn:true,needsHuman:false}));return;}res.writeHead(503);res.end(JSON.stringify({error:'本测试禁止采集、页面操作和真实发送'}));});
 });
 await new Promise<void>(resolve=>browser.listen(0,'127.0.0.1',resolve));const endpoint='http://127.0.0.1:'+(browser.address() as {port:number}).port;
 let running:Awaited<ReturnType<typeof startApp>>|undefined;
 try{
  mkdirSync(directory+'/secrets');writeFileSync(directory+'/secrets/ingress_key',ingress,{mode:0o600});writeFileSync(directory+'/secrets/browser_key',browserKey,{mode:0o600});writeFileSync(directory+'/config.json',JSON.stringify(exampleConfig));Object.assign(process.env,{DATA_DIR:directory+'/data',CONFIG_PATH:directory+'/config.json',SECRETS_DIR:directory+'/secrets',PORT:'0',BROWSER_ENDPOINT:endpoint,MAINTENANCE_DIR:directory+'/missing-maintenance'});
  globalThis.fetch=(async(input:any,init?:any)=>{const url=String(input instanceof Request?input.url:input);if(!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)){external.push(url);throw new Error('整体提案验收禁止外部 HTTP 请求');}return nativeFetch(input,init);}) as typeof fetch;
  mergePanelSettings('model',{provider:'custom',baseUrl:'https://models.integration.invalid/v1',api:'openai-completions',id:'fixture-model',reasoningLevel:'off',maxTokens:4096,timeoutMs:60000,custom:{contextWindow:128000,reasoning:false}},0);writeModelKey(keySlot('custom','https://models.integration.invalid/v1'),modelKey);
  running=await startApp();const {app,store,workflow}=running;workflow.stop();store.set('activeAccount','proposalsbot');
  const auth={host:'panel.test','x-ingress-key':ingress},write={...auth,'x-workflow-control':'1',origin:'https://panel.test'};
  const reads=[
   '/api/feed','/api/feed?filter=pending','/api/feed/conversations','/api/feed/conversations/posts/items','/api/personas','/api/personas/current','/api/chat-test/status','/api/chat-test/users','/api/health','/api/health/alerts','/api/health/reports',
   '/api/persona/replay/samples','/api/persona/replay/runs','/api/persona/quality',
   '/api/persona/prompt-hints','/api/triage/summary','/api/triage/ignores','/api/triage/settings',
   '/api/account/posting-limits','/api/billing/activity?weeks=52','/api/model',
  ];
  const writes:Array<{method:'POST'|'PUT'|'PATCH'|'DELETE';url:string;pattern?:string}>=[
   {method:'POST',url:'/api/personas'},
   ...(['PUT','DELETE'] as const).map(method=>({method,url:'/api/personas/missing',pattern:'/api/personas/:id'})),
   {method:'POST',url:'/api/personas/missing/activate',pattern:'/api/personas/:id/activate'},
   {method:'POST',url:'/api/chat-test/users'},
   ...(['PATCH','DELETE'] as const).map(method=>({method,url:'/api/chat-test/users/missing',pattern:'/api/chat-test/users/:id'})),
   ...['reset','clear-cooldown','messages','process','memory/summarize'].map(action=>({method:'POST' as const,url:'/api/chat-test/users/missing/'+action,pattern:'/api/chat-test/users/:id/'+action})),
   ...['retry','cancel'].map(action=>({method:'POST' as const,url:'/api/chat-test/users/missing/turns/missing/'+action,pattern:'/api/chat-test/users/:id/turns/:turnId/'+action})),
   ...['approve','cancel','regenerate','requeue'].map(action=>({method:'POST' as const,url:'/api/messages/missing/'+action,pattern:'/api/messages/:id/'+action})),
   {method:'PUT',url:'/api/persona/prompt-hints'},{method:'PUT',url:'/api/triage/settings'},{method:'DELETE',url:'/api/triage/ignores'},{method:'DELETE',url:'/api/triage/ignores/missing',pattern:'/api/triage/ignores/:userId'},
   {method:'POST',url:'/api/account/posting-limits/refresh'},
   {method:'POST',url:'/api/persona/replay/estimate'},{method:'POST',url:'/api/persona/replay/runs'},
   {method:'PUT',url:'/api/persona/replay/runs/missing/items/missing/label',pattern:'/api/persona/replay/runs/:id/items/:messageId/label'},
   ...['abort','adopt'].map(action=>({method:'POST' as const,url:'/api/persona/replay/runs/missing/'+action,pattern:'/api/persona/replay/runs/:id/'+action})),
   {method:'DELETE',url:'/api/persona/replay/runs/missing',pattern:'/api/persona/replay/runs/:id'},
   {method:'POST',url:'/api/model/library'},
   ...(['PUT','DELETE'] as const).map(method=>({method,url:'/api/model/library/missing',pattern:'/api/model/library/:key'})),
   {method:'POST',url:'/api/model/library/missing/refresh',pattern:'/api/model/library/:key/refresh'},
   {method:'PUT',url:'/api/model/library/missing/models/missing',pattern:'/api/model/library/:key/models/:id'},
   {method:'POST',url:'/api/model/library/missing/models/missing/test',pattern:'/api/model/library/:key/models/:id/test'},
   {method:'PUT',url:'/api/model/active'},
  ];

  await t.test('新增路由实际注册，GET与所有写入口要求管理凭据、控制标记和同源',async()=>{
   assert.equal((await app.inject({url:'/healthz'})).statusCode,200);
   for(const url of reads){const pattern=url.startsWith('/api/feed/conversations/posts/')?'/api/feed/conversations/:key/items':url.startsWith('/api/personas/')?'/api/personas/:id':url.split('?')[0];assert.equal(app.hasRoute({method:'GET',url:pattern}),true,url+' 已注册');assert.equal((await app.inject({url})).statusCode,401,url+' 无凭据');assert.equal((await app.inject({url,headers:{...auth,origin:'https://other.invalid'}})).statusCode,403,url+' 跨来源');}
   for(const request of writes){const {pattern,...route}=request;assert.equal(app.hasRoute({method:route.method,url:pattern??route.url}),true,route.url+' 已注册');assert.equal((await app.inject({...route,payload:{}})).statusCode,401,route.url+' 无凭据');assert.equal((await app.inject({...route,headers:auth,payload:{}})).statusCode,403,route.url+' 缺控制标记');assert.equal((await app.inject({...route,headers:{...write,origin:'https://other.invalid'},payload:{}})).statusCode,403,route.url+' 跨来源');}
   assert.equal(workflow.control(),'paused');
  });

  await t.test('新增GET只读持久缓存，不访问浏览器/模型，不创建出站',async()=>{
   const before=[...requests];for(const url of reads){const response=await app.inject({url,headers:auth});assert.equal(response.statusCode,200,url+' '+response.body);assert.ok(!response.body.includes(ingress));assert.ok(!response.body.includes(browserKey));assert.ok(!response.body.includes(modelKey));}
   for(const url of ['/api/health/reports/2000-01-01','/api/persona/replay/runs/missing','/api/persona/replay/runs/missing/items/missing'])assert.equal((await app.inject({url,headers:auth})).statusCode,404,url);
   assert.deepEqual(requests,before);assert.deepEqual(external,[]);assert.equal(store.db.prepare('SELECT count(*) n FROM llm_calls').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,0);assert.equal(workflow.control(),'paused');
   const model=(await app.inject({url:'/api/model',headers:auth})).json();assert.equal(model.library.providers[0].keyHint,'••••4321');assert.equal(model.library.active.default.modelId,'fixture-model');assert.equal(model.library.providers[0].hasKey,true);
   const limits=(await app.inject({url:'/api/account/posting-limits',headers:auth})).json();assert.equal(limits.accountId,'proposalsbot');assert.equal(limits.effective.reply.limit,280);assert.equal(limits.reply.status,'unknown');
  });

  await t.test('提醒、分级和模型保存仍暂停，配置修订冲突明确拒绝',async()=>{
   const before=[...requests],hints=(await app.inject({url:'/api/persona/prompt-hints',headers:auth})).json();
   const saved=await app.inject({method:'PUT',url:'/api/persona/prompt-hints',headers:write,payload:{promptHints:{...hints.promptHints,lateMinutes:90},revision:hints.revision}});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().revision,hints.revision+1);assert.equal(workflow.control(),'paused');
   const conflict=await app.inject({method:'PUT',url:'/api/persona/prompt-hints',headers:write,payload:{promptHints:hints.promptHints,revision:hints.revision}});assert.equal(conflict.statusCode,409,conflict.body);
   const triage=(await app.inject({url:'/api/triage/settings',headers:auth})).json(),updated=await app.inject({method:'PUT',url:'/api/triage/settings',headers:write,payload:{settings:{...triage.settings,batchThreshold:4},revision:triage.revision}});assert.equal(updated.statusCode,200,updated.body);assert.equal(workflow.control(),'paused');
   const model=(await app.inject({url:'/api/model',headers:auth})).json(),modelSaved=await app.inject({method:'PUT',url:'/api/model',headers:write,payload:{settings:{...model.settings,maxTokens:2048},revision:model.revision}});assert.equal(modelSaved.statusCode,200,modelSaved.body);assert.equal(readPanelSettings().model?.maxTokens,2048);assert.equal(readPanelSettings().promptHints?.lateMinutes,90);assert.equal(readPanelSettings().triage?.batchThreshold,4);assert.equal(workflow.control(),'paused');assert.deepEqual(requests,before);assert.deepEqual(external,[]);
  });

  await t.test('暂停时批准/取消/重写仅转换数据库状态，不调用模型、不提交浏览器',async()=>{
   const before=[...requests],now=Date.now(),e={id:'fixture-public',channel:'public' as const,userId:'x:fixture',handle:'fixture',text:'仅用于隔离验收的对方正文',url:'https://x.com/fixture/status/123',conversationId:'123',timestamp:now,timestampReliable:true,platformId:'123',targetId:'123',accountId:'proposalsbot'};store.ingest(e,'proposalsbot');const row=store.getMessage(e.id,'proposalsbot')!;store.update(row.id,'draft',{draft:{action:'reply',text:'隔离回复正文',reason:''}},'proposalsbot');
   const draft=store.getMessage(row.id,'proposalsbot')!,url='/api/messages/'+encodeURIComponent(row.id);
   const approve=await app.inject({method:'POST',url:url+'/approve',headers:write,payload:{text:'人工编辑后的隔离回复',revision:draft.updated_at}});assert.equal(approve.statusCode,200,approve.body);assert.equal(store.getMessage(row.id)!.status,'approved');assert.equal(workflow.control(),'paused');
   const cancel=await app.inject({method:'POST',url:url+'/cancel',headers:write,payload:{revision:approve.json().revision}});assert.equal(cancel.statusCode,200,cancel.body);assert.equal(store.getMessage(row.id)!.status,'draft');
   const regenerated=await app.inject({method:'POST',url:url+'/regenerate',headers:write,payload:{revision:cancel.json().revision}});assert.equal(regenerated.statusCode,200,regenerated.body);assert.equal(store.getMessage(row.id)!.status,'queued');assert.equal(JSON.parse(store.getMessage(row.id)!.draft).review,true);assert.equal(workflow.control(),'paused');assert.deepEqual(requests,before);assert.deepEqual(external,[]);assert.equal(store.db.prepare('SELECT count(*) n FROM llm_calls').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,0);
   store.ingest({...e,id:'other-source',platformId:'456',targetId:'456',url:'https://x.com/fixture/status/456',conversationId:'456',accountId:'otherbot'},'otherbot');const other=store.getMessage('other-source','otherbot')!;store.update(other.id,'draft',{draft:{action:'reply',text:'另一个账号正文',reason:''}},'otherbot');const denied=await app.inject({method:'POST',url:'/api/messages/'+encodeURIComponent(other.id)+'/approve',headers:write,payload:{text:'不能跨账号批准',revision:store.getMessage(other.id)!.updated_at}});assert.equal(denied.statusCode,404,denied.body);
  });

  await t.test('会话详情只追加分级和人设身份，不返回派生提示词正文',async()=>{
   const row=store.getMessage('fixture-public','proposalsbot')!;
   store.db.prepare('UPDATE messages SET tier=?,tier_reason=? WHERE id=?').run('priority','first-visit',row.id);
   store.db.prepare('INSERT INTO generation_snapshots(message_id,account_id,user_id,channel,created_at,body_json) VALUES(?,?,?,?,?,?)').run(row.id,row.account_id,row.user_id,row.channel,Date.now(),JSON.stringify({personaId:'saved-persona',personaName:'隔离人设',personaRevision:3,conversation:'禁止返回的提示词分段'}));
   const response=await app.inject({url:'/api/messages/'+encodeURIComponent(row.id),headers:auth});assert.equal(response.statusCode,200,response.body);
   assert.equal(response.json().message.tier,'priority');assert.equal(response.json().message.tierReason,'first-visit');assert.deepEqual(response.json().message.persona,{id:'saved-persona',name:'隔离人设',revision:3});assert.ok(!response.body.includes('禁止返回的提示词分段'));
   store.db.prepare('UPDATE generation_snapshots SET body_json=? WHERE message_id=?').run(JSON.stringify({personaRevision:2}),row.id);
   const legacy=(await app.inject({url:'/api/messages/'+encodeURIComponent(row.id),headers:auth})).json();assert.equal(legacy.message.persona.name,'未记录');assert.equal(legacy.message.persona.revision,2);
  });

  await t.test('人设库和试聊写入口保留独立请求体上限',async()=>{
   for(const [url,size] of [['/api/personas',129*1024],['/api/chat-test/users',65*1024]] as const){const response=await app.inject({method:'POST',url,headers:write,payload:{name:'字'.repeat(size)}});assert.equal(response.statusCode,413,url+' '+response.body);}
   assert.equal(store.db.prepare('SELECT count(*) n FROM llm_calls').get()!.n,0);assert.equal(workflow.control(),'paused');
  });

  await t.test('feed SSE只含摘要，其他页面可刷新待处理数字而不泄露正文',async()=>{
   const address=app.server.address() as {port:number},abort=new AbortController(),response=await fetch('http://127.0.0.1:'+address.port+'/api/events',{headers:auth,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(3000)])}),reader=response.body!.getReader();
   try{let output='';while(!output.includes('event: feed\ndata:')&&output.length<100000){const chunk=await reader.read();if(chunk.done)break;output+=new TextDecoder().decode(chunk.value);}const feed=output.match(/event: feed\ndata: ([^\n]+)/);assert.ok(feed,output);const payload=JSON.parse(feed[1]);assert.equal(typeof payload.latest,'number');assert.equal(typeof payload.pending,'number');assert.ok(!JSON.stringify(payload).includes('隔离'));assert.ok(!JSON.stringify(payload).includes(modelKey));assert.equal(workflow.control(),'paused');}finally{abort.abort();await reader.cancel().catch(()=>{});}
  });
  assert.deepEqual(external,[]);assert.ok(requests.every(value=>value==='POST /control'),'所有新增API均不隐式读取浏览器页面：'+requests.join(','));
 }finally{
  if(running)await running.app.close();globalThis.fetch=nativeFetch;await new Promise<void>(resolve=>browser.close(()=>resolve()));for(const listener of process.listeners('SIGTERM'))if(!listeners.has(listener))process.removeListener('SIGTERM',listener);for(const name of names)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];rmSync(directory,{recursive:true,force:true});
 }
});
