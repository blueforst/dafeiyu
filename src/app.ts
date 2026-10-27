import Fastify from 'fastify';
import proxy from '@fastify/http-proxy';
import staticFiles from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Store } from './store.js';
import { PiGenerator,modelKey } from './model.js';
import { registerModelRoutes } from './model-routes.js';
import { BrowserTransport } from './transport.js';
import { Workflow } from './workflow.js';
import { loadConfig,readSecret,redact } from './config.js';
export async function startApp(){
 const app=Fastify({logger:false,bodyLimit:16384});const data=process.env.DATA_DIR||'/data';mkdirSync(data,{recursive:true});
 const store=new Store(data+'/workflow.sqlite');store.boot();
 const ingress=readSecret('ingress_key');if(!ingress)throw new Error('缺少入口凭据');
 const transport=new BrowserTransport(process.env.BROWSER_ENDPOINT||'http://browser:3001',readSecret('browser_key'));
 const workflow=new Workflow(store,transport,new PiGenerator());
 app.addHook('onRequest',async(req,reply)=>{
  if(req.url==='/healthz')return;
  const supplied=Buffer.from(String(req.headers['x-ingress-key']||'')),expected=Buffer.from(ingress);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply.code(401).send({error:'未授权'});
  if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers['x-workflow-control']!=='1')return reply.code(403).send({error:'缺少控制请求标记'});
  delete req.headers['x-ingress-key'];
  delete req.headers.authorization;
  if(req.headers.origin&&req.headers.origin!=='https://'+req.headers.host)return reply.code(403).send({error:'来源不符'});
 });
 app.get('/healthz',async()=>({ok:true}));
 app.get('/api/status',async()=>{
  let config:any;let configError='';try{const c=loadConfig();config={expectedHandle:c.expectedHandle,mode:c.mode,model:{provider:c.model.provider,id:c.model.id,api:c.model.api,source:c.model.source,baseUrlHost:(()=>{try{return new URL(c.model.baseUrl).hostname;}catch{return '';}})(),configured:!!c.model.id&&!!c.model.baseUrl&&!!modelKey(c.model)},publicPerHour:c.publicPerHour,privatePerHour:c.privatePerHour};}catch(err){configError=redact(err);}
  let browser:any;try{browser=await transport.identity();}catch(err){browser={loggedIn:false,reason:redact(err)};}
  return {control:workflow.control(),busy:workflow.busy,config,configError,browser,lastTick:Number(store.get('lastTick','0')),cooldown:{public:Number(store.get('cooldown:public','0')),private:Number(store.get('cooldown:private','0'))},stats:store.stats(),observationStartedAt:store.get('observationStartedAt'),now:Date.now()};
 });
 app.get('/api/logs',async()=>store.logs());
 app.get('/api/events',async(req,reply)=>{
  reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
  const send=()=>reply.raw.write('event: logs\ndata: '+JSON.stringify(store.logs(30))+'\n\n');send();
  const interval=setInterval(()=>{send();reply.raw.write(': heartbeat\n\n');},5000);
  req.raw.on('close',()=>clearInterval(interval));
 });
 for(const action of ['pause','resume','takeover','release'] as const)app.post('/api/control/'+action,async(req,reply)=>{
  try{await workflow[action]();return {ok:true,control:workflow.control()};}catch(err){return reply.code(409).send({error:redact(err)});}
 });
 registerModelRoutes(app,{store,control:()=>workflow.control()});
 await app.register(proxy,{upstream:'http://browser:6080',prefix:'/desktop',rewritePrefix:'/',websocket:true,preHandler:async(req,reply)=>{if(workflow.control()!=='manual')return reply.code(423).send({error:'请先点击人工接管，再打开浏览器桌面'});}});
 await app.register(staticFiles,{root:new URL('../public',import.meta.url).pathname,prefix:'/',index:'index.html'});
 app.setErrorHandler((err,req,reply)=>{store.log('api-error',redact(err instanceof Error?err.message:err),'warn');reply.code(500).send({error:'请求失败，请查看日志'});});
 const readyLoop=async()=>{try{await transport.control('paused');workflow.start();}catch{setTimeout(readyLoop,3000);}};await readyLoop();
 const statusInterval=setInterval(()=>{store.set('heartbeat',String(Date.now()));},30000);
 app.addHook('onClose',async()=>{clearInterval(statusInterval);workflow.stop();await workflow.waitIdle().catch(()=>{});store.db.close();});
 process.on('SIGTERM',async()=>{await app.close();process.exit(0);});
 await app.listen({port:Number(process.env.PORT||8080),host:'0.0.0.0'});
 return {app,store,workflow};
}
if(process.argv[1]?.endsWith('/app.js'))startApp().catch(e=>{console.error(redact(e));process.exit(1);});
