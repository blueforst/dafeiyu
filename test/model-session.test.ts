import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { listModels } from '../src/model-catalog.js';
import { runCompletion } from '../src/model.js';
import type { Config } from '../src/types.js';

// 捕获真正发出的 HTTP 请求；立即返回错误，避免依赖各协议的响应格式。
test('OpenCode 各协议均发送稳定会话头和应用身份，独立测试使用不同会话', async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '会话头验收，请求已捕获' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = 'http://127.0.0.1:' + (server.address() as any).port;
    for (const provider of ['opencode', 'opencode-go']) {
      const catalog = await listModels(provider);
      for (const api of new Set(catalog.map(m => m.api))) {
        const item = catalog.find(m => m.api === api)!;
        const model: Config['model'] = { provider, api, baseUrl, id: item.id, source: 'panel', reasoning: false, reasoningLevel: 'off', vision: false, maxTokens: 64, timeoutMs: 10000 };
        const sessionId = 'role-test-' + provider + '-' + api;
        for (let turn = 0; turn < 2; turn++) {
          const before = seen.length;
          await runCompletion(model, 'session-test-key', '系统', '测试', { sessionId });
          assert.equal(seen.length, before + 1, provider + '/' + api);
          assert.equal(seen.at(-1)!['x-opencode-session'], sessionId, provider + '/' + api);
          assert.match(String(seen.at(-1)!['user-agent']), /^role-workflow\//);
        }
      }
    }
    const item = (await listModels('opencode-go')).find(m => m.api === 'openai-completions')!;
    // 旧配置通过自定义协议调用时同样需要支持会话。
    const legacy: Config['model'] = { provider: 'opencode-go', api: item.api, baseUrl, id: item.id, reasoning: false, reasoningLevel: 'off', vision: false, maxTokens: 64, timeoutMs: 10000 };
    await runCompletion(legacy, 'session-test-key', '系统', '测试');
    await runCompletion(legacy, 'session-test-key', '系统', '测试');
    assert.ok(seen.at(-1)!['x-opencode-session']);
    assert.ok(seen.at(-2)!['x-opencode-session']);
    assert.notEqual(seen.at(-1)!['x-opencode-session'], seen.at(-2)!['x-opencode-session']);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
