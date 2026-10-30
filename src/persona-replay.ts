import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, redact } from './config.js';
import { LlmStore, beijingDate, billingRange } from './llm-store.js';
import { applyMigration } from './migrations.js';
import {runReplyLoop} from './reply-tools.js';
import { parseDraft, type Generator } from './model.js';
import { PersonaService, validatePersona, type Persona } from './persona.js';
import { opening, expressions, hasSteps } from './reply-style.js';
import { validatePromptHints, type ReplySample } from './reply-hints.js';
import { publicResourceOK } from './posting-policy.js';
import type { Store } from './store.js';
import type { Channel, Config, Draft, Event } from './types.js';
import twitterText from 'twitter-text';
import { ModelLibraryService } from './model-library.js';
import { readPanelSettings } from './settings.js';
import { freezeReplayModel,type FrozenReplayModel,type ReplayPrice } from './replay-model.js';

/** 由应用的加法迁移统一注册；模块不另占迁移编号。 */
export const REPLAY_SCHEMA = `
 CREATE TABLE IF NOT EXISTS generation_snapshots(message_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,user_id TEXT NOT NULL,channel TEXT NOT NULL,created_at INTEGER NOT NULL,body_json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS generation_snapshots_scope ON generation_snapshots(account_id,user_id,channel,created_at);
 CREATE TABLE IF NOT EXISTS replay_runs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,status TEXT NOT NULL,settings_json TEXT NOT NULL,persona_json TEXT NOT NULL,baseline_mode TEXT NOT NULL,estimate_json TEXT NOT NULL,summary_json TEXT NOT NULL DEFAULT '{}');
 CREATE INDEX IF NOT EXISTS replay_runs_account ON replay_runs(account_id,created_at,id);
 CREATE TABLE IF NOT EXISTS replay_items(run_id TEXT NOT NULL,message_id TEXT NOT NULL,account_id TEXT NOT NULL,user_id TEXT NOT NULL,channel TEXT NOT NULL,created_at INTEGER NOT NULL,source_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,baseline_json TEXT,candidate_json TEXT,label TEXT,issues_json TEXT NOT NULL DEFAULT '[]',metrics_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'queued',PRIMARY KEY(run_id,message_id));
 CREATE INDEX IF NOT EXISTS replay_items_source ON replay_items(account_id,user_id,channel,message_id);
`;
export type SnapshotInput = { conversation?:unknown; memory?:unknown; hintMeta?:unknown; dailySlot?:unknown; personaRevision?:number; personaId?:string; personaName?:string };
export type ReplayFilter = { from?:string; to?:string; channel?:Channel|'all'; includePrivate?:boolean; tier?:string; limit?:number; order?:'uniform'|'latest' };
export type ReplayBaseline = 'actual'|'saved';
export type ReplayLabel = 'candidate'|'baseline'|'same'|'both-bad';
export const REPLAY_ISSUES = ['off-topic','fabrication','template-opening','too-many-expressions','steps','should-skip','length','other'] as const;
export class ReplayError extends Error { constructor(message:string, public statusCode=400){super(message);} }
const parse = (value:unknown,fallback:any={})=>{try{return typeof value==='string'?JSON.parse(value):fallback;}catch{return fallback;}};
const hash = (value:string)=>createHash('sha256').update(value).digest('hex');
const hasTable = (db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const columns = (db:DatabaseSync,name:string)=>(db.prepare('PRAGMA table_info('+name+')').all() as any[]).map(r=>r.name as string);
const size = (value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');

/** 截断只作用于派生快照；绝不改写实际生产上下文或原文。 */
export function boundedGenerationSnapshot(input:SnapshotInput,maxBytes=16*1024):SnapshotInput & {truncated:boolean} {
 const value:any=JSON.parse(JSON.stringify({...input,truncated:false}));
 const trim=(key:string)=>{
  if(size(value)<=maxBytes)return;
  const current=value[key];
  if(Array.isArray(current)){while(current.length&&size(value)>maxBytes){current.shift();value.truncated=true;}}
  else if(current!==undefined){delete value[key];value.truncated=true;}
 };
 for(const key of ['conversation','memory','hintMeta','dailySlot'])trim(key);
 if(size(value)>maxBytes)return {personaRevision:input.personaRevision,personaId:input.personaId,personaName:input.personaName,truncated:true};
 return value;
}
export function captureGenerationSnapshot(store:Store,event:Event,input:SnapshotInput,now=Date.now()):boolean {
 if(!hasTable(store.db,'generation_snapshots'))return false;
 const row=store.getMessage(event.id,event.accountId??'');
 if(!row||store.forgotten(event.userId,event.accountId??'')||sourceExcluded(store,row))return false;
 store.db.prepare('INSERT INTO generation_snapshots(message_id,account_id,user_id,channel,created_at,body_json) VALUES(?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET body_json=excluded.body_json,created_at=excluded.created_at').run(row.id,row.account_id,row.user_id,row.channel,now,JSON.stringify(boundedGenerationSnapshot(input)));
 return true;
}
export function eraseReplayScope(store:Store,userId:string,accountId:string,before?:number):void {
 for(const table of ['generation_snapshots','replay_items'])if(hasTable(store.db,table))store.db.prepare('DELETE FROM '+table+' WHERE account_id=? AND user_id=?'+(before===undefined?'':' AND created_at<=?')).run(...(before===undefined?[accountId,userId]:[accountId,userId,before]));
}
/** 人工改记忆后旧召回失效；回放永远重新调用当前允许范围的召回。 */
export function invalidateReplayMemory(store:Store,accountId:string,userId:string,channel?:Channel):void {
 if(!hasTable(store.db,'generation_snapshots'))return;
 const affected=new Map<string,Channel|undefined>([[userId,channel]]);
 if(hasTable(store.db,'identity_links')){
  const links=store.db.prepare('SELECT private_user_id,public_user_id FROM identity_links WHERE account_id=? AND (private_user_id=? OR public_user_id=?)').all(accountId,userId,userId) as any[];
  for(const link of links)affected.set(link.private_user_id===userId?link.public_user_id:link.private_user_id,undefined);
 }
 for(const [identity,scope] of affected){
  const privateOnly=scope==='private',args=privateOnly?[accountId,identity,'private']:[accountId,identity];
  const rows=store.db.prepare('SELECT message_id,body_json FROM generation_snapshots WHERE account_id=? AND user_id=?'+(privateOnly?' AND channel=?':'')).all(...args) as any[];
  for(const row of rows){const body=parse(row.body_json);delete body.memory;body.memoryInvalidated=true;store.db.prepare('UPDATE generation_snapshots SET body_json=? WHERE message_id=?').run(JSON.stringify(body),row.message_id);}
  store.db.prepare('DELETE FROM replay_items WHERE account_id=? AND user_id=?'+(privateOnly?' AND channel=?':'')).run(...args);
  for(const visible of privateOnly?['private']:['public','private']){const key=memoryRevisionKey(accountId,identity,visible);store.set(key,String(Number(store.get(key,'0'))+1));}
 }
}
const memoryRevisionKey=(accountId:string,userId:string,channel:string)=>'replay:memory-revision:'+JSON.stringify([accountId,userId,channel]);
export function pruneReplayData(store:Store,before:number):void {
 if(!hasTable(store.db,'generation_snapshots'))return;
 store.db.prepare('DELETE FROM generation_snapshots WHERE created_at<? OR NOT EXISTS(SELECT 1 FROM messages WHERE messages.id=generation_snapshots.message_id AND messages.account_id=generation_snapshots.account_id)').run(before);
 store.db.prepare('DELETE FROM replay_items WHERE created_at<? OR NOT EXISTS(SELECT 1 FROM messages WHERE messages.id=replay_items.message_id AND messages.account_id=replay_items.account_id)').run(before);
}
function sourceExcluded(store:Store,row:any):boolean {
 return store.forgotten(row.user_id,row.account_id)
  || (hasTable(store.db,'memory_ignored')&&!!store.db.prepare('SELECT 1 FROM memory_ignored WHERE account_id=? AND user_id=? AND channel=? AND message_id=?').get(row.account_id,row.user_id,row.channel,row.id));
}
function sourceHash(row:any):string{return hash(JSON.stringify([row.body,row.draft,row.status,row.created_at]));}
function replayDraft(raw:string,channel:Channel):{draft:Draft;validationError?:string} {
 try{return {draft:parseDraft(raw,{channel})};}catch(error){
  // 回放永不发送；结构有效而含禁用内容的模型结果仍需纳入违规指标。
  // 保留与正式解析相同的大小保护，不能借评估入口持久化无限原文。
  if(Buffer.byteLength(raw,'utf8')>128*1024)throw error;
  const value=parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''),null);
  if(!value||value.action!=='reply'||typeof value.text!=='string'||!value.text.trim()||typeof value.reason!=='string'||!/https?:\/\/|www\.|@[a-z0-9_]{1,15}/i.test(value.text))throw error;
  const text=channel==='public'?value.text.trim().normalize('NFC'):value.text.trim();
  if(channel==='public'?!publicResourceOK(text):text.length>4000)throw error;
  return {draft:{action:'reply',text,reason:value.reason.slice(0,300)},validationError:'回复包含禁用链接或账号提及'};
 }
}

export type QualityInput = { action:'reply'|'skip';text:string;channel:Channel;timestamp?:number };
export type QualityMetrics = { total:number;replies:number;skipped:number;skipRate:number;averageLength:number;openingRepeatRate:number;topOpenings:Array<{text:string;count:number}>;kaomojiPerTen:number;emojiPerTen:number;tildePerTen:number;stepsRate:number;forbiddenLinks:number;forbiddenMentions:number;publicLengthViolations:number };
export function qualityMetrics(items:QualityInput[]):QualityMetrics {
 const replies=items.filter(x=>x.action==='reply'),n=replies.length,counts=new Map<string,number>();let length=0,kaomoji=0,emoji=0,tilde=0,steps=0,links=0,mentions=0,long=0;
 for(const item of replies){const text=item.text??'',key=opening(text);counts.set(key,(counts.get(key)??0)+1);length+=Array.from(text).length;const e=expressions(text);kaomoji+=Number(e.kaomoji);emoji+=Number(e.emoji);tilde+=Number(e.tilde);steps+=Number(hasSteps(text));links+=Number(/https?:\/\/|www\./i.test(text));mentions+=Number(/@[a-z0-9_]{1,15}/i.test(text));long+=Number(item.channel==='public'&&twitterText.parseTweet(text.normalize('NFC')).weightedLength>280);}
 // 重复组内全部条目计入，20 条中同一开头出现 6 次即为 30%。
 const repeated=[...counts.values()].filter(c=>c>1).reduce((a,b)=>a+b,0);
 return {total:items.length,replies:n,skipped:items.length-n,skipRate:items.length?(items.length-n)/items.length:0,averageLength:n?length/n:0,openingRepeatRate:n?repeated/n:0,topOpenings:[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5).map(([text,count])=>({text,count})),kaomojiPerTen:n?kaomoji/n*10:0,emojiPerTen:n?emoji/n*10:0,tildePerTen:n?tilde/n*10:0,stepsRate:n?steps/n:0,forbiddenLinks:links,forbiddenMentions:mentions,publicLengthViolations:long};
}
function summaryQuality(items:QualityInput[]) {
 const metrics=qualityMetrics(items),hasPrivate=items.some(item=>item.channel==='private');
 return {...metrics,topOpenings:hasPrivate?qualityMetrics(items.filter(item=>item.channel==='public')).topOpenings:metrics.topOpenings,privateOpeningsHidden:hasPrivate};
}

type FrozenSample = {id:string;hash:string;revision:number};
type ReplayContext = {event:Event;at:number;body:any;hasSnapshot:boolean;memory:unknown;recentReplies:ReplySample[]};
type Prepared = {id:string;accountId:string;at:number;samples:FrozenSample[];filter:ReplayFilter;candidate:Persona;baseline:Persona;baselineMode:ReplayBaseline;personaRevision:number;personaIdentity?:{id:string;name:string;revision:number};libraryBound?:boolean;promptHints:unknown;dailyState:string;config:Config;estimate:any;compare?:'persona'|'model';modelCandidate?:{key:string;modelId:string;reasoningLevel:string};candidateConfig?:Config;frozenModels?:{baseline:FrozenReplayModel;candidate:FrozenReplayModel};assertCurrent?:()=>void;dispose?:()=>void;expiryTimer?:ReturnType<typeof setTimeout>};
export type ReplayModelSelection={key:string;modelId:string;reasoningLevel:string};
type ReplayOptions = {accountId:()=>string;config?:()=>Config;memory?:(userId:string,channel:Channel,accountId:string,at:number,currentEvent?:Event)=>unknown;now?:()=>number;resolveModel?:(selection:ReplayModelSelection)=>Promise<{model:Config['model'];revision:number;selection:ReplayModelSelection}>;modelLibraryRevision?:()=>number;freezeModel?:(config:Config,generator:Generator,valid:()=>void)=>Promise<FrozenReplayModel>};
export class ReplayRunner {
 private estimates=new Map<string,Prepared>();
 private active?:{id:string;accountId:string;controller:AbortController;done:Promise<void>;dispose?:()=>void};
 private ledger:LlmStore;
 private now:()=>number;
 constructor(public store:Store,public persona:PersonaService,public generator:Generator,public options:ReplayOptions){
  this.ledger=new LlmStore(store);this.now=options.now??Date.now;
  applyMigration(store.db,11,'人设回放快照与隔离批次',REPLAY_SCHEMA);
  store.registerForgetHandler((userId,accountId,before)=>eraseReplayScope(store,userId,accountId,before));
  store.replayForgetLedger();
  store.db.prepare("UPDATE replay_runs SET status='interrupted',updated_at=? WHERE status IN ('queued','running')").run(this.now());
  store.db.prepare("UPDATE replay_items SET status='interrupted' WHERE status='running'").run();
  this.purgeMissingSources();
 }
 private selectedPersona(id:unknown){if(id===undefined)return {...this.persona.get(),identity:this.persona.activeIdentity(),libraryBound:false};if(typeof id!=='string')throw new ReplayError('人设标识无效');const item=this.persona.library.detail(id);return {persona:item.persona,revision:item.revision,identity:{id:item.id,name:item.name,revision:item.revision},libraryBound:true};}
 private personaIdentityView(value:any){if(!value)return {id:null,name:'未记录',revision:null,deleted:false};let deleted=false;try{this.persona.library.detail(value.id);}catch(error:any){deleted=error?.statusCode===404;}return {...value,deleted};}
 private account():string {const id=this.options.accountId();if(!id||id==='unknown')throw new ReplayError('当前工作账号尚未确认',409);return id;}
 private ensureAccount(expected:string){if(this.account()!==expected)throw new ReplayError('工作账号已变化，回放已停止',409);}
 private allowed(row:any,accountId:string):boolean{return !!row&&row.account_id===accountId&&!sourceExcluded(this.store,row);}
 private purgeMissingSources(){
  const rows=this.store.db.prepare('SELECT run_id,message_id,account_id,user_id,channel FROM replay_items').all() as any[];
  for(const item of rows)if(!this.allowed(this.store.getMessage(item.message_id,item.account_id),item.account_id))this.store.db.prepare('DELETE FROM replay_items WHERE run_id=? AND message_id=?').run(item.run_id,item.message_id);
  const snapshots=this.store.db.prepare('SELECT message_id,account_id FROM generation_snapshots').all() as any[];
  for(const row of snapshots)if(!this.allowed(this.store.getMessage(row.message_id,row.account_id),row.account_id))this.store.db.prepare('DELETE FROM generation_snapshots WHERE message_id=?').run(row.message_id);
 }
 samples(filter:ReplayFilter={}):{items:any[];excluded:number;totalEligible:number;filter:ReplayFilter} {
  const accountId=this.account(),limit=filter.limit??20;
  if(!Number.isInteger(limit)||limit<1||limit>50)throw new ReplayError('每次回放需要 1 至 50 条样本');
  if(filter.channel!==undefined&&!['all','public','private'].includes(filter.channel))throw new ReplayError('回放渠道无效');
  if(filter.order!==undefined&&!['uniform','latest'].includes(filter.order))throw new ReplayError('抽样顺序无效');
  if(filter.channel==='private'&&filter.includePrivate!==true)throw new ReplayError('选取私信必须单独确认');
  if(filter.tier!==undefined&&(typeof filter.tier!=='string'||filter.tier.length>32))throw new ReplayError('分级无效');
  const range=filter.from||filter.to?billingRange(filter.from,filter.to,this.now()):{start:0,end:this.now()+1};
  const args:(string|number)[]=[accountId,range.start,range.end];let where="account_id=? AND created_at>=? AND created_at<? AND status IN ('confirmed','draft','skipped')";
  if(filter.channel&&filter.channel!=='all'){where+=' AND channel=?';args.push(filter.channel);}else if(filter.includePrivate!==true)where+=" AND channel='public'";
  if(filter.tier){if(!columns(this.store.db,'messages').includes('tier'))throw new ReplayError('当前消息尚无分级数据');where+=' AND tier=?';args.push(filter.tier);}
  // 最多扫描一个有界候选池；不会把整个历史库装入回放进程。
  const rows=this.store.db.prepare('SELECT * FROM messages WHERE '+where+' ORDER BY created_at DESC,id DESC LIMIT 10000').all(...args) as any[],allowed=rows.filter(row=>this.allowed(row,accountId));
  const selected=filter.order==='latest'||allowed.length<=limit?allowed.slice(0,limit):Array.from({length:limit},(_,i)=>allowed[Math.floor(i*(allowed.length-1)/(limit-1||1))]);
  return {items:selected.map(row=>this.sampleView(row)),excluded:rows.length-allowed.length,totalEligible:allowed.length,filter:{...filter,limit}};
 }
 private sampleView(row:any,privateDetail=false){
  const body=parse(row.body),snapshot=this.store.db.prepare('SELECT body_json FROM generation_snapshots WHERE message_id=? AND account_id=?').get(row.id,row.account_id) as any;
  return {id:row.id,channel:row.channel,timestamp:row.created_at,tier:row.tier??null,status:row.status,revision:row.updated_at,contextIncomplete:!snapshot||!!parse(snapshot.body_json).truncated,private:row.channel==='private',...(row.channel==='public'||privateDetail?{message:{text:body.text??'',handle:body.handle??'',url:body.url??''},actual:parse(row.draft,null)}:{collapsed:true})};
 }
 private averageRounds(config:Config,accountId:string):number {
  const rows=this.store.db.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE account_id=? AND provider=? AND model=? AND purpose='reply' AND interaction_id IS NOT NULL AND started_at>=? GROUP BY interaction_id").all(accountId,config.model.provider,config.model.id,this.now()-7*86400000) as {n:number}[];
  return rows.length?Math.max(1,Math.min(21,rows.reduce((n,r)=>n+r.n,0)/rows.length)):2;
 }
 private costEstimate(config:Config,accountId:string,count:number,_candidate:Persona,_baseline:Persona,mode:ReplayBaseline){
  const rounds=this.averageRounds(config,accountId),side=()=>({reply:Math.ceil(count*rounds),semantic:0});
  const candidateRequests=side(),baselineRequests=mode==='saved'?side():{reply:0,semantic:0},requests=candidateRequests.reply+baselineRequests.reply;
  const rows=this.store.db.prepare("SELECT cost_json,pricing_status FROM llm_calls WHERE account_id=? AND provider=? AND model=? AND purpose='reply' ORDER BY started_at DESC LIMIT 50").all(accountId,config.model.provider,config.model.id) as any[];
  const known=rows.filter(r=>r.pricing_status==='priced'&&Number.isFinite(parse(r.cost_json,null)?.total)),mean=known.length?known.reduce((n,r)=>n+parse(r.cost_json).total,0)/known.length:null;
  return {samples:count,requests,candidateRequests,baselineRequests,averageRounds:rounds,estimatedUsd:mean===null?null:requests*mean,pricingStatus:mean===null?(rows.some(r=>r.pricing_status==='unpriced')?'unpriced':'unknown'):'estimated',priceSource:'Pi 内置价格快照与近七天回复的平均轮数',note:'按平均轮数估算；读取卡片会增加请求，同轮读取多张只增加一轮。每侧每条最多 21 次；未定价或无历史不代表免费。'};
 }
 estimate(raw:any):any {
  if(!raw||typeof raw!=='object')throw new ReplayError('回放参数无效');
  if(raw.compare!==undefined&&!['persona','model'].includes(raw.compare))throw new ReplayError('比较对象无效');
  if(raw.compare==='model')return this.estimateModel(raw);
  const accountId=this.account(),current=this.selectedPersona(raw.personaId),candidate=validatePersona(raw.persona??current.persona),baselineMode=raw.baselineMode??'actual';
  if(!['actual','saved'].includes(baselineMode))throw new ReplayError('基线模式无效');
  if(!Number.isInteger(raw.personaRevision)||raw.personaRevision!==current.revision)throw new ReplayError('人设修订已变化，请重新读取',409);
  if(raw.promptHints!==undefined){if(size(raw.promptHints)>4096)throw new ReplayError('动态提醒设置无效');validatePromptHints(raw.promptHints);}
  const selected=this.samples(raw.filter??{}),samples=selected.items.map(item=>{const row=this.store.getMessage(item.id,accountId)!;return {id:row.id,hash:sourceHash(row),revision:row.updated_at};});
  if(!samples.length)throw new ReplayError('没有符合条件且允许回放的消息');
  const config=structuredClone((this.options.config??loadConfig)()),estimate=this.costEstimate(config,accountId,samples.length,candidate,current.persona,baselineMode),id=randomUUID(),dailyState=typeof raw.dailyState==='string'?raw.dailyState:'回放模拟日程：在家阅读与休息，非真实活动';
  if(dailyState.length>8000)throw new ReplayError('模拟日程不能超过 8,000 字符');
  const prepared:Prepared={id,accountId,at:this.now(),samples,filter:selected.filter,candidate,baseline:current.persona,baselineMode,personaRevision:current.revision,personaIdentity:current.identity,libraryBound:current.libraryBound,promptHints:validatePromptHints(raw.promptHints??config.promptHints??{}),dailyState,config,estimate};
  for(const [key,value] of this.estimates)if(this.now()-value.at>600000)this.dropEstimate(key);
  if(this.estimates.size>=20)this.dropEstimate(this.estimates.keys().next().value!);
  this.estimates.set(id,prepared);
  return {estimateId:id,expiresAt:prepared.at+600000,...estimate,compare:'persona',personaIdentity:current.identity,samples:selected.items,excluded:selected.excluded,requiresConfirmation:true};
 }
 private dropEstimate(id:string){const prepared=this.estimates.get(id);if(prepared){clearTimeout(prepared.expiryTimer);prepared.dispose?.();this.estimates.delete(id);}}
 cancelEstimate(id:string){const prepared=this.estimates.get(id);if(!prepared||prepared.accountId!==this.account())throw new ReplayError('费用预估不存在或已过期',404);this.dropEstimate(id);return {ok:true};}
 private tokenMean(config:Config,purpose:string,accountId:string){
  const rows=this.store.db.prepare("SELECT input_tokens,output_tokens,cache_read,cache_write FROM llm_calls WHERE account_id=? AND provider=? AND model=? AND purpose=? AND usage_known=1 ORDER BY started_at DESC LIMIT 50").all(accountId,config.model.provider,config.model.id,purpose) as any[];
  if(!rows.length)return null;
  return {input:rows.reduce((n,r)=>n+(r.input_tokens??0),0)/rows.length,output:rows.reduce((n,r)=>n+(r.output_tokens??0),0)/rows.length,cacheRead:rows.reduce((n,r)=>n+(r.cache_read??0),0)/rows.length,cacheWrite:rows.reduce((n,r)=>n+(r.cache_write??0),0)/rows.length};
 }
 private priceEstimate(config:Config,price:ReplayPrice,requests:number,tokens:ReturnType<ReplayRunner['tokenMean']>){
  const cost=price.known&&tokens?[tokens.input*(price.input??0),tokens.output*(price.output??0),tokens.cacheRead*(price.cacheRead??0),tokens.cacheWrite*(price.cacheWrite??0)].reduce((a,b)=>a+b,0)/1000000*requests:null;
  return {model:{provider:config.model.provider,id:config.model.id,reasoningLevel:config.model.reasoningLevel},requests,replyRequests:requests,routingRequests:0,estimatedUsd:requests===0?0:cost,pricingStatus:requests===0?'not-needed':!price.known?'unpriced':cost===null?'unknown':'estimated',price};
 }
 private async estimateModel(raw:any){
  const current=this.selectedPersona(raw.personaId),saved=validatePersona(current.persona),candidate=validatePersona(raw.persona??saved);
  if(JSON.stringify(candidate)!==JSON.stringify(saved))throw new ReplayError('比较模型设置时请保持人设未改，一次只比较一个变量');
  if(raw.baselineMode!=='saved')throw new ReplayError('比较模型设置必须使用已保存人设重新生成基线');
  const initial=structuredClone((this.options.config??loadConfig)());
  if(raw.promptHints!==undefined&&JSON.stringify(validatePromptHints(raw.promptHints))!==JSON.stringify(validatePromptHints(initial.promptHints??{})))throw new ReplayError('比较模型设置时请保持已保存的动态提醒设置');
  if(!raw.modelCandidate||typeof raw.modelCandidate.key!=='string'||typeof raw.modelCandidate.modelId!=='string'||typeof raw.modelCandidate.reasoningLevel!=='string')throw new ReplayError('请选择候选服务商、模型和推理档位');
  const selection:ReplayModelSelection={key:raw.modelCandidate.key,modelId:raw.modelCandidate.modelId,reasoningLevel:raw.modelCandidate.reasoningLevel};
  const existing=this.estimate({...raw,compare:'persona',persona:saved,promptHints:initial.promptHints??{}}),prepared=this.estimates.get(existing.estimateId)!;
  let baseline:FrozenReplayModel|undefined,candidateModel:FrozenReplayModel|undefined;
  try{
   const resolved=await (this.options.resolveModel??(value=>new ModelLibraryService({store:this.store}).resolveSelection(value as any)))(selection);
   const revision=()=>this.options.modelLibraryRevision?.()??readPanelSettings().revisions?.modelLibrary??0;
   const modelStamp=hash(JSON.stringify(initial.model));
   const valid=()=>{if(revision()!==resolved.revision||hash(JSON.stringify((this.options.config??loadConfig)().model))!==modelStamp)throw new ReplayError('模型库或使用中的模型已变化，请重新预估',409);};
   valid();this.ensureAccount(prepared.accountId);
   const candidateConfig={...structuredClone(prepared.config),model:structuredClone(resolved.model)},freeze=this.options.freezeModel??freezeReplayModel;
   baseline=await freeze(prepared.config,this.generator,valid);candidateModel=await freeze(candidateConfig,this.generator,valid);valid();
   const count=prepared.samples.length,baselineRounds=this.averageRounds(prepared.config,prepared.accountId),candidateRounds=this.averageRounds(candidateConfig,prepared.accountId),baselineTokens=this.tokenMean(prepared.config,'reply',prepared.accountId),candidateTokens=this.tokenMean(candidateConfig,'reply',prepared.accountId)??baselineTokens;
   const sides={baseline:this.priceEstimate(prepared.config,baseline.price,Math.ceil(count*baselineRounds),baselineTokens),candidate:this.priceEstimate(candidateConfig,candidateModel.price,Math.ceil(count*candidateRounds),candidateTokens),shared:this.priceEstimate(prepared.config,baseline.price,0,null)};
   sides.shared.replyRequests=0;sides.shared.routingRequests=0;
   const all=Object.values(sides),estimate={samples:count,requests:sides.baseline.requests+sides.candidate.requests,estimatedUsd:all.every(side=>side.estimatedUsd!==null)?all.reduce((n,side)=>n+(side.estimatedUsd??0),0):null,pricingStatus:all.some(side=>side.pricingStatus==='unpriced')?'unpriced':all.some(side=>side.pricingStatus==='unknown')?'unknown':'estimated',sides,note:'两侧各按冻结的 Pi 目录价格和历史 token 均值估算；两侧各自读取卡片；按平均轮数估算，同轮读多张只增加一轮，每侧每条最多 21 次，未定价不代表免费'};
   prepared.compare='model';prepared.modelCandidate=resolved.selection;prepared.candidateConfig=candidateConfig;prepared.frozenModels={baseline,candidate:candidateModel};prepared.assertCurrent=()=>{valid();baseline!.assertCurrent();candidateModel!.assertCurrent();};prepared.dispose=()=>{baseline?.dispose();candidateModel?.dispose();};prepared.estimate=estimate;
   prepared.expiryTimer=setTimeout(()=>this.dropEstimate(prepared.id),600000);prepared.expiryTimer.unref?.();
   return {...existing,...estimate,compare:'model',modelCandidate:resolved.selection};
  }catch(error){baseline?.dispose();candidateModel?.dispose();this.dropEstimate(prepared.id);throw error;}
 }
 start(estimateId:string,confirmed:boolean){
  if(confirmed!==true)throw new ReplayError('回放会产生费用，需明确确认');
  if(this.active)throw new ReplayError('已有回放正在运行，请先等待或中止',409);
  const prepared=this.estimates.get(estimateId);if(!prepared||this.now()-prepared.at>600000){this.dropEstimate(estimateId);throw new ReplayError('费用预估已过期，请重新预估',410);}
  try{
   prepared.assertCurrent?.();this.ensureAccount(prepared.accountId);
   if(this.selectedPersona(prepared.libraryBound?prepared.personaIdentity?.id:undefined).revision!==prepared.personaRevision)throw new ReplayError('人设修订已变化，请重新预估',409);
   for(const sample of prepared.samples){const row=this.store.getMessage(sample.id,prepared.accountId);if(!this.allowed(row,prepared.accountId)||sourceHash(row)!==sample.hash)throw new ReplayError('样本已变化或移除，请重新预估',409);}
  }catch(error){this.dropEstimate(estimateId);throw new ReplayError(error instanceof Error?error.message:'模型配置已变化，请重新预估',409);}
  const id=randomUUID(),now=this.store.nextTimestamp(this.now());
  const modelSnapshot=(model:Config['model'])=>({provider:model.provider,id:model.id,api:model.api,reasoning:model.reasoning,reasoningLevel:model.reasoningLevel,custom:model.custom,baseUrlHost:(()=>{try{return new URL(model.baseUrl).hostname;}catch{return '';}})()});
  const settings={filter:prepared.filter,personaRevision:prepared.libraryBound?-1:prepared.personaRevision,personaItemRevision:prepared.libraryBound?prepared.personaRevision:undefined,personaIdentity:prepared.personaIdentity,personaLibraryBound:prepared.libraryBound,promptHints:prepared.promptHints,dailyState:prepared.dailyState,model:{provider:prepared.config.model.provider,id:prepared.config.model.id},baseline:prepared.baseline,compare:prepared.compare??'persona',modelCandidate:prepared.modelCandidate,models:prepared.compare==='model'?{baseline:modelSnapshot(prepared.config.model),candidate:modelSnapshot(prepared.candidateConfig!.model)}:undefined};
  this.store.db.exec('BEGIN IMMEDIATE');
  try{
   this.store.db.prepare("INSERT INTO replay_runs(id,account_id,created_at,updated_at,status,settings_json,persona_json,baseline_mode,estimate_json) VALUES(?,?,?,?,?,?,?,?,?)").run(id,prepared.accountId,now,now,'queued',JSON.stringify(settings),JSON.stringify(prepared.candidate),prepared.baselineMode,JSON.stringify(prepared.estimate));
   for(const sample of prepared.samples){const row=this.store.getMessage(sample.id,prepared.accountId)!;this.store.db.prepare('INSERT INTO replay_items(run_id,message_id,account_id,user_id,channel,created_at,source_revision,source_hash) VALUES(?,?,?,?,?,?,?,?)').run(id,row.id,row.account_id,row.user_id,row.channel,row.created_at,sample.revision,sample.hash);}
   this.store.db.exec('COMMIT');
  }catch(error){this.store.db.exec('ROLLBACK');throw error;}
  clearTimeout(prepared.expiryTimer);this.estimates.delete(estimateId);
  const controller=new AbortController(),active={id,accountId:prepared.accountId,controller,done:Promise.resolve(),dispose:prepared.dispose};this.active=active;
  active.done=this.execute(id,prepared,controller.signal).finally(()=>{prepared.dispose?.();if(this.active===active)this.active=undefined;});
  this.store.log('persona-replay-start',JSON.stringify({runId:id,accountId:prepared.accountId,samples:prepared.samples.length,requests:prepared.estimate.requests}));
  return {id,status:'queued',estimate:prepared.estimate};
 }
 private replayContext(sample:any,prepared:Prepared):ReplayContext {
  const event=parse(sample.body) as Event,at=Number.isFinite(event.timestamp)?event.timestamp+60000:sample.created_at+60000;
  const snapshot=this.store.db.prepare('SELECT body_json FROM generation_snapshots WHERE message_id=? AND account_id=?').get(sample.id,prepared.accountId) as any,body=parse(snapshot?.body_json);
  // 快照中的旧记忆永不作为召回；人工删除/修订后只能看到当前允许的内容。
  const memory=this.options.memory?.(sample.user_id,sample.channel,prepared.accountId,at,event)??{memories:[],recent:[],experiences:[]};
  // 风格样本也重新检查当前来源；不把快照中已遗忘用户的开头重新带入提示词。
  const styleRows=this.store.db.prepare("SELECT * FROM messages WHERE account_id=? AND created_at<=? AND status IN ('confirmed','draft') AND (channel='public' OR (?='private' AND channel='private' AND json_extract(body,'$.conversationId')=?)) ORDER BY created_at DESC,id DESC LIMIT 50").all(prepared.accountId,at,sample.channel,event.conversationId??'') as any[];
  const recentReplies:ReplySample[]=styleRows.filter(row=>row.id!==sample.id&&this.allowed(row,prepared.accountId)).flatMap(row=>{const draft=parse(row.draft);return draft.action==='reply'&&typeof draft.text==='string'?[{text:draft.text,channel:row.channel,conversationId:parse(row.body).conversationId,accountId:row.account_id,at:row.created_at}]:[];}).slice(0,20);
  return {event,at,body,hasSnapshot:!!snapshot,memory:structuredClone(memory),recentReplies};
 }
 private async assembleSide(runId:string,sample:any,prepared:Prepared,persona:Persona,side:'baseline'|'candidate',signal:AbortSignal,context:ReplayContext){
  const {event,at,body,memory,recentReplies}=context,config=side==='candidate'?prepared.candidateConfig??prepared.config:prepared.config,generator=prepared.frozenModels?.[side].generator??this.generator;
  return this.persona.assemble({config,persona,message:event.text,channel:sample.channel,quote:event.quote,card:event.card,accountId:prepared.accountId,conversation:body.conversation??[],memory,dailyState:prepared.dailyState,now:at,timestamp:event.timestamp,timestampReliable:event.timestampReliable,conversationId:event.conversationId,promptHints:side==='candidate'?prepared.promptHints as any:prepared.config.promptHints,recentReplies,sampleSource:'replay-current-allowed-history',sessionId:'replay-'+runId+'-'+hash(sample.id).slice(0,16)+(prepared.compare==='model'?'-shared':'-'+side),interactionId:runId,routingPurpose:'persona-replay',routingSource:'panel-replay',routingSide:prepared.compare==='model'?'shared':side,generator,signal});
 }
 private async generateSide(runId:string,sample:any,prepared:Prepared,persona:Persona,side:'baseline'|'candidate',signal:AbortSignal,privacyRevision:string,context:ReplayContext){
  const memoryRevision=()=>this.store.get(memoryRevisionKey(prepared.accountId,sample.user_id,sample.channel),'0');
  const latest=this.store.getMessage(sample.id,prepared.accountId);
  if(!this.allowed(latest,prepared.accountId)||sourceHash(latest)!==sourceHash(sample)||memoryRevision()!==privacyRevision)throw new ReplayError('来源或记忆已变化或移除',410);
  prepared.assertCurrent?.();
  const {body}=context,config=side==='candidate'?prepared.candidateConfig??prepared.config:prepared.config,generator=prepared.frozenModels?.[side].generator??this.generator;
  const sessionId='replay-'+runId+'-'+hash(sample.id).slice(0,16)+'-'+side;
  const assembled=await this.assembleSide(runId,sample,prepared,persona,side,signal,context);
  if(signal.aborted)throw signal.reason??new Error('回放已中止');
  this.ensureAccount(prepared.accountId);
  const current=this.store.getMessage(sample.id,prepared.accountId);
  if(!this.allowed(current,prepared.accountId)||sourceHash(current)!==sourceHash(sample)||memoryRevision()!==privacyRevision)throw new ReplayError('来源或记忆已变化或移除',410);
  const result=await runReplyLoop({generator,config,system:assembled.system,user:assembled.user,cards:assembled.cards,signal,sessionId,metadata:{purpose:'persona-replay',source:'panel-replay',side,accountId:prepared.accountId,channel:sample.channel,interactionId:runId,jsonObject:true}});
  const parsed=replayDraft(result.text,sample.channel),draft=parsed.draft,lengthViolation=draft.action==='reply'&&sample.channel==='public'&&twitterText.parseTweet(draft.text).weightedLength>280;
  return {draft,validationError:parsed.validationError,lengthViolation,contextIncomplete:!context.hasSnapshot||!!body.truncated,warning:assembled.warning,hits:result.hits,finalTool:result.finalTool,toolCalls:result.toolCalls,toolLimit:result.toolLimit,callIds:result.calls.map(c=>c.callId),callId:result.callId??null};
 }
 private async execute(id:string,prepared:Prepared,signal:AbortSignal):Promise<void>{
  this.store.db.prepare("UPDATE replay_runs SET status='running',updated_at=? WHERE id=?").run(this.now(),id);
  let final='completed';
  try{
   for(const frozen of prepared.samples){
    if(signal.aborted){final='aborted';break;}
    this.ensureAccount(prepared.accountId);
    const row=this.store.getMessage(frozen.id,prepared.accountId),item=this.store.db.prepare('SELECT 1 FROM replay_items WHERE run_id=? AND message_id=?').get(id,frozen.id);
    if(!item||!this.allowed(row,prepared.accountId)||sourceHash(row)!==frozen.hash){this.store.db.prepare('DELETE FROM replay_items WHERE run_id=? AND message_id=?').run(id,frozen.id);continue;}
    const epoch=this.store.epoch(row.user_id,prepared.accountId),privacyRevision=this.store.get(memoryRevisionKey(prepared.accountId,row.user_id,row.channel),'0');
    this.store.db.prepare("UPDATE replay_items SET status='running' WHERE run_id=? AND message_id=?").run(id,row.id);
    let baseline:any=null,candidate:any=null,status='completed',invalidModel=false;
    try{
     const context=this.replayContext(row,prepared);
     prepared.assertCurrent?.();
     if(prepared.baselineMode==='actual')baseline={draft:parse(row.draft,{action:'skip',text:'',reason:'历史结果缺失'}),actual:true,contextIncomplete:true};
     else baseline=await this.generateSide(id,row,prepared,prepared.baseline,'baseline',signal,privacyRevision,context);
     if(signal.aborted)throw signal.reason??new Error('回放已中止');
     candidate=await this.generateSide(id,row,prepared,prepared.candidate,'candidate',signal,privacyRevision,context);
    }catch(error){
     status=signal.aborted?'aborted':'failed';candidate={error:signal.aborted?'回放已中止':redact(error instanceof Error?error.message:error).slice(0,300)};
     if(prepared.compare==='model')try{prepared.assertCurrent?.();}catch{invalidModel=true;final='failed';}
    }
    const current=this.store.getMessage(row.id,prepared.accountId);
    if(this.options.accountId()!==prepared.accountId||!this.allowed(current,prepared.accountId)||sourceHash(current)!==frozen.hash||this.store.epoch(row.user_id,prepared.accountId)!==epoch||this.store.get(memoryRevisionKey(prepared.accountId,row.user_id,row.channel),'0')!==privacyRevision){this.store.db.prepare('DELETE FROM replay_items WHERE run_id=? AND message_id=?').run(id,row.id);if(this.options.accountId()!==prepared.accountId){final='aborted';break;}continue;}
    const metrics={baseline:baseline?.draft?qualityMetrics([{...baseline.draft,channel:row.channel}]):null,candidate:candidate?.draft?qualityMetrics([{...candidate.draft,channel:row.channel}]):null};
    this.store.db.prepare('UPDATE replay_items SET baseline_json=?,candidate_json=?,metrics_json=?,status=? WHERE run_id=? AND message_id=?').run(JSON.stringify(baseline),JSON.stringify(candidate),JSON.stringify(metrics),status,id,row.id);
    this.store.db.prepare('UPDATE replay_runs SET updated_at=? WHERE id=?').run(this.now(),id);
    if(invalidModel)break;
    if(signal.aborted){final='aborted';break;}
   }
  }catch(error){final=signal.aborted||this.options.accountId()!==prepared.accountId?'aborted':'failed';this.store.log('persona-replay-error',JSON.stringify({runId:id,reason:final}),'warn');}
  if(signal.aborted)final='aborted';
  this.store.db.prepare("UPDATE replay_items SET status=? WHERE run_id=? AND status IN ('running','queued')").run(final==='completed'?'interrupted':final,id);
  const summary=this.summary(id,prepared.accountId);
  this.store.db.prepare('UPDATE replay_runs SET status=?,updated_at=?,summary_json=? WHERE id=?').run(final,this.now(),JSON.stringify(summary),id);
  this.trimRuns(prepared.accountId);
  this.store.log('persona-replay-end',JSON.stringify({runId:id,status:final}));
 }
 async waitIdle(){await this.active?.done;}
 abort(id:string){const run=this.runRow(id);if(this.active?.id===id){this.active.controller.abort(new Error('管理员中止回放'));this.active.dispose?.();}return {id:run.id,status:this.active?.id===id?'aborting':run.status};}
 private runRow(id:string){const row=this.store.db.prepare('SELECT * FROM replay_runs WHERE id=? AND account_id=?').get(id,this.account()) as any;if(!row)throw new ReplayError('回放记录不存在',404);return row;}
 private trimRuns(accountId:string){const rows=this.store.db.prepare('SELECT id FROM replay_runs WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 20').all(accountId) as any[];for(const row of rows){this.store.db.prepare('DELETE FROM replay_items WHERE run_id=?').run(row.id);this.store.db.prepare('DELETE FROM replay_runs WHERE id=?').run(row.id);}}
 private summary(id:string,accountId:string){
  const rows=(this.store.db.prepare('SELECT * FROM replay_items WHERE run_id=? AND account_id=?').all(id,accountId) as any[]).filter(row=>this.allowed(this.store.getMessage(row.message_id,accountId),accountId)),labels:Record<string,number>={candidate:0,baseline:0,same:0,'both-bad':0},issues:Record<string,number>={},baseline:QualityInput[]=[],candidate:QualityInput[]=[];
  for(const row of rows){if(row.label)labels[row.label]=(labels[row.label]??0)+1;for(const issue of parse(row.issues_json,[]))issues[issue]=(issues[issue]??0)+1;const b=parse(row.baseline_json,null)?.draft,c=parse(row.candidate_json,null)?.draft;if(b)baseline.push({...b,channel:row.channel});if(c)candidate.push({...c,channel:row.channel});}
  const side=(value:'baseline'|'candidate'|'shared')=>{const result=this.store.db.prepare("SELECT COUNT(*) AS calls,AVG(latency_ms) AS averageLatencyMs,COALESCE(SUM(input_tokens),0) AS input,COALESCE(SUM(output_tokens),0) AS output,COALESCE(SUM(cache_read),0) AS cacheRead,SUM(CASE WHEN pricing_status='priced' AND json_valid(cost_json) THEN json_extract(cost_json,'$.total') END) AS costUSD,SUM(CASE WHEN pricing_status='priced' THEN 1 ELSE 0 END) AS priced,SUM(CASE WHEN pricing_status='unpriced' THEN 1 ELSE 0 END) AS unpriced,SUM(CASE WHEN pricing_status='unknown' THEN 1 ELSE 0 END) AS unknown FROM llm_calls WHERE account_id=? AND interaction_id=? AND purpose='persona-replay' AND source=?").get(accountId,id,'panel-replay:'+value) as any;const column=value==='baseline'?'baseline_json':value==='candidate'?'candidate_json':null,cardsRead=column?Number((this.store.db.prepare("SELECT COALESCE(SUM(CASE WHEN json_valid("+column+") THEN json_array_length("+column+",'$.hits') END),0) AS n FROM replay_items WHERE run_id=?").get(id) as any)?.n??0):0;return {...result,cardsRead,priced:result.priced??0,unpriced:result.unpriced??0,unknown:result.unknown??0};};
  return {total:rows.length,completed:rows.filter(r=>r.status==='completed').length,failed:rows.filter(r=>r.status==='failed').length,labels,issues,baseline:summaryQuality(baseline),candidate:summaryQuality(candidate),sides:{baseline:side('baseline'),candidate:side('candidate'),shared:side('shared')},fees:this.ledger.summary({accountId,interactionId:id}).totals};
 }
 list(){const accountId=this.account();this.purgeMissingSources();return {items:(this.store.db.prepare('SELECT id,created_at,updated_at,status,baseline_mode,estimate_json,settings_json FROM replay_runs WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(accountId) as any[]).map(row=>({id:row.id,createdAt:row.created_at,updatedAt:row.updated_at,status:row.status,baselineMode:row.baseline_mode,compare:parse(row.settings_json).compare??'persona',modelCandidate:parse(row.settings_json).modelCandidate,personaIdentity:this.personaIdentityView(parse(row.settings_json).personaIdentity),canAdopt:parse(row.settings_json).compare!=='model',estimate:parse(row.estimate_json),summary:this.summary(row.id,accountId)}))};}
 detail(id:string){const run=this.runRow(id);this.purgeMissingSources();const settings=parse(run.settings_json);return {id,status:run.status,createdAt:run.created_at,updatedAt:run.updated_at,baselineMode:run.baseline_mode,compare:settings.compare??'persona',modelCandidate:settings.modelCandidate,personaIdentity:this.personaIdentityView(settings.personaIdentity),canAdopt:settings.compare!=='model',persona:parse(run.persona_json),personaRevision:settings.personaItemRevision??settings.personaRevision,estimate:parse(run.estimate_json),summary:this.summary(id,run.account_id),items:(this.store.db.prepare('SELECT * FROM replay_items WHERE run_id=? ORDER BY created_at,message_id').all(id) as any[]).map(row=>row.channel==='private'?{id:row.message_id,channel:'private',status:row.status,label:row.label,issues:parse(row.issues_json,[]),collapsed:true}:this.itemView(row))};}
 private itemView(row:any){const source=this.store.getMessage(row.message_id,row.account_id);if(!this.allowed(source,row.account_id))throw new ReplayError('来源已移除',410);return {...this.sampleView(source,true),status:row.status,baseline:parse(row.baseline_json,null),candidate:parse(row.candidate_json,null),label:row.label,issues:parse(row.issues_json,[]),metrics:parse(row.metrics_json)};}
 item(id:string,messageId:string){const run=this.runRow(id),row=this.store.db.prepare('SELECT * FROM replay_items WHERE run_id=? AND message_id=? AND account_id=?').get(id,messageId,run.account_id) as any;if(!row)throw new ReplayError('回放条目不存在或已移除',404);return this.itemView(row);}
 label(id:string,messageId:string,label:unknown,issues:unknown){
  const run=this.runRow(id);if(!['candidate','baseline','same','both-bad'].includes(String(label))||!Array.isArray(issues)||issues.length>REPLAY_ISSUES.length||issues.some(issue=>!(REPLAY_ISSUES as readonly string[]).includes(issue)))throw new ReplayError('标记或问题类别无效');
  this.item(id,messageId);this.store.db.prepare('UPDATE replay_items SET label=?,issues_json=? WHERE run_id=? AND message_id=? AND account_id=?').run(String(label),JSON.stringify([...new Set(issues)]),id,messageId,run.account_id);return {ok:true,summary:this.summary(id,run.account_id)};
 }
 delete(id:string){this.runRow(id);if(this.active?.id===id)throw new ReplayError('请先中止运行，再删除记录',409);this.store.db.prepare('DELETE FROM replay_items WHERE run_id=?').run(id);this.store.db.prepare('DELETE FROM replay_runs WHERE id=?').run(id);return {ok:true};}
 adopt(id:string){const run=this.runRow(id),settings=parse(run.settings_json);if(settings.compare==='model')throw new ReplayError('模型对比不能一键采用，请前往模型设置',409);if(run.status==='running'||run.status==='queued')throw new ReplayError('回放尚未结束',409);if(settings.personaLibraryBound)return this.persona.library.save(settings.personaIdentity?.id,{persona:parse(run.persona_json),revision:settings.personaItemRevision??settings.personaRevision});return this.persona.save(parse(run.persona_json),settings.personaRevision);}
 quality(filter:ReplayFilter={}){
  const accountId=this.account(),range=billingRange(filter.from??beijingDate(this.now()-6*86400000),filter.to??beijingDate(this.now()+86400000),this.now());
  if(filter.channel!==undefined&&!['all','public','private'].includes(filter.channel))throw new ReplayError('统计渠道无效');
  const args:(string|number)[]=[accountId,range.start,range.end];let where="account_id=? AND created_at>=? AND created_at<? AND status IN ('confirmed','skipped')";if(filter.channel&&filter.channel!=='all'){where+=' AND channel=?';args.push(filter.channel);}
  const rows=this.store.db.prepare('SELECT * FROM messages WHERE '+where+' ORDER BY created_at,id').all(...args) as any[],all:QualityInput[]=[],daily=new Map<string,QualityInput[]>();
  for(const row of rows){if(!this.allowed(row,accountId))continue;const draft=parse(row.draft,null);if(!draft||!['reply','skip'].includes(draft.action))continue;const item={action:draft.action,text:draft.text??'',channel:row.channel,timestamp:row.created_at},date=beijingDate(row.created_at);all.push(item);const group=daily.get(date)??[];group.push(item);daily.set(date,group);}
  return {range,metrics:summaryQuality(all),daily:[...daily.entries()].map(([date,items])=>({date,...summaryQuality(items)})),deterministic:true};
 }
 async close(){for(const id of this.estimates.keys())this.dropEstimate(id);this.active?.controller.abort(new Error('服务关闭'));this.active?.dispose?.();await this.waitIdle();}
}
