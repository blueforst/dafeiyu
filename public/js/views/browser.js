// 浏览器页按需连接，接管与释放都在本分区完成。
import { h, set } from '../dom.js';
import { onStatus, runControl, isPending, getStatus } from '../state.js';

const DESKTOP_URL = '/desktop/vnc.html?autoconnect=1&resize=scale&reconnect=0&path=desktop/websockify';

export function mount(root) {
  let frame = null;
  let control = getStatus()?.control;
  let statusKnown = !!getStatus();

  const connectBtn = h('button', { id: 'connect', class: 'btn primary', type: 'button' }, '接管并连接');
  const newTab = h('a', { id: 'open-new-tab', class: 'btn', href: DESKTOP_URL, target: '_blank', rel: 'noopener' }, '新标签页打开');
  const releaseBtn = h('button', { id: 'release', class: 'btn', type: 'button', onclick: () => runControl('release') }, '释放接管');

  const idle = h('div', { class: 'card desk-idle' });
  const desktopActions = h('span', { class: 'desk-actions' }, newTab, releaseBtn);
  const bar = h('div', { class: 'desk-bar' },
    h('span', { class: 'pill', dataset: { state: 'manual' } }, '人工接管中 · 自动处理已停止'),
    desktopActions);
  const frameBox = h('div', { class: 'desk-frame' });
  const connected = h('div', { class: 'desk' }, bar, frameBox);
  set(root, idle, connected);

  function unmountFrame() {
    if (!frame) return;
    frame.src = 'about:blank';
    frame.remove();
    frame = null;
  }
  function mountFrame() {
    if (frame) return;
    frame = h('iframe', { id: 'desktop-frame', src: DESKTOP_URL, title: '浏览器桌面', allow: 'clipboard-read; clipboard-write' });
    frameBox.append(frame);
  }

  function render() {
    const manual = control === 'manual';
    if (!manual) unmountFrame();
    connected.hidden = !frame;
    idle.hidden = !!frame;
    const busy = isPending();
    connectBtn.disabled = busy || !statusKnown || !control || control === 'draining';
    releaseBtn.disabled = busy || !statusKnown || !manual;
    if (frame) {
      if (newTab.parentNode !== desktopActions) desktopActions.append(newTab, releaseBtn);
      return;
    }
    if (manual) {
      connectBtn.textContent = '连接桌面';
      set(idle,
        h('div', { class: 'desk-icon', 'aria-hidden': 'true' }),
        h('h2', {}, '人工接管中'),
        h('p', { class: 'muted' }, '自动处理已停止。连接桌面后可以登录 X、过验证码、解锁私信。'),
        h('div', { class: 'desk-actions center' }, connectBtn, newTab, releaseBtn));
    } else {
      connectBtn.textContent = '接管并连接';
      set(idle,
        h('div', { class: 'desk-icon', 'aria-hidden': 'true' }),
        h('h2', {}, control === 'draining' ? '正在等待当前操作结束' : '浏览器未连接'),
        h('p', { class: 'muted' }, control === 'draining' ? '当前操作结束后才能连接浏览器桌面。' : '接管会先等当前操作结束、停止自动处理，之后才能在这里操作浏览器，比如登录 X、过验证码。平时不连接，不影响自动处理。'),
        h('div', { class: 'desk-actions center' }, connectBtn));
    }
  }

  connectBtn.addEventListener('click', async () => {
    if (control !== 'manual') {
      const ok = await runControl('takeover');
      if (!ok || getStatus()?.control !== 'manual') return;
    }
    mountFrame();
    render();
  });

  // A failed status poll (null) must not drop a live desktop session; the backend still guards /desktop.
  const off = onStatus(s => { statusKnown = !!s; if (s) control = s.control; render(); });
  render();
  return () => { off(); unmountFrame(); };
}
