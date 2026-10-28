// 服务器隔离验收：真实 dist、临时 SQLite 和本地 noVNC/Xvfb；不读取生产地址、账号或 profile。
import { observer } from '/opt/role-camoufox/launch.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startPanelFixture } from './panel-isolated-fixture.mjs';

const OUT = process.env.ARTIFACT_DIR || '/artifacts';
mkdirSync(OUT, { recursive: true });
const results = {
  evidence: '服务器 --network none 隔离验收；真实 dist app/SQLite/ModelLibrary、临时 Camoufox profile、noVNC→x11vnc→临时 Xvfb 本地彩色夹具；未访问生产、X 或真实模型',
  checks: [], errors: [], screenshots: [], externalAttempts: [], desktopResponses: [], desktopConnections: [],
};
let fixture, browser, context, page, baseURL;

async function step(name, fn) {
  console.log('开始 ' + name);
  try { await fn(); results.checks.push(name); console.log('通过 ' + name); }
  catch (error) {
    results.errors.push({ name, error: error.stack || String(error), visible: await page?.locator('body').innerText().catch(() => '') });
    if (page) await screenshot('失败-' + results.checks.length).catch(() => {});
    throw error;
  }
}
async function screenshot(name) {
  await page.screenshot({ path: OUT + '/' + name + '.png', fullPage: true });
  results.screenshots.push(name + '.png');
}
function desktopPixels() {
  const canvas = document.querySelector('#noVNC_container canvas'), context = canvas?.getContext('2d'), colors = new Set();
  if (context) {
    const pixels = context.getImageData(0, 0, Math.min(canvas.width, 800), Math.min(canvas.height, 600)).data;
    for (let i = 0; i < pixels.length; i += 400) if (pixels[i + 3]) colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
  }
  return { url: location.href, connected: document.documentElement.classList.contains('noVNC_connected'), width: canvas?.width || 0, height: canvas?.height || 0, sampledColors: colors.size };
}
async function connectedDesktop(label) {
  let frame;
  try {
    await page.locator('#desktop-frame').waitFor({ timeout: 30000 });
    await page.locator('#desktop-frame').scrollIntoViewIfNeeded();
    frame = await (await page.locator('#desktop-frame').elementHandle()).contentFrame();
    assert.ok(frame, label + '：找不到真实 noVNC iframe');
    // 新 iframe 刚插入时仍是 about:blank；先跨过导航，随后在 noVNC 文档里检查连接和像素。
    await frame.waitForURL(/\/desktop\/vnc\.html/, { timeout: 30000 });
    await frame.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await frame.waitForFunction(() => document.documentElement.classList.contains('noVNC_connected') && document.querySelector('#noVNC_container canvas')?.width > 100, null, { timeout: 30000, polling: 100 });
    await frame.waitForFunction(() => {
      const canvas = document.querySelector('#noVNC_container canvas'), context = canvas?.getContext('2d');
      if (!context) return false;
      const pixels = context.getImageData(0, 0, Math.min(canvas.width, 800), Math.min(canvas.height, 600)).data, colors = new Set();
      for (let i = 0; i < pixels.length; i += 400) if (pixels[i + 3]) colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
      return colors.size > 12;
    }, null, { timeout: 20000, polling: 100 });
    const evidence = { label, ...await frame.evaluate(desktopPixels) };
    assert.ok(evidence.connected && evidence.width > 100 && evidence.sampledColors > 12, label + '：noVNC 连接或像素断言失败');
    results.desktopConnections.push(evidence);
    return evidence;
  } catch (error) {
    const diagnostic = { label, iframeSrc: await page.locator('#desktop-frame').getAttribute('src').catch(() => null), frameURL: frame?.url(), panelStatus: await status().catch(statusError => ({ error: String(statusError) })), responses: results.desktopResponses.slice(-60) };
    if (frame) diagnostic.document = await frame.evaluate(() => ({ url: location.href, readyState: document.readyState, classes: document.documentElement.className, body: document.body?.innerText.slice(0, 8000), noVncStatus: document.querySelector('#noVNC_status')?.textContent, transition: document.querySelector('#noVNC_transition_text')?.textContent, canvas: [...document.querySelectorAll('canvas')].map(canvas => ({ width: canvas.width, height: canvas.height })) })).catch(frameError => ({ error: String(frameError) }));
    (results.desktopDiagnostics ||= []).push(diagnostic);
    throw error;
  }
}
async function status() {
  const response = await context.request.get(baseURL + '/api/status');
  assert.equal(response.status(), 200);
  return response.json();
}
async function topPaused(manual) {
  await page.waitForFunction(manual => {
    const pill = document.getElementById('status-pill'), button = document.getElementById('primary-action'), link = document.getElementById('takeover-link');
    return pill?.textContent === '已暂停' && button?.textContent === '启动' && button.disabled === manual && link.hidden === !manual;
  }, manual);
  assert.equal(await page.locator('.top-actions').getByRole('button', { name: '释放接管', exact: true }).count(), 0);
  if (manual) {
    assert.equal(await page.locator('#primary-action').getAttribute('title'), '请先在浏览器接管分区释放接管');
    assert.equal(await page.locator('#primary-action').getAttribute('aria-describedby'), 'takeover-hint');
    assert.equal(await page.locator('#takeover-hint').textContent(), '请先在浏览器接管分区释放接管');
  }
}
async function navigate(route, heading, ready) {
  await page.locator('.tabs a[href="#/' + route + '"]').click();
  await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
  await page.locator(ready).first().waitFor();
  assert.equal(new URL(page.url()).hash, '#/' + route);
  assert.equal(await page.locator('.tabs a[aria-current="page"]').getAttribute('data-route'), route);
}
async function noOverflow(manual) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '页面出现整体横向滚动');
  for (const selector of ['#status-pill', '#primary-action', ...(manual ? ['#takeover-link'] : [])]) {
    assert.equal(await page.locator(selector).isVisible(), true, selector + ' 应可见');
    const bounds = await page.locator(selector).boundingBox(), width = await page.evaluate(() => innerWidth);
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, selector + ' 超出屏幕');
  }
}

try {
  fixture = await startPanelFixture({ desktop: true });
  baseURL = fixture.baseURL;
  fixture.state.loggedIn = true;
  fixture.running.store.log('isolated-ui', '本地隔离桌面验收开始');
  browser = await observer();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL) return route.continue();
    results.externalAttempts.push(url.host);
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => results.errors.push({ name: '页面脚本异常', error: error.stack || String(error) }));
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/desktop/')) results.desktopResponses.push({ url: response.url(), status: response.status() }); });
  page.on('requestfailed', request => { if (new URL(request.url()).pathname.startsWith('/desktop/')) results.desktopResponses.push({ url: request.url(), failure: request.failure()?.errorText }); });

  await step('初始保持暂停且桌面入口封锁', async () => {
    const initial = await status();
    results.initialControl = initial.control;
    assert.equal(initial.control, 'paused');
    assert.equal(initial.config.mode, 'draft');
    assert.equal(initial.browser.handle, fixture.state.handle);
    assert.equal((await context.request.get(baseURL + '/desktop/vnc.html')).status(), 423);
    await page.goto(baseURL + '/#/feed');
    await topPaused(false);
  });

  await step('当前五页、登录账号和设置模型库正常加载', async () => {
    assert.equal(await page.locator('.tabs a').count(), 5);
    assert.deepEqual(await page.locator('.tabs a').evaluateAll(nodes => nodes.map(node => node.dataset.route)), ['feed', 'persona', 'memory', 'settings', 'billing']);
    await page.locator('.feed-overview').filter({ hasText: '@' + fixture.state.handle }).waitFor();
    assert.equal(await page.locator('#handle-input, #handle-save, #handle-use-current').count(), 0);
    assert.doesNotMatch(await page.locator('.feed-overview').innerText(), /预期账号/);
    assert.equal((await context.request.put(baseURL + '/api/account', { data: {}, headers: { 'x-workflow-control': '1' } })).status(), 404);
    await navigate('persona', '人设', '#persona-section-0');
    await navigate('memory', '记忆', '#memory-users .empty-state');
    await navigate('settings', '设置', '#program-mode');
    await page.goto(baseURL + '/#/settings/model');
    await page.locator('#settings-model[open] .provider-row').first().waitFor();
    await page.locator('#settings-model .model-row').filter({ hasText: 'my-finetune-v2' }).waitFor();
    assert.equal(await page.locator('#settings-model #base-url').inputValue(), fixture.modelURL);
    assert.equal(await page.locator('#settings-model #api-key').inputValue(), '');
    assert.match(await page.locator('#settings-model').innerText(), /••••0001/);
    assert.ok(!(await page.content()).includes(fixture.modelKey), '页面不能返回完整 Key');
    await page.goto(baseURL + '/#/settings/logs');
    await page.locator('#program-logs li').filter({ hasText: '本地隔离桌面验收开始' }).waitFor();
    await navigate('billing', '计费', '.usage-heatmap');
    await topPaused(false);
    assert.equal((await status()).control, 'paused', '页面加载不能启动处理');
    assert.equal(fixture.requests.filter(request => request.service === 'model').length, 0, '只读页面不能调用模型');
  });

  await step('设置分区接管后真实 noVNC 画布和像素可用', async () => {
    await page.goto(baseURL + '/#/settings/browser');
    await page.locator('#settings-browser[open] #connect').filter({ hasText: '接管并连接' }).waitFor();
    assert.equal(await page.locator('#desktop-frame').count(), 0);
    assert.equal(await page.locator('#settings-browser .section-summary').innerText(), '按需连接');
    assert.equal((await status()).control, 'paused');
    await page.locator('#settings-browser #connect').click();
    await page.locator('#desktop-frame').waitFor({ timeout: 30000 });
    await topPaused(true);
    assert.equal((await status()).control, 'manual');
    assert.equal(await page.locator('#settings-browser .section-summary').innerText(), '人工接管中');
    assert.equal(await page.locator('#settings-browser .desk-bar #release').isVisible(), true);
    assert.equal(await page.locator('#open-new-tab').isVisible(), true);
    assert.equal((await context.request.get(baseURL + '/desktop/vnc.html')).status(), 200);
    results.desktop = await connectedDesktop('首次接管连接');
    await screenshot('panel-desktop');
  });

  await step('接管期间浅深主题和1440/375顶部内容完整', async () => {
    for (const colorScheme of ['light', 'dark']) for (const width of [1440, 375]) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 1000 });
      await topPaused(true);
      await noOverflow(true);
      await screenshot('panel-manual-' + colorScheme + '-' + width);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  await step('顶部接管链接打开分区并在分区释放、断开且返回423', async () => {
    await page.locator('.tabs a[href="#/feed"]').click();
    await page.locator('.feed-overview').waitFor();
    await topPaused(true);
    await page.locator('#takeover-link').click();
    await page.locator('#settings-browser[open] #release').waitFor();
    assert.equal(new URL(page.url()).hash, '#/settings/browser');
    assert.equal(await page.locator('.diagnostics').evaluate(element => element.open), true);
    // 切换页面已卸载桌面，但分区仍必须提供释放入口。
    assert.equal(await page.locator('#desktop-frame').count(), 0);
    await page.locator('#settings-browser #connect').click();
    await page.locator('#desktop-frame').waitFor();
    results.reconnectedDesktop = await connectedDesktop('从顶部链接返回后重新连接');
    await page.locator('#settings-browser .desk-bar #release').click();
    await page.locator('#desktop-frame').waitFor({ state: 'detached', timeout: 30000 });
    await topPaused(false);
    assert.equal((await status()).control, 'paused');
    assert.equal(await page.locator('#settings-browser .section-summary').innerText(), '按需连接');
    assert.equal(await page.locator('#notice').innerText(), '已释放接管，处理保持暂停，可在顶部启动');
    assert.equal((await context.request.get(baseURL + '/desktop/vnc.html')).status(), 423);
    assert.equal(await page.locator('#release').isVisible(), false);
    assert.equal(await page.locator('#release').isDisabled(), true);
  });

  await step('五页浅深主题与窄屏截图，释放后持续暂停', async () => {
    let light, dark;
    for (const colorScheme of ['light', 'dark']) for (const width of [1440, 375]) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 1000 });
      for (const [route, heading, ready] of [['feed', '动态', '.feed-overview'], ['persona', '人设', '#persona-section-0'], ['memory', '记忆', '#memory-users .empty-state'], ['settings', '设置', '#program-mode'], ['billing', '计费', '.usage-heatmap']]) {
        await navigate(route, heading, ready);
        await topPaused(false);
        await noOverflow(false);
        await screenshot('panel-' + route + '-' + colorScheme + '-' + width);
        if (route === 'feed' && width === 1440) {
          const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          if (colorScheme === 'light') light = background; else dark = background;
        }
      }
    }
    assert.notEqual(light, dark, '浅深主题应有不同背景色');
    const final = await status();
    results.finalControl = final.control;
    assert.equal(final.control, 'paused');
    assert.equal(final.config.mode, 'draft');
    assert.deepEqual(fixture.requests.filter(request => request.service === 'panel' && request.path.startsWith('/api/control/')).map(request => request.path), ['/api/control/takeover', '/api/control/release']);
    assert.equal(fixture.requests.filter(request => request.service === 'model').length, 0, '桌面验收不应调用模型');
    assert.deepEqual(fixture.externalAttempts, []);
    assert.deepEqual(results.externalAttempts, []);
  });
} catch (error) {
  if (!results.errors.length) results.errors.push({ name: '隔离验收初始化', error: error.stack || String(error) });
} finally {
  results.externalAttempts.push(...(fixture?.externalAttempts || []));
  results.requests = fixture?.requests || [];
  if (fixture && context) {
    const final = await context.request.get(baseURL + '/api/status').then(response => response.json()).catch(() => null);
    // 仅清理本脚本创建的临时隔离环境；正常验收的释放必须由分区按钮完成。
    if (final?.control === 'manual') await context.request.post(baseURL + '/api/control/release', { headers: { 'x-workflow-control': '1' } }).catch(() => {});
  }
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await fixture?.close().catch(error => results.errors.push({ name: '隔离夹具清理', error: String(error) }));
  writeFileSync(OUT + '/ui-acceptance.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  if (results.errors.length) process.exitCode = 1;
}
