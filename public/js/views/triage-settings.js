import {h,set,fmtDateTime} from '../dom.js';
import {api} from '../api.js';
import {notice} from '../state.js';
import {editorGuard,errorBox,table,advanced,tagInput,emptyLine} from '../view-utils.js';

const TIER={priority:'优先',normal:'普通',skip:'跳过'},STATUS={filtered:'过滤',merged:'合并',ignored:'骚扰冷却',skipped:'跳过'};

export function mount(root,ctx){
  let alive=true,settings=null,revision=0,saved='',advEl=null;
  const tagBoxes=new Map();
  const statsBar=h('div',{class:'ws-stats'}),cardsBox=h('div',{class:'ws-stack'}),queueCard=h('div',{class:'ws-card triage-queue-card'});
  const saveBtn=h('button',{type:'button',id:'triage-settings-save',class:'btn primary small',onclick:saveSettings},'保存');
  ctx.setActions?.(saveBtn);
  const page=h('div',{class:'ws-stack settings-triage'},statsBar,cardsBox,queueCard);
  set(root,page);

  function flushTagBoxes(){
    if(!settings)return;
    for(const [k,box] of tagBoxes)settings[k]=box.getValues();
  }
  const dirty=()=>{
    if(!settings)return false;
    return JSON.stringify(settings)!==saved;
  };
  const guard=editorGuard(ctx,page,dirty);

  function advSummary(){
    if(!settings)return '';
    return `消息时效 ${settings.maxAgeHours??3} 小时（超过就不回复）、同文重复降优先阈值 ${settings.batchThreshold??3}`;
  }

  async function saveSettings(){
    if(!settings)return;
    flushTagBoxes();
    saveBtn.disabled=true;
    try{
      const value=structuredClone(settings);
      const r=await api('/api/triage/settings',{method:'PUT',body:{settings:value,maxAgeHours:value.maxAgeHours,revision}});
      if(!alive)return;
      revision=r.revision;
      settings={...r.settings,maxAgeHours:r.maxAgeHours??value.maxAgeHours};
      saved=JSON.stringify(settings);
      advEl?.updateSummary(advSummary);
      ctx.onSaved?.();
      notice('分级设置已保存，下一轮生效','ok');
    }catch(error){if(alive)notice(error.message,'error');}
    finally{saveBtn.disabled=false;}
  }

  function buildTagSection(key,label,placeholder){
    const countEl=h('small',{class:'muted'},(settings[key]||[]).length?String((settings[key]||[]).length):'');
    const box=tagInput(settings[key]||[],next=>{
      settings[key]=next;
      countEl.textContent=next.length?String(next.length):'';
    },{placeholder,ariaLabel:label});
    tagBoxes.set(key,box);
    return h('div',{class:'triage-tag-group'},
      h('div',{class:'triage-tag-label'},h('span',{},label),countEl),
      box
    );
  }

  async function loadSettings(){
    try{
      const d=await api('/api/triage/settings');
      if(!alive)return;
      settings={...structuredClone(d.settings),maxAgeHours:Number(d.maxAgeHours??d.settings?.maxAgeHours??3)};
      delete settings.normalMaxAgeHours;
      revision=d.revision;
      saved=JSON.stringify(settings);
      tagBoxes.clear();
      const prioCard=h('section',{class:'ws-card'},
        h('div',{class:'ws-card-head'},h('b',{},'优先处理'),h('small',{},'名单里的消息排在前面')),
        buildTagSection('priorityPublicHandles','公开账号','输入 @账号，回车添加'),
        buildTagSection('priorityPrivateConversations','私信会话','输入会话或用户，回车添加')
      );
      const filterCard=h('section',{class:'ws-card'},
        h('div',{class:'ws-card-head'},h('b',{},'过滤'),h('small',{},'命中的消息不回复')),
        buildTagSection('advertisingKeywords','广告关键词','输入广告关键词，回车添加'),
        buildTagSection('greetings','纯问候词','输入纯问候词，回车添加')
      );
      advEl=advanced('triage',advSummary,
        h('div',{class:'run-adv-grid'},
          h('div',{class:'run-adv-field'},
            h('span',{class:'run-adv-label'},'消息时效'),
            h('input',{
              class:'input ws-num',
              type:'number',
              min:1,
              max:48,
              value:settings.maxAgeHours,
              dataset:{setting:'maxAgeHours'},
              'aria-label':'消息时效（小时）',
              oninput:e=>{settings.maxAgeHours=Number(e.target.value);advEl?.updateSummary(advSummary);}
            }),
            h('span',{class:'ws-unit'},'小时'),
            h('span',{class:'small muted'},'超过就不回复')
          ),
          h('div',{class:'run-adv-field'},
            h('span',{class:'run-adv-label'},'同文重复降优先阈值'),
            h('input',{
              class:'input ws-num',
              type:'number',
              min:2,
              max:20,
              value:settings.batchThreshold,
              dataset:{setting:'batchThreshold'},
              'aria-label':'同文重复降优先阈值',
              oninput:e=>{settings.batchThreshold=Number(e.target.value);advEl?.updateSummary(advSummary);}
            })
          )
        ),
        h('p',{class:'small muted',style:'margin:0'},'同一渠道一小时内，不同用户发送相同正文达到阈值时，只降为普通优先级，不直接过滤。广告仍按关键词与链接规则过滤。')
      );
      set(cardsBox,h('div',{class:'ws-cols'},prioCard,filterCard),advEl);
    }catch(e){if(alive)errorBox(cardsBox,e,loadSettings);}
  }

  async function loadSummary(){
    try{
      const [d,i]=await Promise.all([api('/api/triage/summary'),api('/api/triage/ignores')]);
      if(!alive)return;
      const queuedCount=(d.queues||[]).reduce((n,q)=>n+Number(q.count||0),0);
      const filteredCount=(d.reasons||[]).filter(r=>r.status==='filtered').reduce((n,r)=>n+Number(r.count||0),0);
      const ignoreItems=i.items||[];
      set(statsBar,
        h('div',{class:'ws-stat-cell'},h('small',{},'今日公开'),h('b',{},String(d.publicToday??0),' ',h('span',{},`/ ${d.publicPerDay??180}`))),
        h('div',{class:'ws-stat-cell'},h('small',{},'近 24 小时私信'),h('b',{},String(d.privateRecent??0),' ',h('span',{},`/ ${d.privatePerDay??400}`))),
        h('div',{class:'ws-stat-cell'},h('small',{},'排队'),h('b',{},String(queuedCount))),
        h('div',{class:'ws-stat-cell'},h('small',{},'今日过滤'),h('b',{},String(filteredCount))),
        h('div',{class:'ws-stat-cell'},h('small',{},'骚扰冷却'),h('b',{},String(ignoreItems.length),' ',h('span',{},'人'))),
        h('button',{type:'button',class:'ws-icon-button',title:'刷新','aria-label':'刷新分级概况',onclick:loadSummary},'↻')
      );
      const hasQueues=(d.queues||[]).length>0,hasReasons=(d.reasons||[]).length>0,hasIgnores=ignoreItems.length>0;
      if(!hasQueues&&!hasReasons&&!hasIgnores){
        set(queueCard,
          h('div',{class:'ws-empty-line'},
            h('b',{style:'color:var(--ws-text)'},'排队与冷却'),
            emptyLine('当前没有排队消息','今天没有过滤','没有处于骚扰冷却的用户')
          )
        );
      }else{
        const parts=[];
        const emptyNotes=[];
        if(hasQueues){
          parts.push(table(['渠道','分级','排队','最旧时间'],d.queues.map(q=>[q.channel==='private'?'私信':'公开',TIER[q.tier]||q.tier,q.count,fmtDateTime(q.oldestAt)])));
        }else emptyNotes.push('当前没有排队消息');
        if(hasReasons){
          parts.push(table(['状态','原因','今日条数'],d.reasons.map(r=>[STATUS[r.status]||r.status,r.reason,r.count])));
        }else emptyNotes.push('今天没有过滤');
        if(hasIgnores){
          parts.push(table(['用户 / 会话','渠道','冷却至','操作'],ignoreItems.map(v=>[
            v.userId,
            v.channel==='private'?'私信':'公开',
            fmtDateTime(v.until),
            h('button',{type:'button',class:'btn small',onclick:async()=>{
              try{await api('/api/triage/ignores',{method:'DELETE',body:{userId:v.userId,channel:v.channel}});await loadSummary();}
              catch(e){notice(e.message,'error');}
            }},'解除冷却')
          ])));
        }else emptyNotes.push('没有处于骚扰冷却的用户');
        set(queueCard,
          h('div',{class:'ws-card-head'},h('b',{},'排队与冷却'),emptyNotes.length?emptyLine(...emptyNotes):null),
          ...parts
        );
      }
    }catch(e){if(alive)errorBox(statsBar,e,loadSummary);}
  }

  loadSettings();loadSummary();
  return()=>{alive=false;guard();};
}
