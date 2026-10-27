import { readFileSync } from 'node:fs';
import type { Config } from './types.js';
import { mergePanel,readPanelSettings,allModelKeys } from './settings.js';
export function loadConfig(path=process.env.CONFIG_PATH || '/config/config.json'):Config {
 const c=mergePanel(JSON.parse(readFileSync(path,'utf8')) as Config,readPanelSettings());
 if(!['draft','auto'].includes(c.mode)) throw new Error('运行模式必须为 draft 或 auto');
 c.expectedHandle=(c.expectedHandle||'').replace(/^@/,'').toLowerCase();
 if(c.expectedHandle&&!/^[a-z0-9_]{1,15}$/.test(c.expectedHandle)) throw new Error('账号名称无效');
 for(const [key,min,max] of [['pollSeconds',30,3600],['maxAgeHours',1,48],['maxPerRound',1,4],['publicPerHour',1,25],['privatePerHour',1,100],['retentionDays',1,365]] as const) {
  const value=c[key]; if(!Number.isInteger(value)||value<min||value>max) throw new Error('配置范围无效：'+key);
 }
 if(typeof c.persona!=='string'||!c.persona.trim()||c.persona.length>20000)throw new Error('角色描述无效');
 if(c.model?.vision)throw new Error('本期视觉输入尚未接入，请保持 vision=false');
 if(!c.model||((c.model.provider==='custom'||c.model.source!=='panel')&&!['openai-completions','openai-responses','anthropic-messages'].includes(c.model.api)))throw new Error('模型协议无效');
 if(c.model.baseUrl){const u=new URL(c.model.baseUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('模型地址无效');}
 if(!Number.isInteger(c.model.maxTokens)||c.model.maxTokens<64||c.model.maxTokens>8192)throw new Error('输出额度无效');
 if(!Number.isInteger(c.model.timeoutMs)||c.model.timeoutMs<1000||c.model.timeoutMs>180000)throw new Error('模型超时无效');
 return c;
}
export function readSecret(name:string,root=process.env.SECRETS_DIR||'/run/role-secrets'){try{return readFileSync(root+'/'+name,'utf8').trim();}catch{return '';}}
export function redact(s:unknown):string{let text=String(s);let panelKeys:string[]=[];try{panelKeys=allModelKeys();}catch{}for(const value of [...['model_api_key','browser_key','ingress_key'].map(n=>readSecret(n)),...panelKeys]){if(value.length>=8)text=text.split(value).join('[已隐藏]');}return text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/(?:sk-|buf_|ghp_)[A-Za-z0-9_\-]{8,}/g,'[已隐藏]').slice(0,700);}
