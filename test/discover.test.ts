import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { discoverModels } from '../src/model-catalog.js';

type Seen = { url: string; headers: IncomingHttpHeaders };
async function mock(status: number, body: unknown, fn: (base: string, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try { await fn('http://127.0.0.1:' + (server.address() as any).port, seen); } finally { await new Promise<void>(r => server.close(() => r())); }
}

test('OpenAI 兼容接口：结尾斜杠不产生双斜杠，按 pi 目录识别模型', async () => {
  await mock(200, { data: [{ id: 'deepseek-flash' }, { id: 'zzz-unknown' }] }, async (base, seen) => {
    const r = await discoverModels({ provider: 'custom', baseUrl: base + '/v1/', api: 'openai-completions', apiKey: 'k1' });
    assert.equal(seen[0].url, '/v1/models');
    assert.equal(seen[0].headers.authorization, 'Bearer k1');
    assert.deepEqual(r.models.map(m => [m.id, m.known]), [['deepseek-flash', true], ['zzz-unknown', false]]);
    assert.equal(r.models[0].info?.contextWindow, 1000000);
    assert.equal(r.total, 2);
  });
});

test('Anthropic 接口：有无 /v1 都请求 /v1/models，并带 x-api-key', async () => {
  await mock(200, { data: [{ id: 'm1' }] }, async (base, seen) => {
    await discoverModels({ provider: 'custom', baseUrl: base, api: 'anthropic-messages', apiKey: 'k1' });
    await discoverModels({ provider: 'custom', baseUrl: base + '/v1', api: 'anthropic-messages', apiKey: 'k1' });
    assert.deepEqual(seen.map(s => s.url), ['/v1/models', '/v1/models']);
    assert.equal(seen[0].headers['x-api-key'], 'k1');
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  });
});

test('Google 接口：Key 放在 query，返回的 id 去掉 models/ 前缀', async () => {
  await mock(200, { models: [{ name: 'models/gemini-x' }] }, async (base, seen) => {
    const r = await discoverModels({ provider: 'custom', baseUrl: base + '/v1beta', api: 'google-generative-ai', apiKey: 'k1' });
    const url = new URL(seen[0].url, base);
    assert.equal(url.pathname, '/v1beta/models');
    assert.equal(url.searchParams.get('key'), 'k1');
    assert.deepEqual(r.models.map(m => m.id), ['gemini-x']);
  });
});

test('内置服务商用自己的主协议拉取，并在自家目录里识别', async () => {
  await mock(200, { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-flash' }, { id: 'new-one' }] }, async (base, seen) => {
    const r = await discoverModels({ provider: 'deepseek', baseUrl: base, apiKey: 'k1' });
    assert.equal(seen[0].url, '/models');
    assert.deepEqual(r.models.map(m => [m.id, m.known]), [['deepseek-flash', true], ['new-one', false]]);
  });
});

test('返回 1500 个模型时只保留 1000 个，total 记录去重后的总数', async () => {
  const data = Array.from({ length: 1500 }, (_, i) => ({ id: 'm-' + String(i).padStart(4, '0') }));
  await mock(200, { data }, async base => {
    const r = await discoverModels({ provider: 'custom', baseUrl: base + '/v1', api: 'openai-completions', apiKey: 'k1' });
    assert.equal(r.models.length, 1000);
    assert.equal(r.total, 1500);
    assert.equal(r.models[999].id, 'm-0999');
  });
});

test('非 2xx 响应只报状态码，不回显响应正文和 Key', async () => {
  await mock(401, 'secret-echo k1', async base => {
    await assert.rejects(
      discoverModels({ provider: 'custom', baseUrl: base + '/v1', api: 'openai-completions', apiKey: 'k1' }),
      (e: Error) => /拉取失败：HTTP 401/.test(e.message) && !e.message.includes('k1') && !e.message.includes('secret-echo'),
    );
  });
});
