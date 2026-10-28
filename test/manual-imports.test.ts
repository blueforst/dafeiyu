import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {Store,eventIdentity} from '../src/store.js';
import {ReplyTriage} from '../src/reply-triage.js';
import {ManualImportsService,ManualImportError,normalizeImportUrl,type ManualInspectResult} from '../src/manual-imports.js';
import {registerManualImportRoutes} from '../src/manual-import-routes.js';
import {Workflow} from '../src/workflow.js';
import {Outbox} from '../src/outbox.js';
import type {Event} from '../src/types.js';

function fixture(){
 const dir=mkdtempSync(tmpdir()+'/role-manual-import-'),store=new Store(dir+'/workflow.sqlite');let now=Date.now(),account='fixture_worker',control='paused',maxAge=6;
 const calls:Array<{url:string;accountId:string;deadline:number}>=[];
 const event=(id:string,patch:Partial<Event>={}):Event=>({id:'x:'+id,platformId:id,targetId:id,channel:'public',userId:'x:guest',handle:'guest',text:'@fixture_worker 请给个轻松的活动建议',url:'https://x.com/guest/status/'+id,conversationId:'conversation-'+id,timestamp:now-3600000,timestampReliable:true,...patch});
 let inspect:(url:string)=>Promise<ManualInspectResult>=async url=>({target:event(normalizeImportUrl(url).platformId),context:{ancestorHandles:[]}});
 const triage=new ReplyTriage(store,undefined,()=>now),imports=new ManualImportsService(store,{account:()=>account,control:()=>control,maxAgeHours:()=>maxAge,triage,now:()=>now,inspectPost:async(url,accountId,options)=>{calls.push({url,accountId,deadline:options.deadline});return inspect(url);}});
 return {store,triage,imports,event,calls,get now(){return now;},setNow(value:number){now=value;},setAccount(value:string){account=value;},setControl(value:string){control=value;},setMaxAge(value:number){maxAge=value;},setInspect(value:typeof inspect){inspect=value;},close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('补录链接只规整官方HTTPS帖子路径，不携带查询、片段、认证或任意地址',()=>{
 for(const host of ['x.com','twitter.com','mobile.x.com','mobile.twitter.com','www.x.com','www.twitter.com'])assert.deepEqual(normalizeImportUrl(' https://'+host+'/Guest/status/12345/?s=20#context '),{url:'https://x.com/guest/status/12345',handle:'guest',platformId:'12345'});
 for(const raw of [undefined,1,'','https://evil.invalid/guest/status/1','http://x.com/guest/status/1','https://x.com:444/guest/status/1','https://user:password@x.com/guest/status/1','https://x.com/guest/status/not-an-id','https://x.com/guest/status/1/photo/1','https://x.com/guest%2fother/status/1','https://x.com/i/chat/1-2','https://x.com/guest/status/1\\extra'])assert.throws(()=>normalizeImportUrl(raw),ManualImportError);
});

test('提交仅保存请求，pending按平台ID复用、每账号最多20条且可查看稳定分页',async()=>{
 const f=fixture();try{
  const first=f.imports.submit('https://twitter.com/Guest/status/1001?s=20');assert.equal(first.status,'pending');assert.equal(first.reused,false);assert.equal(first.request.url,'https://x.com/guest/status/1001');
  const same=f.imports.submit('https://mobile.x.com/guest/status/1001');assert.equal(same.request.id,first.request.id);assert.equal(same.reused,true);
  for(let i=2;i<=20;i++)f.imports.submit('https://x.com/guest/status/'+(1000+i));
  assert.equal(f.imports.summary().pending,20);assert.throws(()=>f.imports.submit('https://x.com/guest/status/2001'),(e:any)=>e.statusCode===409);assert.equal(f.imports.submit(first.request.url).request.id,first.request.id);
  assert.equal((await f.imports.processRound()).processed,0);assert.equal(f.calls.length,0);
  const expected=f.imports.list({limit:100}).items.map(x=>x.id),seen:string[]=[];let cursor:string|null=null;
  do{const page=f.imports.list({limit:3,...(cursor?{cursor}:{})});seen.push(...page.items.map(x=>x.id));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,20);
  f.setAccount('other_worker');assert.equal(f.imports.list().items.length,0);assert.throws(()=>f.imports.get(first.request.id),(e:any)=>e.statusCode===404);assert.equal(f.imports.submit('https://x.com/guest/status/1001').status,'pending');
  f.setAccount('');assert.throws(()=>f.imports.submit(first.request.url),(e:any)=>e.statusCode===409);
 }finally{f.close();}
});

test('已有消息立即duplicate且不打开浏览器、不改旧unknown和冻结出站',async()=>{
 const f=fixture();try{
  const e=f.event('301');f.store.ingest(e,'fixture_worker');const row=f.store.getMessage(e.id,'fixture_worker');f.store.update(row.id,'unknown',{draft:{action:'reply',text:'冻结正文',reason:''},receipt:{status:'unknown',reason:'待回查'}},'fixture_worker');
  const outbox=new Outbox(f.store),out=outbox.prepare({accountId:'fixture_worker',kind:'reply',sourceId:row.id,targetId:'301',event:e,text:'冻结正文'});outbox.begin(out.id);outbox.settle(out.id,{status:'unknown',reason:'待回查'});
  const before=JSON.stringify({message:f.store.getMessage(row.id),outbox:outbox.get(out.id)}),submitted=f.imports.submit(e.url);assert.equal(submitted.status,'duplicate');assert.equal(submitted.messageStatus,'unknown');assert.equal(submitted.request.messageId,row.id);
  assert.equal(f.imports.submit(e.url).request.id,submitted.request.id);f.setControl('running');assert.equal((await f.imports.processRound()).processed,0);assert.equal(f.calls.length,0);assert.equal(JSON.stringify({message:f.store.getMessage(row.id),outbox:outbox.get(out.id)}),before);
 }finally{f.close();}
});

test('每轮最多检查三条，通过后原子管理员优先入队，draft工作流只生成草稿',async()=>{
 const f=fixture();let generated=0,sent=0;try{
  for(let i=1;i<=5;i++)f.imports.submit('https://x.com/guest/status/'+(400+i));f.setControl('running');
  const result=await f.imports.processRound({limit:99,deadline:f.now+45000});assert.equal(result.processed,3);assert.equal(f.calls.length,3);assert.equal(f.imports.summary().pending,2);
  for(const request of result.items){assert.equal(request.status,'imported');const row=f.store.getMessage(request.messageId!,'fixture_worker');assert.equal(row.status,'queued');assert.equal(row.tier,'priority');assert.equal(row.tier_reason,'管理员补录');assert.equal(row.processed_seq,0);assert.equal(f.store.get('triage:manual:'+row.id),'1');}
  const workflow=new Workflow(f.store,{identity:async()=>({handle:'fixture_worker',loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>({events:[],warnings:[]}),context:async()=> '合成上下文',send:async()=>{sent++;return {status:'confirmed',id:'must-not-send'};},lookup:async()=>({status:'unknown'})},{complete:async()=>{generated++;return {text:JSON.stringify({action:'reply',text:'五分钟散步会很轻松。',reason:''}),input:0,output:0,cache:0};}},()=>({mode:'draft',pollSeconds:60,maxAgeHours:6,maxPerRound:2,publicPerHour:10,privatePerHour:30,retentionDays:30,persona:'合成测试AI角色',dailyState:'合成虚构日程',model:{provider:'custom',api:'openai-completions',baseUrl:'',id:'',reasoning:false,reasoningLevel:'off',vision:false,maxTokens:4096,timeoutMs:60000}}));
  workflow.services={triage:f.triage};try{await workflow.resume();await workflow.tick();}finally{workflow.stop();}
  assert.equal(generated,2);assert.equal(sent,0);assert.equal(Number((f.store.db.prepare("SELECT count(*) n FROM messages WHERE status='draft'").get() as any).n),2);
 }finally{f.close();}
});

test('补录核对作者、提及边界、上文关系、可靠时间及链接目标，单项失败不阻断其他项',async()=>{
 const f=fixture();try{
  const cases:Array<{id:string;patch:Partial<Event>;ancestors?:string[];status:string}>=[
   {id:'501',patch:{handle:'fixture_worker',url:'https://x.com/fixture_worker/status/501'},status:'rejected'},
   {id:'502',patch:{text:'@fixture_worker_extra 并非当前账号'},status:'rejected'},
   {id:'503',patch:{text:'没有直接提及，但属于当前账号上文'},ancestors:['fixture_worker'],status:'imported'},
   {id:'504',patch:{timestamp:f.now-7*3600000},status:'rejected'},
   {id:'505',patch:{timestampReliable:false},status:'failed'},
   {id:'506',patch:{timestamp:f.now+120000},status:'failed'},
   {id:'507',patch:{platformId:'999'},status:'failed'},
  ];
  for(const c of cases){const author=c.patch.handle??'guest';const r=f.imports.submit('https://x.com/'+author+'/status/'+c.id);f.setInspect(async()=>({target:f.event(c.id,c.patch),context:{ancestorHandles:c.ancestors??[]}}));f.setControl('running');await f.imports.processRound();assert.equal(f.imports.get(r.request.id).status,c.status,c.id);}
  assert.equal(Number((f.store.db.prepare('SELECT count(*) n FROM messages').get() as any).n),1);
  assert.ok(f.imports.forMessage(eventIdentity('fixture_worker','public','503')).length===1);
 }finally{f.close();}
});

test('暂停、接管、排空、截止、中止及账号切换均保留pending，不在错误账号入队',async()=>{
 const f=fixture();try{
  const request=f.imports.submit('https://x.com/guest/status/601').request;
  for(const state of ['paused','manual','draining']){f.setControl(state);assert.equal((await f.imports.processRound()).processed,0);}
  f.setControl('running');assert.equal((await f.imports.processRound({deadline:f.now})).processed,0);const already=new AbortController();already.abort();assert.equal((await f.imports.processRound({signal:already.signal})).processed,0);assert.equal(f.calls.length,0);
  let resolve!:(value:ManualInspectResult)=>void;f.setInspect(()=>new Promise(done=>{resolve=done;}));const processing=f.imports.processRound();assert.equal((await f.imports.processRound()).processed,0);f.setAccount('other_worker');resolve({target:f.event('601'),context:{ancestorHandles:[]}});assert.equal((await processing).processed,0);
  f.setAccount('fixture_worker');assert.equal(f.imports.get(request.id).status,'pending');assert.equal(f.store.getMessage('x:601','fixture_worker'),undefined);
  f.setInspect(async()=>{f.setControl('manual');return {target:f.event('601'),context:{ancestorHandles:[]}};});assert.equal((await f.imports.processRound()).processed,0);assert.equal(f.imports.get(request.id).status,'pending');
 }finally{f.close();}
});

test('浏览器错误只影响该请求且可重提，受限传播暂停信号，日志不含URL正文或异常',async()=>{
 const f=fixture();try{
  const first=f.imports.submit('https://x.com/guest/status/701').request;f.setControl('running');f.setInspect(async()=>{throw Error('用户原文和fixture-secret https://private.invalid');});assert.equal((await f.imports.processRound()).processed,1);assert.equal(f.imports.get(first.id).status,'failed');
  const retried=f.imports.submit(first.url).request;assert.notEqual(retried.id,first.id);f.setInspect(async()=>{throw Object.assign(Error('private restriction body'),{browserPaused:true,restricted:'locked'});});await assert.rejects(f.imports.processRound(),(e:any)=>e.browserPaused===true&&e.restricted==='locked');assert.equal(f.imports.get(retried.id).status,'failed');
  const logs=JSON.stringify(f.store.logs());assert.ok(logs.includes('manual-import'));for(const text of ['fixture-secret','用户原文','private.invalid','https://x.com','restriction body'])assert.ok(!logs.includes(text),text);
 }finally{f.close();}
});

test('遗忘和旧来源保护不因人工补录绕过，失败无残留marker；入队分类不先推进processed序号',async()=>{
 const f=fixture();try{
  f.store.forget('x:guest','fixture_worker');const request=f.imports.submit('https://x.com/guest/status/801').request;f.setControl('running');await f.imports.processRound();assert.equal(f.imports.get(request.id).status,'rejected');assert.equal(f.store.get('triage:manual:'+eventIdentity('fixture_worker','public','801')),'');assert.equal(Number((f.store.db.prepare('SELECT count(*) n FROM messages').get() as any).n),0);
  f.store.remember('x:guest','fixture_worker');assert.equal(f.triage.ingestManual(f.event('802',{timestamp:0}),'fixture_worker',6),false);assert.equal(f.store.get('triage:manual:'+eventIdentity('fixture_worker','public','802')),'');
 }finally{f.close();}
});

test('管理员标记和入库事务一起回滚；检查期间已有消息出现也只登记duplicate',async()=>{
 const f=fixture();try{
  f.store.db.exec("CREATE TRIGGER fixture_manual_update_failure BEFORE UPDATE OF tier ON messages BEGIN SELECT RAISE(FAIL,'synthetic-update-failure'); END");
  assert.throws(()=>f.triage.ingestManual(f.event('851'),'fixture_worker',6),/synthetic-update-failure/);
  assert.equal(f.store.getMessage('x:851','fixture_worker'),undefined);assert.equal(f.store.get('triage:manual:'+eventIdentity('fixture_worker','public','851')),'');
  f.store.db.exec('DROP TRIGGER fixture_manual_update_failure');
  const request=f.imports.submit('https://x.com/guest/status/852').request;f.setControl('running');
  f.setInspect(async()=>{f.store.ingest(f.event('852'),'fixture_worker');const row=f.store.getMessage('x:852','fixture_worker');f.store.update(row.id,'unknown',{receipt:{status:'unknown',reason:'先有的未知结果'}},'fixture_worker');return {target:f.event('852'),context:{ancestorHandles:[]}};});
  await f.imports.processRound();const completed=f.imports.get(request.id);assert.equal(completed.status,'duplicate');assert.equal(completed.messageStatus,'unknown');assert.equal(f.store.get('triage:manual:'+eventIdentity('fixture_worker','public','852')),'');
 }finally{f.close();}
});

test('pending后出现旧消息平台标识冲突时只失败该项，保留旧行并继续其他补录',async()=>{
 for(const timing of ['before','during']){
  const f=fixture();try{
   const first=f.imports.submit('https://x.com/guest/status/861').request;f.setNow(f.now+1);const second=f.imports.submit('https://x.com/guest/status/862').request;
   const conflict=()=>{const event=f.event('861');f.store.ingest(event,'fixture_worker');const row=f.store.getMessage(event.id,'fixture_worker');f.store.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify({...event,url:'https://x.com/guest/status/999861'}),row.id);return JSON.stringify(f.store.getMessage(row.id));};
   let before='';if(timing==='before')before=conflict();
   f.setInspect(async url=>{const id=normalizeImportUrl(url).platformId;if(id==='861'&&timing==='during')before=conflict();return {target:f.event(id),context:{ancestorHandles:[]}};});
   f.setControl('running');const result=await f.imports.processRound();assert.equal(result.processed,2);assert.equal(f.imports.get(first.id).status,'failed');assert.match(f.imports.get(first.id).reason!,/平台标识冲突/);assert.equal(f.imports.get(second.id).status,'imported');assert.equal(f.imports.summary().pending,0);
   assert.equal(JSON.stringify(f.store.getMessage('x:861','fixture_worker')),before);assert.equal(f.store.get('triage:manual:'+eventIdentity('fixture_worker','public','861')),'');assert.equal(f.calls.length,timing==='before'?1:2);assert.ok(!JSON.stringify(f.store.logs()).includes('999861'));
  }finally{f.close();}
 }
});

test('检查途中中止或耗尽共享时间预算时仍保留pending，恢复后再检查',async()=>{
 const f=fixture();try{
  const request=f.imports.submit('https://x.com/guest/status/871').request;f.setControl('running');const abort=new AbortController();
  f.setInspect(async()=>{abort.abort();throw Error('aborted');});assert.equal((await f.imports.processRound({signal:abort.signal})).processed,0);assert.equal(f.imports.get(request.id).status,'pending');
  const deadline=f.now+10;f.setInspect(async()=>{f.setNow(deadline);return {target:f.event('871'),context:{ancestorHandles:[]}};});assert.equal((await f.imports.processRound({deadline})).processed,0);assert.equal(f.imports.get(request.id).status,'pending');
  f.setInspect(async()=>({target:f.event('871'),context:{ancestorHandles:[]}}));await f.imports.processRound();assert.equal(f.imports.get(request.id).status,'imported');
 }finally{f.close();}
});

test('补录接口沿用入口鉴权、控制标记及当前账号，读取结果不触发浏览器',async()=>{
 const f=fixture(),app=Fastify();let wakes=0;try{
  app.addHook('onRequest',async(req,reply)=>{if(req.headers['x-test-key']!=='fixture-key')return reply.code(401).send({error:'未授权'});if(req.method!=='GET'&&req.headers['x-workflow-control']!=='1')return reply.code(403).send({error:'缺少控制标记'});});registerManualImportRoutes(app,{imports:f.imports,wake:()=>{wakes++;}});await app.ready();
  assert.equal((await app.inject({method:'POST',url:'/api/messages/import',payload:{url:'https://x.com/guest/status/901'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/messages/import',headers:{'x-test-key':'fixture-key'},payload:{url:'https://x.com/guest/status/901'}})).statusCode,403);
  const headers={'x-test-key':'fixture-key','x-workflow-control':'1'},created=await app.inject({method:'POST',url:'/api/messages/import',headers,payload:{url:'https://x.com/guest/status/901'}});assert.equal(created.statusCode,200);assert.equal(created.json().status,'pending');assert.equal(wakes,1);
  const id=created.json().request.id;assert.equal((await app.inject({method:'GET',url:'/api/messages/imports?status=pending',headers})).json().items.length,1);assert.equal((await app.inject({method:'GET',url:'/api/messages/imports/'+id,headers})).json().request.id,id);
  f.store.ingest(f.event('901'),'fixture_worker');const duplicate=await app.inject({method:'POST',url:'/api/messages/import',headers,payload:{url:'https://x.com/guest/status/901'}});assert.equal(duplicate.json().status,'duplicate');assert.equal(wakes,1,'已有消息不唤醒浏览器工作轮次');
  assert.equal((await app.inject({method:'POST',url:'/api/messages/import',headers,payload:{url:'https://x.com/guest/status/902',body:'not allowed'}})).statusCode,400);f.setAccount('other_worker');assert.equal((await app.inject({method:'GET',url:'/api/messages/imports/'+id,headers})).statusCode,404);assert.equal(f.calls.length,0);
 }finally{await app.close();f.close();}
});
