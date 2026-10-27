// Staging stand-in for the production Nginx: injects the ingress key and drops Origin
// (staging is plain HTTP behind an SSH tunnel, so the app's https Origin check cannot match).
import http from 'node:http';
import { readFileSync } from 'node:fs';

const key = readFileSync('/run/staging/ingress_key', 'utf8').trim();

http.createServer((req, res) => {
  const headers = { ...req.headers, 'x-ingress-key': key };
  delete headers.origin;
  delete headers.authorization;
  const upstream = http.request({ host: 'app', port: 8080, method: req.method, path: req.url, headers }, up => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', e => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'staging proxy: ' + e.message }));
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}).listen(8081, '0.0.0.0');
