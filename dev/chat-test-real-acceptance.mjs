// 服务器专用真实试聊验收。默认仅列计划；--execute 才读取临时凭据并请求指定模型。
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {MemoryService} from '../dist/memory.js';
import {PersonaService} from '../dist/persona.js';
import {Outbox} from '../dist/outbox.js';
import {ModelService,runCompletion,freezeCompletionModel,requestMaxTokens} from '../dist/model.js';
import {ChatTestService} from '../dist/chat-test.js';
import {registerChatTestRoutes} from '../dist/chat-test-routes.js';
import {registerPersonaLibraryRoutes} from '../dist/persona-library-routes.js';
import {redact} from '../dist/config.js';
import {BudgetGate} from './real-chat-budget.mjs';

const followup=process.argv.includes('--followup-presets'),prefix=followup?'followup-':'';
const plan=JSON.parse(readFileSync(new URL('./chat-test-real-cases.json',import.meta.url),'utf8'));
if(followup)plan.cases=plan.cases.filter(c=>['P-claude','P-kimi','P-glm'].includes(c.id));
if(!process.argv.includes('--execute')){console.log(JSON.stringify({mode:'plan',operations:plan.cases.length,users:Object.keys(plan.users),model:'opencode-go/deepseek-v4.1-flash',limitUsd:2,maxModelRequests:24,productionDeployment:false},null,2));process.exit(0);}
if(process.env.ALLOW_REAL_CHAT_USD!=='2')throw Error('执行需要显式 ALLOW_REAL_CHAT_USD=2，仅限本轮授权服务器环境');
const ROOT=process.env.REAL_CHAT_ROOT||'/trial',OUT=join(ROOT,'evidence'),DATA=join(ROOT,'runtime'),budgetPath=join(ROOT,'budget.json');
mkdirSync(OUT,{recursive:true,mode:0o700});
if(existsSync(join(OUT,prefix+'results.json')))throw Error('本批已有结果，禁止自动重复付费验收');
const selection=JSON.parse(readFileSync(join(DATA,'model-selection.json'),'utf8'));
if(selection.provider!=='opencode-go'||selection.id!=='deepseek-v4.1-flash'||selection.baseUrl!=='https://opencode.ai/inference/go/v1'||selection.reasoningLevel!=='low'||selection.maxTokens!==4096)throw Error('模型或参数与已批准快照不一致');
const key=readFileSync(join(ROOT,'secrets/model_api_key'),'utf8').trim();if(!key)throw Error('临时模型凭据缺失');
const save=(path,data)=>{const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});renameSync(tmp,path);chmodSync(path,0o600);};
const safe=e=>redact(String(e?.message??e)).split(key).join('[已隐藏]');
const config=JSON.parse(readFileSync('/app/config.example.json','utf8'));
config.mode='auto';config.model={...selection,source:'panel',api:'',reasoning:true,vision:false};config.memoryPolicy={recentCount:3,recentDays:7,retentionDays:30};
process.env.DATA_DIR=DATA;mkdirSync(join(DATA,'panel'),{recursive:true,mode:0o700});
save(join(DATA,'panel/model-keys.json'),{'opencode-go@opencode.ai':key});
const frozen=await freezeCompletionModel(config.model);
if(!frozen.pricingKnown||frozen.model.id!==selection.id||frozen.model.provider!==selection.provider||frozen.model.baseUrl!==selection.baseUrl||frozen.model.contextWindow!==1000000)throw Error('冻结目录模型或计价无法确认');
const gate=new BudgetGate({path:budgetPath,limitUsd:2,maxRequests:24,inputTokenCeiling:frozen.model.contextWindow,inputRatePerMillion:.30,outputRatePerMillion:1.20});
const nativeFetch=globalThis.fetch,network=[];
globalThis.fetch=async(input,options)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(url.origin!=='https://opencode.ai'||url.pathname!=='/inference/go/v1/chat/completions')throw Error('验收禁止向其他模型或平台请求');network.push({origin:url.origin,path:url.pathname,at:Date.now()});return nativeFetch(input,options);};
const store=new Store(join(DATA,'workflow.sqlite'));new Outbox(store);store.set('activeAccount','trial_runner');store.set('control','manual');
let currentCase='setup',chat,app,base;const rawCalls=[],results=[];
const modelService=new ModelService(store,(m,k,system,user,opts)=>runCompletion(m,k,system,user,{...opts,resolvedModel:frozen}));
const generator={async complete(c,system,user,signal,sessionId,metadata={}){
 if(JSON.stringify(c.model)!==JSON.stringify(config.model))throw Error('请求模型参数漂移，停止');
 const maxOutputTokens=requestMaxTokens(metadata.maxTokens??c.model.maxTokens,frozen.model,metadata.reasoning??(c.model.reasoning?c.model.reasoningLevel:'off'));
 const ticket=gate.reserve({maxOutputTokens,inputBytes:Buffer.byteLength(system)+Buffer.byteLength(user),label:currentCase,interactionId:metadata.interactionId});
 const trace={caseId:currentCase,ticketId:ticket.id,system,user,sessionId,metadata,maxOutputTokens,startedAt:Date.now()};rawCalls.push(trace);save(join(OUT,prefix+'model-trace.json'),rawCalls);
 try{
  const result=await modelService.complete(c,system,user,signal,sessionId,metadata);trace.result=result;
  gate.settle(ticket,{callId:result.callId,usage:result.usage,cost:result.cost,pricingStatus:result.pricingStatus,actualModel:result.actualModel,expectedModel:selection.id});
  if(gate.snapshot().halted)throw Error('预算门控已停止后续调用');return result;
 }catch(error){
  trace.error=safe(error);
  // 超时、断流或未知计费按整笔预留保留；不会因业务失败假定免费或重发。
  if(!trace.result)gate.fail(ticket,{reason:trace.error,callId:error?.callId});
  throw error;
 }finally{trace.finishedAt=Date.now();save(join(OUT,prefix+'model-trace.json'),rawCalls);}
}};
new MemoryService(store,generator,()=>config);const persona=new PersonaService(store,generator,()=>config);
chat=new ChatTestService({dataDir:DATA,store,generator,persona,config:()=>config});
app=Fastify({logger:false});registerChatTestRoutes(app,{service:chat});registerPersonaLibraryRoutes(app,{store,persona});
const users={},personas={},byCase=new Map();
const allCalls=()=>store.db.prepare('SELECT * FROM llm_calls ORDER BY started_at,id').all();
async function api(path,body,method=body===undefined?'GET':'POST'){
 const response=await nativeFetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(370000)});const data=await response.json();if(!response.ok)throw Error('隔离接口 '+path+' HTTP '+response.status+' '+JSON.stringify(data));return data;
}
const businessSnapshot=()=>Object.fromEntries(['messages','users','outbox','memory_items','memory_progress','role_experiences','triage_ignores'].map(table=>{try{return [table,createHash('sha256').update(JSON.stringify(store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all())).digest('hex')];}catch{return [table,null];}}));
let businessBefore,startingCalls=0;
function verify(c,response,memory,turns,calls){
 const e=c.expect,t=response.turn,checks=[],observations=[];const check=(name,passed)=>checks.push({name,passed:!!passed});
 const prerequisites=!e.requiresHarassmentSkips||e.requiresHarassmentSkips.every(id=>{const r=byCase.get(id)?.response?.turn?.result?.draft;return r?.action==='skip'&&r?.category==='harassment';});
 if(prerequisites){check('实际模型调用次数',calls.length>=e.minCalls&&calls.length<=e.maxCalls);}else observations.push('未出现三个真实骚扰skip；冷却分支未触发，本操作仍按实际调用计费');
 if(e.turnStatus)check('轮次状态',t?.status===e.turnStatus);
 if(e.draftAction){if(e.observationOnly)observations.push('实际动作 '+t?.result?.draft?.action+' / '+(t?.result?.draft?.category??''));else check('回复动作',t?.result?.draft?.action===e.draftAction);}
 if(e.skipCategory&&e.observationOnly&&t?.result?.draft?.action==='skip')observations.push('实际跳过类别 '+t.result.draft.category);
 if(e.validationAllowed)check('发送前长度与内容校验',t?.result?.validation?.allowed===true);
 if(e.resultStatus&&prerequisites)check('过滤或冷却状态',t?.result?.status===e.resultStatus);
 if(e.resultReasonContains)check('确定性过滤原因',String(t?.result?.reason).includes(e.resultReasonContains));
 if(c.action!=='inspect'&&(e.newUserMemoryEmpty||e.requireLongTermMemory||e.memoryContains?.length||e.memoryExcludes?.length))check('实际记忆诊断存在',t?.diagnostics?.memory&&Array.isArray(t.diagnostics.memory.memories)&&Array.isArray(t.diagnostics.memory.recent));
 if(t&&c.action!=='summarize'&&c.channel==='public')check('公开保留独立平台线程且不跨线程合并',t.diagnostics?.mergedCount===0&&t.messages.every(m=>m.event.conversationId===m.event.platformId));
 const recalled=c.action==='inspect'?JSON.stringify(memory[c.channel]?.items??[]):JSON.stringify(t?.diagnostics?.memory??{}),reply=t?.result?.draft?.text??'';
 for(const word of e.memoryContains??[])check('记忆含 '+word,recalled.includes(word));
 for(const word of e.memoryExcludes??[])check('记忆隔离 '+word,!recalled.includes(word));
 for(const words of e.replyFactGroups??[])check('回复事实 '+words[0],words.some(w=>reply.includes(w)));
 for(const word of e.replyExcludes??[])check('回复不虚构 '+word,!reply.includes(word));
 for(const word of e.promptContains??[])check('批量上文包含 '+word,JSON.stringify(t?.segments??[]).includes(word));
 if(e.keywordHit)check('关键词卡命中',JSON.stringify(t?.diagnostics?.hits??[]).includes(e.keywordHit));
 if(e.summaryWritten)check('记忆实际写入',(t?.diagnostics?.summary??t?.result?.summary)?.written===true);
 for(const source of e.requiredSources??[])check('调用用途 '+source,calls.some(x=>x.source===source&&x.purpose==='chat-test'));
 if(e.requireLongTermMemory)check('实际召回长期条目',(t?.diagnostics?.memory?.memories?.length??0)>0);
 if(e.otherChannelMemoryEmpty){const other=c.channel==='public'?'private':'public';check('另一渠道为空',memory[other].items.length===0&&memory[other].recent.length===0);}
 if(e.newUserMemoryEmpty)check('新用户或重置后召回为空',(t?.diagnostics?.memory?.memories?.length??0)===0&&(t?.diagnostics?.memory?.recent?.length??0)===0);
 if(e.cooldownActive!==undefined&&prerequisites)check('冷却状态',!!memory[c.channel].cooldown===e.cooldownActive);
 if(e.strikes!==undefined)check('骚扰计数',memory[c.channel].strikes===e.strikes);
 if(e.allTestUserDataEmpty)check('重置全部试聊派生数据',turns.items.length===0&&turns.queued.length===0&&['public','private'].every(ch=>!memory[ch].items.length&&!memory[ch].recent.length&&!memory[ch].cooldown&&memory[ch].progress?.cursor===0&&memory[ch].strikes===0));
 if(e.queued)check('仅攒消息未生成',response.message?.status==='queued');
 if(e.targetCase){const target=byCase.get(e.targetCase)?.response?.message;check('私信目标为最后一条',t?.messages?.at(-1)?.id===target?.id);}
 for(const prior of e.contextCases??[]){const id=byCase.get(prior)?.response?.message?.id;check('较早私信仅作上文',t?.messages?.some(m=>m.id===id&&m.status==='context'));}
 if(t&&c.action!=='summarize')check('人设ID与修订',t.persona.id===personas[c.preset].id&&t.persona.revision===personas[c.preset].revision);
 return {checks,observations,passed:checks.every(x=>x.passed)};
}
try{
 await app.listen({host:'127.0.0.1',port:0});base='http://127.0.0.1:'+app.server.address().port;
 if(followup){const initial=JSON.parse(readFileSync(join(OUT,'manifest.json'),'utf8'));Object.assign(users,initial.users);for(const [id,p] of Object.entries(initial.personas))personas[id]=await api('/api/personas/'+encodeURIComponent(p.id));}
 else{for(const preset of [...new Set(plan.cases.map(c=>c.preset))])personas[preset]=(await api('/api/personas',{from:'preset',presetId:preset,name:'真实验收 '+preset})).item;for(const [alias,definition] of Object.entries(plan.users))users[alias]=(await api('/api/chat-test/users',definition)).user;}
 businessBefore=businessSnapshot();startingCalls=allCalls().length;
 save(join(OUT,prefix+'manifest.json'),{sourceCommit:process.env.SOURCE_COMMIT,authorizedAt:'2026-10-29',authorizedModel:'dsv4.1f',limitUsd:2,maxRequests:24,model:{...config.model,resolved:{id:frozen.model.id,provider:frozen.model.provider,api:frozen.model.api,baseUrl:frozen.model.baseUrl,contextWindow:frozen.model.contextWindow,cost:frozen.model.cost,requestOutputCap:requestMaxTokens(4096,frozen.model,'low')}},budgetPricing:{inputPerMillion:.30,outputPerMillion:1.20,cachedInputDiscount:false,source:'https://opencode.ai/v2/docs/console/go/#usage-limits'},users,personas:Object.fromEntries(Object.entries(personas).map(([k,p])=>[k,{id:p.id,name:p.name,revision:p.revision,origin:p.origin}])),productionDataMounted:false,transportCreated:false,plan});
 for(const c of plan.cases){
  if(gate.snapshot().halted)break;currentCase=c.id;const user=users[c.user],path='/api/chat-test/users/'+user.id,count=allCalls().length;let response;
  const request={channel:c.channel,personaId:personas[c.preset].id,text:c.text};
  if(c.action==='send'||c.action==='hold')response=await api(path+'/messages',{...request,hold:c.action==='hold'});
  else if(c.action==='process')response=await api(path+'/process',request);
  else if(c.action==='summarize')response=await api(path+'/memory/summarize',{channel:c.channel});
  else if(c.action==='clearCooldown')response=await api(path+'/clear-cooldown',{});
  else if(c.action==='reset')response=await api(path+'/reset',{});
  else response=await api(path+'/memory');
  const memory=await api(path+'/memory'),turns=await api(path+'/turns'),calls=allCalls().slice(count),assessment=verify(c,response,memory,turns,calls),row={id:c.id,label:c.label,action:c.action,request,response,memory,turns,calls,...assessment};results.push(row);byCase.set(c.id,row);save(join(OUT,prefix+'results.json'),results);
  console.log(JSON.stringify({case:c.id,passed:assessment.passed,failed:assessment.checks.filter(x=>!x.passed).map(x=>x.name),calls:calls.length,status:response.turn?.status,action:response.turn?.result?.draft?.action,budget:gate.snapshot()}));
 }
}catch(error){save(join(OUT,prefix+'driver-error.json'),{caseId:currentCase,error:safe(error),at:Date.now()});console.error('验收停止：'+safe(error));process.exitCode=1;}
finally{
 const calls=allCalls(),known=calls.filter(c=>c.pricing_status==='priced'&&c.cost_json),piEstimatedUsd=known.reduce((n,c)=>n+JSON.parse(c.cost_json).total,0),businessUnchanged=JSON.stringify(businessBefore)===JSON.stringify(businessSnapshot());
 const summary={sourceCommit:process.env.SOURCE_COMMIT,model:selection.id,modelRequests:calls.length,newModelRequests:calls.length-startingCalls,followup,budget:gate.snapshot(),piEstimatedUsd,priced:known.length,unpriced:calls.filter(c=>c.pricing_status==='unpriced').length,unknown:calls.filter(c=>c.pricing_status==='unknown').length,operations:results.length,plannedOperations:plan.cases.length,passedOperations:results.filter(x=>x.passed).length,failedOperations:results.filter(x=>!x.passed).map(x=>({id:x.id,failed:x.checks.filter(c=>!c.passed).map(c=>c.name)})),checks:results.reduce((n,r)=>n+r.checks.length,0),observations:results.flatMap(r=>r.observations.map(note=>({caseId:r.id,note}))),networkRequests:network,isolatedBaseBusinessUnchanged:businessUnchanged,productionDataMounted:false,transportCreated:false,administratorReview:'待审阅',realModelUsed:true};save(join(OUT,prefix+'summary.json'),summary);save(join(OUT,prefix+'calls.json'),calls);
 await chat?.close();await app?.close();store.db.close();globalThis.fetch=nativeFetch;
 if(summary.failedOperations.length||summary.operations!==summary.plannedOperations||summary.budget.halted||!businessUnchanged)process.exitCode=1;
 console.log(JSON.stringify({final:true,modelRequests:summary.modelRequests,operations:summary.operations,passedOperations:summary.passedOperations,failedOperations:summary.failedOperations,piEstimatedUsd:summary.piEstimatedUsd,budget:summary.budget,isolatedBaseBusinessUnchanged:businessUnchanged}));
}
