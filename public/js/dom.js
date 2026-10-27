// Tiny DOM builder. Text always goes in as text nodes; never innerHTML.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function set(el, ...children) { el.replaceChildren(); return append(el, children); }

const tz = { timeZone: 'Asia/Shanghai', hour12: false };
export function fmtTime(ms, seconds = false) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('zh-CN', { ...tz, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
}
export function fmtDateTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('zh-CN', { ...tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
