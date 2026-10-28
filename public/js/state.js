// Shared panel state: status polling, live logs (SSE), notices, and control actions.
import { api, control } from './api.js';

let status = null;
let logs = [];
let pending = false;
const statusSubs = new Set();
const logSubs = new Set();
const eventSubs = new Map();

function emitStatus() { for (const fn of statusSubs) fn(status); }

export function getStatus() { return status; }
export function isPending() { return pending; }

export function onStatus(fn) {
  statusSubs.add(fn);
  if (status) fn(status);
  return () => statusSubs.delete(fn);
}

export function onLogs(fn) {
  logSubs.add(fn);
  fn(logs);
  return () => logSubs.delete(fn);
}

export function onEvent(name, fn) {
  if (!eventSubs.has(name)) eventSubs.set(name, new Set());
  eventSubs.get(name).add(fn);
  return () => eventSubs.get(name)?.delete(fn);
}

function setConn(state, text = '') {
  const el = document.getElementById('conn');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

export async function refreshStatus() {
  try {
    status = await api('/api/status');
    setConn('ok');
  } catch (e) {
    status = null;
    setConn('error', '连接失败：' + e.message);
  }
  emitStatus();
  return status;
}

export function notice(text, kind = 'info') {
  const el = document.getElementById('notice');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind;
  el.hidden = !text;
}

const DONE = {
  resume: s => '已启动' + (s?.config?.mode === 'auto' ? '' : '（草稿模式，只生成草稿，不发送）'),
  pause: () => '已暂停',
  takeover: () => '已接管，自动处理已停止',
  release: () => '已释放接管，处理保持暂停，可在顶部启动',
};

// Runs one control action; all control buttons stay disabled while it is in flight.
export async function runControl(action) {
  if (pending) return false;
  pending = true;
  emitStatus();
  if (action === 'pause' || action === 'takeover') notice('正在等待当前操作结束…');
  try {
    await control(action);
    await refreshStatus();
    notice(DONE[action]?.(status) ?? '操作完成', 'ok');
    return true;
  } catch (e) {
    notice(e.message, 'error');
    await refreshStatus();
    return false;
  } finally {
    pending = false;
    emitStatus();
  }
}

function startLogs() {
  const es = new EventSource('/api/events');
  es.addEventListener('logs', e => {
    try { logs = JSON.parse(e.data); } catch { return; }
    if (document.getElementById('conn')?.dataset.state === 'reconnecting') setConn('ok');
    for (const fn of logSubs) fn(logs);
  });
  for (const name of ['program', 'tasks', 'feed', 'health']) es.addEventListener(name, e => {
    let payload; try { payload = JSON.parse(e.data); } catch { return; }
    for (const fn of eventSubs.get(name) ?? []) fn(payload);
  });
  es.onerror = () => setConn('reconnecting', '日志重连中');
}

export function start() {
  refreshStatus();
  setInterval(refreshStatus, 10000);
  startLogs();
}
