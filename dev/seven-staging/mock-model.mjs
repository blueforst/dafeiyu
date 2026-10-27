import http from 'node:http';
http.createServer((req,res)=>{
 if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'staging-model'}]}));return;}
 let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  let input={};try{input=JSON.parse(body);}catch{}
  const system=JSON.stringify(input.messages?.filter(x=>x.role==='system')??[]),user=JSON.stringify(input.messages?.filter(x=>x.role==='user')??[]);
  let text='MODEL_OK';
  if(system.includes('matches'))text=JSON.stringify({matches:[]});
  else if(system.includes('periods')||system.includes('三餐')){const date=new Date(Date.now()+8*3600000).toISOString().slice(0,10);text=JSON.stringify({date,fictional:true,periods:[{start:'08:00',end:'09:00',activity:'虚构设定：阅读'}],meals:{breakfast:'面包',lunch:'米饭',dinner:'蔬菜'},activities:['阅读'],mood:'平静'});}
  else if(system.includes('sourceIds'))text=JSON.stringify({items:[]});
  else if(system.includes('action'))text=JSON.stringify({action:'reply',text:'这是隔离试聊回复。',reason:'模拟生成'});
  res.writeHead(200,{'content-type':'text/event-stream'});
  const chunk={id:'staging',object:'chat.completion.chunk',created:1,model:'staging-model',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]};
  res.write('data: '+JSON.stringify(chunk)+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\n');res.end('data: [DONE]\n\n');
 });
}).listen(8080,'0.0.0.0');
