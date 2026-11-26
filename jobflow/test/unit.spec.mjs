// Tests that need neither a database nor career-ops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecret, encryptSecret } from '../src/crypto.mjs';
import { createStorage } from '../src/storage.mjs';
import { MAX_FILE_BYTES, download, upload } from '../src/sync.mjs';
import { usageFromSse, usageOf } from '../src/meter-proxy.mjs';
import { interpretConfirmation, parseEvalOutput } from '../src/handlers.mjs';
import { withoutJobflowCookies, tokenMatches } from '../src/webhost.mjs';
import { checkArchive, sameOrigin } from '../src/app.mjs';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import { costMicroUsd } from '../src/usage.mjs';

const KEY = Buffer.alloc(32, 9).toString('base64');
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

test('secrets round-trip and fail closed on tampering or a wrong key', () => {
  const sealed = encryptSecret('sk-live-123', KEY);
  assert.notEqual(sealed.includes('sk-live'), true);
  assert.equal(decryptSecret(sealed, KEY), 'sk-live-123');
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), KEY));
  assert.throws(() => decryptSecret(sealed, Buffer.alloc(32, 1).toString('base64')));
  assert.throws(() => encryptSecret('x', 'short'));
});

test('sync uploads only changes, mirrors deletes, and keeps users apart', async () => {
  const base = await mkdtemp(join(tmpdir(), 'jf-sync-'));
  const storage = createStorage({ driver: 'fs', fsRoot: join(base, 'bucket') });
  const dirA = join(base, 'a');
  await mkdir(join(dirA, 'data'), { recursive: true });
  await writeFile(join(dirA, 'cv.md'), '# A');
  await writeFile(join(dirA, 'data', 'applications.md'), 'rows');
  await mkdir(join(dirA, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(dirA, 'node_modules', 'x', 'index.js'), 'skip me');
  await mkdir(join(dirA, '.jobflow-tmp'), { recursive: true });
  await writeFile(join(dirA, '.jobflow-tmp', 'scratch'), 'skip me');
  await symlink('/etc/passwd', join(dirA, 'link'));

  let { manifest, summary } = await upload(storage, 'workspaces/', USER_A, dirA, {});
  assert.deepEqual(Object.keys(manifest).sort(), ['cv.md', 'data/applications.md']);
  assert.equal(summary.put, 2);

  await writeFile(join(dirA, 'cv.md'), '# A v2');
  await rm(join(dirA, 'data', 'applications.md'));
  ({ manifest, summary } = await upload(storage, 'workspaces/', USER_A, dirA, manifest));
  assert.deepEqual(summary, { put: 1, deleted: 1, oversized: [] });

  const dirB = join(base, 'b');
  const mB = await download(storage, 'workspaces/', USER_B, dirB);
  assert.deepEqual(mB, {}, 'user B sees nothing of user A');

  const again = join(base, 'a2');
  await download(storage, 'workspaces/', USER_A, again);
  assert.equal(await readFile(join(again, 'cv.md'), 'utf8'), '# A v2');
  assert.equal(existsSync(join(again, 'data', 'applications.md')), false);
});

test('a file that grows past the size limit keeps its bucket copy', async () => {
  const base = await mkdtemp(join(tmpdir(), 'jf-big-'));
  const storage = createStorage({ driver: 'fs', fsRoot: join(base, 'bucket') });
  const dir = join(base, 'w');
  await mkdir(join(dir, 'output'), { recursive: true });
  await writeFile(join(dir, 'output', 'cv.pdf'), 'small pdf');
  let { manifest } = await upload(storage, 'workspaces/', USER_A, dir, {});
  await truncate(join(dir, 'output', 'cv.pdf'), MAX_FILE_BYTES + 1);
  await writeFile(join(dir, 'output', 'huge.bin'), '');
  await truncate(join(dir, 'output', 'huge.bin'), MAX_FILE_BYTES + 1);
  let summary;
  ({ manifest, summary } = await upload(storage, 'workspaces/', USER_A, dir, manifest));
  assert.equal(summary.deleted, 0, 'an oversized file is not a deletion');
  assert.deepEqual(summary.oversized.sort(), ['output/cv.pdf', 'output/huge.bin']);
  assert.ok('output/cv.pdf' in manifest);
  const again = join(base, 'w2');
  await download(storage, 'workspaces/', USER_A, again);
  assert.equal(await readFile(join(again, 'output', 'cv.pdf'), 'utf8'), 'small pdf');
  await rm(base, { recursive: true, force: true });
});

test('imports are refused when they unpack too large or hold too many files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'jf-arc-'));
  const src = join(base, 'career-ops');
  await mkdir(join(src, 'data'), { recursive: true });
  await writeFile(join(src, 'cv.md'), '# CV');
  await writeFile(join(src, 'data', 'applications.md'), 'rows');
  await writeFile(join(src, 'zeros.bin'), Buffer.alloc(2 * 1024 * 1024));
  const make = async (cwd, entries) => {
    const chunks = [];
    for await (const c of tar.c({ gzip: true, cwd, portable: true }, entries)) chunks.push(c);
    return Buffer.concat(chunks);
  };
  const parent = await make(base, ['career-ops']);
  assert.equal(checkArchive(parent).strip, 1);
  assert.equal(checkArchive(await make(src, ['cv.md', 'data'])).strip, 0);
  // 2 MB of zeros gzips to a few KB: the limit is on what it unpacks to.
  assert.ok(parent.length < 64 * 1024);
  assert.throws(() => checkArchive(parent, { maxUnpackedBytes: 1024 * 1024, maxEntries: 100 }), /unpacks to more than/);
  assert.throws(() => checkArchive(parent, { maxUnpackedBytes: 10 * 1024 * 1024, maxEntries: 2 }), /more than 2 files/);
  assert.throws(() => checkArchive(gzipSync(Buffer.alloc(0)).subarray(0, 5)), /not a .tar.gz/);
  await rm(base, { recursive: true, force: true });
});

test('job-board links are scored only once found at the employer', () => {
  const run = (r) => ({ code: 0, stdout: JSON.stringify({ near: [], evidence: '', ...r }) });
  assert.deepEqual(interpretConfirmation(run({ verdict: 'employer_url', employerUrl: 'https://jobs.ashbyhq.com/x/1', live: 'open' }), {}), { url: 'https://jobs.ashbyhq.com/x/1' });
  assert.equal(interpretConfirmation(run({ verdict: 'employer_url', employerUrl: 'https://e/1', live: 'closed' }), {}).fail.result.closed, true);
  assert.deepEqual(interpretConfirmation(run({ verdict: 'found', match: 'exact', employerUrl: 'https://e/2', live: 'unknown' }), {}), { url: 'https://e/2', confirmed: 'exact' });
  const near = interpretConfirmation(run({ verdict: 'found', match: 'near', employerUrl: 'https://e/3' }), {});
  assert.equal(near.fail.ok, false);
  assert.match(near.fail.message, /https:\/\/e\/3/);
  assert.match(interpretConfirmation(run({ verdict: 'unidentified' }), {}).fail.message, /company and job title/);
  assert.match(interpretConfirmation(run({ verdict: 'board_without_role', near: [{ title: 'SRE', url: 'https://e/4' }] }), { company: 'Acme' }).fail.message, /Acme/);
  assert.equal(interpretConfirmation(run({ verdict: 'no_board' }), { company: 'Acme' }).fail.ok, false);
  assert.equal(interpretConfirmation({ code: 2, stdout: '' }, {}).fail.ok, false);
});

test('sync refuses bucket keys that would escape the workspace', async () => {
  const base = await mkdtemp(join(tmpdir(), 'jf-sync-'));
  const storage = createStorage({ driver: 'fs', fsRoot: join(base, 'bucket') });
  await assert.rejects(storage.put(`workspaces/${USER_A}/../${USER_B}/cv.md`, 'x'));
  await assert.rejects(upload(storage, 'workspaces/', '../etc', base, {}), /Bad user id/);
});

test('usage is read from JSON replies and from streamed replies', () => {
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 10, completion_tokens: 2 } }), { input: 10, output: 2 });
  assert.equal(usageOf({}), null);
  const sse = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7}}',
    'data: [DONE]',
  ].join('\n\n');
  assert.deepEqual(usageFromSse(sse), { input: 100, output: 7 });
  assert.equal(costMicroUsd({ priceInputPerMTok: 4, priceOutputPerMTok: 20 }, 1_000_000, 100_000), 6_000_000);
});

test('evaluation output parsing', () => {
  const out = 'saved reports/012-acme-2026-11-26.md\n  Score: 3.8/5  |  Archetype: X';
  assert.deepEqual(parseEvalOutput(out), { score: 3.8, report: 'reports/012-acme-2026-11-26.md' });
});

test('JobFlow cookies never reach the upstream app', () => {
  assert.equal(withoutJobflowCookies('jf_session=abc; theme=dark; jf_oauth_state=x'), 'theme=dark');
  assert.equal(withoutJobflowCookies('jf_session=abc'), undefined);
  assert.equal(tokenMatches('a', 'a'), true);
  assert.equal(tokenMatches('a', 'b'), false);
  assert.equal(tokenMatches(undefined, 'b'), false);
  assert.equal(tokenMatches('', ''), false);
});

test('cross-site writes are refused', () => {
  const pub = 'https://jobflow.example';
  assert.equal(sameOrigin({ method: 'GET', headers: {} }, pub), true);
  assert.equal(sameOrigin({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }, pub), false);
  assert.equal(sameOrigin({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }, pub), true);
  assert.equal(sameOrigin({ method: 'POST', headers: { origin: 'https://evil.example' } }, pub), false);
  assert.equal(sameOrigin({ method: 'POST', headers: { origin: pub } }, pub), true);
  assert.equal(sameOrigin({ method: 'POST', headers: {} }, pub), false);
});
