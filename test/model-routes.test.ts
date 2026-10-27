import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { registerModelRoutes } from '../src/model-routes.js';
import { panelDir, readPanelSettings } from '../src/settings.js';
import type { CompletionResult } from '../src/model.js';
import { writeExampleConfig } from './config-fixture.js';

const KEY = 'sk-test-123456789';
const custom = (over: Record<string, unknown> = {}) => ({ provider: 'custom', baseUrl: 'http://mock.local/v1', api: 'openai-completions', id: 'my-model', reasoningLevel: 'off', maxTokens: 1024, timeoutMs: 60000, ...over });
const okResult = (over: Partial<CompletionResult> = {}): CompletionResult => ({ text: 'MODEL_OK', input: 5, output: 2, cache: 0, stopReason: 'stop', latencyMs: 30, ...over });

function setup(opts: { control?: string; run?: any; discover?: any } = {}) {
  const root = mkdtempSync(tmpdir() + '/role-routes-');
  mkdirSync(root + '/data'); mkdirSync(root + '/secrets');
  writeExampleConfig(root + '/config.json');
  const prev = { d: process.env.DATA_DIR, s: process.env.SECRETS_DIR, c: process.env.CONFIG_PATH };
  process.env.DATA_DIR = root + '/data'; process.env.SECRETS_DIR = root + '/secrets'; process.env.CONFIG_PATH = root + '/config.json';
  const store = new Store(root + '/data/db.sqlite');
  const app = Fastify();
  let control = opts.control ?? 'paused';
  registerModelRoutes(app, { store, control: () => control, run: opts.run ?? (async () => okResult()), discover: opts.discover ?? (async () => ({ models: [], total: 0 })) });
  return {
    app, store,
    setControl: (c: string) => { control = c; },
    req: (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as any }),
    async close() {
      await app.close(); store.db.close();
      for (const [k, v] of [['DATA_DIR', prev.d], ['SECRETS_DIR', prev.s], ['CONFIG_PATH', prev.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('首次读取模型设置：来源是 config.json，面板设置为空', async () => {
  const t = setup();
  try {
    const r = await t.req('GET', '/api/model');
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().source, 'config');
    assert.equal(r.json().settings, null);
  } finally { await t.close(); }
});

test('保存自定义模型和 Key：之后只返回末四位，任何响应都不含 Key', async () => {
  const t = setup();
  try {
    const put = await t.req('PUT', '/api/model', { settings: custom(), apiKey: KEY });
    assert.equal(put.statusCode, 200, put.body);
    const get = await t.req('GET', '/api/model');
    assert.equal(get.json().source, 'panel');
    assert.equal(get.json().keys['custom@mock.local'], '••••6789');
    assert.ok(!put.body.includes(KEY));
    assert.ok(!get.body.includes(KEY));
  } finally { await t.close(); }
});

test('保存时拒绝本机/元数据地址、超范围的长度上限和模型不支持的推理档位', async () => {
  const t = setup();
  try {
    for (const baseUrl of ['http://localhost:1/v1', 'http://169.254.169.254/']) {
      assert.equal((await t.req('PUT', '/api/model', { settings: custom({ baseUrl }), apiKey: KEY })).statusCode, 400, baseUrl);
    }
    assert.equal((await t.req('PUT', '/api/model', { settings: custom({ maxTokens: 9000 }), apiKey: KEY })).statusCode, 400);
    const ds = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', id: 'deepseek-flash', reasoningLevel: 'medium', maxTokens: 1024, timeoutMs: 60000 };
    assert.equal((await t.req('PUT', '/api/model', { settings: ds, apiKey: KEY })).statusCode, 400);
    assert.equal((await t.req('PUT', '/api/model', { settings: { ...ds, reasoningLevel: 'high' }, apiKey: KEY })).statusCode, 200);
  } finally { await t.close(); }
});

test('设置文件损坏时，保存一次就能修好', async () => {
  const t = setup();
  try {
    mkdirSync(panelDir(), { recursive: true });
    writeFileSync(panelDir() + '/settings.json', '{"model":');
    assert.equal((await t.req('PUT', '/api/model', { settings: custom(), apiKey: KEY })).statusCode, 200);
    assert.equal(readPanelSettings().model?.id, 'my-model');
  } finally { await t.close(); }
});

test('预期账号：规范化保存、空值清除、运行中拒绝修改', async () => {
  const t = setup();
  try {
    const r = await t.req('PUT', '/api/account', { expectedHandle: '@Role_Demo' });
    assert.equal(r.json().expectedHandle, 'role_demo');
    assert.equal(readPanelSettings().expectedHandle, 'role_demo');
    await t.req('PUT', '/api/account', { expectedHandle: '' });
    assert.equal(readPanelSettings().expectedHandle, undefined);
    assert.equal((await t.req('PUT', '/api/account', { expectedHandle: 'bad name!' })).statusCode, 400);
    t.setControl('running');
    const blocked = await t.req('PUT', '/api/account', { expectedHandle: 'role_demo' });
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().error, /先暂停/);
  } finally { await t.close(); }
});

test('测试连接：length 算通过，异常算失败且不回显 Key，结果被记录', async () => {
  let next: () => Promise<CompletionResult> = async () => okResult({ stopReason: 'length' });
  const t = setup({ run: () => next() });
  try {
    const pass = await t.req('POST', '/api/model/test', { settings: custom(), apiKey: KEY });
    assert.equal(pass.json().ok, true);
    next = async () => { throw new Error('bad ' + KEY); };
    const fail = await t.req('POST', '/api/model/test', { settings: custom(), apiKey: KEY });
    assert.equal(fail.json().ok, false);
    assert.ok(!fail.body.includes(KEY));
    const last = JSON.parse(t.store.get('model:lastTest'));
    assert.equal(last.ok, false);
    assert.equal(last.id, 'my-model');
  } finally { await t.close(); }
});

test('测试连接用最小请求：能关推理就关、上限 16', async () => {
  const calls: any[] = [];
  const t = setup({ run: async (_m: any, _k: string, _s: string, _u: string, o: any) => { calls.push(o); return okResult(); } });
  try {
    await t.req('POST', '/api/model/test', { settings: custom(), apiKey: KEY });
    assert.equal(calls[0].maxTokens, 16);
    assert.equal(calls[0].reasoning, 'off');
  } finally { await t.close(); }
});

test('测试和拉取同一时间只允许一个，第二个返回 409', async () => {
  const t = setup({ run: async () => { await new Promise(r => setTimeout(r, 50)); return okResult(); } });
  try {
    const [a, b] = await Promise.all([
      t.req('POST', '/api/model/test', { settings: custom(), apiKey: KEY }),
      t.req('POST', '/api/model/discover', { provider: 'custom', baseUrl: 'http://mock.local/v1', api: 'openai-completions', apiKey: KEY }),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  } finally { await t.close(); }
});

test('拉取列表时，没填 Key 且该地址没有保存过 Key，返回 400', async () => {
  const t = setup();
  try {
    await t.req('PUT', '/api/model', { settings: custom(), apiKey: KEY });
    const r = await t.req('POST', '/api/model/discover', { provider: 'custom', baseUrl: 'http://other.example/v1', api: 'openai-completions' });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /请先填写 API Key/);
  } finally { await t.close(); }
});

test('拉取列表时沿用该地址已保存的 Key', async () => {
  let usedKey = '';
  const t = setup({ discover: async (input: any) => { usedKey = input.apiKey; return { models: [{ id: 'x', known: false }], total: 1 }; } });
  try {
    await t.req('PUT', '/api/model', { settings: custom(), apiKey: KEY });
    const r = await t.req('POST', '/api/model/discover', { provider: 'custom', baseUrl: 'http://mock.local/v1', api: 'openai-completions' });
    assert.equal(r.statusCode, 200);
    assert.equal(usedKey, KEY);
    assert.ok(!r.body.includes(KEY));
  } finally { await t.close(); }
});

test('保存后写入 model-save 日志，所有日志都不含 Key', async () => {
  const t = setup();
  try {
    await t.req('PUT', '/api/model', { settings: custom(), apiKey: KEY });
    await t.req('POST', '/api/model/test', { settings: custom(), apiKey: KEY });
    const logs = t.store.logs() as any[];
    assert.ok(logs.some(l => l.event === 'model-save'));
    assert.ok(logs.every(l => !String(l.detail).includes(KEY)));
  } finally { await t.close(); }
});

test('服务商与模型目录接口', async () => {
  const t = setup();
  try {
    const providers = (await t.req('GET', '/api/model/providers')).json();
    assert.ok(providers.some((p: any) => p.id === 'deepseek'));
    const models = (await t.req('GET', '/api/model/providers/deepseek/models')).json();
    assert.ok(models.some((m: any) => m.id === 'deepseek-flash'));
    assert.equal((await t.req('GET', '/api/model/providers/nope/models')).statusCode, 404);
  } finally { await t.close(); }
});

test('没有 Key 的地址不允许保存模型', async () => {
  const t = setup();
  try {
    const r = await t.req('PUT', '/api/model', { settings: custom({ baseUrl: 'http://fresh.example/v1' }) });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /请先填写 API Key/);
    await t.req('PUT', '/api/model', { settings: custom(), apiKey: KEY });
    assert.equal((await t.req('PUT', '/api/model', { settings: custom({ maxTokens: 2048 }) })).statusCode, 200);
  } finally { await t.close(); }
});
