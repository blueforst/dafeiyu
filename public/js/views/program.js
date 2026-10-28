import { h, set, fmtTime, fmtDateTime } from '../dom.js';
import { api } from '../api.js';
import { notice, onEvent } from '../state.js';
import { field, empty, table, json, editorGuard, errorBox } from '../view-utils.js';

const STAGE = { waiting: '等待', identity: '身份检查', 'browser-prepare':'浏览器轮次准备', 'manual-import':'核对补录', 'experience-verify':'核对角色经历', 'collect-public': '公开采集', 'collect-private': '私信采集', collect: '采集', queue: '排队', context: '读取上下文', memory: '记忆召回', semantic: '语义判定', 'semantic-trigger': '语义判定', 'daily-state': '虚构日程', prompt: '组装提示词', generation: '生成', generate: '生成', send: '发送', sending: '发送', lookup: '回查', summary: '整理', cooldown: '退避', error: '错误' };
const STATUS = { running: '进行中', completed: '已完成', success: '已完成', failed: '失败', aborted: '已中止', interrupted: '重启中断', queued: '排队', generating: '生成中', draft: '草稿', sending: '发送中', unknown: '待回查', confirmed: '已确认', skipped: '已跳过', paused: '已暂停', manual: '人工接管', draining: '等待排空' };

export function mount(root, ctx) {
  let alive = true, loading = false, data = null, settings = null, saved = '', revision = 0, saving = false;
  let logs = [], logCursor = null, logsBusy = false, paused = false;
  let messages = [], messageCursor = null, messagesBusy = false;
  const runtime = h('div', { class: 'stack' }, empty('正在读取程序状态…'));
  const settingsBox = h('div', { class: 'stack' });
  const stages = h('div');
  const queue = h('div');
  const detail = h('div', { class: 'stack' });
  const list = h('div', { class: 'stack' });
  const logList = h('ul', { id: 'program-logs', class: 'logs' }, h('li', { class: 'log-empty' }, '正在读取日志…'));
  const level = h('select', { class: 'input' }, h('option', { value: '' }, '全部级别'), ['info', 'warn', 'error'].map(x => h('option', { value: x }, x === 'info' ? '信息' : x === 'warn' ? '警告' : '错误')));
  const channel = h('select', { class: 'input' }, h('option', { value: '' }, '全部渠道'), h('option', { value: 'public' }, '公开'), h('option', { value: 'private' }, '私信'));
  const correlation = h('input', { class: 'input', placeholder: '消息／调用／任务关联 ID' });
  const from = h('input', { type: 'datetime-local', class: 'input' });
  const to = h('input', { type: 'datetime-local', class: 'input' });
  const pause = h('button', { id: 'program-log-pause', class: 'btn', type: 'button', onclick: () => { paused = !paused; pause.textContent = paused ? '恢复实时日志' : '暂停实时日志'; if (!paused) loadLogs(); } }, '暂停实时日志');
  const logMore = h('button', { id: 'program-log-more', class: 'linkbtn', type: 'button', hidden: true, title: '查看更多更早的日志', onclick: () => loadLogs(true) }, '查看更多');
  const messageStatus = h('select', { class: 'input' }, h('option', { value: '' }, '全部消息状态'), ['queued', 'generating', 'draft', 'sending', 'unknown', 'confirmed', 'failed', 'skipped'].map(x => h('option', { value: x }, STATUS[x])));
  const messageChannel = h('select', { class: 'input' }, h('option', { value: '' }, '全部渠道'), h('option', { value: 'public' }, '公开'), h('option', { value: 'private' }, '私信'));
  const messageMore = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => loadMessages(true) }, '加载更多消息');
  const page = h('div', { class: 'stack' }, h('div', {}, h('h1', { class: 'page-title' }, '主程序'), h('p', { class: 'muted page-desc' }, '阶段与控制状态分别显示。日志只含运行元数据，消息正文按需读取。')),
    h('section', { class: 'card stack' }, runtime),
    h('details', { class: 'card' }, h('summary', {}, '运行设置'), settingsBox, h('p', { class: 'muted small' }, '轮询间隔在定时任务页统一维护。保存设置不会恢复处理。 ', h('a', { href: '#/tasks' }, '打开定时任务 →'))),
    h('section', { class: 'card stack' }, h('h2', { class: 'card-h' }, '阶段记录'), stages),
    h('section', { class: 'card stack' }, h('h2', { class: 'card-h' }, '当前队列'), queue),
    h('section', { class: 'card stack' }, h('h2', { class: 'card-h' }, '消息与回执'), h('div', { class: 'toolbar' }, messageStatus, messageChannel, h('button', { type: 'button', class: 'btn', onclick: () => loadMessages() }, '筛选消息')), list, messageMore, detail),
    h('section', { class: 'card stack' }, h('div', { class: 'toolbar' }, h('h2', { class: 'card-h grow' }, h('span', {}, '日志 ', h('span', { class: 'aside' }, '只显示运行事件，不含消息正文'))), logMore, pause),
      h('div', { class: 'filter-grid' }, field('级别', level), field('渠道', channel), field('关联 ID', correlation), field('开始（北京时间）', from), field('结束（北京时间）', to)),
      h('div', { class: 'toolbar' }, h('button', { id: 'program-log-filter', type: 'button', class: 'btn', onclick: () => loadLogs() }, '筛选日志')), logList));
  if (ctx.settingsEmbedded) {
    const cards = [...page.children];
    cards[0]?.remove(); cards[1]?.remove(); cards[2]?.remove(); cards[5]?.remove();
  }
  set(root, page);
  const cleanup = editorGuard(ctx, page, () => !!settings && JSON.stringify(settings) !== saved);

  async function loadStatus() {
    if (loading) return; loading = true;
    try {
      const next = await api('/api/program'); if (!alive) return; data = next;
      if (!settings || JSON.stringify(settings) === saved) { settings = structuredClone(next.settings); saved = JSON.stringify(settings); revision = next.revision; renderSettings(); }
      renderStatus();
    } catch (e) { if (alive && !data) errorBox(runtime, e, loadStatus); }
    finally { loading = false; }
  }
  function renderStatus() {
    const stage = data.stage;
    const activeStage = stage?.status === 'running' ? stage : null;
    set(runtime, h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, h('div', { class: 'muted small' }, '当前控制'), h('div', { class: 'big' }, STATUS[data.control] || data.control)), h('button', { class: 'btn', type: 'button', onclick: loadStatus }, '刷新状态')),
      h('div', { class: 'metric-grid' }, metric('当前阶段', activeStage ? STAGE[activeStage.name] || activeStage.name : data.control === 'running' ? '等待下一轮' : '等待恢复'), metric(activeStage ? '阶段耗时' : '上一阶段耗时', stage ? duration(stage.durationMs ?? Date.now() - stage.startedAt) : '—'), metric('最近完成一轮', fmtDateTime(data.lastTick) || '尚未运行'), metric('下次循环', fmtDateTime(data.nextTick) || '等待恢复')),
      stage ? h('div', { class: 'muted small break' }, (activeStage ? '当前阶段' : '最近阶段') + ' · 轮次 ' + (stage.roundId || '—') + ' · ' + (STATUS[stage.status] || stage.status) + ' · 开始 ' + fmtDateTime(stage.startedAt) + (stage.messageId ? ' · 消息 ' + stage.messageId : '') + (stage.callId ? ' · 调用 ' + stage.callId : '') + (stage.taskId ? ' · 任务 ' + stage.taskId : '')) : null,
      h('div', { class: 'grid2' }, ['public', 'private'].map(ch => h('div', { class: 'subcard' }, h('b', {}, ch === 'public' ? '公开通道' : '私信通道'), h('div', {}, '本小时 ' + (data.limits?.[ch]?.used ?? '未知') + ' / ' + (data.limits?.[ch]?.limit ?? '未知')), Number(data.cooldown?.[ch]) > Date.now() ? h('div', { class: 'warn' }, '平台拒绝后退避至 ' + fmtDateTime(data.cooldown[ch])) : h('div', { class: 'muted small' }, '当前没有通道退避')))));
    set(stages, data.stages?.length ? table(['阶段', '状态', '开始', '耗时', '关联'], data.stages.map(row => [STAGE[row.name] || row.name, STATUS[row.status] || row.status, fmtDateTime(row.startedAt), duration(row.durationMs ?? (row.endedAt || Date.now()) - row.startedAt), h('div', { class: 'break small' }, [row.messageId, row.callId, row.taskId, row.roundId].filter(Boolean).join(' · '), row.error ? h('details', {}, h('summary', { class: 'bad' }, '错误详情'), h('pre', { class: 'pre-wrap' }, row.error)) : null)])) : empty('暂无阶段记录。'));
    set(queue, data.queue?.items?.length ? table(['消息', '渠道', '状态', '工作账号', '入站时间'], data.queue.items.map(row => [h('button', { type: 'button', class: 'linkbtn break', onclick: () => loadMessage(row.id) }, row.id), row.channel === 'private' ? '私信' : '公开', STATUS[row.status] || row.status, row.accountId || '未知归属', fmtDateTime(row.createdAt)])) : empty('当前没有排队消息。'));
  }
  function metric(title, text) { return h('div', { class: 'metric' }, h('span', { class: 'muted small' }, title), h('b', {}, text)); }
  function duration(ms) { return Number.isFinite(ms) ? (ms < 1000 ? Math.max(0, ms) + ' ms' : (Math.max(0, ms) / 1000).toFixed(1) + ' 秒') : '未知'; }
  function renderSettings() {
    const mode = h('select', { id: 'program-mode', class: 'input', onchange: e => { settings.mode = e.target.value; } }, h('option', { value: 'draft' }, '草稿：只生成，不发送'), h('option', { value: 'auto' }, '自动：按规则发送')); mode.value = settings.mode;
    const save = h('button', { id: 'program-settings-save', class: 'btn primary', type: 'button', disabled: saving, onclick: async () => {
      saving = true; save.disabled = true;
      const snapshot = structuredClone(settings);
      try { const res = await api('/api/program/settings', { method: 'PUT', body: { settings: snapshot, revision } }); if (!alive) return; revision = res.revision; saved = JSON.stringify(snapshot); notice('运行设置已保存，下一轮生效', 'ok'); }
      catch (e) { notice(e.message, 'error'); } finally { saving = false; save.disabled = false; }
    } }, '保存运行设置');
    set(settingsBox, field('运行模式', mode), h('div', { class: 'grid2' }, [['maxAgeHours', '普通消息时效（小时）', 1, 48], ['maxPerRound', '每轮最多处理', 1, 4], ['publicPerHour', '公开每小时上限', 1, 25], ['privatePerHour', '私信每小时上限', 1, 100]].map(([key, label, min, max]) => field(label, h('input', { class: 'input', type: 'number', min, max, step: 1, value: settings[key], oninput: e => { settings[key] = Number(e.target.value); } })))), save);
  }
  async function loadMessages(append = false) {
    if (messagesBusy) return; messagesBusy = true;
    try {
      const params = new URLSearchParams({ status: messageStatus.value, channel: messageChannel.value, limit: '30' });
      if (append && messageCursor) params.set('cursor', messageCursor);
      const res = await api('/api/messages?' + params); if (!alive) return; messages = append ? [...messages, ...res.items] : res.items; messageCursor = res.nextCursor;
      set(list, messages.length ? table(['消息', '渠道', '状态', '时间', '详情'], messages.map(row => [row.id, row.channel === 'private' ? '私信' : '公开', STATUS[row.status] || row.status, fmtDateTime(row.createdAt ?? row.created_at), h('button', { class: 'btn small', type: 'button', onclick: () => loadMessage(row.id) }, '展开')] )) : empty('暂无符合筛选条件的消息。')); messageMore.hidden = !messageCursor;
    } catch (e) { if (alive) errorBox(list, e, loadMessages); }
    finally { messagesBusy = false; }
  }
  async function loadMessage(id) {
    set(detail, empty('正在读取消息详情…'));
    try { const res = await api('/api/messages/' + encodeURIComponent(id)); if (alive) set(detail, h('details', { class: 'subcard', open: true }, h('summary', {}, '消息、模型调用与平台回执'), json(res))); }
    catch (e) { if (alive) errorBox(detail, e); }
  }
  function logParams() {
    const params = new URLSearchParams({ level: level.value, channel: channel.value, correlationId: correlation.value.trim(), limit: '50' });
    if (from.value) params.set('from', String(new Date(from.value + '+08:00').getTime()));
    if (to.value) params.set('to', String(new Date(to.value + '+08:00').getTime()));
    return params;
  }
  async function loadLogs(append = false) {
    if (logsBusy) return; logsBusy = true; logMore.disabled = true;
    try {
      const params = logParams(); if (append && logCursor) params.set('cursor', logCursor);
      const res = await api('/api/program/logs?' + params); if (!alive) return; logs = append ? [...logs, ...res.items] : res.items; logCursor = res.nextCursor;
      set(logList, logs.length ? logs.map(row => h('li', { dataset: { level: row.level } },
        h('span', { class: 't', title: fmtDateTime(row.at) }, fmtTime(row.at, true)),
        h('span', { class: 'e' }, row.event),
        h('span', { class: 'd' }, row.detail,
          row.channel || row.correlationId ? h('span', { class: 'log-meta' },
            row.channel ? h('span', { class: 'chip' }, row.channel === 'private' ? '私信' : '公开') : null,
            row.correlationId ? h('button', { type: 'button', class: 'linkbtn break', onclick: () => { correlation.value = row.correlationId; loadLogs(); } }, '关联 ID：' + row.correlationId) : null) : null))) : h('li', { class: 'log-empty' }, '暂无符合筛选条件的日志。')); logMore.hidden = !logCursor;
    } catch (e) { if (alive) set(logList, h('li', { class: 'log-empty' }, h('div', { class: 'callout bad', role: 'alert' }, e.message), h('button', { type: 'button', class: 'btn', onclick: () => loadLogs() }, '重新读取日志'))); }
    finally { logsBusy = false; logMore.disabled = false; }
  }
  const offProgram = onEvent('program', () => { loadStatus(); if (!paused) loadLogs(); });
  const timer = setInterval(() => { loadStatus(); if (!paused) loadLogs(); }, 10000);
  loadStatus(); if (!ctx.settingsEmbedded) loadMessages(); loadLogs();
  return () => { alive = false; cleanup(); offProgram(); clearInterval(timer); };
}
