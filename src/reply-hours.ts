/** 回复作息只计算北京时间时刻，不访问设置、数据库、浏览器或模型。 */
export type ReplyClosure={start:number;end:number};
export type ReplyWindow={open:boolean;reason:'reply-hours-closed'|'waiting-morning-post'|null;closedAt?:number;opensAt?:number;closesAt?:number;openedAt?:number;closeTime:string;openTime:string;closures:ReplyClosure[]};
export type ReplyWindowInput={now:number;enabled?:boolean;closeDelayMinutes?:number;morning:{enabled:boolean;time:string};eveningTime:string;morningRunEnded?:(scheduledAt:number)=>number|null|undefined};
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
 const base=Math.floor((now+offset)/day)*day-offset,raw:Array<ReplyClosure&{scheduledAt:number}>=[];
 // 保留最近四十八小时涉及的完整区间，并预算下一次开关；延迟跨零点仍按时刻轴处理。
 for(let d=-4;d<=2;d++){
  const start=base+d*day+close*minute,scheduledAt=start+duration*minute;
  let end=scheduledAt;
  if(input.morning.enabled){const finished=input.morningRunEnded?.(scheduledAt);end=typeof finished==='number'&&Number.isFinite(finished)?Math.max(scheduledAt,Math.min(finished,scheduledAt+15*minute)):scheduledAt+15*minute;}
  raw.push({start,end,scheduledAt});
 }
 const merged=mergedClosures(raw),current=merged.find(v=>v.start<=now&&now<v.end),next=merged.find(v=>v.start>now),previous=merged.filter(v=>v.end<=now).at(-1);
 result.closures=merged.filter(v=>v.end>now-2*day&&v.start<=now);
 if(previous)result.openedAt=previous.end;
 if(next){result.closesAt=next.start;result.opensAt=next.end;}
 if(current){result.open=false;result.closedAt=current.start;result.opensAt=current.end;result.reason=raw.some(v=>v.start<=now&&now<v.scheduledAt)?'reply-hours-closed':'waiting-morning-post';}
 return result;
}

/** 关闭区间先合并再扣除，交叠和未来区间都不会把等待时间重复扣成负数。 */
export function effectiveAge(receivedAt:number,now:number,closures:readonly ReplyClosure[]=[]):number{
 if(!Number.isFinite(receivedAt)||!Number.isFinite(now)||now<=receivedAt)return 0;
 let closed=0;for(const value of mergedClosures([...closures]))closed+=Math.max(0,Math.min(now,value.end)-Math.max(receivedAt,value.start));return Math.max(0,now-receivedAt-closed);
}
