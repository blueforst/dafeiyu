import { h, set } from './dom.js';

export function field(label, input, hint = '') {
  return h('label', { class: 'field-label' }, h('span', { class: 'field', title: hint || undefined }, label, hint ? h('span', { class: 'field-tip', 'aria-label': hint }, ' ⓘ') : null), input);
}
export function empty(text = '暂无记录') { return h('div', { class: 'empty-state' }, text); }
export function json(value) { return h('pre', { class: 'pre-wrap' }, JSON.stringify(value, null, 2)); }
export function money(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '未知';
  const n = Number(value);
  return '$' + (n === 0 ? '0' : n < 0.01 ? n.toFixed(8).replace(/0+$/, '') : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
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
