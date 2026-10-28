import {h,set,fmtDateTime} from '../dom.js';
import {api} from '../api.js';
import {getStatus,onStatus,notice,refreshStatus} from '../state.js';
import {field,empty,errorBox} from '../view-utils.js';

const STATUS={pending:'待下一轮核对',imported:'已补录入队',duplicate:'已有消息记录',rejected:'未通过核对',failed:'核对失败'};
export function mount(actions,root,{onImported}={}){
 let alive=true,loading=false,reloadRequested=false,busy=false,loaded=false,currentFilter='all',accountId=getStatus()?.accountId||'',items=[],cursor=null;
 const dialogRoot=h('div'),input=h('input',{class:'input',id:'manual-import-url',type:'url',placeholder:'https://x.com/账号/status/…'}),feedback=h('div',{class:'small',role:'status'});
 const openButton=h('button',{class:'btn',id:'manual-import-open',type:'button',disabled:!accountId,onclick:openDialog},'按链接补录');
 const list=h('div',{class:'stack'}),more=h('button',{class:'btn small',type:'button',hidden:true,onclick:()=>load(true)},'加载更早补录结果');
 const heading=h('summary',{},'补录请求与结果'),box=h('details',{class:'card',id:'manual-imports'},heading,h('div',{class:'settings-body stack'},h('div',{class:'toolbar'},h('span',{class:'muted small grow'},'补录通过后仍按正常模式、时效与额度处理，不会因提交链接立即发送。'),h('button',{class:'btn small',type:'button',onclick:()=>load(false)},'刷新补录结果')),list,more));
 actions.append(openButton);root.append(box,dialogRoot);
 function scopeMatches(data,expected){return (!data.accountId||data.accountId===expected)&&(!data.request?.accountId||data.request.accountId===expected)&&(data.items||[]).every(item=>!item.accountId||item.accountId===expected);}
 function recheckAccount(){items=[];cursor=null;loaded=false;heading.textContent='补录请求与结果';render();feedback.textContent='补录响应的工作账号已变化，正在重新确认账号';notice(feedback.textContent,'error');void refreshStatus();}
 function closeDialog(){if(busy)return;set(dialogRoot);openButton.focus();}
 function openDialog(){
  if(!accountId){notice('请先确认当前工作账号','error');return;}
  const submit=h('button',{class:'btn primary',id:'manual-import-submit',type:'submit'},'提交补录请求'),cancel=h('button',{class:'btn',type:'button',onclick:closeDialog},'关闭');
  const form=h('form',{class:'stack',onsubmit:async e=>{
   e.preventDefault();if(busy||!input.value.trim())return;const expected=accountId,url=input.value.trim();busy=true;submit.disabled=true;cancel.disabled=true;input.disabled=true;feedback.textContent='正在保存请求…';
   try{
    const data=await api('/api/messages/import',{method:'POST',body:{url}});if(!alive||expected!==accountId)return;if(!scopeMatches(data,expected)){recheckAccount();return;}
    input.value='';const request=data.request;feedback.textContent=(STATUS[request?.status||data.status]||'请求已保存')+(request?.reason?'：'+request.reason:'')+(data.messageStatus?' · 原消息 '+data.messageStatus:'');
    notice(data.status==='duplicate'?'链接已有消息记录，未重复打开浏览器':'补录请求已保留，正常轮次会只读核对','ok');loaded=true;box.open=true;await load(false);onImported?.();
   }catch(error){if(alive&&expected===accountId)feedback.textContent=error.message;}
   finally{busy=false;submit.disabled=false;cancel.disabled=false;input.disabled=false;}
  }},field('帖子链接',input,'支持 X 与 Twitter 的单条帖子链接，核对时不会打开链接卡片网页。'),h('p',{class:'small muted'},'暂停、人工接管或排空期间只保留请求。恢复后每轮最多核对三条，原消息相关性、作者和时间均须通过检查。'),feedback,h('div',{class:'toolbar'},submit,cancel));
  const dialog=h('section',{class:'modal-card stack',role:'dialog','aria-modal':'true','aria-labelledby':'manual-import-title',onkeydown:e=>{
   if(e.key==='Escape'){e.preventDefault();closeDialog();return;}
   if(e.key==='Tab'){const controls=[...dialog.querySelectorAll('input,button,a[href]')].filter(el=>!el.disabled);if(!controls.length)return;const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  }},h('h2',{id:'manual-import-title'},'按链接补录公开消息'),form);
  set(dialogRoot,h('div',{class:'modal-overlay'},dialog));queueMicrotask(()=>input.focus());
 }
 function render(){
  set(list,items.length?items.map(item=>{
   const details=h('details',{class:'feed-details'},h('summary',{},'补录详情'),h('div',{class:'small pre-wrap'},'请求 '+item.id+'\n平台消息 '+item.platformId+'\n更新 '+fmtDateTime(item.updatedAt)));
   return h('article',{class:'subcard stack manual-import-item',dataset:{id:item.id}},h('div',{class:'toolbar'},h('b',{class:'grow'},STATUS[item.status]||item.status),h('time',{class:'small muted'},fmtDateTime(item.createdAt))),h('div',{class:'small break'},item.url),item.reason?h('div',{class:'small'},item.reason):null,item.messageId?h('div',{class:'small break'},'关联消息 '+item.messageId+(item.messageStatus?' · '+item.messageStatus:'')):null,['failed','rejected'].includes(item.status)?h('button',{class:'btn small',type:'button',onclick:()=>{input.value=item.url;feedback.textContent='重新提交后仍会按当前账号、时效和相关性核对。';openDialog();}},'重新提交链接'):null,details);
  }):empty(currentFilter==='pending'?'没有待核对的补录请求。':'暂无补录请求。'));
  more.hidden=!cursor;
 }
 async function load(append=false){
  if(!accountId){set(list,empty('确认当前工作账号后再读取补录请求。'));return;}if(loading){if(!append)reloadRequested=true;return;}loading=true;const expected=accountId,filter=currentFilter;more.disabled=true;
  try{const query=new URLSearchParams({limit:'30'});if(filter==='pending')query.set('status','pending');if(append&&cursor)query.set('cursor',cursor);const data=await api('/api/messages/imports?'+query);if(!alive||expected!==accountId||filter!==currentFilter)return;if(!scopeMatches(data,expected)){recheckAccount();return;}items=append?[...items,...data.items]:data.items;cursor=data.nextCursor??null;loaded=true;heading.textContent='补录请求与结果'+(data.pending?' · 待处理 '+data.pending:'');render();}
  catch(error){if(alive&&expected===accountId)errorBox(list,error,()=>load(false));}
  finally{loading=false;more.disabled=false;const reload=reloadRequested||expected!==accountId||filter!==currentFilter;reloadRequested=false;if(alive&&reload&&box.open)queueMicrotask(()=>load(false));}
 }
 box.addEventListener('toggle',()=>{if(box.open&&!loaded)load(false);});
 const off=onStatus(s=>{if(!s)return;const next=s?.accountId||'';openButton.disabled=!next;if(next===accountId)return;accountId=next;items=[];cursor=null;loaded=false;input.value='';feedback.textContent='';heading.textContent='补录请求与结果';set(dialogRoot);render();if(box.open)load(false);});
 return{
  dirty:()=>!!input.value.trim(),
  setFilter(filter){const changed=filter!==currentFilter;currentFilter=filter;box.hidden=!['all','pending'].includes(filter);if(filter==='pending')box.open=true;if(changed&&box.open&&!box.hidden)load(false);},
  refresh(){if(loaded&&box.open&&!box.hidden)load(false);},
  dispose(){alive=false;off();set(dialogRoot);}
 };
}
