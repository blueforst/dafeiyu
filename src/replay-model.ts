import { ModelService,freezeCompletionModel,modelKey,type Generator } from './model.js';
import type { Config } from './types.js';

export type ReplayPrice={source:'pi-builtin';known:boolean;input:number|null;output:number|null;cacheRead:number|null;cacheWrite:number|null};
export type FrozenReplayModel={generator:Generator;price:ReplayPrice;assertCurrent:()=>void;dispose:()=>void};
/** 凭据仅由闭包持有。返回的价格与公开元数据可序列化，generator 不得持久化。 */
export async function freezeReplayModel(config:Config,generator:Generator,valid:()=>void):Promise<FrozenReplayModel>{
 if(!(generator instanceof ModelService))throw new Error('模型对比需要支持冻结调用的模型服务');
 const state={key:modelKey(config.model)};
 if(!state.key)throw new Error('请先为两侧模型配置有效 Key');
 const resolved=await freezeCompletionModel(config.model),rates=resolved.model.cost;
 const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
 const known=resolved.pricingKnown&&!!rates;
 const price:ReplayPrice={source:'pi-builtin',known,input:known?number(rates?.input):null,output:known?number(rates?.output):null,cacheRead:known?number(rates?.cacheRead):null,cacheWrite:known?number(rates?.cacheWrite):null};
 const assertCurrent=()=>{valid();if(!state.key||modelKey(config.model)!==state.key)throw new Error('模型 Key 已变化或失效，请重新预估');};
 return {price,assertCurrent,dispose(){state.key='';},generator:{async complete(c,system,user,signal,sessionId,metadata){
  assertCurrent();
  const usedKey=state.key;
  try{
   const result=await generator.request(c.model,usedKey,system,user,{signal,sessionId,resolvedModel:resolved},metadata);
   if(['error','aborted','length','toolUse','deferred','pending'].includes(result.stopReason))throw new Error(result.errorMessage||'模型返回不完整或不支持的响应：'+result.stopReason);
   return result;
  }catch(error){throw new Error(String(error instanceof Error?error.message:error).split(usedKey).join('[已隐藏]'));}
 }}};
}
