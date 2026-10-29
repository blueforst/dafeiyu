import {h,set,fmtDateTime} from '../dom.js';
import {api} from '../api.js';
import {heatmap,trend,share,compact,money,addDays,destroyCharts} from '../charts/usage.js';
import {empty,errorBox,fmtUsd} from '../view-utils.js';

const PURPOSE={
 reply:'回复',
 'semantic-trigger':'语义触发',
 'daily-state':'虚构日程',
 'memory-summary':'记忆整理',
 'model-test':'连接测试',
 'cli-test':'CLI 测试',
 'persona-preview':'人设试聊（旧接口）',
 'chat-test':'试聊',
 'morning-post':'早安帖',
 'evening-post':'晚安帖',
 'persona-replay':'人设回放',
 'legacy-unknown':'历史用量'
};
const STATUS={completed:'完成',failed:'失败',aborted:'已中止',interrupted:'重启中断',started:'进行中'};

function today(){
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
}

function pills(items,onChange,initial){
 const box=h('div',{class:'segmented',role:'group'});
 for(const [value,label]of items){
  const b=h('button',{
   class:'btn small',
   type:'button',
   'aria-pressed':String(value===initial),
   onclick:()=>{
    for(const c of box.children)c.setAttribute('aria-pressed',String(c===b));
    onChange(value);
   }
  },label);
  box.append(b);
 }
 return box;
}

export function mount(root,ctx={}){
 let alive=true,generation=0,activity=null,summary=null,heatMode='daily',trendMetric='totalTokens',shareGroup='models',shareTable=false,cursor=null,query='',loadingCalls=false,callsLoaded=false,custom=false;
 const day=today();
 const from=h('input',{type:'date',class:'input small','aria-label':'开始日期',value:addDays(day,-6)});
 const to=h('input',{type:'date',class:'input small','aria-label':'结束日期',value:day});
 const purpose=h('select',{class:'input small','aria-label':'用途',onchange:()=>{custom=true;loadRange();}},
  h('option',{value:''},'全部用途'),
  Object.entries(PURPOSE).map(([id,l])=>h('option',{value:id},l))
 );

 const metrics=h('div',{class:'ws-stats usage-summary'},empty('正在读取用量…'));
 const heat=h('div');
 const line=h('div');
 const donut=h('div');
 const state=h('div',{role:'status',class:'muted small',hidden:true});
 const calls=h('div',{class:'stack'});
 const more=h('button',{class:'btn small',hidden:true,type:'button',onclick:()=>loadCalls(true)},'加载更多调用');
 const rangeLabel=h('small',{class:'muted'},`${from.value} 至 ${to.value}`);

 const preset=pills([['1','今日'],['7','近 7 日'],['30','近 30 日'],['month','本月']],v=>{
  if(v==='1'){from.value=day;to.value=day;}
  else if(v==='7'){from.value=addDays(day,-6);to.value=day;}
  else if(v==='30'){from.value=addDays(day,-29);to.value=day;}
  else if(v==='month'){from.value=day.slice(0,8)+'01';to.value=day;}
  purpose.value='';
  custom=false;
  loadRange();
 },'7');

 const refreshBtn=h('button',{class:'btn ghost small ws-icon-btn',type:'button',title:'刷新','aria-label':'刷新',onclick:()=>loadAll()},'↻');
 const headActions=h('div',{class:'row'},preset,refreshBtn);
 if(ctx.setActions)ctx.setActions(headActions);

 const callFilters=h('div',{
  class:'usage-calls-filters',
  onclick:e=>e.stopPropagation()
 },
  purpose,
  from,
  h('span',{class:'muted small'},'至'),
  to,
  h('button',{
   class:'btn small',
   type:'button',
   onclick:e=>{
    e.stopPropagation();
    custom=true;
    for(const c of preset.children)c.setAttribute('aria-pressed','false');
    loadRange();
   }
  },'应用筛选')
 );

 const callDetails=h('details',{class:'ws-advanced card usage-calls'},
  h('summary',{class:'ws-advanced-head usage-calls-summary'},
   h('span',{class:'ws-advanced-chev','aria-hidden':'true'},'▸'),
   h('strong',{},'调用流水'),
   rangeLabel,
   h('span',{class:'grow'}),
   callFilters
  ),
  h('div',{class:'ws-advanced-body stack settings-body'},calls,more)
 );

 set(root,h('div',{class:'stack billing-page'},
  ctx.workspace?null:h('div',{class:'toolbar'},h('h1',{class:'page-title grow'},'计费'),headActions),
  metrics,
  state,
  h('div',{class:'billing-charts-grid'},
   h('section',{class:'ws-card card stack billing-trend-card'},
    h('div',{class:'ws-card-head toolbar'},
     h('h2',{class:'card-h'},'每日用量'),
     h('small',{class:'muted'},'按模型'),
     h('span',{class:'grow'}),
     pills([['totalTokens','token'],['costUSD','费用']],v=>{trendMetric=v;renderCharts();},'totalTokens')
    ),
    line
   ),
   h('section',{class:'ws-card card stack billing-share-card'},
    h('div',{class:'ws-card-head toolbar'},
     h('h2',{class:'card-h grow'},'用量占比'),
     pills([['models','按模型'],['purposes','按用途']],v=>{shareGroup=v;renderCharts();},'models'),
     h('button',{
      class:'btn small',
      type:'button',
      onclick:e=>{
       shareTable=!shareTable;
       e.currentTarget.textContent=shareTable?'图形':'表格';
       renderCharts();
      }
     },'表格')
    ),
    donut
   )
  ),
  h('section',{class:'ws-card card stack billing-heat-card'},
   h('div',{class:'ws-card-head toolbar'},
    h('h2',{class:'card-h'},'活动'),
    h('small',{class:'muted grow'},'近一年 · 每格一天'),
    pills([['daily','每日'],['weekly','每周'],['cumulative','累计']],v=>{heatMode=v;renderHeat();},'daily')
   ),
   heat
  ),
  callDetails
 ));

 function updateRangeLabel(){
  const count=summary?.totals?.calls??activity?.totals?.calls??0;
  rangeLabel.textContent=`${from.value} 至 ${to.value} · 共 ${count} 次调用`;
 }

 function renderHeader(){
  const t=summary?.totals||activity?.totals||{};
  const cache=summary?.cache?.ratio??activity?.last7?.cache?.ratio;
  const average=activity?.last7?.reply?.averageCostUSD;
  const peak=summary?.daily?.length
   ?Math.max(Number(activity?.peakDailyTokens||0),...summary.daily.map(d=>Number(d.totalTokens||0)))
   :activity?.peakDailyTokens;
  const costNode=t.costUSD==null
   ?h('span',{class:'ws-usd',title:'费用未知'},'—')
   :fmtUsd(t.costUSD);
  const avgNode=average==null
   ?h('span',{class:'ws-usd',title:'费用未知'},'—')
   :fmtUsd(average);
  const unpricedSub=(t.unpriced||t.unknown)
   ?`另有 ${t.unpriced||0} 次未定价 / ${t.unknown||0} 次未知`
   :'Pi 目录估算';

  const items=[
   ['累计 token',compact(t.totalTokens),'token'],
   ['可估算费用',costNode,unpricedSub],
   ['单日峰值',compact(peak),'token'],
   ['缓存读取占比',cache==null?'—':(cache*100).toFixed(1)+'%','缓存读取 /（输入 + 缓存读取）'],
   ['每次回复均费',avgNode,'仅含已定价回复']
  ];
  set(metrics,items.map(([title,v,sub])=>h('div',{class:'ws-stat-cell usage-stat'},
   h('span',{class:'ws-stat-label muted small'},title),
   h('strong',{class:'ws-stat-value numbers'},v),
   h('span',{class:'faint small'},sub)
  )));
 }

 function renderHeat(){
  if(!activity)return;
  const filtered=custom?{...activity,daily:purpose.value?(summary?.daily||[]):activity.daily.filter(d=>d.date>=from.value&&d.date<=to.value)}:activity;
  destroyCharts(heat);
  set(heat,heatmap(filtered,heatMode));
 }

 function renderCharts(){
  if(!summary)return;
  const range={from:from.value,to:addDays(to.value,1)};
  destroyCharts(line);
  destroyCharts(donut);
  set(line,trend(summary,range,trendMetric));
  set(donut,share(summary,shareGroup,shareTable,PURPOSE));
 }

 async function loadRange(){
  if(!from.value||!to.value||from.value>to.value){
   state.hidden=false;
   state.textContent='请选择有效日期范围';
   return;
  }
  const n=++generation;
  state.hidden=true;
  state.textContent='';
  query=new URLSearchParams({from:from.value,to:addDays(to.value,1),...(purpose.value?{purpose:purpose.value}:{})}).toString();
  callsLoaded=false;
  cursor=null;
  set(calls);
  more.hidden=true;
  try{
   const data=await api('/api/billing/summary?'+query);
   if(!alive||n!==generation)return;
   summary=data;
   updateRangeLabel();
   renderHeader();
   renderCharts();
   renderHeat();
   if(callDetails.open)loadCalls();
  }catch(e){
   if(alive&&n===generation){
    state.hidden=false;
    state.textContent='读取失败：'+e.message;
    destroyCharts(line);
    destroyCharts(donut);
    set(line,empty('当前无法读取趋势'));
    set(donut,empty('当前无法读取用量占比'));
   }
  }
 }

 async function loadAll(){
  try{
   activity=await api('/api/billing/activity?weeks=52');
   if(!alive)return;
   updateRangeLabel();
   renderHeader();
   renderHeat();
  }catch(e){
   if(alive)errorBox(metrics,e,loadAll);
  }
  await loadRange();
 }

 function callRow(c){
  const u=c.usage;
  const price=c.pricingStatus==='unpriced'?'未定价':c.cost?.total==null?money(null):fmtUsd(c.cost.total);
  return h('article',{class:'call-record subcard stack'},
   h('div',{class:'toolbar'},
    h('b',{class:'grow'},PURPOSE[c.purpose]||c.purpose),
    h('span',{class:'small muted'},STATUS[c.status]||c.status)
   ),
   h('div',{class:'small muted break'},fmtDateTime(c.startedAt)+' · '+[c.provider,c.model].filter(Boolean).join(' / ')+' · '+(c.latencyMs??'未知')+' ms'),
   h('div',{class:'toolbar'},
    h('span',{class:'numbers grow'},u?compact(u.totalTokens)+' token':'用量未知'),
    h('b',{},price)
   ),
   h('details',{},
    h('summary',{class:'small'},'分项与关联'),
    h('div',{class:'small pre-wrap'},
     u
      ?'输入 '+compact(u.input)+' · 输出 '+compact(u.output)+'\n缓存读取 '+compact(u.cacheRead)+' · 缓存写入 '+compact(u.cacheWrite)+(u.reasoning==null?'':' · 思考 '+compact(u.reasoning)+'（含于输出）')
      :'没有可靠用量',
     '\n调用 '+c.id+'\n来源 '+(c.source||'未知')+(c.interactionId?'\n关联 '+c.interactionId:'')
    )
   )
  );
 }

 async function loadCalls(append=false){
  if(loadingCalls||!query)return;
  loadingCalls=true;
  more.disabled=true;
  const expected=query;
  try{
   const page=await api('/api/billing/calls?'+expected+(append&&cursor?'&cursor='+encodeURIComponent(cursor):''));
   if(!alive||query!==expected)return;
   if(!append)set(calls);
   calls.append(...(page.items||[]).map(callRow));
   if(!calls.children.length)calls.append(empty('该范围没有调用流水'));
   cursor=page.nextCursor;
   more.hidden=!cursor;
   callsLoaded=true;
  }catch(e){
   if(alive)errorBox(calls,e,()=>loadCalls());
  }finally{
   loadingCalls=false;
   more.disabled=false;
  }
 }

 callDetails.ontoggle=()=>{if(callDetails.open&&!callsLoaded)loadCalls();};
 loadAll();
 return()=>{alive=false;destroyCharts(heat);destroyCharts(line);destroyCharts(donut);};
}
