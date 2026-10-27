// 生产模型页只读验收：不保存设置、不测试计费接口、不修改控制状态。
import { observer } from '/opt/role-camoufox/launch.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const BASE = process.env.PANEL_URL || 'https://43.133.80.237';
const lines = readFileSync('/run/test/admin-access.txt', 'utf8').split('\n');
const field = i => (lines[i] || '').split('：')[1]?.trim();
const browser = await observer();
const context = await browser.newContext({ httpCredentials: { username: field(1), password: field(2) }, viewport: { width: 1440, height: 1000 } });
const results = { checks: [], errors: [] };
const page = await context.newPage();
const writes = [];
page.on('pageerror', e => results.errors.push(e.message));
page.on('request', r => { if (r.method() !== 'GET' && r.url().includes('/api/')) writes.push(r.url()); });
try {
  await page.goto(BASE + '/#/model');
  await page.locator('#provider-select:not([disabled])').waitFor({ timeout: 30000 });
  await page.click('#provider-select');
  for (const id of ['opencode', 'opencode-go', 'radius', 'github-copilot', 'commandcode']) assert.equal(await page.locator('[data-provider="' + id + '"]').isEnabled(), true);
  assert.equal(await page.locator('[data-provider="amazon-bedrock"]').isDisabled(), true);
  results.checks.push('完整供应商列表及接入状态');
  await page.fill('#provider-search', 'code');
  await page.screenshot({ path: '/artifacts/providers.png', fullPage: true });
  await page.click('[data-provider="commandcode"]');
  await page.locator('#commandcode-note').waitFor();
  await page.click('#model-input');
  await page.locator('[data-model="claude-sonnet-4-6"]').click();
  assert.equal(await page.inputValue('#base-url'), 'https://api.commandcode.ai/provider');
  assert.match(await page.locator('#model-info').innerText(), /未提供/);
  await page.click('#model-input');
  await page.locator('[data-model="gpt-6.1-sol"]').click();
  assert.equal(await page.inputValue('#base-url'), 'https://api.commandcode.ai/provider/v1');
  await page.screenshot({ path: '/artifacts/commandcode.png', fullPage: true });
  results.checks.push('Command Code 模型、协议地址、GOAT 说明和未映射价格');
  assert.deepEqual(writes, []);
  results.checks.push('未保存配置、未发起计费测试、未修改控制状态');
} catch (e) { results.errors.push(e?.message || String(e)); }
finally { await context.close(); await browser.close(); }
writeFileSync('/artifacts/providers-acceptance.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
process.exit(results.errors.length ? 1 : 0);
