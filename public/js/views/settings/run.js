import {h,set,fmtDateTime} from '../../dom.js';
import {api} from '../../api.js';
import {notice,refreshStatus,onStatus,onEvent} from '../../state.js';
import {errorBox,editorGuard,advanced} from '../../view-utils.js';

const MODES=[['draft','草稿模式','只生成草稿，批准后才发送'],['auto','自动模式','按身份、时效、额度和出站规则自动发送']];

export function mount(root,ctx){
  let alive=true,settings=null,saved=null,revision=0,program=null,summary=null,busy=false,refreshing=false,refreshAgain=false,postingSummary='原创 280 · 公开回复 280';
  const hoursBig=h('span',{class:'run-hours-big',id:'reply-hours-schedule'}),hoursUnit=h('span',{class:'muted run-hours-suffix'},'不回复'),hoursStatus=h('span',{class:'ws-badge ok',role:'status',id:'reply-hours-state'});
  const pubBar=h('i',{style:'width:0%'}),privBar=h('i',{style:'width:0%'});
  const pubUsedText=h('span',{class:'run-usage-nums'},'0 · 0'),privUsedText=h('span',{class:'run-usage-nums'},'0 · 0');
  const content=h('div',{class:'ws-stack'}),error=h('div',{role:'status'});
  const page=h('div',{class:'ws-stack settings-run'},error,content),modes=h('div',{class:'settings-mode-cards run-modes-compact',role:'radiogroup','aria-label':'运行模式'}),limitsBox=h('div',{class:'ws-card'}),hoursBox=h('div',{class:'ws-card'}),posting=h('div',{id:'posting-limits',class:'run-posting-inline'});
  let advEl=null;
  set(root,page);
  const save=h('button',{id:'program-settings-save',type:'button',class:'btn primary small',onclick:saveLimits},'保存');
  ctx.setActions?.(save);
  const dirty=()=>!!settings&&JSON.stringify(settings)!==JSON.stringify(saved),cleanup=editorGuard(ctx,page,dirty);

  function advSummary(){
    if(!settings)return '平时不用改 · 默认收起';
    return `每轮最多处理 ${settings.maxPerRound} 条、晚安后关闭延迟 ${settings.replyHours?.closeDelayMinutes??30} 分钟、${postingSummary}`;
  }

  function numInput(key,label,min,max,{id,get,setVal}={}){
    return h('input',{
      type:'number',
      id,
      class:'input ws-num',
      min,
      max,
      step:1,
      value:get?get():settings[key],
      dataset:{setting:key},
      'aria-label':label,
      oninput:e=>{
        const v=Number(e.target.value);
        if(setVal)setVal(v);else settings[key]=v;
        advEl?.updateSummary(advSummary);
      },
    });
  }

  async function load(){
    try{
      const [d,t]=await Promise.all([api('/api/program'),api('/api/triage/summary').catch(()=>null)]);
      if(!alive)return;
      program=d;summary=t;
      settings=structuredClone(d.settings);
      delete settings.normalMaxAgeHours;
      settings.privatePerDay??=400;
      settings.replyHours??={enabled:true,closeDelayMinutes:30};
      saved=structuredClone(settings);
      revision=d.revision;
      render();
      await loadPosting();
    }catch(e){if(alive)errorBox(error,e,load);}
  }

  function renderModes(){
    set(modes,MODES.map(([value,title,description])=>{
      const input=h('input',{type:'radio',name:'program-mode',id:'program-mode-'+value,value,checked:settings.mode===value,disabled:busy,onchange:()=>saveMode(value)});
      return h('label',{class:'settings-mode-card'+(settings.mode===value?' selected':'')},input,h('span',{},h('strong',{},title),h('small',{class:'muted'},description)));
    }));
  }

  function render(){
    renderModes();
    const modeCard=h('section',{class:'ws-card'},
      h('div',{class:'ws-card-head'},h('b',{},'运行模式'),h('small',{},'切换立即保存；顶部“启动 / 暂停”控制主循环，切换模式不会恢复业务')),
      modes
    );
    set(limitsBox,
      h('div',{class:'ws-card-head'},h('b',{},'发送上限'),h('small',{},'私信的“每天”按近 24 小时算；公开的“今天”含问候帖')),
      h('table',{class:'run-limits-table'},
        h('thead',{},h('tr',{},h('th',{},''),h('th',{},'每小时'),h('th',{},'每天'),h('th',{},'已用（本小时 · 今天）'))),
        h('tbody',{},
          h('tr',{},
            h('td',{},'公开回复'),
            h('td',{},numInput('publicPerHour','公开每小时上限',1,25)),
            h('td',{},numInput('publicPerDay','公开每日上限',1,1000)),
            h('td',{class:'run-limit-used'},h('span',{class:'run-usage-bar'},pubBar),pubUsedText)
          ),
          h('tr',{},
            h('td',{},'私信'),
            h('td',{},numInput('privatePerHour','私信每小时上限',1,100)),
            h('td',{},numInput('privatePerDay','私信 24 小时上限',1,500)),
            h('td',{class:'run-limit-used'},h('span',{class:'run-usage-bar'},privBar),privUsedText)
          )
        )
      )
    );
    const enabledSwitch=h('input',{
      type:'checkbox',
      role:'switch',
      class:'ws-switch',
      id:'reply-hours-enabled',
      'aria-label':'回复时段跟随早晚安',
      checked:settings.replyHours.enabled,
      onchange:e=>{
        settings.replyHours.enabled=e.target.checked;
        renderReadonly();
      }
    });
    set(hoursBox,
      h('div',{class:'ws-card-head'},h('b',{},'回复时段'),h('span',{class:'sp'}),hoursStatus),
      h('div',{class:'run-hours-row'},hoursBig,hoursUnit),
      h('label',{class:'run-hours-row run-switch-label'},enabledSwitch,h('span',{},'跟随早晚安：早安帖后开放，晚安帖后延迟关闭')),
      h('div',{class:'small muted'},'早晚安任务停用或失败时，仍按上面的时间开关')
    );
    advEl=advanced('run',advSummary,
      h('div',{class:'run-adv-grid'},
        h('div',{class:'run-adv-field'},
          h('span',{class:'run-adv-label'},'每轮最多处理'),
          numInput('maxPerRound','每轮最多处理',1,4),
          h('span',{class:'ws-unit'},'条'),
          h('span',{class:'small muted'},'公开与私信轮流出队')
        ),
        h('div',{class:'run-adv-field'},
          h('span',{class:'run-adv-label'},'晚安后关闭延迟'),
          numInput('closeDelayMinutes','晚安后关闭延迟（分钟）',0,180,{id:'reply-hours-delay',get:()=>settings.replyHours.closeDelayMinutes,setVal:v=>{settings.replyHours.closeDelayMinutes=v;}}),
          h('span',{class:'ws-unit'},'分钟')
        ),
        posting
      )
    );
    set(content,modeCard,h('div',{class:'ws-cols'},limitsBox,hoursBox),advEl);
    renderReadonly();
  }

  function renderReadonly(){
    const p=program?.limits||{};
    const pubHour=Number(p.public?.used??0),pubDay=Number(summary?.publicToday??0),pubCap=Math.max(1,Number(settings?.publicPerDay||180));
    const privHour=Number(p.private?.used??0),privDay=Number(summary?.privateRecent??0),privCap=Math.max(1,Number(settings?.privatePerDay||400));
    pubBar.style.width=Math.min(100,Math.max(2,Math.round(pubDay/pubCap*100)))+'%';
    privBar.style.width=Math.min(100,Math.max(2,Math.round(privDay/privCap*100)))+'%';
    pubUsedText.textContent=`${p.public?.used??0} · ${summary?.publicToday??0}`;
    privUsedText.textContent=`${p.private?.used??0} · ${summary?.privateRecent??0}`;
    const window=program?.replyHours||{};
    const enabled=settings?.replyHours ? settings.replyHours.enabled!==false : program?.settings?.replyHours?.enabled!==false;
    if(enabled){
      hoursBig.textContent=`${window.closeTime||'23:30'} – ${window.openTime||'08:00'}`;
      hoursUnit.hidden=false;
    }else{
      hoursBig.textContent='全天回复';
      hoursUnit.hidden=true;
    }
    const opening=Number.isFinite(window.opensAt)?fmtDateTime(window.opensAt):'';
    const closed=enabled&&window.open===false;
    hoursStatus.className='ws-badge '+(closed?'warn':'ok');
    hoursStatus.textContent=closed?(window.reason==='waiting-morning-post'?'等待早安任务结束':'当前不回复')+' · '+(opening?'开放于 '+opening:'下次开放待定'):'● 现在可以回复';
    advEl?.updateSummary(advSummary);
  }

  async function refreshReadonly(){
    if(!alive||!program)return;
    if(refreshing){refreshAgain=true;return;}
    refreshing=true;
    try{
      const[d,t]=await Promise.all([api('/api/program'),api('/api/triage/summary').catch(()=>null)]);
      if(!alive)return;
      program=d;summary=t;
      renderReadonly();
    }catch{}finally{
      refreshing=false;
      if(alive&&refreshAgain){refreshAgain=false;queueMicrotask(refreshReadonly);}
    }
  }

  async function saveMode(mode){
    if(busy||settings.mode===mode)return;
    busy=true;
    for(const input of modes.querySelectorAll('input')){input.disabled=true;input.closest('label')?.classList.toggle('selected',input.value===mode);}
    const snapshot={...structuredClone(saved),mode};
    try{
      const result=await api('/api/program/settings',{method:'PUT',body:{settings:snapshot,revision}});
      if(!alive)return;
      revision=result.revision;saved=snapshot;settings.mode=mode;program.settings=snapshot;
      await refreshStatus();if(!alive)return;
      await refreshReadonly();if(!alive)return;
      ctx.onSaved?.();
      notice('运行模式已保存，业务控制状态保持不变','ok');
    }catch(e){if(alive)notice(e.message,'error');}
    finally{busy=false;if(alive)renderModes();}
  }

  async function saveLimits(){
    if(busy||!settings)return;
    busy=true;save.disabled=true;renderModes();
    const snapshot=structuredClone(settings);
    try{
      const result=await api('/api/program/settings',{method:'PUT',body:{settings:snapshot,revision}});
      if(!alive)return;
      revision=result.revision;saved=snapshot;
      await refreshStatus();if(!alive)return;
      await refreshReadonly();if(!alive)return;
      ctx.onSaved?.();
      notice('发送限制与回复时段已保存，下一轮生效','ok');
    }catch(e){if(alive)notice(e.message,'error');}
    finally{busy=false;save.disabled=false;if(alive)renderModes();}
  }

  async function loadPosting(){
    if(!alive)return;
    try{
      const data=await api('/api/account/posting-limits');
      if(!alive)return;
      const policies=data.effective||data.policies||data;
      const postVal=policies.post||data.capabilities?.post||{};
      const replyVal=policies.reply||data.capabilities?.reply||{};
      const source=data.post||postVal;
      const unitLabel={'weighted-characters':'加权字符','normalized-code-points':'规范化码点','javascript-characters':'JS 字符'}[postVal.unit||postVal.countingMode]||'加权字符';
      postingSummary=`账号字数上限 原创 ${postVal.limit??280} · 公开回复 ${replyVal.limit??280}`;
      advEl?.updateSummary(advSummary);
      set(posting,
        h('div',{class:'run-adv-field run-posting-row'},
          h('span',{class:'run-adv-label'},'账号字数上限'),
          h('span',{},`原创 ${postVal.limit??280} · 公开回复 ${replyVal.limit??280}`),
          h('span',{class:'small muted'},`${unitLabel} · ${(source.status==='confirmed'?'已确认':source.reason||'普通账号回退')} · ${fmtDateTime(source.checkedAt)||'尚未读取'}`),
          h('button',{class:'btn small',type:'button',onclick:async e=>{
            const button=e.currentTarget;button.disabled=true;
            try{await api('/api/account/posting-limits/refresh',{method:'POST'});await loadPosting();}
            catch(error){if(alive)notice(error.message,'error');}
            finally{button.disabled=false;}
          }},'重新读取')
        )
      );
    }catch(e){if(alive)errorBox(posting,e,loadPosting);}
  }

  const offStatus=onStatus(()=>refreshReadonly()),offEvents=['program','tasks'].map(name=>onEvent(name,()=>refreshReadonly()));
  load();
  return()=>{alive=false;cleanup();offStatus();offEvents.forEach(off=>off());};
}
