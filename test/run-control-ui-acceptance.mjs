// 服务器隔离 Camoufox：顶部运行控制、浏览器接管与释放；仅使用合成 API 和桌面。
import { observer } from '/opt/role-camoufox/launch.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = resolve(process.env.PUBLIC_DIR || '/app/public');
const OUT = process.env.ARTIFACT_DIR || '/artifacts';
mkdirSync(OUT, { recursive: true });
const report = { evidence: '服务器隔离 Camoufox，合成 API 与桌面；未访问生产、X 或真实模型', checks: [], errors: [], screenshots: [], requests: [] };
let state, failStatus = false, holdAction = null, pendingAction = null, releaseAction = null, caseId = 0;
const fixture = (control = 'paused', mode = 'draft', busy = false) => ({ control, busy, accountId: 'fixture_worker', browser: { loggedIn: true, needsHuman: false, handle: 'fixture_worker' }, config: { mode, model: { configured: true, provider: 'fixture', id: 'fixture-model' } }, cooldown: {}, configError: '', now: Date.now() });
const policy = { recentCount: 3, recentDays: 7, retentionDays: 30 };
const settings = () => ({ mode: state.config.mode, maxAgeHours: 24, maxPerRound: 2, publicPerHour: 8, privatePerHour: 8, publicPerDay: 30 });
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    report.requests.push({ path, method: req.method });
    if (path === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('retry: 60000\n\n'); return; }
    if (path === '/api/status') { report.requests.at(-1).control = state.control; return send(res, failStatus ? 503 : 200, failStatus ? { error: '合成状态读取失败' } : state); }
    if (path.startsWith('/api/control/')) {
      assert.equal(req.headers['x-workflow-control'], '1');
      const action = path.split('/').at(-1);
      if (action === 'resume' && state.control === 'manual') return send(res, 409, { error: '请先释放人工接管' });
      if (!['pause', 'resume', 'takeover', 'release'].includes(action)) return send(res, 400, { error: '未知动作' });
      if (holdAction === action) {
        if (action === 'pause' || action === 'takeover') { state.control = 'draining'; state.busy = true; }
        pendingAction = action;
        await new Promise(done => { releaseAction = done; });
        pendingAction = null; releaseAction = null; holdAction = null;
      }
      state.control = ({ pause: 'paused', resume: 'running', takeover: 'manual', release: 'paused' })[action]; state.busy = false;
      return send(res, 200, { ok: true });
    }
    if (path === '/api/program') return send(res, 200, { settings: settings(), revision: 0 });
    if (path === '/api/memory/policy') return send(res, 200, { policy, revision: 0 });
    if (path === '/api/memory/users') return send(res, 200, { users: [], nextCursor: null });
    if (path === '/api/feed') return send(res, 200, { items: [], pending: 0, nextCursor: null });
    if (path === '/api/health') return send(res, 200, { status: 'normal', activeAlerts: [] });
    if (path === '/api/account/posting-limits') return send(res, 200, { effective: { post: { limit: 280 }, reply: { limit: 280 } } });
    return send(res, 404, { error: '隔离 API 未定义 ' + path });
  }
  if (path.startsWith('/desktop/')) {
    if (state.control !== 'manual') { res.writeHead(423); res.end('请先接管'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="zh-CN"><body><h1>合成浏览器桌面</h1></body></html>'); return;
  }
  try {
    const file = resolve(ROOT, '.' + (path === '/' ? '/index.html' : decodeURIComponent(path)));
    if (!file.startsWith(ROOT + '/')) throw Error('无效路径');
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' })[extname(file)] || 'text/plain' }); res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const BASE = 'http://127.0.0.1:' + server.address().port;
const browser = await observer();
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.route('**/*', route => new URL(route.request().url()).origin === BASE ? route.continue() : route.abort());
const page = await context.newPage(); page.setDefaultTimeout(15000);
page.on('pageerror', error => report.errors.push({ name: '页面异常', error: String(error) }));
async function fresh(control = 'paused', { mode = 'draft', busy = false, fail = false, route = 'settings/browser' } = {}) {
  releaseAction?.(); state = fixture(control, mode, busy); failStatus = fail; holdAction = null;
  await page.goto(BASE + '/?case=' + (++caseId) + '#/' + route);
  await page.waitForFunction(() => document.getElementById('status-pill').textContent !== '连接中');
  if (route === 'settings/browser') await page.locator('#connect').waitFor();
}
// 等待 app 自身轮询；Camoufox 的 evaluate 动态 import 使用独立模块上下文。
async function refresh() { await page.waitForResponse(response => new URL(response.url()).pathname === '/api/status', { timeout: 20000 }); }
async function enabled(selector) { await page.waitForFunction(selector => { const el = document.querySelector(selector); return el && !el.disabled; }, selector); }
async function expectedPill(text) { await page.locator('#status-pill').filter({ hasText: text }).waitFor(); assert.equal(await page.locator('#status-pill').innerText(), text); }
async function shot(name) { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForFunction(() => scrollY === 0); await page.screenshot({ path: OUT + '/' + name + '.png', fullPage: true }); report.screenshots.push(name + '.png'); }
async function layout(manual) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '页面出现横向滚动');
  for (const selector of ['#status-pill', '#primary-action', ...(manual ? ['#takeover-link'] : [])]) {
    assert.equal(await page.locator(selector).isVisible(), true);
    const box = await page.locator(selector).boundingBox(), width = await page.evaluate(() => innerWidth);
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, selector + ' 超出窄屏');
  }
}
async function waitHeld(action) {
  const start = Date.now(); while (pendingAction !== action && Date.now() - start < 8000) await new Promise(done => setTimeout(done, 20));
  assert.equal(pendingAction, action, '控制请求没有进入隔离等待');
}
async function check(name, run) {
  console.log('开始 ' + name);
  try { await run(); report.checks.push(name); console.log('通过 ' + name); }
  catch (error) { report.errors.push({ name, error: error.stack || String(error), visible: await page.locator('body').innerText().catch(() => '') }); console.log('失败 ' + name + ' ' + error); }
  finally { releaseAction?.(); }
}
try {
  await check('五态顶部、摘要、浅深色和1440/375布局', async () => {
    const cases = [
      { control: 'running', label: '运行中', button: '暂停', disabled: false, color: 'running', summary: '按需连接' },
      { control: 'paused', label: '已暂停', button: '启动', disabled: false, color: 'paused', summary: '按需连接' },
      { control: 'draining', label: '正在暂停…', button: '正在暂停…', disabled: true, color: 'draining', summary: '等待当前操作结束' },
      { control: 'manual', label: '已暂停', button: '启动', disabled: true, color: 'paused', summary: '人工接管中' },
      { control: 'paused', label: '连接失败', button: '…', disabled: true, color: 'error', summary: '按需连接', fail: true },
    ];
    for (const color of ['light', 'dark']) for (const width of [1440, 375]) {
      await page.emulateMedia({ colorScheme: color }); await page.setViewportSize({ width, height: 1100 });
      for (const item of cases) {
        await fresh(item.control, { busy: item.control === 'draining', fail: item.fail }); await expectedPill(item.label);
        assert.equal(await page.locator('#primary-action').innerText(), item.button);
        assert.equal(await page.locator('#primary-action').isDisabled(), item.disabled);
        assert.equal(await page.locator('#status-pill').getAttribute('data-state'), item.color);
        assert.equal(await page.locator('#takeover-link').isVisible(), item.control === 'manual');
        assert.equal(await page.locator('#settings-browser .section-summary').innerText(), item.summary);
        assert.equal(await page.locator('.top-actions').getByRole('button', { name: '释放接管', exact: true }).count(), 0);
        if (item.control === 'manual') {
          assert.equal(await page.locator('#primary-action').getAttribute('title'), '请先在浏览器接管分区释放接管');
          const hint = await page.locator('#primary-action').getAttribute('aria-describedby'); assert.equal(hint, 'takeover-hint');
          assert.equal(await page.locator('#' + hint).textContent(), '请先在浏览器接管分区释放接管');
        } else assert.equal(await page.locator('#primary-action').getAttribute('aria-describedby'), null);
        await layout(item.control === 'manual'); await shot('run-control-' + color + '-' + width + '-' + (item.fail ? 'read-failure' : item.control));
      }
    }
  });
  await check('顶部接管链接从动态打开并展开浏览器分区', async () => {
    await fresh('manual', { route: 'feed' }); await page.locator('#takeover-link').click(); await page.locator('#connect').waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#/settings/browser');
    assert.equal(await page.locator('#settings-browser').evaluate(el => el.open), true);
    assert.equal(await page.locator('.diagnostics').evaluate(el => el.open), true);
    assert.equal(await page.locator('#desktop-frame').count(), 0); assert.equal(await page.locator('#release').isVisible(), true);
  });
  await check('顶部启动和暂停保持运行模式，排空时控制禁用', async () => {
    for (const mode of ['draft', 'auto']) {
      await fresh('paused', { mode }); await page.locator('#primary-action').click(); await expectedPill('运行中'); await enabled('#primary-action');
      assert.equal(state.config.mode, mode);
      assert.equal(await page.locator('#notice').innerText(), '已启动' + (mode === 'draft' ? '（草稿模式，只生成草稿，不发送）' : ''));
      holdAction = 'pause'; await page.locator('#primary-action').click(); await waitHeld('pause'); await refresh(); await expectedPill('正在暂停…');
      assert.equal(await page.locator('#primary-action').isDisabled(), true); assert.equal(await page.locator('#connect').isDisabled(), true);
      assert.equal(await page.locator('#settings-browser .section-summary').innerText(), '等待当前操作结束');
      releaseAction(); await expectedPill('已暂停'); await enabled('#primary-action'); assert.equal(state.config.mode, mode); assert.equal(await page.locator('#primary-action').isEnabled(), true);
    }
  });
  await check('排空无操作时沿用重试暂停，发起请求后禁用', async () => {
    await fresh('draining'); assert.equal(await page.locator('#primary-action').innerText(), '重试暂停');
    holdAction = 'pause'; await page.locator('#primary-action').click(); await waitHeld('pause'); assert.equal(await page.locator('#primary-action').isDisabled(), true);
    releaseAction(); await expectedPill('已暂停');
  });
  await check('未连接桌面也能在分区释放接管，保持暂停并返回423', async () => {
    await fresh('manual'); assert.equal(await page.locator('#desktop-frame').count(), 0); assert.equal(await page.locator('#release').isEnabled(), true);
    holdAction = 'release'; await page.locator('#release').click(); await waitHeld('release');
    assert.equal(await page.locator('#release').isDisabled(), true); assert.equal(await page.locator('#connect').isDisabled(), true);
    releaseAction(); await expectedPill('已暂停'); await page.locator('#release').waitFor({ state: 'detached' }); await enabled('#primary-action');
    assert.equal(await page.locator('#primary-action').isEnabled(), true); assert.equal(await page.locator('#takeover-link').isVisible(), false);
    assert.equal(await page.locator('#settings-browser .section-summary').innerText(), '按需连接');
    assert.equal(await page.locator('#notice').innerText(), '已释放接管，处理保持暂停，可在顶部启动');
    assert.equal((await context.request.get(BASE + '/desktop/vnc.html')).status(), 423);
  });
  await check('分区接管排空、连接合成桌面、释放后卸载且423', async () => {
    await fresh('paused'); holdAction = 'takeover'; await page.locator('#connect').click(); await waitHeld('takeover'); await refresh();
    await expectedPill('正在暂停…'); assert.match(await page.locator('#settings-browser').innerText(), /正在等待当前操作结束/);
    releaseAction(); await page.locator('#desktop-frame').waitFor(); await page.frameLocator('#desktop-frame').getByRole('heading', { name: '合成浏览器桌面' }).waitFor();
    assert.equal(state.control, 'manual'); await expectedPill('已暂停'); assert.equal(await page.locator('#primary-action').isDisabled(), true);
    assert.equal(await page.locator('.desk-bar #release').isVisible(), true); assert.equal(await page.locator('#open-new-tab').isVisible(), true);
    assert.equal((await context.request.get(BASE + '/desktop/vnc.html')).status(), 200);
    failStatus = true; await refresh(); await expectedPill('连接失败'); assert.equal(await page.locator('#desktop-frame').count(), 1); assert.equal(await page.locator('#release').isDisabled(), true);
    failStatus = false; await refresh(); await page.locator('#release').click(); await expectedPill('已暂停'); await page.locator('#desktop-frame').waitFor({ state: 'detached' }); await enabled('#primary-action');
    assert.equal(state.control, 'paused'); assert.equal(await page.locator('#primary-action').isEnabled(), true);
    assert.equal(await page.locator('#notice').innerText(), '已释放接管，处理保持暂停，可在顶部启动');
    assert.equal((await context.request.get(BASE + '/desktop/vnc.html')).status(), 423);
  });
  assert.equal(report.requests.some(r => r.method !== 'GET' && !r.path.startsWith('/api/control/')), false, '验收意外写入业务配置');
} catch (error) { report.errors.push({ name: '总体断言', error: error.stack || String(error) }); }
finally {
  releaseAction?.(); await context.close(); await browser.close(); await new Promise(done => server.close(done));
  writeFileSync(OUT + '/run-control-ui-acceptance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); if (report.errors.length) process.exitCode = 1;
}
