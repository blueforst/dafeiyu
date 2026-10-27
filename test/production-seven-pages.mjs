// 生产七页验收：只读取接口和页面；仅本脚本接管的暂停会话允许释放。
// 不保存设置、不请求模型、不执行任务，不在 X 页面输入、点击或发送内容。
import { observer } from '/opt/role-camoufox/launch.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = (process.env.PANEL_URL || 'https://43.133.80.237').replace(/\/$/, '');
const OUT = process.env.ARTIFACT_DIR || '/artifacts';
const baseURL = new URL(BASE);
if (!['https:', 'http:'].includes(baseURL.protocol) || baseURL.username || baseURL.password) throw new Error('面板地址必须是不含凭据的 HTTP(S) 地址');
const lines = readFileSync('/run/test/admin-access.txt', 'utf8').split('\n');
const field = index => { const text = lines[index] || '', at = text.indexOf('：'); return at < 0 ? '' : text.slice(at + 1).trim(); };
const password = field(2);
if (!password) throw new Error('临时验收凭据缺失');
const httpCredentials = { username: field(1) || 'operator', password };
function redact(value) { return String(value).split(password).join('[已隐藏]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [已隐藏]').replace(/(?:sk-|buf_|ghp_)[A-Za-z0-9_\-]{8,}/g, '[已隐藏]').slice(0, 1200); }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ROUTES = [
  ['overview', '主页面', '#login-account'], ['model', '模型', '#provider-select'], ['persona', '人设', '#persona-section-0'],
  ['memory', '记忆', '#memory-search-button'], ['program', '主程序', '#program-logs'],
  ['tasks', '定时任务', '#task-enabled-main'], ['billing', '计费', '#billing-from'],
];
const API_PATHS = ['/api/status', '/api/persona', '/api/persona/daily', '/api/memory/policy', '/api/memory/users', '/api/program', '/api/program/logs', '/api/messages', '/api/tasks', '/api/tasks/runs', '/api/billing/summary', '/api/billing/calls'];
const results = { evidence: '真实公网面板、只读接口及受控桌面连接；未调用模型或执行 X 收发', controlOwnershipPolicy: '后端没有接管租约；仅在独占验收窗口，以初始暂停且本次接管收到200推定所有权。未确认响应时不盲目释放。', checks: [], errors: [], startedAt: new Date().toISOString(), screenshots: [], writes: [], blockedWrites: [] };
let browser, context, page, ownsTakeover = false, permittedControl = null, initial = null, exitCode = 0;
mkdirSync(OUT, { recursive: true });

async function readJson(path) {
  const response = await context.request.get(BASE + path, { timeout: 30000 });
  assert.equal(response.status(), 200, path + ' 读取失败，HTTP ' + response.status());
  const data = await response.json(); assert.ok(data && typeof data === 'object', path + ' 未返回 JSON 对象'); return data;
}
async function snapshot() {
  const status = await readJson('/api/status'), model = await readJson('/api/model');
  const persona = await readJson('/api/persona'), memory = await readJson('/api/memory/policy'), program = await readJson('/api/program'), tasks = await readJson('/api/tasks');
  return {
    control: status.control, busy: status.busy,
    model: { provider: model.effective?.provider || status.config?.model?.provider || null, id: model.effective?.id || status.config?.model?.id || null, source: model.source || status.config?.model?.source || null },
    modelHash: hash({ source: model.source, settings: model.settings, effective: model.effective }),
    panelSettingsHash: hash({ persona: { persona: persona.persona, revision: persona.revision }, memory, program: { settings: program.settings, revision: program.revision }, tasks: { revision: tasks.revision, plans: (tasks.tasks || []).map(task => ({ id: task.id, enabled: task.enabled, time: task.time, intervalSeconds: task.intervalSeconds })) } }),
    effectiveConfigHash: hash(status.config), usage: status.stats?.usage || null,
    messageCountsHash: hash(status.stats?.messages || []),
  };
}
async function step(name, fn) {
  try { await fn(); results.checks.push(name); return true; }
  catch (error) { results.errors.push(name + '：' + redact(error?.message || error)); return false; }
}
async function screenshot(name, mask = []) {
  await page.screenshot({ path: OUT + '/' + name + '.png', fullPage: true, mask }); results.screenshots.push(name + '.png');
}
async function statusIs(expected) { const status = await readJson('/api/status'); assert.equal(status.control, expected, '控制状态已变化，停止本次操作'); return status; }
async function waitData(route) {
  if (route === 'overview') await page.locator('#status-pill', { hasText: initial.control === 'manual' ? '人工接管中' : '已暂停' }).waitFor({ timeout: 30000 });
  else if (route === 'model') await page.waitForFunction(expected => { const select = document.getElementById('provider-select'), input = document.getElementById('model-input'); return select && !select.disabled && (expected ? input?.value === expected : select.textContent.includes('请选择服务商')); }, initial.model.id, { timeout: 30000 });
  else if (route === 'persona') { await page.locator('#persona-section-0').waitFor({ timeout: 30000 }); await page.waitForFunction(() => !document.getElementById('view').textContent.includes('正在读取当日日程')); }
  else if (route === 'memory') await page.waitForFunction(() => { const list = document.getElementById('memory-users'); return list && (list.querySelector('.memory-user') || list.textContent.includes('没有符合筛选条件')); });
  else if (route === 'program') await page.waitForFunction(() => { const view = document.getElementById('view'); return view.textContent.includes('当前控制') && !view.textContent.includes('正在读取日志'); });
  else if (route === 'tasks') await page.locator('#task-enabled-main').waitFor({ timeout: 30000 });
  else if (route === 'billing') await page.locator('.metric-grid .metric').first().waitFor({ timeout: 30000 });
  assert.ok(!/读取失败|页面加载失败|请求失败|加载失败/.test(await page.locator('#view').innerText()), route + ' 页面出现读取或加载错误');
}
async function releaseOwned() {
  if (!ownsTakeover) return;
  const status = await readJson('/api/status');
  if (status.control !== 'manual') { ownsTakeover = false; assert.equal(status.control, 'paused', '本脚本接管后的控制状态已变化'); return; }
  permittedControl = 'release';
  try {
    const response = await context.request.post(BASE + '/api/control/release', { headers: { 'x-workflow-control': '1' }, timeout: 120000 });
    results.writes.push({ method: 'POST', path: '/api/control/release', cleanup: true });
    assert.equal(response.status(), 200, '释放人工接管失败，HTTP ' + response.status());
    await statusIs('paused'); ownsTakeover = false;
  } finally { permittedControl = null; }
}

try {
  browser = await observer();
  context = await browser.newContext({ httpCredentials, viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === baseURL.origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const allowed = method === 'POST' && permittedControl && url.pathname === '/api/control/' + permittedControl && request.headers()['x-workflow-control'] === '1';
      if (!allowed) { results.blockedWrites.push({ method, path: url.pathname }); await route.abort('blockedbyclient'); return; }
      results.writes.push({ method, path: url.pathname });
    }
    await route.continue();
  });
  initial = await snapshot(); results.initial = initial;
  if (!['paused', 'manual'].includes(initial.control)) {
    results.skipped = '初始控制为 ' + initial.control + '，未连接桌面或改变状态'; exitCode = 2;
  } else {
    results.existingManualReadOnly = initial.control === 'manual';
    page = await context.newPage();
    page.on('pageerror', error => results.errors.push('页面脚本异常：' + redact(error.message)));
    page.on('response', response => { const url = new URL(response.url()); if (url.origin === baseURL.origin && url.pathname.startsWith('/api/') && response.status() >= 400) results.errors.push('页面接口失败：' + response.request().method() + ' ' + url.pathname + ' HTTP ' + response.status()); });
    await step('十二组真实接口可读', async () => { for (const path of API_PATHS) await readJson(path); });
    await step('七页直接地址、精确导航、主题与375宽度', async () => {
      for (const scheme of ['light', 'dark']) for (const width of [1440, 375]) {
        await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width, height: 1000 });
        for (const [route, label, selector] of ROUTES) {
          await page.goto(BASE + '/#/' + route);
          await page.locator('.tabs a.active[data-route="' + route + '"]').waitFor({ timeout: 30000 });
          await page.locator(selector).waitFor({ timeout: 30000 });
          await waitData(route);
          if (route === 'overview') { assert.equal(await page.locator('#view ul.logs').count(), 0, '主页面不应再显示日志'); results.homeLogsAbsent = true; }
          if (route === 'program') {
            assert.equal(await page.locator('ul#program-logs.logs').count(), 1); assert.equal(await page.locator('#program-logs details.log-entry').count(), 0);
            const row = page.locator('#program-logs li[data-level]').first();
            if (await row.count()) { assert.equal(await row.locator(':scope > span.t').count(), 1); assert.equal(await row.locator(':scope > span.e').count(), 1); assert.equal(await row.locator(':scope > span.d').count(), 1); }
            results.programLogFormat = '时间／事件／说明，直接展示';
          }
          assert.deepEqual((await page.locator('.tabs a').allTextContents()).map(x => x.trim()), ROUTES.map(x => x[1]));
          assert.equal((await page.locator('.tabs a.active').innerText()).trim(), label);
          assert.ok(page.url().endsWith('#/' + route), '页面地址与当前导航不一致');
          const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
          assert.ok(scrollWidth <= width, route + ' 页面溢出 ' + scrollWidth + '/' + width);
          if ((route === 'overview' && width === 1440) || (scheme === 'light' && width === 375 && ['persona', 'memory', 'program', 'tasks', 'billing'].includes(route)) || (scheme === 'dark' && width === 375 && route === 'model')) await screenshot('production-' + route + '-' + scheme + '-' + width);
        }
      }
    });
    const browserPage = await step('旧浏览器地址并入主页面且不自动连接', async () => {
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(BASE + '/#/browser'); await page.locator('#browser-panel[open]').waitFor({ timeout: 30000 });
      await page.locator('#connect').waitFor({ timeout: 30000 }); assert.ok(page.url().endsWith('#/overview'));
      assert.equal(await page.locator('#desktop-frame').count(), 0); assert.equal(await page.locator('.tabs a[data-route="browser"]').count(), 0);
    });
    if (browserPage && initial.control === 'paused') {
      const connected = await step('暂停时接管并建立noVNC画布连接', async () => {
        await statusIs('paused'); permittedControl = 'takeover';
        try {
          // 只点击面板的接管按钮。后续操作仅读取 iframe 和画布状态。
          const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/control/takeover', { timeout: 120000 });
          await page.click('#connect');
          const response = await responsePromise; assert.equal(response.status(), 200, '接管请求失败，HTTP ' + response.status());
          ownsTakeover = true;
          await page.locator('#status-pill', { hasText: '人工接管中' }).waitFor({ timeout: 120000 });
        } finally { permittedControl = null; }
        await page.locator('#desktop-frame').waitFor({ timeout: 30000 });
        const frame = await (await page.locator('#desktop-frame').elementHandle()).contentFrame(); assert.ok(frame, '桌面iframe不可用');
        try {
          await frame.waitForFunction(() => document.documentElement.classList.contains('noVNC_connected') && document.querySelector('#noVNC_container canvas')?.width > 100, null, { timeout: 30000 });
        } catch (error) {
          results.desktopDiagnostic = await frame.evaluate(() => ({ rootClass: document.documentElement.className, canvasWidth: document.querySelector('#noVNC_container canvas')?.width || 0, canvasHeight: document.querySelector('#noVNC_container canvas')?.height || 0, connectionStatus: (document.querySelector('#noVNC_status')?.textContent || '').slice(0, 300) })).catch(() => ({ unavailable: true }));
          await screenshot('production-desktop-failed-masked', [page.locator('#desktop-frame')]);
          throw error;
        }
        await frame.waitForFunction(() => {
          const c = document.querySelector('#noVNC_container canvas'), x = c?.getContext('2d'); if (!c || !x) return false;
          const data = x.getImageData(0, 0, Math.min(c.width, 800), Math.min(c.height, 600)).data, colors = new Set();
          for (let i = 0; i < data.length; i += 400) if (data[i + 3]) colors.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
          return colors.size > 12;
        }, null, { timeout: 20000 });
        const canvas = await frame.evaluate(() => {
          const c = document.querySelector('#noVNC_container canvas'); if (!c) return { connected: false };
          const x = c.getContext('2d'); if (!x) return { connected: false };
          const data = x.getImageData(0, 0, Math.min(c.width, 800), Math.min(c.height, 600)).data, colors = new Set();
          for (let i = 0; i < data.length; i += 400) if (data[i + 3]) colors.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
          return { connected: document.documentElement.classList.contains('noVNC_connected'), width: c.width, height: c.height, hasPixels: colors.size > 12 };
        });
        assert.equal(canvas.hasPixels, true, '桌面画布没有有效像素'); results.desktop = { ...canvas, screenshotMasked: true };
        // 不保存 X 页面像素，避免把可能可见的私信正文写入截图证据。
        await screenshot('production-desktop-connected-masked', [page.locator('#desktop-frame')]);
      });
      if (ownsTakeover) await step('释放接管后保持暂停且桌面返回423', async () => {
        await statusIs('manual'); permittedControl = 'release';
        try { await page.locator('#primary-action', { hasText: '释放接管' }).click(); await page.locator('#status-pill', { hasText: '已暂停' }).waitFor({ timeout: 120000 }); }
        finally { permittedControl = null; }
        await statusIs('paused'); ownsTakeover = false;
        assert.equal(await page.locator('#desktop-frame').count(), 0);
        assert.equal((await context.request.get(BASE + '/desktop/vnc.html')).status(), 423);
      });
      else if (!connected) results.desktopSkipped = '未取得本脚本接管所有权，未执行释放';
    } else if (initial.control === 'manual') results.desktopSkipped = '初始已由他人接管：只观察面板，不新建桌面连接、不释放';
    await step('配置、模型来源与LLM用量保持不变', async () => {
      const final = await snapshot(); results.final = final;
      assert.equal(final.control, initial.control); assert.equal(final.modelHash, initial.modelHash);
      assert.equal(final.panelSettingsHash, initial.panelSettingsHash);
      assert.equal(final.effectiveConfigHash, initial.effectiveConfigHash); assert.deepEqual(final.model, initial.model);
      assert.deepEqual(final.usage, initial.usage, '验收期间出现新的模型调用或用量变化');
      assert.equal(final.messageCountsHash, initial.messageCountsHash, '验收期间消息计数变化');
      assert.deepEqual(results.blockedWrites, []);
      assert.ok(results.writes.every(x => ['/api/control/takeover', '/api/control/release'].includes(x.path)));
    });
  }
} catch (error) { results.errors.push('验收异常：' + redact(error?.message || error)); }
finally {
  if (ownsTakeover && context) await step('异常清理释放本脚本的接管', releaseOwned);
  if (context && initial) await step('记录最终状态', async () => {
    results.final = await snapshot();
    if (initial.control === 'paused' && results.final.control === 'manual') results.controlWarning = ownsTakeover ? '本脚本已确认接管，但释放未成功；需要处理当前人工接管状态。' : '接管响应或所有权未确认，未盲目释放；需要核对当前人工接管状态。';
  });
  if (context) try { await context.close(); } catch (error) { results.errors.push('关闭观察上下文：' + redact(error?.message || error)); }
  if (browser) try { await browser.close(); } catch (error) { results.errors.push('关闭观察浏览器：' + redact(error?.message || error)); }
  results.finishedAt = new Date().toISOString();
  writeFileSync(OUT + '/production-seven-pages.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
process.exit(results.errors.length ? 1 : exitCode);
