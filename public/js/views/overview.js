// 概览：运行状态、浏览器当前账号、模型摘要和日志。
import { h, set, fmtTime, fmtDateTime, hostOf } from '../dom.js';
import { api } from '../api.js';
import { onStatus, onLogs, notice } from '../state.js';

const MODE = { draft: '草稿模式 · 只生成草稿，不发送', auto: '自动回复' };
const STATE_LABEL = { paused: '已暂停', running: '处理中', draining: '等待当前操作结束', manual: '人工接管中' };
const CHANNEL = { public: '公开', private: '私信' };

function count(stats, channel, statuses) {
  return (stats?.messages ?? []).filter(m => (!channel || m.channel === channel) && statuses.includes(m.status)).reduce((n, m) => n + Number(m.count || 0), 0);
}

export function mount(root) {
  // ---- run card
  const runState = h('div', { id: 'run-state', class: 'big' }, '—');
  const runMode = h('div', { class: 'muted' });
  const runRows = h('div', { style: 'margin-top:8px' });
  const unknown = h('div', { id: 'unknown-count', class: 'callout warn' });
  const cooldown = h('div', { class: 'callout warn' });
  const configError = h('div', { class: 'callout bad' });
  const runCard = h('section', { class: 'card' }, h('h2', { class: 'card-h' }, '运行'), runState, runMode, runRows, unknown, cooldown, configError);

  // ---- account card
  const loginLine = h('span', { id: 'login-account' });
  const accountCard = h('section', { class: 'card' },
    h('h2', { class: 'card-h' }, 'X 账号'),
    h('div', { class: 'row' }, h('span', {}, '当前登录'), loginLine),
    h('div', { class: 'muted small', style: 'margin-top:6px' }, '使用浏览器当前登录的账号。登录或过验证码请去"浏览器"页。'));

  // ---- model card
  const modelSummary = h('div', { id: 'model-summary' }, h('span', { class: 'muted' }, '读取中…'));
  const modelCard = h('section', { class: 'card' }, h('h2', { class: 'card-h' }, '模型', h('a', { href: '#/model', class: 'aside' }, '去配置 →')), modelSummary);

  // ---- logs card
  const logList = h('ul', { id: 'logs', class: 'logs' });
  const more = h('button', { class: 'linkbtn', type: 'button' }, '查看更多');
  const logsCard = h('section', { class: 'card span-all' },
    h('h2', { class: 'card-h' }, h('span', {}, '日志 ', h('span', { class: 'aside' }, '只显示运行事件，不含消息正文')), more), logList);

  set(root, h('div', { class: 'grid3' }, runCard, accountCard, modelCard, logsCard));

  // ---- behaviour
  function renderRun(s) {
    if (!s) { runState.textContent = '连接失败'; return; }
    runState.textContent = STATE_LABEL[s.control] ?? s.control;
    runMode.textContent = s.config ? MODE[s.config.mode] ?? s.config.mode : '';
    const usage = s.stats?.usage ?? {};
    set(runRows,
      h('div', { class: 'row' }, h('span', {}, '最近一轮'), h('span', {}, s.lastTick ? fmtTime(s.lastTick) : '尚未运行')),
      h('div', { class: 'row' }, h('span', {}, '待处理'), h('span', {}, '公开 ' + count(s.stats, 'public', ['queued', 'generating']) + ' · 私信 ' + count(s.stats, 'private', ['queued', 'generating']))),
      h('div', { class: 'row' }, h('span', {}, '草稿'), h('span', {}, String(count(s.stats, null, ['draft'])))),
      h('div', { class: 'row' }, h('span', {}, '累计 token'), h('span', {}, '输入 ' + (usage.input ?? 0) + ' · 输出 ' + (usage.output ?? 0))));
    const n = count(s.stats, null, ['unknown']);
    unknown.textContent = n > 0 ? n + ' 条发送结果待回查' : '';
    const cds = Object.entries(s.cooldown ?? {}).filter(([, until]) => Number(until) > (s.now ?? Date.now()));
    cooldown.textContent = cds.map(([ch, until]) => (CHANNEL[ch] ?? ch) + '通道退避至 ' + fmtDateTime(Number(until))).join('；');
    configError.textContent = s.configError ? '配置错误：' + s.configError : '';
  }

  function renderAccount(s) {
    const b = s?.browser ?? {};
    if (b.loggedIn && b.handle && !b.needsHuman) { loginLine.textContent = '@' + b.handle; loginLine.className = 'ok'; }
    else { loginLine.textContent = b.needsHuman ? '需要人工处理' : '未登录'; loginLine.className = 'muted'; }
  }

  async function loadModel() {
    try {
      const m = await api('/api/model');
      const e = m.effective;
      if (!e?.id) { set(modelSummary, h('div', { class: 'big', style: 'font-size:16px' }, '尚未配置'), h('div', { class: 'muted' }, '去模型页选择服务商和模型')); }
      else {
        const t = m.lastTest;
        set(modelSummary,
          h('div', { class: 'big', style: 'font-size:16px;overflow-wrap:anywhere' }, m.info?.name || e.id),
          h('div', { class: 'muted small', style: 'overflow-wrap:anywhere' }, [hostOf(e.baseUrl), m.source === 'panel' ? '面板配置' : '配置文件'].filter(Boolean).join(' · ')),
          h('div', { class: 'row', style: 'margin-top:8px' }, h('span', {}, '上次测试'),
            t ? h('span', { class: t.ok ? 'ok' : 'bad' }, (t.ok ? '通过' : '失败') + ' · ' + fmtTime(t.at)) : h('span', { class: 'muted' }, '尚未测试')));
      }
      if (m.configError) modelSummary.append(h('div', { class: 'callout bad' }, m.configError));
    } catch (e) {
      set(modelSummary, h('span', { class: 'bad' }, '读取失败：' + e.message));
    }
  }

  let expanded = false;
  function renderLogs(rows) {
    set(logList, rows.map(r => h('li', { dataset: { level: r.level } },
      h('span', { class: 't' }, fmtTime(r.at, true)), h('span', { class: 'e' }, r.event), h('span', { class: 'd' }, r.detail))));
  }
  async function loadMore() {
    try { renderLogs(await api('/api/logs')); } catch (e) { notice(e.message, 'error'); }
  }
  more.addEventListener('click', () => { expanded = !expanded; more.textContent = expanded ? '只看最近' : '查看更多'; if (expanded) loadMore(); });

  const offStatus = onStatus(s => { renderRun(s); renderAccount(s); });
  const offLogs = onLogs(rows => { if (expanded) loadMore(); else renderLogs(rows); });
  loadModel();
  return () => { offStatus(); offLogs(); };
}
