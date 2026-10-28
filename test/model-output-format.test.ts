import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelService,parseDraft,runCompletion,type CompletionOptions,type ResolvedCompletionModel} from '../src/model.js';
import {Store} from '../src/store.js';
import type {Config} from '../src/types.js';

// 只访问本机合成SSE服务，捕获真实Pi最终请求体；不读取生产配置或密钥。
async function fixture(options:{status?:number;text?:string;finish?:string}={}){
 const requests:any[]=[],server=createServer((req,res)=>{
  let data='';req.setEncoding('utf8');req.on('data',chunk=>{data+=chunk;});req.on('end',()=>{
   const body=JSON.parse(data);requests.push(body);
   if(options.status){res.writeHead(options.status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture: response_format unsupported'}}));return;}
   const chunk={id:'json-format-fixture',object:'chat.completion.chunk',created:1,model:'json-format-fixture'};
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',content:options.text??'{"action":"reply","text":"合成回复","reason":"合成校验"}'},finish_reason:null}]})+'\n\n');
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:options.finish??'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\n');res.end('data: [DONE]\n\n');
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const model:Config['model']={provider:'custom',api:'openai-completions',baseUrl:'http://127.0.0.1:'+(server.address() as any).port+'/v1',id:'json-format-fixture',reasoning:false,reasoningLevel:'off',vision:false,maxTokens:128,timeoutMs:5000};
 return {model,requests,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

test('明确JSON对象意图通过真实Pi发出response_format并保留原消息与输出上限',async()=>{
 const f=await fixture();try{
  const result=await runCompletion(f.model,'fixture-key-only','只返回JSON对象，保留原系统规则。','合成输入',{jsonObject:true});
  assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].response_format,{type:'json_object'});
  assert.ok(f.requests[0].messages.some((message:any)=>String(message.content).includes('保留原系统规则')));
  assert.ok(f.requests[0].max_tokens===128||f.requests[0].max_completion_tokens===128);
  assert.equal(parseDraft(result.text).text,'合成回复');assert.equal(result.stopReason,'stop');
 }finally{await f.close();}
});

test('普通文本及显式false不注入JSON格式参数，MODEL_OK仍是纯文本',async()=>{
 const f=await fixture({text:'MODEL_OK'});try{
  for(const options of [{},{jsonObject:false}]){
   const result=await runCompletion(f.model,'fixture-key-only','只返回MODEL_OK','合成连接测试',options);
   assert.equal(result.text,'MODEL_OK');assert.equal(Object.hasOwn(f.requests.at(-1),'response_format'),false);
  }
  assert.equal(f.requests.length,2);
 }finally{await f.close();}
});

test('Chat端点拒绝response_format时只请求一次且落失败账，不降级为普通请求',async()=>{
 const f=await fixture({status:400}),directory=mkdtempSync(join(tmpdir(),'role-json-format-')),store=new Store(join(directory,'workflow.sqlite'));
 try{
  const service=new ModelService(store),result=await service.request(f.model,'fixture-key-only','只返回JSON对象','合成输入',{jsonObject:true},{purpose:'persona-preview'});
  assert.equal(result.stopReason,'error');assert.match(result.errorMessage??'',/response_format unsupported/);
  assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].response_format,{type:'json_object'});
  const rows=service.ledger!.calls().items;assert.equal(rows.length,1);assert.equal(rows[0].status,'failed');
 }finally{store.db.close();rmSync(directory,{recursive:true,force:true});await f.close();}
});

test('显式执行hint优先于options并保留false，未指定时不自动启用',async()=>{
 const seen:CompletionOptions[]=[],service=new ModelService(undefined,async(_model,_key,_system,_user,options={})=>{
  seen.push(options);return {text:'MODEL_OK',input:1,output:1,cache:0,stopReason:'stop',latencyMs:1};
 });
 const model:Config['model']={provider:'custom',api:'openai-completions',baseUrl:'https://fixture.invalid/v1',id:'fixture',reasoning:false,reasoningLevel:'off',vision:false,maxTokens:64,timeoutMs:1000};
 await service.request(model,'fixture-key-only','系统','合成输入',{jsonObject:false},{jsonObject:true});
 await service.request(model,'fixture-key-only','系统','合成输入',{jsonObject:true},{jsonObject:false});
 await service.request(model,'fixture-key-only','系统','合成输入',{jsonObject:true});
 await service.request(model,'fixture-key-only','系统','合成输入');
 assert.deepEqual(seen.map(options=>options.jsonObject),[true,false,true,undefined]);
});

test('其他协议不带Chat格式字段，所有请求显式关闭供应商自动重试',async()=>{
 const captured:any[]=[],model:any={id:'fixture',name:'fixture',api:'anthropic-messages',provider:'custom',baseUrl:'https://fixture.invalid',cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024,reasoning:false,input:['text']};
 const resolved={model,pricingKnown:false,models:{completeSimple:async(_model:any,_context:any,options:any)=>{
  captured.push(options);return {content:[{type:'text',text:'MODEL_OK'}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',model:'fixture'};
 }}} as unknown as ResolvedCompletionModel;
 const config:Config['model']={provider:'custom',api:'anthropic-messages',baseUrl:'https://fixture.invalid',id:'fixture',reasoning:false,reasoningLevel:'off',vision:false,maxTokens:64,timeoutMs:1000};
 await runCompletion(config,'fixture-key-only','系统','合成输入',{jsonObject:true,resolvedModel:resolved});
 assert.equal(captured[0].onPayload,undefined);assert.equal(captured[0].maxRetries,0);
 model.api='openai-completions';await runCompletion({...config,api:'openai-completions'},'fixture-key-only','系统','合成输入',{jsonObject:true,resolvedModel:resolved});
 assert.equal(captured[1].maxRetries,0);const original={messages:[{role:'user',content:'合成'}],stream:true,max_tokens:64};
 assert.deepEqual(captured[1].onPayload(original),{...original,response_format:{type:'json_object'}});assert.equal(Object.hasOwn(original,'response_format'),false);
 assert.throws(()=>captured[1].onPayload(null),/请求结构/);
});

test('JSON格式约束不替代原有完整响应与正文安全校验',async()=>{
 assert.throws(()=>parseDraft('直接返回台词'),SyntaxError);
 assert.throws(()=>parseDraft('{"action":"reply","text":"合成",}'),SyntaxError);
 assert.throws(()=>parseDraft('{"action":"reply","text":"合成"}'),/结构校验/);
 for(const text of ['https://fixture.invalid','@fixture_user'])assert.throws(()=>parseDraft(JSON.stringify({action:'reply',text,reason:'合成'})),/禁用链接及账号提及/);
 const f=await fixture({text:'',finish:'length'});try{
  const result=await runCompletion(f.model,'fixture-key-only','只返回JSON对象','合成输入',{jsonObject:true});
  assert.equal(result.stopReason,'length');assert.equal(result.text,'');assert.throws(()=>parseDraft(result.text),SyntaxError);assert.equal(f.requests.length,1);
 }finally{await f.close();}
});
