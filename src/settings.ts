// Panel-managed settings (expected handle, model) and per-slot model keys.
// Stored under the writable data volume; config.json stays read-only.
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Config } from './types.js';

export type ReasoningLevel = 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
export type PanelModel = { provider:string; baseUrl:string; api?:'openai-completions'|'openai-responses'|'anthropic-messages'; id:string; reasoningLevel:ReasoningLevel; maxTokens:number; timeoutMs:number; custom?:{contextWindow:number;reasoning:boolean} };
export type SettingsSection = 'model'|'modelLibrary'|'persona'|'tasks'|'memory'|'program'|'promptHints'|'triage'|'health';
export type PanelSettings = { model?:PanelModel; modelLibrary?:import('./model-library.js').ModelLibrary; promptHints?:Record<string,any>; triage?:Record<string,any>; health?:Record<string,any>; persona?:Record<string,any>; tasks?:Record<string,any>; memory?:Record<string,any>; program?:Record<string,any>; revisions?:Partial<Record<SettingsSection,number>> };
export class SettingsConflictError extends Error { statusCode=409; constructor(public section:SettingsSection,public revision:number){super('设置已被其他操作修改，请重新读取后保存');} }


export function panelDir():string { return (process.env.DATA_DIR || '/data') + '/panel'; }

function writeAtomic(file:string, data:string) {
  mkdirSync(panelDir(), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { writeFileSync(tmp, data, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, file); }
  finally { try { unlinkSync(tmp); } catch {} }
}

function readObject(file:string):Record<string,any>|undefined {
  let raw:string;
  try { raw = readFileSync(file, 'utf8'); } catch (e:any) { if (e?.code === 'ENOENT') return {}; throw e; }
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
}

export function readPanelSettings(opts:{tolerant?:boolean} = {}):PanelSettings {
  const v = readObject(panelDir() + '/settings.json');
  if (v) return v as PanelSettings;
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

const BLOCKED_HOSTS = new Set(['browser', 'app', 'localhost', '0.0.0.0', '::1']);
export function checkBaseUrl(raw:string):URL {
  let u:URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new Error('模型地址无效：无法解析'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('模型地址无效：只支持 http 或 https');
  if (u.username || u.password) throw new Error('模型地址无效：地址里不能带账号密码');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(h) || /^127\./.test(h) || /^169\.254\./.test(h) || /^::ffff:(7f|a9fe)/.test(h)) {
    throw new Error('模型地址无效：不能指向本机、内部服务或云元数据地址');
  }
  return u;
}

export function toConfigModel(p:PanelModel):Config['model'] {
  return { provider: p.provider, api: p.api ?? '', baseUrl: p.baseUrl, id: p.id, reasoning: p.reasoningLevel !== 'off', reasoningLevel: p.reasoningLevel, vision: false, maxTokens: p.maxTokens, timeoutMs: p.timeoutMs, source: 'panel', custom: p.custom };
}

export function mergePanel(c:Config, p:PanelSettings):Config {
  c.model = p.model ? toConfigModel(p.model) : { ...c.model, source: 'config' };
  for(const field of ['mode','maxAgeHours','maxPerRound','publicPerHour','privatePerHour','publicPerDay'] as const)if(p.program?.[field]!==undefined)(c as any)[field]=p.program[field];
  if(p.tasks?.plans?.main?.intervalSeconds!==undefined)c.pollSeconds=p.tasks.plans.main.intervalSeconds;
  c.memoryPolicy={recentCount:p.memory?.recentCount??3,recentDays:p.memory?.recentDays??7,retentionDays:p.memory?.retentionDays??c.retentionDays};
  c.retentionDays=c.memoryPolicy.retentionDays;
  c.publicPerDay=p.program?.publicPerDay??c.publicPerDay??180;
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
