#!/usr/bin/env node
// JobFlow entry point. One image, several roles:
//
//   node src/main.mjs app        public web service (sign-in, pages, proxy)
//   node src/main.mjs webhost    runs each user's upstream career-ops web app
//   node src/main.mjs worker     runs scan and score jobs
//   node src/main.mjs cron       queues scheduled scans, then exits
//   node src/main.mjs migrate    applies database migrations, then exits
//   node src/main.mjs invite <email>   prints a one-time sign-in link
//   node src/main.mjs all        app + webhost + worker in one process (local use)
import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { createPool, migrate } from './db.mjs';
import { createStorage } from './storage.mjs';
import { createApp } from './app.mjs';
import { WebHost } from './webhost.mjs';
import { enqueueDueScans, startWorker } from './worker.mjs';
import { createInvite } from './auth.mjs';

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

function requireSetting(ok, name) {
  if (!ok) throw new Error(`${name} must be set for this role`);
}

async function main() {
  const [role = 'all', ...args] = process.argv.slice(2);
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  if (role === 'migrate') {
    const applied = await migrate(pool);
    log(applied.length ? `applied ${applied.join(', ')}` : 'database is up to date');
    return pool.end();
  }
  if (role === 'cron') {
    const n = await enqueueDueScans(pool, config.scanIntervalHours);
    log(`queued ${n} scheduled scan(s)`);
    return pool.end();
  }
  if (role === 'invite') {
    const email = args[0];
    if (!email) throw new Error('Usage: main.mjs invite <email>');
    await migrate(pool);
    const { url } = await createInvite(pool, config, { email });
    console.log(url);
    return pool.end();
  }

  const storage = createStorage(config.storage);
  const ctx = { pool, storage, config, log };
  await mkdir(config.workDir, { recursive: true });
  const stoppers = [];
  if (role === 'app' || role === 'all' || role === 'webhost' || role === 'worker') await migrate(pool);

  if (role === 'webhost' || role === 'all') {
    requireSetting(config.internalToken, 'JOBFLOW_INTERNAL_TOKEN');
    const listenPort = role === 'all' ? config.port + 1 : config.port;
    if (role === 'all' && !config.webhostAdvertiseUrl) config.webhostAdvertiseUrl = `http://127.0.0.1:${listenPort}`;
    const host = new WebHost(ctx, { listenPort });
    await host.listen();
    stoppers.push(() => host.shutdown());
    if (role === 'all') ctx.webhostUrl = `http://127.0.0.1:${listenPort}`;
  }
  if (role === 'worker' || role === 'all') {
    const worker = startWorker(ctx, { concurrency: config.workerConcurrency });
    stoppers.push(() => worker.stop());
    log(`worker started (${config.workerConcurrency} slots)`);
  }
  if (role === 'app' || role === 'all') {
    requireSetting(config.internalToken, 'JOBFLOW_INTERNAL_TOKEN');
    requireSetting(ctx.webhostUrl || config.webhostUrl, 'WEBHOST_URL');
    const server = createApp(ctx);
    await new Promise((r) => server.listen(config.port, '0.0.0.0', r));
    stoppers.push(() => new Promise((r) => server.close(() => r())));
    log(`app listening on :${config.port} (${config.publicUrl})`);
  }
  if (!stoppers.length) throw new Error(`Unknown role "${role}"`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: shutting down (uploading open workspaces first)`);
    // Reverse order: stop taking traffic, then finish jobs, then close web apps.
    for (const stop of stoppers.reverse()) await stop().catch((err) => log(`shutdown: ${err.message}`));
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
