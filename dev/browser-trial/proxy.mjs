// 仅供监听宿主回环端口的隔离验收，支持 HTTP 与 noVNC WebSocket。
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const key = readFileSync('/run/trial/ingress_key', 'utf8').trim();
function headers(req) {
  const out = { ...req.headers, 'x-ingress-key': key };
  delete out.origin;
  delete out.authorization;
  return out;
}
const server = http.createServer((req, res) => {
  const upstream = http.request({ host: 'app', port: 8080, method: req.method, path: req.url, headers: headers(req) }, response => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/desktop/websockify') return socket.destroy();
  const upstream = net.connect(8080, 'app', () => {
    const lines = Object.entries(headers(req)).map(([name, value]) => name + ': ' + value);
    upstream.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' + lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.listen(8082, '0.0.0.0');
