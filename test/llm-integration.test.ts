import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer,type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Store } from '../src/store.js';
import { ModelService,parseDraft } from '../src/model.js';
import { LlmStore,billingTotals } from '../src/llm-store.js';
import { MemoryService } from '../src/memory.js';
import { exampleConfig } from './config-fixture.js';
import type { Config,Event } from '../src/types.js';

const execute=promisify(execFile);
const EVENT:Event={id:'raw-source',platformId:'123456789',channel:'public',userId:'visitor',handle:'visitor',text:'我喜欢热茶',url:'https://x.com/visitor/status/123456789',conversationId:'123456789',timestamp:Date.now(),timestampReliable:true};
function fixture(){
 const dir=mkdtempSync(tmpdir()+'/role-llm-integration-');mkdirSync(dir+'/data');mkdirSync(dir+'/secrets');
 const config:Config=structuredClone(exampleConfig) as Config;
 writeFileSync(dir+'/secrets/model_api_key','integration-only-key');writeFileSync(dir+'/secrets/ingress_key','integration-ingress-only-key');writeFileSync(dir+'/secrets/browser_key','integration-browser-only-key');
 const previous=new Map(['DATA_DIR','SECRETS_DIR','CONFIG_PATH','BROWSER_ENDPOINT','PORT'].map(key=>[key,process.env[key]]));
 process.env.DATA_DIR=dir+'/data';process.env.SECRETS_DIR=dir+'/secrets';process.env.CONFIG_PATH=dir+'/config.json';
 const store=new Store(dir+'/data/workflow.sqlite'),ledger=new LlmStore(store);
 return {dir,store,ledger,config,save(){writeFileSync(dir+'/config.json',JSON.stringify(config));},close(){store.db.close();for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(dir,{recursive:true,force:true});}};
}
async function httpFixture(handler:(res:ServerResponse,body:any)=>void){
 const seen:any[]=[];const server=createServer((req,res)=>{let raw='';req.on('data',part=>raw+=part);req.on('end',()=>{const body=JSON.parse(raw||'{}');seen.push({url:req.url,headers:req.headers,body});handler(res,body);});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {base:'http://127.0.0.1:'+(server.address() as any).port,seen,async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
function completion(res:ServerResponse,text:string){
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const base={id:'completion-test',object:'chat.completion.chunk',created:1,model:'integration-model'};
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\n');
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40,prompt_tokens_details:{cached_tokens:4,cache_write_tokens:6},completion_tokens_details:{reasoning_tokens:3}}})+'\n\n');
 res.end('data: [DONE]\n\n');
}

test('真实协议解析后业务JSON失败仍保留全部用量，默认4096且不写旧usage',async()=>{
 const f=fixture(),http=await httpFixture(res=>completion(res,'这不是业务JSON'));
 try{
  f.config.model={...f.config.model,provider:'custom',baseUrl:http.base+'/v1',id:'integration-model',reasoning:false};f.save();
  const result=await new ModelService(f.store).complete(f.config,'固定系统规则','真实协议测试',undefined,'stable-session',{purpose:'reply',source:'integration',accountId:'working',channel:'public',interactionId:'bad-json'});
  assert.throws(()=>parseDraft(result.text));
  // 未声明旧兼容字段的自定义 Chat Completions 使用 Pi 的 max_completion_tokens 默认。
  assert.equal(http.seen[0].body.max_completion_tokens,4096);assert.equal(http.seen[0].body.max_tokens,undefined);
  const row=f.ledger.get(result.callId!)!;assert.equal(row.status,'completed');assert.equal(row.interactionId,'bad-json');assert.equal(row.pricingStatus,'unpriced');assert.equal(row.cost,null);
  assert.deepEqual({input:row.usage!.input,output:row.usage!.output,cacheRead:row.usage!.cacheRead,cacheWrite:row.usage!.cacheWrite,totalTokens:row.usage!.totalTokens,reasoning:row.usage!.reasoning},{input:20,output:10,cacheRead:4,cacheWrite:6,totalTokens:40,reasoning:3});
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM usage').get() as any).n,0);
 }finally{await http.close();f.close();}
});

test('真实Anthropic流缺少结束原因时，已到达的缓存及输入用量继续落账',async()=>{
 const f=fixture(),http=await httpFixture(res=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const event={type:'message_start',message:{id:'partial-message',type:'message',role:'assistant',model:'integration-model',content:[],usage:{input_tokens:11,output_tokens:0,cache_read_input_tokens:5,cache_creation_input_tokens:3,cache_creation:{ephemeral_1h_input_tokens:1}}}};
  res.end('event: message_start\ndata: '+JSON.stringify(event)+'\n\n');
 });
 try{
  f.config.model={...f.config.model,provider:'custom',api:'anthropic-messages',baseUrl:http.base,id:'integration-model',reasoning:false};f.save();
  await assert.rejects(new ModelService(f.store).complete(f.config,'系统','请求',undefined,undefined,{purpose:'daily-state',source:'integration'}));
  const rows=f.ledger.calls().items;assert.equal(rows.length,1);assert.equal(rows[0].status,'failed');assert.equal(rows[0].usage!.input,11);assert.equal(rows[0].usage!.cacheRead,5);assert.equal(rows[0].usage!.cacheWrite,3);assert.equal(rows[0].usage!.cacheWrite1h,1);assert.equal(rows[0].usage!.totalTokens,19);assert.equal(rows[0].cost,null);assert.equal(rows[0].pricingStatus,'unpriced');
 }finally{await http.close();f.close();}
});

test('真实HTTP拒绝未返回用量时，流水标记未知而不是免费',async()=>{
 const f=fixture(),http=await httpFixture(res=>{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'拒绝测试'}}));});
 try{
  f.config.model={...f.config.model,provider:'custom',baseUrl:http.base+'/v1',id:'integration-model',reasoning:false};f.save();
  await assert.rejects(new ModelService(f.store).complete(f.config,'系统','请求'));
  const row=f.ledger.calls().items[0];assert.equal(row.status,'failed');assert.equal(row.usage,null);assert.equal(row.cost,null);assert.equal(row.pricingStatus,'unknown');assert.equal(f.ledger.totals().costUSD,null);
 }finally{await http.close();f.close();}
});

test('成功文本流未携带usage也显示未知，不能把Pi初始零值当免费',async()=>{
 const f=fixture(),http=await httpFixture(res=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const base={id:'no-usage',object:'chat.completion.chunk',created:1,model:'integration-model'};
  res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'MODEL_OK'},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');
 });
 try{
  f.config.model={...f.config.model,provider:'custom',baseUrl:http.base+'/v1',id:'integration-model',reasoning:false};f.save();
  const result=await new ModelService(f.store).complete(f.config,'系统','请求');assert.equal(result.text,'MODEL_OK');assert.equal(result.usage,null);assert.equal(result.pricingStatus,'unknown');
  const row=f.ledger.get(result.callId!)!;assert.equal(row.status,'completed');assert.equal(row.usage,null);assert.equal(row.cost,null);
 }finally{await http.close();f.close();}
});

test('原厂标签改到第三方HTTP地址，实际请求返回用量也不套原厂价',async()=>{
 const f=fixture(),http=await httpFixture(res=>completion(res,'MODEL_OK'));
 try{
  const m:Config['model']={...f.config.model,provider:'deepseek',source:'panel',baseUrl:http.base,id:'deepseek-flash',reasoning:false};
  const result=await new ModelService(f.store).request(m,'integration-key','系统','请求',{}, {purpose:'model-test',source:'integration'});
  assert.equal(http.seen.length,1);assert.equal(result.input,20);assert.equal(result.pricingStatus,'unpriced');assert.equal(result.cost,null);assert.equal(f.ledger.get(result.callId!)!.cost,null);
 }finally{await http.close();f.close();}
});

test('CLI status与账单使用同一旧新合计，显式历史用途筛选仍保留旧记录',async()=>{
 const f=fixture();try{
  f.save();f.store.usage(11,7,3);
  const id=f.ledger.start({provider:'custom',id:'test'},{purpose:'reply'});f.ledger.finish(id,'completed',{usage:{input:5,output:2,cacheRead:1,cacheWrite:0,totalTokens:8},pricingStatus:'unpriced'});
  const result=await execute(process.execPath,['--import','tsx',new URL('../src/cli.ts',import.meta.url).pathname,'status'],{env:process.env});
  assert.deepEqual(JSON.parse(result.stdout).stats.usage,billingTotals(f.store.db));
  assert.equal(f.ledger.totals({purpose:'legacy-unknown'}).legacyRows,1);assert.equal(f.ledger.calls({purpose:'legacy-unknown'}).items.length,1);
 }finally{f.close();}
});

test('CLI整理写入新记忆条目且拒绝未知工作账号，独立scope遗忘账本原样重放',async()=>{
 const f=fixture();let reply='';const http=await httpFixture(res=>completion(res,reply));
 try{
  f.config.model={...f.config.model,provider:'custom',baseUrl:http.base+'/v1',id:'integration-model',reasoning:false};f.save();
  await assert.rejects(execute(process.execPath,['--import','tsx',new URL('../src/cli.ts',import.meta.url).pathname,'summarize','visitor','public'],{env:process.env}),e=>String(e).includes('没有已确认的工作账号'));
  f.store.set('activeAccount','working');f.store.ingest(EVENT,'working');const row=f.store.getMessage(EVENT.id,'working');f.store.update(row.id,'draft',{draft:{action:'reply',text:'好的',reason:'测试'}});
  reply=JSON.stringify({items:[{type:'preference',text:'喜欢热茶',sourceIds:[row.id]}]});
  await execute(process.execPath,['--import','tsx',new URL('../src/cli.ts',import.meta.url).pathname,'summarize','visitor','public'],{env:process.env});
  assert.equal(f.ledger.calls({purpose:'memory-summary'}).items[0].source,'cli');
  const memory=new MemoryService(f.store,new ModelService(f.store));assert.equal(memory.items('visitor','public','working')[0].text,'喜欢热茶');
  f.store.forget('visitor','working');
  await execute(process.execPath,['--import','tsx',new URL('../src/cli.ts',import.meta.url).pathname,'apply-forget-ledger'],{env:process.env});
  assert.equal(f.store.forgotten('visitor','working'),true);assert.equal(memory.items('visitor','public','working').length,0);
  const fake=(f.store.db.prepare("SELECT id FROM users WHERE id LIKE 'scope:%'").all());assert.equal(fake.length,0);
 }finally{await http.close();f.close();}
});
