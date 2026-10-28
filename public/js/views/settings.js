import {h,set} from '../dom.js';
import {api} from '../api.js';
import {onStatus,onEvent,getStatus} from '../state.js';
import {empty,errorBox,money} from '../view-utils.js';
import {mountWorkspace} from '../shell.js';

const GROUPS=[['运行',['run','model','tasks','triage']],['数据',['memory','billing']],['浏览器与采集',['browser','sources']],['排查',['health','logs','history']]];
const ITEMS={run:['运行与发送','保存后下一轮生效，顶部启动与暂停控制业务'],model:['模型','管理服务商、模型与参数'],tasks:['定时任务','计划统一使用北京时间'],triage:['消息分级与过滤','分级、优先名单与骚扰冷却'],memory:['记忆','用户记忆、角色经历与召回策略'],billing:['计费','Pi 内置价格估算 · 美元 · 北京时间'],browser:['浏览器接管','接管后自动处理停止，释放后保持暂停'],sources:['采集来源','仅在打开此项时读取浏览器来源状态'],health:['健康与日报','健康指标、账号检查与每日归档'],logs:['日志阶段与队列','运行事件与排查信息'],history:['任务执行历史','执行状态、耗时与关联调用']};
const LOADERS={run:()=>import('./settings/run.js'),model:()=>import('./model.js'),tasks:()=>import('./task-settings.js'),triage:()=>import('./triage-settings.js'),memory:()=>import('./memory.js'),billing:()=>import('./billing.js'),browser:()=>import('./browser.js'),sources:()=>import('./settings/sources.js'),health:()=>import('./settings/health.js'),logs:()=>import('./program.js'),history:()=>import('./task-settings.js')};
const CONTROL={paused:'已暂停',running:'运行中',draining:'正在暂停',manual:'人工接管中'};
const stored=()=>{try{return localStorage.getItem('ws:settings:item');}catch{return null;}};
function style(){if(document.getElementById('settings-workspace-style'))return;document.head.append(h('link',{id:'settings-workspace-style',rel:'stylesheet',href:'/settings-workspace.css'}));}
export function mount(root,ctx){
 style();let alive=true,active=null,sequence=0,summaryGeneration=0;const mounted=new Map(),summaries=new Map();
 const ws=mountWorkspace(root,{page:'settings'}),heading=h('div',{class:'settings-heading'}),actions=h('div',{class:'settings-actions'});set(ws.leftHeader,h('strong',{},'设置'));set(ws.mainHeader,heading,actions);
 const childGuard=()=>active?.guard?.()??true;ctx.setLeaveGuard(childGuard);
 for(const [title,ids]of GROUPS){const group=h('section',{class:'settings-nav-group'},h('h2',{class:'settings-nav-label'},title));for(const id of ids){const summary=h('span',{class:'settings-nav-summary'},id==='sources'||id==='logs'?'':'—'),link=h('a',{href:'#/settings/'+id,class:'settings-nav-item',dataset:{settingsItem:id}},h('span',{class:'settings-nav-title'},ITEMS[id][0]),summary);summaries.set(id,summary);group.append(link);}ws.left.append(group);}
 function setSummary(id,value,level){const node=summaries.get(id);if(!node)return;node.textContent=value;node.dataset.level=level||'';}
 function updateStatus(s){if(!s)return;const config=s.config||{};setSummary('run',(config.mode==='auto'?'自动':'草稿')+' · '+(CONTROL[s.control]||s.control||'未知'));const model=config.model;setSummary('model',model?.configured?[model.provider,model.id].filter(Boolean).join(' / '):'尚未配置');setSummary('browser',s.control==='manual'?'人工接管中':(s.browser?.loggedIn??s.identity?.loggedIn)===false?'需要登录':'未接管',s.control==='manual'?'attention':'');const cached=mounted.get('browser');if(cached&&cached!==active&&!cached.root.querySelector('#desktop-frame'))dispose(cached);}
 async function refreshSummaries(){const generation=++summaryGeneration,day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now()),end=new Date(Date.parse(day+'T00:00:00+08:00')+86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});const jobs=[
  ['run','/api/program',d=>(d.settings?.mode==='auto'?'自动':'草稿')+' · '+(CONTROL[d.control]||d.control||'未知')],
  ['tasks','/api/tasks',d=>{const tasks=(d.tasks||[]).filter(t=>!['main','health'].includes(t.id));return tasks.filter(t=>t.enabled).length+' / '+tasks.length+' 启用';}],
  ['triage','/api/triage/summary',d=>'排队 '+(d.queues||[]).reduce((n,q)=>n+Number(q.count||0),0)],
  ['memory','/api/memory/policy',d=>'近期 '+d.policy.recentCount+' 次 / '+d.policy.recentDays+' 天'],
  ['billing','/api/billing/summary?'+new URLSearchParams({from:day,to:end}),d=>{const totals=d.totals||d.summary||d;return totals.unpriced?'未定价 '+totals.unpriced:'今日 '+money(totals.costUSD??totals.estimatedUsd??0);}],
  ['health','/api/health',d=>{const n=(d.metrics||[]).filter(m=>m.level!=='normal').length;return d.status==='error'?'异常 '+n:d.status==='attention'?'需关注 '+n:'正常';}],
  ['history','/api/tasks/runs?limit=1',d=>d.items?.[0]?.status==='failed'?'最近失败':'']
 ];await Promise.allSettled(jobs.map(async([id,path,format])=>{try{const d=await api(path);if(alive&&generation===summaryGeneration){setSummary(id,format(d),id==='health'?d.status:id==='history'&&d.items?.[0]?.status==='failed'?'error':'');}}catch{if(alive&&generation===summaryGeneration)setSummary(id,'—');}}));updateStatus(getStatus());}
 function dispose(entry){entry.cleanup?.();entry.root.remove();mounted.delete(entry.id);}
 async function route(target=ctx.route){if(target.page!=='settings')return;const wanted=target.section||stored()||'run',id=ITEMS[wanted]?wanted:'run';if(target.section!==id){const query=target.params?.toString();const hash='#/settings/'+id+(query?'?'+query:'');if(ctx.replaceRouteHash)ctx.replaceRouteHash(hash);else history.replaceState(null,'',hash);target={...target,section:id,hash};ctx.route=target;}try{localStorage.setItem('ws:settings:item',id);}catch{}
  if(active?.id===id&&(id!=='memory'||target.hash===active.ctx.route.hash)){active.ctx.route={...target,section:id};return;}
  const token=++sequence;if(active){if(active.id==='browser'&&active.root.querySelector('#desktop-frame'))active.root.hidden=true;else dispose(active);}set(actions);set(heading,h('strong',{},ITEMS[id][0]),h('span',{class:'small muted settings-description'},ITEMS[id][1]));for(const link of ws.left.querySelectorAll('[data-settings-item]')){const selected=link.dataset.settingsItem===id;link.classList.toggle('selected',selected);if(selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  if(matchMedia('(max-width:860px)').matches)ws.close('left');
  const existing=mounted.get(id);if(existing){active=existing;active.root.hidden=false;active.ctx.route={...target,section:id};set(actions,...(active.actions||[]));return;}
  const body=h('div',{class:'settings-item-content',dataset:{settingsView:id}},empty('正在读取…'));ws.main.append(body);const entry={id,root:body,cleanup:null,guard:null,ctx:null,actions:[]};active=entry;mounted.set(id,entry);const child={...ctx,route:{...target,section:id},workspace:true,embedded:true,settingsEmbedded:id==='logs',header:ws.mainHeader,setActions(...nodes){entry.actions=nodes;if(alive&&active===entry)set(actions,...nodes);},onSaved(){window.dispatchEvent(new CustomEvent('settings-saved',{detail:{id}}));},setSummary(value,level){setSummary(id,value,level);},setLeaveGuard(fn){entry.guard=fn;}};entry.ctx=child;
  try{const module=await LOADERS[id]();if(!alive||token!==sequence||active!==entry)return;entry.cleanup=(id==='history'?module.mountHistory:module.mount)(body,child)||null;}catch(error){if(alive&&active===entry)errorBox(body,error,()=>{dispose(entry);active=null;route(target);});}
 }
 const onRoute=e=>route(e.detail),onSaved=()=>refreshSummaries();window.addEventListener('panel-route',onRoute);window.addEventListener('settings-saved',onSaved);const offStatus=onStatus(updateStatus),offEvents=['program','tasks','health','feed'].map(name=>onEvent(name,()=>refreshSummaries()));refreshSummaries();route();
 return()=>{alive=false;sequence++;summaryGeneration++;offStatus();offEvents.forEach(fn=>fn());window.removeEventListener('panel-route',onRoute);window.removeEventListener('settings-saved',onSaved);for(const entry of [...mounted.values()])dispose(entry);ctx.setLeaveGuard(null);ws.dispose();};
}
