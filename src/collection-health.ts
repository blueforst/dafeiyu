import type {Store} from './store.js';
import type {Channel,Event} from './types.js';

export type CollectionStatus='ok'|'empty'|'partial'|'failed'|'unsupported'|'blocked'|'unknown';
export type CollectionSource='mentions'|'search'|'own-post-replies'|'inbox'|'requests'|'conversation'|'chat';
export type CollectionDiagnostic={channel:Channel;status:CollectionStatus;code:string;source?:CollectionSource;eventCount:number;readyPages?:number;failedPages?:number;emptyPages?:number};
export type CollectionResult={events:Event[];warnings:string[];diagnostics?:CollectionDiagnostic[]};
export const COLLECTION_CODES=[
 'public-pin-unrecognized','public-relation-unverified','public-ready','public-confirmed-empty','public-budget-exhausted','public-page-timeout','public-page-error','public-target-unavailable','public-target-missing','public-wrong-location','public-parser-unready','public-profile-unready','public-navigation-failed',
 'chat-native-message-structure-unverified','chat-native-body-unverified','chat-native-observed','chat-native-time-unverified','chat-native-sender-unverified','chat-native-messages-unavailable','chat-native-locked','chat-native-shadow-unavailable','chat-native-conversation-mismatch','chat-native-id-conflict','chat-inbox-entries-unverified','chat-request-entry-missing','chat-other-entry-missing',
 'private-inbox-ready','chat-native-messages-ready','chat-native-conversation-empty','private-page-loading','private-structure-unverified','private-wrong-location',
 'private-legacy-body-unverified','private-direct-unverified','private-inbox-unverified','private-legacy-readable','private-inbox-empty','private-legacy-time-unverified','private-legacy-direction-unverified','private-legacy-id-missing','private-navigation-failed','private-collection-deadline',
 'legacy-unclassified','legacy-events-observed','legacy-empty-unverified','unclassified'
] as const;
const CODES=new Set<string>(COLLECTION_CODES),STATUSES=new Set<string>(['ok','empty','partial','failed','unsupported','blocked','unknown']),SOURCES=new Set<string>(['mentions','search','own-post-replies','inbox','requests','conversation','chat']);
const EMPTY_CODES=new Set(['public-confirmed-empty','private-inbox-empty','chat-native-conversation-empty']),BUDGET_CODES=new Set(['public-budget-exhausted','private-collection-deadline']);
const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(100000,Math.floor(value))):0;
const parse=(raw:string)=>{try{return JSON.parse(raw);}catch{return null;}};
/** 浏览器只提供诊断；账号、轮次与日志时间始终由应用绑定。 */
export function normalizeCollectionDiagnostics(raw:unknown,expectedChannel?:Channel):CollectionDiagnostic[]{
 if(!Array.isArray(raw))return [];
 const output:CollectionDiagnostic[]=[];
 for(const value of raw.slice(0,100)){
  if(!value||typeof value!=='object'||!['public','private'].includes(value.channel)||(expectedChannel&&value.channel!==expectedChannel))continue;
  let status:CollectionStatus=STATUSES.has(value.status)?value.status:'unknown',code=CODES.has(value.code)?value.code:'unclassified';
  if(code==='unclassified')status='unknown';if(status==='empty'&&!EMPTY_CODES.has(code)){status='unknown';code='unclassified';}
  const failedPages=count(value.failedPages);if(BUDGET_CODES.has(code)&&failedPages===0&&status==='failed')status='partial';
  output.push({channel:value.channel,status,code,eventCount:count(value.eventCount),...(SOURCES.has(value.source)?{source:value.source}:{}),...(value.readyPages!==undefined?{readyPages:count(value.readyPages)}:{}),...(value.failedPages!==undefined?{failedPages}:{}),...(value.emptyPages!==undefined?{emptyPages:count(value.emptyPages)}:{})});
 }
 return output;
}
export function diagnosticsForCollection(result:Pick<CollectionResult,'events'|'warnings'|'diagnostics'>,expectedChannel?:Channel):CollectionDiagnostic[]{
 const reports=normalizeCollectionDiagnostics(result.diagnostics,expectedChannel);if(reports.length)return reports;
 return (expectedChannel?[expectedChannel]:['public','private'] as Channel[]).map((channel):CollectionDiagnostic=>{const eventCount=Array.isArray(result.events)?result.events.filter(event=>event.channel===channel).length:0;const warned=Array.isArray(result.warnings)&&result.warnings.length>0;
  return {channel,eventCount,status:warned?'unknown':eventCount?'ok':'unknown',code:warned?'legacy-unclassified':eventCount?'legacy-events-observed':'legacy-empty-unverified'};});
}
export function recordCollectionResult(store:Store,accountId:string,roundId:string,result:Pick<CollectionResult,'events'|'warnings'|'diagnostics'>,expectedChannel?:Channel,at=Date.now()){
 if(!accountId||accountId.length>200||!roundId||roundId.length>250||!Number.isSafeInteger(at)||at<0)throw new Error('采集诊断范围无效');
 const reports=diagnosticsForCollection(result,expectedChannel);
 for(const report of reports)store.db.prepare('INSERT INTO logs(at,level,event,detail) VALUES(?,?,?,?)').run(at,report.status==='ok'||report.status==='empty'?'info':'warn','collection-result',JSON.stringify({accountId,roundId,...report}));
 return reports;
}
export type CollectionHealthDetail={channel:Channel;roundId:string;at:number;status:CollectionStatus;code:string;eventCount:number;failureStreak:number;failedPages:number};
export type LegacyCollectionHealthDetail={kind:'legacy-warning';firstAt:number;lastAt:number;roundCount:number};
export type CollectionMetricDetail=CollectionHealthDetail|LegacyCollectionHealthDetail;
export type CollectionHealthMetric={key:string;level:'normal'|'attention'|'error';summary:string;value:number;detail?:CollectionMetricDetail};
type Report=CollectionDiagnostic&{roundId:string;at:number};
function realFailure(report:CollectionDiagnostic){return report.status==='failed'||report.status==='unsupported'||(report.status==='partial'&&(report.failedPages??0)>0);}
function severity(report:CollectionDiagnostic){return realFailure(report)?5:report.status==='blocked'?4:report.status==='unknown'?3:report.status==='partial'?2:0;}
/** 同轮同渠道多个来源合并一次；一个预算提示不能覆盖已发生的真实来源失败。 */
function aggregate(reports:Report[]):Report {
 const sorted=[...reports].sort((a,b)=>severity(b)-severity(a)),worst=sorted[0],failedPages=reports.reduce((sum,row)=>sum+(row.failedPages??0),0);
 return {...worst,eventCount:reports.reduce((sum,row)=>sum+row.eventCount,0),failedPages,at:Math.max(...reports.map(row=>row.at))};
}
export function collectionHealthMetrics(store:Store,accountId:string,now=Date.now()):CollectionHealthMetric[]{
 const rows=store.db.prepare("SELECT id,at,detail FROM logs WHERE event='collection-result' AND at>=? AND json_valid(detail) AND json_extract(detail,'$.accountId')=? ORDER BY at DESC,id DESC LIMIT 600").all(now-86400000,accountId) as any[];
 const rounds=new Map<string,Report[]>(),knownRoundIds=new Set<string>();
 for(const row of rows){const raw=parse(row.detail);if(typeof raw?.roundId!=='string'||!raw.roundId)continue;const report=normalizeCollectionDiagnostics([raw])[0];if(!report)continue;knownRoundIds.add(raw.roundId);const key=JSON.stringify([report.channel,raw.roundId]);const list=rounds.get(key)??[];list.push({...report,roundId:raw.roundId,at:row.at});rounds.set(key,list);}
 const aggregated=[...rounds.values()].map(aggregate),metrics:CollectionHealthMetric[]=[];
 for(const channel of ['public','private'] as const){
  const history=aggregated.filter(report=>report.channel===channel).sort((a,b)=>b.at-a.at||b.roundId.localeCompare(a.roundId)),latest=history[0],label=channel==='public'?'公开':'私信';let streak=0;
  for(const report of history){if(!realFailure(report))break;streak++;}
  let level:CollectionHealthMetric['level']='normal',summary=label+'采集暂无诊断记录';
  if(latest){
   if(realFailure(latest)){level=streak>=3?'error':'attention';summary=label+(latest.status==='unsupported'?'采集结构尚未适配':latest.status==='partial'?'采集部分来源失败':'采集失败')+'（连续 '+streak+' 轮）';}
   else if(latest.status==='partial'){level='attention';summary=label+(BUDGET_CODES.has(latest.code)?'采集预算已结束，保留已采集结果':'采集部分资料仍需确认，已保留可用结果');}
   else if(latest.status==='blocked'){level='attention';summary=label+'采集需要人工解锁或处理';}
   else if(latest.status==='unknown'){level='attention';summary=label+'采集诊断无法确认，请检查该通道';}
   else summary=label+(latest.status==='empty'?'列表已确认正常为空':'采集正常');
  }
  metrics.push({key:'collection-'+channel,level,summary,value:streak,...(latest?{detail:{channel,roundId:latest.roundId,at:latest.at,status:latest.status,code:latest.code,eventCount:latest.eventCount,failureStreak:streak,failedPages:latest.failedPages??0}}:{})});
 }
 const oldWarnings=store.db.prepare("SELECT id,at,detail FROM logs WHERE event='collection-warning' AND at>=? AND json_valid(detail) AND json_extract(detail,'$.accountId')=? ORDER BY at DESC,id DESC LIMIT 100").all(now-86400000,accountId) as {id:number;at:number;detail:string}[];
 const latestByChannel=(['public','private'] as const).map(channel=>aggregated.filter(report=>report.channel===channel).sort((a,b)=>b.at-a.at)[0]);
 const unclassified=new Set<string>(),warningTimes:number[]=[];for(const row of oldWarnings){const raw=parse(row.detail),round=raw?.roundId;const superseded=latestByChannel.every(report=>report&&report.at>row.at&&!report.code.startsWith('legacy-')&&report.code!=='unclassified');if(typeof round==='string'&&!knownRoundIds.has(round)&&!superseded){unclassified.add(round);warningTimes.push(row.at);}}
 metrics.push({key:'collection-failures',level:unclassified.size?'attention':'normal',summary:unclassified.size?'历史采集告警缺少通道诊断，当前采集尚未复验，范围仍待确认':'采集诊断按通道分别判定',value:unclassified.size,...(unclassified.size?{detail:{kind:'legacy-warning' as const,firstAt:Math.min(...warningTimes),lastAt:Math.max(...warningTimes),roundCount:unclassified.size}}:{})});
 return metrics;
}
