// Production read-only acceptance for the panel. Only runs while processing is paused:
// it takes over the browser once (to prove noVNC works) and always releases afterwards.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = (process.env.PANEL_URL || 'https://43.133.80.237').replace(/\/$/, '');
const lines = (() => { try { return readFileSync('/run/test/admin-access.txt', 'utf8').split('\n'); } catch { return []; } })();
const field = i => (lines[i] || '').split('：')[1]?.trim();
const httpCredentials = field(2) ? { username: field(1) || 'operator', password: field(2) } : undefined;

const results = { checks: [], errors: [] };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, chromiumSandbox: true });
const context = await browser.newContext({ httpCredentials, viewport: { width: 1440, height: 1000 } });
let tookOver = false;
let exitCode = 0;

async function step(name, fn) {
  try { await fn(); results.checks.push(name); return true; }
  catch (e) { results.errors.push(name + ': ' + (e?.message ?? e)); return false; }
}

try {
  const status = await (await context.request.get(BASE + '/api/status')).json();
  if (status.control !== 'paused') {
    console.log(JSON.stringify({ skipped: 'control=' + status.control + '，只在暂停时验收' }));
    exitCode = 2;
  } else {
    const page = await context.newPage();
    page.on('pageerror', e => results.errors.push('页面脚本异常：' + e.message));

    const pagesOk = await step('三个页面加载', async () => {
      await page.goto(BASE + '/#/overview');
      await page.locator('#status-pill', { hasText: '已暂停' }).waitFor({ timeout: 20000 });
      await page.locator('#logs').waitFor();
      await page.click('a[href="#/model"]');
      await page.locator('#provider-select').waitFor({ timeout: 20000 });
      await page.click('#provider-select');
      await page.locator('#provider-list [data-provider="deepseek"]').waitFor({ timeout: 30000 });
      await page.click('a[href="#/browser"]');
      await page.getByText('浏览器未连接').waitFor({ timeout: 10000 });
      assert.equal(await page.locator('#desktop-frame').count(), 0);
    });

    // Takeover pauses processing, so re-check right before clicking and stop at the first failure.
    const connected = pagesOk && await step('接管后 noVNC 画布连上', async () => {
      const now = await (await context.request.get(BASE + '/api/status')).json();
      if (now.control !== 'paused') throw new Error('control=' + now.control + '，不再接管');
      await page.click('#connect');
      tookOver = true;
      const failed = page.waitForFunction(() => { const n = document.getElementById('notice'); return n && !n.hidden && n.dataset.kind === 'error' ? n.textContent : false; }, null, { timeout: 120000 }).then(h => h.jsonValue()).catch(() => false);
      const mounted = page.locator('#desktop-frame').waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
      const outcome = await Promise.race([mounted.then(ok => ({ mounted: ok })), failed.then(text => ({ error: text }))]);
      if (outcome.error) throw new Error('接管失败：' + outcome.error);
      if (await page.locator('#desktop-frame').count() === 0) throw new Error('桌面没有出现');
      const frame = await (await page.locator('#desktop-frame').elementHandle()).contentFrame();
      assert.ok(frame, '找不到桌面 iframe');
      await frame.waitForURL(/\/desktop\/vnc\.html/, { timeout: 30000 });
      await frame.waitForFunction(() => document.documentElement.classList.contains('noVNC_connected') && document.querySelector('#noVNC_container canvas')?.width > 100, null, { timeout: 30000 });
      await frame.waitForFunction(() => { const c = document.querySelector('#noVNC_container canvas'); if (!c) return false; const x = c.getContext('2d'); if (!x) return false; const a = x.getImageData(0, 0, Math.min(c.width, 800), Math.min(c.height, 600)).data; const colors = new Set(); for (let i = 0; i < a.length; i += 400) if (a[i + 3]) colors.add(a[i] + ',' + a[i + 1] + ',' + a[i + 2]); return colors.size > 12; }, null, { timeout: 20000 });
      await page.screenshot({ path: '/artifacts/panel-desktop.png', fullPage: true });
    });

    if (connected) await step('释放后断开并封锁桌面入口', async () => {
      await page.locator('#primary-action', { hasText: '释放接管' }).click();
      await page.locator('#status-pill', { hasText: '已暂停' }).waitFor({ timeout: 120000 });
      tookOver = false;
      assert.equal(await page.locator('#desktop-frame').count(), 0);
      assert.equal((await context.request.get(BASE + '/desktop/vnc.html')).status(), 423);
    });

    await step('浅色与深色截图', async () => {
      await page.click('a[href="#/overview"]');
      await page.locator('#logs').waitFor();
      await page.emulateMedia({ colorScheme: 'light' });
      await page.screenshot({ path: '/artifacts/panel-light.png', fullPage: true });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.screenshot({ path: '/artifacts/panel-dark.png', fullPage: true });
    });

    writeFileSync('/artifacts/ui-acceptance.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
    exitCode = results.errors.length ? 1 : 0;
  }
} finally {
  if (tookOver) await context.request.post(BASE + '/api/control/release', { headers: { 'x-workflow-control': '1' } }).catch(() => {});
  await context.close();
  await browser.close();
}
process.exit(exitCode);
