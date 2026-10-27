// 在服务器 Camoufox 镜像内验证七页交互。所有业务接口使用确定性模拟数据，不连接生产账号。
import { observer } from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const BASE = process.env.PANEL_URL || 'http://127.0.0.1:8081';
const OUT = process.env.ARTIFACT_DIR || '/artifacts';
const now = Date.now();
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const unsafe = '<img src=x onerror="window.__injected=1">';
const routes = ['overview', 'model', 'persona', 'memory', 'program', 'tasks', 'billing'];
const result = { evidence: '服务器 Camoufox／模拟 API；不代表真实模型或 X 平台验收', checks: [], errors: [] };
const browser = await observer();

async function fixtures(page, options = {}) {
  let control = 'paused';
  let personaRevision = 0, taskRevision = 0;
  let persona = { sections: [{ id: 'role', title: '角色定义', content: '原始角色文本\n' + unsafe }, { id: 'style', title: '说话风格', content: '' }, { id: 'memory', title: '记忆与承诺', content: '' }, { id: 'boundaries', title: '互动边界', content: '' }], triggers: [] };
  let tasks = [['main', '主循环', true, null, 60, 'main'], ['daily-state', '虚构日程', true, '06:00', null, 'business'], ['memory-summary', '记忆补整理', true, '03:00', null, 'business'], ['morning-post', '早安帖', false, '08:00', null, 'business'], ['evening-post', '晚安帖', false, '23:00', null, 'business'], ['backup', '数据库备份', false, '02:30', null, 'host'], ['health', '宿主健康检查', true, null, 300, 'host']].map(([id, title, enabled, time, intervalSeconds, kind]) => ({ id, title, enabled, ...(time ? { time } : {}), ...(intervalSeconds ? { intervalSeconds } : {}), kind, nextRunAt: enabled ? now + 60000 : null }));
  const calls = [];
  let logVersion = 0;
  calls.setLogVersion = value => { logVersion = value; };
  const dailyContent = { date: day, fictional: true, periods: [{ start: '06:00', end: '12:00', activity: '整理房间' }, { start: '12:00', end: '24:00', activity: '读书和休息' }], meals: { breakfast: '面包', lunch: '米饭', dinner: '蔬菜' }, activities: ['阅读'], mood: '平静' };
  const dailyRevision = { accountId: 'tester', date: day, revision: 1, content: dailyContent, source: 'automatic', generatedAt: now, callId: 'call-daily' };
  const daily = { date: day, status: 'ready', attempts: 1, nextRetryAt: null, today: dailyRevision, state: dailyRevision, currentPeriod: dailyContent.periods[0], history: [dailyRevision], scheduleTime: '06:00' };
  const totals = { calls: options.empty ? 0 : 1, input: 12, output: 8, cacheRead: 2, cacheWrite: 0, totalTokens: 22, reasoning: 3, costUSD: null, priced: 0, unpriced: options.empty ? 0 : 1, unknown: 0, legacyRows: 0 };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const method = req.method();
    let body; try { body = req.postDataJSON(); } catch {}
    calls.push({ method, path, body, query: Object.fromEntries(url.searchParams) });
    if (path === '/api/events') { await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: logs\ndata: []\n\n' }); return; }
    if (options.error && path !== '/api/status') { await route.fulfill({ status: 503, json: { error: '模拟服务暂时不可用' } }); return; }
    let data;
    if (path === '/api/status') data = { control, busy: false, browser: { loggedIn: true, needsHuman: false, handle: 'tester' }, accountId: 'tester', config: { mode: 'draft', model: { configured: true, provider: 'custom', id: 'mock' }, publicPerHour: 10, privatePerHour: 30 }, stats: { messages: [], usage: totals }, cooldown: {}, now };
    else if (path.startsWith('/api/control/')) { control = path.endsWith('/takeover') ? 'manual' : path.endsWith('/resume') ? 'running' : 'paused'; data = { ok: true, control }; }
    else if (path === '/api/logs') data = [];
    else if (path === '/api/model') data = { settings: null, effective: null, keys: {}, lastTest: null };
    else if (path === '/api/model/providers') data = [];
    else if (/^\/api\/model\/providers\/[^/]+\/models$/.test(path)) data = [];
    else if (path === '/api/persona') { if (method === 'PUT') { persona = body.persona; personaRevision++; } data = { persona, revision: personaRevision, fixedRules: '固定系统约束：不能编造真实互动。', daily, scheduleTime: '06:00' }; }
    else if (path === '/api/persona/daily') data = daily;
    else if (path === '/api/persona/daily/generate') data = { state: dailyRevision, status: 'ready' };
    else if (path === '/api/persona/preview') data = { draft: { action: 'reply', text: '模拟回复', reason: '适合回复' }, segments: [{ kind: 'static', title: '静态分区', content: unsafe }], hits: [], calls: [{ callId: 'call-preview' }], fees: { requests: 1, estimatedUsd: null, unpriced: 1, unknown: 0 }, latencyMs: 10 };
    else if (path === '/api/memory/policy') data = { policy: body?.policy || { recentCount: 3, recentDays: 7, retentionDays: 30 }, revision: method === 'PUT' ? 1 : 0 };
    else if (path === '/api/memory/users') data = { users: options.empty ? [] : [{ userId: 'person1', accountId: 'tester', channel: 'public', label: unsafe, identityConfirmed: true, forgotten: false, lastInteractionAt: now, itemCount: 1, lastSummaryAt: now }], nextCursor: null };
    else if (path.endsWith('/preview')) data = { memories: [{ text: unsafe, channel: 'public' }], recent: [], experiences: [], readonly: true };
    else if (path.startsWith('/api/memory/users/')) data = { userId: 'person1', accountId: 'tester', channel: 'public', forgotten: false, epoch: 0, revision: 1, items: options.empty ? [] : [{ id: 'item-1', type: 'fact', text: unsafe, revision: 1, sourceStatus: 'incomplete', createdAt: now, updatedAt: now, sources: [] }], recent: [], progress: { cursor: 1 } };
    else if (path === '/api/program/settings') data = { settings: body.settings, revision: 1 };
    else if (path === '/api/program') data = { control, busy: false, stage: null, stages: options.empty ? [] : [{ id: 'stage-1', name: 'generate', status: 'interrupted', startedAt: now - 10000, endedAt: now - 5000, durationMs: 5000, roundId: 'round-1', messageId: 'msg-1', error: unsafe }], queue: { items: [], counts: [] }, lastTick: now - 10000, nextTick: null, cooldown: { public: now + 60000, private: 0 }, settings: { mode: 'draft', maxAgeHours: 24, maxPerRound: 2, publicPerHour: 10, privatePerHour: 30 }, revision: 0, limits: { public: { used: 0, limit: 10 }, private: { used: 0, limit: 30 } } };
    else if (path === '/api/messages') data = { items: [], nextCursor: null };
    else if (path === '/api/program/logs') data = options.pagedLogs
      ? url.searchParams.get('cursor') === 'older' ? { items: [{ id: 1, at: now - 10000, level: 'info', event: 'older-event', detail: '更早的一条日志' }], nextCursor: null } : { items: [{ id: 2 + logVersion, at: now + logVersion, level: 'error', event: logVersion ? 'live-event' : 'recent-event', detail: unsafe, channel: 'public', correlationId: 'call-1' }], nextCursor: 'older' }
      : { items: options.empty ? [] : [{ id: 1, at: now, level: 'error', event: 'generation-error', detail: unsafe, correlationId: 'call-1' }], nextCursor: null };
    else if (path === '/api/tasks/runs') data = { items: [], nextCursor: null };
    else if (path === '/api/tasks' || /^\/api\/tasks\/[^/]+$/.test(path)) { if (method === 'PUT') { const task = tasks.find(x => x.id === path.split('/').at(-1)); Object.assign(task, body); taskRevision++; } data = { timezone: 'Asia/Shanghai', revision: taskRevision, tasks, backupScope: '仅业务数据库；不含设置、密钥、源码和 profile。', control, hostAvailable: false }; }
    else if (path === '/api/billing/summary') data = { totals, daily: options.empty ? [] : [{ date: day, ...totals }], models: [], purposes: [], range: {}, priceSource: 'Pi 内置目录估算' };
    else if (path === '/api/billing/calls') data = { items: options.empty ? [] : [{ id: 'call-1', purpose: 'reply', source: 'workflow', provider: 'custom', model: 'mock', status: 'completed', startedAt: now, latencyMs: 10, usage: totals, cost: null, pricingStatus: 'unpriced' }], nextCursor: null, range: {} };
    else { await route.fulfill({ status: 404, json: { error: '模拟接口不存在：' + path } }); return; }
    if ((options.previewDelay && path === '/api/persona/preview') || (options.saveDelay && method === 'PUT')) await new Promise(resolve => setTimeout(resolve, options.previewDelay || options.saveDelay));
    await route.fulfill({ json: data });
  });
  return calls;
}

async function check(name, fn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try { await fn(page, context); assert.deepEqual(errors, []); result.checks.push(name); }
  catch (e) { result.errors.push(name + '：' + e.message); await page.screenshot({ path: OUT + '/seven-fail-' + name.replace(/[^a-z0-9]/gi, '-') + '.png', fullPage: true }).catch(() => {}); }
  finally { await context.close(); }
}

try {
  await check('actual staging api contracts', async (page, context) => {
    const paths = ['/api/status', '/api/persona', '/api/persona/daily', '/api/memory/policy', '/api/memory/users', '/api/program', '/api/program/logs', '/api/messages', '/api/tasks', '/api/tasks/runs', '/api/billing/summary', '/api/billing/calls'];
    for (const path of paths) {
      const response = await context.request.get(BASE + path);
      assert.equal(response.status(), 200, path + ' must be registered');
      const body = await response.json();
      assert.ok(body && typeof body === 'object', path + ' JSON');
    }
  });
  if (process.env.PANEL_STAGING_MUTATIONS === '1') await check('actual staging revision and paused saves', async (page, context) => {
    const request = context.request, headers = { 'x-workflow-control': '1' };
    const status = await (await request.get(BASE + '/api/status')).json(); assert.equal(status.control, 'paused');
    const p = await (await request.get(BASE + '/api/persona')).json();
    const saved = await request.put(BASE + '/api/persona', { headers, data: { persona: p.persona, revision: p.revision } }); assert.equal(saved.status(), 200);
    const stale = await request.put(BASE + '/api/persona', { headers, data: { persona: p.persona, revision: p.revision } }); assert.equal(stale.status(), 409);
    const policy = await (await request.get(BASE + '/api/memory/policy')).json();
    assert.equal((await request.put(BASE + '/api/memory/policy', { headers, data: policy })).status(), 200);
    const plans = await (await request.get(BASE + '/api/tasks')).json(), plan = plans.tasks.find(x => x.id === 'daily-state');
    assert.equal((await request.put(BASE + '/api/tasks/daily-state', { headers, data: { revision: plans.revision, enabled: plan.enabled, time: plan.time } })).status(), 200);
    const usersBefore = await (await request.get(BASE + '/api/memory/users')).json();
    const preview = await request.post(BASE + '/api/memory/users/acceptance-readonly/preview', { headers, data: { accountId: status.accountId, channel: 'public' } });
    assert.equal(preview.status(), 200); assert.equal((await preview.json()).readonly, true);
    const usersAfter = await (await request.get(BASE + '/api/memory/users')).json(); assert.deepEqual(usersAfter, usersBefore);
    assert.equal((await (await request.get(BASE + '/api/status')).json()).control, 'paused');
  });
  if (process.env.PANEL_STAGING_PREVIEW === '1') await check('actual staging preview uses billing lifecycle', async (page, context) => {
    const request = context.request, p = await (await request.get(BASE + '/api/persona')).json();
    const response = await request.post(BASE + '/api/persona/preview', { headers: { 'x-workflow-control': '1' }, data: { persona: p.persona, channel: 'public', messages: [{ role: 'user', text: '你好，今天心情怎么样？' }] }, timeout: 180000 });
    assert.equal(response.status(), 200); const preview = await response.json(); assert.equal(preview.draft?.action, 'reply'); assert.ok(preview.fees.requests >= 1);
    const calls = await (await request.get(BASE + '/api/billing/calls?interactionId=' + encodeURIComponent(preview.interactionId))).json();
    assert.equal(calls.items.length, preview.fees.requests); assert.ok(calls.items.every(x => x.status !== 'started'));
  });
  await check('seven pages themes and mobile', async page => {
    await fixtures(page);
    for (const scheme of ['light', 'dark']) for (const width of [1440, 375]) {
      await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width, height: 1000 });
      for (const route of routes) {
        await page.goto(BASE + '/#/' + route);
        await page.locator('.tabs a.active').waitFor();
        await page.waitForFunction(() => document.getElementById('view').textContent.trim().length > 20);
        await page.waitForTimeout(150);
        assert.equal(await page.locator('.tabs a').count(), 7);
        if (route === 'overview') assert.equal(await page.locator('#view ul.logs').count(), 0);
        if (route === 'program') { assert.equal(await page.locator('ul#program-logs.logs').count(), 1); assert.equal(await page.locator('#program-logs details.log-entry').count(), 0); }
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(scrollWidth <= width, route + ' overflow ' + scrollWidth + '/' + width);
        assert.equal(await page.evaluate(() => window.__injected), undefined);
        assert.equal(await page.locator('#view img').count(), 0);
        await page.screenshot({ path: OUT + '/seven-' + route + '-' + scheme + '-' + width + '.png', fullPage: true });
      }
    }
  });
  await check('home logs move to program with live filter and paging', async page => {
    await page.addInitScript(() => {
      window.__eventSources = [];
      window.EventSource = class extends EventTarget { constructor() { super(); window.__eventSources.push(this); } close() {} };
    });
    const requests = await fixtures(page, { pagedLogs: true });
    await page.goto(BASE + '/#/overview'); await page.locator('#login-account').waitFor();
    assert.equal(await page.locator('#view ul.logs').count(), 0); assert.equal(requests.filter(x => x.path === '/api/logs').length, 0);
    await page.click('.tabs a[data-route="program"]'); await page.locator('#program-logs .e', { hasText: 'recent-event' }).waitFor();
    assert.equal(await page.locator('#program-logs li[data-level] > .t').count(), 1);
    assert.equal(await page.locator('#program-logs li[data-level] > .e').count(), 1);
    assert.equal(await page.locator('#program-logs li[data-level] > .d').count(), 1);
    assert.equal(await page.locator('#program-logs details.log-entry').count(), 0);
    await page.click('#program-log-pause'); await page.click('#program-log-more'); await page.locator('#program-logs .e', { hasText: 'older-event' }).waitFor();
    assert.equal(await page.locator('#program-logs li[data-level]').count(), 2);
    const before = requests.filter(x => x.path === '/api/program/logs').length; requests.setLogVersion(1);
    await page.evaluate(() => { for (const source of window.__eventSources) source.dispatchEvent(new MessageEvent('program', { data: '{}' })); });
    await page.waitForTimeout(100); assert.equal(requests.filter(x => x.path === '/api/program/logs').length, before);
    assert.equal(await page.locator('#program-logs .e', { hasText: 'older-event' }).count(), 1);
    await page.click('#program-log-pause'); await page.locator('#program-logs .e', { hasText: 'live-event' }).waitFor();
    assert.equal(await page.locator('#program-logs .e', { hasText: 'older-event' }).count(), 0);
    assert.ok(await page.locator('#program-logs .t').getAttribute('title'));
    await page.locator('.filter-grid select').first().selectOption('error');
    const filtered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/program/logs' && new URL(response.url()).searchParams.get('level') === 'error');
    await page.click('#program-log-filter'); await filtered;
    assert.equal(requests.filter(x => x.path === '/api/program/logs').at(-1).query.level, 'error');
    assert.equal(await page.locator('#view img').count(), 0); assert.equal(await page.evaluate(() => window.__injected), undefined);
    assert.equal(requests.filter(x => x.method !== 'GET').length, 0);
  });
  await check('browser legacy route opens main takeover', async page => {
    await fixtures(page); await page.goto(BASE + '/#/browser');
    await page.locator('#browser-panel[open]').waitFor();
    assert.ok(page.url().endsWith('#/overview'));
    assert.equal(await page.locator('#desktop-frame').count(), 0);
    assert.equal(await page.locator('.tabs a[data-route="browser"]').count(), 0);
    await page.locator('#connect').waitFor();
  });
  await check('persona draft leave and isolated multi turn preview', async page => {
    const requests = await fixtures(page, { previewDelay: 500 }); await page.goto(BASE + '/#/persona');
    await page.locator('#persona-section-0').waitFor(); await page.fill('#persona-section-0', '未保存的人设');
    await page.click('.tabs a[data-route="model"]'); await page.getByText('保留编辑', { exact: true }).click();
    assert.ok(page.url().endsWith('#/persona')); assert.equal(await page.inputValue('#persona-section-0'), '未保存的人设');
    await page.fill('#preview-message', '第一条消息'); await page.click('#persona-preview');
    assert.equal(await page.locator('#preview-channel').isDisabled(), true);
    await page.fill('#preview-message', '下一轮尚未发送的草稿'); await page.getByText('模拟回复', { exact: true }).waitFor();
    assert.equal(await page.inputValue('#preview-message'), '下一轮尚未发送的草稿');
    await page.fill('#preview-message', '第二条消息'); await page.click('#persona-preview');
    await page.waitForFunction(() => document.querySelectorAll('.chat-message').length === 4);
    const previews = requests.filter(x => x.path === '/api/persona/preview'); assert.equal(previews.length, 2); assert.equal(previews[1].body.messages.length, 3); assert.equal(previews[1].body.persona.sections[0].content, '未保存的人设');
    assert.equal(requests.filter(x => x.path.startsWith('/api/control/') || x.path.includes('/memory/') && x.method !== 'GET').length, 0);
    await page.click('.tabs a[data-route="model"]'); await page.getByText('放弃并离开', { exact: true }).click(); await page.locator('#provider-select').waitFor();
  });
  await check('daily editor retains draft and freezes saving', async page => {
    await fixtures(page, { saveDelay: 500 }); await page.goto(BASE + '/#/persona');
    await page.locator('#daily-edit').click(); await page.fill('#daily-mood', '编辑中的心情');
    await page.locator('#daily-edit').click(); assert.equal(await page.inputValue('#daily-mood'), '编辑中的心情');
    await page.click('#daily-save'); assert.equal(await page.locator('#daily-mood').isDisabled(), true);
    assert.equal(await page.locator('#daily-edit').isDisabled(), true);
    await page.getByText('虚构日程已保存', { exact: true }).waitFor();
  });
  await check('memory source warning and read only recall', async page => {
    const requests = await fixtures(page); await page.goto(BASE + '/#/memory');
    await page.locator('.memory-user').click(); await page.getByText('来源不完整：旧摘要未建立可靠来源关系。', { exact: true }).waitFor();
    await page.click('#memory-preview'); await page.getByText('只读召回预览', { exact: true }).last().waitFor();
    assert.equal(requests.filter(x => x.method !== 'GET' && x.path.includes('/memory/') && !x.path.endsWith('/preview')).length, 0);
    assert.equal(await page.evaluate(() => window.__injected), undefined);
  });
  await check('task save keeps paused and billing shows unpriced', async page => {
    const requests = await fixtures(page); await page.goto(BASE + '/#/tasks');
    await page.locator('#task-time-daily-state').waitFor(); await page.fill('#task-time-daily-state', '07:00');
    await page.locator('form').filter({ has: page.locator('#task-time-daily-state') }).getByText('保存计划', { exact: true }).click();
    await page.getByText('已保存，按计划生效', { exact: true }).waitFor();
    assert.equal(await page.locator('#status-pill').innerText(), '已暂停'); assert.equal(requests.filter(x => x.path.startsWith('/api/control/')).length, 0);
    await page.click('.tabs a[data-route="billing"]'); await page.getByText('未定价', { exact: true }).waitFor();
  });
  for (const mode of ['empty', 'error']) await check(mode + ' states on new pages', async page => {
    await fixtures(page, { [mode]: true });
    for (const route of routes.filter(x => x !== 'overview' && x !== 'model')) {
      await page.goto(BASE + '/#/' + route); await page.locator('h1').waitFor(); await page.waitForTimeout(150);
      if (mode === 'error') assert.ok((await page.locator('#view').innerText()).includes('失败') || (await page.locator('#view').innerText()).includes('不可用'));
    }
  });
} finally { await browser.close(); }
writeFileSync(OUT + '/seven-pages-acceptance.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(result.errors.length ? 1 : 0);
