// 日程、内容与宿主任务共同展示；保存计划和立即执行使用不同操作。
import { h, set, fmtDateTime } from '../dom.js';
import { api } from '../api.js';
import { notice, refreshStatus, onEvent } from '../state.js';

const STATUS = { running: '执行中', pending: '等待执行', queued: '排队中', completed: '完成', success: '完成', succeeded: '完成', failed: '失败', unknown: '提交结果未知，只回查', missed: '已错过窗口', skipped: '已跳过', cancelled: '已取消', aborted: '已中止', interrupted: '重启中断' };
const LABEL = { main: '主循环', 'daily-state': '虚构日程', 'memory-summary': '记忆补整理', 'morning-post': '早安帖', 'evening-post': '晚安帖', backup: '数据库备份', health: '宿主健康检查' };
const HINT = { main: '一轮完成后再等待设定秒数。启停与右上角全局控制一致。', 'daily-state': '每天生成一份虚构日程；当天已有结果时复用，暂停期间不自动调用。', 'memory-summary': '仅整理存在新增真实入站记录的用户；暂停期间不自动调用。', 'morning-post': '生成并发布公开早安帖，只在计划后五分钟内开始，共享公开额度。', 'evening-post': '生成并发布公开晚安帖，只在计划后五分钟内开始，共享公开额度。', backup: '只备份业务数据库，保留最近七份；恢复仍重放独立遗忘记录。', health: '宿主独立执行，每五分钟检查；应用故障或业务暂停时继续运行。' };
function signature(v) { return JSON.stringify({ enabled: !!v.enabled, ...(v.time !== undefined ? { time: v.time } : {}), ...(v.intervalSeconds !== undefined ? { intervalSeconds: Number(v.intervalSeconds) } : {}) }); }
function duration(v) { return v == null ? '未知' : Number(v) < 1000 ? v + ' ms' : (Number(v) / 1000).toFixed(1) + ' 秒'; }
function money(v) { return v == null ? '未知' : '$' + Number(v).toFixed(8); }

export function mount(root, ctx) {
  let alive = true, revision = 0, busy = false, nextCursor = null, leaveResolve = null, historyGeneration = 0;
  const forms = new Map();
  const error = h('div', { class: 'callout bad', role: 'alert' });
  const state = h('p', { class: 'muted', role: 'status' }, '正在读取任务计划…');
  const refresh = h('button', { class: 'btn', type: 'button', onclick: () => { loadPlans(true); loadHistory(); } }, '刷新状态');
  const plans = h('div', { class: 'grid2' });
  const scope = h('p', { class: 'muted small' });
  const hostState = h('p', { class: 'callout warn' });
  const filter = h('select', { class: 'input', id: 'task-history-filter' }, h('option', { value: '' }, '全部任务'), Object.entries(LABEL).map(([id, title]) => h('option', { value: id }, title)));
  const history = h('div');
  const more = h('button', { class: 'btn', type: 'button', hidden: true }, '加载更多历史');
  const leave = h('div', { class: 'confirm', hidden: true }, h('span', {}, '任务计划尚未保存，是否放弃修改并离开？'), h('span', { class: 'confirm-actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => answerLeave(false) }, '保留编辑'), h('button', { class: 'btn small', type: 'button', onclick: () => answerLeave(true) }, '放弃并离开')));
  set(root, h('div', { class: 'stack' }, leave, h('div', {}, h('h1', { class: 'page-title' }, '定时任务'), h('p', { class: 'page-desc muted' }, '所有时间均为北京时间。业务任务遵循全局暂停；宿主维护独立运行。'), refresh), error, state, plans, h('section', { class: 'card' }, h('h2', { class: 'card-h' }, '数据库与宿主维护'), hostState, scope, h('p', { class: 'muted small' }, '证书续期继续由宿主现有机制执行。')), h('section', { class: 'card' }, h('h2', { class: 'card-h' }, '执行历史'), h('label', { class: 'field', for: 'task-history-filter' }, '筛选任务'), filter, history, more)));

  const dirty = () => [...forms.values()].some(f => signature(f.value()) !== f.saved);
  function answerLeave(ok) { leave.hidden = true; const done = leaveResolve; leaveResolve = null; done?.(ok); }
  ctx?.setLeaveGuard(() => { if (!dirty()) return true; leave.hidden = false; leave.scrollIntoView({ block: 'start' }); return new Promise(resolve => { leaveResolve = resolve; }); });
  function beforeUnload(e) { if (dirty()) { e.preventDefault(); e.returnValue = ''; } }
  window.addEventListener('beforeunload', beforeUnload);

  function renderTask(task) {
    const enabled = h('input', { type: 'checkbox', checked: !!task.enabled, id: 'task-enabled-' + task.id });
    const time = task.time !== undefined ? h('input', { type: 'time', class: 'input', value: task.time, id: 'task-time-' + task.id, required: true }) : null;
    const interval = task.intervalSeconds !== undefined ? h('input', { type: 'number', class: 'input', value: task.intervalSeconds, min: task.id === 'main' ? 30 : 1, max: task.id === 'main' ? 3600 : 86400, step: 1, id: 'task-interval-' + task.id, required: true }) : null;
    const save = h('button', { class: 'btn primary', type: 'submit', disabled: true }, '保存计划');
    const run = h('button', { class: 'btn', type: 'button', hidden: task.id === 'main' }, task.id === 'main' ? '执行一轮' : task.id.includes('-post') ? '生成并发布一次' : '执行一次');
    const result = h('p', { class: 'small muted', role: 'status' });
    const next = h('span', {}, task.nextRunAt ? fmtDateTime(task.nextRunAt) : task.enabled ? '等待恢复或宿主计划' : '已关闭');
    const last = h('span', {}, task.lastRun ? (STATUS[task.lastRun.status] || task.lastRun.status) + ' · ' + fmtDateTime(task.lastRun.finishedAt || task.lastRun.startedAt || task.lastRun.scheduledAt) : '尚未执行');
    const value = () => ({ enabled: enabled.checked, ...(time ? { time: time.value } : {}), ...(interval ? { intervalSeconds: Number(interval.value) } : {}) });
    const f = { value, saved: signature(task), save, run, enabled, time, interval, next, last, result };
    if (interval && task.id === 'health') interval.readOnly = true;
    forms.set(task.id, f);
    const onInput = () => { save.disabled = signature(value()) === f.saved || busy; result.textContent = signature(value()) === f.saved ? '' : '有未保存修改'; };
    enabled.addEventListener('change', onInput); time?.addEventListener('input', onInput); interval?.addEventListener('input', onInput);
    const form = h('form', { class: 'card', onsubmit: e => { e.preventDefault(); saveTask(task.id); } },
      h('h2', { class: 'card-h' }, task.title || LABEL[task.id] || task.id, h('span', { class: 'chip' }, task.kind === 'host' ? '宿主维护' : task.kind === 'main' ? '全局控制' : '业务任务')),
      h('p', { class: 'muted small' }, HINT[task.id] || ''),
      h('label', { class: 'check', for: 'task-enabled-' + task.id }, enabled, task.id === 'main' ? '启用主循环（保存时变更全局运行状态）' : '启用自动计划'),
      time ? h('div', {}, h('label', { class: 'field', for: 'task-time-' + task.id }, '每天执行时间'), time) : null,
      interval ? h('div', {}, h('label', { class: 'field', for: 'task-interval-' + task.id }, task.id === 'main' ? '一轮结束后等待（秒）' : '执行间隔（秒）'), interval) : null,
      h('div', { class: 'row small', style: 'margin-top:10px' }, h('span', {}, '下次执行'), next),
      h('div', { class: 'row small' }, h('span', {}, '上次执行'), last),
      h('div', { class: 'toolbar', style: 'margin-top:12px' }, save, run),
      task.id.includes('-post') ? h('p', { class: 'small muted' }, '单次执行会调用模型并尝试真实发布，仍受暂停、额度和五分钟窗口约束。') : task.id === 'daily-state' || task.id === 'memory-summary' ? h('p', { class: 'small muted' }, '单次执行可能真实调用模型并计费。') : null,
      result);
    run.addEventListener('click', () => runTask(task.id, run));
    return form;
  }
  function updateAllButtons() { for (const f of forms.values()) { f.save.disabled = busy || signature(f.value()) === f.saved; f.run.disabled = busy; f.enabled.disabled = busy; if (f.time) f.time.disabled = busy; if (f.interval) f.interval.disabled = busy; } }
  async function loadPlans(refreshing = false) {
    try {
      const data = await api('/api/tasks'); if (!alive) return;
      const preserve = refreshing && dirty();
      if (!preserve) revision = data.revision;
      hostState.textContent = data.hostAvailable === false ? '宿主维护桥接尚未安装，健康检查与备份配置／单次执行暂不可用。' : '';
      scope.textContent = data.backupScope || '只包含业务数据库，不包含面板配置、Key、源码或浏览器 profile；独立遗忘记录不得被覆盖。';
      if (!refreshing || !forms.size) set(plans, (data.tasks ?? []).map(renderTask));
      else for (const task of data.tasks ?? []) {
        const f = forms.get(task.id); if (!f) continue;
        f.next.textContent = task.nextRunAt ? fmtDateTime(task.nextRunAt) : task.enabled ? '等待恢复或宿主计划' : '已关闭';
        f.last.textContent = task.lastRun ? (STATUS[task.lastRun.status] || task.lastRun.status) + ' · ' + fmtDateTime(task.lastRun.finishedAt || task.lastRun.startedAt || task.lastRun.scheduledAt) : '尚未执行';
        if (!preserve && !busy) { f.enabled.checked = !!task.enabled; if (f.time) f.time.value = task.time; if (f.interval) f.interval.value = task.intervalSeconds; f.saved = signature(task); }
      }
      updateAllButtons(); state.textContent = data.tasks?.length ? '' : '尚无任务计划';
    } catch (e) { if (alive) { state.textContent = ''; error.textContent = '读取计划失败：' + e.message; } }
  }
  async function saveTask(id) {
    if (busy) return;
    const f = forms.get(id); if (!f) return;
    busy = true; updateAllButtons(); error.textContent = ''; f.result.textContent = '正在保存…';
    try {
      const data = await api('/api/tasks/' + encodeURIComponent(id), { method: 'PUT', body: { revision, ...f.value() }, timeoutMs: 120000 });
      if (!alive) return;
      revision = data.revision;
      const saved = data.tasks?.find(t => t.id === id);
      f.saved = signature(saved || f.value());
      if (saved) { f.enabled.checked = !!saved.enabled; if (f.time) f.time.value = saved.time; if (f.interval) f.interval.value = saved.intervalSeconds; f.next.textContent = saved.nextRunAt ? fmtDateTime(saved.nextRunAt) : saved.enabled ? '等待恢复或宿主计划' : '已关闭'; }
      f.result.textContent = '已保存' + (id === 'main' ? '，全局状态已同步' : '，按计划生效');
      refreshStatus(); notice('任务计划已保存', 'ok');
    } catch (e) { if (alive) { f.result.textContent = '保存失败，编辑仍保留'; error.textContent = e.message; } }
    finally { busy = false; if (alive) updateAllButtons(); }
  }
  async function runTask(id, button) {
    if (busy) return;
    busy = true; button.disabled = true; updateAllButtons(); error.textContent = ''; const f = forms.get(id); f.result.textContent = '正在执行…';
    try { const data = await api('/api/tasks/' + encodeURIComponent(id) + '/run', { method: 'POST', timeoutMs: 180000 }); if (!alive) return; const r = data.run; f.result.textContent = r ? (STATUS[r.status] || r.status) + (r.error ? '：' + r.error : '') : '已提交执行'; if (r) f.last.textContent = (STATUS[r.status] || r.status) + ' · ' + fmtDateTime(r.finishedAt || r.startedAt || r.scheduledAt); await loadHistory(); }
    catch (e) { if (alive) { f.result.textContent = '执行失败'; error.textContent = e.message; } }
    finally { busy = false; if (alive) { button.disabled = false; updateAllButtons(); } }
  }
  function runRow(r) {
    const cost = r.costUSD ?? r.cost?.costUSD ?? r.cost?.total;
    return h('article', { style: 'border-top:1px solid var(--border);padding:10px 0;overflow-wrap:anywhere' },
      h('div', { class: 'row' }, h('strong', {}, LABEL[r.taskId] || r.taskId), h('span', { class: r.status === 'failed' ? 'bad' : r.status === 'unknown' ? 'warn' : 'muted' }, STATUS[r.status] || r.status)),
      h('p', { class: 'muted small' }, fmtDateTime(r.startedAt || r.scheduledAt) + ' · ' + (r.source === 'manual' ? '手动' : r.source === 'host' ? '宿主' : '计划') + ' · ' + duration(r.durationMs) + (r.callIds?.length ? ' · 模型估算 ' + money(cost) : '')),
      r.error ? h('p', { class: 'bad small' }, r.error) : null,
      r.cost && (r.cost.unpriced || r.cost.unknown) ? h('p', { class: 'warn small' }, '模型调用中未定价 ' + (r.cost.unpriced || 0) + ' 次、用量未知 ' + (r.cost.unknown || 0) + ' 次；这些费用未包含在可估价部分中。') : null,
      h('details', {}, h('summary', { class: 'small' }, '关联与结果'), h('p', { class: 'small pre-wrap' }, [
        '实例：' + r.id, '计划时刻：' + (fmtDateTime(r.scheduledAt) || '未知'), '工作账号：' + (r.accountId || '宿主／未知'), r.outboxId ? '出站：' + r.outboxId : '', ...(r.callIds || []).map(id => '调用：' + id), r.receipt ? '平台回执：' + JSON.stringify(r.receipt) : '', r.detail ? '结果：' + (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)) : ''
      ].filter(Boolean).join('\n')), r.callIds?.length ? h('a', { href: '#/billing', class: 'small' }, '查看统一计费流水 →') : null));
  }
  async function loadHistory(append = false) {
    const id = append ? historyGeneration : ++historyGeneration;
    const q = new URLSearchParams({ limit: '20', ...(filter.value ? { taskId: filter.value } : {}), ...(append && nextCursor ? { cursor: nextCursor } : {}) });
    more.disabled = true;
    try { const page = await api('/api/tasks/runs?' + q); if (!alive || id !== historyGeneration) return; if (!append) set(history); const items = page.items ?? []; if (!items.length && !append) history.append(h('p', { class: 'empty-state' }, '暂无执行历史')); else history.append(...items.map(runRow)); nextCursor = page.nextCursor; more.hidden = !nextCursor; }
    catch (e) { if (alive && id === historyGeneration) error.textContent = '读取执行历史失败：' + e.message; }
    finally { if (alive && id === historyGeneration) more.disabled = false; }
  }
  filter.addEventListener('change', () => loadHistory());
  more.addEventListener('click', () => loadHistory(true));
  let eventRefresh = null;
  const offEvents = onEvent('tasks', () => { if (eventRefresh) return; eventRefresh = setTimeout(() => { eventRefresh = null; if (!busy) { loadPlans(true); loadHistory(); } }, 250); });
  loadPlans(); loadHistory();
  return () => { alive = false; offEvents(); clearTimeout(eventRefresh); answerLeave(false); window.removeEventListener('beforeunload', beforeUnload); };
}
