// Gate 1 of the rollout plan: no data crosses between users.
//
// Runs the real app and web host with a stand-in career-ops web app, then
// tries the ways one user might reach another's files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { createSession } from '../src/auth.mjs';
import { WebHost } from '../src/webhost.mjs';
import { databaseAvailable, makeUser, setup } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hasDb = await databaseAvailable();
const isRoot = process.getuid?.() === 0;
let env; let host; let app; let base; let a; let b; let cookieA; let cookieB;

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

function req(path, { cookie, method = 'GET', headers = {}, body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    body,
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: 'http://jobflow.test' } : {}), ...headers },
  });
}

before(async () => {
  if (!hasDb) return;
  env = await setup({ CAREER_OPS_DIR: join(here, 'fixtures', 'career-ops'), WEB_PORT_BASE: '4700', JOBFLOW_TEST_TMP: '/tmp' });
  const { ctx, pool, storage } = env;
  a = await makeUser(pool, 'a@example.com');
  b = await makeUser(pool, 'b@example.com');
  await storage.put(`workspaces/${a.id}/cv.md`, 'A private CV');
  await storage.put(`workspaces/${b.id}/cv.md`, 'B private CV');
  cookieA = `jf_session=${await createSession(pool, env.config, a.id)}`;
  cookieB = `jf_session=${await createSession(pool, env.config, b.id)}`;

  const port = await freePort();
  ctx.config.webhostAdvertiseUrl = `http://127.0.0.1:${port}`;
  host = new WebHost(ctx, { listenPort: port });
  await host.listen();
  app = createApp({ ...ctx, webhostUrl: host.advertiseUrl });
  base = `http://127.0.0.1:${await listen(app)}`;
});

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

after(async () => {
  await host?.shutdown();
  await new Promise((r) => (app ? app.close(r) : r()));
  await env?.pool.end();
});

test('signed-out requests never reach a workspace', { skip: !hasDb }, async () => {
  assert.equal((await req('/file?name=cv.md')).status, 401);
  const page = await req('/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/jobflow/login');
  assert.equal((await req('/jobflow/scan', { method: 'POST', headers: { origin: 'https://evil.example' }, cookie: cookieA })).status, 403);
});

test('each user reaches only their own files, whatever headers they send', { skip: !hasDb }, async () => {
  assert.equal((await req('/jobflow/open', { method: 'POST', cookie: cookieA })).status, 200);
  assert.equal((await req('/jobflow/open', { method: 'POST', cookie: cookieB })).status, 200);

  assert.equal(await (await req('/file?name=cv.md', { cookie: cookieA })).text(), 'A private CV');
  assert.equal(await (await req('/file?name=cv.md', { cookie: cookieB })).text(), 'B private CV');

  // A forges the web host's routing headers: ignored, still A's app.
  const forged = await req('/file?name=cv.md', {
    cookie: cookieA,
    headers: { 'x-jobflow-user': b.id, 'x-jobflow-internal': 'guess' },
  });
  assert.equal(await forged.text(), 'A private CV');

  // The upstream app never sees JobFlow's session cookie or routing headers.
  const seen = await (await req('/headers', { cookie: `${cookieA}; theme=dark` })).json();
  assert.equal(seen.cookie, 'theme=dark');
  assert.equal(seen['x-jobflow-user'], undefined);
  assert.equal(seen['x-jobflow-internal'], undefined);
});

test("a bug in one user's app cannot read another user's folder", { skip: !hasDb || !isRoot }, async () => {
  const whoA = await (await req('/whoami', { cookie: cookieA })).json();
  const whoB = await (await req('/whoami', { cookie: cookieB })).json();
  assert.notEqual(whoA.uid, 0, 'apps do not run as root');
  assert.notEqual(whoA.uid, whoB.uid, 'each workspace has its own uid');
  const steal = await req(`/read?path=${encodeURIComponent(join(whoB.root, 'cv.md'))}`, { cookie: cookieA });
  assert.equal(steal.status, 500);
  assert.equal(await steal.text(), 'EACCES');
});

test('the web host refuses callers without the internal token', { skip: !hasDb }, async () => {
  const direct = await fetch(`${host.advertiseUrl}/file?name=cv.md`, { headers: { 'x-jobflow-user': a.id } });
  assert.equal(direct.status, 403);
});

test("a user's edits are saved to their own folder in the bucket only", { skip: !hasDb }, async () => {
  assert.equal(await (await req('/write?name=notes.md', { method: 'POST', cookie: cookieA, body: 'A notes' })).text(), 'written');
  await host.syncAll();
  assert.equal((await env.storage.get(`workspaces/${a.id}/notes.md`)).toString(), 'A notes');
  await assert.rejects(env.storage.get(`workspaces/${b.id}/notes.md`));
  // Closing the app uploads, releases the lock, and removes the local copy.
  await host.stop(a.id, 'test');
  const lock = await env.pool.query('SELECT 1 FROM workspace_locks WHERE user_id = $1', [a.id]);
  assert.equal(lock.rowCount, 0);
});

test('admin pages are for admins only', { skip: !hasDb }, async () => {
  assert.equal((await req('/jobflow/admin', { cookie: cookieB })).status, 403);
  assert.equal((await req('/jobflow/jobs/1', { cookie: cookieB })).status, 404);
});
