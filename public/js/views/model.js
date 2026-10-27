// Model page: pick a pi provider (or a custom endpoint), pick a model, key, test, save.
import { h, set, fmtTime } from '../dom.js';
import { api } from '../api.js';
import { notice, refreshStatus } from '../state.js';
import * as F from './model-form.js';

const GROUPS = [['cn', '国内'], ['intl', '海外']];

export function mount(root, ctx) {
  let providers = [];
  let catalog = [];
  let discovered = null;          // { models:[{id,known,info}], total } for the current provider + host
  let keys = {};                  // slot -> '••••xxxx'
  let form = F.emptyForm();
  let loadedInfo = null;          // { id, info } from GET /api/model for the saved model
  let typedKey = '';
  let originSlot = '';
  let baseUrlEdited = false;
  let savedSig = '';
  let testedSig = null;
  let busy = false;
  let alive = true;
  let leaveResolve = null;

  // ---------------------------------------------------------------- elements
  const providerSelect = h('button', { id: 'provider-select', class: 'select', type: 'button' });
  const providerSearch = h('input', { id: 'provider-search', class: 'input', placeholder: '搜索服务商…', autocomplete: 'off' });
  const providerItems = h('div', { class: 'opts' });
  const providerPop = h('div', { id: 'provider-list', class: 'popover', hidden: true }, providerSearch, providerItems);

  const baseUrl = h('input', { id: 'base-url', class: 'input', placeholder: 'https://…/v1', autocomplete: 'off', spellcheck: 'false' });
  const baseUrlChip = h('span', { class: 'chip' });
  const apiGroup = h('div', { id: 'api-group', class: 'radios three' },
    F.CUSTOM_APIS.map(a => h('label', { class: 'radio-card' }, h('input', { type: 'radio', name: 'api', value: a.value }), h('b', {}, a.title), h('span', {}, a.hint))));
  const apiField = h('div', {}, h('div', { class: 'field' }, '接口协议 ', h('span', { class: 'faint' }, '（中转站用哪种由它决定，pi 无法得知）')), apiGroup);

  const apiKey = h('input', { id: 'api-key', class: 'input', type: 'password', placeholder: '粘贴 API Key', autocomplete: 'new-password', spellcheck: 'false' });
  const keyState = h('span', { id: 'key-state', class: 'key-state' });

  const modelInput = h('input', { id: 'model-input', class: 'input', placeholder: '选择或直接填写模型 id', autocomplete: 'off', spellcheck: 'false' });
  const discoverBtn = h('button', { id: 'discover', class: 'btn', type: 'button' }, '用 Key 拉取');
  const modelSearch = h('input', { id: 'model-search', class: 'input', placeholder: '搜索模型…', autocomplete: 'off' });
  const modelHead = h('div', { class: 'pop-head' });
  const modelItems = h('div', { class: 'opts' });
  const modelPop = h('div', { id: 'model-list', class: 'popover', hidden: true }, h('div', { class: 'pop-search' }, modelSearch, modelHead), modelItems);

  const modelInfo = h('div', { id: 'model-info', class: 'info' });
  const reasoningGroup = h('div', { id: 'reasoning-group', class: 'radios' });
  const reasoningField = h('div', {}, h('div', { class: 'field' }, '推理强度 ', h('span', { class: 'faint' }, '（档位来自 pi）')), reasoningGroup);

  const maxTokens = h('input', { id: 'max-tokens', class: 'input', type: 'number', min: 64, max: 8192, step: 1 });
  const timeout = h('input', { id: 'timeout', class: 'input', type: 'number', min: 1, max: 180, step: 1 });
  const advanced = h('details', { id: 'advanced', class: 'advanced' },
    h('summary', {}, '高级'),
    h('div', { class: 'two' },
      h('div', {}, h('label', { class: 'field', for: 'max-tokens' }, '回复长度上限（token）'), maxTokens, h('div', { class: 'faint small' }, '只限制看得见的回复；开推理时推理额度另加')),
      h('div', {}, h('label', { class: 'field', for: 'timeout' }, '超时（秒）'), timeout)));

  const testBtn = h('button', { id: 'test', class: 'btn', type: 'button' }, '测试连接');
  const saveBtn = h('button', { id: 'save', class: 'btn primary', type: 'button' }, '保存');
  const testResult = h('span', { id: 'test-result', class: 'test-result' });

  const confirmSave = h('div', { id: 'confirm-save', class: 'confirm', hidden: true },
    h('span', {}, '未通过测试，仍要保存吗'),
    h('span', { class: 'confirm-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { confirmSave.hidden = true; } }, '取消'),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => { confirmSave.hidden = true; doSave(); } }, '仍然保存')));
  const confirmLeave = h('div', { id: 'confirm-leave', class: 'confirm', hidden: true },
    h('span', {}, '有未保存的修改，确定离开吗'),
    h('span', { class: 'confirm-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => answerLeave(false) }, '留下'),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => answerLeave(true) }, '离开')));

  const formBody = h('div', { class: 'form-body' },
    h('label', { class: 'field', for: 'base-url' }, 'Base URL'), h('div', { class: 'with-chip' }, baseUrl, baseUrlChip),
    apiField,
    h('label', { class: 'field', for: 'api-key' }, 'API Key'), apiKey, keyState,
    h('label', { class: 'field', for: 'model-input' }, '模型'),
    h('div', { class: 'dropdown' }, h('div', { class: 'inline' }, modelInput, discoverBtn), modelPop),
    modelInfo, reasoningField, advanced,
    h('div', { class: 'form-foot' }, testBtn, saveBtn, testResult),
    h('div', { class: 'faint small' }, '测试连接会真实请求一次模型，会产生少量费用。'),
    confirmSave);

  set(root, h('div', { class: 'form-wrap' },
    confirmLeave,
    h('h1', { class: 'page-title' }, '模型'),
    h('p', { class: 'muted page-desc' }, '通过 pi 适配器调用。保存后下一轮处理生效，不用重启。'),
    h('label', { class: 'field', for: 'provider-select' }, '服务商'),
    h('div', { class: 'dropdown' }, providerSelect, providerPop),
    formBody));

  // ---------------------------------------------------------------- derived state
  const isCustom = () => form.provider === 'custom';
  const providerById = id => providers.find(p => p.id === id);
  function currentInfo() {
    const id = form.id.trim();
    if (!id) return null;
    const fromDiscovery = discovered?.models.find(m => m.id === id)?.info;
    if (isCustom()) return fromDiscovery ?? (loadedInfo?.id === id ? loadedInfo.info : null);
    return catalog.find(m => m.id === id) ?? fromDiscovery ?? null;
  }
  const levels = () => F.levelsOf(currentInfo(), form.provider, form.custom);
  const settingsSig = () => JSON.stringify(F.settingsFrom(form, !!currentInfo()));
  // What a passing test vouches for: the settings plus the key that was typed for it.
  const testSig = () => JSON.stringify([F.settingsFrom(form, !!currentInfo()), typedKey]);
  const dirty = () => !!form.provider && (settingsSig() !== savedSig || typedKey !== '');

  // ---------------------------------------------------------------- rendering
  function renderProviders() {
    const q = providerSearch.value.trim().toLowerCase();
    const match = p => !q || p.id.includes(q) || p.name.toLowerCase().includes(q);
    const groups = GROUPS.map(([g, label]) => [label, providers.filter(p => p.group === g && match(p))]).filter(([, list]) => list.length);
    const customMatch = !q || '自定义 custom 中转站'.includes(q);
    set(providerItems,
      groups.map(([label, list]) => [h('div', { class: 'grp' }, label),
        list.map(p => h('button', { class: 'opt' + (p.id === form.provider ? ' on' : ''), type: 'button', dataset: { provider: p.id }, onclick: () => selectProvider(p.id) },
          h('span', {}, p.name), h('span', { class: 'chip' }, p.modelCount + ' 个模型')))]),
      customMatch ? [h('div', { class: 'grp' }, '其他'),
        h('button', { class: 'opt' + (isCustom() ? ' on' : ''), type: 'button', dataset: { provider: 'custom' }, onclick: () => selectProvider('custom') },
          h('span', {}, h('b', {}, '自定义'), h('span', { class: 'faint' }, '　中转站、自建服务')), h('span', { class: 'chip' }, '手填地址'))] : null,
      !groups.length && !customMatch ? h('div', { class: 'empty' }, '没有匹配的服务商') : null);
  }

  function modelRows() {
    if (isCustom()) return (discovered?.models ?? []).map(m => ({ id: m.id, info: m.info ?? null, tag: m.known ? ['pi 已识别', 'g'] : ['需手填参数', 'o'] }));
    const available = discovered ? new Set(discovered.models.map(m => m.id)) : null;
    const rows = catalog.map(m => ({ id: m.id, info: m, tag: available ? (available.has(m.id) ? ['可用', 'g'] : ['接口未返回', 'dim']) : null }));
    for (const m of discovered?.models ?? []) if (!catalog.some(c => c.id === m.id)) rows.push({ id: m.id, info: null, tag: ['仅接口', 'o'] });
    return rows;
  }

  function renderModels() {
    const q = modelSearch.value.trim().toLowerCase();
    const rows = modelRows();
    const shown = rows.filter(r => !q || r.id.toLowerCase().includes(q) || (r.info?.name ?? '').toLowerCase().includes(q));
    if (discovered) {
      const head = isCustom() ? '接口返回 ' + discovered.total + ' 个' : 'Key 可用 ' + rows.filter(r => r.tag?.[0] === '可用').length + ' / ' + catalog.length;
      modelHead.textContent = head + (discovered.total > discovered.models.length ? '（只显示前 ' + discovered.models.length + ' 个）' : '');
    } else modelHead.textContent = isCustom() ? '先填地址和 Key，再点"用 Key 拉取"' : 'pi 目录 · ' + catalog.length + ' 个模型';
    set(modelItems, shown.length ? shown.map(r => h('button', { class: 'opt model' + (r.id === form.id ? ' on' : '') + (r.tag?.[1] === 'dim' ? ' dim' : ''), type: 'button', dataset: { model: r.id }, onclick: () => selectModel(r.id) },
      h('span', { class: 'opt-name' }, r.info?.name && r.info.name !== r.id ? [r.info.name, h('small', {}, r.id)] : r.id),
      h('span', { class: 'chips' },
        h('span', { class: 'chip' }, r.info ? F.fmtTokens(r.info.contextWindow) : '—'),
        r.info?.reasoning ? h('span', { class: 'chip b' }, '推理') : null,
        r.info?.vision ? h('span', { class: 'chip' }, '看图') : null,
        r.tag ? h('span', { class: 'chip ' + r.tag[1] }, r.tag[0]) : null)))
      : h('div', { class: 'empty' }, rows.length ? '没有匹配的模型' : '暂无模型'));
  }

  let infoKey = '';
  function renderInfo() {
    const info = currentInfo();
    const key = [form.provider, form.id, !!info].join('|');
    if (key === infoKey) return;
    infoKey = key;
    if (!form.id.trim()) { set(modelInfo, h('div', { class: 'faint' }, '选择或填写模型后显示模型信息')); return; }
    if (info) {
      set(modelInfo,
        h('div', { class: 'info-h' }, h('span', {}, '模型信息'), h('span', { class: 'ok small' }, isCustom() ? 'pi 已识别 · 自动带出' : 'pi 提供 · 只读')),
        h('div', { class: 'info-grid' },
          h('div', {}, h('span', {}, '协议'), h('b', {}, F.API_LABEL[isCustom() ? form.api : info.api] ?? info.api)),
          h('div', {}, h('span', {}, '上下文'), h('b', {}, F.fmtTokens(info.contextWindow))),
          h('div', {}, h('span', {}, '最大输出'), h('b', {}, F.fmtTokens(info.maxTokens))),
          h('div', {}, h('span', {}, '价格 / 百万 token'), h('b', {}, F.fmtPrice(info.cost)))),
        h('div', { class: 'chips', style: 'margin-top:8px' }, h('span', { class: 'chip' + (info.reasoning ? ' b' : '') }, info.reasoning ? '支持推理' : '不支持推理'), h('span', { class: 'chip' }, info.vision ? '能看图（本期不用）' : '不能看图')));
      return;
    }
    if (!isCustom()) {
      set(modelInfo, h('div', { class: 'info-h' }, h('span', {}, '模型信息'), h('span', { class: 'warn small' }, 'pi 目录里没有')), h('div', { class: 'muted small' }, '按保守参数调用：上下文 128K、不开推理。'));
      return;
    }
    const ctxInput = h('input', { id: 'custom-context', class: 'input', type: 'number', min: 1000, step: 1000, value: String(form.custom.contextWindow) });
    const reasonInput = h('input', { id: 'custom-reasoning', type: 'checkbox', checked: !!form.custom.reasoning });
    ctxInput.addEventListener('input', () => { form.custom.contextWindow = Number(ctxInput.value); update(); });
    reasonInput.addEventListener('change', () => { form.custom.reasoning = reasonInput.checked; if (!levels().includes(form.reasoningLevel)) form.reasoningLevel = F.defaultLevel(levels()); update(); });
    set(modelInfo,
      h('div', { class: 'info-h' }, h('span', {}, '模型信息'), h('span', { class: 'warn small' }, 'pi 认不出 · 需手填参数')),
      h('div', { class: 'two' },
        h('div', {}, h('label', { class: 'field', for: 'custom-context' }, '上下文长度（token）'), ctxInput),
        h('div', {}, h('div', { class: 'field' }, '推理'), h('label', { class: 'check' }, reasonInput, '支持推理'))));
  }

  let levelsKey = '';
  function renderReasoning() {
    const list = levels();
    reasoningField.hidden = list.length === 1 && list[0] === 'off';
    const key = list.join(',');
    if (key !== levelsKey) {
      levelsKey = key;
      set(reasoningGroup, list.map(l => h('label', { class: 'radio-card' },
        h('input', { type: 'radio', name: 'reasoning', value: l, onchange: () => { form.reasoningLevel = l; update(); } }), h('b', {}, F.LEVEL_LABEL[l] ?? l))));
    }
    for (const r of reasoningGroup.querySelectorAll('input')) r.checked = r.value === form.reasoningLevel;
  }

  function renderKeyState() {
    const slot = F.slotOf(form.provider, form.baseUrl);
    keyState.className = 'key-state';
    if (slot && keys[slot]) { keyState.textContent = '已设置 ' + keys[slot] + (typedKey ? '，保存后替换为新填写的 Key' : ''); keyState.classList.add('ok'); }
    else if (originSlot && slot !== originSlot && keys[originSlot]) { keyState.textContent = '地址的主机变了，请重新填写 Key'; keyState.classList.add('warn'); }
    else keyState.textContent = '';
  }

  function update() {
    const p = providerById(form.provider);
    set(providerSelect, h('span', {}, isCustom() ? '自定义 · 中转站、自建服务' : p?.name ?? (form.provider || '请选择服务商')), h('span', { class: 'chev', 'aria-hidden': 'true' }));
    formBody.hidden = !form.provider;
    if (baseUrl.value !== form.baseUrl) baseUrl.value = form.baseUrl;
    baseUrlChip.textContent = isCustom() || !form.provider ? '' : baseUrlEdited ? '已修改' : 'pi 预设 · 可改';
    baseUrlChip.hidden = !baseUrlChip.textContent;
    apiField.hidden = !isCustom();
    for (const r of apiGroup.querySelectorAll('input')) r.checked = r.value === form.api;
    if (modelInput.value !== form.id) modelInput.value = form.id;
    if (document.activeElement !== maxTokens) maxTokens.value = String(form.maxTokens);
    if (document.activeElement !== timeout) timeout.value = String(form.timeoutSec);
    discoverBtn.disabled = busy || !form.baseUrl.trim() || (isCustom() && !form.api);
    testBtn.disabled = saveBtn.disabled = busy || !form.provider || !form.id.trim();
    renderKeyState();
    renderInfo();
    renderReasoning();
    if (!providerPop.hidden) renderProviders();
    if (!modelPop.hidden) renderModels();
  }

  // ---------------------------------------------------------------- actions
  function closePops() { providerPop.hidden = true; modelPop.hidden = true; }
  function clearTypedKey() { typedKey = ''; apiKey.value = ''; }

  async function selectProvider(id) {
    closePops();
    if (id === form.provider) return;
    clearTypedKey();
    discovered = null;
    catalog = [];
    baseUrlEdited = false;
    form = { ...F.emptyForm(), provider: id, maxTokens: form.maxTokens, timeoutSec: form.timeoutSec };
    if (id !== 'custom') form.baseUrl = providerById(id)?.baseUrl ?? '';
    originSlot = F.slotOf(form.provider, form.baseUrl);
    update();
    if (id === 'custom') return;
    try {
      const list = await api('/api/model/providers/' + encodeURIComponent(id) + '/models');
      if (!alive || form.provider !== id) return;
      catalog = list;
      update();
    } catch (e) { notice(e.message, 'error'); }
  }

  function setBaseUrl(value, byUser) {
    if (F.hostOf(value) !== F.hostOf(form.baseUrl)) { clearTypedKey(); discovered = null; }
    form.baseUrl = value;
    if (byUser) baseUrlEdited = true;
  }

  function selectModel(id) {
    modelPop.hidden = true;
    form.id = id;
    const info = currentInfo();
    if (!isCustom() && !baseUrlEdited && info?.baseUrl) setBaseUrl(info.baseUrl, false);
    if (info && form.maxTokens > info.maxTokens) form.maxTokens = info.maxTokens;
    form.reasoningLevel = F.defaultLevel(levels());
    update();
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true; update();
    try { await fn(); } finally { busy = false; if (alive) update(); }
  }

  const discoverNow = () => withBusy(async () => {
    try {
      discovered = await api('/api/model/discover', { method: 'POST', timeoutMs: 25000, body: { provider: form.provider, baseUrl: form.baseUrl.trim(), api: isCustom() ? form.api : undefined, apiKey: typedKey || undefined } });
      modelSearch.value = '';
      providerPop.hidden = true; modelPop.hidden = false;
      notice('拉取到 ' + discovered.total + ' 个模型', 'ok');
    } catch (e) { notice(e.message, 'error'); }
  });

  const testNow = () => withBusy(async () => {
    const settings = F.settingsFrom(form, !!currentInfo());
    const sig = testSig();
    testedSig = null;
    testResult.className = 'test-result muted';
    testResult.textContent = '测试中…';
    try {
      const r = await api('/api/model/test', { method: 'POST', timeoutMs: settings.timeoutMs + 15000, body: { settings, apiKey: typedKey || undefined } });
      testedSig = r.ok ? sig : null;
      testResult.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
      testResult.textContent = r.ok
        ? '✓ 测试通过 · ' + (r.latencyMs / 1000).toFixed(1) + ' 秒' + (r.input !== undefined ? ' · 输入 ' + r.input + ' / 输出 ' + r.output + ' token' : '')
        : '✗ 测试失败：' + (r.error || '未知错误');
    } catch (e) {
      testResult.className = 'test-result bad';
      testResult.textContent = '✗ ' + e.message;
    }
  });

  const doSave = () => withBusy(async () => {
    const settings = F.settingsFrom(form, !!currentInfo());
    const wasTested = testedSig === testSig();
    try {
      const r = await api('/api/model', { method: 'PUT', body: { settings, apiKey: typedKey || undefined } });
      keys = r.keys ?? keys;
      clearTypedKey();
      form = F.formFrom(r.settings);
      originSlot = F.slotOf(form.provider, form.baseUrl);
      savedSig = settingsSig();
      testedSig = wasTested ? testSig() : null;
      notice('已保存，下一轮处理生效', 'ok');
      refreshStatus();
    } catch (e) { notice(e.message, 'error'); }
  });

  function askLeave() {
    confirmLeave.hidden = false;
    confirmLeave.scrollIntoView({ block: 'nearest' });
    return new Promise(resolve => { leaveResolve = resolve; });
  }
  function answerLeave(ok) {
    confirmLeave.hidden = true;
    const r = leaveResolve; leaveResolve = null;
    r?.(ok);
  }

  // ---------------------------------------------------------------- events
  providerSelect.addEventListener('click', e => { e.stopPropagation(); modelPop.hidden = true; providerPop.hidden = !providerPop.hidden; if (!providerPop.hidden) { providerSearch.value = ''; renderProviders(); providerSearch.focus(); } });
  providerSearch.addEventListener('input', renderProviders);
  baseUrl.addEventListener('input', () => { setBaseUrl(baseUrl.value, true); update(); });
  apiGroup.addEventListener('change', e => { if (e.target.name === 'api') { form.api = e.target.value; discovered = null; update(); } });
  apiKey.addEventListener('input', () => { typedKey = apiKey.value.trim(); renderKeyState(); });
  const openModels = e => { e.stopPropagation(); providerPop.hidden = true; if (modelPop.hidden) { modelSearch.value = ''; modelPop.hidden = false; renderModels(); } };
  modelInput.addEventListener('click', openModels);
  modelInput.addEventListener('focus', openModels);
  modelInput.addEventListener('input', () => { form.id = modelInput.value; if (!levels().includes(form.reasoningLevel)) form.reasoningLevel = F.defaultLevel(levels()); update(); });
  modelSearch.addEventListener('input', renderModels);
  for (const pop of [providerPop, modelPop]) pop.addEventListener('click', e => e.stopPropagation());
  const onDocClick = () => closePops();
  document.addEventListener('click', onDocClick);
  discoverBtn.addEventListener('click', e => { e.stopPropagation(); discoverNow(); });
  maxTokens.addEventListener('input', () => { form.maxTokens = maxTokens.value === '' ? '' : Number(maxTokens.value); update(); });
  timeout.addEventListener('input', () => { form.timeoutSec = timeout.value === '' ? '' : Number(timeout.value); update(); });
  testBtn.addEventListener('click', testNow);
  saveBtn.addEventListener('click', () => { if (testedSig !== testSig()) { confirmSave.hidden = false; return; } confirmSave.hidden = true; doSave(); });

  const onBeforeUnload = e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  ctx?.setLeaveGuard?.(() => (dirty() ? askLeave() : true));

  // ---------------------------------------------------------------- load
  formBody.hidden = true;
  providerSelect.disabled = true;
  set(providerSelect, h('span', { class: 'muted' }, '读取中…'));
  (async () => {
    try {
      const [m, provs] = await Promise.all([api('/api/model'), api('/api/model/providers')]);
      if (!alive) return;
      providers = provs;
      keys = m.keys ?? {};
      clearTypedKey();
      if (m.settings) form = F.formFrom(m.settings);
      else if (m.effective?.baseUrl || m.effective?.id) form = { ...F.emptyForm(), provider: 'custom', baseUrl: m.effective.baseUrl ?? '', api: m.effective.api || 'openai-completions', id: m.effective.id ?? '' };
      loadedInfo = m.info && m.effective?.id ? { id: m.effective.id, info: m.info } : null;
      if (form.provider && !isCustom()) catalog = await api('/api/model/providers/' + encodeURIComponent(form.provider) + '/models').catch(() => []);
      const info = currentInfo();
      baseUrlEdited = !isCustom() && !!form.provider && form.baseUrl !== providerById(form.provider)?.baseUrl && form.baseUrl !== info?.baseUrl;
      originSlot = F.slotOf(form.provider, form.baseUrl);
      savedSig = settingsSig();
      const t = m.lastTest;
      if (t?.ok && t.provider === form.provider && t.id === form.id) {
        testedSig = testSig();
        testResult.className = 'test-result ok';
        testResult.textContent = '✓ 上次测试通过 · ' + fmtTime(t.at);
      }
      if (m.configError) notice('配置错误：' + m.configError, 'error');
      providerSelect.disabled = false;
      update();
    } catch (e) {
      notice('读取模型设置失败：' + e.message, 'error');
    }
  })();

  return () => {
    alive = false;
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('beforeunload', onBeforeUnload);
    answerLeave(true);
  };
}
