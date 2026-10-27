import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Store } from './store.js';
import { applyMigration } from './migrations.js';
import type { Identity, Channel } from './types.js';
import { redact } from './config.js';

/** 加法迁移 v10；旧版忽略新增表，数据库备份保持现有边界。 */
export const HEALTH_SCHEMA = `
 CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY,account_id TEXT NOT NULL DEFAULT '',key TEXT NOT NULL,level TEXT NOT NULL,summary TEXT NOT NULL,started_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,resolved_at INTEGER);
 CREATE UNIQUE INDEX IF NOT EXISTS alerts_active ON alerts(account_id,key) WHERE resolved_at IS NULL;
 CREATE INDEX IF NOT EXISTS alerts_history ON alerts(account_id,started_at DESC,id DESC);
 CREATE TABLE IF NOT EXISTS daily_reports(date TEXT NOT NULL,account_id TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(date,account_id));
`;
export type HealthLevel = 'normal'|'attention'|'error';
export type HealthMetric = {key:string;level:HealthLevel;summary:string;value?:number|string|null};
export type HealthAlert = {id:string;accountId:string;key:string;level:Exclude<HealthLevel,'normal'>;summary:string;startedAt:number;lastSeenAt:number;resolvedAt:number|null};
export type HealthSettings = {softTimeoutMinutes:number;hardTimeoutMinutes:number;publicCollectionSeconds:number;privateCollectionSeconds:number;rpcTimeoutSeconds:number;memoryRatio:number;browserMaxAgeHours:number;requiredPhrases:string[]};
export const DEFAULT_HEALTH_SETTINGS:HealthSettings={softTimeoutMinutes:8,hardTimeoutMinutes:12,publicCollectionSeconds:90,privateCollectionSeconds:90,rpcTimeoutSeconds:120,memoryRatio:.75,browserMaxAgeHours:24,requiredPhrases:['AI']};
export function healthSettings(value:Partial<HealthSettings>={}):HealthSettings {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_HEALTH_SETTINGS,key)))throw new Error('健康配置字段无效');
 const result={...DEFAULT_HEALTH_SETTINGS,...value,requiredPhrases:value.requiredPhrases??[...DEFAULT_HEALTH_SETTINGS.requiredPhrases]};
 const ranges:[keyof HealthSettings,number,number][]=[['softTimeoutMinutes',3,30],['hardTimeoutMinutes',5,45],['publicCollectionSeconds',10,300],['privateCollectionSeconds',10,300],['rpcTimeoutSeconds',10,300],['memoryRatio',.25,.95],['browserMaxAgeHours',1,168]];
 for(const [key,min,max] of ranges){const n=result[key];if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||(key!=='memoryRatio'&&!Number.isInteger(n)))throw new Error('健康配置范围无效：'+key);}
 if(result.hardTimeoutMinutes<result.softTimeoutMinutes+2)throw new Error('硬超时必须比软超时至少多两分钟');
 if(!Array.isArray(result.requiredPhrases)||result.requiredPhrases.length>20||result.requiredPhrases.some(v=>typeof v!=='string'||!v.trim()||v.length>100))throw new Error('披露词配置无效');
 result.requiredPhrases=[...new Set(result.requiredPhrases.map(v=>v.trim()))];return result;
}
export function healthDate(at:number){return new Date(at+28800000).toISOString().slice(0,10);}
export function healthDay(date:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('日期格式无效');const start=Date.parse(date+'T00:00:00+08:00');if(!Number.isFinite(start)||healthDate(start)!==date)throw new Error('日期无效');return {start,end:start+86400000};}
function safeSummary(value:unknown){return redact(value??'').slice(0,500);}
function parse<T>(value:string|undefined|null,fallback:T):T{try{return value?JSON.parse(value):fallback;}catch{return fallback;}}
function table(store:Store,name:string){return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function alertRow(row:any):HealthAlert{return {id:row.id,accountId:row.account_id,key:row.key,level:row.level,summary:row.summary,startedAt:row.started_at,lastSeenAt:row.last_seen_at,resolvedAt:row.resolved_at};}

/** 软超时不切断当前消息；硬超时只触发已有 AbortController。 */
export class RoundBudget {
 readonly startedAt:number;readonly softDeadline:number;readonly hardDeadline:number;
 private timer:ReturnType<typeof setTimeout>|undefined;
 constructor(readonly abort:AbortController,settings:Partial<HealthSettings>={},readonly now:()=>number=Date.now,onHardTimeout?:()=>void){
  const config=healthSettings(settings);this.startedAt=now();this.softDeadline=this.startedAt+config.softTimeoutMinutes*60000;this.hardDeadline=this.startedAt+config.hardTimeoutMinutes*60000;
  this.timer=setTimeout(()=>{if(!this.abort.signal.aborted){onHardTimeout?.();this.abort.abort(new Error('轮次超过硬超时'));}},Math.max(0,this.hardDeadline-now()));this.timer.unref?.();
 }
 get softExpired(){return this.now()>=this.softDeadline;}
 get hardExpired(){return this.now()>=this.hardDeadline;}
 check(){if(this.hardExpired&&!this.abort.signal.aborted)this.abort.abort(new Error('轮次超过硬超时'));return !this.softExpired&&!this.abort.signal.aborted;}
 collectionDeadline(channel:Channel,settings:Partial<HealthSettings>={}){const c=healthSettings(settings);return Math.min(this.hardDeadline,this.now()+(channel==='public'?c.publicCollectionSeconds:c.privateCollectionSeconds)*1000);}
 dispose(){clearTimeout(this.timer);this.timer=undefined;}
}
export type WatchdogSnapshot={control:string;busy:boolean;startedAt:number;nextTick:number;hasTimer?:boolean;stopped?:boolean};
export type WatchdogDeps={snapshot:()=>WatchdogSnapshot;restoreSchedule:()=>void|Promise<void>;abortCurrent:()=>void;safetyPause:(reason:string)=>void|Promise<void>;log?:(event:string,detail:string)=>void;clock?:()=>number;hardTimeoutMs?:()=>number};
/** 不访问浏览器；先请求中止，等释放后才恢复唯一调度器。 */
export class WorkflowWatchdog {
 private active=false;private attempts=0;private retryAfter=0;private fault='';
 constructor(readonly deps:WatchdogDeps){}
 async check(){
  if(this.active)return;this.active=true;
  try{
   const now=(this.deps.clock??Date.now)(),s=this.deps.snapshot();
   if(s.control!=='running'||s.stopped){this.reset();return;}
   const stuck=s.busy&&s.startedAt>0&&now-s.startedAt>(this.deps.hardTimeoutMs?.()??720000)+120000;
   const lost=!s.busy&&(s.hasTimer===false||!s.nextTick||s.nextTick<=now-60000);
   if(!stuck&&!lost){this.reset();return;}
   const fault=stuck?'stuck-round':'missing-timer';if(this.fault!==fault){this.fault=fault;this.attempts=0;this.retryAfter=0;}
   if(now<this.retryAfter)return;
   if(this.attempts>=2){this.deps.log?.('watchdog-failed',JSON.stringify({fault,attempts:this.attempts}));await this.deps.safetyPause('看门狗连续两次恢复失败，已安全暂停');this.reset();return;}
   this.attempts++;this.retryAfter=now+30000;this.deps.log?.('watchdog-recovery',JSON.stringify({fault,attempt:this.attempts}));
   if(stuck)this.deps.abortCurrent();else try{await this.deps.restoreSchedule();}catch{/* 下次检查继续验证，连续失败安全暂停。 */}
  }finally{this.active=false;}
 }
 private reset(){this.attempts=0;this.retryAfter=0;this.fault='';}
}

export type BrowserMemory={bytes:number|null;limitBytes:number|null;ratio:number|null;source:'cgroup'|'process-rss'|'unavailable'};
/** 只读取固定 cgroup 与 /proc，测试可注入只读文件系统；不执行宿主命令。 */
export function readBrowserMemory(options:{cgroupRoot?:string;procRoot?:string;rootPid?:number;fallbackLimitBytes?:number;read?:(path:string)=>string;list?:(path:string)=>string[]}={}):BrowserMemory {
 const read=options.read??((path:string)=>readFileSync(path,'utf8')),list=options.list??((path:string)=>readdirSync(path));const cgroup=options.cgroupRoot??'/sys/fs/cgroup';
 try{const bytes=Number(read(cgroup+'/memory.current').trim()),raw=read(cgroup+'/memory.max').trim(),limit=raw==='max'?null:Number(raw);if(Number.isFinite(bytes)&&bytes>=0&&(limit===null||(Number.isFinite(limit)&&limit>0)))return {bytes,limitBytes:limit,ratio:limit===null?null:bytes/limit,source:'cgroup'};}catch{}
 try{
  const root=options.procRoot??'/proc',processes=new Map<number,{parent:number;rss:number;name:string}>();
  for(const pid of list(root).filter(v=>/^\d+$/.test(v))){try{const stat=read(root+'/'+pid+'/status');const name=stat.match(/^Name:\s*(.+)$/m)?.[1]??'';const parent=Number(stat.match(/^PPid:\s*(\d+)/m)?.[1]);const rss=Number(stat.match(/^VmRSS:\s*(\d+)\s+kB/m)?.[1])*1024;if(Number.isFinite(parent)&&Number.isFinite(rss))processes.set(Number(pid),{parent,rss,name});}catch{}}
  const selected=new Set<number>(options.rootPid?[options.rootPid]:[...processes].filter(([,p])=>/camoufox|firefox/i.test(p.name)).map(([pid])=>pid));
  for(let changed=true;changed;){changed=false;for(const [pid,p] of processes)if(selected.has(p.parent)&&!selected.has(pid)){selected.add(pid);changed=true;}}
  if(!selected.size)throw new Error('浏览器进程不可确认');const bytes=[...selected].reduce((sum,pid)=>sum+(processes.get(pid)?.rss??0),0),limit=options.fallbackLimitBytes??2*1024*1024*1024;
  return {bytes,limitBytes:limit,ratio:limit?bytes/limit:null,source:'process-rss'};
 }catch{return {bytes:null,limitBytes:null,ratio:null,source:'unavailable'};}
}
export type BrowserResourceHealth={sessionId?:string;stale?:boolean;at:number;startedAt:number;memory:BrowserMemory;lastRestartAt:number|null;lastRestartReason:string|null;restarts:number;restartError:string|null};
export type BrowserGuardDeps={readMemory?:()=>BrowserMemory;clock?:()=>number;restart:()=>Promise<Identity>;identity:()=>Promise<Identity>;settings?:()=>Partial<HealthSettings>;onRestart?:(info:{at:number;reason:string;ok:boolean})=>void};
export class BrowserResourceGuard {
 private state:BrowserResourceHealth;private restarting=false;
 constructor(readonly deps:BrowserGuardDeps){const now=(deps.clock??Date.now)();this.state={sessionId:randomUUID(),at:now,startedAt:now,memory:{bytes:null,limitBytes:null,ratio:null,source:'unavailable'},lastRestartAt:null,lastRestartReason:null,restarts:0,restartError:null};}
 snapshot(){return structuredClone(this.state);}
 sample(){this.state.at=(this.deps.clock??Date.now)();try{this.state.memory=(this.deps.readMemory??readBrowserMemory)();}catch{this.state.memory={bytes:null,limitBytes:null,ratio:null,source:'unavailable'};}return this.snapshot();}
 async before(operation:string,control:string,expectedHandle=''){
  const state=this.sample(),config=healthSettings(this.deps.settings?.()??{}),reason=state.memory.ratio!==null&&state.memory.ratio>=config.memoryRatio?'memory-threshold':state.at-state.startedAt>=config.browserMaxAgeHours*3600000?'runtime-threshold':null;
  if(!reason||this.restarting||control==='manual'||control==='draining'||['send','post','lookup','lookupPost','control','health'].includes(operation))return state;
  this.restarting=true;
  try{
   const previous=expectedHandle||String((await this.deps.identity()).handle||'').replace(/^@/,'').toLowerCase();
   if(!previous)throw new Error('重启前无法确认工作账号');
   const identity=await this.deps.restart(),handle=String(identity.handle||'').replace(/^@/,'').toLowerCase();
   if(!identity.loggedIn||identity.needsHuman||(identity as any).restricted||handle!==previous)throw new Error('浏览器重启后登录身份失效或改变');
   const at=(this.deps.clock??Date.now)();this.state.startedAt=at;this.state.lastRestartAt=at;this.state.lastRestartReason=reason;this.state.restarts++;this.state.restartError=null;this.deps.onRestart?.({at,reason,ok:true});return this.sample();
  }catch(error){this.state.restartError='浏览器资源恢复失败，需要人工检查';this.deps.onRestart?.({at:(this.deps.clock??Date.now)(),reason,ok:false});throw Object.assign(new Error(this.state.restartError),{code:'browser-recovery-failed'});}
  finally{this.restarting=false;}
 }
}
export type AccountRestriction='suspended'|'locked'|'read_only'|'limited';
/** 必须绑定当前自己的账号页面，其他用户资料的冻结提示不得触发。 */
export function detectAccountRestriction(input:{url:string;text:string;ownAccount:boolean;testIds?:string[]}):AccountRestriction|undefined {
 const accountAccess=/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/account\/access(?:[/?#]|$)/i.test(input.url);
 if(!input.ownAccount&&!accountAccess)return;
 const text=input.text.slice(0,100000);
 if(/your account (?:is|has been) suspended|您的[帐账][户号](?:已被|已)?冻结|你的[帐账][户号](?:已被|已)?冻结/i.test(text))return 'suspended';
 if(/your account (?:is|has been) locked|您的[帐账][户号](?:已被|已)?锁定|你的[帐账][户号](?:已被|已)?锁定/i.test(text)||accountAccess)return 'locked';
 if(/your account (?:is|has been|has been placed) (?:in )?(?:a )?read.only|您的[帐账][户号].{0,12}只读|你的[帐账][户号].{0,12}只读/i.test(text))return 'read_only';
 if(/your account (?:is|has been) (?:temporarily )?(?:restricted|limited)|您的[帐账][户号].{0,12}受限|你的[帐账][户号].{0,12}受限/i.test(text))return 'limited';
}
export function classifyPlatformRejection(text:string):'automation'|'quota'|'other' {
 if(/(?:looks? like|appear).{0,50}automat|请求看起来像是自动|看起来像自动|疑似自动化/i.test(text))return 'automation';
 if(/(?:daily|rate|post|message|usage) limit|too many|已达.{0,10}上限|次数过多/i.test(text))return 'quota';return 'other';
}
export type ComplianceObservation={accountId:string;profileReliable:boolean;name?:string;bio?:string;automatedLabel:boolean|null;qualityFilter:boolean|null;reasons?:string[]};
export type ComplianceResult={accountId:string;checkedAt:number;disclosure:'confirmed'|'missing'|'unknown';missingPhrases:string[];automatedLabel:'confirmed'|'missing'|'unknown';qualityFilter:'on'|'off'|'unknown';reasons:string[]};
export function assessCompliance(observation:ComplianceObservation,requiredPhrases:string[]=['AI'],now=Date.now()):ComplianceResult {
 const phrases=healthSettings({requiredPhrases}).requiredPhrases,text=((observation.name??'')+'\n'+(observation.bio??'')).normalize('NFC').toLocaleLowerCase('en-US');
 const missing=observation.profileReliable?phrases.filter(phrase=>!text.includes(phrase.normalize('NFC').toLocaleLowerCase('en-US'))):[];
 return {accountId:observation.accountId,checkedAt:now,disclosure:observation.profileReliable?(missing.length?'missing':'confirmed'):'unknown',missingPhrases:missing,automatedLabel:observation.automatedLabel===null?'unknown':observation.automatedLabel?'confirmed':'missing',qualityFilter:observation.qualityFilter===null?'unknown':observation.qualityFilter?'on':'off',reasons:(observation.reasons??[]).slice(0,10).map(safeSummary)};
}
export type HealthEvaluation={accountId:string;control:string;mode:string;identity?:Identity&{restricted?:AccountRestriction};cooldown?:Partial<Record<Channel,number>>;sendableChannels?:Partial<Record<Channel,boolean>>;pendingByChannel?:Partial<Record<Channel,{count:number;oldestAt:number|null}>>;publicPerHour?:number;privatePerHour?:number;publicPerDay?:number;maxAgeHours?:number;startedAt?:number;backup?:{ok?:boolean;status?:string}|null;certificateHoursRemaining?:number|null;browser?:BrowserResourceHealth|null;watchdogFailure?:boolean};
export type HealthSnapshot={at:number;accountId:string;status:HealthLevel;metrics:HealthMetric[];activeAlerts:HealthAlert[];compliance:ComplianceResult|null;browser:BrowserResourceHealth|null};
export class RuntimeHealth {
 constructor(readonly store:Store,readonly now:()=>number=Date.now){applyMigration(store.db,10,'运行健康告警与日报',HEALTH_SCHEMA);}
 private key(account:string,suffix:string){return 'health:'+suffix+':'+account;}
 get(accountId=''):HealthSnapshot {return parse(this.store.get(this.key(accountId,'snapshot')),{at:0,accountId,status:'normal',metrics:[],activeAlerts:[],compliance:this.compliance(accountId),browser:null});}
 compliance(accountId:string):ComplianceResult|null{return parse(this.store.get(this.key(accountId,'compliance')),null);}
 saveCompliance(observation:ComplianceObservation,phrases=['AI']){const result=assessCompliance(observation,phrases,this.now());this.store.set(this.key(observation.accountId,'compliance'),JSON.stringify(result));this.store.log('account-compliance',JSON.stringify({accountId:observation.accountId,disclosure:result.disclosure,automatedLabel:result.automatedLabel,qualityFilter:result.qualityFilter}));return result;}
 recordAutomationBlock(accountId:string,channel:Channel){this.store.log('automation-block',JSON.stringify({accountId,channel}),'warn');}
 recordControl(control:string,accountId=''){this.store.log('health-control',JSON.stringify({control,accountId}));}
 evaluate(input:HealthEvaluation):HealthSnapshot {
  const now=this.now(),account=input.accountId,metrics:HealthMetric[]=[],add=(key:string,level:HealthLevel,summary:string,value?:HealthMetric['value'])=>metrics.push({key,level,summary,...(value!==undefined?{value}:{})});
  const previousBrowser=this.get(account).browser,sameSession=input.browser?.sessionId===previousBrowser?.sessionId,previousRestarts=sameSession?(previousBrowser?.restarts??0):0,processRestart=!!(previousBrowser?.sessionId&&input.browser?.sessionId&&!sameSession),restartDelta=input.browser?Math.max(0,input.browser.restarts-previousRestarts)+(processRestart?1:0):0;if(input.browser&&restartDelta>0)this.store.log('browser-restart',JSON.stringify({accountId:account,at:input.browser.lastRestartAt??now,count:restartDelta,reason:processRestart?'browser-process-restart':input.browser.lastRestartReason,ok:!input.browser.restartError}));const observedBrowser=input.browser??(previousBrowser?{...previousBrowser,stale:true}:null);
  const queued=input.pendingByChannel?Object.entries(input.pendingByChannel).filter(([,value])=>!!value&&value.count>0&&value.oldestAt!==null).map(([channel,value])=>({channel,n:value!.count,oldest:value!.oldestAt})):this.store.db.prepare("SELECT channel,COUNT(*) n,MIN(created_at) oldest FROM messages WHERE account_id=? AND status IN ('queued','approved') AND created_at>=? GROUP BY channel").all(account,now-(input.maxAgeHours??24)*3600000) as any[];
  const lastConfirmed=table(this.store,'outbox')?(this.store.db.prepare("SELECT MAX(updated_at) at FROM outbox WHERE account_id=? AND status='confirmed'").get(account) as any)?.at:null;
  const legacyConfirmed=(this.store.db.prepare("SELECT MAX(updated_at) at FROM messages WHERE account_id=? AND status='confirmed'").get(account) as any)?.at;
  let sendableOldest:number|undefined;
  for(const row of queued){const channel=row.channel as Channel;const eligible=input.sendableChannels?.[channel]??this.fallbackSendable(account,channel,input,now);if(eligible)sendableOldest=Math.min(sendableOldest??row.oldest,row.oldest);}
  const lastProgress=Math.max(lastConfirmed??0,legacyConfirmed??0);const baseline=Math.max(lastProgress,sendableOldest??now);
  const stalled=input.control==='running'&&input.mode==='auto'&&sendableOldest!==undefined&&now-baseline>=20*60000;
  add('send-stall',stalled?'error':'normal',stalled?'有可处理消息，二十分钟没有确认发送':'发送进展正常',Math.max(0,now-baseline));
  const runs=table(this.store,'task_runs')?this.store.db.prepare("SELECT status FROM task_runs WHERE task_id='main' AND account_id=? AND status<>'running' ORDER BY started_at DESC,id DESC LIMIT 3").all(account) as any[]:[];
  const failures=runs.findIndex(row=>row.status!=='failed'),consecutive=failures===-1?runs.length:failures;add('round-failures',consecutive>=3?'error':'normal',consecutive>=3?'主循环连续三轮失败':'主循环失败次数未达阈值',consecutive);
  const recentRounds=table(this.store,'task_runs')?this.store.db.prepare("SELECT id,started_at,COALESCE(finished_at,?) ended FROM task_runs WHERE task_id='main' AND account_id=? AND status<>'running' ORDER BY started_at DESC,id DESC LIMIT 3").all(now,account) as any[]:[];
  const collectionFailures=recentRounds.filter(run=>!!this.store.db.prepare("SELECT 1 FROM logs WHERE at>=? AND at<=? AND event='collection-warning' AND (CASE WHEN json_valid(detail) THEN json_extract(detail,'$.roundId')=? ELSE 1 END) LIMIT 1").get(run.started_at,run.ended,run.id)).length;
  add('collection-failures',recentRounds.length===3&&collectionFailures===3?'error':'normal',recentRounds.length===3&&collectionFailures===3?'采集连续三轮异常':'采集状态正常',collectionFailures);
  for(const channel of ['public','private'] as const){const until=input.cooldown?.[channel]??Number(this.store.get('cooldown:'+channel+':'+account,this.store.get('cooldown:'+channel,'0'))),blocked=this.store.db.prepare("SELECT COUNT(*) n FROM logs WHERE event='automation-block' AND at>=? AND json_valid(detail) AND json_extract(detail,'$.accountId')=? AND json_extract(detail,'$.channel')=?").get(now-86400000,account,channel) as any;
   add('cooldown-'+channel,until>now?'attention':'normal',until>now?(channel==='public'?'公开':'私信')+'通道退避中':'通道没有退避',until);
   const n=Number(blocked.n);add('automation-'+channel,n>=3?'error':'normal',n>=3?`过去二十四小时${channel==='public'?'公开':'私信'}通道自动化拦截 ${n} 次；请降低频率（每小时 ${channel==='public'?input.publicPerHour??'未配置':input.privatePerHour??'未配置'}，每日 ${channel==='public'?input.publicPerDay??'未配置':'未设置'}）`:'自动化拦截次数未达阈值',n);
  }
  add('browser-human',input.identity?.needsHuman?'error':'normal',input.identity?.needsHuman?'浏览器需要人工处理':'浏览器没有人工处理提示');
  add('account-restricted',input.identity?.restricted?'error':'normal',input.identity?.restricted?'当前账号受限：'+input.identity.restricted:'当前未发现账号受限',input.identity?.restricted??null);
  add('browser-recovery',observedBrowser?.restartError?'error':'normal',observedBrowser?.restartError?'浏览器资源恢复失败，需要人工检查':'浏览器资源恢复正常');
  const backupFailed=input.backup?.ok===false||input.backup?.status==='failed';add('backup-failure',backupFailed?'error':'normal',backupFailed?'最近一次数据库备份失败':'未发现备份失败');
  const hours=input.certificateHoursRemaining;add('certificate-expiry',hours!==undefined&&hours!==null&&hours<24?'error':'normal',hours!==undefined&&hours!==null&&hours<24?'证书有效期不足二十四小时':'证书没有临期提示',hours??null);
  add('watchdog-failure',input.watchdogFailure?'error':'normal',input.watchdogFailure?'主循环看门狗恢复失败':'主循环调度正常');
  const compliance=this.compliance(account);if(compliance){add('compliance-disclosure',compliance.disclosure==='confirmed'?'normal':'attention',compliance.disclosure==='missing'?'简介披露不完整：'+compliance.missingPhrases.join('、'):compliance.disclosure==='unknown'?'简介披露无法确认':'简介披露完整');add('compliance-label',compliance.automatedLabel==='confirmed'?'normal':'attention',compliance.automatedLabel==='missing'?'未标注自动化账号，请在账号设置中人工检查':compliance.automatedLabel==='unknown'?'自动化账号标签无法确认':'已标注自动化账号');add('compliance-quality',compliance.qualityFilter==='off'?'normal':'attention',compliance.qualityFilter==='on'?'通知质量过滤已开启，可能有部分提及收不到':compliance.qualityFilter==='unknown'?'通知质量过滤状态无法确认':'通知质量过滤关闭');}
  this.updateAlerts(account,metrics,now);const activeAlerts=this.activeAlerts(account),snapshot:HealthSnapshot={at:now,accountId:account,status:metrics.some(m=>m.level==='error')?'error':metrics.some(m=>m.level==='attention')?'attention':'normal',metrics,activeAlerts,compliance,browser:observedBrowser};this.store.set(this.key(account,'snapshot'),JSON.stringify(snapshot));return snapshot;
 }
 private fallbackSendable(account:string,channel:Channel,input:HealthEvaluation,now:number){
  if((input.cooldown?.[channel]??Number(this.store.get('cooldown:'+channel+':'+account,this.store.get('cooldown:'+channel,'0'))))>now)return false;
  const unknown=!!this.store.db.prepare("SELECT 1 FROM messages WHERE account_id=? AND channel=? AND status IN ('sending','unknown') LIMIT 1").get(account,channel);if(unknown)return false;
  const kinds=channel==='public'?"('reply','post')":"('dm')";
  const hasOutbox=table(this.store,'outbox');let count=0;
  if(hasOutbox){if(this.store.db.prepare("SELECT 1 FROM outbox WHERE account_id=? AND kind IN "+kinds+" AND status IN ('submitting','unknown') LIMIT 1").get(account))return false;count=Number((this.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE account_id=? AND kind IN "+kinds+" AND status IN ('confirmed','submitting','unknown','rejected') AND submitted_at>?").get(account,now-3600000) as any).n);}
  count+=Number((this.store.db.prepare("SELECT COUNT(*) n FROM messages m WHERE account_id=? AND channel=? AND status IN ('confirmed','sending','unknown') AND updated_at>?"+(hasOutbox?" AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.account_id=m.account_id AND o.source_id=m.id)":"")).get(account,channel,now-3600000) as any).n);
  return count<(channel==='public'?input.publicPerHour??10:input.privatePerHour??30);
 }
 private updateAlerts(account:string,metrics:HealthMetric[],now:number){
  this.store.db.exec('BEGIN IMMEDIATE');try{for(const metric of metrics){if(metric.level==='normal')this.store.db.prepare('UPDATE alerts SET resolved_at=?,last_seen_at=? WHERE account_id=? AND key=? AND resolved_at IS NULL').run(now,now,account,metric.key);else {const found=this.store.db.prepare('SELECT id FROM alerts WHERE account_id=? AND key=? AND resolved_at IS NULL').get(account,metric.key) as any;if(found)this.store.db.prepare('UPDATE alerts SET level=?,summary=?,last_seen_at=? WHERE id=?').run(metric.level,safeSummary(metric.summary),now,found.id);else this.store.db.prepare('INSERT INTO alerts(id,account_id,key,level,summary,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),account,metric.key,metric.level,safeSummary(metric.summary),now,now);}}this.store.db.exec('COMMIT');}catch(error){this.store.db.exec('ROLLBACK');throw error;}
 }
 activeAlerts(accountId:string){return (this.store.db.prepare('SELECT * FROM alerts WHERE account_id=? AND resolved_at IS NULL ORDER BY started_at DESC,id DESC').all(accountId) as any[]).map(alertRow);}
 alerts(accountId:string,query:{cursor?:string;limit?:number}={}){const limit=Math.max(1,Math.min(100,Math.trunc(query.limit??30))),args:(string|number)[]=[accountId];let where='account_id=?';if(query.cursor){const row=this.store.db.prepare('SELECT started_at,id FROM alerts WHERE id=? AND account_id=?').get(query.cursor,accountId) as any;if(!row)throw new Error('告警游标无效');where+=' AND (started_at<? OR (started_at=? AND id<?))';args.push(row.started_at,row.started_at,row.id);}const rows=this.store.db.prepare('SELECT * FROM alerts WHERE '+where+' ORDER BY started_at DESC,id DESC LIMIT ?').all(...args,limit+1) as any[];return {items:rows.slice(0,limit).map(alertRow),nextCursor:rows.length>limit?rows[limit-1].id:null};}
 reports(accountId='',limit=30){return (this.store.db.prepare('SELECT date,created_at,body_json FROM daily_reports WHERE account_id=? ORDER BY date DESC LIMIT ?').all(accountId,Math.max(1,Math.min(30,Math.trunc(limit)))) as any[]).map(row=>({date:row.date,createdAt:row.created_at,...parse<Record<string,unknown>>(row.body_json,{})}));}
 report(date:string,accountId=''){healthDay(date);const row=this.store.db.prepare('SELECT * FROM daily_reports WHERE date=? AND account_id=?').get(date,accountId) as any;return row?{date:row.date,createdAt:row.created_at,...parse<Record<string,unknown>>(row.body_json,{})}:null;}
 catchUpReport(accountId=''){const now=this.now(),day=healthDate(now),at=Date.parse(day+'T09:00:00+08:00');return now>=at?this.generateReport(healthDate(healthDay(day).start-1),accountId):null;}
 generateReport(date:string,accountId=''){
  const existing=this.report(date,accountId);if(existing)return existing;const {start,end}=healthDay(date),args:(number|string)[]=[start,end],accountWhere=accountId?' AND account_id=?':'';if(accountId)args.push(accountId);
  const channels:Record<string,Record<string,number>>={public:{received:0,replied:0,skipped:0,filtered:0,failed:0,unknown:0},private:{received:0,replied:0,skipped:0,filtered:0,failed:0,unknown:0}};
  const received=this.store.db.prepare('SELECT channel,COUNT(*) n FROM messages WHERE created_at>=? AND created_at<?'+accountWhere+' GROUP BY channel').all(...args) as any[];
  for(const row of received)if(channels[row.channel])channels[row.channel].received=row.n;
  const rows=this.store.db.prepare('SELECT channel,status,COUNT(*) n FROM messages WHERE updated_at>=? AND updated_at<?'+accountWhere+' GROUP BY channel,status').all(...args) as any[];
  for(const row of rows){const c=channels[row.channel];if(!c)continue;const key=row.status==='confirmed'?'replied':['skipped','ignored','merged'].includes(row.status)?'skipped':row.status==='filtered'?'filtered':row.status==='failed'?'failed':['unknown','sending'].includes(row.status)?'unknown':null;if(key)c[key]+=row.n;}
  const delays=(this.store.db.prepare("SELECT updated_at,body FROM messages WHERE status='confirmed' AND updated_at>=? AND updated_at<?"+accountWhere).all(...args) as any[]).map(row=>{const body=parse<any>(row.body,{});return body.timestampReliable!==false&&Number.isFinite(body.timestamp)&&body.timestamp>0&&row.updated_at>=body.timestamp?row.updated_at-body.timestamp:null;}).filter((v):v is number=>v!==null).sort((a,b)=>a-b);
  const percentile=(p:number)=>delays.length?delays[Math.max(0,Math.ceil(delays.length*p)-1)]:null;
  const calls=table(this.store,'llm_calls')?this.store.db.prepare(`SELECT COUNT(*) calls,COALESCE(SUM(total_tokens),0) tokens,COALESCE(SUM(CASE WHEN usage_known=1 THEN cache_read ELSE 0 END),0) cache_read,COALESCE(SUM(CASE WHEN usage_known=1 THEN input_tokens ELSE 0 END),0) input,COALESCE(SUM(usage_known),0) usage_known,COALESCE(SUM(CASE WHEN pricing_status='priced' THEN json_extract(cost_json,'$.total') ELSE 0 END),0) cost,COALESCE(SUM(CASE WHEN pricing_status='priced' THEN 1 ELSE 0 END),0) priced,COALESCE(SUM(CASE WHEN pricing_status='unpriced' THEN 1 ELSE 0 END),0) unpriced,COALESCE(SUM(CASE WHEN pricing_status='unknown' THEN 1 ELSE 0 END),0) unknown FROM llm_calls WHERE started_at>=? AND started_at<?`+accountWhere).get(...args) as any:{calls:0,tokens:0,cache_read:0,input:0,usage_known:0,cost:0,priced:0,unpriced:0,unknown:0};
  const logRows=this.store.db.prepare("SELECT at,event,detail FROM logs WHERE at>=? AND at<? AND event IN ('automation-block','browser-restart','health-control','resume','pause','takeover','release','safety-pause','cooldown') ORDER BY at,id").all(start,end) as any[];
  const selected=logRows.filter(row=>{const meta=parse<any>(row.detail,{});return !accountId||!meta.accountId||meta.accountId===accountId;});
  const alerts=Number((this.store.db.prepare('SELECT COUNT(*) n FROM alerts WHERE started_at>=? AND started_at<?'+accountWhere).get(...args) as any).n);
  const body={timezone:'Asia/Shanghai',accountId,channels,responseLatencyMs:{samples:delays.length,median:percentile(.5),p90:percentile(.9)},model:{calls:calls.calls,totalTokens:calls.tokens,cacheRead:calls.cache_read,input:calls.input,cacheReadRatio:calls.usage_known&&calls.input+calls.cache_read>0?calls.cache_read/(calls.input+calls.cache_read):null,costUSD:calls.priced?calls.cost:null,priced:calls.priced,unpriced:calls.unpriced,unknown:calls.unknown,usageUnknown:calls.calls-calls.usage_known,priceSource:'Pi 内置目录估算'},alerts,platformRejections:selected.filter(row=>row.event==='cooldown').length,automationBlocks:selected.filter(row=>row.event==='automation-block').length,browserRestarts:selected.filter(row=>row.event==='browser-restart'&&parse<any>(row.detail,{}).ok!==false).reduce((sum,row)=>sum+Math.max(1,Number(parse<any>(row.detail,{}).count)||1),0),pausedMs:this.pausedDuration(start,end,accountId)};
  this.store.db.prepare('INSERT OR IGNORE INTO daily_reports(date,account_id,created_at,body_json) VALUES(?,?,?,?)').run(date,accountId,this.now(),JSON.stringify(body));return this.report(date,accountId)!;
 }
 private pausedDuration(start:number,end:number,accountId:string){
  const rows=this.store.db.prepare("SELECT at,event,detail FROM logs WHERE at<? AND event IN ('health-control','resume','pause','takeover','release','safety-pause','boot') ORDER BY at,id").all(end) as any[];
  let state='paused',at=start,paused=0;for(const row of rows){const meta=parse<any>(row.detail,{});if(accountId&&meta.accountId&&meta.accountId!==accountId)continue;const next=row.event==='resume'?'running':row.event==='health-control'?meta.control:'paused';if(!['running','paused','manual','draining'].includes(next))continue;if(row.at<start){state=next;continue;}if(state!=='running')paused+=row.at-at;at=row.at;state=next;}if(state!=='running')paused+=end-at;return Math.max(0,Math.min(86400000,paused));
 }
}
