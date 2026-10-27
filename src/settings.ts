// Panel-managed settings (expected handle, model) and per-slot model keys.
// Stored under the writable data volume; config.json stays read-only.
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import type { Config } from './types.js';

export type ReasoningLevel = 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
export type PanelModel = { provider:string; baseUrl:string; api?:'openai-completions'|'openai-responses'|'anthropic-messages'; id:string; reasoningLevel:ReasoningLevel; maxTokens:number; timeoutMs:number; custom?:{contextWindow:number;reasoning:boolean} };
export type PanelSettings = { model?:PanelModel };

export function panelDir():string { return (process.env.DATA_DIR || '/data') + '/panel'; }

function writeAtomic(file:string, data:string) {
  mkdirSync(panelDir(), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
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

export function writePanelSettings(next:PanelSettings):void {
  writeAtomic(panelDir() + '/settings.json', JSON.stringify(next, null, 2));
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
  return c;
}
