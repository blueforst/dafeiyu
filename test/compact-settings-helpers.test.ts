import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsdText, fmtUsd } from '../public/js/view-utils.js';
import { groupRuns } from '../public/js/views/task-settings.js';
import { EVENT_SUMMARY, summarizeLogEvent, formatBeijingDayDivider } from '../public/js/views/program.js';

test('fmtUsd 与 fmtUsdText 按两位有效小数格式化美元边界值并保留精确悬停值', () => {
  assert.deepEqual(fmtUsdText(null), { text: '—', title: '' });
  assert.deepEqual(fmtUsdText(undefined), { text: '—', title: '' });
  assert.deepEqual(fmtUsdText(NaN), { text: '—', title: '' });
  assert.deepEqual(fmtUsdText(0), { text: '$0', title: '$0' });
  assert.deepEqual(fmtUsdText(0.00001), { text: '$0.00001', title: '$0.00001' });
  assert.deepEqual(fmtUsdText(0.0002454), { text: '$0.00025', title: '$0.0002454' });
  assert.deepEqual(fmtUsdText(0.0011), { text: '$0.0011', title: '$0.0011' });
  assert.deepEqual(fmtUsdText(0.04840811), { text: '$0.048', title: '$0.04840811' });
  assert.deepEqual(fmtUsdText(1.5), { text: '$1.50', title: '$1.5' });
  assert.deepEqual(fmtUsdText(12.3456), { text: '$12.35', title: '$12.3456' });
  assert.equal(String(fmtUsd(0.0002454)), '$0.00025');
});

test('groupRuns 合并连续成功记录，拆开失败与运行中记录，并支持跨页拼接', () => {
  const page1 = [
    { id: 'r1', taskId: 'health', status: 'completed', startedAt: 10000, durationMs: 100 },
    { id: 'r2', taskId: 'health', status: 'completed', startedAt: 9000, durationMs: 200 },
    { id: 'r3', taskId: 'health', status: 'failed', startedAt: 8000, durationMs: 50, error: 'timeout' },
    { id: 'r4', taskId: 'health', status: 'completed', startedAt: 7000, durationMs: 120 },
  ];
  const groups1 = groupRuns(page1);
  assert.equal(groups1.length, 3);
  assert.equal(groups1[0].kind, 'group');
  assert.equal(groups1[0].count, 2);
  assert.equal(groups1[0].avgDurationMs, 150);
  assert.equal(groups1[0].totalCostUSD, null);
  assert.equal(groups1[1].kind, 'single');
  assert.equal(groups1[1].status, 'failed');
  assert.equal(groups1[2].kind, 'single');
  assert.equal(groups1[2].items[0].id, 'r4');

  // 跨页拼接：把上一页结果或列表与新一页拼接，r4 与 r5 合并为一组
  const page2 = [
    { id: 'r5', taskId: 'health', status: 'completed', startedAt: 6000, durationMs: 80, fees: { estimatedUsd: 0.002 } },
    { id: 'r6', taskId: 'daily-report', status: 'started', startedAt: 5000, durationMs: 10 },
    { id: 'r7', taskId: 'daily-report', status: 'started', startedAt: 4000, durationMs: 20 },
  ];
  const combined = groupRuns([...groups1, ...page2]);
  assert.equal(combined.length, 5);
  assert.equal(combined[2].kind, 'group');
  assert.equal(combined[2].count, 2);
  assert.equal(combined[2].avgDurationMs, 100);
  assert.equal(combined[2].totalCostUSD, 0.002);
  // 运行中不合并
  assert.equal(combined[3].kind, 'single');
  assert.equal(combined[3].status, 'started');
  assert.equal(combined[4].kind, 'single');
  assert.equal(combined[4].status, 'started');
});

test('EVENT_SUMMARY 与 summarizeLogEvent 覆盖已登记事件类型并回退未知类型', () => {
  for (const [type, def] of Object.entries(EVENT_SUMMARY)) {
    const out = summarizeLogEvent({
      event: type,
      detail: JSON.stringify({ provider: 'deepseek', name: '测试人设', revision: 3, control: 'paused', missing: ['自动化标签'] }),
    });
    assert.equal(out.category, def.category);
    assert.ok(typeof out.summary === 'string' && out.summary.length > 0, `事件 ${type} 摘要为空`);
  }

  const fallback = summarizeLogEvent({ event: 'custom-unknown-event', detail: '原始说明文本' });
  assert.equal(fallback.category, 'custom-unknown-event');
  assert.equal(fallback.summary, '原始说明文本');

  const now = Date.parse('2026-10-29T12:00:00+08:00');
  assert.equal(formatBeijingDayDivider(now, now), '今天 · 10/29');
  assert.equal(formatBeijingDayDivider(now - 86400_000, now), '昨天 · 10/28');
  assert.equal(formatBeijingDayDivider(now - 2 * 86400_000, now), '10/27');
});
