// 服务器隔离Camoufox：原生响应→可见DOM→采集→合并→工作轮次；不访问真实平台或模型。
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {observer} from '/opt/role-camoufox/launch.mjs';
import {collectReadyPublic} from '../dist/public-collection.js';
import {readTweets} from '../dist/browser.js';
import {Store} from '../dist/store.js';
import {Workflow} from '../dist/workflow.js';
import {Outbox} from '../dist/outbox.js';
import {ReplyTriage} from '../dist/reply-triage.js';

const OUT=process.env.ARTIFACT_DIR||'/artifacts';mkdirSync(OUT,{recursive:true});
const actor='fixture_worker',at=Date.now(),stamp=new Date(at).toISOString();
const item=(id,handle,parent=null,root=id)=>({id,handle,parent,root});
const own=item('700',actor),first=item('701','visitor','700','700'),last=item('702','visitor','700','700'),recommendation=item('799','other');
const registry=[own,first,last,recommendation];let scenario='valid',browser,context,page;
const report={checks:[],errors:[],externalRequests:[],realModelRequests:0,realPlatformRequests:0,productionMounts:false};
const html=rows=>'<html><body><main>'+rows.map(row=>'<article data-testid="tweet"><a href="/'+row.handle+'/status/'+row.id+'"><time datetime="'+stamp+'"></time></a><div data-testid="tweetText">普通合成正文 '+row.id+'</div></article>').join('')+'</main><script>fetch("/i/api/graphql/fixture/Thread")</script></body></html>';
const native=row=>({rest_id:row.id,legacy:{created_at:stamp,conversation_id_str:row.root,in_reply_to_status_id_str:row.parent,...(row.parent?{in_reply_to_screen_name:actor}:{})},core:{user_results:{result:{legacy:{screen_name:row.handle}}}}});
async function check(name,fn){try{await fn();report.checks.push(name);console.log('[通过] '+name);}catch(error){report.errors.push({name,error:error.stack});console.log('[失败] '+name+' '+error.message);}}
try{
 browser=await observer();context=await browser.newContext();page=await context.newPage();
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!=='https://x.com'){report.externalRequests.push(url.origin);await route.abort();return;}
  if(url.pathname==='/i/api/graphql/fixture/Thread'){await route.fulfill({status:200,json:{data:(scenario==='missing'?[]:registry).map(native)}});return;}
  await route.fulfill({status:200,contentType:'text/html',body:html(url.pathname==='/'+actor?[own]:[own,first,last,recommendation])});
 });
 const collect=()=>collectReadyPublic({page,source:2,handle:actor,deadline:Date.now()+8000,pageTimeoutMs:1800,readTweets,navigate:async(p,url)=>p.goto(url,{waitUntil:'domcontentloaded'})});
 await check('可信native元数据使同主帖评论共用线程，推荐被排除',async()=>{const result=await collect();assert.equal(result.diagnostics[0].status,'ok');assert.deepEqual(result.events.map(e=>[e.platformId,e.conversationId,e.targetId,e.conversationIdReliable]),[['701','700','701',true],['702','700','702',true]]);
  const folder=mkdtempSync(tmpdir()+'/x-dom-workflow-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=folder;const store=new Store(folder+'/workflow.sqlite'),sends=[];let calls=0,workflow;
  try{const generator={converse:async()=>{calls++;return {text:'',input:0,output:0,cache:0,toolCalls:[{type:'toolCall',id:'fixture-draft',name:'submit_draft',arguments:{action:'reply',text:'合成回复',reason:''}}]};}},transport={identity:async()=>({handle:actor,loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>result,context:async()=>'',lookup:async()=>({status:'unknown'}),send:async e=>{sends.push(e.platformId);return {status:'confirmed',id:'sent-'+e.platformId};}};
   workflow=new Workflow(store,transport,generator,()=>({mode:'auto',pollSeconds:60,maxAgeHours:6,maxPerRound:4,publicPerHour:10,privatePerHour:30,publicPerDay:180,privatePerDay:400,replyHours:{enabled:false,closeDelayMinutes:30},retentionDays:30,persona:'合成AI角色',model:{provider:'custom',api:'openai-completions',baseUrl:'',id:'fixture',reasoning:false,reasoningLevel:'low',vision:false}}));workflow.services={outbox:new Outbox(store),triage:new ReplyTriage(store)};store.set('control','running');await workflow.tick();assert.equal(calls,1);assert.deepEqual(sends,['702']);assert.equal(store.getMessage('x:701',actor).status,'merged');
  }finally{workflow?.stop();store.db.close();rmSync(folder,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}
 });
 await check('缺少native关系时同页文章全部不入队，诊断明确且无真实请求',async()=>{scenario='missing';const result=await collect();assert.deepEqual(result.events,[]);assert.ok(result.warnings.some(w=>w.includes('public-relation-unverified')));assert.notEqual(result.diagnostics[0].status,'ok');assert.deepEqual(report.externalRequests,[]);});
}finally{await context?.close();await browser?.close();writeFileSync(OUT+'/x-message-boundaries-dom.json',JSON.stringify({...report,passed:report.checks.length,failed:report.errors.length},null,2));if(report.errors.length)process.exitCode=1;}
