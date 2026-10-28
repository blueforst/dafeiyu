// 发布后仅通过正式试聊 API 验证，不恢复业务，不访问平台发送接口；共用本轮一美元账本。
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {BudgetGate} from './real-chat-budget.mjs';
if(process.env.ALLOW_PRODUCTION_CHAT_USD!=='1')throw Error('需要本轮显式授权 ALLOW_PRODUCTION_CHAT_USD=1');
const root=process.env.REAL_CHAT_ROOT||'/var/lib/role-workflow-refinements-real-20261029',output=join(root,'production-smoke.json');if(existsSync(output))throw Error('已有生产试聊结果，禁止自动重复付费');
const key=readFileSync('/var/lib/role-workflow/secrets/app/ingress_key','utf8').trim();
async function api(path,body,method=body===undefined?'GET':'POST'){
 if(!path.startsWith('/api/'))throw Error('只允许面板接口');const response=await fetch('http://127.0.0.1:8080'+path,{method,headers:{'X-Ingress-Key':key,'X-Workflow-Control':'1','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)});const value=await response.json();if(!response.ok)throw Error('面板接口 '+path+' 返回 '+response.status);return value;
}
function business(){const db=new DatabaseSync('/var/lib/role-workflow/app/workflow.sqlite',{readOnly:true});try{return Object.fromEntries(['messages','outbox'].map(t=>[t,db.prepare('SELECT count(*) n FROM '+t).get().n]));}finally{db.close();}}
const initial=await api('/api/status'),model=await api('/api/model');
if(initial.control!=='paused'||initial.busy||model.effective?.provider!=='opencode-go'||model.effective.id!=='deepseek-v4.1-flash'||model.effective.baseUrl!=='https://opencode.ai/inference/go/v1'||model.settings.maxTokens!==4096||model.settings.reasoningLevel!=='low'||model.info.cost.input>.30||model.info.cost.output>1.20)throw Error('生产状态或模型与冻结范围不符');
const library=await api('/api/personas');let selected;
for(const item of [...library.items].sort((a,b)=>(b.id===library.activeId)-(a.id===library.activeId))){const detail=await api('/api/personas/'+encodeURIComponent(item.id));if(!detail.persona.triggers.some(t=>t.enabled&&t.match!=='keywords')){selected=detail;break;}}
if(!selected)throw Error('没有可确定单次生成的人设，本轮不追加生产计费请求');
const gate=new BudgetGate({path:join(root,'budget.json'),limitUsd:1,maxRequests:64,inputTokenCeiling:1000000,inputRatePerMillion:.30,outputRatePerMillion:1.20});
const before=business(),user=(await api('/api/chat-test/users',{name:'发布验收：公开与私信'})).user,turns=[];
for(const [channel,text] of [['public','你好呀，我是这轮来打招呼的小林，可以随便聊聊吗？'],['private','我刚刚在公开跟你打过招呼，你还有印象吗？']]){
 const current=await api('/api/model');if(current.effective.id!==model.effective.id||current.effective.provider!==model.effective.provider||current.effective.baseUrl!==model.effective.baseUrl)throw Error('模型已变更，停止后续请求');
 const ticket=gate.reserve({maxOutputTokens:6144,inputBytes:0,label:'production-smoke-'+channel,interactionId:'production-smoke-'+channel});let settled=false;
 try{const response=await api('/api/chat-test/users/'+user.id+'/messages',{channel,text,personaId:selected.id}),turn=response.turn,calls=turn?.diagnostics?.calls??[];turns.push(turn);
  if(calls.length!==1)throw Error('试聊实际调用数与预留不符');const call=calls[0];gate.settle(ticket,{callId:call.id,usage:call.usage,cost:call.cost,pricingStatus:call.pricingStatus,actualModel:call.actualModel,expectedModel:model.effective.id});settled=true;
  if(turn.status!=='completed'||gate.snapshot().halted)throw Error('生产试聊未完成或预算停止');if(channel==='private'&&!turn.diagnostics.memory.recent.some(r=>r.channel==='public'&&r.message.includes('小林')))throw Error('私信未召回先前公开往来');
 }catch(error){if(!settled)gate.fail(ticket,{reason:'request-failed'});writeFileSync(output,JSON.stringify({user,persona:{id:selected.id,name:selected.name},turns,error:String(error.message),budget:gate.snapshot()},null,2),{mode:0o600});throw error;}
}
const after=business(),final=await api('/api/status');if(JSON.stringify(before)!==JSON.stringify(after)||final.control!=='paused'||final.config.mode!==initial.config.mode)throw Error('业务状态或出站发生意外变化');
const budget=gate.snapshot(),value={scope:'正式部署后的正常试聊API；模拟用户，不发到X',user,persona:{id:selected.id,name:selected.name},turns,before,after,control:final.control,mode:final.config.mode,budget};writeFileSync(output,JSON.stringify(value,null,2),{mode:0o600});
console.log(JSON.stringify({userId:user.id,replies:turns.map(t=>t.result?.draft?.text),requests:budget.requests,guardUsedUSD:budget.usedNano/1e9,piEstimatedUSD:budget.tickets.reduce((n,t)=>n+(t.reportedPiCost?.total??0),0),control:final.control,mode:final.config.mode}));
