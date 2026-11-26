// The JobFlow app: the only service the internet reaches.
//
//   /jobflow/...  JobFlow's own pages (sign-in, home, settings, admin)
//   everything else  the signed-in user's own career-ops web app, through the web host
//
// Every request is tied to the signed-in user here, and the web host is told
// which user it is for; nothing a browser sends can pick another user.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import * as tar from 'tar';
import {
  clearSessionCookie, createInvite, createSession, destroySession, googleCallback, googleEnabled,
  googleStart, redeemInvite, sessionCookie, userFromRequest,
} from './auth.mjs';
import { audit } from './db.mjs';
import { encryptSecret } from './crypto.mjs';
import { enqueueJob, getJob, hasPendingJob, listJobs } from './jobs.mjs';
import { capMicroUsd, monthStart, monthUsage } from './usage.mjs';
import { currentLock } from './lock.mjs';
import { MAX_FILE_BYTES, download } from './sync.mjs';
import { LockBusyError, openWorkspace } from './workspace.mjs';
import { proxyRequest, proxyUpgrade } from './http-proxy.mjs';
import { INTERNAL_HEADER, USER_HEADER, webHolderUrl } from './webhost.mjs';
import {
  adminPage, dashboardPage, invitePage, jobPage, loginPage, messagePage, openingPage, settingsPage,
} from './pages.mjs';

const MAX_FORM = 256 * 1024;
const MAX_IMPORT = 50 * 1024 * 1024;

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readForm(req) {
  return new URLSearchParams((await readBody(req, MAX_FORM)).toString('utf8'));
}

function html(res, body, status = 200, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

/** Refuse cross-site writes: a state-changing request must come from our own pages. */
export function sameOrigin(req, publicUrl) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const origin = req.headers.origin;
  return Boolean(origin) && origin === new URL(publicUrl).origin;
}

export function createApp(ctx) {
  const { pool, config, storage } = ctx;
  const log = ctx.log ?? console.log;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const webhostUrl = () => ctx.webhostUrl ?? config.webhostUrl;

  // --- talking to the web host -------------------------------------------

  async function openWebApp(userId) {
    const res = await fetchImpl(`${webhostUrl()}/__jobflow/sessions/${userId}`, {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: config.internalToken },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, url: body.url, error: body.error };
  }

  async function closeWebApp(userId) {
    const holder = await webHolderUrl(pool, userId);
    if (!holder) return;
    await fetchImpl(`${holder}/__jobflow/sessions/${userId}`, {
      method: 'DELETE',
      headers: { [INTERNAL_HEADER]: config.internalToken },
    }).catch(() => {});
  }

  /** Ask the web host holding this user's open web app to upload it now. */
  async function syncWebApp(userId) {
    const holder = await webHolderUrl(pool, userId);
    if (!holder) return true;
    const res = await fetchImpl(`${holder}/__jobflow/sessions/${userId}/sync`, {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: config.internalToken },
    }).catch(() => null);
    return Boolean(res && res.status < 300);
  }

  function forwardHeaders(user) {
    return {
      [INTERNAL_HEADER]: config.internalToken,
      [USER_HEADER]: user.id,
      'x-forwarded-for': undefined,
    };
  }

  async function busyMessage(userId) {
    const lock = await currentLock(pool, userId);
    if (lock?.kind === 'job') return 'A scan or scoring job is working on your files. Your workspace opens as soon as it finishes.';
    return 'Your workspace is busy. Trying again shortly.';
  }

  // --- route handlers ------------------------------------------------------

  async function dashboard(req, res, user, flash = '') {
    const [jobs, usage, ownKey] = await Promise.all([
      listJobs(pool, user.id, 15),
      monthUsage(pool, user.id),
      pool.query('SELECT 1 FROM user_ai_keys WHERE user_id = $1', [user.id]),
    ]);
    html(res, dashboardPage({ user, jobs, usage, capMicro: capMicroUsd(user, config.ai), hasOwnKey: ownKey.rowCount > 0, flash }));
  }

  async function settings(req, res, user, flash = '') {
    const ownKey = (await pool.query('SELECT base_url, model FROM user_ai_keys WHERE user_id = $1', [user.id])).rows[0];
    html(res, settingsPage({ user, ownKey, flash, defaultModel: config.ai.model }));
  }

  async function admin(req, res, user, { flash = '', newInviteUrl = '' } = {}) {
    const users = (await pool.query(
      `SELECT u.*, COALESCE(a.cost_microusd, 0) AS spent_micro FROM users u
       LEFT JOIN ai_usage a ON a.user_id = u.id AND a.month = $1 AND a.key_source = 'jobflow'
       ORDER BY u.created_at`,
      [monthStart()],
    )).rows;
    const invites = (await pool.query(
      'SELECT email FROM invites WHERE used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 50',
    )).rows;
    html(res, adminPage({ user, users, invites, newInviteUrl, flash, defaultCapUsd: config.ai.defaultMonthlyCapUsd }));
  }

  async function exportWorkspace(res, user) {
    // The open web app uploads every minute; upload now so the export has the latest edits.
    if (!(await syncWebApp(user.id))) {
      return html(res, messagePage({ user, title: 'Try again', message: 'Your open workspace could not be saved just now, so the export would miss recent edits. Try again in a minute.' }), 503);
    }
    const tmp = await mkdtemp(join(config.workDir, 'export-'));
    try {
      await download(storage, config.storage.prefix, user.id, join(tmp, 'career-ops'));
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-disposition': 'attachment; filename="jobflow-workspace.tar.gz"',
        'cache-control': 'no-store',
      });
      await pipeline(tar.c({ gzip: true, cwd: tmp, portable: true }, ['career-ops']), res);
      await audit(pool, { userId: user.id, actorId: user.id, action: 'workspace.exported' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async function importWorkspace(req, res, user) {
    const body = await readBody(req, MAX_IMPORT);
    await closeWebApp(user.id); // its open copy would otherwise overwrite the import
    let ws;
    try {
      ws = await openWorkspace(ctx, user.id, { kind: 'job' });
    } catch (err) {
      if (err instanceof LockBusyError) return json(res, 409, { message: 'Your workspace is busy with a job. Try again in a minute.' });
      throw err;
    }
    let count = 0;
    try {
      const limits = checkArchive(body);
      const tooBig = [];
      await pipeline(Readable.from(body), tar.x({
        cwd: ws.dir,
        // Accept an archive of the folder itself or of its parent (career-ops/...).
        strip: limits.strip,
        // Regular files and folders only; no links, devices or paths outside the folder.
        filter: (path, entry) => {
          const ok = (entry.type === 'File' || entry.type === 'Directory') && !path.split('/').includes('..');
          if (ok && entry.type === 'File' && entry.size > MAX_FILE_BYTES) {
            tooBig.push(path);
            return false;
          }
          if (ok && entry.type === 'File') count++;
          return ok;
        },
        preserveOwner: false,
        noChmod: true,
      }));
      if (tooBig.length) {
        throw new Error(`files over ${MAX_FILE_BYTES / 1024 / 1024} MB are not accepted: ${tooBig.slice(0, 3).join(', ')}`);
      }
      await ws.own(ws.dir);
      await ws.close();
    } catch (err) {
      await ws.close({ upload: false });
      return json(res, 400, { message: `Could not read that archive: ${err.message}` });
    }
    await audit(pool, { userId: user.id, actorId: user.id, action: 'workspace.imported', detail: { files: count } });
    return json(res, 200, { message: `Imported ${count} files.` });
  }

  async function route(req, res) {
    const url = new URL(req.url, config.publicUrl);
    const path = url.pathname;

    if (path === '/jobflow/health') return json(res, 200, { ok: true });
    if (!sameOrigin(req, config.publicUrl)) return json(res, 403, { error: 'Cross-site request refused' });

    // --- signed-out routes ---
    if (path === '/jobflow/login') return html(res, loginPage({ googleEnabled: googleEnabled(config), error: url.searchParams.get('error') }));
    if (path === '/jobflow/auth/google' && googleEnabled(config)) {
      const { location, cookie } = googleStart(config);
      return redirect(res, location, { 'set-cookie': cookie });
    }
    if (path === '/jobflow/auth/google/callback' && googleEnabled(config)) {
      const out = await googleCallback(pool, config, req, url.searchParams, fetchImpl);
      if (out.error) return redirect(res, `/jobflow/login?error=${encodeURIComponent(out.error)}`);
      const token = await createSession(pool, config, out.user.id);
      return redirect(res, '/jobflow', { 'set-cookie': sessionCookie(config, token) });
    }
    const invite = path.match(/^\/jobflow\/invite\/([A-Za-z0-9_-]{20,})$/);
    if (invite) {
      // GET only shows a button, so link previews in chat apps cannot use up the invite.
      if (req.method === 'GET') return html(res, invitePage({ token: invite[1] }));
      const user = await redeemInvite(pool, config, invite[1]);
      if (!user) return redirect(res, `/jobflow/login?error=${encodeURIComponent('That invite link has expired or was already used.')}`);
      const token = await createSession(pool, config, user.id);
      return redirect(res, '/jobflow', { 'set-cookie': sessionCookie(config, token) });
    }

    const user = await userFromRequest(pool, req);
    if (!user) {
      if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) return redirect(res, '/jobflow/login');
      return json(res, 401, { error: 'Sign in first' });
    }

    // --- signed-in JobFlow pages ---
    if (path === '/jobflow/logout' && req.method === 'POST') {
      await destroySession(pool, req);
      return redirect(res, '/jobflow/login', { 'set-cookie': clearSessionCookie(config) });
    }
    if (path === '/jobflow' || path === '/jobflow/') return dashboard(req, res, user);
    if (path === '/jobflow/scan' && req.method === 'POST') {
      if (await hasPendingJob(pool, user.id, 'scan')) return dashboard(req, res, user, 'A scan is already queued.');
      await enqueueJob(pool, { userId: user.id, type: 'scan', payload: { reason: 'manual' } });
      return redirect(res, '/jobflow');
    }
    if (path === '/jobflow/score' && req.method === 'POST') {
      const form = await readForm(req);
      const jobUrl = (form.get('url') ?? '').trim();
      const text = (form.get('text') ?? '').trim();
      if (!jobUrl && !text) return dashboard(req, res, user, 'Add a job link or paste the description.');
      if (jobUrl && !/^https?:\/\//i.test(jobUrl)) return dashboard(req, res, user, 'The job link should start with https://');
      const job = await enqueueJob(pool, {
        userId: user.id, type: 'score', maxAttempts: 2,
        payload: {
          url: jobUrl || null,
          company: (form.get('company') ?? '').trim().slice(0, 200) || null,
          title: (form.get('title') ?? '').trim().slice(0, 300) || null,
          text: text.slice(0, 100_000) || null,
        },
      });
      return redirect(res, `/jobflow/jobs/${job.id}`);
    }
    const jobMatch = path.match(/^\/jobflow\/jobs\/(\d+)$/);
    if (jobMatch) {
      const job = await getJob(pool, user.id, Number(jobMatch[1]));
      if (!job) return html(res, messagePage({ user, title: 'Not found', message: 'No such job.' }), 404);
      return html(res, jobPage({ user, job }));
    }
    if (path === '/jobflow/settings') return settings(req, res, user);
    if (path === '/jobflow/settings/ai-key' && req.method === 'POST') {
      const form = await readForm(req);
      const baseUrl = (form.get('base_url') ?? '').trim().replace(/\/$/, '');
      const model = (form.get('model') ?? '').trim();
      const apiKey = (form.get('api_key') ?? '').trim();
      if (!/^https:\/\//.test(baseUrl) || !model || !apiKey) return settings(req, res, user, 'Give an https base URL, a model and a key.');
      await pool.query(
        `INSERT INTO user_ai_keys(user_id, base_url, model, key_ciphertext) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET base_url = $2, model = $3, key_ciphertext = $4, updated_at = now()`,
        [user.id, baseUrl, model, encryptSecret(apiKey, config.encryptionKey)],
      );
      await audit(pool, { userId: user.id, actorId: user.id, action: 'ai_key.saved', detail: { baseUrl, model } });
      return settings(req, res, user, 'Saved. Your jobs now use your own key.');
    }
    if (path === '/jobflow/settings/ai-key/delete' && req.method === 'POST') {
      await pool.query('DELETE FROM user_ai_keys WHERE user_id = $1', [user.id]);
      await audit(pool, { userId: user.id, actorId: user.id, action: 'ai_key.removed' });
      return settings(req, res, user, 'Removed. Your jobs use JobFlow’s key again, within your monthly limit.');
    }
    if (path === '/jobflow/settings/auto-scan' && req.method === 'POST') {
      const on = (await readForm(req)).get('auto_scan') === 'on';
      await pool.query('UPDATE users SET auto_scan = $2 WHERE id = $1', [user.id, on]);
      return settings(req, res, { ...user, auto_scan: on }, `Automatic scans turned ${on ? 'on' : 'off'}.`);
    }
    if (path === '/jobflow/export' && req.method === 'GET') return exportWorkspace(res, user);
    if (path === '/jobflow/import' && req.method === 'POST') return importWorkspace(req, res, user);
    if (path === '/jobflow/open' && req.method === 'POST') {
      const out = await openWebApp(user.id);
      if (out.status === 200) return json(res, 200, { ok: true });
      if (out.status === 409) return json(res, 409, { message: await busyMessage(user.id) });
      if (out.status === 503) return json(res, 503, { message: 'JobFlow is at capacity right now. Trying again shortly.' });
      return json(res, 502, { message: 'Could not start your workspace. Trying again.' });
    }

    if (path === '/jobflow/admin' || path.startsWith('/jobflow/admin/')) {
      if (!user.is_admin) return html(res, messagePage({ user, title: 'Not allowed', message: 'Admins only.' }), 403);
      if (path === '/jobflow/admin') return admin(req, res, user);
      if (path === '/jobflow/admin/invite' && req.method === 'POST') {
        const email = (await readForm(req)).get('email') ?? '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return admin(req, res, user, { flash: 'That email does not look right.' });
        const inv = await createInvite(pool, config, { email, createdBy: user.id });
        await audit(pool, { actorId: user.id, action: 'invite.created', detail: { email: email.trim().toLowerCase() } });
        return admin(req, res, user, { newInviteUrl: inv.url });
      }
      const edit = path.match(/^\/jobflow\/admin\/users\/([0-9a-f-]{36})$/);
      if (edit && req.method === 'POST') {
        const form = await readForm(req);
        const capRaw = (form.get('cap_usd') ?? '').trim();
        const cap = capRaw === '' ? null : Math.round(Number(capRaw) * 100);
        if (cap !== null && !(cap >= 0)) return admin(req, res, user, { flash: 'The limit must be a number of dollars.' });
        const status = form.get('status') === 'disabled' ? 'disabled' : 'active';
        if (edit[1] === user.id && status === 'disabled') return admin(req, res, user, { flash: 'You cannot disable yourself.' });
        await pool.query('UPDATE users SET monthly_ai_cap_cents = $2, status = $3 WHERE id = $1', [edit[1], cap, status]);
        if (status === 'disabled') {
          await pool.query('DELETE FROM sessions WHERE user_id = $1', [edit[1]]);
          await closeWebApp(edit[1]);
        }
        await audit(pool, { userId: edit[1], actorId: user.id, action: 'user.updated', detail: { capCents: cap, status } });
        return admin(req, res, user, { flash: 'Saved.' });
      }
      return html(res, messagePage({ user, title: 'Not found', message: 'No such page.' }), 404);
    }
    if (path.startsWith('/jobflow/')) return html(res, messagePage({ user, title: 'Not found', message: 'No such page.' }), 404);

    // --- everything else: the user's own career-ops web app ---
    return forwardToWebApp(req, res, user);
  }

  async function forwardToWebApp(req, res, user) {
    let holder = await webHolderUrl(pool, user.id);
    const isPageLoad = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    if (!holder) {
      if (isPageLoad) return html(res, openingPage({ user }));
      const out = await openWebApp(user.id);
      if (out.status !== 200) return json(res, 503, { error: await busyMessage(user.id) });
      holder = out.url;
    }
    try {
      await proxyRequest(req, res, holder, { setHeaders: forwardHeaders(user) });
    } catch (err) {
      log(`proxy to ${holder} failed: ${err.message}`);
      if (!res.headersSent) {
        if (isPageLoad) return html(res, openingPage({ user }));
        json(res, 502, { error: 'Your workspace is restarting. Try again.' });
      }
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log(`request ${req.method} ${req.url} failed: ${err.stack}`);
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.status === 413 ? 'Too large' : 'Something went wrong' });
      else res.destroy();
    });
  });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const user = await userFromRequest(pool, req);
      const holder = user && (await webHolderUrl(pool, user.id));
      if (!user || !holder || !sameOriginUpgrade(req, config.publicUrl)) return socket.destroy();
      proxyUpgrade(req, socket, head, holder, { setHeaders: forwardHeaders(user) });
    } catch {
      socket.destroy();
    }
  });

  return server;
}

function sameOriginUpgrade(req, publicUrl) {
  return !req.headers.origin || req.headers.origin === new URL(publicUrl).origin;
}

// Limits for an imported archive, checked on the decompressed bytes before
// anything is written: a 50 MB gzip can expand to many gigabytes.
export const IMPORT_LIMITS = Object.freeze({ maxUnpackedBytes: 200 * 1024 * 1024, maxEntries: 20_000 });

/**
 * Decompress the archive once with a hard output cap, walk its tar headers and
 * refuse it when it unpacks too large or holds too many entries. Returns the
 * strip level: 1 when the entries sit under one top folder (an archive of
 * "career-ops/"), else 0. Throws with a message the user can read.
 */
export function checkArchive(gz, limits = IMPORT_LIMITS) {
  let raw;
  try {
    // tar pads to 512-byte blocks and ends with two zero blocks; allow that slack.
    raw = gunzipSync(gz, { maxOutputLength: limits.maxUnpackedBytes + 64 * 1024 });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer.*large/i.test(err.message)) {
      throw new Error(`it unpacks to more than ${limits.maxUnpackedBytes / 1024 / 1024} MB`);
    }
    throw new Error('it is not a .tar.gz file');
  }
  let entries = 0;
  let first = '';
  for (let off = 0; off + 512 <= raw.length;) {
    const header = raw.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    // PAX and GNU long-name headers describe the next entry; count real entries only.
    if (!['x', 'g', 'L', 'K'].includes(type)) {
      if (++entries > limits.maxEntries) throw new Error(`it holds more than ${limits.maxEntries} files`);
      if (!first) first = name;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  const top = first.split('/')[0];
  const known = ['cv.md', 'config', 'data', 'modes', 'reports', 'portals.yml', 'jds', 'output', 'interview-prep', '.', ''];
  return { strip: top && !known.includes(top) && first.includes('/') ? 1 : 0, entries };
}
