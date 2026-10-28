import {h,set} from '../dom.js';
import {api} from '../api.js';
import {empty,errorBox} from '../view-utils.js';

const IDS=['default','deepseek','gpt','claude','kimi','glm'];
const clone=value=>structuredClone(value);

/** 预设来源和撤销仅存在于本次编辑器挂载，不写进 persona 或设置。 */
export function mount(root,{getPersona,replacePersona,onStateChange,reminderRoot=root}){
 let alive=true,loaded=false,loading=false,items=[],selected='default',pending=null,copyGeneration=0,nextId=0;
 let draft={id:0,origin:null,pendingFill:false},undo=null;
 const choices=h('fieldset',{class:'persona-presets-choices'},h('legend',{class:'sr-only'},'选择人设预设'));
 const bio=h('div'),confirmation=h('div'),feedback=h('div',{class:'small',role:'status','aria-live':'polite'}),reminder=h('div',{id:'persona-preset-reminder'});
 const fill=h('button',{id:'persona-preset-fill',class:'btn',type:'button',onclick:requestFill},'填入编辑框');
 const undoButton=h('button',{id:'persona-preset-undo',class:'btn',type:'button',hidden:true,onclick:restore},'撤销填入');
 const body=h('div',{class:'settings-body stack'},empty('展开后读取内置预设。'));
 const box=h('details',{class:'card persona-presets',id:'persona-presets'},h('summary',{},'从预设开始'),body);
 set(root,box);reminderRoot.append(reminder);
 function current(){return items.find(item=>item.id===selected);}
 function changed(){undoButton.hidden=!undo;onStateChange?.();}
 function origin(item){return {id:item.id,name:item.name,bioSuggestion:item.bioSuggestion};}
 function valid(data){return Number.isSafeInteger(data?.version)&&data.version>0&&Array.isArray(data.items)&&data.items.length===IDS.length&&data.items.every((item,i)=>item?.id===IDS[i]&&typeof item.name==='string'&&typeof item.summary==='string'&&typeof item.bioSuggestion==='string'&&Array.isArray(item.persona?.sections)&&Array.isArray(item.persona?.triggers));}
 async function load(){
  if(loading)return;loading=true;set(body,empty('正在读取内置预设…'));
  try{const data=await api('/api/persona/presets');if(!alive)return;if(!valid(data))throw new Error('预设格式暂不支持，请重新读取');items=clone(data.items);loaded=true;render();}
  catch(error){if(alive)errorBox(body,error,load);}
  finally{loading=false;}
 }
 function render(){
  set(choices,h('legend',{class:'sr-only'},'选择人设预设'),items.map(item=>h('label',{class:'persona-preset-option'},h('input',{type:'radio',name:'persona-preset',value:item.id,checked:item.id===selected,onchange:()=>{
   selected=item.id;pending=null;copyGeneration++;feedback.textContent='';set(confirmation);renderBio();
  }}),h('span',{class:'stack'},h('strong',{},item.name),h('span',{class:'small muted'},item.summary)))));
  set(body,h('p',{class:'small muted'},'选一个起点，再按自己的想法修改。填入后可以先试聊或回放对比，保存后下一轮生效。'),choices,bio,h('div',{class:'toolbar'},fill,undoButton),confirmation,feedback);renderBio();changed();
 }
 function renderBio(){
  const item=current();if(!item||item.id==='default'){set(bio);return;}
  const text=h('textarea',{class:'input persona-preset-bio',id:'persona-preset-bio',rows:2,readonly:true,'aria-label':'建议简介',value:item.bioSuggestion});
  const status=h('div',{class:'small muted',role:'status'});
  const copy=h('button',{class:'btn small',id:'persona-preset-copy',type:'button',onclick:async()=>{
   const generation=++copyGeneration,value=item.bioSuggestion;copy.disabled=true;
   try{if(!navigator.clipboard?.writeText)throw new Error('剪贴板不可用');await navigator.clipboard.writeText(value);if(alive&&generation===copyGeneration)status.textContent='建议简介已复制。';}
   catch{if(alive&&generation===copyGeneration){text.focus();text.select();status.textContent='自动复制失败，已选中建议简介，请手动复制。';}}
   finally{copy.disabled=false;}
  }},'复制');
  set(bio,h('div',{class:'subcard stack'},h('div',{class:'toolbar'},h('b',{class:'grow'},'建议简介'),copy),text,status));
 }
 function requestFill(){
  const item=current();if(!item)return;pending=clone(item);
  set(confirmation,h('div',{class:'confirm stack',role:'alert'},h('span',{},'将替换当前全部分区和触发规则，尚未保存的修改会丢失。预设：'+item.name),h('div',{class:'toolbar'},h('button',{id:'persona-preset-confirm',class:'btn primary',type:'button',onclick:apply},'确认替换'),h('button',{class:'btn',type:'button',onclick:()=>{pending=null;set(confirmation);fill.focus();}},'取消'))));
 }
 function apply(){
  if(!pending)return;const item=pending;pending=null;
  undo={persona:clone(getPersona()),state:clone(draft)};
  draft={id:++nextId,origin:origin(item),pendingFill:true};replacePersona(clone(item.persona));set(confirmation);feedback.textContent='已填入「'+item.name+'」，尚未保存。可以先试聊或回放对比，再保存。';changed();
 }
 function restore(){
  if(!undo)return;const before=undo;undo=null;draft=clone(before.state);replacePersona(clone(before.persona));pending=null;set(confirmation);feedback.textContent='已撤销填入，恢复填入前的编辑内容。';changed();
 }
 function showReminder(source){
  const close=h('button',{class:'btn small',type:'button','aria-label':'关闭保存提示',onclick:()=>set(reminder)},'关闭');
  set(reminder,h('aside',{class:'callout persona-preset-saved stack',role:'status'},h('div',{class:'toolbar'},h('strong',{class:'grow'},'已保存来自「'+source.name+'」的人设'),close),h('p',{},'今日日程不会自动改变。需要时可到“今日日程”手动重新生成，会产生模型费用。'),source.id==='default'?null:h('div',{class:'stack'},h('p',{},'恢复业务前，请先把 X 账号名称和简介改为包含“非官方”“AI 自动回复”的写法，名称不要只写角色名。'),h('div',{class:'pre-wrap'},'建议简介：'+source.bioSuggestion),h('p',{},'建议在设置的合规检查披露词中加入“非官方”。'),h('a',{href:'#/settings/health'},'到设置 →'))));
 }
 box.addEventListener('toggle',()=>{if(box.open&&!loaded)load();});
 return {
  isDirty:()=>draft.pendingFill,
  captureSave:()=>({...clone(draft),personaJSON:JSON.stringify(getPersona())}),
  saved(token,normalized){
   if(!alive||!token)return;
   if(draft.id===token.id){draft.pendingFill=false;undo=null;feedback.textContent='人设已保存，下一轮生效。';}
   else if(undo?.state.id===token.id){undo.state.pendingFill=false;if(JSON.stringify(undo.persona)===token.personaJSON)undo.persona=clone(normalized);}
   if(token.origin)showReminder(token.origin);changed();
  },
  dispose(){alive=false;undo=null;pending=null;copyGeneration++;set(reminder);}
 };
}
