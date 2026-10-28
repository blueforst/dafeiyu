import { h, set } from './dom.js';

let serial = 0;
const stored = (key, value) => { try { if (value === undefined) return localStorage.getItem(key) === '1'; localStorage.setItem(key, value ? '1' : '0'); } catch { return false; } };

/** 工作区内容容器不包含页头；dispose 负责还原全局布局并移除监听。 */
export function mountWorkspace(root, { page, left, main, right } = {}) {
  const uid = 'ws-' + (++serial), narrow = matchMedia('(max-width: 860px)');
  let disposed = false, hasRight = right !== undefined && right !== false, focusBack = null;
  const closed = { left: stored(`ws:${page}:left`), right: stored(`ws:${page}:right`) };
  const mobile = { left: false, right: false };
  const mask = h('button', { class: 'ws-mask', type: 'button', 'aria-label': '关闭侧栏', hidden: true });
  const pane = (side, content) => {
    const header = h('div', { class: 'ws-header-content' }), tools = h('div', { class: 'ws-header-tools' });
    const body = h('div', { class: 'ws-content', id: `${uid}-${side}-body` });
    if (content instanceof Node) body.append(content);
    else if (typeof content === 'string') body.append(content);
    const el = h('section', { class: `ws-pane ws-${side}`, id: `${uid}-${side}`, 'aria-label': {left:'左栏',main:'主区',right:'详情'}[side] }, h('header', { class: 'ws-header' }, header, tools), body);
    return { el, header, tools, body };
  };
  const l = pane('left', left), m = pane('main', main), r = pane('right', right);
  const el = h('div', { class: 'ws-shell', dataset: { page } }, mask, l.el, m.el, r.el);
  const toggle = (side, holder) => { const b = h('button', { class:'ws-icon-button',type:'button','aria-controls':`${uid}-${side}`,onclick:()=>collapse(side,!isCollapsed(side)) }, side==='left'?'☰':'▥');holder.append(b);return b; };
  const leftClose = toggle('left',l.tools), leftOpen = toggle('left',m.tools), rightToggle = toggle('right',m.tools), rightClose = toggle('right',r.tools);
  const isCollapsed = side => narrow.matches ? !mobile[side] : closed[side];
  function render() {
    for (const side of ['left','right']) {
      const hidden = side === 'right' && !hasRight || isCollapsed(side);
      el.classList.toggle(`ws-${side}-closed`, hidden);
      const p = side==='left'?l:r;
      p.el.hidden = hidden;
      p.el.setAttribute('aria-hidden',String(hidden));
      for (const b of side==='left'?[leftClose,leftOpen]:[rightToggle,rightClose]) {
        b.setAttribute('aria-expanded',String(!hidden));
        b.setAttribute('aria-label',(hidden?'展开':'收起')+(side==='left'?'左栏':'右栏'));
        b.title=b.getAttribute('aria-label');
      }
    }
    leftOpen.hidden=!isCollapsed('left');
    rightToggle.hidden=!hasRight;
    rightClose.textContent=narrow.matches?'×':'▥';
    mask.hidden=!(narrow.matches&&(mobile.left||hasRight&&mobile.right));
    r.el.setAttribute('role',narrow.matches&&mobile.right?'dialog':'region');
    if(narrow.matches&&mobile.right) r.el.setAttribute('aria-modal','true');else r.el.removeAttribute('aria-modal');
  }
  function collapse(side, value) {
    if (!['left','right'].includes(side)) return;
    if (narrow.matches) { mobile[side]=!value; if(!value){mobile[side==='left'?'right':'left']=false;focusBack=document.activeElement;} }
    else { closed[side]=!!value;stored(`ws:${page}:${side}`,!!value); }
    render();
    if(narrow.matches){if(!value){const p=side==='left'?l:r;queueMicrotask(()=>p.el.querySelector('button,a,input,select,textarea,[tabindex]')?.focus());}else if(focusBack?.isConnected)focusBack.focus();}
  }
  function open(side,trigger) { if(trigger)focusBack=trigger;collapse(side,false);if(trigger)focusBack=trigger; }
  function close(side) { collapse(side,true); }
  function setRight(visible) { hasRight=!!visible;render(); }
  const closeMobile=()=>{if(mobile.right)close('right');else if(mobile.left)close('left');};
  mask.onclick=closeMobile;
  function keydown(e){if(!narrow.matches||!(mobile.right||mobile.left))return;if(e.key==='Escape'){e.preventDefault();closeMobile();return;}if(e.key==='Tab'){const p=mobile.right?r:l,items=[...p.el.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(x=>!x.hidden&&x.getClientRects().length);if(!items.length)return;const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}
  const selectLeft=e=>{if(narrow.matches&&e.target.closest('[data-ws-select],.ws-side-item,a[href]'))close('left');};
  const changed=()=>{mobile.left=false;mobile.right=false;render();};
  document.addEventListener('keydown',keydown);l.body.addEventListener('click',selectLeft);narrow.addEventListener('change',changed);
  document.body.classList.add('workspace');
  const top=document.querySelector('.topbar'),notice=document.getElementById('notice');
  const resize=()=>{if(!disposed)document.documentElement.style.setProperty('--ws-top-height',(top?.getBoundingClientRect().height||57)+'px');};
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;observer?.observe(top||document.body);resize();
  set(root,el);render();
  return { el,left:l.body,main:m.body,right:r.body,leftHeader:l.header,mainHeader:m.header,rightHeader:r.header,leftPane:l.el,mainPane:m.el,rightPane:r.el,leftTools:l.tools,mainTools:m.tools,rightTools:r.tools,setRight,collapse,open,close,isCollapsed,
    dispose(){if(disposed)return;disposed=true;document.removeEventListener('keydown',keydown);l.body.removeEventListener('click',selectLeft);narrow.removeEventListener('change',changed);observer?.disconnect();document.body.classList.remove('workspace');document.documentElement.style.removeProperty('--ws-top-height');el.remove();} };
}

export function sideItem({ title, subtitle, meta, selected=false, badge:label, icon, onclick, href, ...attrs }={}) {
  return h(href?'a':'button',{class:'ws-side-item'+(selected?' selected':''),type:href?undefined:'button',href,'aria-current':selected?'true':undefined,'data-ws-select':'1',onclick,...attrs},icon?h('span',{class:'ws-avatar'},icon):null,h('span',{class:'ws-side-copy'},h('span',{class:'ws-side-title'},title),subtitle?h('span',{class:'ws-side-subtitle'},subtitle):null),label?badge(label):null,meta?h('span',{class:'ws-side-meta'},meta):null);
}
export function segmented(items, value, onChange, label='切换视图') { return h('div',{class:'ws-segmented',role:'tablist','aria-label':label},items.map(item=>{const [id,title]=Array.isArray(item)?item:[item.value,item.label];return h('button',{type:'button',role:'tab','aria-selected':String(value===id),class:value===id?'selected':'',onclick:()=>onChange(id)},title);})); }
export function badge(text,kind='') { return h('span',{class:'ws-badge '+kind},text); }
export function chip(text,kind='') { return h('span',{class:'ws-chip '+kind},text); }
export function button(text,onclick,{primary=false,...attrs}={}) { return h('button',{class:'ws-button'+(primary?' primary':''),type:'button',onclick,...attrs},text); }
export function card(title,...children) { return h('section',{class:'ws-card'},title?h('h3',{},title):null,...children); }
export function input(attrs={}) { return h('input',{class:'ws-input',...attrs}); }
export function composer({input:control,controls,footer,onsubmit}={}) { return h('form',{class:'ws-composer',onsubmit:e=>{e.preventDefault();onsubmit?.(e);}},controls?h('div',{class:'ws-composer-controls'},controls):null,control,footer?h('div',{class:'ws-composer-footer'},footer):null); }
export function turn({role='assistant',text,summary,footer,kind='',selected=false,onclick,children,interactive=false,...attrs}={}) { return h('article',{class:`ws-turn ws-turn-${role} ${kind}${selected?' selected':''}`,onclick,role:interactive?'button':undefined,...attrs},summary?h('div',{class:'ws-turn-summary'},summary):null,text!==undefined?h('div',{class:role==='user'?'ws-bubble':'ws-turn-text'},text):null,children,footer?h('div',{class:'ws-turn-footer'},footer):null); }
export function stateMessage(text,{error=false,retry}={}) { return h('div',{class:'ws-state'+(error?' bad':''),role:error?'alert':'status'},h('p',{},text),retry?button('重试',retry):null); }
