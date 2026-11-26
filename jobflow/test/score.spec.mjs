// A score job end to end against the real, unmodified career-ops scripts:
// posting guard -> openai-eval.mjs (through the metering proxy, to a mock AI)
// -> merge-tracker.mjs, then upload. Needs career-ops' own npm dependencies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { claimJob, enqueueJob } from '../src/jobs.mjs';
import { executeJob } from '../src/worker.mjs';
import { databaseAvailable, makeUser, setup } from './helpers.mjs';
import { startMockAi } from './mock-ai.mjs';

const hasDb = await databaseAvailable();
let env; let mock;
const ready = () => hasDb && existsSync(join(env.config.careerOpsDir, 'node_modules', 'js-yaml'));

before(async () => {
  if (!hasDb) return;
  mock = await startMockAi();
  env = await setup({
    JOBFLOW_TEST_TMP: '/tmp',
    AI_BASE_URL: mock.url,
    AI_API_KEY: 'jobflow-real-key',
    AI_MODEL: 'mock-model',
    AI_PRICE_INPUT_PER_MTOK: '4',
    AI_PRICE_OUTPUT_PER_MTOK: '20',
  });
});
after(async () => {
  await mock?.close();
  await env?.pool.end();
});

test('a pasted job is scored, reported and added to the tracker', async (t) => {
  if (!hasDb || !ready()) return t.skip('needs Postgres and `npm install` in the career-ops folder');
  const { ctx, pool, storage } = env;
  const user = await makeUser(pool, 'score@example.com');
  await storage.put(`workspaces/${user.id}/cv.md`, '# Test Person\n\n## Experience\n- Built things.\n');
  await enqueueJob(pool, { userId: user.id, type: 'score', payload: { text: 'Staff Engineer at Example Co. Remote.' } });
  const job = await claimJob(pool, 'test-worker');
  await executeJob(ctx, job);

  const row = (await pool.query('SELECT status, result, log FROM jobs WHERE id = $1', [job.id])).rows[0];
  assert.equal(row.status, 'done', row.log);
  assert.equal(row.result.score, 4.2);
  assert.match(row.result.report, /^reports\/001-example-co-.*\.md$/);
  assert.equal(row.result.usage.costMicro, 78_000);

  // The model was called with JobFlow's key; the child only ever had the proxy token.
  assert.equal(mock.calls.at(-1).auth, 'Bearer jobflow-real-key');

  const tracker = (await storage.get(`workspaces/${user.id}/data/applications.md`)).toString();
  assert.match(tracker, /Example Co \| Staff Engineer \| 4\.2\/5 \| Evaluated/);
  const report = (await storage.get(`workspaces/${user.id}/${row.result.report}`)).toString();
  assert.match(report, /Job Description \(archived verbatim\)/);
  assert.equal((await pool.query('SELECT 1 FROM workspace_locks WHERE user_id = $1', [user.id])).rowCount, 0, 'lock released');
});

test('a job-board link is not scored until the employer has the role', async (t) => {
  if (!hasDb || !ready()) return t.skip('needs Postgres and `npm install` in the career-ops folder');
  const { ctx, pool } = env;
  const user = await makeUser(pool, 'board@example.com');
  const calls = mock.calls.length;
  // Even with the description pasted, a LinkedIn link with no employer to look for stops here.
  await enqueueJob(pool, {
    userId: user.id, type: 'score',
    payload: { url: 'https://www.linkedin.com/jobs/view/1234567890/', text: 'Staff Engineer. Remote.' },
  });
  const job = await claimJob(pool, 'test-worker');
  await executeJob(ctx, job);
  const row = (await pool.query('SELECT status, result, log FROM jobs WHERE id = $1', [job.id])).rows[0];
  assert.equal(row.status, 'failed', row.log);
  assert.match(row.result.message, /job board/);
  assert.match(row.log, /confirm-at-employer\.mjs \(exit 0\)/);
  assert.equal(mock.calls.length, calls, 'no AI call was made');
});
