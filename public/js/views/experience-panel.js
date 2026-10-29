import {h,set,fmtDateTime} from '../dom.js';
import {api} from '../api.js';
import {getStatus,onStatus,notice,refreshStatus} from '../state.js';
import {field,errorBox,rowActions,emptyLine} from '../view-utils.js';

const VERIFY={verified:'已核对',pending:'待核对',failed:'核对失败'};
function dateOf(value){
 if(!value)return '';
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Number(value));
}
function safeLink(value){
 try{
  const u=new URL(value);
  if(u.protocol==='https:'&&u.hostname==='x.com'&&!u.username&&!u.password&&/^\/[A-Za-z0-9_]+\/status\/\d+$/.test(u.pathname)){
   return h('a',{href:u.href,target:'_blank',rel:'noopener noreferrer',class:'small'},'原帖 ↗');
  }
 }catch{}
 return null;
}

/** 账号级经历；账号切换立即清除上一账号的列表及草稿。 */
export function mount(root){
 let alive=true,loaded=false,loading=false,reloadRequested=false,saving=false,accountId=getStatus()?.accountId||'',revision=0,cursor=null,items=[],editing=null,savedDraft='';
 const box=h('section',{class:'ws-card card stack',id:'memory-experiences'});
 const list=h('div',{class:'stack',id:'experience-list'});
 const status=h('div',{class:'small muted',role:'status'});
 const account=h('small',{class:'muted'});
 const text=h('textarea',{class:'input',id:'experience-text',rows:3,maxlength:1200,placeholder:'登记角色实际发生的重要经历'});
 const date=h('input',{class:'input',id:'experience-date',type:'date'});
 const url=h('input',{class:'input',id:'experience-url',type:'url',placeholder:'https://x.com/当前账号/status/…'});
 const save=h('button',{class:'btn primary',id:'experience-save',type:'button',onclick:saveEntry},'登记经历');
 const cancel=h('button',{class:'btn',type:'button',onclick:()=>closeDialog()},'取消');
 const more=h('button',{class:'btn small',type:'button',hidden:true,onclick:()=>load(true)},'加载更多经历');

 const dialogTitle=h('h2',{class:'card-h grow'},'登记经历');
 const dialogWrap=h('div',{class:'modal',hidden:true,id:'experience-editor',onclick:e=>{if(e.target===dialogWrap)closeDialog();}},
  h('div',{class:'modal-card stack',role:'dialog','aria-modal':'true','aria-label':'登记或编辑经历'},
   h('div',{class:'toolbar'},
    dialogTitle,
    h('button',{class:'btn small ghost',type:'button',onclick:()=>closeDialog()},'关闭')
   ),
   field('经历正文',text,'最多 1,200 字符；不登记为用户事实。'),
   h('div',{class:'grid2'},
    field('发生日期（北京时间）',date),
    field('当前账号帖子链接（可选）',url)
   ),
   h('div',{class:'small muted'},'带链接的经历在核对通过前不用于回复。暂停或接管期间只保留登记，不打开 X。'),
   status,
   h('div',{class:'toolbar'},h('span',{class:'grow'}),cancel,save)
  )
 );

 const addBtn=h('button',{
  class:'btn small primary',
  id:'experience-add-btn',
  type:'button',
  onclick:()=>{
   resetEditor();
   dialogTitle.textContent='登记经历';
   dialogWrap.hidden=false;
   text.focus();
  }
 },'＋ 登记经历');

 set(box,
  h('div',{class:'ws-card-head toolbar'},
   h('h2',{class:'card-h'},'角色经历'),
   account,
   h('span',{class:'small muted grow'},'只召回角色发帖和可用的人工经历，普通回复保留在用户互动记录中。'),
   h('button',{class:'btn small',type:'button',onclick:()=>load(false)},'刷新核对状态'),
   addBtn
  ),
  list,
  more,
  dialogWrap
 );
 root.append(box);

 const draft=()=>JSON.stringify({text:text.value,date:date.value,url:url.value});
 const dirty=()=>!dialogWrap.hidden&&draft()!==savedDraft;

 function resetEditor(){
  editing=null;
  text.value='';
  date.value=dateOf(Date.now());
  url.value='';
  save.textContent='登记经历';
  status.textContent='';
  savedDraft=draft();
 }
 function closeDialog(){
  dialogWrap.hidden=true;
  resetEditor();
 }
 resetEditor();

 function scopeMatches(data,expected){
  return (!data.accountId||data.accountId===expected)&&(!data.item?.accountId||data.item.accountId===expected)&&(data.items||[]).every(item=>!item.accountId||item.accountId===expected);
 }
 function recheckAccount(){
  items=[];cursor=null;loaded=false;render();
  notice('经历响应的工作账号已变化，正在重新确认账号','error');
  void refreshStatus();
 }

 function render(){
  account.textContent=accountId?'@'+accountId:'账号未确认';
  save.disabled=saving||!accountId||!loaded;
  more.hidden=!cursor;
  if(!items.length){
   set(list,emptyLine(accountId?'暂无角色经历，可点击右上角「＋ 登记经历」添加':'确认工作账号后再读取角色经历'));
   return;
  }
  const tbody=h('tbody');
  for(const item of items){
   const isManual=item.kind==='manual'||item.type==='manual';
   const editBtn=isManual?h('button',{
    class:'btn small',
    type:'button',
    onclick:e=>{
     e.stopPropagation();
     editing=item;
     text.value=item.text;
     date.value=dateOf(item.occurredAt);
     url.value=item.url||'';
     savedDraft=draft();
     save.textContent='保存经历';
     dialogTitle.textContent='编辑经历';
     dialogWrap.hidden=false;
     text.focus();
    }
   },'编辑'):null;

   const hideBtn=h('button',{
    class:'btn small',
    type:'button',
    onclick:async e=>{
     e.stopPropagation();
     const button=e.currentTarget;
     button.disabled=true;
     const snapshot=accountId;
     try{
      const data=await api('/api/memory/experiences/'+encodeURIComponent(item.id)+'/'+(item.hidden?'unhide':'hide'),{method:'POST',body:{revision:item.revision}});
      if(!alive||snapshot!==accountId)return;
      if(!scopeMatches(data,snapshot)){recheckAccount();return;}
      await load(false);
      notice(item.hidden?'已恢复经历的可用状态':'已隐藏；原平台回执与出站记录保持不变','ok');
     }catch(error){
      if(alive)notice(error.message,'error');
     }finally{
      button.disabled=false;
     }
    }
   },item.hidden?'取消隐藏':'隐藏经历');

   const tr=h('tr',{
    class:'experience-item experience-row'+(item.hidden?' is-muted':''),
    dataset:{id:item.id},
    onclick:e=>{if(e.target.closest('button,a'))return;tr.classList.toggle('selected');}
   },
    h('td',{class:'experience-summary-cell'},
     h('span',{class:'experience-summary-text',title:item.text},item.text),
     item.hidden?h('span',{class:'ws-badge neutral',style:'margin-left:6px'},'已隐藏'):null
    ),
    h('td',{class:'muted small nowrap'},
     isManual?'人工登记':'已确认发帖',
     ' · ',
     VERIFY[item.verifyStatus]||'核对未知',
     item.url?[' · ',safeLink(item.url)]:null
    ),
    h('td',{class:'muted small numbers nowrap'},dateOf(item.occurredAt)||fmtDateTime(item.occurredAt)||'—'),
    h('td',{class:'tasks-act-cell'},rowActions(editBtn,hideBtn))
   );
   tbody.append(tr);
  }
  set(list,h('div',{class:'table-wrap'},h('table',{class:'data-table experience-table'},tbody)));
 }

 async function load(append=false){
  if(!accountId){render();return;}
  if(loading){if(!append)reloadRequested=true;return;}
  loading=true;
  const expected=accountId;
  more.disabled=true;
  try{
   const query=new URLSearchParams({limit:'30'});
   if(append&&cursor)query.set('cursor',cursor);
   const data=await api('/api/memory/experiences?'+query);
   if(!alive||expected!==accountId)return;
   if(!scopeMatches(data,expected)){recheckAccount();return;}
   items=append?[...items,...data.items]:data.items;
   cursor=data.nextCursor??null;
   revision=data.revision;
   loaded=true;
   render();
  }catch(error){
   if(alive&&expected===accountId)errorBox(list,error,()=>load(false));
  }finally{
   loading=false;
   more.disabled=false;
   const reload=reloadRequested||expected!==accountId;
   reloadRequested=false;
   if(alive&&reload)queueMicrotask(()=>load(false));
  }
 }

 async function saveEntry(){
  if(saving||!accountId)return;
  if(!text.value.trim()||!date.value){status.textContent='请填写经历正文和发生日期';return;}
  saving=true;
  save.disabled=true;
  status.textContent='正在保存…';
  const expected=accountId,selected=editing,payload={
   text:text.value.trim(),
   occurredAt:date.value,
   ...(url.value.trim()?{url:url.value.trim()}:{url:''}),
   revision:selected?selected.revision:revision
  };
  try{
   const data=await api('/api/memory/experiences'+(selected?'/'+encodeURIComponent(selected.id):''),{method:selected?'PUT':'POST',body:payload});
   if(!alive||expected!==accountId)return;
   if(!scopeMatches(data,expected)){recheckAccount();return;}
   revision=data.revision;
   closeDialog();
   await load(false);
   notice('经历已保存，控制状态不变','ok');
  }catch(error){
   if(alive&&expected===accountId)status.textContent=error.message;
  }finally{
   saving=false;
   if(alive)save.disabled=!accountId||!loaded;
  }
 }

 const off=onStatus(value=>{
  if(!value)return;
  const next=value?.accountId||'';
  if(next===accountId)return;
  const hadDraft=dirty();
  accountId=next;
  items=[];cursor=null;revision=0;loaded=false;
  closeDialog();
  render();
  if(hadDraft)notice('工作账号已变化，上一账号的经历草稿已清除','error');
  load(false);
 });
 render();
 load(false);
 return{dirty,dispose(){alive=false;off();}};
}
