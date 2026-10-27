import Fastify from 'fastify';
import { type BrowserContext, type Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher.js';
import { readFileSync,writeFileSync,renameSync,mkdirSync } from 'node:fs';
import { createHash,timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSecret,redact } from './config.js';
import type { Event,Identity,Receipt } from './types.js';
const exec=promisify(execFile);
export function browserProxy(value?:string):{server:string}|undefined {
 if(!value?.trim())return undefined;
 try{
  const u=new URL(value);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error();
  return {server:u.origin};
 }catch{throw new Error('浏览器代理地址无效；请使用不含凭据的代理入口');}
}
export class Serial {
 private tail:Promise<unknown>=Promise.resolve();
 run<T>(fn:()=>Promise<T>):Promise<T>{const p=this.tail.then(fn,fn);this.tail=p.catch(()=>{});return p;}
}
function hash(s:string){return createHash('sha256').update(s).digest('hex').slice(0,24);}
export function safeEvent(e:Event){const u=new URL(e.url);if(u.origin!=='https://x.com'||!/^\/(?:[a-zA-Z0-9_]+\/status\/\d+|messages\/[\d-]+|i\/chat\/[a-zA-Z0-9_-]+)$/.test(u.pathname))throw new Error('消息地址不在允许范围');if(!['public','private'].includes(e.channel)||!e.id||!e.userId||e.text.length>30000)throw new Error('消息格式无效');}
async function identity(page:Page):Promise<Identity>{
 const result=await page.evaluate(()=>{
  const a=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') as HTMLAnchorElement|null;
  const handle=a?.getAttribute('href')?.split('/').filter(Boolean)[0]||'';
  const text=document.body.innerText;
  const needsHuman=/verify (your|you are)|unusual activity|authenticate your|enter (your )?passcode|unlock your|验证你的身份|输入.*密码锁|解锁.*聊天/i.test(text)||/challenge|account\/access/.test(location.pathname);
  return {handle,loggedIn:!!handle,needsHuman,reason:needsHuman?'页面需要人工验证或解锁':!handle?'尚未登录或页面结构需要适配':undefined};
 });return result;
}
export async function readTweets(page:Page):Promise<Event[]> {
 const rows=await page.locator('article[data-testid="tweet"]').evaluateAll(articles=>articles.map(a=>{
  const time=a.querySelector('time');
  const link=time?.closest('a') as HTMLAnchorElement|null;
  const match=link?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
  if(!match)return null;
  const text=(a.querySelector('[data-testid="tweetText"]') as HTMLElement|null)?.innerText||'';
  return {id:'x:'+match[2],channel:'public' as const,userId:'x:'+match[1].toLowerCase(),handle:match[1],text,url:'https://x.com/'+match[1]+'/status/'+match[2],conversationId:match[2],timestamp:Date.parse(time?.getAttribute('datetime')||'')||Date.now(),mediaUnavailable:!!a.querySelector('[data-testid="tweetPhoto"],video')};
 }).filter(Boolean));
 return rows as Event[];
}
export async function readDM(page:Page,conversationId:string):Promise<{events:Event[];all:any[]}> {
 const all=await page.evaluate(()=>{
  const nodes=Array.from(document.querySelectorAll('[data-testid="messageEntry"]'));
  const main=document.querySelector('[data-testid="DmActivityViewport"],main')||document.body;
  const pane=main.getBoundingClientRect();
  return nodes.slice(-20).map(n=>{
   const content=n.querySelector('[data-testid="messageEntryContent"],[data-testid="message-text"]') as HTMLElement|null;
   if(!content)return null;
   const box=content.getBoundingClientRect();
   const explicit=n.getAttribute('data-direction');
   const direction=explicit||(box.right<pane.left+pane.width*.68?'in':box.left>pane.left+pane.width*.40?'out':'unknown');
   const time=n.querySelector('time')?.getAttribute('datetime');
   const id=n.getAttribute('data-message-id')||n.id;
   return {id,text:content.innerText,direction,timestamp:time?Date.parse(time):null,media:!!n.querySelector('img:not([data-testid*="Avatar"]),video')};
  }).filter(Boolean);
 });
 const incoming=(all as any[]).filter(x=>x.direction==='in');
 const latest=(all as any[]).at(-1);
 // 仅处理最后一条明确为入站的消息，防止重复响应自己的发言。
 const events:Event[]=[];
 if(latest&&latest.direction==='in'){
  const stamp=latest.timestamp||0;
  const id=latest.id||hash(conversationId+'|'+latest.text+'|'+stamp);
  events.push({id:'dm:'+conversationId+':'+id,channel:'private',userId:'dm:'+conversationId,handle:'',text:latest.text,url:page.url().split('?')[0],conversationId,timestamp:latest.timestamp||Date.now(),timestampReliable:!!latest.timestamp,mediaUnavailable:latest.media});
 }
 if(!incoming.length&&all.length)throw new Error('私信方向或新版聊天结构尚未确认，已跳过');
 return {events,all};
}
export async function startBrowserServer(){
 const secret=readSecret('browser_key');if(!secret)throw new Error('缺少浏览器内部凭据');
 const profile=process.env.PROFILE_DIR||'/profile';mkdirSync(profile,{recursive:true});
 let shuttingDown=false;
 let mode='paused';const serial=new Serial();let round=0;let context:BrowserContext;
 const journalPath=profile+'/transport-journal.json';let journal:Record<string,Receipt>={};
 try{journal=JSON.parse(readFileSync(journalPath,'utf8'));}catch{}
 function saveJournal(){const entries=Object.entries(journal).slice(-2000);journal=Object.fromEntries(entries);writeFileSync(journalPath+'.tmp',JSON.stringify(journal),{mode:0o600});renameSync(journalPath+'.tmp',journalPath);}
 const proxy=browserProxy(process.env.BROWSER_PROXY_SERVER);
 context=await launchBrowser(profile,proxy);
 context.on('close',()=>{if(shuttingDown)return;console.error('浏览器上下文关闭，交由监督器恢复');process.exit(1);});
 let publicPage=context.pages()[0]||await context.newPage();
 await publicPage.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
 let dmPage:Page|undefined;
 async function check(handle:string){const i=await identity(publicPage);if(!i.loggedIn||i.needsHuman||i.handle.toLowerCase()!==handle.toLowerCase())throw new Error('账号未登录、身份不符或需要人工验证');}
 async function navigate(p:Page,url:string){await p.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await p.locator('main').waitFor({timeout:12000}).catch(()=>{});}
 async function getDM(){if(!dmPage||dmPage.isClosed())dmPage=await context.newPage();return dmPage;}
 async function eventContext(e:Event){
  safeEvent(e);
  if(e.channel==='public'){await navigate(publicPage,e.url);return JSON.stringify((await readTweets(publicPage)).slice(0,12));}
  const p=await getDM();await navigate(p,e.url);return JSON.stringify((await readDM(p,e.conversationId)).all);
 }
 async function lookup(e:Event,text:string):Promise<Receipt>{
  safeEvent(e);
  if(e.channel==='public'){
   await navigate(publicPage,e.url);const rows=await readTweets(publicPage);
   const mine=(await identity(publicPage)).handle.toLowerCase();
   const candidates=rows.filter(x=>x.handle.toLowerCase()===mine&&x.text.trim()===text.trim()&&x.id!==e.id&&x.timestamp>=e.timestamp);
   if(candidates.length===1)return {status:'confirmed',id:candidates[0].id,url:candidates[0].url};
  }else{
   const p=await getDM();await navigate(p,e.url);const {all}=await readDM(p,e.conversationId);
   const candidates=all.filter(x=>x.direction==='out'&&x.text?.trim()===text.trim()&&x.id);
   if(candidates.length===1)return {status:'confirmed',id:String(candidates[0].id)};
  }
  return {status:'unknown',reason:'尚无唯一的平台消息回执，保持待回查'};
 }
 const app=Fastify({logger:false,bodyLimit:262144});
 app.addHook('onRequest',async(req,reply)=>{
  const value=String(req.headers['x-browser-key']||'');const a=Buffer.from(value),b=Buffer.from(secret);
  if(a.length!==b.length||!timingSafeEqual(a,b))return reply.code(401).send({error:'未授权'});
 });
 app.get('/health',async()=>({ready:!!context&&context.pages().length>0,mode,engine:'camoufox',version:context.browser()?.version()}));
 app.get('/identity',async()=>{if(publicPage.isClosed()){const replacement=context.pages().find(p=>p.url().startsWith('https://x.com/'));if(replacement)publicPage=replacement;else return {handle:'',loggedIn:false,needsHuman:true,reason:'请人工打开 X 页面'};}return identity(publicPage);});
 app.post('/control',async(req,reply)=>{
  const next=(req.body as any)?.mode;if(!['manual','paused','auto'].includes(next))return reply.code(400).send({error:'控制模式无效'});
  return serial.run(async()=>{
   if(mode==='manual'&&next!=='manual')await exec('x11vnc',['-display',process.env.DISPLAY||':99','-R','disconnect:all'],{timeout:5000});
   mode=next;return {mode};
  });
 });
 async function task(req:any,reply:any,fn:()=>Promise<unknown>){
  return serial.run(async()=>{
   if(mode!=='auto')return reply.code(409).send({error:'浏览器已暂停或正在人工接管'});
   try{await check(req.body.handle);return await fn();}catch(err){return reply.code(409).send({error:redact(err)});}
  });
 }
 app.post('/collect',async(req,reply)=>task(req,reply,async()=>{
  const {handle}=req.body as any;const events:Event[]=[],warnings:string[]=[];
  const source=round++%3;
  const url=source===0?'https://x.com/notifications/mentions':source===1?'https://x.com/search?q='+encodeURIComponent('@'+handle)+'&f=live':'https://x.com/'+handle;
  await navigate(publicPage,url);
  await publicPage.locator('article[data-testid="tweet"]').first().waitFor({timeout:10000}).catch(()=>{});
  if(source===2){
   const own=(await readTweets(publicPage)).filter(e=>e.handle.toLowerCase()===handle.toLowerCase()).slice(0,2);
   for(const post of own){await navigate(publicPage,post.url);events.push(...(await readTweets(publicPage)).filter(e=>e.handle.toLowerCase()!==handle.toLowerCase()));}
  }else events.push(...(await readTweets(publicPage)).filter(e=>e.handle.toLowerCase()!==handle.toLowerCase()));
  try{
   const p=await getDM();await navigate(p,'https://x.com/messages');
   const links=await p.locator('a[href^="/messages/"],a[href^="/i/chat/"]').evaluateAll(as=>as.map(a=>a.getAttribute('href')||'').filter(h=>/^\/(messages\/[\d-]+|i\/chat\/[a-zA-Z0-9_-]+)$/.test(h)).slice(0,3));
   if(!links.length)warnings.push('私信列表暂无可识别会话；新版 Chat 或加密会话需人工确认');
   for(const link of [...new Set(links)]){await navigate(p,'https://x.com'+link);const conversationId=link.split('/').at(-1)!;events.push(...(await readDM(p,conversationId)).events);}
  }catch(err){warnings.push('私信采集：'+redact(err));}
  return {events,warnings};
 }));
 app.post('/context',async(req,reply)=>task(req,reply,async()=>({text:await eventContext((req.body as any).event)})));
 app.post('/lookup',async(req,reply)=>task(req,reply,async()=>{const {event,text}=req.body as any;const r=await lookup(event,text);if(r.status==='confirmed'){journal[event.id]=r;saveJournal();}return r;}));
 app.post('/send',async(req,reply)=>task(req,reply,async()=>{
  const {event:e,text,requestId}=req.body as {event:Event;text:string;requestId:string};
  safeEvent(e);if(typeof text!=='string'||!text.trim()||text.length>4000||requestId!==e.id)throw new Error('发送参数无效');
  if(journal[requestId])return journal[requestId];
  await eventContext(e);let p=publicPage;
  if(e.channel==='public'){
   const id=e.id.replace(/^x:/,'');
   const article=p.locator('article[data-testid="tweet"]').filter({has:p.locator('a[href*="/status/'+id+'"] time')});
   if(await article.count()!==1)throw new Error('无法唯一定位要回复的帖子');
   await article.getByTestId('reply').click();
   const dialog=p.getByRole('dialog');await dialog.getByTestId('tweetTextarea_0').fill(text);
   journal[requestId]={status:'unknown',reason:'已准备提交，尚未取得平台回执'};saveJournal();
   await dialog.getByTestId('tweetButton').click({timeout:15000});
  }else{
   p=await getDM();const snap=await readDM(p,e.conversationId);
   if(snap.events.at(-1)?.id!==e.id)throw new Error('私信上下文已变化，停止发送');
   const input=p.locator('[data-testid="dmComposerTextInput"]');if(await input.count()!==1)throw new Error('当前私信输入框尚未适配');
   await input.fill(text);
   journal[requestId]={status:'unknown',reason:'已准备提交，尚未取得平台回执'};saveJournal();
   await p.locator('[data-testid="dmComposerSendButton"]').click({timeout:15000});
  }
  await p.waitForTimeout(1500);
  const toast=await p.locator('[data-testid="toast"]').allTextContents();
  if(toast.some(x=>/limit|automated|unable|failed|try again|上限|自动|失败|稍后/i.test(x))){
   const r:Receipt={status:'rejected',reason:toast.join(' ').slice(0,300)};journal[requestId]=r;saveJournal();return r;
  }
  const r=await lookup(e,text);journal[requestId]=r;saveJournal();return r;
 }));
 app.setErrorHandler((err,req,reply)=>reply.code(500).send({error:redact(err instanceof Error?err.message:err)}));
 await app.listen({port:Number(process.env.BROWSER_PORT||3001),host:'0.0.0.0'});
 process.on('SIGTERM',async()=>{shuttingDown=true;await app.close();await context.close();process.exit(0);});
 return {app,context};
}
if(process.argv[1]?.endsWith('/browser.js'))startBrowserServer().catch(e=>{console.error(redact(e));process.exit(1);});
