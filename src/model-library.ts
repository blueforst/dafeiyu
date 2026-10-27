// 多服务商模型库。使用中的 model 仍是旧版可读的物化配置。
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { redact } from './config.js';
import { checkBaseUrl,commitModelLibrary,keyHint,keySlot,readModelKey,readPanelSettings,toConfigModel,writeModelKey,type PanelModel,type ReasoningLevel } from './settings.js';
import { discoverModels,findCatalogModel,listCatalogModels,listModels,listProviders,type ModelInfo } from './model-catalog.js';
import { ModelService,runCompletion } from './model.js';

export type LibraryTest = {ok:boolean;at:number;latencyMs:number;provider:string;id:string;input?:number;output?:number;error?:string;callId?:string;usage?:unknown;cost?:unknown;pricingStatus?:string};
export type LibraryParams = {reasoningLevel:ReasoningLevel;maxTokens:number;timeoutMs:number};
export type LibraryModel = {id:string;source:'discovered'|'catalog'|'manual';missing?:boolean;params?:LibraryParams;custom?:{contextWindow:number;reasoning:boolean};lastTest?:LibraryTest};
export type LibraryProvider = {key:string;provider:string;name:string;baseUrl:string;api?:PanelModel['api'];fetchedAt?:number;fetchError?:string;models:LibraryModel[]};
export type ModelLibrary = {version:1;providers:LibraryProvider[];active:{default?:{key:string;modelId:string}}};
export type ModelLibraryDependencies = {store:Store;run?:typeof runCompletion;discover?:typeof discoverModels};
export class ModelLibraryError extends Error {constructor(message:string,public statusCode=400,public extra:Record<string,unknown>={}){super(message);}}
const APIS=['openai-completions','openai-responses','anthropic-messages'];
const DEFAULT_PARAMS:LibraryParams={reasoningLevel:'off',maxTokens:4096,timeoutMs:60000};
function integer(value:unknown,min:number,max:number,label:string):number {if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max)throw new ModelLibraryError(label+'超出范围');return value as number;}
function modelId(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.trim().length>200||/[\u0000-\u001f]/.test(value))throw new ModelLibraryError('模型 ID 无效');return value.trim();}
function typedKey(value:unknown):string {if(value===undefined||value==='')return '';if(typeof value!=='string')throw new ModelLibraryError('API Key 格式无效');const key=value.trim();if(!key||key.length>1000||/\s/.test(key))throw new ModelLibraryError('API Key 格式无效');return key;}
function baseUrl(value:unknown):string {try{return checkBaseUrl(String(value??'')).href.replace(/\/$/,'');}catch(error){throw new ModelLibraryError(error instanceof Error?error.message:'模型地址无效');}}
function safeError(error:unknown,key=''):string {let value=redact(error instanceof Error?error.message:String(error));if(key)value=value.split(key).join('[已隐藏]');return value.slice(0,500);}
function sameModel(a:PanelModel|undefined,b:PanelModel):boolean {return !!a&&a.provider===b.provider&&a.id===b.id&&a.baseUrl===b.baseUrl&&(a.api||'')===(b.api||'')&&a.reasoningLevel===b.reasoningLevel&&a.maxTokens===b.maxTokens&&a.timeoutMs===b.timeoutMs&&JSON.stringify(a.custom||null)===JSON.stringify(b.custom||null);}
function fromLegacy(model:PanelModel,lastTest?:LibraryTest,key?:string):LibraryProvider {return {key:key||(model.provider==='custom'?'custom-legacy':model.provider),provider:model.provider,name:model.provider==='custom'?'自定义接口':model.provider,baseUrl:model.baseUrl,...(model.api?{api:model.api}:{}),models:[{id:model.id,source:'manual',params:{reasoningLevel:model.reasoningLevel,maxTokens:model.maxTokens,timeoutMs:model.timeoutMs},...(model.custom?{custom:structuredClone(model.custom)}:{}),...(lastTest?.provider===model.provider&&lastTest.id===model.id?{lastTest}: {})}]};}

export class ModelLibraryService {
 private service:ModelService;
 private discover:typeof discoverModels;
 constructor(private deps:ModelLibraryDependencies){this.service=new ModelService(deps.store,deps.run??runCompletion);this.discover=deps.discover??discoverModels;}
 /** 首读迁移只登记面板模型，不改变 model 或 Key 文件。配置文件的 secret 路径保留原含义。 */
 read():{library:ModelLibrary;revision:number}{
  let panel=readPanelSettings(),library=panel.modelLibrary;
  if(!library){
   let last:LibraryTest|undefined;try{last=JSON.parse(this.deps.store.get('model:lastTest','null'))||undefined;}catch{}
   const provider=panel.model?fromLegacy(panel.model,last):undefined;
   library={version:1,providers:provider?[provider]:[],active:{...(provider?{default:{key:provider.key,modelId:panel.model!.id}}:{})}};
   const saved=commitModelLibrary(library,panel.revisions?.modelLibrary??0);panel=saved.settings;
  }
  // 旧入口/旧版本可能只修改 model；以实际运行 model 为准修复 active，不反向覆盖运行配置。
  if(panel.model){
   const active=library.active.default,p=library.providers.find(x=>x.key===active?.key),m=p?.models.find(x=>x.id===active?.modelId);
   if(!p||!m||!sameModel(panel.model,this.materialize(p,m))){
    const next=structuredClone(library);let provider=next.providers.find(x=>x.provider===panel.model!.provider&&x.baseUrl===panel.model!.baseUrl&&(x.api||'')===(panel.model!.api||''));
    if(!provider){provider=fromLegacy(panel.model,undefined,panel.model.provider==='custom'?'custom-'+randomUUID().slice(0,8):next.providers.some(x=>x.key===panel.model!.provider)?panel.model.provider+'-'+randomUUID().slice(0,8):panel.model.provider);next.providers.push(provider);}
    const index=provider.models.findIndex(x=>x.id===panel.model!.id),legacy=fromLegacy(panel.model).models[0];if(index>=0)provider.models[index]=legacy;else provider.models.push(legacy);
    next.active.default={key:provider.key,modelId:panel.model.id};
    const saved=commitModelLibrary(next,panel.revisions?.modelLibrary??0);panel=saved.settings;library=next;
    this.deps.store.log('model-library-reconcile','使用中模型已按现有运行配置同步');
   }
  }
  return {library:structuredClone(library),revision:panel.revisions?.modelLibrary??0};
 }
 private current(expected:unknown){const state=this.read();if(!Number.isSafeInteger(expected)||expected!==state.revision)throw new ModelLibraryError('模型库已被修改，请重新读取后保存',409,{revision:state.revision});return state;}
 private provider(library:ModelLibrary,key:string){const found=library.providers.find(x=>x.key===key);if(!found)throw new ModelLibraryError('服务商不存在',404);return found;}
 private model(provider:LibraryProvider,id:string){const found=provider.models.find(x=>x.id===id);if(!found)throw new ModelLibraryError('模型不存在',404);return found;}
 private active(library:ModelLibrary,provider:LibraryProvider,model?:LibraryModel){return library.active.default?.key===provider.key&&(!model||library.active.default.modelId===model.id);}
 private saved(library:ModelLibrary,revision:number,materialize=false){const active=library.active.default,p=active?this.provider(library,active.key):undefined,m=p&&active?this.model(p,active.modelId):undefined;return commitModelLibrary(library,revision,materialize&&p&&m?this.materialize(p,m):undefined);}
 private materialize(provider:LibraryProvider,model:LibraryModel):PanelModel{return {provider:provider.provider,baseUrl:provider.baseUrl,...(provider.api?{api:provider.api}:{}),id:model.id,...(model.params||DEFAULT_PARAMS),...(model.custom?{custom:structuredClone(model.custom)}:{})};}
 private async info(provider:LibraryProvider,id:string):Promise<ModelInfo|undefined>{if(provider.provider!=='custom')return (await listModels(provider.provider)).find(x=>x.id===id);const known=await findCatalogModel(id);return known?{...known,cost:{input:0,output:0},costKnown:false}:undefined;}
 private async validateModel(provider:LibraryProvider,model:LibraryModel,requireUnknown=true){
  const info=await this.info(provider,model.id),params=model.params||DEFAULT_PARAMS;
  integer(params.maxTokens,64,8192,'回复长度上限');integer(params.timeoutMs,1000,180000,'超时');
  if(info&&params.maxTokens>info.maxTokens)throw new ModelLibraryError('回复长度上限超过模型上限 '+info.maxTokens);
  if(!info&&requireUnknown&&!model.custom)throw new ModelLibraryError('未识别的模型需要填写上下文长度和是否支持推理');
  if(model.custom){integer(model.custom.contextWindow,1000,10000000,'上下文长度');if(typeof model.custom.reasoning!=='boolean')throw new ModelLibraryError('请填写是否支持推理');}
  const levels=info?.levels??(model.custom?.reasoning?['off','low','medium','high']:['off']);
  if(!levels.includes(params.reasoningLevel))throw new ModelLibraryError('该模型不支持这个推理档位');
  return info;
 }
 async view(){
  const {library,revision}=this.read();
  const providers=await Promise.all(library.providers.map(async provider=>{
   const key=readModelKey(keySlot(provider.provider,provider.baseUrl)),active=this.active(library,provider);
   const catalog=new Map<string,ModelInfo>();for(const info of await (provider.provider==='custom'?listCatalogModels():listModels(provider.provider)))if(!catalog.has(info.id))catalog.set(info.id,info);
   const models=provider.models.map(model=>{const info=catalog.get(model.id);return {...model,params:{...DEFAULT_PARAMS,...model.params},info:info?(provider.provider==='custom'?{...info,cost:{input:0,output:0},costKnown:false}:info):null,active:this.active(library,provider,model)};});
   const priority=(model:typeof models[number])=>Number(model.active)*4+Number(!!model.lastTest)*2+Number(!!provider.models.find(x=>x.id===model.id)?.params);
   models.sort((a,b)=>priority(b)-priority(a)||a.id.localeCompare(b.id));
   return {...provider,models,hasKey:!!key,keyHint:keyHint(key),ready:!!key&&models.some(x=>x.lastTest?.ok),active};
  }));
  return {...library,providers,revision};
 }
 private async refreshed(provider:LibraryProvider,library:ModelLibrary,key:string):Promise<void>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const result=await Promise.race([this.discover({provider:provider.provider,baseUrl:provider.baseUrl,api:provider.api,apiKey:key}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('拉取失败：超时')),25000);})]);
   const incoming=[...new Set(result.models.map(x=>modelId(x.id)))].slice(0,1000),old=new Map(provider.models.map(x=>[x.id,x]));
   const models:LibraryModel[]=incoming.map(id=>{const existing=old.get(id);return {...existing,id,source:existing?.source==='manual'?'manual':'discovered',missing:false};});
   for(const existing of provider.models)if(!incoming.includes(existing.id)&&(existing.source==='manual'||existing.params||existing.lastTest||this.active(library,provider,existing)))models.push({...existing,missing:true});
   provider.models=models;delete provider.fetchError;
  }catch(error){
   provider.fetchError=safeError(error,key);
   if(provider.provider!=='custom'){
    const catalog=await listModels(provider.provider),old=new Map(provider.models.map(x=>[x.id,x]));
    provider.models=catalog.map(info=>({...old.get(info.id),id:info.id,source:old.get(info.id)?.source==='manual'?'manual':'catalog'}));
    for(const existing of old.values())if(!provider.models.some(x=>x.id===existing.id)&&(existing.source==='manual'||existing.params||existing.lastTest||this.active(library,provider,existing)))provider.models.push({...existing,missing:true});
   }
  }finally{clearTimeout(timer);provider.fetchedAt=Date.now();}
 }
 async add(raw:any){
  const state=this.current(raw?.revision),providerId=String(raw.provider||''),catalog=(await listProviders()).find(x=>x.id===providerId);
  if(providerId!=='custom'&&(!catalog||!catalog.available))throw new ModelLibraryError(catalog?.reason||'服务商尚未接入或不存在');
  if(providerId!=='custom'&&state.library.providers.some(x=>x.key===providerId))throw new ModelLibraryError('服务商已添加',409);
  if(state.library.providers.length>=100)throw new ModelLibraryError('最多添加 100 个服务商');
  const endpoint=baseUrl(raw.baseUrl||catalog?.baseUrl),name=String(raw.name||catalog?.name||'自定义接口').trim();if(!name||name.length>100)throw new ModelLibraryError('服务商名称应为 1–100 个字符');
  if(providerId==='custom'&&!APIS.includes(raw.api))throw new ModelLibraryError('请选择接口协议');
  const apiKey=typedKey(raw.apiKey);if(!apiKey)throw new ModelLibraryError('请先填写 API Key');
  const provider:LibraryProvider={key:providerId==='custom'?'custom-'+randomUUID().slice(0,8):providerId,provider:providerId,name,baseUrl:endpoint,...(providerId==='custom'?{api:raw.api}:{}),models:[]};
  state.library.providers.push(provider);await this.refreshed(provider,state.library,apiKey);
  this.current(state.revision);writeModelKey(keySlot(provider.provider,provider.baseUrl),apiKey);this.saved(state.library,state.revision);
  this.deps.store.log('model-library-add','已添加服务商 '+provider.key);
  return this.view();
 }
 async update(key:string,raw:any){
  const state=this.current(raw?.revision),provider=this.provider(state.library,key),before={...provider},typed=typedKey(raw.apiKey);
  if(raw.name!==undefined){const name=String(raw.name).trim();if(!name||name.length>100)throw new ModelLibraryError('服务商名称应为 1–100 个字符');provider.name=name;}
  if(raw.baseUrl!==undefined)provider.baseUrl=baseUrl(raw.baseUrl);
  if(raw.api!==undefined){if(provider.provider!=='custom'||!APIS.includes(raw.api))throw new ModelLibraryError('接口协议无效');provider.api=raw.api;}
  const hostChanged=new URL(before.baseUrl).hostname.toLowerCase()!==new URL(provider.baseUrl).hostname.toLowerCase();if(hostChanged&&!typed)throw new ModelLibraryError('地址主机已改变，请重新填写 API Key');
  const keyValue=typed||readModelKey(keySlot(provider.provider,provider.baseUrl));if(!keyValue)throw new ModelLibraryError('请先填写 API Key');
  if(before.baseUrl!==provider.baseUrl||before.api!==provider.api||typed){for(const model of provider.models)delete model.lastTest;delete provider.fetchError;}
  this.current(state.revision);if(typed)writeModelKey(keySlot(provider.provider,provider.baseUrl),typed);this.saved(state.library,state.revision,this.active(state.library,provider));
  this.deps.store.log('model-library-update','已更新服务商 '+key);return this.view();
 }
 async remove(key:string,revision:unknown){const state=this.current(revision),provider=this.provider(state.library,key);if(this.active(state.library,provider))throw new ModelLibraryError('请先切换使用中的模型',409);state.library.providers=state.library.providers.filter(x=>x.key!==key);this.saved(state.library,state.revision);this.deps.store.log('model-library-remove','已移除服务商 '+key);return this.view();}
 async refresh(key:string,revision:unknown){const state=this.current(revision),provider=this.provider(state.library,key),apiKey=readModelKey(keySlot(provider.provider,provider.baseUrl));if(!apiKey)throw new ModelLibraryError('请先填写 API Key');await this.refreshed(provider,state.library,apiKey);this.current(state.revision);this.saved(state.library,state.revision);this.deps.store.log('model-library-refresh',key+(provider.fetchError?' 拉取失败':' 已刷新'));return this.view();}
 async updateModel(key:string,id:string,raw:any){
  const state=this.current(raw?.revision),provider=this.provider(state.library,key);id=modelId(id);let model=provider.models.find(x=>x.id===id);if(!model){if(provider.models.length>=2000)throw new ModelLibraryError('模型数量超过上限');model={id,source:'manual'};provider.models.push(model);}
  const old=JSON.stringify([model.params,model.custom]),params=raw.params||raw;
  model.params={...DEFAULT_PARAMS,...model.params,...(params.reasoningLevel!==undefined?{reasoningLevel:params.reasoningLevel}:{}),...(params.maxTokens!==undefined?{maxTokens:params.maxTokens}:{}),...(params.timeoutMs!==undefined?{timeoutMs:params.timeoutMs}:{})};
  if(raw.custom!==undefined)model.custom={contextWindow:raw.custom?.contextWindow,reasoning:raw.custom?.reasoning};await this.validateModel(provider,model);
  if(old!==JSON.stringify([model.params,model.custom]))delete model.lastTest;
  this.current(state.revision);this.saved(state.library,state.revision,this.active(state.library,provider,model));this.deps.store.log('model-library-model','已更新模型 '+key+'/'+id);return this.view();
 }
 async activate(raw:any){
  const state=this.current(raw?.revision),provider=this.provider(state.library,String(raw.key||'')),model=this.model(provider,modelId(raw.modelId));await this.validateModel(provider,model);
  if(!readModelKey(keySlot(provider.provider,provider.baseUrl)))throw new ModelLibraryError('请先填写 API Key');
  if(!model.lastTest?.ok&&raw.confirmUntested!==true&&raw.confirm!==true)throw new ModelLibraryError('该模型最近未通过测试，确认后才能设为使用中',409,{requiresConfirmation:true});
  state.library.active.default={key:provider.key,modelId:model.id};this.current(state.revision);this.saved(state.library,state.revision,true);
  if(model.lastTest)this.deps.store.set('model:lastTest',JSON.stringify(model.lastTest));else this.deps.store.set('model:lastTest','null');
  this.deps.store.log('model-library-active','使用中模型已切换到 '+provider.key+'/'+model.id);return this.view();
 }
 async test(key:string,id:string,revision:unknown){
  const state=this.current(revision),provider=this.provider(state.library,key),model=this.model(provider,modelId(id)),info=await this.validateModel(provider,model),apiKey=readModelKey(keySlot(provider.provider,provider.baseUrl));if(!apiKey)throw new ModelLibraryError('请先填写 API Key');
  const levels=info?.levels??(model.custom?.reasoning?['off','low','medium','high']:['off']),level=levels.includes('off')?'off':levels[0],started=Date.now();let result:LibraryTest;
  try{const r=await this.service.request(toConfigModel(this.materialize(provider,model)),apiKey,'你是接口验收助手。只输出 MODEL_OK。','请验证当前配置。',{maxTokens:level==='off'?16:2048,reasoning:level},{purpose:'model-test',source:'model-library:'+key});const ok=!['error','aborted'].includes(r.stopReason);result={ok,at:Date.now(),latencyMs:r.latencyMs,provider:provider.provider,id:model.id,input:r.input,output:r.output,callId:r.callId,usage:r.usage,cost:r.cost,pricingStatus:r.pricingStatus,...(ok?{}:{error:safeError(r.errorMessage||'模型返回 '+r.stopReason,apiKey)})};}
  catch(error:any){result={ok:false,at:Date.now(),latencyMs:Date.now()-started,provider:provider.provider,id:model.id,callId:error?.callId,error:safeError(error,apiKey)};}
  // 网络等待期间任何配置变化均不可把旧结果写入新连接；费用仍已独立记账。
  this.current(state.revision);model.lastTest=result;this.saved(state.library,state.revision);if(this.active(state.library,provider,model))this.deps.store.set('model:lastTest',JSON.stringify(result));
  this.deps.store.log('model-test',key+'/'+model.id+(result.ok?' 通过':' 失败'),result.ok?'info':'warn');return {result,library:await this.view()};
 }
 /** 原 PUT /api/model 的同步登记；与 model 写入在同一次设置提交中完成。 */
 saveLegacy(model:PanelModel,expectedModelRevision:unknown,key:string,typed=false){
  const panel=readPanelSettings({tolerant:true}),actual=panel.revisions?.model??0;if(expectedModelRevision!==undefined&&expectedModelRevision!==actual)throw new ModelLibraryError('模型设置已被修改，请重新读取后保存',409,{revision:actual});
  const library=structuredClone(panel.modelLibrary||{version:1,providers:[],active:{}}) as ModelLibrary;let provider=library.providers.find(x=>x.provider===model.provider&&x.baseUrl===model.baseUrl&&(x.api||'')===(model.api||''));
  if(!provider){provider=fromLegacy(model,undefined,model.provider==='custom'?(library.providers.some(x=>x.key==='custom-legacy')?'custom-'+randomUUID().slice(0,8):'custom-legacy'):library.providers.some(x=>x.key===model.provider)?model.provider+'-'+randomUUID().slice(0,8):model.provider);library.providers.push(provider);}
  const index=provider.models.findIndex(x=>x.id===model.id),existing=provider.models[index],next=fromLegacy(model).models[0];if(existing){if(JSON.stringify(existing.params)===JSON.stringify(next.params)&&JSON.stringify(existing.custom)===JSON.stringify(next.custom))next.lastTest=existing.lastTest;provider.models[index]=next;}else provider.models.push(next);
  library.active.default={key:provider.key,modelId:model.id};if(typed)writeModelKey(keySlot(model.provider,model.baseUrl),key);return commitModelLibrary(library,panel.revisions?.modelLibrary??0,model);
 }
}
