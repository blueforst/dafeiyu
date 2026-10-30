// 在服务器容器中验证实际选择的浏览器，不访问或发送真实账号消息。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { launchBrowser, browserProfile } from '../dist/browser-launcher.js';
import { readTweets, readDM } from '../dist/browser.js';

const engine = 'camoufox';
const profile = mkdtempSync(tmpdir() + '/role-engine-');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>浏览器持久性测试</title><main>本地模拟页面</main>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let context;
const checks = [];
const result = { engine, checks };
try {
  assert.notEqual(process.getuid(), 0);
  if(process.env.LEGACY_DEVICE_PRESET){
    mkdirSync(browserProfile(profile),{recursive:true});
    copyFileSync(process.env.LEGACY_DEVICE_PRESET,browserProfile(profile)+'/device-preset.json');
    result.legacyPresetHash=createHash('sha256').update(readFileSync(process.env.LEGACY_DEVICE_PRESET)).digest('hex');
  }
  context = await launchBrowser(profile);
  let page = context.pages()[0] || await context.newPage();
  await page.goto(origin);
  result.version = context.browser()?.version();
  result.userAgent = await page.evaluate(() => navigator.userAgent);
  const device = async () => page.evaluate(() => ({ userAgent: navigator.userAgent, platform: navigator.platform, cores: navigator.hardwareConcurrency, language: navigator.language, screen: [screen.width, screen.height], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  const firstDevice = await device();
  assert.match(result.userAgent, /Firefox\//);
  checks.push('实际内核为 Camoufox，使用非 root 用户');

  await page.evaluate(() => {
    localStorage.setItem('role-engine-check', 'persisted');
    document.cookie = 'roleEngineCheck=persisted; max-age=3600; path=/';
  });
  await page.setContent('<main><article data-testid="tweet"><a href="/alice/status/123"><time datetime="2026-10-27T08:00:00Z"></time></a><div data-testid="tweetText">公开测试</div><div data-testid="tweetPhoto"></div></article></main>');
  const tweets = await readTweets(page);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].id, 'x:123');
  assert.equal(tweets[0].mediaUnavailable, true);
  checks.push('公开消息 DOM 解析');
  await page.setContent('<main><div data-testid="messageEntry" data-direction="in" data-message-id="m1"><div data-testid="messageEntryContent">私信测试</div></div></main>');
  assert.equal((await readDM(page, '1-2')).events[0].text, '私信测试');
  checks.push('私信模拟 DOM 解析');

  const presetPath = browserProfile(profile) + '/device-preset.json';
  const presetHash = createHash('sha256').update(readFileSync(presetPath)).digest('hex');
  if(result.legacyPresetHash){assert.equal(presetHash,result.legacyPresetHash);checks.push('升级沿用原设备预设，只在独立临时profile访问合成本地页面');}
  await context.close();
  if(process.env.EXPECTED_FIREFOX_VERSION){
    const cache='/opt/role-camoufox/cache/camoufox/',active=JSON.parse(readFileSync(cache+'config.json','utf8')).active_version;
    const ini=readFileSync(cache+active+'/application.ini','utf8');
    result.binaryVersion=ini.match(/^Version=(.+)$/m)?.[1];assert.ok(result.binaryVersion?.startsWith(process.env.EXPECTED_FIREFOX_VERSION));
    const prefs=readFileSync(browserProfile(profile)+'/prefs.js','utf8');
    assert.match(prefs,/user_pref\("services\.settings\.server", "https:\/\/firefox\.settings\.services\.mozilla\.com\/v1"\)/);
    assert.match(prefs,/user_pref\("extensions\.blocklist\.enabled", true\)/);
    checks.push('实际固定二进制版本及运行后安全偏好均核对通过');
  }
  context = await launchBrowser(profile);
  page = context.pages()[0] || await context.newPage();
  await page.goto(origin);
  assert.equal(await page.evaluate(() => localStorage.getItem('role-engine-check')), 'persisted');
  assert.equal((await context.cookies(origin)).find(cookie => cookie.name === 'roleEngineCheck')?.value, 'persisted');
  checks.push('重启后保留模拟 Cookie 和 localStorage');
  assert.equal(createHash('sha256').update(readFileSync(presetPath)).digest('hex'), presetHash);
  assert.deepEqual(await device(), firstDevice);
  checks.push('重启后设备预设保持一致');
  await page.screenshot({ path: '/artifacts/engine.png' });
  await context.close();
  context = undefined;
  writeFileSync(presetPath, '{');
  await assert.rejects(launchBrowser(profile), /设备预设损坏/);
  checks.push('设备预设损坏时停止启动，不静默更换身份或内核');
  writeFileSync('/artifacts/browser-engine-acceptance.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}
