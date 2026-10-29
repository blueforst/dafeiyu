import {h,set,fmtDateTime} from '../../dom.js';
import {api} from '../../api.js';
import {notice} from '../../state.js';
import {empty,errorBox,field,editorGuard,fmtUsd,advanced} from '../../view-utils.js';

const LABEL={normal:'正常',attention:'需关注',error:'异常',confirmed:'已确认',missing:'缺少',unknown:'未知',on:'已开启',off:'已关闭'};
const GROUPS=[
  ['运行',['send-stall','reply-stall','reply-hours','round-failures','watchdog-failure']],
  ['采集',['collection-public','collection-private','collection-failures']],
  ['发送',['cooldown-public','cooldown-private','automation-public','automation-private']],
  ['浏览器',['browser-human','browser-recovery','browser-resource-pressure']],
  ['账号',['account-restricted','compliance-disclosure','compliance-label','compliance-quality']],
  ['基础设施',['backup-failure','certificate-expiry']]
];
const TITLES=['发送进度','回复进度','回复时段','轮次运行','调度看门狗','公开采集','私信采集','采集告警','公开发送退避','私信发送退避','公开自动化拦截','私信自动化拦截','人工处理','浏览器恢复','浏览器资源','账号状态','简介披露','自动化账号标签','通知质量过滤','数据库备份','证书有效期'];
const METRIC_TITLE=Object.fromEntries(GROUPS.flatMap(([,ids])=>ids).map((id,i)=>[id,TITLES[i]]));

function actionHrefFor(metricId,groupName){
  if(groupName==='账号'||groupName==='浏览器')return '#/settings/browser';
  if(groupName==='采集')return '#/settings/sources';
  if(groupName==='运行'||groupName==='发送')return '#/settings/logs';
  if(metricId==='backup-failure')return '#/settings/tasks';
  return null;
}

export function mount(root,ctx){
  let alive=true,config=null,saved='',revision=0;
  const page=h('div',{class:'ws-stack health-page'}),metrics=h('div',{class:'ws-stack health-metrics-wrap'}),reports=h('section',{class:'ws-card health-reports-card'}),alerts=h('details',{class:'ws-fold health-alerts'}),advHolder=h('div');
  const refresh=h('button',{type:'button',class:'ws-icon-button',title:'刷新','aria-label':'刷新',onclick:load},'↻');
  set(root,page);
  page.append(metrics,reports,alerts,advHolder);
  ctx.setActions?.(refresh);
  const dirty=()=>!!config&&JSON.stringify(config)!==saved,cleanup=editorGuard(ctx,page,dirty);
  const table=(titles,rows,cls)=>h('div',{class:'table-wrap'},h('table',{class:cls},h('thead',{},h('tr',{},titles.map(title=>h('th',{},title)))),h('tbody',{},rows)));

  function renderMetrics(d){
    const items=(d.metrics||[]).map(m=>({...m,id:m.id||m.key})),compliance=d.compliance;
    if(compliance){
      const fallbacks=[
        ['compliance-disclosure',compliance.disclosure,compliance.disclosure==='confirmed'?'披露完整':compliance.disclosure==='missing'?'缺少 '+(compliance.missingPhrases||[]).join('、'):'无法确认'],
        ['compliance-label',compliance.automatedLabel,compliance.automatedLabel==='confirmed'?'已标注':compliance.automatedLabel==='missing'?'尚未标注':'无法确认'],
        ['compliance-quality',compliance.qualityFilter,compliance.qualityFilter==='on'?'已开启，可能有部分提及收不到':compliance.qualityFilter==='off'?'已关闭':'无法确认']
      ];
      for(const [id,status,summary] of fallbacks){
        if(!items.some(m=>m.id===id))items.push({id,level:status==='confirmed'||status==='off'?'normal':'attention',summary});
      }
    }else{
      for(const m of d.account?.checks||d.accountChecks||d.accountCheck?.checks||[]){
        if(!items.some(x=>x.id===(m.id||m.key)))items.push({...m,id:m.id||m.key||m.title,name:m.title,level:m.level||'attention'});
      }
    }
    const unique=[...new Map(items.map(m=>[m.id,m])).values()];
    const abnormal=unique.filter(m=>m.level!=='normal');
    const n=abnormal.length;
    const label=d.status==='error'?'异常':d.status==='attention'?'需关注':'正常';
    ctx.setSummary?.('健康：'+label+(n?' '+n+' 项':''),d.status);

    const known=new Set(GROUPS.flatMap(([,ids])=>ids));
    const groupOfMetric=new Map();
    for(const [gName,ids] of GROUPS)for(const id of ids)groupOfMetric.set(id,gName);
    const otherIds=unique.filter(m=>!known.has(m.id)).map(m=>m.id);
    for(const id of otherIds)groupOfMetric.set(id,'其他');
    const groups=[...GROUPS,...(otherIds.length?[['其他',otherIds]]:[])];

    const topBlock=n>0
      ? h('div',{class:`ws-card health-top-card is-${d.status==='error'?'error':'attention'} health-status health-attn`,dataset:{status:d.status}},
          h('div',{class:'ws-card-head'},
            h('b',{},`${d.status==='error'?'异常':'需关注'} ${n} 项`),
            h('small',{},'采样 '+(fmtDateTime(d.at)||'尚未采样'))
          ),
          ...abnormal.map(m=>{
            const title=METRIC_TITLE[m.id]||m.name||m.id;
            const gName=groupOfMetric.get(m.id)||'其他';
            const href=actionHrefFor(m.id,gName);
            return h('div',{class:'health-attention-row health-attn-row',dataset:{metric:m.id,level:m.level}},
              h('b',{},title),
              h('span',{class:'health-attn-desc'},m.summary||(LABEL[m.level]||m.level)),
              href?h('a',{href,class:'health-action-link health-attn-link'},'去处理 →'):null
            );
          })
        )
      : h('div',{class:'ws-card health-top-card is-normal health-status health-status-ok'},
          h('span',{class:'ws-dot normal',role:'img','aria-label':'正常'}),
          h('strong',{},'全部正常'),
          h('span',{class:'small muted'},'· 采样 '+(fmtDateTime(d.at)||'尚未采样'))
        );

    const grid=h('div',{class:'ws-cols-3 health-groups-grid'},groups.map(([name,ids])=>{
      const rows=unique.filter(m=>ids.includes(m.id)).sort((a,b)=>(a.level==='normal')-(b.level==='normal')||ids.indexOf(a.id)-ids.indexOf(b.id));
      if(!rows.length&&name!=='账号')return null;
      const warnCount=rows.filter(m=>m.level!=='normal').length;
      return h('section',{class:'health-group-card health-group',dataset:{healthGroup:name}},
        h('div',{class:'health-group-head'},
          h('h2',{},name),
          h('span',{class:warnCount?'warn':'ok'},warnCount?`${warnCount} 项需关注`:'全部正常')
        ),
        h('div',{class:'health-chips',role:'list','aria-label':name+'指标'},rows.map(m=>{
          const mTitle=METRIC_TITLE[m.id]||m.name||m.id;
          const lText=LABEL[m.level]||m.level||'未知';
          const tip=`${mTitle}：${lText}${m.summary?'，'+m.summary:''}`;
          return h('span',{
            class:'health-chip'+(m.level==='normal'?'':' warn'),
            role:'listitem',
            tabindex:0,
            dataset:{metric:m.id,level:m.level},
            title:tip,
            'aria-label':tip,
          },
            h('i',{class:'ws-dot '+m.level,'aria-hidden':'true'}),
            h('span',{class:'health-name'},mTitle)
          );
        })),
        name==='账号'?h('div',{class:'health-account-footer small muted'},
          '检查 '+(fmtDateTime(compliance?.checkedAt||d.account?.checkedAt)||'尚未检查'),
          ' · ',
          h('a',{href:'#/settings/tasks'},'检查计划')
        ):null
      );
    }));

    set(metrics,topBlock,grid);
  }

  async function load(){
    if(dirty()){notice('请先保存健康配置，再刷新状态','error');return;}
    refresh.disabled=true;
    try{
      const [d,a,r,c]=await Promise.all([api('/api/health'),api('/api/health/alerts'),api('/api/health/reports'),api('/api/health/settings')]);
      if(!alive)return;
      config=structuredClone(c.settings);saved=JSON.stringify(config);revision=c.revision;
      renderMetrics(d);
      set(alerts,
        h('summary',{class:'ws-advanced-head'},
          h('b',{},'告警历史'),
          h('small',{class:'ws-advanced-summary'},a.items?.length?`近 7 天 ${a.items.length} 条`:'暂无告警历史')
        ),
        h('div',{class:'ws-advanced-body'},
          a.items?.length
            ? table(['状态','摘要','开始','恢复或最近一次'],a.items.map(v=>h('tr',{},h('td',{},v.resolvedAt?'已恢复':'持续中'),h('td',{},v.summary),h('td',{},fmtDateTime(v.startedAt)),h('td',{},fmtDateTime(v.resolvedAt||v.lastSeenAt)))),'health-alert-table')
            : empty('暂无告警历史')
        )
      );
      const channelCell=ch=>h('td',{title:'跳过 '+(ch.skipped||0)+' · 待回查 '+(ch.unknown||0)},(ch.received||0)+' / '+(ch.replied||0)+' / '+(ch.failed||0));
      const seconds=value=>Number.isFinite(value)?(value/1000).toFixed(1):null;
      set(reports,
        h('div',{class:'ws-card-head'},h('b',{},'每日日报'),h('small',{},'北京时间每天 09:00 归档')),
        r.items?.length
          ? table(['日期','调用','token','费用','公开 入／回／失败','私信 入／回／失败','响应 中位／P90','告警'],r.items.map(v=>{
              const callsCount=Number(v.model?.calls||0);
              const costVal=callsCount>0&&Number.isFinite(Number(v.model?.costUSD))?Number(v.model.costUSD):null;
              const med=seconds(v.responseLatencyMs?.median),p90=seconds(v.responseLatencyMs?.p90);
              return h('tr',{},
                h('td',{},v.date),
                h('td',{},callsCount),
                h('td',{},Number(v.model?.totalTokens||0).toLocaleString()),
                h('td',{},fmtUsd(costVal),v.model?.unpriced?` · 未定价 ${v.model.unpriced}`:null),
                channelCell(v.channels?.public||{}),
                channelCell(v.channels?.private||{}),
                h('td',{class:med===null&&p90===null?'muted':''},med===null&&p90===null?'—':`${med??'—'} / ${p90??'—'}`),
                h('td',{title:'拦截 '+(v.automationBlocks||0)+' · 浏览器恢复 '+(v.browserRestarts||0)+' · 暂停 '+Math.round((v.pausedMs||0)/60000)+' 分钟'},v.alerts||0)
              );
            }),'health-report-table')
          : empty('暂无日报；每日 09:00 归档前一北京日')
      );
      renderForm();
    }catch(e){if(alive)errorBox(metrics,e,load);}
    finally{refresh.disabled=false;}
  }

  function renderForm(){
    const adv=advanced('health','健康阈值与账号披露检查配置',
      field('简介披露词（每行一项）',h('textarea',{class:'input',rows:2,value:(config.requiredPhrases||[]).join('\n'),oninput:e=>{config.requiredPhrases=e.target.value.split('\n').map(x=>x.trim()).filter(Boolean);}})),
      h('div',{class:'run-adv-grid'},[
        ['softTimeoutMinutes','轮次软超时（分钟）',3,30,1],
        ['hardTimeoutMinutes','轮次硬超时（分钟）',5,45,1],
        ['publicCollectionSeconds','公开采集预算（秒）',10,300,1],
        ['privateCollectionSeconds','私信采集预算（秒）',10,300,1],
        ['rpcTimeoutSeconds','浏览器请求超时（秒）',10,300,1],
        ['memoryRatio','浏览器内存占比阈值',.25,.95,.01],
        ['browserMaxAgeHours','浏览器最长运行（小时）',1,168,1]
      ].map(([key,label,min,max,step])=>h('div',{class:'run-adv-field'},
        h('span',{class:'run-adv-label'},label),
        h('input',{class:'input ws-num',type:'number',min,max,step,'aria-label':label,value:config[key],oninput:e=>{config[key]=Number(e.target.value);}})
      ))),
      h('div',{},h('button',{type:'button',class:'btn primary small',onclick:async e=>{
        const button=e.currentTarget,snapshot=structuredClone(config);button.disabled=true;
        try{
          const r=await api('/api/health/settings',{method:'PUT',body:{...snapshot,revision}});
          if(!alive)return;
          revision=r.revision;saved=JSON.stringify(snapshot);
          ctx.onSaved?.();
          notice('健康配置已保存，下一次操作生效','ok');
        }catch(error){if(alive)notice(error.message,'error');}
        finally{button.disabled=false;}
      }},'保存健康配置'))
    );
    set(advHolder,adv);
  }

  load();
  return()=>{alive=false;cleanup();};
}
