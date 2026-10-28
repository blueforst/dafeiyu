// 服务器最小红／绿探针；只使用既有 replyWindow 对象，不依赖周期策略新导出。
import test from 'node:test';
import assert from 'node:assert/strict';
import {replyWindow} from '../src/reply-hours.js';

const at=(clock:string)=>Date.parse('2026-10-29T'+clock+'+08:00');
const shortWindow=(now:number,morningRunEnded?:(scheduledAt:number)=>number|null)=>replyWindow({now,enabled:true,closeDelayMinutes:0,morning:{enabled:true,time:'08:00'},eveningTime:'08:01',morningRunEnded});

test('开放仅一分钟而晨间等待覆盖全天时，不把有限样本的末尾伪称下次开放',()=>{
 const window=shortWindow(at('08:02:00'),()=>null);
 assert.equal(window.open,false);
 assert.equal(window.opensAt,undefined,'没有任何可确认的下一次开放，不能使用有限区间数组的最后结束时间');
 assert.equal(window.openTime,'08:00','保留计划时刻展示，不能把它当作已确认开放时间');
});

test('明确早安终态只开放真实的一分钟间隙，关闭后不承诺未知未来开放',()=>{
 const morning=at('08:00:00'),ended=at('08:00:30'),readEnd=(scheduledAt:number)=>scheduledAt===morning?ended:null;
 assert.equal(shortWindow(ended-1,readEnd).open,false);
 const opened=shortWindow(ended,readEnd);assert.equal(opened.open,true);assert.equal(opened.openedAt,ended);assert.equal(opened.closesAt,at('08:01:00'));
 assert.equal(shortWindow(at('08:00:59.999'),readEnd).open,true);
 const closed=shortWindow(at('08:01:00'),readEnd);assert.equal(closed.open,false);assert.equal(closed.opensAt,undefined,'本次真实间隙结束以后，下一次开放仍未确定');
});
