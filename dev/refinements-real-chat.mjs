// 2026-10-29 用户授权：本轮隔离真实模型试聊最多 1 美元，不访问 X 或生产业务库。
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {MemoryService} from '../dist/memory.js';
import {PersonaService} from '../dist/persona.js';
import {ModelService,runCompletion,freezeCompletionModel,requestMaxTokens} from '../dist/model.js';
import {ChatTestService} from '../dist/chat-test.js';
import {BudgetGate} from './real-chat-budget.mjs';

const presets=['deepseek','claude','kimi'],slots=[['深夜','2026-10-29T03:53:00+08:00'],['早晨','2026-10-29T08:15:00+08:00']];
if(!process.argv.includes('--execute')){console.log(JSON.stringify({presets,slots,limitUsd:1,maxRequests:64,productionData:false,clock:'试聊注入北京时间，不改变宿主或生产时间'},null,2));process.exit(0);}
if(process.env.ALLOW_REAL_CHAT_USD!=='1')throw Error('本轮执行需要 ALLOW_REAL_CHAT_USD=1');
const followup=process.argv.includes('--followup-clock'),ROOT=process.env.REAL_CHAT_ROOT||'/trial',OUT=join(ROOT,followup?'evidence-clock':'evidence'),DATA=join(ROOT,followup?'runtime-clock':'runtime');mkdirSync(OUT,{recursive:true,mode:0o700});if(existsSync(join(OUT,'results.json')))throw Error('已有本轮结果，禁止隐式重跑');
const key=readFileSync(join(ROOT,'secrets/model_api_key'),'utf8').trim(),selection=JSON.parse(readFileSync(join(ROOT,'selection.json'),'utf8'));
if(!key||selection.provider!=='opencode-go'||selection.id!=='deepseek-v4.1-flash'||selection.baseUrl!=='https://opencode.ai/inference/go/v1')throw Error('冻结的使用中模型或临时凭据不符');
const save=(file,value)=>writeFileSync(join(OUT,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const config=JSON.parse(readFileSync('/app/config.example.json','utf8'));config.model={...selection,source:'panel',reasoning:true,vision:false};config.mode='auto';config.memoryPolicy={recentCount:3,recentDays:7,retentionDays:30};
process.env.DATA_DIR=DATA;mkdirSync(join(DATA,'panel'),{recursive:true,mode:0o700});writeFileSync(join(DATA,'panel/model-keys.json'),JSON.stringify({'opencode-go@opencode.ai':key}),{mode:0o600});
const frozen=await freezeCompletionModel(config.model);if(!frozen.pricingKnown||frozen.model.provider!==selection.provider||frozen.model.id!==selection.id)throw Error('模型计价或身份未知');
const catalogCost=frozen.model.cost;if(!Number.isFinite(catalogCost?.input)||!Number.isFinite(catalogCost?.output)||catalogCost.input<0||catalogCost.output<0)throw Error('模型价格未知，停止');
const inputRate=Math.max(.30,catalogCost.input),outputRate=Math.max(1.20,catalogCost.output);save('pricing.json',{source:'冻结的 Pi 模型目录；预算保护取既定峰价与目录价的较大值',catalogCost,guardPeak:{inputRate,outputRate},contextWindow:frozen.model.contextWindow,maxTokens:config.model.maxTokens});
const gate=new BudgetGate({path:join(ROOT,'budget.json'),limitUsd:1,maxRequests:64,inputTokenCeiling:frozen.model.contextWindow,inputRatePerMillion:inputRate,outputRatePerMillion:outputRate});
const nativeFetch=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(url.origin!=='https://opencode.ai'||url.pathname!=='/inference/go/v1/chat/completions')throw Error('试聊禁止访问其他服务');return nativeFetch(input,options);};
const store=new Store(join(DATA,'workflow.sqlite'));store.set('activeAccount','trial_runner');store.set('control','paused');
let clock=Date.parse(slots[0][1]),currentCase='setup';const traces=[],results=[];
const service=new ModelService(store,(m,k,system,user,opts)=>runCompletion(m,k,system,user,{...opts,resolvedModel:frozen}));
const generator={async complete(c,system,user,signal,sessionId,metadata={}){
 const maxOutputTokens=requestMaxTokens(metadata.maxTokens??c.model.maxTokens,frozen.model,metadata.reasoning??(c.model.reasoning?c.model.reasoningLevel:'off'));
 const ticket=gate.reserve({maxOutputTokens,inputBytes:Buffer.byteLength(system)+Buffer.byteLength(user),label:currentCase,interactionId:metadata.interactionId}),trace={caseId:currentCase,system,user,startedAt:Date.now()};traces.push(trace);save('traces.json',traces);
 try{const result=await service.complete(c,system,user,signal,sessionId,metadata);trace.result=result;gate.settle(ticket,{callId:result.callId,usage:result.usage,cost:result.cost,pricingStatus:result.pricingStatus,actualModel:result.actualModel,expectedModel:selection.id});if(gate.snapshot().halted)throw Error('预算门控已停止');return result;}
 catch(error){trace.error=String(error?.message??error).split(key).join('[已隐藏]');if(!trace.result)gate.fail(ticket,{reason:trace.error,callId:error?.callId});throw error;}
 finally{trace.finishedAt=Date.now();save('traces.json',traces);}
}};
new MemoryService(store,generator,()=>config);const persona=new PersonaService(store,generator,()=>config),chat=new ChatTestService({dataDir:DATA,store,generator,persona,config:()=>config,now:()=>clock});
const personas=Object.fromEntries(presets.map(id=>[id,persona.library.create({from:'preset',presetId:id}).item]));
async function message(id,channel,text,personaId,label){currentCase=label;if(gate.snapshot().halted)throw Error('预算停止，不再请求');const response=await chat.addMessage(id,{channel,text,personaId}),turn=response.turn;const expectedTime=new Date(clock+8*3600000).toISOString().slice(11,16);if(!turn.segments?.find(s=>s.kind==='now')?.content.includes(expectedTime))throw Error('实际提示词时钟与场景不符，停止');results.push({id:label,clock:new Date(clock).toISOString(),channel,input:text,turn});save('results-in-progress.json',results);console.log(JSON.stringify({case:label,status:turn.status,reply:turn.result?.draft?.text,note:turn.result?.note}));if(turn.status!=='completed')throw Error('真实试聊未完成：'+label);return turn;}
try{
 const greetings=[['你好呀，想找你说句话。','嗨，来跟你打声招呼。','哈喽，可以陪我聊两句吗？'],['你好，想听你随便聊一聊。','来找你闲聊啦，方便说话吗？','嘿，今天想和你聊点有趣的。']];
 const normal=['你最近有什么有趣的小事可以分享？','随便推荐一个轻松的聊天话题吧。','你现在在做什么，可以跟我讲一点吗？'];
 for(let s=0;s<slots.length;s++)for(let p=0;p<presets.length;p++){
  const preset=presets[p],personaId=personas[preset].id;clock=Date.parse(slots[s][1]);const user=chat.createUser({name:preset+'-'+slots[s][0]}).user;
  await message(user.id,'public',greetings[s][p],personaId,preset+'-'+s+'-greeting');clock+=60000;
  const separate=chat.createUser({name:preset+'-'+slots[s][0]+'普通'}).user;await message(separate.id,'public',normal[p]+(s?'可以简单说两句。':''),personaId,preset+'-'+s+'-normal');
  if(s===0&&!followup){const followups=['刚才在公开跟你打招呼的那个，你还有印象吗？','我刚在公开来过，你还记得那句招呼吗？','刚刚跟你说哈喽的人就是我，还记得吧？'];const turn=await message(user.id,'private',followups[p],personaId,preset+'-cross-channel');if(!turn.diagnostics.memory.recent.some(r=>r.channel==='public'&&r.message===greetings[s][p]))throw Error('跨渠道公开往来未召回');}
 }
 for(let p=0;p<(followup?0:presets.length);p++){
  const preset=presets[p],personaId=personas[preset].id;clock=Date.parse(slots[0][1]);const user=chat.createUser({name:preset+'私信背景'}).user,facts=['我的猫叫银杏，十一月十六日去大阪。','我养的狗叫松果，下个月十二号去札幌。','我的仓鼠叫豆芽，十二月七日去京都。'];
  await message(user.id,'private','有件事只在私信里说：'+facts[p]+'请不要在公开聊这些。',personaId,preset+'-private-fact');currentCase=preset+'-summary';const summary=await chat.summarize(user.id,{channel:'private'});results.push({id:currentCase,result:summary});if(!summary.turn?.result?.summary?.written&&!summary.turn?.diagnostics?.summary?.written&&!chat.memory(user.id).private.items.length)throw Error('私信长期整理未写入');
  const text=['我们在这里聊点什么轻松的好？','公开闲聊一下，你想从什么话题开始？','不说别的，随便聊个日常话题吧。'][p],turn=await message(user.id,'public',text,personaId,preset+'-private-background');if(!turn.diagnostics.memory.privateBackground?.length)throw Error('公开没有召回私信长期背景');
 }
 save('results.json',{scope:'真实模型，合成用户与注入北京深夜／早晨；未访问生产或X',selection,results,budget:gate.snapshot(),calls:store.db.prepare('SELECT id,status,purpose,source,model FROM llm_calls ORDER BY started_at,id').all()});
 const budget=gate.snapshot();console.log(JSON.stringify({finished:true,operations:results.length,requests:budget.requests,guardUsedUSD:budget.usedNano/1e9,reservedUSD:budget.reservedNano/1e9,halted:budget.halted}));
}finally{await chat.close();store.db.close();}
