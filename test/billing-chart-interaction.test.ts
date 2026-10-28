import test from 'node:test';
import assert from 'node:assert/strict';
// 图表模块顶层不读取 DOM，纯函数可直接用 Node 验证；无需增加模拟 DOM 依赖。
import {positionTooltip} from '../public/js/charts/tooltip.js';
import {heatmapTooltip,moveHeatIndex,trendData,trendTooltip,shareData,shareTooltip,days} from '../public/js/charts/usage.js';
const row=(date:string,model:string,totalTokens:number,costUSD:number|null,unpriced=0)=>({date,model,provider:'fixture',totalTokens,calls:1,costUSD,unpriced});
test('提示框右下放置并在四边翻转、夹紧',()=>{
 assert.deepEqual(positionTooltip({width:300,height:200},{width:80,height:50},{x:20,y:20}),{left:32,top:32});
 assert.deepEqual(positionTooltip({width:300,height:200},{width:80,height:50},{x:290,y:20}),{left:198,top:32});
 assert.deepEqual(positionTooltip({width:300,height:200},{width:80,height:50},{x:20,y:190}),{left:32,top:128});
 assert.deepEqual(positionTooltip({width:300,height:200},{width:80,height:50},{left:280,top:180,right:290,bottom:190}),{left:188,top:118});
 assert.deepEqual(positionTooltip({width:40,height:25},{width:80,height:50},{x:0,y:0}),{left:0,top:0});
 assert.deepEqual(positionTooltip({width:300,height:200},{width:80,height:50},{x:-50,y:-50}),{left:0,top:0});
});
const activity={range:{from:'2026-10-18'},daily:[{date:'2026-10-19',calls:2,totalTokens:12000,costUSD:.0123,unpriced:1},{date:'2026-10-25',calls:1,totalTokens:3,costUSD:null,unpriced:1}]};
test('热力图每日含北京星期、token/调用/费用及未定价',()=>{const t=heatmapTooltip(activity,'daily',1);assert.match(t.title,/10月19日.*周一/);assert.equal(t.rows[0].value,'1.2万');assert.match(t.rows[0].unit,/token · 2 次/);assert.equal(t.rows[1].value,'$0.0123');assert.match(t.rows[1].unit,/1 次未定价/);});
test('热力图每周和累计不丢未知费用与未定价附注',()=>{const weekly=heatmapTooltip(activity,'weekly',8);assert.match(weekly.title,/10月25日.*10月31日/);assert.equal(weekly.rows[1].value,'费用未知');const cumulative=heatmapTooltip(activity,'cumulative',8);assert.match(cumulative.title,/截至 10月31日/);assert.equal(cumulative.rows[0].value,'1.2万');assert.match(cumulative.rows[0].unit,/3 次/);assert.match(cumulative.rows[1].unit,/2 次未定价/);});
test('热力键盘按周、跨日和边界移动',()=>{assert.equal(moveHeatIndex(7,'ArrowLeft'),0);assert.equal(moveHeatIndex(6,'ArrowDown'),7);assert.equal(moveHeatIndex(7,'ArrowUp'),6);assert.equal(moveHeatIndex(0,'ArrowUp'),0);assert.equal(moveHeatIndex(363,'ArrowRight'),363);assert.equal(moveHeatIndex(12,'Home'),0);assert.equal(moveHeatIndex(0,'End'),363);assert.equal(moveHeatIndex(12,'ArrowDown','weekly'),12);assert.equal(moveHeatIndex(12,'ArrowRight','cumulative'),19);});
const summary={dailyModels:[row('2026-10-19','A',10,.01),row('2026-10-19','B',30,null,1),row('2026-10-19','C',0,0),row('2026-10-20','A',20,.02)]};
test('趋势提示按数值降序，0值过滤，空日只显示合计0',()=>{const c=trendData(summary,{from:'2026-10-19',to:'2026-10-22'});const t=trendTooltip(c,0);assert.match(t.title,/合计 40 token/);assert.deepEqual(t.rows.map(x=>x.name),['fixture / B','fixture / A']);assert.match(t.rows[0].unit,/token/);const empty=trendTooltip(c,2);assert.match(empty.title,/合计 0 token/);assert.deepEqual(empty.rows,[]);});
test('费用提示只累加已知部分，未定价不视为0线',()=>{const c=trendData(summary,{from:'2026-10-19',to:'2026-10-22'},'costUSD'),t=trendTooltip(c,0,'costUSD');assert.match(t.title,/合计 \$0.01.*另有未定价/);assert.equal(t.rows.find(r=>r.name==='fixture / B')?.value,'未定价');assert.equal(c.series.find(s=>s.name==='fixture / B')?.unpriced,true);assert.deepEqual(trendTooltip(c,2,'costUSD').rows,[]);});
test('全部未定价费用显示未知合计而非免费',()=>{const c=trendData({dailyModels:[row('2026-10-19','B',30,null,1)]},{from:'2026-10-19',to:'2026-10-20'},'costUSD');assert.match(trendTooltip(c,0,'costUSD').title,/费用未知.*另有未定价/);});
test('单日与30日保持首尾日期，超过5模型合为其他模型',()=>{const one=trendData(summary,{from:'2026-10-19',to:'2026-10-20'});assert.equal(one.dates.length,1);assert.match(trendTooltip(one,0).title,/10月19日/);const thirty=trendData({dailyModels:Array.from({length:7},(_,i)=>row('2026-10-19','M'+i,i+1,.01))},{from:'2026-10-01',to:'2026-10-31'});assert.equal(thirty.dates.length,30);assert.equal(thirty.series.length,6);assert.equal(thirty.series.at(-1)?.name,'其他模型');assert.match(trendTooltip(thirty,29).title,/10月30日/);});
test('环形其他分区合计及百分比，未知与未定价费用分别展示',()=>{const rows=shareData({models:Array.from({length:8},(_,i)=>({model:'M'+i,totalTokens:i+1,calls:1,costUSD:null,unpriced:1}))});assert.equal(rows.length,7);assert.equal(rows.at(-1)?.name,'其他');assert.equal(rows.at(-1)?.totalTokens,3);assert.equal(rows.at(-1)?.unpriced,2);const t=shareTooltip(rows.at(-1),36);assert.equal(t.title,'其他');assert.match(t.rows[0].unit,/8.3%/);assert.equal(t.rows[1].value,'未定价');assert.equal(shareTooltip({name:'旧用量',totalTokens:1,costUSD:null},1).rows[1].value,'费用未知');});
