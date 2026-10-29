import {modelTarget} from './model-egress.js';
// Panel-managed settings (expected handle, model) and per-slot model keys.
// Stored under the writable data volume; config.json stays read-only.
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Config } from './types.js';

export type ReasoningLevel = 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
export type PanelModel = { provider:string; baseUrl:string; api?:'openai-completions'|'openai-responses'|'anthropic-messages'; id:string; reasoningLevel:ReasoningLevel; custom?:{contextWindow:number;reasoning:boolean} };
export type SettingsSection = 'model'|'modelLibrary'|'persona'|'personaLibrary'|'tasks'|'memory'|'program'|'promptHints'|'triage'|'health';
export type PanelSettings = { model?:PanelModel; modelLibrary?:import('./model-library.js').ModelLibrary; personaLibrary?:import('./persona-library.js').PersonaLibrary; promptHints?:Record<string,any>; triage?:Record<string,any>; health?:Record<string,any>; persona?:Record<string,any>; tasks?:Record<string,any>; memory?:Record<string,any>; program?:Record<string,any>; migrations?:Record<string,number>; revisions?:Partial<Record<SettingsSection,number>> };
export class SettingsConflictError extends Error { statusCode=409; constructor(public section:SettingsSection,public revision:number){super('设置已被其他操作修改，请重新读取后保存');} }


export function panelDir():string { return (process.env.DATA_DIR || '/data') + '/panel'; }

function writeAtomic(file:string, data:string) {
  mkdirSync(panelDir(), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { writeFileSync(tmp, data, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, file); }
  finally { try { unlinkSync(tmp); } catch {} }
}
/** 仅供启动时已备份的人设升级，保留其他设置的原始字段。 */
export function commitPersonaUpgrade(settings:PanelSettings):void {writeAtomic(panelDir()+'/settings.json',JSON.stringify(settings,null,2));}

function readObject(file:string):Record<string,any>|undefined {
  let raw:string;
  try { raw = readFileSync(file, 'utf8'); } catch (e:any) { if (e?.code === 'ENOENT') return {}; throw e; }
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
}

export function readPanelSettings(opts:{tolerant?:boolean} = {}):PanelSettings {
  const v = readObject(panelDir() + '/settings.json');
  if (v) {
    // 兼容旧设置；只保留仍生效的参数，下一次原子保存自然移除旧字段。
    if(v.model){delete v.model.maxTokens;delete v.model.timeoutMs;}
    for(const provider of v.modelLibrary?.providers??[]){
      const fallbackApi=provider.provider==='custom'?(provider.api||'openai-completions'):undefined;
      for(const model of provider.models??[]){
        if(model.params){delete model.params.maxTokens;delete model.params.timeoutMs;}
        if(fallbackApi&&!model.api)model.api=fallbackApi;
      }
    }
    return v as PanelSettings;
  }
  if (opts.tolerant) return {};
  throw new Error('面板设置文件损坏');
}

function isObject(value:unknown):value is Record<string,any> { return !!value && typeof value==='object' && !Array.isArray(value); }
function mergeFields(current:any, patch:any):any {
 if(!isObject(patch))return structuredClone(patch);
 const result:Record<string,any>=isObject(current)?{...current}:{};
 for(const [key,value] of Object.entries(patch)) {
  if(['__proto__','prototype','constructor'].includes(key))throw new Error('设置字段无效');
  if(value!==undefined)result[key]=isObject(value)?mergeFields(result[key],value):structuredClone(value);
 }
 return result;
}
/** 同一 Node 进程内同步读改写，写入只合并指定域；调用者可提供该域的修订实现乐观锁。 */
export function mergePanelSettings(section:SettingsSection,value:Record<string,any>,expectedRevision?:number):{settings:PanelSettings;revision:number} {
 if(!['model','modelLibrary','persona','tasks','memory','program','promptHints','triage','health'].includes(section)||!isObject(value))throw new Error('设置分区无效');
 let current:PanelSettings;
 try{current=readPanelSettings();}catch(error){if(section!=='model'||(expectedRevision!==undefined&&expectedRevision!==0))throw error;current={};}
 const revision=current.revisions?.[section]??0;
 if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision!==revision))throw new SettingsConflictError(section,revision);
 const next={...current,[section]:['model','modelLibrary'].includes(section)?structuredClone(value):mergeFields(current[section],value),revisions:{...current.revisions,[section]:revision+1}};
 writeAtomic(panelDir()+'/settings.json',JSON.stringify(next,null,2));
 return {settings:next,revision:revision+1};
}

/** 人设库与兼容 persona 镜像必须一次写入；单项与整库修订均在写前核对。 */
export function commitPersonaLibrary(library:import('./persona-library.js').PersonaLibrary,opts:{expectedLibraryRevision?:number;itemId?:string;expectedItemRevision?:number;previousPersona?:import('./persona.js').Persona;expectedPersonaRevision?:number}={}):{settings:PanelSettings;revision:number;personaRevision:number} {
 const current=readPanelSettings(),revision=current.revisions?.personaLibrary??0,personaRevision=current.revisions?.persona??0;
 if(opts.expectedLibraryRevision!==undefined&&(!Number.isSafeInteger(opts.expectedLibraryRevision)||opts.expectedLibraryRevision!==revision))throw new SettingsConflictError('personaLibrary',revision);
 if(opts.expectedPersonaRevision!==undefined&&(!Number.isSafeInteger(opts.expectedPersonaRevision)||opts.expectedPersonaRevision!==personaRevision))throw new SettingsConflictError('persona',personaRevision);
 if(opts.itemId!==undefined&&current.personaLibrary){const item=current.personaLibrary.items.find(item=>item.id===opts.itemId);if(!item||item.revision!==opts.expectedItemRevision)throw new SettingsConflictError('personaLibrary',item?.revision??0);}
 const active=library.items.find(item=>item.id===library.activeId);if(!active)throw new Error('人设库缺少使用中人设');
 const previous=current.persona??opts.previousPersona,changed=JSON.stringify(previous)!==JSON.stringify(active.persona),nextPersonaRevision=personaRevision+Number(changed);
 const next:PanelSettings={...current,personaLibrary:structuredClone(library),persona:structuredClone(active.persona),revisions:{...current.revisions,personaLibrary:revision+1,persona:nextPersonaRevision}};
 writeAtomic(panelDir()+'/settings.json',JSON.stringify(next,null,2));
 return {settings:next,revision:revision+1,personaRevision:nextPersonaRevision};
}
/** 兼容旧模型保存入口：重读最新设置并逐域合并，不能删除其他页面的数据。 */
export function writePanelSettings(next:PanelSettings):void {
 for(const section of ['model','modelLibrary','persona','tasks','memory','program','promptHints','triage','health'] as const)if(next[section]!==undefined)mergePanelSettings(section,next[section]!);
}


const keysFile = () => panelDir() + '/model-keys.json';
function readKeys():Record<string,string> { return (readObject(keysFile()) ?? {}) as Record<string,string>; }

export function keySlot(provider:string, baseUrl:string):string {
  let host:string;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { throw new Error('模型地址无效：无法解析'); }
  return provider + '@' + host;
}

export function readModelKey(slot:string):string { const v = readKeys()[slot]; return typeof v === 'string' ? v : ''; }

export function writeModelKey(slot:string, key:string):void {
  const keys = readKeys();
  if (key) keys[slot] = key; else delete keys[slot];
  writeAtomic(keysFile(), JSON.stringify(keys));
}

export function allModelKeys():string[] { return Object.values(readKeys()).filter((v):v is string => typeof v === 'string' && v.length > 0); }

export function keyHint(key:string):string { return key ? '••••' + key.slice(-4) : ''; }

export function keyHints():Record<string,string> {
  const out:Record<string,string> = {};
  for (const [slot, key] of Object.entries(readKeys())) if (typeof key === 'string' && key) out[slot] = keyHint(key);
  return out;
}

export function checkBaseUrl(raw:string):URL {return modelTarget(String(raw??''),{base:true});}

export function toConfigModel(p:PanelModel):Config['model'] {
  return { provider: p.provider, api: p.api ?? '', baseUrl: p.baseUrl, id: p.id, reasoning: p.reasoningLevel !== 'off', reasoningLevel: p.reasoningLevel, vision: false, source: 'panel', custom: p.custom };
}

export function mergePanel(c:Config, p:PanelSettings):Config {
  const {maxTokens: _oldCap,timeoutMs: _oldTimeout,...configModel}=c.model as Config['model']&Record<string,unknown>;
  c.model = p.model ? toConfigModel(p.model) : { ...configModel, source: 'config' };
  for(const field of ['mode','maxAgeHours','maxPerRound','publicPerHour','privatePerHour','publicPerDay','privatePerDay','replyHours'] as const)if(p.program?.[field]!==undefined)(c as any)[field]=p.program[field];
  if(p.tasks?.plans?.main?.intervalSeconds!==undefined)c.pollSeconds=p.tasks.plans.main.intervalSeconds;
  c.memoryPolicy={recentCount:p.memory?.recentCount??3,recentDays:p.memory?.recentDays??7,retentionDays:p.memory?.retentionDays??c.retentionDays};
  c.retentionDays=c.memoryPolicy.retentionDays;
  c.publicPerDay=p.program?.publicPerDay??c.publicPerDay??180;
  if(c.privatePerDay===undefined)c.privatePerDay=400;
  if(c.replyHours===undefined)c.replyHours={enabled:true,closeDelayMinutes:30};
  c.promptHints=p.promptHints??{};
  c.triage=p.triage??{};
  c.health=p.health??{};
  return c;
}

/** 模型库与使用中模型同一次原子写入，避免 active 与兼容 model 不一致。 */
export function commitModelLibrary(library:import('./model-library.js').ModelLibrary,expectedRevision?:number,model?:PanelModel):{settings:PanelSettings;revision:number} {
 let current:PanelSettings;try{current=readPanelSettings();}catch(error){if(!model||(expectedRevision!==undefined&&expectedRevision!==0))throw error;current={};}
 const revision=current.revisions?.modelLibrary??0;
 if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision!==revision))throw new SettingsConflictError('modelLibrary',revision);
 const revisions={...current.revisions,modelLibrary:revision+1,...(model?{model:(current.revisions?.model??0)+1}:{})};
 const next:PanelSettings={...current,modelLibrary:structuredClone(library),...(model?{model:structuredClone(model)}:{}),revisions};
 writeAtomic(panelDir()+'/settings.json',JSON.stringify(next,null,2));return {settings:next,revision:revision+1};
}

/** 分流规则与统一消息时效 maxAgeHours 同一次原子写入，同时递增 triage 与 program 修订号。 */
export function commitTriageSettings(triage:Record<string,any>,opts:{maxAgeHours?:number;expectedRevision?:number;expectedProgramRevision?:number}={}):{settings:PanelSettings;revision:number;programRevision:number} {
 const current=readPanelSettings(),revision=current.revisions?.triage??0,programRevision=current.revisions?.program??0;
 if(opts.expectedRevision!==undefined&&(!Number.isSafeInteger(opts.expectedRevision)||opts.expectedRevision!==revision))throw new SettingsConflictError('triage',revision);
 if(opts.expectedProgramRevision!==undefined&&(!Number.isSafeInteger(opts.expectedProgramRevision)||opts.expectedProgramRevision!==programRevision))throw new SettingsConflictError('program',programRevision);
 if(opts.maxAgeHours!==undefined&&(!Number.isInteger(opts.maxAgeHours)||opts.maxAgeHours<1||opts.maxAgeHours>48))throw new Error('maxAgeHours 超出范围');
 const nextTriage=mergeFields(current.triage,triage);
 const nextProgram=opts.maxAgeHours!==undefined?mergeFields(current.program,{maxAgeHours:opts.maxAgeHours}):current.program;
 const next:PanelSettings={...current,triage:nextTriage,...(nextProgram!==undefined?{program:nextProgram}:{}),revisions:{...current.revisions,triage:revision+1,program:programRevision+1}};
 writeAtomic(panelDir()+'/settings.json',JSON.stringify(next,null,2));
 return {settings:next,revision:revision+1,programRevision:programRevision+1};
}

/** 启动时一次性将旧版 normalMaxAgeHours / program.maxAgeHours 合并为统一 maxAgeHours，并备份原 settings.json。 */
export function upgradeMessageAgeSettings(store?:{log(event:string,detail:string,level?:'info'|'warn'|'error'):void},configMaxAgeHours?:number,now=Date.now()):{upgraded:boolean;maxAgeHours?:number;backupPath?:string} {
 const file=panelDir()+'/settings.json';
 if(!existsSync(file))return {upgraded:false};
 const current=readPanelSettings();
 if(current.migrations?.messageAge)return {upgraded:false};
 const rawText=readFileSync(file,'utf8');
 let cfgAge=configMaxAgeHours;
 if(cfgAge===undefined){try{cfgAge=(JSON.parse(readFileSync(process.env.CONFIG_PATH||'/config/config.json','utf8')) as any)?.maxAgeHours;}catch{}}
 const normalAge=current.triage?.normalMaxAgeHours;
 const fallback=Math.min(3,Number.isInteger(current.program?.maxAgeHours)?current.program!.maxAgeHours:(Number.isInteger(cfgAge)?cfgAge!:6));
 const maxAgeHours=Number.isInteger(normalAge)&&normalAge>=1&&normalAge<=48?normalAge:Math.max(1,Math.min(48,fallback));
 const backupPath=`${file}.bak-message-age-${now}`;
 writeAtomic(backupPath,rawText);
 const next:PanelSettings={
  ...current,
  program:{...(current.program??{}),maxAgeHours},
  migrations:{...(current.migrations??{}),messageAge:1},
  revisions:{...(current.revisions??{}),program:(current.revisions?.program??0)+1,triage:(current.revisions?.triage??0)+1},
 };
 writeAtomic(file,JSON.stringify(next,null,2));
 store?.log('settings-upgrade',`消息时效已合并为 maxAgeHours=${maxAgeHours}h，已备份 ${backupPath}`);
 return {upgraded:true,maxAgeHours,backupPath};
}
