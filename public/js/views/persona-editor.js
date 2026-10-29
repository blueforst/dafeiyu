import { h,set,fmtDateTime } from '../dom.js';
import { api } from '../api.js';
import { notice } from '../state.js';
import { field,money,billingBadge,errorBox } from '../view-utils.js';
import { sideItem,badge,button,card,stateMessage } from '../shell.js';
import { mount as mountReplay } from './persona-replay.js';

const BASE='/api/personas',clone=v=>structuredClone(v),sidebars=new WeakMap();
export function mount(ws,{route,library,navigate,onLibraryChanged,setDirty,onTryPersona,drafts=new Map(),disclosureRoot}) {
 let alive=true,item=null,persona=null,saved='',revision=0,busy=false,presets=[],replayOff=null,hints=null,hintsSaved='',hintRevision=0;
 const content=h('div',{class:'ws-stack'}),reminder=disclosureRoot||h('div'),tally=h('span',{class:'small muted'});
 set(ws.main,...(disclosureRoot?[]:[reminder]),content);setDirty(()=>!!persona&&JSON.stringify(persona)!==saved||!!hints&&JSON.stringify(hints)!==hintsSaved);ws.setRight(false);
 const mode=route.kind||'p';
 let sidebar=sidebars.get(ws.left);
 if(!sidebar){sidebar={nodes:new Map(),actions:{},header:null,presetHeading:h('div',{class:'ws-group-title'},'内置预设 · 只读模板'),footer:h('div',{class:'ws-side-footer'})};sidebars.set(ws.left,sidebar);}
 sidebar.actions={importFile,create,navigate,copy:()=>create('copy',{sourceId:item?.id||library.activeId})};

 async function action(fn){if(!alive||busy)return;busy=true;try{await fn();}catch(e){notice(e.message,'error');}finally{busy=false;update();}}
 function go(id){navigate('#/persona/p/'+encodeURIComponent(id));}
 async function create(from,params={}){await action(async()=>{const d=await api(BASE,{method:'POST',body:{from,...params}});if(!alive)return;await onLibraryChanged();if(alive)go(d.item.id);});}
 function newMenu(){
  const d=h('details',{class:'ws-menu'},h('summary',{class:'ws-button','aria-label':'新建人设'},'＋'));
  d.append(h('div',{class:'ws-menu-popover'},button('从文件导入',()=>{d.open=false;sidebar.actions.importFile();}),button('空白人设',()=>{d.open=false;sidebar.actions.create('blank');}),button('从预设新建',()=>{d.open=false;sidebar.actions.navigate('#/persona/preset/default');}),button('复制当前人设',()=>{d.open=false;sidebar.actions.copy();})));return d;
 }
 function renderLeft(){
  if(!sidebar.header)sidebar.header=h('div',{class:'toolbar'},h('span',{class:'ws-group-title grow'},'我的人设'),newMenu());
  const wanted=[];
  function nav(key,{title,subtitle='',meta='',selected=false,href}){
   let node=sidebar.nodes.get(key);
   if(!node){node=sideItem({title,subtitle:' ',meta:' ',onclick:()=>sidebar.actions.navigate(node.dataset.personaHref),'data-persona-nav':key});sidebar.nodes.set(key,node);}
   node.dataset.personaHref=href;node.classList.toggle('selected',selected);
   if(selected)node.setAttribute('aria-current','true');else node.removeAttribute('aria-current');
   const text=(selector,value)=>{const el=node.querySelector(selector);if(el.textContent!==value)el.textContent=value;el.hidden=!value;};
   text('.ws-side-title',title);text('.ws-side-subtitle',subtitle);text('.ws-side-meta',meta);wanted.push(node);return node;
  }
  const own=library.items.map(p=>nav('p:'+p.id,{title:p.name,subtitle:p.id===library.activeId?'用于生产回复与日程':'修订 '+p.revision,meta:p.id===library.activeId?'使用中':fmtDateTime(p.updatedAt),selected:mode==='p'&&p.id===(route.id||library.activeId),href:'#/persona/p/'+encodeURIComponent(p.id)}));
  const templates=presets.map(p=>nav('preset:'+p.id,{title:p.name,subtitle:p.summary,selected:mode==='preset'&&p.id===route.id,href:'#/persona/preset/'+encodeURIComponent(p.id)}));
  const hint=nav('hints',{title:'动态提醒',subtitle:'所有人设共用',selected:mode==='hints',href:'#/persona/hints'});
  if(hint.parentNode!==sidebar.footer)sidebar.footer.append(hint);
  const nodes=[sidebar.header,...own,sidebar.presetHeading,...templates,sidebar.footer];
  let anchor=ws.left.firstChild;
  for(const node of nodes){if(node===anchor)anchor=anchor.nextSibling;else ws.left.insertBefore(node,anchor);}
  for(const child of [...ws.left.children])if(!nodes.includes(child))child.remove();
  for(const [key,node] of sidebar.nodes)if(!wanted.includes(node)){node.remove();sidebar.nodes.delete(key);}
 }
 function menu(){const d=h('details',{class:'ws-menu'},h('summary',{class:'ws-button','aria-label':'人设操作'},'⋯'));d.append(h('div',{class:'ws-menu-popover'},button('设为使用中',activate,{disabled:item.id===library.activeId}),button('复制',()=>create('copy',{sourceId:item.id})),button('导出到本地',exportFile),button('重命名',rename),button('删除',remove,{disabled:item.id===library.activeId,class:'ws-button bad'})));return d;}
 function header(replay=false){set(ws.mainHeader,h('div',{class:'ws-heading'},replay?'回放 · '+item.name:item.name,item.id===library.activeId?badge('使用中','ok'):null),tally,h('div',{class:'ws-header-actions'},replay?button('返回配置',()=>go(item.id)):button('回放对比',()=>navigate('#/persona/p/'+encodeURIComponent(item.id)+'/replay'),{class:'ws-button ws-secondary'}),button('试聊',()=>{if(JSON.stringify(persona)!==saved)notice('试聊使用已保存版本；未保存的修改不会加入本轮。','info');onTryPersona(item.id);}),button('保存',save,{primary:true,id:'persona-save',hidden:replay}),menu()));update();}
 const DESCRIPTION={'角色定义':'你是谁、在哪儿运营、和谁聊','说话风格':'怎么说话——语言、长度、口吻、不用哪些开头','记忆与承诺':'能记住什么、不能答应什么','互动边界':'哪些话题不接、遇到挑衅和危机怎么办'};
 let selected='s:0',isEditor=false,editorReadonly=false,toc=null,editorPane=null,detailRoot=null,mobileSelect=null,rows=new Map(),groupCounts=new Map(),options=new Map(),meta=null,savedValue=null,savedObject=null,drag=null,suppressClickUntil=0,suppressClickKey=null;
 const gesture=new AbortController();
 function entries(){
  const source=item.disclosure||presets.find(p=>p.id===item.origin?.presetId)||item;
  return [...persona.sections.map((s,i)=>({key:'s:'+i,group:'始终生效',title:s.title||'未命名分区',count:s.content.length,preview:s.content,data:s,index:i,readOnly:editorReadonly})),
   ...persona.triggers.map(r=>({key:'t:'+r.id,group:'触发卡',title:r.title||'未命名卡片',count:r.condition.length+r.content.length,preview:r.condition.replace(/^对方聊到下列说法或类似意思时使用：/,''),data:r,readOnly:editorReadonly})),
   {key:'fixed',group:'只读',title:'固定规则',count:(item.fixedRules||'').length,preview:'只读 · 所有人设共用',readOnly:true},
   ...(source?.bioSuggestion?[{key:'bio',group:'只读',title:'建议简介',count:source.bioSuggestion.length,preview:'只读 · 账号披露',text:source.bioSuggestion,readOnly:true}]:[])];
 }
 function baseline(){if(savedValue!==saved){savedValue=saved;savedObject=JSON.parse(saved||'{}');}return savedObject;}
 function changed(entry){
  if(!entry.data)return false;const before=baseline();
  const value=entry.key.startsWith('s:')?before.sections?.[entry.index]:before.triggers?.find(r=>r.id===entry.data.id);
  return !value||JSON.stringify(value)!==JSON.stringify(entry.data);
 }
 function update(){
  if(!alive||!persona)return;
  if(mode==='p'&&item)drafts.set(item.id,{persona:clone(persona),revision,saved,selected});
  const n=persona.sections.reduce((n,s)=>n+s.content.length,0)+persona.triggers.reduce((n,r)=>n+r.condition.length+r.content.length,0),dirty=JSON.stringify(persona)!==saved;
  tally.textContent=(dirty?'未保存 · ':'')+n.toLocaleString()+' / 20,000';
  if(n>20000)tally.textContent+=' · 超出上限，保存前需删减';
  tally.className=dirty?'ws-unsaved':'small muted';const b=ws.mainHeader.querySelector('#persona-save');if(b)b.disabled=busy||n>20000;
  if(isEditor)refreshEditorState();
 }
 function refreshEditorState(){
  const list=entries(),entry=list.find(e=>e.key===selected);
  for(const e of list){
   const row=rows.get(e.key),dirty=changed(e),active=e.key===selected;
   if(row){row.el.classList.toggle('selected',active);row.pick.setAttribute('aria-pressed',String(active));row.pick.setAttribute('aria-label',e.title);row.pick.setAttribute('aria-description',e.count+' 字'+(dirty?'，未保存':''));row.title.textContent=e.title;row.count.textContent=e.count;row.preview.textContent=e.preview.replace(/\s+/g,' ').trim()||'（空）';row.mark.hidden=!dirty;if(row.switch){row.switch.setAttribute('aria-checked',String(!!e.data.enabled));row.switch.setAttribute('aria-label','启用触发卡 '+e.title);}}
   const option=options.get(e.key);if(option)option.textContent=e.title+' · '+e.count+' 字'+(dirty?' · 未保存':'');
  }
  for(const name of ['始终生效','触发卡'])if(groupCounts.has(name))groupCounts.get(name).textContent=list.filter(e=>e.group===name).reduce((n,e)=>n+e.count,0)+' 字';
  if(mobileSelect)mobileSelect.value=selected;
  if(meta&&entry){
   meta.title.textContent=entry.title;
   meta.info.textContent=entry.group+(entry.data&&entry.key.startsWith('t:')?' · '+(entry.data.enabled?'已启用':'已关闭'):'')+' · '+entry.count+' 字';
   const i=list.findIndex(e=>e.key===selected),prev=list[i-1],next=list[i+1];
   meta.prev.disabled=!prev;meta.prev.textContent=prev?'‹ '+prev.title:'‹';meta.prev.setAttribute('aria-label',prev?'上一项 '+prev.title:'没有上一项');
   meta.next.disabled=!next;meta.next.textContent=next?next.title+' ›':'›';meta.next.setAttribute('aria-label',next?'下一项 '+next.title:'没有下一项');
   if(meta.switch){meta.switch.setAttribute('aria-checked',String(!!entry.data.enabled));meta.switch.setAttribute('aria-label','启用触发卡 '+entry.title);}
   for(const [field,node]of meta.counts)node.textContent=(entry.data?.[field]||'').length+' 字';
  }
 }
 function selectEntry(key,{focus=false}={}){
  if(!entries().some(e=>e.key===key))return;selected=key;renderDetail();update();
  if(focus)detailRoot.querySelector('input,textarea')?.focus();
 }
 function switchFor(r){return button('',e=>{e.stopPropagation();if(editorReadonly)return;r.enabled=!r.enabled;update();},{class:'pe-switch',role:'switch','aria-label':'启用触发卡 '+(r.title||'未命名卡片'),'aria-checked':String(!!r.enabled),disabled:editorReadonly});}
 function renderDirectory(){
  rows=new Map();options=new Map();groupCounts=new Map();const list=entries();
  if(!list.some(e=>e.key===selected))selected=list[0]?.key||'fixed';
  set(toc);set(mobileSelect);
  for(const name of ['始终生效','触发卡','只读']){
   const count=h('small'),heading=h('h3',{'aria-label':name},name),head=h('div',{class:'pe-toc-group-head'},heading);
   if(name!=='只读'){groupCounts.set(name,count);head.append(count);}
   if(name==='触发卡'&&!editorReadonly)head.append(button('＋',()=>{const r={id:crypto.randomUUID(),title:'',condition:'',content:'',enabled:true,order:persona.triggers.length};persona.triggers.push(r);selected='t:'+r.id;renderDirectory();selectEntry(selected,{focus:true});},{id:'trigger-add','aria-label':'添加触发卡',class:'pe-add'}));
   const group=h('section',{class:'pe-toc-group'},head),optgroup=h('optgroup',{label:name});
   for(const e of list.filter(e=>e.group===name)){
    const title=h('b',{class:'pe-item-title'},e.title),mark=h('span',{class:'pe-unsaved',role:'img','aria-label':'未保存',hidden:true}),number=h('span',{class:'pe-item-count'},e.count),preview=h('p',{class:'pe-preview'});
    const pick=button('',event=>{if(event.detail===0||e.key!==suppressClickKey||performance.now()>=suppressClickUntil)selectEntry(e.key);},{class:'pe-item-pick','data-pe-select':e.key,'aria-label':e.title,'aria-pressed':String(e.key===selected)});
    pick.append(h('span',{class:'pe-item-name'},title,mark),number,preview);
    const row=h('div',{class:'pe-toc-item'+(e.key.startsWith('t:')?' pe-trigger-item':''),dataset:{peKey:e.key,...(e.data?.id&&e.key.startsWith('t:')?{rule:e.data.id}:{})}},pick);
    let toggle=null;
    if(e.key.startsWith('t:')){
     toggle=switchFor(e.data);row.append(toggle);
     if(!editorReadonly){row.append(button('⠿',()=>{},{class:'pe-drag-handle','aria-label':'拖动 '+e.title}));row.addEventListener('pointerdown',event=>startDrag(event,e.data.id,row));}
    }
    group.append(row);rows.set(e.key,{el:row,pick,title,count:number,preview,mark,switch:toggle});
    const option=h('option',{value:e.key});optgroup.append(option);options.set(e.key,option);
   }
   toc.append(group);mobileSelect.append(optgroup);
  }
  refreshEditorState();
 }
 function startDrag(event,id,row){
  if(editorReadonly||matchMedia('(max-width:860px)').matches||event.button!==0||event.target.closest('[role="switch"]'))return;
  if(event.pointerType==='touch'&&!event.target.closest('.pe-drag-handle'))return;
  drag={id,row,pointerId:event.pointerId,x:event.clientX,y:event.clientY,started:false,target:null};
  if(event.target.closest('.pe-drag-handle'))event.preventDefault();
 }
 function clearDrag(){if(drag){drag.row.classList.remove('is-dragging');try{drag.row.releasePointerCapture(drag.pointerId);}catch{}drag=null;}toc?.querySelectorAll('.is-drop-target').forEach(el=>el.classList.remove('is-drop-target'));}
 document.addEventListener('pointermove',event=>{
  if(!drag||event.pointerId!==drag.pointerId)return;
  if(!drag.started&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<6)return;
  if(!drag.started){drag.started=true;drag.row.classList.add('is-dragging');try{drag.row.setPointerCapture(drag.pointerId);}catch{}}
  event.preventDefault();const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.pe-toc-item[data-rule]');
  toc.querySelectorAll('.is-drop-target').forEach(el=>el.classList.remove('is-drop-target'));
  if(target&&toc.contains(target)&&target.dataset.rule!==drag.id){target.classList.add('is-drop-target');const r=target.getBoundingClientRect();drag.target={id:target.dataset.rule,after:event.clientY>r.top+r.height/2};}else drag.target=null;
 },{signal:gesture.signal,passive:false});
 document.addEventListener('pointerup',event=>{
  if(!drag||event.pointerId!==drag.pointerId)return;const current=drag,drop=current.target;clearDrag();
  if(!current.started)return;suppressClickUntil=performance.now()+300;suppressClickKey='t:'+current.id;
  if(!drop)return;const from=persona.triggers.findIndex(r=>r.id===current.id),target=persona.triggers.findIndex(r=>r.id===drop.id);if(from<0||target<0)return;
  let at=target+(drop.after?1:0);const [r]=persona.triggers.splice(from,1);if(from<at)at--;persona.triggers.splice(at,0,r);renumber();renderDirectory();renderDetail();update();
 },{signal:gesture.signal});
 document.addEventListener('pointercancel',clearDrag,{signal:gesture.signal});
 function renumber(){persona.triggers.forEach((r,i)=>r.order=i);}
 function move(i,d){const target=i+d;if(target<0||target>=persona.triggers.length)return;[persona.triggers[i],persona.triggers[target]]=[persona.triggers[target],persona.triggers[i]];renumber();renderDirectory();renderDetail();update();detailRoot.querySelector('[aria-label="触发卡操作"]')?.focus();}
 function removeCard(r){const index=persona.triggers.findIndex(x=>x.id===r.id);if(index<0)return;persona.triggers.splice(index,1);renumber();selected=persona.triggers[index]?'t:'+persona.triggers[index].id:persona.triggers[index-1]?'t:'+persona.triggers[index-1].id:'s:'+Math.max(0,persona.sections.length-1);renderDirectory();renderDetail();update();}
 function readonlyText(text,attrs={}){return h('div',{class:'pe-readonly',tabindex:0,...attrs},text);}
 function renderDetail(){
  const list=entries(),entry=list.find(e=>e.key===selected)||list[0];if(!entry)return;
  selected=entry.key;
  const title=h('b'),info=h('span',{class:'pe-entry-info'}),prev=button('‹',()=>{const all=entries(),i=all.findIndex(e=>e.key===selected);if(i>0)selectEntry(all[i-1].key);},{class:'ws-button pe-neighbor'}),next=button('›',()=>{const all=entries(),i=all.findIndex(e=>e.key===selected);if(i<all.length-1)selectEntry(all[i+1].key);},{class:'ws-button pe-neighbor'});
  const head=h('header',{class:'pe-header'}),fields=h('div',{class:'pe-fields'}),counts=new Map();meta={title,info,prev,next,counts};
  if(entry.key.startsWith('t:')){meta.switch=switchFor(entry.data);head.append(meta.switch);}
  head.append(title);if(entry.readOnly)head.append(h('span',{class:'pe-ro-tag'},'只读'));head.append(info,h('div',{class:'pe-neighbors'},prev,next));
  if(entry.key.startsWith('t:')&&!entry.readOnly){
   const index=persona.triggers.findIndex(r=>r.id===entry.data.id),menu=h('details',{class:'ws-menu pe-menu'},h('summary',{class:'ws-button','aria-label':'触发卡操作'},'⋯'));
   menu.append(h('div',{class:'ws-menu-popover'},button('上移',()=>{menu.open=false;move(index,-1);},{disabled:index===0}),button('下移',()=>{menu.open=false;move(index,1);},{disabled:index===persona.triggers.length-1}),button('删除卡片',()=>removeCard(entry.data),{class:'ws-button bad'})));head.append(menu);
  }
  let description='';
  if(entry.key.startsWith('s:')){
   description=DESCRIPTION[entry.data.title]||'';
   fields.append(h('div',{class:'pe-field pe-grow'},entry.readOnly?readonlyText(entry.data.content,{id:'persona-section-'+entry.index,'aria-label':entry.title}):h('textarea',{class:'input pe-fill-input',id:'persona-section-'+entry.index,'aria-label':entry.title,value:entry.data.content,oninput:e=>{entry.data.content=e.target.value;update();}})));
  }else if(entry.key.startsWith('t:')){
   description='对方说到哪些话时，模型额外读一段什么说明';
   for(const [key,label,hint]of [['title','卡名','目录里显示的名称，模型也会看到'],['condition','什么时候用','一句话说明在什么情况下用这张卡'],['content','内容','']]){
    const count=h('small'),field=h('section',{class:'pe-field'+(key==='content'?' pe-grow':'')},h('div',{class:'pe-field-head'},h('b',{},label),hint?h('span',{},hint):null,count));counts.set(key,count);
    if(entry.readOnly)field.append(readonlyText(entry.data[key],{'aria-label':label}));
    else{
     let input;const grow=()=>{if(key!=='condition')return;input.style.height='auto';const css=getComputedStyle(input);input.style.height=Math.min(input.scrollHeight,parseFloat(css.lineHeight)*8+parseFloat(css.paddingTop)+parseFloat(css.paddingBottom)+2)+'px';};
     input=h(key==='title'?'input':'textarea',{class:'input'+(key==='content'?' pe-fill-input':key==='condition'?' pe-condition':''),'aria-label':label,rows:key==='condition'?2:undefined,value:entry.data[key],oninput:e=>{entry.data[key]=e.target.value;grow();update();}});field.append(input);
     if(key==='condition')requestAnimationFrame(()=>{if(alive&&input.isConnected)grow();});
    }
    fields.append(field);
   }
  }else if(entry.key==='fixed'){
   description='系统规则，每次回复都会带上；这里只能看，不能改';fields.append(readonlyText(item.fixedRules||'',{id:'fixed-rules','aria-label':'固定规则'}));
  }else{
   description='修改账号名称与简介需要管理员在 X 上操作';const text=readonlyText(entry.text,{'aria-label':'建议简介'}),status=h('span',{class:'small muted',role:'status'});
   fields.append(text,h('div',{class:'pe-copy-row'},button('复制建议简介',async()=>{
    try{await navigator.clipboard.writeText(entry.text);if(alive&&text.isConnected)status.textContent='已复制';}
    catch{if(!alive||!text.isConnected)return;text.focus();const range=document.createRange();range.selectNodeContents(text);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);status.textContent='已选中，请手动复制。';}
   }),status));
  }
  set(detailRoot,head,description?h('p',{class:'pe-description'},description):null,fields);refreshEditorState();
 }
 function editor(readOnly=false){
  editorReadonly=readOnly;isEditor=true;content.className='pe-content';ws.main.classList.add('pe-host');
  toc=h('nav',{class:'pe-toc','aria-label':'人设段落目录'});mobileSelect=h('select',{class:'input pe-select','aria-label':'选择人设段落',onchange:()=>selectEntry(mobileSelect.value)});detailRoot=h('div',{class:'pe-detail'});
  editorPane=h('section',{class:'pe-editor'},h('div',{class:'pe-mobile-controls'},mobileSelect),detailRoot);set(content,toc,editorPane);renderDirectory();renderDetail();update();
 }
 async function save(){await action(async()=>{const snapshot=clone(persona);const d=await api(BASE+'/'+encodeURIComponent(item.id),{method:'PUT',body:{revision,persona:snapshot}});if(!alive)return;item=d.item;revision=item.revision;saved=JSON.stringify(item.persona||snapshot);if(JSON.stringify(persona)===JSON.stringify(snapshot)){persona=clone(item.persona||snapshot);renderDirectory();renderDetail();}library=await onLibraryChanged(false)||library;notice('人设已保存'+(item.id===library.activeId?'，下一轮生效':''),'ok');update();});update();}
 async function activate(){if(!confirm('将「'+item.name+'」设为使用中？下一轮生效，当前业务状态不变，今日日程不会自动改变。'))return;await action(async()=>{const d=await api(BASE+'/'+encodeURIComponent(item.id)+'/activate',{method:'POST',body:{libraryRevision:library.libraryRevision}});set(reminder);library.activeId=d.activeId;library.libraryRevision=d.libraryRevision;library=await onLibraryChanged(false)||library;renderLeft();header();const disclosure=d.disclosure;if(disclosure&&disclosure.requiresDisclosure!==false&&disclosure.presetId!=='default'){const close=button('关闭',()=>set(reminder));set(reminder,h('aside',{class:'callout warn stack',role:'status'},h('div',{class:'toolbar'},h('b',{class:'grow'},'恢复业务前，请修改 X 账号名称和简介'),close),h('p',{},'建议包含“非官方”和“AI 自动回复”，并在合规检查披露词中加入“非官方”。系统不会自动修改。'),h('div',{class:'pre-wrap'},disclosure.bioSuggestion||disclosure.bio||''),h('a',{href:'#/settings/health'},'前往健康与披露设置 →')));}else notice('已设为使用中，下一轮生效；今日日程不会自动改变。','ok');});}
 async function exportFile(){
  if(JSON.stringify(persona)!==saved){notice('请先保存人设，再导出已保存版本','error');return;}
  await action(async()=>{const document=await api(BASE+'/'+encodeURIComponent(item.id)+'/export');if(!alive)return;const url=URL.createObjectURL(new Blob([JSON.stringify(document,null,2)+'\n'],{type:'application/json;charset=utf-8'})),link=h('a',{href:url,download:item.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')+'.persona.json'});documentDownload(link);setTimeout(()=>URL.revokeObjectURL(url),1000);notice('人设文件已交给浏览器下载','ok');});
 }
 function documentDownload(link){document.body.append(link);link.click();link.remove();}
 function importFile(){
  const input=h('input',{type:'file',accept:'.json,application/json','aria-label':'选择人设文件'});
  input.onchange=()=>action(async()=>{const file=input.files?.[0];if(!file)return;if(file.size>120*1024)throw new Error('人设文件不能超过 120 KB');let document;try{document=JSON.parse(await file.text());}catch{throw new Error('文件不是有效的 JSON');}
   if(document?.format!=='role-workflow-persona'||![1,2].includes(document.version)||typeof document.name!=='string'||!document.persona)throw new Error('请选择本系统导出的人设 JSON 文件（版本 1 或 2）');
   const name=prompt('导入为新的人设（1–40 字，库内唯一；不会自动启用）',document.name);if(name===null||!alive)return;
   const result=await api(BASE+'/import',{method:'POST',body:{document,name}});if(!alive)return;await onLibraryChanged();go(result.item.id);notice('人设已导入，尚未启用','ok');
  });input.click();
 }
 async function rename(){const name=prompt('人设名称（1–40 字，库内唯一）',item.name);if(name===null)return;await action(async()=>{const d=await api(BASE+'/'+encodeURIComponent(item.id),{method:'PUT',body:{revision,name}});item=d.item;revision=item.revision;library=await onLibraryChanged(false)||library;renderLeft();header();});}
 async function remove(){if(item.id===library.activeId)return;if(!confirm('删除「'+item.name+'」？回放记录仍保留。'))return;await action(async()=>{await api(BASE+'/'+encodeURIComponent(item.id),{method:'DELETE',body:{revision}});persona=null;await onLibraryChanged();navigate('#/persona');});}
 async function loadHints(){set(ws.mainHeader,h('h2',{},'动态提醒'),badge('所有人设共用'));const d=await api('/api/persona/prompt-hints');if(!alive)return;hints=clone(d.promptHints);hintsSaved=JSON.stringify(hints);hintRevision=d.revision;const b=button('保存提醒',async()=>{const snapshot=clone(hints);b.disabled=true;try{const d=await api('/api/persona/prompt-hints',{method:'PUT',body:{revision:hintRevision,promptHints:snapshot}});hintRevision=d.revision;hintsSaved=JSON.stringify(snapshot);notice('动态提醒已保存，下一轮生效','ok');}catch(e){notice(e.message,'error');}finally{b.disabled=false;}},{primary:true});ws.mainHeader.append(b);set(content,h('p',{class:'muted'},'这些提醒由所有人设共用，不属于当前人设。'),card('提醒开关',h('div',{class:'ws-grid-two'},[['lateEnabled','迟到提醒'],['languageEnabled','跟随对方语言'],['expressionEnabled','表情节制'],['replyCheckEnabled','生成前自检']].map(([k,l])=>h('label',{class:'check'},h('input',{type:'checkbox',checked:!!hints[k],onchange:e=>hints[k]=e.target.checked}),l)))),card('提醒阈值',h('div',{class:'ws-grid-two'},[['lateMinutes','迟到阈值（分钟）',30,360],['kaomojiPer10','每10条颜文字次数',0,10],['emojiPer10','每10条 emoji 次数',0,10],['tildePer10','每10条波浪号次数',0,10]].map(([k,l,min,max])=>field(l,h('input',{class:'input',type:'number',min,max,value:hints[k],oninput:e=>hints[k]=Number(e.target.value)}))))));}
 async function load(){isEditor=false;content.className='ws-stack';ws.main.classList.remove('pe-host');set(content,stateMessage('正在读取人设…'));try{const catalog=await api('/api/persona/presets');if(!alive)return;presets=catalog.items||[];renderLeft();if(mode==='hints'){await loadHints();return;}if(mode==='preset'){item=presets.find(p=>p.id===route.id);if(item)item={...item,fixedRules:catalog.fixedRules||''};if(!item)throw new Error('预设不存在');persona=clone(item.persona);saved=JSON.stringify(persona);set(ws.mainHeader,h('h2',{class:'grow'},item.name),badge('只读模板'),item.summary?h('span',{class:'pe-preset-summary',title:item.summary},item.summary):null,button('以此新建',()=>create('preset',{presetId:item.id}),{primary:true,id:'persona-preset-create'}));editor(true);return;}const id=route.id||library.activeId;if(!library.items.some(p=>p.id===id)){set(ws.mainHeader,h('h2',{},'人设不可用'));set(content,stateMessage('这个人设已被删除。'),button('返回人设列表',()=>navigate('#/persona')));return;}item=await api(BASE+'/'+encodeURIComponent(id));if(!alive)return;persona=clone(item.persona);revision=item.revision;saved=JSON.stringify(persona);const cached=drafts.get(item.id);if(cached&&cached.revision===revision){persona=clone(cached.persona);saved=cached.saved;selected=cached.selected||'s:0';}header(route.replay);if(route.replay){set(content,h('p',{class:'muted'},'以「'+item.name+'」的人设草稿为候选，保存与采用均不切换使用中人设。'));const replay=h('div');content.append(replay);replayOff=mountReplay(replay,{getCandidate:()=>({persona:clone(persona),personaRevision:revision,personaId:item.id}),onAdopt:async()=>{await onLibraryChanged();go(item.id);}});}else editor();}catch(e){if(alive)errorBox(content,e,load);}}
 load();return()=>{alive=false;clearDrag();gesture.abort();ws.main.classList.remove('pe-host');replayOff?.();setDirty(()=>false);};
}
