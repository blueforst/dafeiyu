// Router and top bar.
import { start, onStatus, runControl, isPending, notice } from './state.js';

const STATE_LABEL = { paused: '已暂停', running: '处理中', draining: '等待当前操作结束', manual: '人工接管中' };
const PRIMARY = {
  paused: { action: 'resume', label: '恢复处理' },
  running: { action: 'pause', label: '暂停' },
  draining: { action: null, label: '等待当前操作结束…' },
  manual: { action: 'release', label: '释放接管' },
};
const ROUTES = {
  overview: () => import('./views/overview.js'),
  model: () => import('./views/model.js'),
  browser: () => import('./views/browser.js'),
};

const pill = document.getElementById('status-pill');
const primary = document.getElementById('primary-action');
const view = document.getElementById('view');

onStatus(s => {
  const control = s?.control;
  pill.dataset.state = s ? control : 'error';
  pill.textContent = s ? (STATE_LABEL[control] ?? control) : '连接失败';
  // "draining" with an idle backend means a pause/takeover failed half-way; offer a retry instead of a dead button.
  const p = control === 'draining' && !s?.busy && !isPending() ? { action: 'pause', label: '重试暂停' } : PRIMARY[control] ?? { action: null, label: '…' };
  primary.textContent = p.label;
  primary.dataset.action = p.action ?? '';
  primary.disabled = !s || !p.action || isPending();
});

primary.addEventListener('click', () => {
  const action = primary.dataset.action;
  if (action) runControl(action);
});

let current = { route: '', unmount: null };
let leaveGuard = null;
const ctx = { setLeaveGuard(fn) { leaveGuard = fn; } };

function routeFromHash() {
  const r = location.hash.replace(/^#\/?/, '');
  return ROUTES[r] ? r : 'overview';
}

async function show(route) {
  if (current.route === route) return;
  current.unmount?.();
  current = { route, unmount: null };
  leaveGuard = null;
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.route === route);
  view.replaceChildren();
  try {
    const mod = await ROUTES[route]();
    if (current.route !== route) return;
    current.unmount = mod.mount(view, ctx) ?? null;
  } catch (e) {
    notice('页面加载失败：' + e.message, 'error');
  }
}

window.addEventListener('hashchange', async () => {
  const target = routeFromHash();
  if (target === current.route) return;
  if (leaveGuard && !(await leaveGuard())) {
    history.replaceState(null, '', '#/' + current.route);
    return;
  }
  show(target);
});

if (!location.hash) history.replaceState(null, '', '#/overview');
start();
show(routeFromHash());
