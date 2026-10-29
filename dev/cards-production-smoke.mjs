// 发布后仅生成一条无卡预览草稿；本轮共用一美元账本，无平台发送或设置保存。
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {BudgetGate} from './real-chat-budget.mjs';
import {freezeCompletionModel} from '../dist/model.js';
const root=process.env.REAL_CHAT_ROOT||'/trial',file=root+'/production-smoke.json';
if(process.env.ALLOW_REAL_CHAT_USD!=='1'||existsSync(file))throw Error('缺少授权或已有验收结果');
const key=readFileSync('/run/test/ingress_key','utf8').trim();
async function api(path,body){const r=await fetch('http://127.0.0.1:8080'+path,{method:body?'POST':'GET',headers:{'X-Ingress-Key':key,'X-Workflow-Control':'1','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(200000)});if(!r.ok)throw Error('正式接口 '+path+' HTTP '+r.status);return r.json();}
const before=await api('/api/status'),model=await api('/api/model'),persona=await api('/api/persona'),selection=JSON.parse(readFileSync(root+'/selection.json','utf8'));
if(before.control!=='paused'||before.busy||before.config.mode!=='auto'||model.effective.id!==selection.id||model.effective.provider!==selection.provider||model.effective.baseUrl!==selection.baseUrl)throw Error('生产状态或模型变化');
const frozen=await freezeCompletionModel({...selection,reasoning:true,reasoningLevel:selection.reasoningLevel}),gate=new BudgetGate({path:root+'/budget.json',limitUsd:1,maxRequests:Number.MAX_SAFE_INTEGER,inputTokenCeiling:frozen.model.contextWindow,inputRatePerMillion:Math.max(.3,frozen.model.cost.input),outputRatePerMillion:Math.max(1.2,frozen.model.cost.output)});
const ticket=gate.reserve({maxOutputTokens:frozen.model.maxTokens,inputBytes:0,label:'production-native-draft',interactionId:'production-native-draft'});let settled=false;
try{
 const result=await api('/api/persona/preview',{channel:'public',persona:{sections:persona.persona.sections,triggers:[]},messages:[{role:'user',text:'你好呀，来打个招呼。'}]}),calls=await api('/api/billing/calls?interactionId='+encodeURIComponent(result.interactionId)+'&limit=100');
 if(calls.items.length!==1)throw Error('无卡生成未满足单次请求边界');const call=calls.items[0];
 gate.settle(ticket,{callId:call.id,usage:call.usage,cost:call.cost,pricingStatus:call.pricingStatus,actualModel:call.actualModel,expectedModel:selection.id});settled=true;
 if(gate.snapshot().halted||result.error||result.draft?.action!=='reply'||result.meta.finalTool!=='submit_draft'||call.stopReason==='length'||call.status!=='completed')throw Error('正式终态草稿验收未通过');
 const after=await api('/api/status');if(after.control!==before.control||after.config.mode!==before.config.mode||JSON.stringify(after.stats.messages)!==JSON.stringify(before.stats.messages))throw Error('生产业务状态变化');
 const output={scope:'正式预览API，使用当前已保存静态分区，无卡单次终态工具；不发送平台',result,calls:calls.items,control:after.control,mode:after.config.mode,budget:gate.snapshot()};writeFileSync(file,JSON.stringify(output,null,2),{mode:0o600});console.log(JSON.stringify({passed:true,requests:calls.items.length,finalTool:result.meta.finalTool,reply:result.draft.text,callId:call.id}));
}catch(error){if(!settled)gate.fail(ticket,{reason:'request-failed'});writeFileSync(file,JSON.stringify({error:error.message,budget:gate.snapshot()},null,2),{mode:0o600});throw error;}
