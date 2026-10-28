/** 回复作息只计算北京时间时刻，不访问设置、数据库、浏览器或模型。 */
export type ReplyClosure={start:number;end:number};
export type ReplyMorningEnd={scheduledAt:number;endedAt:number};
/** 内部计时规则；不进入管理接口 DTO，不按历史天数展开 SQL。 */
export type ReplyAgePolicy={kind:'daily';periodMs:86400000;closeOffsetMs:number;closedDurationMs:number;morningDelayMs:number;overrides:ReplyMorningEnd[]};
export type ReplyAgeSource=readonly ReplyClosure[]|ReplyAgePolicy;
export type ReplyWindow={open:boolean;reason:'reply-hours-closed'|'waiting-morning-post'|null;closedAt?:number;opensAt?:number;closesAt?:number;openedAt?:number;closeTime:string;openTime:string;closures:ReplyClosure[];agePolicy?:ReplyAgePolicy};
export type ReplyWindowInput={now:number;enabled?:boolean;closeDelayMinutes?:number;morning:{enabled:boolean;time:string};eveningTime:string;morningRunEnded?:(scheduledAt:number)=>number|null|undefined;morningRunEnds?:readonly ReplyMorningEnd[]};
const minute=60000,day=86400000,offset=8*3600000;
function clockMinutes(value:string){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new Error('回复时段任务时间无效');const [h,m]=value.split(':').map(Number);return h*60+m;}
function clockText(value:number){const minutes=((value%1440)+1440)%1440;return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');}
function mergedClosures(values:ReplyClosure[]):ReplyClosure[]{
 const sorted=values.filter(v=>Number.isFinite(v.start)&&Number.isFinite(v.end)&&v.end>v.start).map(v=>({...v})).sort((a,b)=>a.start-b.start),result:ReplyClosure[]=[];
 for(const value of sorted){const previous=result.at(-1);if(previous&&value.start<=previous.end)previous.end=Math.max(previous.end,value.end);else result.push(value);}return result;
}
export function replyWindow(input:ReplyWindowInput):ReplyWindow{
 const {now}=input,enabled=input.enabled??true,delay=input.closeDelayMinutes??30;
 if(!Number.isFinite(now)||typeof enabled!=='boolean'||!Number.isInteger(delay)||delay<0||delay>180||typeof input.morning?.enabled!=='boolean')throw new Error('回复时段参数无效');
 const morning=clockMinutes(input.morning.time),close=clockMinutes(input.eveningTime)+delay,closeClock=close%1440,duration=(morning-closeClock+1440)%1440;
 const result:ReplyWindow={open:true,reason:null,closeTime:clockText(closeClock),openTime:clockText(morning),closures:[]};
 // 相同的关闭与早安时刻表示零长度区间，不额外等待早安任务。
 if(!enabled||duration===0)return result;
 const base=Math.floor((now+offset)/day)*day-offset,raw:Array<ReplyClosure&{scheduledAt:number}>=[],knownEnds=new Map<number,number>();
 for(const run of input.morningRunEnds??[])if(Number.isFinite(run.scheduledAt)&&Number.isFinite(run.endedAt))knownEnds.set(run.scheduledAt,run.endedAt);
 // 最近区间只供状态与界面展示；有效时效使用下面的全历史周期规则。
 for(let d=-4;d<=2;d++){
  const start=base+d*day+close*minute,scheduledAt=start+duration*minute;
  let end=scheduledAt;
  if(input.morning.enabled){const finished=knownEnds.get(scheduledAt)??input.morningRunEnded?.(scheduledAt);if(typeof finished==='number'&&Number.isFinite(finished))knownEnds.set(scheduledAt,finished);end=typeof finished==='number'&&Number.isFinite(finished)?Math.max(scheduledAt,Math.min(finished,scheduledAt+15*minute)):scheduledAt+15*minute;}
  raw.push({start,end,scheduledAt});
 }
 const merged=mergedClosures(raw),current=merged.find(v=>v.start<=now&&now<v.end),next=merged.find(v=>v.start>now),previous=merged.filter(v=>v.end<=now).at(-1);
 result.closures=merged.filter(v=>v.end>now-2*day&&v.start<=now);
 result.agePolicy={kind:'daily',periodMs:day,closeOffsetMs:closeClock*minute-offset,closedDurationMs:duration*minute,morningDelayMs:input.morning.enabled?15*minute:0,overrides:input.morning.enabled?[...knownEnds].map(([scheduledAt,endedAt])=>({scheduledAt,endedAt})):[]};
 if(previous)result.openedAt=previous.end;
 if(next){result.closesAt=next.start;result.opensAt=next.end;}
 if(current){result.open=false;result.closedAt=current.start;result.opensAt=current.end;result.reason=raw.some(v=>v.start<=now&&now<v.scheduledAt)?'reply-hours-closed':'waiting-morning-post';}
 // 名义关闭加早安等待覆盖整周期时，有限展示数组的末端不是保证开放的时间。
 // 只有真实提前终态形成的间隙能确定下一次开放，未知时沿用可选字段语义。
 if(input.morning.enabled&&duration*minute+15*minute>=day){const confirmed=policyParts(result.agePolicy).corrections.find(interval=>interval.start>now);if(confirmed)result.opensAt=confirmed.start;else delete result.opensAt;}
 return result;
}

function isPolicy(source:ReplyAgeSource):source is ReplyAgePolicy{return !Array.isArray(source);}
function policyParts(policy:ReplyAgePolicy){
 if(policy.kind!=='daily'||policy.periodMs!==day||!Number.isFinite(policy.closeOffsetMs)||!Number.isFinite(policy.closedDurationMs)||policy.closedDurationMs<=0||policy.closedDurationMs>=day||!Number.isFinite(policy.morningDelayMs)||policy.morningDelayMs<0||policy.morningDelayMs>15*minute||!Array.isArray(policy.overrides))throw new Error('回复时段计时策略无效');
 const closed=Math.min(day,policy.closedDurationMs+policy.morningDelayMs),open=day-closed,corrections:ReplyClosure[]=[];
 for(const run of policy.overrides){
  if(!Number.isFinite(run?.scheduledAt)||!Number.isFinite(run?.endedAt))continue;
  // 任务计划变更后仍按当前作息回算；旧计划的其他时刻不冒充当前早安实例。
  const phase=((run.scheduledAt-policy.closeOffsetMs-policy.closedDurationMs)%day+day)%day;if(phase!==0)continue;
  const end=run.scheduledAt+Math.min(policy.morningDelayMs,day-policy.closedDurationMs),start=Math.max(run.scheduledAt,Math.min(run.endedAt,end));
  if(end>start)corrections.push({start,end});
 }
 return {closed,open,corrections:mergedClosures(corrections)};
}
/** 周期开放时间的原函数，负时间也取数学floor；两个端点之差不依赖跨度。 */
function periodicOpenAt(at:number,anchor:number,closed:number){const cycles=Math.floor((at-anchor)/day),phase=at-anchor-cycles*day;return cycles*(day-closed)+Math.max(0,phase-closed);}
/** 旧显式区间仍先合并；新周期规则数学计时，历史没有固定天数截断。 */
export function effectiveAge(receivedAt:number,now:number,source:ReplyAgeSource=[]):number{
 if(!Number.isFinite(receivedAt)||!Number.isFinite(now)||now<=receivedAt)return 0;
 if(isPolicy(source)){
  const {closed,corrections}=policyParts(source);let age=periodicOpenAt(now,source.closeOffsetMs,closed)-periodicOpenAt(receivedAt,source.closeOffsetMs,closed);
  for(const interval of corrections)age+=Math.max(0,Math.min(now,interval.end)-Math.max(receivedAt,interval.start));
  return Math.max(0,Math.min(now-receivedAt,age));
 }
 let closed=0;for(const value of mergedClosures([...source]))closed+=Math.max(0,Math.min(now,value.end)-Math.max(receivedAt,value.start));return Math.max(0,now-receivedAt-closed);
}
/** field只能是调用方固定的内部SQL字段；策略数值校验后作为常量，例外用一个JSON参数。 */
export function effectiveAgeSql(field:string,at:number,source:ReplyAgeSource=[]):{sql:string;params:(number|string)[]}{
 if(isPolicy(source)){
  const {closed,open,corrections}=policyParts(source),x=`((${field})-(${source.closeOffsetMs}))`,quotient=`CAST((${x})/${day} AS INTEGER)`,cycles=`(${quotient}-CASE WHEN ${x}<0 AND ${x}<>(${quotient})*${day} THEN 1 ELSE 0 END)`;
  // 不依赖可选SQLite数学扩展；CAST加负余数修正与Math.floor口径相同。
  const base=open===0?'0':`((${cycles})*${open}+MAX(0,${x}-(${cycles})*${day}-${closed}))`,params:(number|string)[]=[at,periodicOpenAt(at,source.closeOffsetMs,closed)];
  // 新消息晚于最后一个历史差量，或统计截止尚未进入首个差量时，完全不用扫描JSON。
  // 保留完整历史；只有区间确定不相交才走零分支，边界仍是半开区间。
  const needsCorrections=corrections.length>0&&at>corrections[0].start,lastCorrectionEnd=corrections.at(-1)?.end;
  const correction=needsCorrections?' + CASE WHEN ('+field+')>='+lastCorrectionEnd+' THEN 0 ELSE COALESCE((SELECT SUM(MAX(0,MIN(?,json_extract(age_override.value,\'$.end\'))-MAX('+field+',json_extract(age_override.value,\'$.start\')))) FROM json_each(?) age_override),0) END':'';
  if(needsCorrections)params.push(at,JSON.stringify(corrections));
  return {sql:`MAX(0,MIN(?-(${field}),?-(${base})${correction}))`,params};
 }
 const intervals=mergedClosures([...source]).filter(x=>x.start<at).map(x=>({start:x.start,end:Math.min(at,x.end)}));
 return {sql:'MAX(0,(? - '+field+')'+intervals.map(()=>'- MAX(0,? - MAX('+field+',?))').join('')+')',params:[at,...intervals.flatMap(x=>[x.end,x.start])]};
}
