import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { listProviders, listModels, resolveRuntimeModel } from '../src/model-catalog.js';
import { requestMaxTokens, runCompletion, PiGenerator } from '../src/model.js';
import { writeModelKey } from '../src/settings.js';
import type { Config } from '../src/types.js';

const deepseek = (over: Partial<Config['model']> = {}): Config['model'] => ({ provider: 'deepseek', api: '', baseUrl: 'https://api.deepseek.com', id: 'deepseek-flash', reasoning: false, reasoningLevel: 'off', vision: false, maxTokens: 1024, timeoutMs: 10000, source: 'panel', ...over });
const config = (model: Config['model']): Config => ({ expectedHandle: 'tester', mode: 'draft', pollSeconds: 60, maxAgeHours: 6, maxPerRound: 2, publicPerHour: 10, privatePerHour: 30, retentionDays: 30, persona: '测试 AI', dailyState: '无', model });

type Seen = { url?: string; headers: IncomingHttpHeaders; body: any };
async function mockSse(fn: (port: number, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d);
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'MODEL_OK' }, finish_reason: null }] };
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try { await fn((server.address() as any).port, seen); } finally { await new Promise<void>(r => server.close(() => r())); }
}

test('服务商列表排除需要额外参数或只能 OAuth 的服务商，并按国内/海外分组', async () => {
  const providers = await listProviders();
  const ids = providers.map(p => p.id);
  for (const banned of ['amazon-bedrock', 'azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'google-vertex', 'openai-codex', 'github-copilot', 'typesafe']) assert.ok(!ids.includes(banned), banned);
  const ds = providers.find(p => p.id === 'deepseek')!;
  assert.equal(ds.group, 'cn');
  assert.equal(ds.baseUrl, 'https://api.deepseek.com');
  assert.deepEqual(ds.apis, ['openai-completions']);
  assert.equal(providers.find(p => p.id === 'anthropic')!.group, 'intl');
});

test('模型信息来自 pi 目录：上下文、推理档位、看图', async () => {
  const flash = (await listModels('deepseek')).find(m => m.id === 'deepseek-flash')!;
  assert.equal(flash.contextWindow, 1000000);
  assert.equal(flash.reasoning, true);
  assert.equal(flash.vision, true);
  assert.deepEqual(flash.levels, ['off', 'low', 'high', 'max']);
  await assert.rejects(listModels('nope'), /未知服务商/);
});

test('推理额度只加在非 Anthropic 协议上，并受模型上限约束', async () => {
  const { model } = await resolveRuntimeModel(deepseek());
  assert.equal(requestMaxTokens(1024, model, 'off'), 1024);
  assert.equal(requestMaxTokens(1024, model, 'high'), 9216);
  assert.equal(requestMaxTokens(1024, { ...model, maxTokens: 4096 }, 'high'), 4096);
  const claudeId = (await listModels('anthropic')).find(m => m.reasoning)!.id;
  const { model: claude } = await resolveRuntimeModel(deepseek({ provider: 'anthropic', id: claudeId, baseUrl: 'https://api.anthropic.com' }));
  assert.equal(requestMaxTokens(1024, claude, 'high'), 1024);
});

test('运行时模型：改地址、未知 id、自定义服务商借用目录参数', async () => {
  assert.equal((await resolveRuntimeModel(deepseek({ baseUrl: 'http://127.0.0.1:9/x' }))).model.baseUrl, 'http://127.0.0.1:9/x');
  const unknown = (await resolveRuntimeModel(deepseek({ id: 'brand-new' }))).model;
  assert.equal(unknown.id, 'brand-new');
  assert.equal(unknown.api, 'openai-completions');
  assert.equal(unknown.contextWindow, 128000);
  const custom = (await resolveRuntimeModel(deepseek({ provider: 'custom', api: 'anthropic-messages', baseUrl: 'https://relay.example/v1' }))).model;
  assert.equal(custom.api, 'anthropic-messages');
  assert.equal(custom.contextWindow, 1000000);
  assert.equal((custom.compat as any)?.thinkingFormat, undefined);
});

test('runCompletion 经内置服务商把请求发到改过的地址，并带上 Key', async () => {
  await mockSse(async (port, seen) => {
    const r = await runCompletion(deepseek({ baseUrl: 'http://127.0.0.1:' + port }), 'k-unit-0001', '系统', '你好');
    assert.equal(seen[0].headers.authorization, 'Bearer k-unit-0001');
    assert.equal(seen[0].body.model, 'deepseek-flash');
    assert.equal(seen[0].body.max_tokens, 1024);
    assert.equal(r.stopReason, 'stop');
    assert.equal(r.input, 12);
    assert.equal(r.text, 'MODEL_OK');
  });
});

test('PiGenerator：面板配置只用面板 Key，不回退到旧 Key 文件', async () => {
  const root = mkdtempSync(tmpdir() + '/role-gen-');
  mkdirSync(root + '/data'); mkdirSync(root + '/secrets');
  writeFileSync(root + '/secrets/model_api_key', 'legacy-key-0000');
  const prev = { d: process.env.DATA_DIR, s: process.env.SECRETS_DIR };
  process.env.DATA_DIR = root + '/data'; process.env.SECRETS_DIR = root + '/secrets';
  try {
    await mockSse(async (port, seen) => {
      const c = config(deepseek({ baseUrl: 'http://127.0.0.1:' + port }));
      await assert.rejects(new PiGenerator().complete(c, '系统', '你好'), /模型未配置/);
      assert.equal(seen.length, 0);
      writeModelKey('deepseek@127.0.0.1', 'panel-key-0001');
      const r = await new PiGenerator().complete(c, '系统', '你好');
      assert.equal(seen[0].headers.authorization, 'Bearer panel-key-0001');
      assert.equal(r.text, 'MODEL_OK');
    });
  } finally {
    if (prev.d === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev.d;
    if (prev.s === undefined) delete process.env.SECRETS_DIR; else process.env.SECRETS_DIR = prev.s;
    rmSync(root, { recursive: true, force: true });
  }
});

test('旧 config.json 模型不在 pi 目录里时，保留配置里的推理开关', async () => {
  const legacy = deepseek({ provider: 'custom', api: 'openai-completions', baseUrl: 'https://relay.example/v1', id: 'legacy-unknown-model', reasoning: true, reasoningLevel: 'low', source: undefined });
  assert.equal((await resolveRuntimeModel(legacy)).model.reasoning, true);
  assert.equal((await resolveRuntimeModel({ ...legacy, reasoning: false })).model.reasoning, false);
});
