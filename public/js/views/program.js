import { h, set, fmtTime, fmtDateTime } from '../dom.js';
import { api } from '../api.js';
import { notice, onEvent } from '../state.js';
import { field, empty, table, json, editorGuard, errorBox } from '../view-utils.js';

const STAGE = { waiting: '等待', identity: '身份检查', 'browser-prepare':'浏览器轮次准备', 'manual-import':'核对补录', 'experience-verify':'核对角色经历', 'collect-public': '公开采集', 'collect-private': '私信采集', collect: '采集', queue: '排队', context: '读取上下文', memory: '记忆召回', semantic: '语义判定', 'semantic-trigger': '语义判定', 'daily-state': '虚构日程', prompt: '组装提示词', generation: '生成', generate: '生成', send: '发送', sending: '发送', lookup: '回查', summary: '整理', cooldown: '退避', error: '错误' };
const STATUS = { running: '进行中', completed: '已完成', success: '已完成', failed: '失败', aborted: '已中止', interrupted: '重启中断', queued: '排队', generating: '生成中', draft: '草稿', sending: '发送中', unknown: '待回查', confirmed: '已确认', skipped: '已跳过', paused: '已暂停', manual: '人工接管', draining: '等待排空' };
const CONTROL_LABEL = { paused: '暂停', running: '运行', manual: '人工', auto: '自动' };

function parseJson(detail) {
  if (typeof detail !== 'string') return null;
  const trimmed = detail.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function personaSummary(verb) {
  return (detail) => {
    const obj = parseJson(detail);
    if (!obj) return detail || `${verb}人设`;
    const name = obj.name || obj.id || '未命名';
    const rev = Number.isFinite(Number(obj.revision)) ? `（第 ${obj.revision} 版）` : '';
    return `${verb}人设「${name}」${rev}`;
  };
}

export const EVENT_SUMMARY = {
  'model-library-refresh': {
    category: '模型',
    tone: 'blue',
    summarize(detail) {
      const o = parseJson(detail);
      if (o && (o.provider || o.key)) return `${o.provider || o.key} 模型列表${o.error || o.fetchError ? '拉取失败' : '已刷新'}`;
      const m = /^(\S+)\s+(已刷新|拉取失败)$/.exec(String(detail || '').trim());
      if (m) return m[2] === '已刷新' ? `${m[1]} 模型列表已刷新` : `${m[1]} 模型列表拉取失败`;
      return String(detail || '模型列表已刷新');
    },
  },
  'model-library-add': { category: '模型', tone: 'blue', summarize: d => String(d || '已添加服务商') },
  'model-library-update': { category: '模型', tone: 'blue', summarize: d => String(d || '已更新服务商') },
  'model-library-remove': { category: '模型', tone: 'blue', summarize: d => String(d || '已移除服务商') },
  'model-library-model': { category: '模型', tone: 'blue', summarize: d => String(d || '已更新模型参数') },
  'model-library-model-remove': { category: '模型', tone: 'blue', summarize: d => String(d || '已删除模型') },
  'model-library-active': { category: '模型', tone: 'blue', summarize: d => String(d || '已切换使用中模型') },
  'model-library-reconcile': { category: '模型', tone: 'blue', summarize: d => String(d || '使用中模型已同步') },
  'model-discover': { category: '模型', tone: 'blue', summarize: d => String(d || '模型目录拉取') },
  'model-test': { category: '模型', tone: 'blue', summarize: d => '模型测试：' + String(d || '') },
  'model-save': { category: '模型', tone: 'blue', summarize: d => String(d || '模型设置已保存') },
  'browser-restart': {
    category: '浏览器',
    tone: 'warn',
    summarize() { return '浏览器进程重启'; },
  },
  'browser-resource-wait': {
    category: '浏览器',
    tone: 'warn',
    summarize() { return '浏览器等待资源恢复'; },
  },
  'persona-create': { category: '人设', summarize: personaSummary('新建') },
  'persona-save': { category: '人设', summarize: personaSummary('保存') },
  'persona-delete': { category: '人设', summarize: personaSummary('删除') },
  'persona-import': { category: '人设', summarize: personaSummary('导入') },
  'persona-activate': { category: '人设', summarize: personaSummary('启用') },
  'persona-upgrade': { category: '人设', summarize: () => '人设升级，已自动备份' },
  'persona-api-error': { category: '人设', tone: 'warn', summarize: d => String(d || '人设操作异常') },
  'persona-library-error': { category: '人设', tone: 'warn', summarize: d => String(d || '人设库校验异常') },
  'persona-library-api-error': { category: '人设', tone: 'warn', summarize: d => String(d || '人设库操作失败') },
  'persona-replay-start': { category: '人设', summarize: d => { const o = parseJson(d); return o ? `开始人设回放（${o.samples ?? 0} 条样本）` : '开始人设回放'; } },
  'persona-replay-end': { category: '人设', summarize: d => { const o = parseJson(d); return o ? `人设回放结束：${STATUS[o.status] || o.status || '完成'}` : '人设回放结束'; } },
  'persona-replay-error': { category: '人设', tone: 'warn', summarize: () => '人设回放异常中止' },
  boot: { category: '服务', summarize: d => String(d || '服务启动') },
  'settings-upgrade': { category: '服务', summarize: d => String(d || '设置迁移已完成') },
  'api-error': { category: '服务', tone: 'warn', summarize: d => String(d || '请求处理失败') },
  pause: { category: '控制', summarize: d => String(d || '自动处理已暂停') },
  resume: {
    category: '控制',
    summarize(d) {
      const o = parseJson(d);
      if (o) return `自动处理已恢复（${o.accountId ? '@' + o.accountId + ' · ' : ''}${o.mode === 'auto' ? '自动模式' : '草稿模式'}）`;
      return String(d || '自动处理已恢复');
    },
  },
  'safety-pause': { category: '控制', tone: 'bad', summarize: d => '安全暂停：' + String(d || '') },
  'control-error': { category: '控制', tone: 'bad', summarize: d => String(d || '控制操作失败') },
  'health-control': {
    category: '健康',
    summarize(d) {
      const o = parseJson(d);
      const ctl = o?.control ? (CONTROL_LABEL[o.control] || o.control) : String(d || '暂停');
      return `健康控制：${ctl}`;
    },
  },
  'health-evaluation-error': { category: '健康', tone: 'warn', summarize: d => String(d || '健康快照计算失败') },
  takeover: { category: '接管', summarize: d => String(d || '已移交人工；自动任务停止') },
  release: { category: '接管', summarize: d => String(d || '人工连接已关闭，等待显式恢复') },
  'account-compliance': {
    category: '账号',
    summarize(d) {
      const o = parseJson(d);
      if (!o) return String(d || '账号合规检查');
      const issues = [];
      if (o.disclosure === 'missing') issues.push('披露缺失');
      else if (o.disclosure === 'unknown') issues.push('披露待确认');
      if (o.automatedLabel === 'missing') issues.push('未标注自动化');
      else if (o.automatedLabel === 'unknown') issues.push('自动化标签待确认');
      if (o.qualityFilter === 'on') issues.push('质量过滤开启');
      else if (o.qualityFilter === 'unknown') issues.push('质量过滤待确认');
      return '账号合规检查：' + (issues.length ? issues.join('、') : '全部正常');
    },
  },
  'automation-block': { category: '发送', tone: 'warn', summarize: d => { const o = parseJson(d); return `触发平台自动化拦截（${o?.channel === 'private' ? '私信' : '公开'}）`; } },
  cooldown: { category: '发送', tone: 'warn', summarize: d => { const o = parseJson(d); return `${o?.channel === 'private' ? '私信' : '公开'}通道进入退避`; } },
  processed: { category: '运行', summarize: d => { const o = parseJson(d); return o ? `消息处理完成（${o.channel === 'private' ? '私信' : '公开'} · ${STATUS[o.status] || o.status || '已处理'}）` : '消息处理完成'; } },
  'generation-error': { category: '运行', tone: 'warn', summarize: () => '回复生成失败' },
  'message-validation': { category: '采集', tone: 'warn', summarize: d => { const o = parseJson(d); return '入站消息校验跳过：' + (o?.reason || '缺少可靠时间或标识'); } },
  'collection-warning': { category: '采集', tone: 'warn', summarize: d => { const o = parseJson(d); return o?.reason || '页面采集存在异常'; } },
  'private-peer-candidate': { category: '记忆', summarize: d => { const o = parseJson(d); return o?.peerHandle ? `识别私信对象候选 @${o.peerHandle}` : '识别私信对象候选'; } },
  'identity-link-conflict': { category: '记忆', tone: 'warn', summarize: () => '跨渠道身份关联冲突' },
  'memory-summary': { category: '记忆', summarize: d => { const o = parseJson(d); return o ? `用户记忆整理完成（新增 ${o.itemCount ?? 0} 条）` : '用户记忆整理完成'; } },
  'summary-error': { category: '记忆', tone: 'warn', summarize: () => '用户记忆整理失败' },
  forget: { category: '记忆', summarize: d => String(d || '用户记忆已删除并停止记录') },
  remember: { category: '记忆', summarize: d => String(d || '用户已恢复记忆记录') },
  'role-experience-create': { category: '记忆', summarize: () => '登记角色经历' },
  'role-experience-edit': { category: '记忆', summarize: () => '更新角色经历' },
  'role-experience-hide': { category: '记忆', summarize: () => '停用角色经历' },
  'role-experience-unhide': { category: '记忆', summarize: () => '启用角色经历' },
  'role-experience-verify': { category: '记忆', summarize: d => { const o = parseJson(d); return `核对角色经历：${o?.result === 'verified' ? '已核实' : '失败'}`; } },
  'triage-harassment': { category: '分级', tone: 'warn', summarize: d => { const o = parseJson(d); return `触发骚扰冷却（${o?.userId || ''}）`; } },
  'triage-unignore': { category: '分级', summarize: d => { const o = parseJson(d); return `解除骚扰冷却（${o?.userId || ''}）`; } },
  'triage-requeue': { category: '分级', summarize: () => '消息已重新入队' },
  'draft-approve': { category: '运行', summarize: () => '批准草稿并提交发送' },
  'draft-cancel': { category: '运行', summarize: () => '取消已批准草稿' },
  'draft-regenerate': { category: '运行', summarize: () => '请求重写草稿' },
  'manual-import': { category: '采集', summarize: d => { const o = parseJson(d); return `手动补录链接：${o?.result || '已处理'}`; } },
  'daily-state-error': { category: '运行', tone: 'warn', summarize: () => '虚构日程生成失败' },
  'tick-error': { category: '运行', tone: 'bad', summarize: d => String(d || '工作轮次异常') },
  'prompt-hints-save': { category: '人设', summarize: d => String(d || '动态提醒已保存') },
};

export function summarizeLogEvent(row) {
  const event = String(row?.event || '');
  const detail = String(row?.detail ?? '');
  const entry = EVENT_SUMMARY[event];
  const parsed = parseJson(detail);
  const summary = entry ? entry.summarize(detail, row) : (detail && !parsed ? detail : event || '未知事件');
  const category = entry ? entry.category : (event || '事件');
  const tone = row?.level === 'error' ? 'bad' : row?.level === 'warn' ? 'warn' : (entry?.tone || '');
  const rawPreview = parsed ? detail : (row?.correlationId ? `关联 ${row.correlationId.slice(0, 12)}…` : (summary !== detail ? detail : ''));
  return { category, tone, summary, rawPreview, parsed };
}

function beijingDayKey(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ms)));
}

export function formatBeijingDayDivider(ms, now = Date.now()) {
  const key = beijingDayKey(ms);
  if (!key) return '';
  const mmdd = key.slice(5).replace('-', '/');
  const todayKey = beijingDayKey(now);
  const yesterdayKey = beijingDayKey(now - 86400000);
  if (key === todayKey) return `今天 · ${mmdd}`;
  if (key === yesterdayKey) return `昨天 · ${mmdd}`;
  return mmdd;
}

export function mount(root, ctx) {
  let alive = true, loading = false, data = null, settings = null, saved = '', revision = 0, saving = false;
  let logs = [], logCursor = null, logsBusy = false, paused = false, searchTimer = null;
  let messages = [], messageCursor = null, messagesBusy = false;
  const expandedLogIds = new Set();
  const runtime = h('div', { class: 'stack' }, empty('正在读取程序状态…'));
  const settingsBox = h('div', { class: 'stack' });
  const stages = h('div', { class: 'ws-card compact-table-card' });
  const queue = h('div', { class: 'ws-card compact-table-card' });
  const detail = h('div', { class: 'stack' });
  const list = h('div', { class: 'stack' });
  const logContainer = h('div', { id: 'program-logs', class: 'ws-card log-table-card' }, h('div', { class: 'log-empty muted small', style: 'padding:12px' }, '正在读取日志…'));

  const level = h('select', { class: 'input log-filter-select', 'aria-label': '级别', onchange: () => loadLogs() },
    h('option', { value: '' }, '全部级别'),
    ['info', 'warn', 'error'].map(x => h('option', { value: x }, x === 'info' ? '信息' : x === 'warn' ? '警告' : '错误')));
  const channel = h('select', { class: 'input log-filter-select', 'aria-label': '渠道', onchange: () => loadLogs() },
    h('option', { value: '' }, '全部渠道'),
    h('option', { value: 'public' }, '公开'),
    h('option', { value: 'private' }, '私信'));
  const correlation = h('input', {
    class: 'input log-filter-search',
    placeholder: '搜索内容或关联 ID…',
    'aria-label': '关联 ID',
    oninput: () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (alive) loadLogs(); }, 300);
    },
  });
  const timeRange = h('select', {
    class: 'input log-filter-select',
    'aria-label': '时间范围',
    onchange: () => {
      customRangeWrap.hidden = timeRange.value !== 'custom';
      loadLogs();
    },
  },
    h('option', { value: '1d' }, '最近 1 天'),
    h('option', { value: '3d', selected: true }, '最近 3 天'),
    h('option', { value: '7d' }, '最近 7 天'),
    h('option', { value: 'all' }, '全部时间'),
    h('option', { value: 'custom' }, '自选时间')
  );
  timeRange.value = '3d';
  const from = h('input', { type: 'datetime-local', class: 'input log-filter-date', 'aria-label': '开始（北京时间）', onchange: () => loadLogs() });
  const to = h('input', { type: 'datetime-local', class: 'input log-filter-date', 'aria-label': '结束（北京时间）', onchange: () => loadLogs() });
  const customRangeWrap = h('span', { class: 'log-custom-range', hidden: true }, from, h('span', { class: 'muted' }, '–'), to);

  const pause = h('button', {
    id: 'program-log-pause',
    class: 'btn small',
    type: 'button',
    onclick: () => {
      paused = !paused;
      pause.textContent = paused ? '恢复实时日志' : '暂停实时日志';
      if (!paused) loadLogs();
    },
  }, '暂停实时日志');
  const logMore = h('button', { id: 'program-log-more', class: 'btn small', type: 'button', hidden: true, title: '查看更多更早的日志', onclick: () => loadLogs(true) }, '查看更多');
  const messageStatus = h('select', { class: 'input' }, h('option', { value: '' }, '全部消息状态'), ['queued', 'generating', 'draft', 'sending', 'unknown', 'confirmed', 'failed', 'skipped'].map(x => h('option', { value: x }, STATUS[x])));
  const messageChannel = h('select', { class: 'input' }, h('option', { value: '' }, '全部渠道'), h('option', { value: 'public' }, '公开'), h('option', { value: 'private' }, '私信'));
  const messageMore = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => loadMessages(true) }, '加载更多消息');
  const replyWindowState = h('span', { class: 'small muted log-reply-state', role: 'status' });

  const logsSection = h('section', { class: 'ws-stack log-view-section' },
    h('div', { class: 'log-toolbar' },
      level,
      channel,
      correlation,
      timeRange,
      customRangeWrap,
      h('span', { class: 'sp' }),
      replyWindowState,
      pause
    ),
    logContainer,
    logMore
  );

  const stagesSection = h('section', { class: 'ws-stack' }, stages);
  const queueSection = h('section', { class: 'ws-stack' }, queue, detail);

  const page = h('div', { class: 'ws-stack settings-logs-page' },
    h('div', {}, h('h1', { class: 'page-title' }, '主程序'), h('p', { class: 'muted page-desc' }, '阶段与控制状态分别显示。日志只含运行元数据，消息正文按需读取。')),
    h('section', { class: 'card stack' }, runtime),
    h('details', { class: 'card' }, h('summary', {}, '运行设置'), settingsBox, h('p', { class: 'muted small' }, '轮询间隔在定时任务页统一维护。保存设置不会恢复处理。 ', h('a', { href: '#/tasks' }, '打开定时任务 →'))),
    stagesSection,
    queueSection,
    h('section', { class: 'card stack' }, h('h2', { class: 'card-h' }, '消息与回执'), h('div', { class: 'toolbar' }, messageStatus, messageChannel, h('button', { type: 'button', class: 'btn', onclick: () => loadMessages() }, '筛选消息')), list, messageMore),
    logsSection
  );

  if (ctx.settingsEmbedded) {
    const cards = [...page.children];
    cards[0]?.remove(); cards[1]?.remove(); cards[2]?.remove(); cards[5]?.remove();
    const panels = { logs: logsSection, stages: stagesSection, queue: queueSection };
    const tabs = h('div', { class: 'ws-segmented settings-log-tabs', role: 'group', 'aria-label': '排查视图' });
    function show(id) {
      for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== id;
      for (const button of tabs.children) {
        const active = button.dataset.programView === id;
        button.classList.toggle('selected', active);
        button.setAttribute('aria-pressed', String(active));
      }
    }
    for (const [id, label] of [['logs', '日志'], ['stages', '阶段'], ['queue', '队列']]) {
      tabs.append(h('button', { type: 'button', dataset: { programView: id }, onclick: () => show(id) }, label));
    }
    if (ctx.setActions) ctx.setActions(tabs);
    else page.prepend(tabs);
    show('logs');
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
    const window = data.replyHours;
    replyWindowState.textContent = window?.open === false
      ? '回复时段已关闭 · 开放 ' + (fmtDateTime(window.opensAt) || window.openTime || '待定')
      : window ? '回复时段已开放' : '';
    const stage = data.stage;
    const activeStage = stage?.status === 'running' ? stage : null;
    set(runtime, h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, h('div', { class: 'muted small' }, '当前控制'), h('div', { class: 'big' }, STATUS[data.control] || data.control)), h('button', { class: 'btn', type: 'button', onclick: loadStatus }, '刷新状态')),
      h('div', { class: 'metric-grid' }, metric('当前阶段', activeStage ? STAGE[activeStage.name] || activeStage.name : data.control === 'running' ? '等待下一轮' : '等待恢复'), metric(activeStage ? '阶段耗时' : '上一阶段耗时', stage ? duration(stage.durationMs ?? Date.now() - stage.startedAt) : '—'), metric('最近完成一轮', fmtDateTime(data.lastTick) || '尚未运行'), metric('下次循环', fmtDateTime(data.nextTick) || '等待恢复')),
      stage ? h('div', { class: 'muted small break' }, (activeStage ? '当前阶段' : '最近阶段') + ' · 轮次 ' + (stage.roundId || '—') + ' · ' + (STATUS[stage.status] || stage.status) + ' · 开始 ' + fmtDateTime(stage.startedAt) + (stage.messageId ? ' · 消息 ' + stage.messageId : '') + (stage.callId ? ' · 调用 ' + stage.callId : '') + (stage.taskId ? ' · 任务 ' + stage.taskId : '')) : null,
      h('div', { class: 'grid2' }, ['public', 'private'].map(ch => h('div', { class: 'subcard' }, h('b', {}, ch === 'public' ? '公开通道' : '私信通道'), h('div', {}, '本小时 ' + (data.limits?.[ch]?.used ?? '未知') + ' / ' + (data.limits?.[ch]?.limit ?? '未知')), Number(data.cooldown?.[ch]) > Date.now() ? h('div', { class: 'warn' }, '平台拒绝后退避至 ' + fmtDateTime(data.cooldown[ch])) : h('div', { class: 'muted small' }, '当前没有通道退避')))));
    set(stages, data.stages?.length ? table(['阶段', '状态', '开始', '耗时', '关联'], data.stages.map(row => [STAGE[row.name] || row.name, STATUS[row.status] || row.status, fmtDateTime(row.startedAt), duration(row.durationMs ?? (row.endedAt || Date.now()) - row.startedAt), h('div', { class: 'break small' }, [row.messageId, row.callId, row.taskId, row.roundId, row.detail ? '请求 ' + row.detail.rounds + ' 轮、读取卡片 ' + row.detail.cardsRead + ' 张' : null].filter(Boolean).join(' · '), row.error ? h('details', {}, h('summary', { class: 'bad' }, '错误详情'), h('pre', { class: 'pre-wrap' }, row.error)) : null)])) : empty('暂无阶段记录。'));
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
      set(list, messages.length ? table(['消息', '渠道', '状态', '时间', '详情'], messages.map(row => [row.id, row.channel === 'private' ? '私信' : '公开', STATUS[row.status] || row.status, fmtDateTime(row.createdAt ?? row.created_at), h('button', { class: 'btn small', type: 'button', onclick: () => loadMessage(row.id) }, '展开')])) : empty('暂无符合筛选条件的消息。')); messageMore.hidden = !messageCursor;
    } catch (e) { if (alive) errorBox(list, e, loadMessages); }
    finally { messagesBusy = false; }
  }
  async function loadMessage(id) {
    set(detail, empty('正在读取消息详情…'));
    try { const res = await api('/api/messages/' + encodeURIComponent(id)); if (alive) set(detail, h('details', { class: 'subcard', open: true }, h('summary', {}, '消息、模型调用与平台回执'), json(res))); }
    catch (e) { if (alive) errorBox(detail, e); }
  }
  function logParams() {
    const q = correlation.value.trim();
    const params = new URLSearchParams({ level: level.value, channel: channel.value, correlationId: q, limit: '50' });
    const range = timeRange.value;
    if (range === '1d') params.set('from', String(Date.now() - 86400000));
    else if (range === '3d') params.set('from', String(Date.now() - 3 * 86400000));
    else if (range === '7d') params.set('from', String(Date.now() - 7 * 86400000));
    else if (range === 'custom') {
      if (from.value) params.set('from', String(new Date(from.value + '+08:00').getTime()));
      if (to.value) params.set('to', String(new Date(to.value + '+08:00').getTime()));
    }
    return params;
  }

  function renderLogsTable() {
    const q = correlation.value.trim().toLowerCase();
    const visible = q
      ? logs.filter(row => {
          const s = summarizeLogEvent(row);
          return String(row.correlationId || '').toLowerCase().includes(q)
            || String(row.event || '').toLowerCase().includes(q)
            || String(row.detail || '').toLowerCase().includes(q)
            || String(s.summary || '').toLowerCase().includes(q);
        })
      : logs;

    if (!visible.length) {
      set(logContainer, h('div', { class: 'log-empty muted small', style: 'padding:12px' }, '暂无符合筛选条件的日志。'));
      return;
    }

    const tbody = h('tbody');
    let lastDay = '';
    for (const row of visible) {
      const dayLabel = formatBeijingDayDivider(row.at);
      if (dayLabel && dayLabel !== lastDay) {
        lastDay = dayLabel;
        tbody.append(h('tr', { class: 'log-day-divider' }, h('td', { colSpan: 4 }, dayLabel)));
      }
      const key = String(row.id ?? (row.at + ':' + row.event));
      const open = expandedLogIds.has(key);
      const { category, tone, summary, rawPreview, parsed } = summarizeLogEvent(row);
      const toggleRow = () => {
        if (expandedLogIds.has(key)) expandedLogIds.delete(key);
        else expandedLogIds.add(key);
        renderLogsTable();
      };
      const tr = h('tr', {
        class: 'log-row' + (open ? ' is-open' : ''),
        dataset: { level: row.level, event: row.event },
        tabindex: 0,
        onclick: toggleRow,
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(); } },
      },
        h('td', { class: 'log-col-time', title: fmtDateTime(row.at) }, fmtTime(row.at, true)),
        h('td', { class: 'log-col-cat' }, h('span', { class: 'ws-badge ' + tone }, category)),
        h('td', { class: 'log-col-msg' },
          summary,
          row.channel ? h('span', { class: 'ws-badge', style: 'margin-left:6px' }, row.channel === 'private' ? '私信' : '公开') : null
        ),
        h('td', { class: 'log-col-raw' }, rawPreview)
      );
      tbody.append(tr);
      if (open) {
        const detailTd = h('td', { colSpan: 4, class: 'log-detail-cell' },
          h('div', { class: 'log-detail-box small' },
            h('div', { class: 'muted' }, `事件类型：${row.event} · 时间：${fmtDateTime(row.at)}`),
            parsed ? json(parsed) : h('pre', { class: 'pre-wrap' }, String(row.detail ?? '')),
            row.correlationId ? h('div', {},
              h('button', {
                type: 'button',
                class: 'linkbtn break',
                onclick: e => {
                  e.stopPropagation();
                  correlation.value = row.correlationId;
                  loadLogs();
                },
              }, '关联 ID：' + row.correlationId)
            ) : null
          )
        );
        tbody.append(h('tr', { class: 'log-detail-row' }, detailTd));
      }
    }
    set(logContainer, h('table', { class: 'logs-table' }, tbody));
  }

  async function loadLogs(append = false) {
    if (logsBusy) return; logsBusy = true; logMore.disabled = true;
    try {
      const params = logParams(); if (append && logCursor) params.set('cursor', logCursor);
      const res = await api('/api/program/logs?' + params); if (!alive) return;
      logs = append ? [...logs, ...res.items] : res.items;
      logCursor = res.nextCursor;
      renderLogsTable();
      logMore.hidden = !logCursor;
    } catch (e) {
      if (alive) set(logContainer, h('div', { class: 'log-empty', style: 'padding:12px' }, h('div', { class: 'callout bad', role: 'alert' }, e.message), h('button', { type: 'button', class: 'btn small', onclick: () => loadLogs() }, '重新读取日志')));
    } finally { logsBusy = false; logMore.disabled = false; }
  }
  const offProgram = onEvent('program', () => { loadStatus(); if (!paused) loadLogs(); });
  const timer = setInterval(() => { loadStatus(); if (!paused) loadLogs(); }, 10000);
  loadStatus(); if (!ctx.settingsEmbedded) loadMessages(); loadLogs();
  return () => { alive = false; clearTimeout(searchTimer); cleanup(); offProgram(); clearInterval(timer); };
}
