// Staging end-to-end checks for the panel. Runs inside the browser image (chromium + playwright-core).
// Every check gets a fresh browser context; results go to /artifacts/panel-e2e.json.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.PANEL_URL || 'http://127.0.0.1:8081';
const checks = [];
export function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------- checks

check('providers API', async (page, { request }) => {
  const r = await request.get(BASE + '/api/model/providers');
  assert.equal(r.status(), 200);
  assert.ok((await r.json()).some(p => p.id === 'deepseek'));
});

async function openPanel(page, route = 'overview') {
  await page.goto(BASE + '/#/' + route);
  await page.locator('#status-pill', { hasText: '已暂停' }).waitFor({ timeout: 15000 });
}

check('overview loads', async page => {
  await openPanel(page);
  assert.equal((await page.locator('#primary-action').innerText()).trim(), '恢复处理');
});

check('resume needs handle', async page => {
  await openPanel(page);
  await page.click('#primary-action');
  await page.waitForFunction(() => document.getElementById('notice')?.textContent.includes('预期 X 账号'), null, { timeout: 20000 });
  assert.equal((await page.locator('#status-pill').innerText()).trim(), '已暂停');
});

check('handle save/clear', async page => {
  await openPanel(page);
  await page.fill('#handle-input', '@Role_Demo');
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/account') && r.status() === 200), page.click('#handle-save')]);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('handle-input')?.value === 'role_demo', null, { timeout: 15000 });
  await page.fill('#handle-input', '');
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/account') && r.status() === 200), page.click('#handle-save')]);
  await page.reload();
  await openPanel(page);
  await page.waitForTimeout(500);
  assert.equal(await page.inputValue('#handle-input'), '');
});

check('logs render', async page => {
  await openPanel(page);
  await page.locator('#logs li').first().waitFor({ timeout: 15000 });
  assert.ok(await page.locator('#logs li').count() >= 1);
});

check('theme', async page => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPanel(page);
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: '/artifacts/overview-light.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: '/artifacts/overview-dark.png', fullPage: true });
  assert.notEqual(light, dark);
});

check('mobile', async page => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openPanel(page);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 375, 'scrollWidth=' + width);
  await page.screenshot({ path: '/artifacts/overview-mobile.png', fullPage: true });
});

// ---- model page
const MOCK = 'http://mock-model:8080/v1';
const STAGING_KEY = 'staging-key-0001';

async function openModel(page) {
  await openPanel(page, 'model');
  await page.locator('#provider-select').waitFor({ timeout: 15000 });
}
async function pickProvider(page, id) {
  await page.click('#provider-select');
  await page.click(`#provider-list [data-provider="${id}"]`);
}
async function pickModel(page, id) {
  await page.click('#model-input');
  await page.click(`#model-list [data-model="${id}"]`);
}
async function discover(page) {
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/model/discover'), { timeout: 30000 }), page.click('#discover')]);
  await page.locator('#model-list [data-model]').first().waitFor({ timeout: 15000 });
}

check('provider list', async page => {
  await openModel(page);
  await page.click('#provider-select');
  assert.equal(await page.locator('#provider-list [data-provider="deepseek"]').count(), 1);
  assert.equal(await page.locator('#provider-list [data-provider="custom"]').count(), 1);
  assert.equal(await page.locator('#provider-list [data-provider="amazon-bedrock"]').count(), 0);
});

check('builtin provider', async page => {
  await openModel(page);
  await pickProvider(page, 'deepseek');
  assert.equal(await page.inputValue('#base-url'), 'https://api.deepseek.com');
  assert.equal(await page.locator('input[name=api]').first().isVisible(), false);
  await pickModel(page, 'deepseek-flash');
  await page.waitForFunction(() => document.getElementById('model-info')?.textContent.includes('1M'), null, { timeout: 10000 });
  await page.screenshot({ path: '/artifacts/model-builtin.png', fullPage: true });
});

check('custom discover/test/save', async page => {
  await openModel(page);
  await pickProvider(page, 'custom');
  await page.fill('#base-url', MOCK);
  await page.check('input[name=api][value="openai-completions"]');
  await page.fill('#api-key', STAGING_KEY);
  await discover(page);
  assert.match(await page.locator('#model-list [data-model="deepseek-flash"]').innerText(), /pi 已识别/);
  assert.match(await page.locator('#model-list [data-model="my-finetune-v2"]').innerText(), /需手填参数/);
  await page.click('#model-list [data-model="my-finetune-v2"]');
  await page.click('#test');
  await page.waitForFunction(() => document.getElementById('test-result')?.textContent.includes('通过'), null, { timeout: 30000 });
  await page.screenshot({ path: '/artifacts/model-custom.png', fullPage: true });
  await page.click('#save');
  await page.waitForFunction(() => document.getElementById('notice')?.textContent.includes('下一轮处理生效'), null, { timeout: 15000 });
  assert.equal((await page.locator('#status-pill').innerText()).trim(), '已暂停');
  await page.reload();
  await openModel(page);
  await page.waitForFunction(() => document.getElementById('key-state')?.textContent.includes('••••0001'), null, { timeout: 10000 });
  assert.ok(!(await page.evaluate(() => document.documentElement.outerHTML)).includes(STAGING_KEY));
});

check('unknown model params', async page => {
  await openModel(page);
  await page.locator('#custom-context').waitFor({ timeout: 10000 });
  assert.equal(await page.inputValue('#model-input'), 'my-finetune-v2');
  assert.equal(await page.inputValue('#custom-context'), '128000');
  assert.equal(await page.isChecked('#custom-reasoning'), false);
});

check('leave with unsaved changes', async page => {
  await openModel(page);
  await page.click('#advanced summary');
  await page.fill('#max-tokens', '2048');
  await page.click('a[href="#/overview"]');
  await page.locator('#confirm-leave').waitFor({ state: 'visible', timeout: 5000 });
  await page.click('#confirm-leave button:has-text("留下")');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => location.hash), '#/model');
  assert.equal(await page.locator('#provider-select').count(), 1);
});

check('host change', async page => {
  await openModel(page);
  await page.waitForFunction(() => document.getElementById('key-state')?.textContent.includes('已设置'), null, { timeout: 10000 });
  await page.fill('#api-key', 'typed-0003');
  await page.fill('#base-url', 'http://other-host:8080/v1');
  await page.waitForFunction(() => document.getElementById('key-state')?.textContent.includes('地址的主机变了'), null, { timeout: 5000 });
  assert.equal(await page.inputValue('#api-key'), '');
});

check('typed key cleared on provider switch', async page => {
  await openModel(page);
  await page.fill('#api-key', 'typed-0002');
  await pickProvider(page, 'deepseek');
  assert.equal(await page.inputValue('#api-key'), '');
});

check('save without test', async page => {
  await openModel(page);
  await discover(page);
  await page.click('#model-list [data-model="deepseek-flash"]');
  await page.click('#save');
  await page.locator('#confirm-save').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await page.locator('#confirm-save').innerText(), /未通过测试，仍要保存吗/);
});

check('failed test then save asks', async page => {
  await openModel(page);
  await page.waitForFunction(() => document.getElementById('key-state')?.textContent.includes('已设置'), null, { timeout: 10000 });
  await page.fill('#api-key', 'wrong-key-0009');
  await page.click('#test');
  await page.waitForFunction(() => document.getElementById('test-result')?.textContent.includes('失败'), null, { timeout: 30000 });
  await page.click('#save');
  await page.locator('#confirm-save').waitFor({ state: 'visible', timeout: 5000 });
});

check('provider select locked while loading', async page => {
  await page.route('**/api/model', async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
  await page.goto(BASE + '/#/model');
  await page.locator('#provider-select').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#provider-select').isDisabled(), true);
  await page.waitForFunction(() => !document.getElementById('provider-select').disabled, null, { timeout: 10000 });
});

check('big list', async page => {
  await openModel(page);
  await page.fill('#base-url', 'http://mock-model:8080/big/v1');
  await page.fill('#api-key', STAGING_KEY);
  await discover(page);
  assert.equal(await page.locator('#model-list [data-model]').count(), 1000);
  await page.fill('#model-search', 'm-0999');
  await page.waitForFunction(() => document.querySelectorAll('#model-list [data-model]').length === 1, null, { timeout: 5000 });
  await page.fill('#model-search', 'm-1499');
  await page.waitForFunction(() => document.querySelectorAll('#model-list [data-model]').length === 0, null, { timeout: 5000 });
});

// ---- browser page (staging has no browser container, so takeover always fails; keep these last)
check('status blip keeps desktop', async page => {
  let fail = false;
  const fake = () => ({ control: 'manual', busy: false, config: { expectedHandle: '', mode: 'draft', model: {} }, configError: '', browser: { loggedIn: false }, lastTick: 0, cooldown: { public: 0, private: 0 }, stats: { messages: [], usage: {} }, now: Date.now() });
  await page.route('**/api/status', route => (fail ? route.abort() : route.fulfill({ json: fake() })));
  await page.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stub</title><p>desktop stub</p>' }));
  await page.goto(BASE + '/#/browser');
  await page.locator('#connect', { hasText: '连接桌面' }).waitFor({ timeout: 15000 });
  await page.click('#connect');
  await page.locator('#desktop-frame').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#open-new-tab').isVisible(), true);
  assert.equal(await page.locator('#primary-action', { hasText: '释放接管' }).isVisible(), true);
  fail = true;
  await page.waitForFunction(() => document.getElementById('conn')?.dataset.state === 'error', null, { timeout: 15000 });
  assert.equal(await page.locator('#desktop-frame').count(), 1);
});

check('top bar releases connected desktop', async page => {
  let control = 'manual';
  const fake = () => ({ control, busy: false, config: { expectedHandle: '', mode: 'draft', model: {} }, configError: '', browser: { loggedIn: false }, lastTick: 0, cooldown: { public: 0, private: 0 }, stats: { messages: [], usage: {} }, now: Date.now() });
  await page.route('**/api/status', route => route.fulfill({ json: fake() }));
  await page.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stub</title><p>desktop stub</p>' }));
  await page.route('**/api/control/release', route => {
    control = 'paused';
    return route.fulfill({ json: { ok: true, control } });
  });
  await page.goto(BASE + '/#/browser');
  await page.locator('#connect', { hasText: '连接桌面' }).click();
  await page.locator('#desktop-frame').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#release').count(), 0);
  assert.equal(await page.locator('#open-new-tab').isVisible(), true);
  await page.locator('#primary-action', { hasText: '释放接管' }).click();
  await page.locator('#status-pill', { hasText: '已暂停' }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#desktop-frame').count(), 0);
  await page.getByText('浏览器未连接').waitFor();
});

check('browser idle', async page => {
  await openPanel(page, 'browser');
  await page.getByText('浏览器未连接').waitFor({ timeout: 10000 });
  assert.equal((await page.locator('#connect').innerText()).trim(), '接管并连接');
  assert.equal(await page.locator('#desktop-frame').count(), 0);
  await page.screenshot({ path: '/artifacts/browser-idle.png', fullPage: true });
});

check('connect failure stays disconnected', async page => {
  await openPanel(page, 'browser');
  await page.click('#connect');
  await page.waitForFunction(() => { const n = document.getElementById('notice'); return n && !n.hidden && n.dataset.kind === 'error'; }, null, { timeout: 30000 });
  assert.equal(await page.locator('#desktop-frame').count(), 0);
  assert.notEqual((await page.locator('#status-pill').innerText()).trim(), '人工接管中');
  await page.locator('#primary-action', { hasText: '重试暂停' }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#primary-action').isEnabled(), true);
});

// ---------------------------------------------------------------- runner

const results = { checks: [], errors: [] };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, chromiumSandbox: true });
try {
  for (const { name, fn } of checks) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    try {
      await fn(page, { context, request: context.request, base: BASE });
      if (pageErrors.length) throw new Error('页面脚本异常：' + pageErrors.join('; '));
      results.checks.push(name);
    } catch (e) {
      results.errors.push(name + ': ' + (e?.message ?? e));
      await page.screenshot({ path: '/artifacts/fail-' + name.replace(/[^a-z0-9]+/gi, '-') + '.png', fullPage: true }).catch(() => {});
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync('/artifacts/panel-e2e.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
process.exit(results.errors.length ? 1 : 0);
