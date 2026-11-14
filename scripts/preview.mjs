import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('extension');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json'};
const server = http.createServer((req, res) => {
  const requested = new URL(req.url, 'http://127.0.0.1').pathname;
  const file = path.resolve(root, '.' + (requested === '/' ? '/options.html' : decodeURIComponent(requested)));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control':'no-store'}); fs.createReadStream(file).pipe(res);
});
server.listen(8786, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:8786/options.html'));
