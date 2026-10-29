import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createModelFetch,modelTarget,publicModelAddress,withModelEgress} from '../src/model-egress.js';
import {checkBaseUrl} from '../src/settings.js';
import {parseDraft} from '../src/model.js';
import {validatePostingText} from '../src/posting-policy.js';
import {qualityMetrics} from '../src/persona-replay.js';

test('模型出口拒绝私网保留地址、IPv6映射、非标准IPv4及URL附带字段',()=>{
 for(const ip of ['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','203.0.113.1','224.0.0.1','240.0.0.1','::','::1','::ffff:127.0.0.1','64:ff9b::7f00:1','fd00::1','fe80::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicModelAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicModelAddress(ip),true,ip);
 for(const url of ['http://2130706433','http://0x7f000001','http://0177.0.0.1','http://localhost.localdomain','http://host.internal','http://user:pass@example.com','https://example.com/v1?ignored=','https://example.com/v1#ignored'])assert.throws(()=>checkBaseUrl(url),url);
 assert.equal(checkBaseUrl('https://api.example.com/v1').pathname,'/v1');
});

test('解析含任意受限地址时在真实连接前拒绝，连接器每次解析不接受DNS变化',async()=>{
 let hits=0;const server=createServer((_req,res)=>{hits++;res.end('must not reach');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
 let lookups=0;const guarded=createModelFetch({resolve:async()=>{lookups++;return [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}];}});
 try{await assert.rejects(guarded.fetch('http://api.example.com:'+port),/fetch failed|受限/);await assert.rejects(guarded.fetch('http://api.example.com:'+port),/fetch failed|受限/);assert.ok(lookups>=2);assert.equal(hits,0);}finally{await guarded.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('显式内部目标与端口可用，默认跳转被拒绝且不访问第二个目标',async()=>{
 let first=0,redirected=0;const blocked=createServer((_req,res)=>{redirected++;res.end('never');});await new Promise<void>(resolve=>blocked.listen(0,'127.0.0.1',resolve));const blockedPort=(blocked.address() as any).port;
 const server=createServer((req,res)=>{first++;if(req.url==='/redirect'){res.writeHead(302,{location:'http://127.0.0.1:'+blockedPort+'/private'});res.end();}else{res.setHeader('content-type','application/json');res.end('{"data":[]}');}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address() as any).port,guarded=createModelFetch({allowedTargets:origin});
 try{assert.equal((await guarded.fetch(origin+'/models')).status,200);await assert.rejects(guarded.fetch(origin+'/redirect'));await assert.rejects(guarded.fetch('http://127.0.0.1:'+blockedPort));assert.equal(first,2);assert.equal(redirected,0);assert.throws(()=>createModelFetch({allowedTargets:'http://127.0.0.1'}));assert.throws(()=>modelTarget(origin+'?ignored=',{base:true,allowedOrigins:new Set([origin])}));}finally{await guarded.close();await Promise.all([server,blocked].map(s=>new Promise<void>(resolve=>s.close(()=>resolve()))));}
});

test('模型受控fetch支持SDK常用Request对象和流式响应',async()=>{
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: one\n\n');res.end('data: [DONE]\n\n');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address() as any).port,guarded=createModelFetch({allowedTargets:origin});
 try{const response=await guarded.fetch(new Request(origin+'/v1/chat/completions',{method:'POST',body:'{}'}));assert.match(await response.text(),/\[DONE\]/);}finally{await guarded.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('不支持自定义fetch的SDK仍受模型异步范围保护，普通内部RPC不受该策略影响',async()=>{
 let hits=0;const server=createServer((_req,res)=>{hits++;res.end('internal rpc');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as any).port;
 try{assert.equal(await (await fetch(url)).text(),'internal rpc');await assert.rejects(withModelEgress(()=>fetch(url)));assert.equal(hits,1);assert.equal(await (await fetch(url)).text(),'internal rpc');assert.equal(hits,2);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('裸域名短链接和国际化域名在解析、三种提交和回放指标中一致被识别',()=>{
 for(const text of ['example.com','t.co/example','https://example.com','www.example.com','xn--fsqu00a.xn--fiqs8s/path','例子.中国/路径','@alice']){
  assert.throws(()=>parseDraft(JSON.stringify({action:'reply',text,reason:''}),{channel:'public'}),text);
  for(const kind of ['reply','post','dm'] as const)assert.equal(validatePostingText(text,kind).code,'forbidden-content',text+kind);
  const metrics=qualityMetrics([{action:'reply',text,channel:'public'}]);assert.equal(metrics.forbiddenLinks+metrics.forbiddenMentions,1,text);
 }
 for(const text of ['普通的一句话。','版本 1.2.3，今天完成。'])assert.ok(validatePostingText(text,'reply').allowed,text);
});
