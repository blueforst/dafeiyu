// 桌面连接只在明确点击后建立；设置项切换由工作区保留此模块。
import {h,set} from '../dom.js';
import {onStatus,runControl,isPending,getStatus} from '../state.js';
const DESKTOP_URL='/desktop/vnc.html?autoconnect=1&resize=scale&reconnect=0&path=desktop/websockify';
export function mount(root,ctx={}){
  let frame=null,status=getStatus(),control=status?.control,statusKnown=!!status;
  const connect=h('button',{id:'connect',class:'btn primary',type:'button'},'接管并连接');
  const release=h('button',{id:'release',class:'btn small',type:'button','aria-label':'释放接管',onclick:()=>runControl('release')},'释放');
  const newTab=h('a',{id:'open-new-tab',class:'btn small',href:DESKTOP_URL,target:'_blank',rel:'noopener'},'新标签页打开');
  const statusBox=h('div',{class:'browser-acct-bar'});
  const idle=h('div',{class:'desk-placeholder desk-idle'});
  const frameBox=h('div',{class:'desk-frame'});
  const bar=h('div',{class:'desk-bar'},h('span',{class:'pill',dataset:{state:'manual'}},'人工接管中 · 自动处理已停止'),h('span',{class:'desk-actions'},newTab));
  const connected=h('div',{class:'desk'},bar,frameBox);
  const page=h('div',{class:'settings-browser'},statusBox,idle,connected);
  set(root,page);
  if(ctx.setActions)ctx.setActions(release);
  function unmountFrame(){if(!frame)return;frame.src='about:blank';frame.remove();frame=null;}
  function render(){
    const manual=control==='manual',browser=status?.browser||status?.identity||{};
    if(!manual)unmountFrame();
    connected.hidden=!frame;
    idle.hidden=!!frame;
    connect.disabled=isPending()||!statusKnown||!control||control==='draining';
    release.disabled=isPending()||!statusKnown||!manual;
    connect.hidden=!!frame;
    release.hidden=!manual;
    connect.textContent=manual?'连接桌面':'接管并连接';
    set(statusBox,
      h('span',{class:'settings-state-dot '+(browser.loggedIn?'normal':'attention')}),
      h('b',{},browser.handle?'@'+browser.handle:status?.accountId?'@'+status.accountId:'账号未确认'),
      h('span',{class:'muted'},browser.loggedIn?'已登录':browser.needsHuman?'需要登录或人工处理':'登录状态待确认'),
      h('span',{class:'ws-badge '+(manual?'blue':'')},manual?'人工接管中':'未接管'),
      h('span',{class:'sp'}),
      h('a',{href:'#/settings/health',class:'small'},'账号检查与需要处理的设置 →')
    );
    if(!frame){
      set(idle,
        h('div',{class:'desk-placeholder-inner'},
          h('h3',{},manual?'人工接管中':control==='draining'?'正在等待当前操作结束':'浏览器未连接'),
          h('p',{class:'muted'},manual?'连接桌面后可以登录 X、过验证码、解锁私信。':'接管会等待当前操作结束并停止自动处理；释放后保持暂停。'),
          h('div',{class:'desk-actions center'},connect,!ctx.setActions&&manual?release:null)
        )
      );
    }
  }
  connect.addEventListener('click',async()=>{
    if(control!=='manual'){
      const ok=await runControl('takeover');
      if(!ok||getStatus()?.control!=='manual')return;
    }
    if(!frame){
      frame=h('iframe',{id:'desktop-frame',src:DESKTOP_URL,title:'浏览器桌面',allow:'clipboard-read; clipboard-write'});
      frameBox.append(frame);
    }
    render();
  });
  const off=onStatus(s=>{statusKnown=!!s;if(s){status=s;control=s.control;}render();});
  render();
  return()=>{off();unmountFrame();};
}
