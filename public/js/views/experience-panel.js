import {h,set,fmtDateTime} from '../dom.js';
import {api} from '../api.js';
import {getStatus,onStatus,notice,refreshStatus} from '../state.js';
import {field,empty,errorBox} from '../view-utils.js';

const VERIFY={verified:'已核对，可用于回复',pending:'待下一轮只读核对',failed:'核对失败，不用于回复'};
function dateOf(value){if(!value)return '';return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Number(value));}
function safeLink(value){try{const u=new URL(value);if(u.protocol==='https:'&&u.hostname==='x.com'&&!u.username&&!u.password&&/^\/[A-Za-z0-9_]+\/status\/\d+$/.test(u.pathname))return h('a',{href:u.href,target:'_blank',rel:'noopener noreferrer'},'已登记的帖子 ↗');}catch{}return null;}

/** 账号级经历；账号切换立即清除上一账号的列表及草稿。 */
export function mount(root){
 let alive=true,loaded=false,loading=false,reloadRequested=false,saving=false,accountId=getStatus()?.accountId||'',revision=0,cursor=null,items=[],editing=null,savedDraft='';
 const body=h('div',{class:'stack settings-body'}),box=h('details',{class:'card',id:'memory-experiences'},h('summary',{},'角色经历'),body);
 const list=h('div',{class:'stack',id:'experience-list'}),status=h('div',{class:'small muted',role:'status'}),account=h('div',{class:'small muted'});
 const text=h('textarea',{class:'input',id:'experience-text',rows:3,maxlength:1200,placeholder:'登记角色实际发生的重要经历'}),date=h('input',{class:'input',id:'experience-date',type:'date'}),url=h('input',{class:'input',id:'experience-url',type:'url',placeholder:'https://x.com/当前账号/status/…'});
 const save=h('button',{class:'btn primary',id:'experience-save',type:'button',onclick:saveEntry},'登记经历'),cancel=h('button',{class:'btn',type:'button',onclick:()=>resetEditor()},'取消编辑');
 const more=h('button',{class:'btn',type:'button',hidden:true,onclick:()=>load(true)},'加载更多经历');
 const editor=h('details',{class:'subcard',id:'experience-editor'},h('summary',{},'登记或编辑经历'),h('div',{class:'stack settings-body'},field('经历正文',text,'最多 1,200 字符；不登记为用户事实。'),h('div',{class:'grid2'},field('发生日期（北京时间）',date),field('当前账号帖子链接（可选）',url)),h('div',{class:'small muted'},'带链接的经历在核对通过前不用于回复。暂停或接管期间只保留登记，不打开 X。'),h('div',{class:'toolbar'},save,cancel),status));
 set(body,account,h('div',{class:'toolbar'},h('span',{class:'small muted grow'},'只召回角色发帖和可用的人工经历，普通回复保留在用户互动记录中。'),h('button',{class:'btn small',type:'button',onclick:()=>load(false)},'刷新核对状态')),editor,list,more);root.append(box);
 const draft=()=>JSON.stringify({text:text.value,date:date.value,url:url.value});
 const dirty=()=>draft()!==savedDraft;
 function resetEditor(){editing=null;text.value='';date.value=dateOf(Date.now());url.value='';save.textContent='登记经历';status.textContent='';savedDraft=draft();cancel.hidden=true;}
 resetEditor();
 function scopeMatches(data,expected){return (!data.accountId||data.accountId===expected)&&(!data.item?.accountId||data.item.accountId===expected)&&(data.items||[]).every(item=>!item.accountId||item.accountId===expected);}
 function recheckAccount(){items=[];cursor=null;loaded=false;render();notice('经历响应的工作账号已变化，正在重新确认账号','error');void refreshStatus();}
 function render(){
  account.textContent=accountId?'当前工作账号 @'+accountId:'当前工作账号尚未确认';
  save.disabled=saving||!accountId||!loaded;more.hidden=!cursor;
  set(list,items.length?items.map(item=>{
   const note=h('div',{class:'small muted'},VERIFY[item.verifyStatus]||'核对状态未知',item.verifyReason?' · '+item.verifyReason:'');
   const actions=h('div',{class:'toolbar'});
   if(item.kind==='manual'||item.type==='manual')actions.append(h('button',{class:'btn small',type:'button',onclick:()=>{
    if(dirty()){notice('请先保存当前经历或取消编辑，再编辑其他条目','error');return;}
    editing=item;text.value=item.text;date.value=dateOf(item.occurredAt);url.value=item.url||'';savedDraft=draft();save.textContent='保存经历';cancel.hidden=false;editor.open=true;text.focus();
   }},'编辑经历'));
   actions.append(h('button',{class:'btn small',type:'button',onclick:async e=>{
    const button=e.currentTarget;button.disabled=true;const snapshot=accountId;
    try{const data=await api('/api/memory/experiences/'+encodeURIComponent(item.id)+'/'+(item.hidden?'unhide':'hide'),{method:'POST',body:{revision:item.revision}});if(!alive||snapshot!==accountId)return;if(!scopeMatches(data,snapshot)){recheckAccount();return;}await load(false);notice(item.hidden?'已恢复经历的可用状态':'已隐藏；原平台回执与出站记录保持不变','ok');}
    catch(error){if(alive)notice(error.message,'error');}finally{button.disabled=false;}
   }},item.hidden?'取消隐藏':'隐藏经历'));
   return h('article',{class:'subcard stack experience-item',dataset:{id:item.id}},h('div',{class:'toolbar'},h('b',{class:'grow'},item.kind==='manual'||item.type==='manual'?'人工登记':'已确认发帖'),h('span',{class:'chip'},item.hidden?'已隐藏':'未隐藏')),h('div',{class:'small muted'},'发生于 '+(fmtDateTime(item.occurredAt)||'日期未知')+' · 修订 '+item.revision),h('div',{class:'pre-wrap'},item.text),note,safeLink(item.url),actions);
  }):empty(accountId?'暂无角色经历，可登记重要的手动发帖或经历。':'确认工作账号后再读取角色经历。'));
 }
 async function load(append=false){
  if(!accountId){render();return;}if(loading){if(!append)reloadRequested=true;return;}loading=true;const expected=accountId;more.disabled=true;
  try{
   const query=new URLSearchParams({limit:'30'});if(append&&cursor)query.set('cursor',cursor);
   const data=await api('/api/memory/experiences?'+query);if(!alive||expected!==accountId)return;if(!scopeMatches(data,expected)){recheckAccount();return;}
   items=append?[...items,...data.items]:data.items;cursor=data.nextCursor??null;revision=data.revision;loaded=true;render();
  }catch(error){if(alive&&expected===accountId)errorBox(list,error,()=>load(false));}
  finally{loading=false;more.disabled=false;const reload=reloadRequested||expected!==accountId;reloadRequested=false;if(alive&&reload&&box.open)queueMicrotask(()=>load(false));}
 }
 async function saveEntry(){
  if(saving||!accountId)return;if(!text.value.trim()||!date.value){status.textContent='请填写经历正文和发生日期';return;}
  saving=true;save.disabled=true;status.textContent='正在保存…';const expected=accountId,selected=editing,payload={text:text.value.trim(),occurredAt:date.value,...(url.value.trim()?{url:url.value.trim()}:{url:''}),revision:selected?selected.revision:revision},snapshot=draft();
  try{
   const data=await api('/api/memory/experiences'+(selected?'/'+encodeURIComponent(selected.id):''),{method:selected?'PUT':'POST',body:payload});
   if(!alive||expected!==accountId)return;if(!scopeMatches(data,expected)){recheckAccount();return;}revision=data.revision;
   if(draft()===snapshot)resetEditor();else{savedDraft=snapshot;if(editing===selected){editing=data.item;save.textContent='保存经历';cancel.hidden=false;}}
   status.textContent=data.item?.verifyStatus==='pending'?'已登记，等待正常轮次只读核对链接':'已保存经历';await load(false);notice('经历已保存，控制状态不变','ok');
  }catch(error){if(alive&&expected===accountId)status.textContent=error.message;}
  finally{saving=false;if(alive)save.disabled=!accountId||!loaded;}
 }
 box.addEventListener('toggle',()=>{if(box.open&&!loaded&&!loading)load(false);});
 const off=onStatus(value=>{
  if(!value)return;const next=value?.accountId||'';if(next===accountId)return;
  const hadDraft=dirty();accountId=next;items=[];cursor=null;revision=0;loaded=false;resetEditor();render();if(hadDraft)notice('工作账号已变化，上一账号的经历草稿已清除','error');if(box.open)load(false);
 });render();
 return{dirty,dispose(){alive=false;off();}};
}
