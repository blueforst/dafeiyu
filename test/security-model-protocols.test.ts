import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {runCompletion} from '../src/model.js';
import {listModels} from '../src/model-catalog.js';
import {exampleConfig} from './config-fixture.js';
import {allowTestModelServer} from './model-network-fixture.js';

// 通过真实Pi及各SDK访问合成服务；第二个端口未获允许，不能接收模型请求或凭据。
for(const api of ['openai-completions','openai-responses','anthropic-messages','google-generative-ai'] as const){
 test(api+'实际SDK禁止重定向，而普通内部fetch保持原有行为',async()=>{
  let first=0,redirected=0;
  const blocked=createServer((request,response)=>{redirected++;request.resume();response.writeHead(500,{'content-type':'application/json'});response.end('{"error":{"message":"未授权的合成目标不应收到模型请求"}}');});
  await new Promise<void>(resolve=>blocked.listen(0,'127.0.0.1',resolve));
  const target='http://127.0.0.1:'+(blocked.address() as any).port;
  const server=createServer((request,response)=>{first++;request.resume();response.writeHead(307,{location:target+'/private'});response.end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));allowTestModelServer(server);
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  try{
   const builtin=api==='google-generative-ai'?(await listModels('google')).find(item=>item.api===api):undefined;
   if(api==='google-generative-ai')assert.ok(builtin,'须使用已注册的Google适配器');
   const model={...exampleConfig.model,provider:builtin?'google':'custom',source:'panel' as const,api,baseUrl:origin,id:builtin?.id||'fixture',reasoning:false,reasoningLevel:'off' as const,vision:false};
   await runCompletion(model,'fixture-egress-key-only','合成系统','合成消息',{signal:AbortSignal.timeout(3000)}).catch(()=>{});
   assert.ok(first>0,'须经过实际SDK的HTTP请求，不能以配置失败代替出口验证');
   assert.equal(redirected,0,'模型请求不得访问未允许的第二个目标');
   const ordinary=await fetch(origin+'/ordinary',{method:'POST',body:'{}',signal:AbortSignal.timeout(3000)});
   assert.equal(ordinary.status,500);assert.equal(redirected,1,'普通内部调用仍能跳转，合成目标和异步范围均有效');
  }finally{
   server.closeAllConnections();blocked.closeAllConnections();
   await Promise.all([server,blocked].map(item=>new Promise<void>(resolve=>item.close(()=>resolve()))));
  }
 });
}
