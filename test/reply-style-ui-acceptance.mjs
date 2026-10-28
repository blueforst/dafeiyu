// 服务器隔离 Camoufox：回复文风仅作提示；合成 API，不连接生产、X 或真实模型。
import { observer } from '/opt/role-camoufox/launch.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = resolve(process.env.PUBLIC_DIR || '/app/public');
const OUT = process.env.ARTIFACT_DIR || '/artifacts';
mkdirSync(OUT, { recursive: true });
const report = { evidence: '服务器隔离 Camoufox，合成 API；未访问生产、X 或真实模型；仅验证格式标记的界面展示', checks: [], errors: [], screenshots: [], requests: [], blockedOrigins: [] };
const clone = value => structuredClone(value);
const timestamp = Date.parse('2026-10-28T08:00:00+08:00');
const BOTH = ['list-or-steps', 'markdown'];
const persona = { sections: [{ id: 'identity', title: '静态人格', content: '这是界面验收用的合成人设。说简短的日常口语。' }], triggers: [] };
const originalHints = { lateEnabled: true, lateMinutes: 60, languageEnabled: true, openingEnabled: false, openingCount: 7, expressionEnabled: true, kaomojiPer10: 1, emojiPer10: 2, tildePer10: 1, replyCheckEnabled: true };
const state = { control: 'paused', busy: false, accountId: 'fixture_worker', browser: { loggedIn: true, needsHuman: false, handle: 'fixture_worker' }, config: { mode: 'draft', model: { configured: true, provider: 'fixture', id: 'fixture-model' } }, configError: '', cooldown: {}, now: timestamp };
const recent = { note: '以下是你和对方最近的往来；reply 是你已经发出的原话。这次避免重复。', items: [{ id: 'recent-1', channel: 'public', message: '今天下雨了吗', reply: '窗外刚停，路边的树还滴着水。', timestamp: timestamp - 86400000 }] };
const segments = [
  { kind: 'system', title: '固定约束与静态人格', role: 'system', stable: true, content: '使用日常口语。' },
  { kind: 'memory', title: '关于对方的记忆', role: 'user', stable: false, content: JSON.stringify({ memories: [] }) },
  { kind: 'recent', title: '与对方的近期往来', role: 'user', stable: false, content: JSON.stringify(recent) },
  { kind: 'conversation', title: '当前对话', role: 'user', stable: false, content: '模拟当前对话。' },
];
let savedHints, hintsRevision, previewFormat, previewCount, items, runs, caseId = 0;
function reset() {
  savedHints = clone(originalHints); hintsRevision = 3; previewFormat = { issues: [] }; previewCount = 0;
  items = [
    { id: 'draft-keep', messageId: 'draft-keep', type: 'reply', status: 'draft', revision: 1, handle: 'Draft_User', at: timestamp + 4000, original: { text: '这段回复可以吗' }, draft: { action: 'reply', text: '1. **先看窗外**\n2. 再聊今天的天气', format: { issues: BOTH } } },
    { id: 'draft-edit', messageId: 'draft-edit', type: 'dm', status: 'draft', revision: 2, handle: 'Edit_User', at: timestamp + 3000, original: { text: '换成普通口语吧' }, draft: { action: 'reply', text: '1. 看看天气\n2. 出门走走', format: { issues: ['list-or-steps'] } } },
    { id: 'sent-reply', messageId: 'sent-reply', type: 'reply', status: 'confirmed', revision: 1, handle: 'Sent_User', at: timestamp + 2000, original: { text: '已经发出的回复' }, draft: { action: 'reply', text: '**下雨天也能慢慢过。**', format: { issues: ['markdown'] } }, receipt: { status: 'confirmed' } },
    { id: 'sent-dm', messageId: 'sent-dm', type: 'dm', status: 'confirmed', revision: 1, handle: 'Private_User', at: timestamp + 1000, original: { text: '已经发出的私信' }, draft: { action: 'reply', text: '第一步看看窗外，第二步回来聊天。', format: { issues: ['list-or-steps'] } }, receipt: { status: 'confirmed' } },
    { id: 'post-morning', runId: 'morning-run', taskRunId: 'morning-run', type: 'post', taskId: 'morning-post', status: 'confirmed', at: timestamp, text: '## 早上好\n窗外终于放晴。', format: { issues: ['markdown'] }, receipt: { status: 'confirmed' } },
    { id: 'legacy-message', messageId: 'legacy-message', type: 'reply', status: 'confirmed', revision: 1, at: timestamp - 1000, draft: { action: 'reply', text: '旧记录没有格式字段。' } },
  ];
  runs = [
    { id: 'morning-run', taskId: 'morning-post', status: 'completed', startedAt: timestamp, scheduledAt: timestamp, durationMs: 140, source: 'schedule', accountId: 'fixture_worker', outboxId: 'outbox-morning', calls: [], result: { text: '## 早上好\n窗外终于放晴。', format: { issues: ['markdown'] } }, fees: { estimatedUsd: 0 } },
    { id: 'evening-run', taskId: 'evening-post', status: 'completed', startedAt: timestamp - 3600000, scheduledAt: timestamp - 3600000, durationMs: 120, source: 'manual', accountId: 'fixture_worker', calls: [], result: { text: '1. **看看月亮**\n2. 早点休息', format: { issues: BOTH } }, fees: { estimatedUsd: 0 } },
    { id: 'legacy-run', taskId: 'morning-post', status: 'completed', startedAt: timestamp - 86400000, scheduledAt: timestamp - 86400000, durationMs: 100, source: 'schedule', accountId: 'fixture_worker', calls: [], result: { text: '旧的早安记录。' }, fees: { estimatedUsd: 0 } },
  ];
}
reset();
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined; }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname, method = req.method;
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (path.startsWith('/api/')) {
      const body = method === 'GET' ? undefined : await readBody(req);
      report.requests.push({ path, method, ...(body ? { body } : {}) });
      if (path === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write('retry: 60000\n\n'); return; }
      if (method !== 'GET') assert.equal(req.headers['x-workflow-control'], '1');
      if (path === '/api/status') return send(res, 200, state);
      if (path === '/api/persona') return send(res, 200, { persona, revision: 0, fixedRules: '明确是 AI 自动回复。' });
      if (path === '/api/persona/daily') return send(res, 200, { status: 'missing', date: '2026-10-28', history: [], scheduleTime: '06:00' });
      if (path === '/api/persona/prompt-hints') {
        if (method === 'PUT') { assert.equal(body.revision, hintsRevision); savedHints = clone(body.promptHints); hintsRevision++; }
        return send(res, 200, { promptHints: savedHints, revision: hintsRevision });
      }
      if (path === '/api/persona/preview' && method === 'POST') {
        previewCount++;
        return send(res, 200, { draft: { action: 'reply', text: '合成试聊回复 ' + previewCount }, ...(previewFormat === undefined ? {} : { format: previewFormat }), fees: { requests: 1, estimatedUsd: 0, unpriced: 0, unknown: 0 }, hints: [{ kind: 'expression', text: '表情保持适量。', reason: '只统计数量。' }], hits: [], segments, meta: { promptVersion: 'reply-context-v4', sampleSource: 'fixture', sampleCount: 1 } });
      }
      if (path === '/api/program') return send(res, 200, { settings: { mode: 'draft', publicPerHour: 8, privatePerHour: 8, publicPerDay: 30 }, revision: 0 });
      if (path === '/api/memory/policy') return send(res, 200, { policy: { recentCount: 3, recentDays: 7, retentionDays: 30 }, revision: 0 });
      if (path === '/api/health') return send(res, 200, { status: 'normal', activeAlerts: [] });
      if (path === '/api/account/posting-limits') return send(res, 200, { effective: { post: { limit: 280 }, reply: { limit: 280 } } });
      if (path === '/api/feed') return send(res, 200, { items, pending: items.filter(item => item.status === 'draft').length, nextCursor: null });
      if (path.startsWith('/api/messages/')) {
        const [, , , id, action] = path.split('/');
        const item = items.find(item => item.messageId === id);
        if (!item) return send(res, 404, { error: '合成消息不存在' });
        if (action === 'approve' && method === 'POST') {
          assert.equal(item.status, 'draft'); assert.equal(body.revision, item.revision); assert.equal(typeof body.text, 'string');
          item.status = 'approved'; item.revision++; item.draft.text = body.text;
          // 此处只模拟后端重算后的 DTO；检测规则由服务器单元测试验证。
          item.draft.format = { issues: body.text === '改成普通口语，现在这样就挺好。' ? [] : clone(item.draft.format.issues) };
          return send(res, 200, { ok: true });
        }
        if (!action && method === 'GET') return send(res, 200, { message: item, calls: [], outbox: [] });
      }
      if (path === '/api/tasks/runs') {
        const taskId = url.searchParams.get('taskId');
        return send(res, 200, { items: taskId ? runs.filter(run => run.taskId === taskId) : runs, nextCursor: null });
      }
      if (path.startsWith('/api/tasks/runs/')) { const run = runs.find(run => run.id === path.split('/').at(-1)); return send(res, run ? 200 : 404, run ? { run } : { error: '合成任务不存在' }); }
      return send(res, 404, { error: '隔离 API 未定义 ' + path });
    }
    const file = resolve(ROOT, '.' + (path === '/' ? '/index.html' : decodeURIComponent(path)));
    if (!file.startsWith(ROOT + '/')) throw Error('无效静态路径');
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' })[extname(file)] || 'text/plain' }); res.end(readFileSync(file));
  } catch (error) { report.errors.push({ name: '隔离服务异常', error: error.stack || String(error) }); if (!res.headersSent) send(res, 500, { error: '合成 API 错误' }); else res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const BASE = 'http://127.0.0.1:' + server.address().port;
const browser = await observer(), context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === BASE) return route.continue(); report.blockedOrigins.push(origin); return route.abort(); });
const page = await context.newPage(); page.setDefaultTimeout(10000);
page.on('pageerror', error => report.errors.push({ name: '页面异常', error: String(error) }));
page.on('dialog', async dialog => { report.errors.push({ name: '意外原生弹窗', error: dialog.type() + ': ' + dialog.message() }); await dialog.accept(); });
async function fresh(route, { resetFixture = true } = {}) {
  if (resetFixture) reset();
  await page.goto(BASE + '/?case=' + (++caseId) + '#/' + route);
  await page.locator('#status-pill').filter({ hasText: '已暂停' }).waitFor();
  if (route.startsWith('persona')) await page.locator('#persona-section-0').waitFor({ state: 'attached' });
  if (route === 'feed') await page.locator('.feed-item[data-id="draft-keep"]').waitFor();
}
async function check(name, run) {
  console.log('开始 ' + name);
  try { await run(); report.checks.push(name); console.log('通过 ' + name); }
  catch (error) { report.errors.push({ name, error: error.stack || String(error), visible: await page.locator('body').innerText().catch(() => '') }); console.log('失败 ' + name + ' ' + error); }
}
async function preview(format, text = '今天想聊点什么') {
  previewFormat = format;
  const previous = previewCount;
  await page.locator('#preview-message').fill(text); await page.locator('#persona-preview').click();
  await page.getByText('合成试聊回复 ' + (previous + 1), { exact: true }).waitFor();
  await page.waitForFunction(() => !document.getElementById('persona-preview').disabled);
}
async function openDetail(id) {
  const card = page.locator('.feed-item[data-id="' + id + '"]');
  await card.locator('.feed-details > summary').click(); return card;
}
async function taskHistory() {
  await fresh('settings/history');
  const history = page.locator('#settings-history');
  await history.locator('details.subcard').first().waitFor();
  for (const row of await history.locator('details.subcard').all()) { await row.locator(':scope > summary').click(); }
  await history.locator('.reply-format-note').nth(1).waitFor(); return history;
}
async function layout() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '页面出现整体横向滚动');
  for (const label of await page.locator('.reply-format-check, .reply-format-note').all()) {
    if (!await label.isVisible()) continue;
    const box = await label.boundingBox(), width = await page.evaluate(() => innerWidth);
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1, '格式提示超出页面宽度');
  }
}
async function shot(name) {
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForFunction(() => scrollY === 0);
  await page.screenshot({ path: OUT + '/' + name + '.png', fullPage: true }); report.screenshots.push(name + '.png');
}
try {
  await check('动态提醒隐藏开头控件，保存和试聊保留旧字段', async () => {
    await fresh('persona');
    const hints = page.locator('details.card').filter({ has: page.getByText('动态提醒', { exact: true }) }).first();
    await hints.locator(':scope > summary').click(); await hints.getByRole('button', { name: '保存提醒', exact: true }).waitFor();
    assert.equal(await hints.getByText('避免开头重复', { exact: true }).count(), 0); assert.equal(await hints.getByText('开头采样数量', { exact: true }).count(), 0);
    assert.equal(await hints.locator('input[type="checkbox"]').count(), 4); assert.equal(await hints.locator('input[type="number"]').count(), 4);
    const late = hints.getByLabel('迟到阈值（分钟）', { exact: true }); await late.fill('90');
    await hints.getByRole('button', { name: '保存提醒', exact: true }).click(); await page.getByText('动态提醒已保存，下一轮生效', { exact: true }).waitFor();
    assert.equal(savedHints.openingEnabled, false); assert.equal(savedHints.openingCount, 7); assert.equal(savedHints.lateMinutes, 90);
    await page.locator('#persona-tab-preview').click(); await preview({ issues: [] });
    const input = report.requests.filter(r => r.path === '/api/persona/preview' && r.method === 'POST').at(-1).body;
    assert.equal(input.promptHints.openingEnabled, false); assert.equal(input.promptHints.openingCount, 7); assert.equal(input.promptHints.lateMinutes, 90);
  });
  await check('试聊显示通过和双类别，近期往来按实际分段展示', async () => {
    await fresh('persona/preview'); await preview({ issues: [] });
    assert.equal(await page.locator('.reply-format-check').innerText(), '格式检查：通过');
    await preview({ issues: BOTH }); assert.equal(await page.locator('.reply-format-check').innerText(), '格式检查：含列表或步骤、含 Markdown');
    const memory = page.locator('details.subcard').filter({ has: page.locator('summary').filter({ hasText: /^关于对方的记忆 ·/ }) }).first();
    const recentBox = page.locator('details.subcard').filter({ has: page.locator('summary').filter({ hasText: /^与对方的近期往来 ·/ }) }).first();
    const ordered = await page.locator('details.subcard > summary').allTextContents();
    assert.ok(ordered.findIndex(text => text.startsWith('关于对方的记忆')) < ordered.findIndex(text => text.startsWith('与对方的近期往来')));
    assert.ok(ordered.findIndex(text => text.startsWith('与对方的近期往来')) < ordered.findIndex(text => text.startsWith('当前对话')));
    await recentBox.locator(':scope > summary').click(); assert.match(await recentBox.innerText(), /窗外刚停，路边的树还滴着水/);
    await memory.locator(':scope > summary').click(); assert.ok(!(await memory.innerText()).includes('窗外刚停'));
  });
  await check('旧试聊响应和null不误显示格式检查通过', async () => {
    await fresh('persona/preview'); await preview(undefined); assert.equal(await page.locator('.reply-format-check').count(), 0);
    await preview(null); assert.equal(await page.locator('.reply-format-check').count(), 0);
  });
  await check('草稿格式只提示，原文可批准，改写后标记消失', async () => {
    await fresh('feed');
    const keep = page.locator('.feed-item[data-id="draft-keep"]'), edit = page.locator('.feed-item[data-id="draft-edit"]');
    assert.equal(await keep.locator('.reply-format-note').innerText(), '格式提示：含列表或步骤、含 Markdown');
    assert.equal(await keep.getByRole('button', { name: '发送', exact: true }).isEnabled(), true);
    assert.equal(await edit.getByRole('button', { name: '发送', exact: true }).isEnabled(), true);
    assert.equal(report.requests.filter(r => r.path.endsWith('/approve') && r.method === 'POST').length, 0);
    await keep.getByRole('button', { name: '发送', exact: true }).click(); await keep.getByRole('button', { name: '取消发送', exact: true }).waitFor();
    assert.equal(items.find(item => item.id === 'draft-keep').status, 'approved');
    assert.deepEqual(items.find(item => item.id === 'draft-keep').draft.format.issues, BOTH);
    const originalApproval = report.requests.find(r => r.path === '/api/messages/draft-keep/approve').body;
    assert.equal(originalApproval.text, '1. **先看窗外**\n2. 再聊今天的天气');
    await edit.locator('.feed-details > summary').click(); await edit.locator('.feed-details .reply-format-note').waitFor();
    assert.equal(await edit.locator('.feed-details .reply-format-note').innerText(), '格式提示：含列表或步骤');
    await edit.getByLabel('编辑草稿', { exact: true }).fill('改成普通口语，现在这样就挺好。');
    await edit.getByRole('button', { name: '发送', exact: true }).click(); await edit.getByRole('button', { name: '取消发送', exact: true }).waitFor();
    assert.deepEqual(items.find(item => item.id === 'draft-edit').draft.format.issues, []);
    await page.waitForFunction(() => document.querySelector('.feed-item[data-id="draft-edit"] .feed-details')?.textContent.includes('approved'));
    assert.equal(await edit.locator('.reply-format-note').count(), 0, '正文和已展开详情不能残留旧格式标记');
  });
  await check('已发公开回复、私信和帖子详情显示标记，旧消息兼容', async () => {
    await fresh('feed');
    const reply = await openDetail('sent-reply'); await reply.locator('.feed-details .reply-format-note').waitFor();
    assert.equal(await reply.locator('.feed-details .reply-format-note').innerText(), '格式提示：含 Markdown');
    const dm = await openDetail('sent-dm'); await dm.locator('.feed-details .reply-format-note').waitFor();
    assert.equal(await dm.locator('.feed-details .reply-format-note').innerText(), '格式提示：含列表或步骤');
    const post = await openDetail('post-morning'); await post.locator('.feed-details .reply-format-note').waitFor();
    assert.equal(await post.locator('.feed-details .reply-format-note').innerText(), '格式提示：含 Markdown');
    const legacy = await openDetail('legacy-message'); await legacy.locator('.feed-details').getByText('状态：confirmed', { exact: true }).waitFor();
    assert.equal(await legacy.locator('.reply-format-note').count(), 0); assert.equal(await page.locator('#view img, #view script').count(), 0);
  });
  await check('早晚安任务执行历史显示标记，旧任务结果兼容', async () => {
    const history = await taskHistory();
    assert.deepEqual(await history.locator('.reply-format-note').allTextContents(), ['格式提示：含 Markdown', '格式提示：含列表或步骤、含 Markdown']);
    assert.equal(await history.locator('details.subcard').count(), 3);
    const legacy = history.locator('details.subcard').nth(2); assert.equal(await legacy.locator('.reply-format-note').count(), 0);
  });
  await check('1440/375浅深色试聊、动态和任务历史布局截图', async () => {
    for (const color of ['light', 'dark']) for (const width of [1440, 375]) {
      await page.emulateMedia({ colorScheme: color }); await page.setViewportSize({ width, height: 1100 });
      await fresh('persona/preview'); await preview({ issues: BOTH });
      const recentBox = page.locator('details.subcard').filter({ has: page.locator('summary').filter({ hasText: /^与对方的近期往来 ·/ }) }).first();
      await recentBox.locator(':scope > summary').click(); await layout(); await shot('reply-style-' + color + '-' + width + '-preview');
      await fresh('feed'); const sent = await openDetail('sent-reply'); await sent.locator('.feed-details .reply-format-note').waitFor();
      await layout(); await shot('reply-style-' + color + '-' + width + '-feed');
      await taskHistory(); await layout(); await shot('reply-style-' + color + '-' + width + '-tasks');
    }
  });
  const writes = report.requests.filter(r => r.method !== 'GET');
  assert.equal(writes.some(r => !['/api/persona/prompt-hints', '/api/persona/preview', '/api/messages/draft-keep/approve', '/api/messages/draft-edit/approve'].includes(r.path)), false, '验收出现范围外写入');
  assert.equal(report.blockedOrigins.length, 0, '页面尝试访问隔离来源之外的网址');
} catch (error) { report.errors.push({ name: '总体断言', error: error.stack || String(error) }); }
finally {
  await context.close(); await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  writeFileSync(OUT + '/reply-style-ui-acceptance.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (report.errors.length) process.exitCode = 1;
}
