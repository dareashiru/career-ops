// Test stand-in for the upstream web app: `node server.mjs start -p PORT`.
//   GET  /whoami          -> the data root and uid it runs as
//   GET  /file?name=x     -> a file from its own data root
//   GET  /read?path=/abs  -> tries to read any absolute path (an app bug an attacker might use)
//   POST /write?name=x    -> writes the request body into its data root
//   GET  /headers         -> the request headers it received
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
const root = process.env.CAREER_OPS_ROOT;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/whoami') return res.end(JSON.stringify({ root, uid: process.getuid() }));
    if (url.pathname === '/headers') return res.end(JSON.stringify(req.headers));
    if (url.pathname === '/file') return res.end(readFileSync(join(root, url.searchParams.get('name'))));
    if (url.pathname === '/read') return res.end(readFileSync(url.searchParams.get('path')));
    if (url.pathname === '/write' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        writeFileSync(join(root, url.searchParams.get('name')), body);
        res.end('written');
      });
      return undefined;
    }
    res.end('career-ops stand-in');
  } catch (err) {
    res.statusCode = 500;
    res.end(err.code || err.message);
  }
  return undefined;
}).listen(port, '127.0.0.1');
