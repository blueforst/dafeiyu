// 用户授权本轮合计不超过 $1；用户随后解除请求次数上限；只用独立库与冻结的当前模型。
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {ModelService,runCompletion,freezeCompletionModel,fitContext,inputEstimate,requestMaxTokens,connectionCheck} from '../dist/model.js';
import {PersonaService} from '../dist/persona.js';
import {ChatTestService} from '../dist/chat-test.js';
import {MemoryService} from '../dist/memory.js';
import {runReplyLoop} from '../dist/reply-tools.js';
import {BudgetGate} from './real-chat-budget.mjs';
const ROOT=process.env.REAL_CHAT_ROOT||'/trial';
if(process.env.ALLOW_REAL_CHAT_USD!=='1')throw Error('需要本轮一美元明确授权');
const phase=process.argv.find(v=>v.startsWith('--phase='))?.slice(8)??(process.argv.includes('--retry-prompt-v2')?'evidence-v2':'evidence');if(!/^[a-z0-9-]+$/.test(phase))throw Error('验收批次名无效');const DATA=join(ROOT,'runtime-'+phase),OUT=join(ROOT,phase);mkdirSync(OUT,{recursive:true,mode:0o700});
const selection=JSON.parse(readFileSync(join(ROOT,'selection.json'),'utf8')),key=readFileSync(join(ROOT,'secrets/model_api_key'),'utf8').trim();
if(selection.provider!=='opencode-go'||selection.id!=='deepseek-v4.1-flash'||selection.baseUrl!=='https://opencode.ai/inference/go/v1'||!key)throw Error('使用中模型不符，停止');
const config=JSON.parse(readFileSync('/app/config.example.json','utf8'));config.model={...selection,source:'panel',reasoning:selection.reasoningLevel!=='off',vision:false};config.memoryPolicy={recentCount:3,recentDays:7,retentionDays:30};
process.env.DATA_DIR=DATA;mkdirSync(join(DATA,'panel'),{recursive:true,mode:0o700});writeFileSync(join(DATA,'panel/model-keys.json'),JSON.stringify({'opencode-go@opencode.ai':key}),{mode:0o600});
const frozen=await freezeCompletionModel(config.model);if(!frozen.pricingKnown)throw Error('模型价格未知');
const gate=new BudgetGate({path:join(ROOT,'budget.json'),limitUsd:1,maxRequests:Number.MAX_SAFE_INTEGER,inputTokenCeiling:frozen.model.contextWindow,inputRatePerMillion:Math.max(.3,frozen.model.cost.input),outputRatePerMillion:Math.max(1.2,frozen.model.cost.output)});
const save=(name,x)=>writeFileSync(join(OUT,name),JSON.stringify(x,null,2)+'\n',{mode:0o600});
const nativeFetch=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(url.origin!=='https://opencode.ai'||url.pathname!=='/inference/go/v1/chat/completions')throw Error('验收禁止访问其他服务');return nativeFetch(input,options);};
const store=new Store(join(DATA,'workflow.sqlite'));store.set('activeAccount','cards_acceptance');store.set('control','paused');
const requestStart=gate.snapshot().requests;let label='setup';const tracePath=join(OUT,'traces.json'),traces=existsSync(tracePath)?JSON.parse(readFileSync(tracePath,'utf8')):[];
class BudgetModel extends ModelService {
 async request(m,k,system,user,opts={},metadata={}){
  if(label.startsWith('preflight-')&&gate.snapshot().requests-requestStart>=5)throw Error('前置验证达到5次请求上限');
  const context=opts.context??{systemPrompt:system,messages:[{role:'user',content:user,timestamp:Date.now()}]},cap=fitContext(requestMaxTokens(metadata.maxTokens??opts.maxTokens??frozen.model.maxTokens,frozen.model,metadata.reasoning??opts.reasoning??(m.reasoning?m.reasoningLevel:'off')),frozen.model.contextWindow,inputEstimate(context));
  const ticket=gate.reserve({maxOutputTokens:cap,inputBytes:Buffer.byteLength(JSON.stringify(context)),label,interactionId:metadata.interactionId||label}),trace={label,context,startedAt:Date.now()};traces.push(trace);save('traces.json',traces);
  try{const r=await super.request(m,k,system,user,opts,metadata);trace.result=r;gate.settle(ticket,{callId:r.callId,usage:r.usage,cost:r.cost,pricingStatus:r.pricingStatus,actualModel:r.actualModel,expectedModel:selection.id});if(gate.snapshot().halted)throw Error('预算门控停止');return r;}
  catch(e){trace.error=String(e.message).split(key).join('[已隐藏]');if(!trace.result)gate.fail(ticket,{reason:'request-failed'});throw e;}
  finally{trace.finishedAt=Date.now();save('traces.json',traces);save('budget-summary.json',gate.snapshot());}
 }
}
const generator=new BudgetModel(store,(m,k,system,user,opts)=>runCompletion(m,k,system,user,{...opts,resolvedModel:frozen,...(process.argv.includes('--without-json')&&opts.context?.tools?.length?{jsonObject:false}:{})}));
if(process.argv.includes('--preflight')){
 if(existsSync(join(OUT,'preflight.json')))throw Error('前置验证已有结果，不隐式重复');
 const before=gate.snapshot().requests;label='preflight-connection';const check=await connectionCheck(generator,config.model,key,'off',{purpose:'model-test',source:'cards-acceptance',interactionId:label});
 if(!check.ok)throw Error(check.errorMessage||'连接工具失败');label='preflight-native-draft';
 const cards=[{id:'test-card',title:'测试卡',condition:'当用户询问测试口令时读取。',content:'测试口令是蓝鲸散步。',enabled:true,order:0}];
 const result=await runReplyLoop({generator,config,system:'你是接口验收助手。先调用 read_card 读取 test-card，然后单独调用 submit_draft，action=reply、text 必须且只能是卡片中的四字口令本身，不加解释、引号或标点；reason 为验收。',user:'测试口令是什么？',cards,sessionId:label,metadata:{purpose:'chat-test',source:'cards-acceptance',interactionId:label,maxTokens:2048}});
 if(gate.snapshot().requests-before>5||!result.hits.some(h=>h.id==='test-card')||JSON.parse(result.text).text!=='蓝鲸散步')throw Error('读卡与终态工具前置验收未达标');
 save('preflight.json',{check,result,requests:gate.snapshot().requests-before,budget:gate.snapshot()});console.log(JSON.stringify({preflight:true,requests:gate.snapshot().requests,piCost:gate.snapshot().tickets.reduce((n,t)=>n+(t.reportedPiCost?.total||0),0)}));store.db.close();process.exit(0);
}
if(!existsSync(join(ROOT,'evidence/preflight.json')))throw Error('先完成前置验收');
if(existsSync(join(OUT,'results.json')))throw Error('真实样例已有结果，不隐式重复');
new MemoryService(store,generator,()=>config);const persona=new PersonaService(store,generator,()=>config),chat=new ChatTestService({dataDir:DATA,store,generator,persona,config:()=>config,now:()=>Date.parse('2026-10-29T14:00:00+08:00')});
const fish=persona.library.create({from:'preset',presetId:'deepseek'}).item,claude=persona.library.create({from:'preset',presetId:'claude'}).item;
let scenarios=[['别装可爱',fish,[],['deepseek-praise']],['你好可爱',fish,['deepseek-praise'],[]],['怎么才能做好番茄炒蛋',fish,['deepseek-no-steps'],[]],['你长什么样',fish,['appearance'],[]],['你平时爱吃啥',fish,['self'],[]],['你好呀，来打个招呼',fish,[],['*']],['哈哈，听你这么说我也笑了',fish,[],['*']],['你是官方的吗',claude,['identity'],[]]],results=[];
if(process.argv.includes('--duplicates'))scenarios=Array.from({length:3},()=>['你平时爱吃啥',fish,['self'],[]]);
try{for(let i=0;i<scenarios.length;i++){const [text,p,required,forbidden]=scenarios[i];label='sample-'+i;const user=chat.createUser({name:'触发卡验收 '+(i+1)}).user,response=await chat.addMessage(user.id,{channel:'public',text,personaId:p.id}),turn=response.turn,hits=turn.diagnostics?.hits?.map(h=>h.id)??[];const passed=turn.status==='completed'&&turn.diagnostics?.meta?.finalTool==='submit_draft'&&required.every(id=>hits.includes(id))&&forbidden.every(id=>id==='*'?hits.length===0:!hits.includes(id))&&(turn.diagnostics?.meta?.toolCalls??0)<=20;results.push({label,text,required,forbidden,passed,turn});save('results-in-progress.json',results);console.log(JSON.stringify({label,passed,hits,reply:turn.result?.draft?.text}));if(gate.snapshot().halted)break;}save('results.json',{selection,duplicateQuestions:process.argv.includes('--duplicates'),withoutJson:process.argv.includes('--without-json'),results,passed:results.length===scenarios.length&&results.every(r=>r.passed),budget:gate.snapshot()});}finally{await chat.close();store.db.close();}
