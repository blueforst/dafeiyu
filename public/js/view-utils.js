import { h, set } from './dom.js';

export function field(label, input, hint = '') {
  if (input && typeof label === 'string' && typeof input.setAttribute === 'function' && /^(INPUT|SELECT|TEXTAREA)$/i.test(input.tagName || '') && !input.getAttribute('aria-label')) {
    input.setAttribute('aria-label', label);
  }
  return h('label', { class: 'field-label' }, h('span', { class: 'field', title: hint || undefined }, label, hint ? h('span', { class: 'field-tip', 'aria-label': hint }, ' ⓘ') : null), input);
}
export function empty(text = '暂无记录') { return h('div', { class: 'empty-state' }, text); }
export function json(value) { return h('pre', { class: 'pre-wrap' }, JSON.stringify(value, null, 2)); }
export function money(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '未知';
  const n = Number(value);
  return '$' + (n === 0 ? '0' : n < 0.01 ? n.toFixed(8).replace(/0+$/, '') : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
}
export function fmtUsdText(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return { text: '—', title: '' };
  const n = Number(value), abs = Math.abs(n), sign = n < 0 ? '-' : '';
  const exact = sign + '$' + (abs === 0 ? '0' : abs.toFixed(8).replace(/\.?0+$/, ''));
  if (abs === 0) return { text: '$0', title: exact };
  if (abs >= 1) return { text: sign + '$' + abs.toFixed(2), title: exact };
  const digits = Math.min(10, Math.max(2, Math.floor(-Math.log10(abs)) + 2));
  const rounded = Number(abs.toFixed(digits));
  if (rounded >= 1) return { text: sign + '$' + rounded.toFixed(2), title: exact };
  return { text: sign + '$' + abs.toFixed(digits).replace(/\.?0+$/, ''), title: exact };
}
export function fmtUsd(value) {
  const { text, title } = fmtUsdText(value);
  if (typeof document === 'undefined') return { text, title, textContent: text, toString: () => text };
  return h('span', { class: 'ws-usd' + (title ? '' : ' muted'), title: title || undefined }, text);
}
export function advanced(id, summary, ...content) {
  const key = 'ws:settings:advanced:' + id;
  let open = false;
  try { open = typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'; } catch { open = false; }
  const summaryEl = h('small', { class: 'ws-advanced-summary' }, typeof summary === 'function' ? summary() : (summary ?? ''));
  const details = h('details', {
    class: 'ws-advanced',
    dataset: { advancedId: id },
    open,
    ontoggle: () => {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, details.open ? '1' : '0'); } catch {}
    },
  },
    h('summary', { class: 'ws-advanced-head' }, h('b', {}, '高级设置'), summaryEl),
    h('div', { class: 'ws-advanced-body' }, ...content),
  );
  details.updateSummary = next => set(summaryEl, typeof next === 'function' ? next() : (next ?? ''));
  return details;
}
export function advancedDialog(id, title, ...content) {
  let opts = {};
  if (content.length === 1 && content[0] && typeof content[0] === 'object' && !(content[0] instanceof Node) && !Array.isArray(content[0]) && ('body' in content[0] || 'dirty' in content[0] || 'footer' in content[0])) {
    opts = content[0];
    content = Array.isArray(opts.body) ? opts.body : [opts.body];
  }
  const confirmBar = h('div', { class: 'confirm', hidden: true, role: 'alert' },
    h('span', {}, '有未保存的修改，离开会放弃这些修改。'),
    h('div', { class: 'confirm-actions' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { confirmBar.hidden = true; } }, '保留编辑'),
      h('button', { type: 'button', class: 'btn small danger', onclick: () => { confirmBar.hidden = true; opts.onDiscard?.(); forceClose(); } }, '放弃并离开')));
  const bodyHolder = h('div', { class: 'ws-dialog-body' }, ...content);
  const closeBtn = h('button', { type: 'button', class: 'btn small', 'aria-label': '关闭', onclick: () => requestClose() }, '关闭');
  const modal = h('div', { class: 'modal card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '高级设置', dataset: { advancedDialog: id } },
    h('div', { class: 'card-h' }, h('span', {}, title || '高级设置'), closeBtn),
    confirmBar,
    bodyHolder,
    opts.footer || null);
  const overlay = h('div', { class: 'modal-overlay', hidden: true, onclick: e => { if (e.target === overlay) requestClose(); } }, modal);
  function forceClose() {
    confirmBar.hidden = true;
    overlay.hidden = true;
    opts.onClose?.();
  }
  function requestClose() {
    if (opts.dirty?.()) {
      confirmBar.hidden = false;
      return false;
    }
    forceClose();
    return true;
  }
  const trigger = h('button', { type: 'button', class: 'ws-button', dataset: { advancedTrigger: id }, onclick: () => open() }, '⚙ 高级设置');
  function open() {
    confirmBar.hidden = true;
    opts.onOpen?.();
    overlay.hidden = false;
  }
  return { overlay, modal, trigger, open, close: requestClose, forceClose, body: bodyHolder };
}
let rowSelectionBound = false;
function ensureRowSelection() {
  if (rowSelectionBound || typeof document === 'undefined' || !document.body) return;
  rowSelectionBound = true;
  document.body.addEventListener('click', e => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const row = target.closest('tr, .ws-row-hover');
    if (!row || !row.querySelector('.ws-row-actions')) return;
    if (target.closest('button, a, input, select, textarea, label, summary, [role="button"]')) return;
    const scope = row.parentElement || document;
    for (const prev of scope.querySelectorAll('tr.selected, .ws-row-hover.selected')) {
      if (prev !== row) prev.classList.remove('selected');
    }
    row.classList.toggle('selected');
  });
}
export function rowActions(...buttons) {
  ensureRowSelection();
  return h('div', { class: 'ws-row-actions' }, ...buttons);
}
export function emptyLine(...items) {
  return h('div', { class: 'ws-empty-line' }, items.flat().filter(Boolean).map(text => h('span', {}, h('span', { class: 'ok-mark', 'aria-hidden': 'true' }, '✓'), text)));
}
export function tagInput(initialValues = [], onChange, { placeholder = '输入后回车添加', id, ariaLabel } = {}) {
  let items = [...new Set((initialValues || []).map(x => String(x ?? '').trim()).filter(Boolean))];
  const listEl = h('span', { class: 'ws-tag-items' });
  const inputEl = h('input', {
    type: 'text',
    class: 'ws-tag-input',
    id,
    placeholder,
    'aria-label': ariaLabel || placeholder,
    onkeydown: e => {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        if (commitRaw(inputEl.value)) inputEl.value = '';
        else inputEl.value = '';
      } else if (e.key === 'Backspace' && !inputEl.value && items.length) {
        items.pop();
        renderTags();
        onChange?.([...items]);
      }
    },
    onpaste: e => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (/[\r\n,，]/.test(text)) {
        e.preventDefault();
        commitRaw(text);
        inputEl.value = '';
      }
    },
    onblur: () => {
      if (inputEl.value.trim()) {
        commitRaw(inputEl.value);
        inputEl.value = '';
      }
    },
  });
  function commitRaw(raw) {
    const parts = String(raw ?? '').split(/[\r\n,，]+/).map(x => x.trim()).filter(Boolean);
    let changed = false;
    for (const part of parts) {
      if (!items.includes(part)) {
        items.push(part);
        changed = true;
      }
    }
    if (changed) {
      renderTags();
      onChange?.([...items]);
    }
    return changed;
  }
  function removeAt(idx) {
    items.splice(idx, 1);
    renderTags();
    onChange?.([...items]);
  }
  function renderTags() {
    set(listEl, items.map((val, idx) => h('span', { class: 'ws-tag-item' },
      h('span', { class: 'ws-tag-text' }, val),
      h('button', {
        type: 'button',
        class: 'ws-tag-remove',
        'aria-label': '删除 ' + val,
        onclick: e => { e.stopPropagation(); removeAt(idx); },
      }, '×'))));
  }
  renderTags();
  const box = h('div', {
    class: 'ws-tag-box',
    onclick: e => { if (e.target === box || e.target === listEl) inputEl.focus(); },
  }, listEl, inputEl);
  box.getValues = () => {
    if (inputEl.value.trim()) {
      commitRaw(inputEl.value);
      inputEl.value = '';
    }
    return [...items];
  };
  box.setValues = next => {
    items = [...new Set((next || []).map(x => String(x ?? '').trim()).filter(Boolean))];
    inputEl.value = '';
    renderTags();
  };
  box.input = inputEl;
  return box;
}
export function table(headings, rows) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', {}, h('tr', {}, headings.map(x => h('th', {}, x)))), h('tbody', {}, rows.map(row => h('tr', {}, row.map(x => h('td', {}, x)))))));
}
export function editorGuard(ctx, root, dirty) {
  let resolve;
  const banner = h('div', { class: 'confirm', hidden: true, role: 'alert' }, h('span', {}, '有未保存的修改，离开会放弃这些修改。'), h('div', { class: 'confirm-actions' },
    h('button', { type: 'button', class: 'btn small', onclick: () => answer(false) }, '保留编辑'),
    h('button', { type: 'button', class: 'btn small danger', onclick: () => answer(true) }, '放弃并离开')));
  root.prepend(banner);
  function answer(leave) { banner.hidden = true; resolve?.(leave); resolve = null; }
  const beforeUnload = e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  ctx.setLeaveGuard(() => {
    if (!dirty()) return true;
    if (!banner.isConnected) root.prepend(banner);
    banner.classList.toggle('confirm-over-modal', !!root.querySelector('.modal-overlay'));
    banner.hidden = false;
    banner.scrollIntoView({ block: 'nearest' });
    return new Promise(done => { resolve?.(false); resolve = done; });
  });
  window.addEventListener('beforeunload', beforeUnload);
  return () => { window.removeEventListener('beforeunload', beforeUnload); resolve?.(false); };
}
export function setBusy(button, busy, label) { button.disabled = busy; if (label) button.textContent = label; }
export function errorBox(root, error, retry) { set(root, h('div', { class: 'callout bad', role: 'alert' }, error.message || String(error)), retry ? h('button', { type: 'button', class: 'btn', onclick: retry }, '重新读取') : null); }

export function billingBadge() { return h('span', { class:'badge-billing', title:'此操作会调用模型并计入用量', 'aria-label':'会调用模型并计费', 'aria-describedby':'billing-charge-hint' }, '计费'); }
