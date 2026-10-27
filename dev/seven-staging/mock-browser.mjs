// 仅隔离验收使用，无浏览器 profile，也不访问 X。
import http from 'node:http';
let mode='paused';
http.createServer((req,res)=>{
 let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  let input={};try{input=JSON.parse(body||'{}');}catch{}
  let value={ok:true};
  if(req.url==='/identity')value={loggedIn:true,needsHuman:false,handle:'staging_bot',userId:'isolated-staging',reason:'隔离模拟账号'};
  else if(req.url==='/control')mode=input.mode;
  else if(['/collect','/collect/public','/collect/private'].includes(req.url))value={events:[],warnings:[]};
  else if(req.url==='/context')value={text:'隔离模拟上下文'};
  else if(['/send','/post','/lookup','/lookup-post'].includes(req.url))value={status:'unknown',reason:'隔离环境不访问平台'};
  else if(req.url==='/health')value={ready:true,mode};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
 });
}).listen(3001,'0.0.0.0');
