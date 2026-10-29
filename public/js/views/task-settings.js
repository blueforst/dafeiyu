import {h,set,fmtDateTime} from '../dom.js';
import {api} from '../api.js';
import {notice,onEvent} from '../state.js';
import {empty,editorGuard,errorBox,billingBadge,money,fmtUsd,advanced,rowActions} from '../view-utils.js';
import {formatNotice} from '../reply-format.js';

const LABEL={main:'主循环','daily-state':'虚构日程','memory-summary':'记忆补整理','morning-post':'早安帖','evening-post':'晚安帖',backup:'数据库备份',health:'宿主健康检查','daily-report':'每日日报','account-check':'账号合规检查'};
const SHORT_LABEL={'daily-state':'虚构日程','memory-summary':'记忆补整理','morning-post':'早安帖','evening-post':'晚安帖',backup:'备份','daily-report':'日报','account-check':'合规检查'};
const STATUS={running:'执行中',completed:'完成',failed:'失败',unknown:'待回查',missed:'错过窗口',skipped:'跳过',cancelled:'已取消',aborted:'已中止',interrupted:'重启中断'};
const BILLING_TASKS=new Set(['daily-state','memory-summary','morning-post','evening-post']);

function taskCost(run,calls=[]){
  const cost=run.cost;
  if(cost){
    const hasCalls=Number(cost.calls||0)>0||Number(cost.costUSD||0)>0||Number(cost.unpriced||0)>0||Number(cost.unknown||0)>0;
    if(!hasCalls&&!BILLING_TASKS.has(run.taskId)&&run.taskId!=='main')return '—';
    return money(cost.costUSD)+(cost.unpriced?' · 未定价 '+cost.unpriced:'')+(cost.unknown?' · 用量未知 '+cost.unknown:'')+(cost.missing?' · 缺失 '+cost.missing:'');
  }
  if(run.fees)return money(run.fees.estimatedUsd);
  if(!calls.length)return '—';
  const priced=calls.every(c=>c.pricingStatus!=='unpriced'&&Number.isFinite(c.cost?.total));
  return priced?money(calls.reduce((n,c)=>n+c.cost.total,0)):'未定价或用量未知';
}

function runCostUsd(run){
  const cost=run?.cost;
  if(cost){
    const hasCalls=Number(cost.calls||0)>0||Number(cost.costUSD||0)>0;
    if(!hasCalls&&!BILLING_TASKS.has(run.taskId)&&run.taskId!=='main')return null;
    return Number.isFinite(Number(cost.costUSD))&&Number(cost.costUSD)>0?Number(cost.costUSD):hasCalls&&Number(cost.costUSD)===0?0:null;
  }
  if(run?.fees&&Number.isFinite(Number(run.fees.estimatedUsd)))return Number(run.fees.estimatedUsd);
  return null;
}

function fmtDuration(ms){
  if(!Number.isFinite(Number(ms)))return '—';
  const n=Number(ms);
  return n>=1000?(n/1000).toFixed(1)+' s':Math.round(n)+' ms';
}

function parseHours(hhmm){
  const m=/^(\d{1,2}):(\d{2})$/.exec(String(hhmm||'').trim());
  if(!m)return null;
  return Number(m[1])+Number(m[2])/60;
}

function beijingNowHHMM(){
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(Date.now());
}

/** 将连续且相同任务的成功记录合并为一组；失败、取消、执行中记录保持独立。支持跨页拼接。 */
export function groupRuns(runs=[]){
  const flat=[];
  for(const item of runs||[]){
    if(!item)continue;
    if(item.kind==='group'&&Array.isArray(item.items))flat.push(...item.items);
    else if(item.kind==='single'&&item.run)flat.push(item.run);
    else flat.push(item);
  }
  const groups=[];
  for(const run of flat){
    const taskId=run.taskId??run.task??'';
    const status=run.status??'';
    const prev=groups.at(-1);
    if(status==='completed'&&prev&&prev.status==='completed'&&prev.taskId===taskId){
      prev.items.push(run);
    }else{
      groups.push({taskId,status,items:[run]});
    }
  }
  return groups.map(g=>{
    if(g.items.length===1){
      const r=g.items[0];
      return {
        kind:'single',
        id:r.id,
        taskId:g.taskId,
        status:g.status,
        count:1,
        run:r,
        items:g.items,
        fromAt:r.startedAt||r.scheduledAt||0,
        toAt:r.startedAt||r.scheduledAt||0,
        avgDurationMs:Number.isFinite(Number(r.durationMs))?Number(r.durationMs):null,
        totalCostUSD:runCostUsd(r),
      };
    }
    const times=g.items.map(r=>Number(r.startedAt||r.scheduledAt||0)).filter(n=>n>0);
    const durs=g.items.map(r=>Number(r.durationMs)).filter(n=>Number.isFinite(n));
    const costs=g.items.map(runCostUsd).filter(n=>n!==null&&Number.isFinite(n)&&n>0);
    return {
      kind:'group',
      id:'group:'+g.items[0].id+':'+g.items.at(-1).id,
      taskId:g.taskId,
      status:'completed',
      count:g.items.length,
      items:g.items,
      fromAt:times.length?Math.min(...times):0,
      toAt:times.length?Math.max(...times):0,
      avgDurationMs:durs.length?Math.round(durs.reduce((a,b)=>a+b,0)/durs.length):null,
      totalCostUSD:costs.length?costs.reduce((a,b)=>a+b,0):null,
    };
  });
}

export function mount(root,ctx){
  let alive=true,revision=0,busy=false,currentTasks=[],replyHours=null,replyHoursEnabled=true,advEl=null;
  const forms=new Map(),timelineCard=h('div',{class:'ws-card tasks-timeline-card'}),tableCard=h('div',{class:'ws-card tasks-table-card'}),advHolder=h('div'),state=h('span',{role:'status',class:'small muted'});
  const save=h('button',{class:'btn primary small',id:'tasks-save',type:'button',onclick:saveAll},'保存');
  ctx.setActions?.(save);
  const footer=h('div',{class:'tasks-footer'},h('span',{},'主循环由顶部“启动 / 暂停”控制'),h('a',{href:'#/settings/history',class:'settings-history-link'},'查看任务执行历史 →'),state);
  const page=h('div',{class:'ws-stack settings-tasks'},timelineCard,tableCard,footer,advHolder);
  set(root,page);
  const dirty=()=>[...forms.values()].some(f=>JSON.stringify(f.value())!==f.saved);
  const guard=editorGuard(ctx,page,dirty);

  function renderTimeline(){
    const daily=currentTasks
      .filter(t=>t.time!==undefined)
      .map(t=>{
        const f=forms.get(t.id),val=f?f.value():t;
        const timeStr=val.time??t.time;
        const hours=parseHours(timeStr);
        return hours===null?null:{id:t.id,title:SHORT_LABEL[t.id]||LABEL[t.id]||t.title||t.id,fullTitle:LABEL[t.id]||t.title||t.id,time:timeStr,hours,enabled:val.enabled??t.enabled};
      })
      .filter(Boolean)
      .sort((a,b)=>a.hours-b.hours||a.id.localeCompare(b.id));

    const tl=h('div',{class:'tasks-timeline tasks-tl',id:'tasks-timeline'});
    tl.append(h('div',{class:'tasks-tl-axis tl-axis'}));

    if(replyHoursEnabled&&replyHours){
      const closeH=parseHours(replyHours.closeTime||'23:30')??23.5;
      const openH=parseHours(replyHours.openTime||'08:00')??8;
      if(closeH>openH){
        if(openH>0)tl.append(h('div',{class:'tasks-tl-closed tl-closed',style:`left:0%;width:${(openH/24*100).toFixed(2)}%`},'不回复'));
        if(closeH<24)tl.append(h('div',{class:'tasks-tl-closed tl-closed',style:`left:${(closeH/24*100).toFixed(2)}%;width:${((24-closeH)/24*100).toFixed(2)}%`}));
      }else if(closeH<openH){
        tl.append(h('div',{class:'tasks-tl-closed tl-closed',style:`left:${(closeH/24*100).toFixed(2)}%;width:${((openH-closeH)/24*100).toFixed(2)}%`},'不回复'));
      }
    }

    for(const tickH of [0,3,6,9,12,15,18,21,24]){
      tl.append(h('span',{class:'tasks-tl-tick tl-tick',style:`left:${(tickH/24*100).toFixed(2)}%`},String(tickH).padStart(2,'0')+':00'));
    }

    // 两行交错排布并保证同一行的标签水平间距充足、互不重叠
    const lastPct={a:-100,b:-100};
    const evNodes={a:[],b:[]};
    daily.forEach((item,idx)=>{
      const rawPct=item.hours/24*100;
      const preferred=idx%2===0?'a':'b';
      const alt=preferred==='a'?'b':'a';
      const minGap=Math.max(8,item.title.length*2.2+3);
      const rowKey=(rawPct-lastPct[preferred]>=minGap||rawPct-lastPct[alt]<rawPct-lastPct[preferred])?preferred:alt;
      const labelPct=Math.min(96,Math.max(4,Math.max(rawPct,lastPct[rowKey]+minGap)));
      lastPct[rowKey]=labelPct;
      const ev=h('div',{
        class:`tasks-tl-ev tl-ev row-${rowKey}${item.enabled?'':' is-off off'}`,
        dataset:{tlTask:item.id,row:rowKey},
        title:`${item.fullTitle} ${item.time}`,
        style:`left:${labelPct.toFixed(2)}%`,
      },h('span',{class:'tl-ev-text'},item.title),h('span',{class:'tasks-tl-stem tl-stem'}));
      const dot=h('i',{
        class:`tasks-tl-dot tl-dot${item.enabled?'':' is-off off'}`,
        dataset:{tlTask:item.id},
        title:`${item.fullTitle} ${item.time}`,
        style:`left:${rawPct.toFixed(2)}%`,
      });
      evNodes[rowKey].push(ev);
      tl.append(ev,dot);
    });

    const nowStr=beijingNowHHMM(),nowH=parseHours(nowStr)??12,nowPct=(nowH/24*100).toFixed(2);
    tl.append(
      h('div',{class:'tasks-tl-now tl-now',style:`left:${nowPct}%`}),
      h('span',{class:'tasks-tl-now-label tl-now-label',style:`left:${nowPct}%`},'现在 '+nowStr)
    );

    set(timelineCard,
      h('div',{class:'ws-card-head'},h('b',{},'今天的安排'),h('small',{},'北京时间')),
      tl
    );

    queueMicrotask(()=>{
      if(!tl.isConnected)return;
      const boxRect=tl.getBoundingClientRect();
      if(boxRect.width<=0)return;
      for(const key of ['a','b']){
        let prevRight=-Infinity;
        for(const node of evNodes[key]){
          const r=node.getBoundingClientRect();
          if(r.left<prevRight+4){
            const shift=prevRight+4-r.left;
            const currentLeftPx=(parseFloat(node.style.left)||0)/100*boxRect.width;
            node.style.left=Math.min(98,(currentLeftPx+shift)/boxRect.width*100).toFixed(2)+'%';
          }
          prevRight=node.getBoundingClientRect().right;
        }
      }
    });
  }

  function advSummary(){
    const mainF=forms.get('main'),healthTask=currentTasks.find(t=>t.id==='health');
    const mainSec=mainF?mainF.value().intervalSeconds:(currentTasks.find(t=>t.id==='main')?.intervalSeconds??60);
    const healthSec=healthTask?.intervalSeconds??300;
    return `主循环间隔 ${mainSec} 秒、宿主健康检查间隔 ${healthSec} 秒（只读）`;
  }

  function render(tasks){
    currentTasks=tasks;
    forms.clear();
    const tbody=h('tbody');

    function buildDailyRow(t){
      const title=LABEL[t.id]||t.title||t.id;
      const enabled=h('input',{
        type:'checkbox',
        role:'switch',
        class:'ws-switch',
        checked:!!t.enabled,
        'aria-label':'启用'+title,
      });
      const input=h('input',{
        class:'input ws-time',
        type:'time',
        value:t.time,
        'aria-label':title+'时间或间隔',
      });
      const result=h('span',{class:'small muted task-inline-status',role:'status'});
      const value=()=>({enabled:enabled.checked,time:input.value});
      const tr=h('tr',{class:t.enabled?'':'offr',dataset:{taskId:t.id}});
      forms.set(t.id,{value,saved:JSON.stringify(value()),result,tr,task:t});

      enabled.onchange=()=>{
        tr.classList.toggle('offr',!enabled.checked);
        renderTimeline();
      };
      input.oninput=()=>{
        sortDailyRows();
        renderTimeline();
      };

      const runBtn=h('button',{
        class:'btn small',
        type:'button',
        disabled:busy,
        onclick:async()=>{
          runBtn.disabled=true;
          try{
            const d=await api('/api/tasks/'+encodeURIComponent(t.id)+'/run',{method:'POST',timeoutMs:180000});
            result.textContent=STATUS[d.run?.status]||d.run?.status||'执行请求已处理';
            ctx.onSaved?.();
          }catch(e){result.textContent=e.message;}
          finally{runBtn.disabled=false;}
        }
      },'单次执行',BILLING_TASKS.has(t.id)?billingBadge():null);

      const last=t.lastRun;
      const lastFailed=last&&['failed','unknown','interrupted'].includes(last.status);
      const lastText=last
        ? `${fmtDateTime(last.startedAt||last.scheduledAt)} ${STATUS[last.status]||last.status}`
        : '从未执行';
      const lastNode=h('span',{class:lastFailed?'warn':last?'muted':'cap'},lastText);

      set(tr,
        h('td',{class:'task-col-switch'},enabled),
        h('td',{class:'task-col-name'},
          h('b',{},title),
          t.id.includes('-post')?h('span',{class:'ws-badge warn task-post-badge'},'会发到 X'):null
        ),
        h('td',{class:'task-col-time'},input),
        h('td',{class:'task-col-last'},lastNode,' ',result),
        h('td',{class:'task-col-act'},rowActions(runBtn))
      );
      return tr;
    }

    const dailyTasks=tasks.filter(t=>t.time!==undefined);
    for(const t of dailyTasks)tbody.append(buildDailyRow(t));

    function sortDailyRows(){
      const rows=[...tbody.querySelectorAll('tr[data-task-id]')];
      rows.sort((ra,rb)=>{
        const fa=forms.get(ra.dataset.taskId),fb=forms.get(rb.dataset.taskId);
        const ta=fa?.value().time??'',tb=fb?.value().time??'';
        return ta.localeCompare(tb)||ra.dataset.taskId.localeCompare(rb.dataset.taskId);
      });
      for(const r of rows)tbody.append(r);
    }
    sortDailyRows();

    set(tableCard,
      h('table',{class:'tasks-table'},
        h('thead',{},h('tr',{},h('th',{style:'width:44px'},''),h('th',{},'任务'),h('th',{},'时间'),h('th',{},'上次执行'),h('th',{class:'task-col-act'},''))),
        tbody
      )
    );

    // 高级设置：主循环间隔 + 宿主健康检查间隔（只读）
    const advRows=[];
    for(const t of tasks.filter(x=>x.time===undefined)){
      const readOnly=t.id==='health';
      const title=LABEL[t.id]||t.title||t.id;
      const input=h('input',{
        class:'input ws-num',
        type:'number',
        value:t.intervalSeconds,
        min:30,
        max:3600,
        readOnly,
        'aria-label':title+'时间或间隔',
        oninput:()=>advEl?.updateSummary(advSummary),
      });
      const result=h('span',{class:'small muted',role:'status'});
      const value=()=>({intervalSeconds:Number(input.value)});
      forms.set(t.id,{value,saved:JSON.stringify(value()),result,task:t});
      const last=t.lastRun;
      const metaText=readOnly
        ? '宿主维护状态只读'+(t.hostResult?' · 最近检查 '+fmtDateTime(t.hostResult.at):'')
        : '由顶部启动／暂停控制'+(last?' · 上次 '+fmtDateTime(last.startedAt||last.scheduledAt)+' '+(STATUS[last.status]||last.status):'');
      advRows.push(h('div',{class:'run-adv-field',dataset:{taskId:t.id}},
        h('span',{class:'run-adv-label'},title+'间隔'),
        input,
        h('span',{class:'ws-unit'},'秒'),
        h('span',{class:'small muted'},metaText),
        result
      ));
    }
    advEl=advanced('tasks',advSummary,h('div',{class:'run-adv-grid'},...advRows));
    set(advHolder,advEl);
    renderTimeline();
  }

  async function load(){
    try{
      const [d,prog]=await Promise.all([api('/api/tasks'),api('/api/program').catch(()=>null)]);
      if(!alive)return;
      if(prog){
        replyHours=prog.replyHours||null;
        replyHoursEnabled=prog.settings?.replyHours?.enabled!==false;
      }
      if(!dirty()){
        revision=d.revision;
        render(d.tasks||[]);
      }else{
        renderTimeline();
      }
      if(d.hostAvailable===false)state.textContent='宿主维护桥接尚未安装';
    }catch(e){if(alive)errorBox(tableCard,e,load);}
  }

  async function saveAll(){
    if(busy)return;
    busy=true;save.disabled=true;state.textContent='';
    try{
      for(const [id,f] of forms){
        if(id==='health'||JSON.stringify(f.value())===f.saved)continue;
        f.result.textContent='保存中…';
        try{
          const snapshot=f.value();
          const d=await api('/api/tasks/'+encodeURIComponent(id),{method:'PUT',body:{revision,...snapshot}});
          revision=d.revision;
          f.saved=JSON.stringify(snapshot);
          f.result.textContent='已保存';
        }catch(e){
          f.result.textContent='保存失败：'+e.message;
          state.textContent='已停止，前面标记“已保存”的计划已生效，其余修改保留。';
          throw e;
        }
      }
      ctx.onSaved?.();
      notice('任务计划已保存','ok');
    }catch(e){notice(e.message,'error');}
    finally{busy=false;save.disabled=false;}
  }

  const off=onEvent('tasks',()=>{if(!busy&&!dirty())load();});
  load();
  return()=>{alive=false;guard();off();};
}

export function mountHistory(root){
  let alive=true,cursor=null,loading=false,selectedTask='',onlyFailed=false,allRuns=[],counts=[];
  const expandedGroups=new Set(),expandedRuns=new Set(),runDetails=new Map();
  const toolbar=h('div',{class:'history-toolbar'}),tableWrap=h('div',{class:'ws-card history-table-card'}),more=h('button',{class:'btn small',type:'button',hidden:true,onclick:()=>load(true)},'加载更早的记录');
  const page=h('div',{class:'ws-stack settings-history'},toolbar,tableWrap,more);
  set(root,page);

  function renderToolbar(){
    const totalAll=counts.reduce((n,c)=>n+Number(c.total||0),0);
    const chips=[['',`全部${totalAll?` ${totalAll}`:''}`]];
    for(const [taskId,label] of Object.entries(LABEL)){
      const found=counts.find(c=>c.task===taskId);
      const count=found?Number(found.total||0):0;
      if(count>0||selectedTask===taskId){
        chips.push([taskId,`${label} ${count}`]);
      }
    }
    const seg=h('div',{class:'ws-segmented history-seg',role:'tablist','aria-label':'按任务筛选'},
      chips.map(([val,text])=>h('button',{
        type:'button',
        role:'tab',
        class:selectedTask===val?'selected':'',
        'aria-selected':String(selectedTask===val),
        onclick:()=>{if(selectedTask===val)return;selectedTask=val;load(false);}
      },text))
    );
    const failBtn=h('button',{
      type:'button',
      class:'ws-button'+(onlyFailed?' primary':''),
      'aria-pressed':String(onlyFailed),
      onclick:()=>{onlyFailed=!onlyFailed;load(false);}
    },'只看失败');
    set(toolbar,seg,h('span',{class:'sp'}),failBtn);
  }

  async function toggleSingleDetail(runId,detailCell){
    if(expandedRuns.has(runId)){
      expandedRuns.delete(runId);
      renderTable();
      return;
    }
    expandedRuns.add(runId);
    renderTable();
    if(runDetails.has(runId))return;
    try{
      const result=await api('/api/tasks/runs/'+encodeURIComponent(runId));
      if(!alive)return;
      runDetails.set(runId,result);
      renderTable();
    }catch(e){
      if(!alive)return;
      runDetails.set(runId,{error:e});
      renderTable();
    }
  }

  function renderDetailRow(runId){
    const d=runDetails.get(runId);
    const holder=h('div',{class:'history-run-detail'});
    if(!d){
      holder.textContent='加载详情中…';
    }else if(d.error){
      errorBox(holder,d.error);
    }else{
      const v=d.run||d;
      const calls=d.calls||v.calls||[];
      set(holder,
        h('div',{class:'small'},`耗时 ${v.durationMs??'未知'} ms · 费用 ${taskCost(v,calls)}`),
        formatNotice(v.result?.format),
        v.error?h('div',{class:'callout bad'},v.error):null,
        v.outboxId?h('div',{class:'small break'},'出站 '+v.outboxId):null,
        calls.map(c=>h('div',{class:'small'},[c.purpose,c.model,(c.usage?.totalTokens??'未知')+' token',c.pricingStatus==='unpriced'?'未定价':money(c.cost?.total)].join(' · ')))
      );
    }
    return h('tr',{class:'hist-detail-row history-detail-tr'},h('td',{colSpan:6},holder));
  }

  function buildSingleRow(r,{sub=false}={}){
    const title=LABEL[r.taskId]||r.taskId;
    const ok=r.status==='completed';
    const fail=['failed','unknown','interrupted'].includes(r.status);
    const expanded=expandedRuns.has(r.id);
    const tr=h('tr',{
      class:(sub?'hist-sub-row history-sub-row ':'hist-single-row ')+'history-row',
      dataset:{runId:r.id,taskId:r.taskId},
      tabindex:0,
      onclick:()=>toggleSingleDetail(r.id),
      onkeydown:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleSingleDetail(r.id);}},
    },
      h('td',{},(sub?'  └ ':'')+(expanded?'▾ ':'▸ ')+title),
      h('td',{class:ok?'ok':fail?'bad':'muted'},(ok?'✓ ':'')+(STATUS[r.status]||r.status)),
      h('td',{class:'muted'},fmtDateTime(r.startedAt||r.scheduledAt)),
      h('td',{class:'muted'},r.source==='manual'?'手动':'自动'),
      h('td',{},fmtDuration(r.durationMs)),
      h('td',{},fmtUsd(runCostUsd(r)))
    );
    return expanded?[tr,renderDetailRow(r.id)]:[tr];
  }

  function renderTable(){
    if(!allRuns.length){
      set(tableWrap,empty('暂无执行历史'));
      return;
    }
    const groups=groupRuns(allRuns);
    const rows=[];
    for(const g of groups){
      if(g.kind==='single'){
        rows.push(...buildSingleRow(g.run));
      }else{
        const open=expandedGroups.has(g.id);
        const title=LABEL[g.taskId]||g.taskId;
        const timeRange=g.fromAt===g.toAt?fmtDateTime(g.toAt):`${fmtDateTime(g.fromAt)} – ${fmtDateTime(g.toAt)}`;
        const tr=h('tr',{
          class:'hist-group-row history-group-row history-row',
          dataset:{groupId:g.id,taskId:g.taskId,groupCount:String(g.count)},
          tabindex:0,
          onclick:()=>{if(expandedGroups.has(g.id))expandedGroups.delete(g.id);else expandedGroups.add(g.id);renderTable();},
          onkeydown:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(expandedGroups.has(g.id))expandedGroups.delete(g.id);else expandedGroups.add(g.id);renderTable();}},
        },
          h('td',{},(open?'▾ ':'▸ ')+title),
          h('td',{class:'ok'},`✓ 完成 ×${g.count}`),
          h('td',{class:'muted'},timeRange),
          h('td',{class:'muted'},'自动'),
          h('td',{},g.avgDurationMs!==null?`平均 ${fmtDuration(g.avgDurationMs)}`:'—'),
          h('td',{},fmtUsd(g.totalCostUSD))
        );
        rows.push(tr);
        if(open){
          for(const item of g.items)rows.push(...buildSingleRow(item,{sub:true}));
        }
      }
    }
    set(tableWrap,
      h('table',{class:'hist-table'},
        h('thead',{},h('tr',{},h('th',{},'任务'),h('th',{},'结果'),h('th',{},'时间'),h('th',{},'触发'),h('th',{},'耗时'),h('th',{},'费用'))),
        h('tbody',{},rows)
      )
    );
  }

  async function load(append=false){
    if(loading)return;
    loading=true;
    try{
      const q=new URLSearchParams({limit:'50'});
      if(selectedTask)q.set('taskId',selectedTask);
      if(onlyFailed)q.set('status','failed');
      if(append&&cursor)q.set('cursor',cursor);
      const d=await api('/api/tasks/runs?'+q);
      if(!alive)return;
      if(Array.isArray(d.counts))counts=d.counts;
      if(!append)allRuns=d.items||[];
      else allRuns=[...allRuns,...(d.items||[])];
      cursor=d.nextCursor;
      more.hidden=!cursor;
      renderToolbar();
      renderTable();
    }catch(e){if(alive)errorBox(tableWrap,e,()=>load(false));}
    finally{loading=false;}
  }

  load();
  return()=>{alive=false;};
}
