import {h,set} from '../dom.js';
let nextTip=0;
const clamp=(value,min,max)=>Math.min(Math.max(value,min),Math.max(min,max));
/** 坐标均相对 frame；矩形锚点用两侧边界翻转，指针用同一个点。 */
export function positionTooltip(frame,tip,anchor,gap=12){
 const left=anchor.x??anchor.left??0,top=anchor.y??anchor.top??0,right=anchor.x??anchor.right??left,bottom=anchor.y??anchor.bottom??top;
 let x=right+gap,y=bottom+gap;
 if(x+tip.width>frame.width)x=left-gap-tip.width;
 if(y+tip.height>frame.height)y=top-gap-tip.height;
 return{left:clamp(x,0,frame.width-tip.width),top:clamp(y,0,frame.height-tip.height)};
}
export function createTooltip(frame){
 const element=h('div',{class:'chart-tip',id:'chart-tip-'+(++nextTip),role:'tooltip',hidden:true});frame.append(element);
 let content=null,described=null,listening=false,destroyed=false;
 const api={element,onHide:null,show,hide,destroy};
 function outside(event){if(!frame.contains(event.target))hide();}
 function escape(event){if(event.key==='Escape')hide();}
 function listen(){if(!listening){document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);listening=true;}}
 function hide(){element.hidden=true;content=null;if(described?.getAttribute('aria-describedby')===element.id)described.removeAttribute('aria-describedby');described=null;if(listening){document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);listening=false;}api.onHide?.();}
 function show(anchor,data){
  if(destroyed||!frame.isConnected)return;
  if(data!==content){content=data;set(element,h('div',{class:'chart-tip-title'},data.title),...(data.rows||[]).map(row=>h('div',{class:'chart-tip-row'},row.color!==undefined?h('i',{class:'legend-swatch chart-bg-'+row.color,'aria-hidden':'true'}):null,h('span',{class:'chart-tip-name'},row.name),h('span',{class:'numbers'},row.value),row.unit?h('span',{class:'chart-tip-unit'},row.unit):null)),...(data.notes||[]).map(note=>h('div',{class:'chart-tip-note'},note)));}
  const bounds=frame.getBoundingClientRect();element.style.maxWidth=Math.max(0,Math.min(360,bounds.width))+'px';element.style.left='0px';element.style.top='0px';element.style.maxHeight=Math.max(32,bounds.height)+'px';element.hidden=false;
  const local='right'in anchor?{left:anchor.left-bounds.left,top:anchor.top-bounds.top,right:anchor.right-bounds.left,bottom:anchor.bottom-bounds.top}:{x:anchor.x-bounds.left,y:anchor.y-bounds.top};
  const size=element.getBoundingClientRect(),p=positionTooltip(bounds,size,local);element.style.left=p.left+'px';element.style.top=p.top+'px';
  const focused=document.activeElement;if(focused&&frame.contains(focused)&&focused!==frame){if(described&&described!==focused)described.removeAttribute('aria-describedby');described=focused;described.setAttribute('aria-describedby',element.id);}
  listen();
 }
 function destroy(){if(destroyed)return;hide();destroyed=true;element.remove();}
 return api;
}
