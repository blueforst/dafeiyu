// Fake OpenAI-compatible model endpoint for staging.
//   /v1/models            -> deepseek-flash (in pi catalog) + my-finetune-v2 (unknown)
//   /big/v1/models        -> 1500 models m-0000 .. m-1499
//   /v1/chat/completions  -> SSE "MODEL_OK"
import http from 'node:http';

const KEY = 'staging-key-0001';
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const big = url.pathname.startsWith('/big/');
  const path = big ? url.pathname.slice(4) : url.pathname;
  if (req.headers.authorization !== 'Bearer ' + KEY) return json(res, 401, { error: { message: 'invalid api key' } });
  if (req.method === 'GET' && path === '/v1/models') {
    const data = big
      ? Array.from({ length: 1500 }, (_, i) => ({ id: 'm-' + String(i).padStart(4, '0'), object: 'model' }))
      : [{ id: 'deepseek-flash', object: 'model' }, { id: 'my-finetune-v2', object: 'model' }];
    return json(res, 200, { object: 'list', data });
  }
  if (req.method === 'POST' && path === '/v1/chat/completions') {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'MODEL_OK' }, finish_reason: null }] };
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 18, completion_tokens: 4, total_tokens: 22 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  json(res, 404, { error: { message: 'not found' } });
}).listen(8080, '0.0.0.0');
