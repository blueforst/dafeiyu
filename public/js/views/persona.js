import {h,set} from '../dom.js';
import {api} from '../api.js';
import {notice} from '../state.js';
import {mountWorkspace,segmented,stateMessage,button} from '../shell.js';
import {mount as mountEditor} from './persona-editor.js';
import {mount as mountDaily} from './persona-daily.js';
import {mount as mountChat} from './chat-test.js';

/** 人设工作区入口；条目、模式、顶层页面共用同一未保存保护。 */
export function mount(root,ctx){
 let alive=true,library=null,off=null,dirty=()=>false,hash=location.hash,routeToken=0,pendingResolve=null,selectedPersona=null;
 const last={persona:'#/persona',daily:'#/persona/daily',chat:'#/persona/chat'},drafts=new Map();
 const ws=mountWorkspace(root,{page:'persona',right:false});const disclosureRoot=h('div',{class:'ws-disclosure-root',id:'persona-preset-reminder'});ws.mainPane.insertBefore(disclosureRoot,ws.main);
 const guard=h('div',{class:'confirm ws-leave-confirm',hidden:true,role:'alert'},h('span',{},'有未保存的修改。保留编辑，或明确放弃后离开。'),h('div',{class:'confirm-actions'},button('保留编辑',()=>answer(false)),button('放弃并离开',()=>answer(true),{class:'ws-button bad'})));
 ws.el.append(guard);
 const check=()=>{if(!dirty())return true;guard.hidden=false;guard.querySelector('button')?.focus();return new Promise(resolve=>{pendingResolve?.(false);pendingResolve=resolve;});};
 function answer(value){guard.hidden=true;pendingResolve?.(value);pendingResolve=null;}
 ctx.setLeaveGuard(check);
 const beforeUnload=e=>{if(dirty()){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
 function parse(){const raw=location.hash.replace(/^#\/persona\/?/,'').split('?')[0],parts=raw.split('/').filter(Boolean);if(parts[0]==='persona'){if(ctx.replaceRouteHash)ctx.replaceRouteHash('#/persona');else history.replaceState(null,'','#/persona');return {mode:'persona',kind:'p'};}if(parts[0]==='preview'){if(ctx.replaceRouteHash)ctx.replaceRouteHash('#/persona/chat');else history.replaceState(null,'','#/persona/chat');return {mode:'chat',kind:'chat'};}if(parts[0]==='daily')return {mode:'daily',kind:'daily',id:decode(parts[1])};if(parts[0]==='chat')return {mode:'chat',kind:'chat',id:decode(parts[1])};return {mode:'persona',kind:['p','preset','hints'].includes(parts[0])?parts[0]:'p',id:decode(parts[1]),replay:parts[2]==='replay'};}
 function decode(value){try{return value?decodeURIComponent(value):undefined;}catch{return value;}}
 function navigate(target){if(target===location.hash)return;location.hash=target;}
 async function refreshLibrary(){const next=await api('/api/personas');if(!alive)return;library=next;return library;}
 let currentRoute=null;
 async function show(force=false){const token=++routeToken,target=parse(),nextHash=location.hash;if(!force&&nextHash===hash&&off)return;const samePersona=currentRoute?.mode==='persona'&&target.mode==='persona'&&currentRoute.kind==='p'&&target.kind==='p'&&(currentRoute.id||library?.activeId)===(target.id||library?.activeId);if(off&&!samePersona){const yes=await check();if(token!==routeToken||!alive)return;if(!yes){if(ctx.replaceRouteHash)ctx.replaceRouteHash(hash);else history.replaceState(null,'',hash);return;}if(currentRoute?.id)drafts.delete(currentRoute.id);}off?.();off=null;dirty=()=>false;hash=nextHash;last[target.mode]=hash;currentRoute=target;set(ws.leftHeader,segmented([['persona','人设'],['daily','日程'],['chat','试聊']],target.mode,mode=>navigate(last[mode]),'人设工作区模式'));set(ws.mainHeader,h('h2',{},'正在读取…'));set(ws.main,stateMessage('正在读取…'));set(ws.left);set(ws.right);try{await refreshLibrary();if(!alive||token!==routeToken)return;const options={route:target,library,navigate,disclosureRoot,setDirty:fn=>{dirty=fn;},drafts,onLibraryChanged:refreshLibrary,onTryPersona:id=>{selectedPersona=id;navigate(last.chat);},selectedPersona};off=target.mode==='daily'?mountDaily(ws,options):target.mode==='chat'?mountChat(ws,options):mountEditor(ws,options);}catch(e){if(alive)set(ws.main,stateMessage(e.message,{error:true,retry:()=>show(true)}));}}
 const routeListener=e=>{if(e.detail.page==='persona')show();};window.addEventListener('panel-route',routeListener);show(true);
 return()=>{alive=false;routeToken++;off?.();answer(false);window.removeEventListener('panel-route',routeListener);window.removeEventListener('beforeunload',beforeUnload);drafts.clear();ws.dispose();};
}
