import { h } from './dom.js';

const LABELS = { 'list-or-steps': '含列表或步骤', markdown: '含 Markdown' };

// 只展示后端检查结果，不参与发送条件；旧记录没有结果时不标为通过。
export function formatNotice(format, { check = false } = {}) {
  if (!Array.isArray(format?.issues)) return null;
  const labels = [...new Set(format.issues)].map(issue => LABELS[issue]).filter(Boolean);
  if (!check && !labels.length) return null;
  return h('p', { class: 'small ' + (check ? 'reply-format-check' : 'reply-format-note') },
    (check ? '格式检查：' : '格式提示：') + (labels.join('、') || '通过'));
}
