// The web host: runs one unmodified upstream career-ops web app per signed-in
// user, each on its own loopback port, against that user's downloaded folder.
//
// Only the JobFlow app talks to it (shared JOBFLOW_INTERNAL_TOKEN). The app
// says which user a request is for; the web host forwards it to that user's
// web app and nowhere else.
//
// While a user's web app is open, this instance holds their workspace lock:
// it uploads changes every SYNC_INTERVAL_SECONDS, runs that user's queued jobs
// in the same folder, and closes the app after WEB_IDLE_MINUTES without use.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { childEnv } from './careerops.mjs';
import { proxyRequest, proxyUpgrade } from './http-proxy.mjs';
import { LockBusyError, LockLostError, openWorkspace } from './workspace.mjs';
import { claimJob, requeueJob } from './jobs.mjs';
import { executeJob } from './worker.mjs';
import { currentLock } from './lock.mjs';

export const INTERNAL_HEADER = 'x-jobflow-internal';
export const USER_HEADER = 'x-jobflow-user';

export function tokenMatches(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function firstIPv4() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

/** Strip JobFlow's own cookies so the upstream app never sees the session token. */
export function withoutJobflowCookies(header) {
  if (!header) return undefined;
  const kept = header.split(';').map((s) => s.trim()).filter((c) => c && !c.startsWith('jf_'));
  return kept.length ? kept.join('; ') : undefined;
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((r) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` }, timeout: 2000 }, (res) => {
        res.resume();
        r(true);
      });
      req.on('error', () => r(false));
      req.on('timeout', () => { req.destroy(); r(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`web app did not start on port ${port}`);
}

export class WebHost {
  constructor(ctx, { listenPort }) {
    this.ctx = ctx;
    this.config = ctx.config;
    this.log = ctx.log ?? console.log;
    this.listenPort = listenPort;
    this.advertiseUrl = this.config.webhostAdvertiseUrl || `http://${firstIPv4()}:${listenPort}`;
    this.sessions = new Map(); // userId -> session
    this.pending = new Map(); // userId -> Promise<session>
    this.usedPorts = new Set();
    this.timers = [];
    this.jobBusy = false;
  }

  nextPort() {
    for (let p = this.config.webPortBase; p < this.config.webPortBase + 1000; p++) {
      if (!this.usedPorts.has(p) && p !== this.listenPort) {
        this.usedPorts.add(p);
        return p;
      }
    }
    throw new Error('No free port for a web app');
  }

  /** Open (or reuse) the user's web app. Throws LockBusyError, or Error('full'). */
  async ensure(userId) {
    const existing = this.sessions.get(userId);
    if (existing && !existing.closing) {
      existing.lastSeen = Date.now();
      return existing;
    }
    if (this.pending.has(userId)) return this.pending.get(userId);
    const p = this.start(userId).finally(() => this.pending.delete(userId));
    this.pending.set(userId, p);
    return p;
  }

  async start(userId) {
    if (this.sessions.size + this.pending.size > this.config.maxWebSessions) {
      // Make room by closing the longest-idle app that has been quiet for two minutes.
      const idle = [...this.sessions.values()].filter((s) => Date.now() - s.lastSeen > 120_000)
        .sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!idle) throw Object.assign(new Error('full'), { code: 'FULL' });
      await this.stop(idle.userId, 'making room');
    }
    const ws = await openWorkspace(this.ctx, userId, { kind: 'web', holderUrl: this.advertiseUrl });
    const port = this.nextPort();
    const { careerOpsDir } = this.config;
    const child = spawn(process.execPath, [join(careerOpsDir, 'web', 'server.mjs'), 'start', '-p', String(port)], {
      cwd: join(careerOpsDir, 'web'),
      env: childEnv(ws.dir),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // its own process group, so stop() also ends next's children
      ...(ws.uid !== undefined ? { uid: ws.uid, gid: ws.uid } : {}),
    });
    const session = { userId, ws, port, child, lastSeen: Date.now(), closing: false };
    child.stdout.on('data', () => {});
    child.stderr.on('data', (c) => this.log(`[web ${userId.slice(0, 8)}] ${String(c).trim().slice(0, 300)}`));
    child.on('exit', (code) => {
      if (!session.closing) {
        this.log(`web app for ${userId} exited (${code}); closing session`);
        this.stop(userId, 'web app exited').catch(() => {});
      }
    });
    this.sessions.set(userId, session);
    try {
      await waitForPort(port, 90_000);
    } catch (err) {
      await this.stop(userId, 'start failed');
      throw err;
    }
    this.log(`web app for ${userId} ready on :${port}`);
    return session;
  }

  async stop(userId, reason = '') {
    const s = this.sessions.get(userId);
    if (!s || s.closing) return;
    s.closing = true;
    this.log(`closing web app for ${userId}${reason ? ` (${reason})` : ''}`);
    try { process.kill(-s.child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => {
      if (s.child.exitCode !== null) return r();
      const t = setTimeout(() => { try { process.kill(-s.child.pid, 'SIGKILL'); } catch { /* gone */ } r(); }, 5000);
      s.child.once('exit', () => { clearTimeout(t); r(); });
    });
    try {
      await s.ws.close({ upload: !s.ws.lost });
    } catch (err) {
      this.log(`final upload for ${userId} failed: ${err.message}`);
    }
    this.sessions.delete(userId);
    this.usedPorts.delete(s.port);
  }

  async syncAll() {
    for (const s of [...this.sessions.values()]) {
      if (s.closing) continue;
      try {
        await s.ws.sync();
      } catch (err) {
        this.log(`sync for ${s.userId} failed: ${err.message}`);
        if (err instanceof LockLostError) await this.stop(s.userId, 'lock lost');
      }
    }
  }

  async closeIdle() {
    const limit = this.config.webIdleMinutes * 60_000;
    for (const s of [...this.sessions.values()]) {
      if (!s.jobRunning && Date.now() - s.lastSeen > limit) await this.stop(s.userId, 'idle');
    }
  }

  /** Run queued jobs for users whose workspace is open here. */
  async runHostedJobs() {
    if (this.jobBusy || this.sessions.size === 0) return;
    this.jobBusy = true;
    try {
      const userIds = [...this.sessions.values()].filter((s) => !s.closing).map((s) => s.userId);
      if (!userIds.length) return;
      const job = await claimJob(this.ctx.pool, this.advertiseUrl, { userIds });
      if (!job) return;
      const s = this.sessions.get(job.user_id);
      if (!s || s.closing) {
        await requeueJob(this.ctx.pool, job.id, { delaySeconds: 5, countAttempt: false });
        return;
      }
      this.log(`job ${job.id} (${job.type}) for ${job.user_id}: running in open workspace`);
      s.jobRunning = true;
      try {
        await executeJob(this.ctx, job, { ws: s.ws });
      } finally {
        s.jobRunning = false;
      }
    } catch (err) {
      this.log(`hosted job failed: ${err.message}`);
    } finally {
      this.jobBusy = false;
    }
  }

  async handle(req, res) {
    if (!tokenMatches(req.headers[INTERNAL_HEADER], this.config.internalToken)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, 'http://webhost');

    if (url.pathname === '/__jobflow/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessions: this.sessions.size }));
      return;
    }

    const syncPath = url.pathname.match(/^\/__jobflow\/sessions\/([0-9a-f-]{36})\/sync$/i);
    if (syncPath && req.method === 'POST') {
      // Upload the open copy now, so an export reads the latest files.
      const s = this.sessions.get(syncPath[1]);
      if (!s || s.closing) {
        res.writeHead(204).end();
        return;
      }
      try {
        await s.ws.sync();
        res.writeHead(204).end();
      } catch (err) {
        this.log(`sync for ${s.userId} failed: ${err.message}`);
        if (err instanceof LockLostError) await this.stop(s.userId, 'lock lost');
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'sync-failed' }));
      }
      return;
    }

    const sessionPath = url.pathname.match(/^\/__jobflow\/sessions\/([0-9a-f-]{36})$/i);
    if (sessionPath) {
      const userId = sessionPath[1];
      if (req.method === 'POST') {
        try {
          await this.ensure(userId);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ url: this.advertiseUrl }));
        } catch (err) {
          const status = err instanceof LockBusyError ? 409 : err.code === 'FULL' ? 503 : 500;
          if (status === 500) this.log(`could not open web app for ${userId}: ${err.stack}`);
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.code || err.message }));
        }
        return;
      }
      if (req.method === 'DELETE') {
        await this.stop(userId, 'requested');
        res.writeHead(204).end();
        return;
      }
    }

    const userId = req.headers[USER_HEADER];
    const s = typeof userId === 'string' ? this.sessions.get(userId) : null;
    if (!s || s.closing) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no-session' }));
      return;
    }
    s.lastSeen = Date.now();
    await proxyRequest(req, res, `http://127.0.0.1:${s.port}`, { setHeaders: this.upstreamHeaders(req, s) })
      .catch(() => { if (!res.headersSent) res.writeHead(502).end('The career-ops app is not answering.'); });
  }

  upstreamHeaders(req, s) {
    const local = `127.0.0.1:${s.port}`;
    return {
      host: local,
      // The app already checked the browser's origin; upstream checks it against its own host.
      origin: req.headers.origin ? `http://${local}` : undefined,
      referer: undefined,
      cookie: withoutJobflowCookies(req.headers.cookie),
      [INTERNAL_HEADER]: undefined,
      [USER_HEADER]: undefined,
      'x-forwarded-for': undefined,
      'x-forwarded-host': undefined,
      'x-forwarded-proto': undefined,
    };
  }

  handleUpgrade(req, socket, head) {
    const s = this.sessions.get(req.headers[USER_HEADER]);
    if (!tokenMatches(req.headers[INTERNAL_HEADER], this.config.internalToken) || !s) {
      socket.destroy();
      return;
    }
    s.lastSeen = Date.now();
    proxyUpgrade(req, socket, head, `http://127.0.0.1:${s.port}`, { setHeaders: this.upstreamHeaders(req, s) });
  }

  async listen() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log(`webhost error: ${err.stack}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    await new Promise((r) => this.server.listen(this.listenPort, '0.0.0.0', r));
    this.timers.push(setInterval(() => this.syncAll(), this.config.syncIntervalSeconds * 1000));
    this.timers.push(setInterval(() => this.closeIdle(), 30_000));
    this.timers.push(setInterval(() => this.runHostedJobs(), 3000));
    this.log(`web host listening on :${this.listenPort} (advertised as ${this.advertiseUrl})`);
  }

  async shutdown() {
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id, 'shutdown')));
    await new Promise((r) => this.server?.close(() => r()) ?? r());
  }
}

/** Is a web app for this user open somewhere? Returns its web host URL, or null. */
export async function webHolderUrl(pool, userId) {
  const lock = await currentLock(pool, userId);
  return lock?.kind === 'web' ? lock.holder_url : null;
}
