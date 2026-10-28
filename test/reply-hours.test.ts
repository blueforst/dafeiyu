import test from 'node:test';
import assert from 'node:assert/strict';
import {replyWindow,effectiveAge} from '../src/reply-hours.js';
const at=(time:string)=>Date.parse(time+'+08:00');
const window=(now:string,patch:Partial<Parameters<typeof replyWindow>[0]>={})=>replyWindow({now:at(now),enabled:true,closeDelayMinutes:30,morning:{enabled:false,time:'08:00'},eveningTime:'23:00',...patch});

test('回复时段按北京时间在默认边界开关，停用早晚安任务仍关闭',()=>{
 assert.equal(window('2026-10-28T23:29:59.999').open,true);
 const closed=window('2026-10-28T23:30:00');assert.equal(closed.open,false);assert.equal(closed.reason,'reply-hours-closed');assert.equal(closed.opensAt,at('2026-10-29T08:00:00'));assert.equal(closed.closeTime,'23:30');assert.equal(closed.openTime,'08:00');
 assert.equal(window('2026-10-29T07:59:59.999').open,false);
 const opened=window('2026-10-29T08:00:00');assert.equal(opened.open,true);assert.equal(opened.openedAt,at('2026-10-29T08:00:00'));assert.equal(opened.closesAt,at('2026-10-29T23:30:00'));
 assert.equal(window('2026-10-29T01:00:00',{enabled:false}).open,true);
 assert.deepEqual(window('2026-10-29T01:00:00',{enabled:false}).closures,[]);
});

test('晚安加延迟跨零点或晚安本身在零点后，取关闭点之后的早安',()=>{
 const crossed=window('2026-10-29T00:30:00',{eveningTime:'23:30',closeDelayMinutes:60});assert.equal(crossed.open,false);assert.equal(crossed.closedAt,at('2026-10-29T00:30:00'));assert.equal(crossed.opensAt,at('2026-10-29T08:00:00'));assert.equal(crossed.closeTime,'00:30');
 assert.equal(window('2026-10-29T01:00:00',{eveningTime:'01:00',closeDelayMinutes:30}).open,true);
 assert.equal(window('2026-10-29T02:00:00',{eveningTime:'01:00',closeDelayMinutes:30}).opensAt,at('2026-10-29T08:00:00'));
 const zero=window('2026-10-29T08:01:00',{eveningTime:'07:30',closeDelayMinutes:30,morning:{enabled:true,time:'08:00'}});assert.equal(zero.open,true);assert.deepEqual(zero.closures,[]);
});

test('早安启用时等任一终态，未结束或无实例时最多等十五分钟',()=>{
 const morning={enabled:true,time:'08:00'},finished=at('2026-10-29T08:02:00');
 for(const status of ['completed','failed','missed','interrupted','unknown','skipped','cancelled']){
  const patch={morning,morningRunEnded:()=>finished};
  assert.equal(window('2026-10-29T08:01:00',patch).reason,'waiting-morning-post',status);
  const opened=window('2026-10-29T08:02:00',patch);assert.equal(opened.open,true,status);assert.equal(opened.openedAt,finished,status);
 }
 const waiting=window('2026-10-29T08:14:59.999',{morning,morningRunEnded:()=>null});assert.equal(waiting.open,false);assert.equal(waiting.reason,'waiting-morning-post');assert.equal(waiting.opensAt,at('2026-10-29T08:15:00'));
 assert.equal(window('2026-10-29T08:15:00',{morning}).open,true);
 assert.equal(window('2026-10-29T08:15:00',{morning,morningRunEnded:()=>at('2026-10-29T08:30:00')}).open,true);
});

test('有效等待扣除跨一个和两个关闭区间，交叠不重复扣除',()=>{
 const now=at('2026-10-29T08:30:00'),closures=window('2026-10-29T08:30:00').closures;
 assert.equal(effectiveAge(at('2026-10-29T02:00:00'),now,closures),30*60000);
 assert.equal(effectiveAge(at('2026-10-28T23:10:00'),now,closures),50*60000);
 assert.equal(effectiveAge(at('2026-10-27T23:10:00'),now,closures),(16*60+20)*60000);
 assert.equal(effectiveAge(0,100,[{start:10,end:60},{start:50,end:80}]),30);
 assert.equal(effectiveAge(now+1000,now,closures),0);
});
