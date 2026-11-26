// Tests against a real Postgres: locks, queue, sign-in, AI metering and caps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { acquireLock, currentLock, releaseLock, renewLock } from '../src/lock.mjs';
import { claimJob, enqueueJob, finishJob, reapStuckJobs } from '../src/jobs.mjs';
import { createInvite, redeemInvite } from '../src/auth.mjs';
import { encryptSecret } from '../src/crypto.mjs';
import { startMeterProxy } from '../src/meter-proxy.mjs';
import { monthUsage, resolveAiAccess } from '../src/usage.mjs';
import { enqueueDueScans } from '../src/worker.mjs';
import { databaseAvailable, makeUser, setup } from './helpers.mjs';
import { MOCK_USAGE, startMockAi } from './mock-ai.mjs';

const hasDb = await databaseAvailable();
let env;
before(async () => { if (hasDb) env = await setup({ AI_PRICE_INPUT_PER_MTOK: '4', AI_PRICE_OUTPUT_PER_MTOK: '20' }); });
after(async () => { await env?.pool.end(); });

test('one holder per workspace; a lapsed lease can be taken over', { skip: !hasDb }, async () => {
  const { pool } = env;
  const u = await makeUser(pool, 'lock@example.com');
  assert.equal(await acquireLock(pool, u.id, 'A', { kind: 'job', leaseSeconds: 30 }), true);
  assert.equal(await acquireLock(pool, u.id, 'B', { kind: 'job', leaseSeconds: 30 }), false, 'B must wait');
  assert.equal(await acquireLock(pool, u.id, 'A', { kind: 'job', leaseSeconds: 30 }), true, 're-entrant for A');
  // A crashes: its lease runs out.
  await pool.query("UPDATE workspace_locks SET expires_at = now() - interval '1 second' WHERE user_id = $1", [u.id]);
  assert.equal(await currentLock(pool, u.id), null);
  assert.equal(await acquireLock(pool, u.id, 'B', { kind: 'web', holderUrl: 'http://b', leaseSeconds: 30 }), true);
  assert.equal(await renewLock(pool, u.id, 'A', 30), false, 'A learns it lost the lock and must not upload');
  assert.equal((await currentLock(pool, u.id)).holder_url, 'http://b');
  await releaseLock(pool, u.id, 'A'); // a stale holder cannot release someone else's lock
  assert.equal((await currentLock(pool, u.id)).holder, 'B');
  await releaseLock(pool, u.id, 'B');
  assert.equal(await currentLock(pool, u.id), null);
});

test('workers skip users whose workspace is busy, the web host takes only its users', { skip: !hasDb }, async () => {
  const { pool } = env;
  const a = await makeUser(pool, 'qa@example.com');
  const b = await makeUser(pool, 'qb@example.com');
  const ja1 = await enqueueJob(pool, { userId: a.id, type: 'scan' });
  await enqueueJob(pool, { userId: a.id, type: 'score', payload: { text: 'x' } });
  const jb = await enqueueJob(pool, { userId: b.id, type: 'scan' });

  await acquireLock(pool, b.id, 'webhost-1', { kind: 'web', holderUrl: 'http://w1', leaseSeconds: 30 });
  const first = await claimJob(pool, 'worker-1');
  assert.equal(first.id, ja1.id);
  assert.equal(await claimJob(pool, 'worker-2'), null, "a's second job waits for the first; b is held by the web host");

  const hosted = await claimJob(pool, 'webhost-1', { userIds: [b.id] });
  assert.equal(hosted.id, jb.id);
  await finishJob(pool, first.id, { status: 'done' });
  const second = await claimJob(pool, 'worker-1');
  assert.equal(second.user_id, a.id);

  // A crashed worker's job is put back.
  await pool.query("UPDATE jobs SET started_at = now() - interval '2 hours' WHERE id = $1", [second.id]);
  assert.equal(await reapStuckJobs(pool, 30), 1);
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id = $1', [second.id])).rows[0].status, 'queued');
  await releaseLock(pool, b.id, 'webhost-1');
  await pool.query("UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'running')");
});

test('scheduled scans are queued once per due user', { skip: !hasDb }, async () => {
  const { pool } = env;
  await pool.query("UPDATE users SET last_scan_at = now()");
  const due = await makeUser(pool, 'due@example.com');
  const off = await makeUser(pool, 'off@example.com');
  await pool.query('UPDATE users SET auto_scan = false WHERE id = $1', [off.id]);
  assert.equal(await enqueueDueScans(pool, 8), 1);
  assert.equal(await enqueueDueScans(pool, 8), 0, 'no duplicate while one is queued');
  const rows = (await pool.query("SELECT user_id FROM jobs WHERE status = 'queued' AND type = 'scan'")).rows;
  assert.deepEqual(rows.map((r) => r.user_id), [due.id]);
  await pool.query("UPDATE jobs SET status = 'done' WHERE status = 'queued'");
});

test('invites are single-use and only invited people get accounts', { skip: !hasDb }, async () => {
  const { pool, config } = env;
  assert.equal(await redeemInvite(pool, config, 'not-a-real-token-at-all'), null);
  const inv = await createInvite(pool, config, { email: 'Friend@Example.com' });
  assert.match(inv.url, /^http:\/\/jobflow\.test\/jobflow\/invite\//);
  const user = await redeemInvite(pool, config, inv.token);
  assert.equal(user.email, 'friend@example.com');
  assert.equal(await redeemInvite(pool, config, inv.token), null, 'second use refused');
  const stored = (await pool.query('SELECT token_hash FROM invites')).rows.map((r) => r.token_hash);
  assert.ok(!stored.includes(inv.token), 'only the hash is stored');
});

test('metering proxy: own token only, real key upstream, usage recorded, cap enforced', { skip: !hasDb }, async () => {
  const { pool, config } = env;
  const mock = await startMockAi();
  const user = await makeUser(pool, 'meter@example.com', { capCents: 10 }); // $0.10
  const cfg = { ...config, ai: { ...config.ai, baseUrl: mock.url, apiKey: 'jobflow-real-key', model: 'm' } };
  const access = await resolveAiAccess(pool, cfg, user);
  assert.equal(access.keySource, 'jobflow');
  const proxy = await startMeterProxy({ pool, config: cfg, user, access });
  const call = (token) => fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal((await call('wrong')).status, 401);
  const ok = await call(proxy.token);
  assert.equal(ok.status, 200);
  await ok.json();
  assert.equal(mock.calls.at(-1).auth, 'Bearer jobflow-real-key');
  // 12000 in * $4/M + 1500 out * $20/M = $0.078
  const usage = await monthUsage(pool, user.id);
  assert.equal(usage.jobflow.costMicro, 78_000);
  assert.equal(usage.jobflow.inputTokens, MOCK_USAGE.prompt_tokens);
  await (await call(proxy.token)).json(); // $0.156 now: over the $0.10 cap
  assert.equal((await call(proxy.token)).status, 429);
  assert.match((await resolveAiAccess(pool, cfg, user)).error, /monthly AI limit|this month's AI limit/);
  await proxy.close();

  // With their own key the user is never capped, and JobFlow's key is not used.
  await pool.query(
    'INSERT INTO user_ai_keys(user_id, base_url, model, key_ciphertext) VALUES ($1, $2, $3, $4)',
    [user.id, mock.url, 'their-model', encryptSecret('user-own-key', config.encryptionKey)],
  );
  const own = await resolveAiAccess(pool, cfg, user);
  assert.equal(own.keySource, 'user');
  const p2 = await startMeterProxy({ pool, config: cfg, user, access: own });
  const r = await fetch(`${p2.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p2.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'their-model', stream: true, messages: [] }),
  });
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(mock.calls.at(-1).auth, 'Bearer user-own-key');
  const after = await monthUsage(pool, user.id);
  assert.equal(after.user.inputTokens, MOCK_USAGE.prompt_tokens, 'streamed usage counted');
  assert.equal(after.user.costMicro, 0);
  await p2.close();
  await mock.close();
});
