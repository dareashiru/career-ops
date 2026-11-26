// A small streaming HTTP reverse proxy (requests and WebSocket upgrades).
import http from 'node:http';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/**
 * Forward `req` to `target` (http://host:port) and stream the answer to `res`.
 * `setHeaders` overrides request headers (pass undefined to drop one).
 * Resolves with the upstream status, or rejects if the target is unreachable
 * before any response was sent.
 */
export function proxyRequest(req, res, target, { setHeaders = {}, path = req.url } = {}) {
  return new Promise((resolveProxy, rejectProxy) => {
    const url = new URL(target);
    const headers = { ...cleanHeaders(req.headers), ...setHeaders };
    for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
    const upstream = http.request({
      hostname: url.hostname,
      port: url.port,
      method: req.method,
      path,
      headers,
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, cleanHeaders(up.headers));
      up.pipe(res);
      up.on('end', () => resolveProxy(up.statusCode));
      up.on('error', () => res.destroy());
    });
    upstream.on('error', (err) => {
      if (res.headersSent) res.destroy();
      rejectProxy(err);
    });
    req.pipe(upstream);
  });
}

/** Forward a WebSocket upgrade. */
export function proxyUpgrade(req, socket, head, target, { setHeaders = {}, path = req.url } = {}) {
  const url = new URL(target);
  const headers = { ...req.headers, ...setHeaders };
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  const upstream = http.request({ hostname: url.hostname, port: url.port, method: req.method, path, headers });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  upstream.on('response', (r) => {
    socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
}
