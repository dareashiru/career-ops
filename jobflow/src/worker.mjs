// Background worker: claims jobs, opens the user's workspace, runs the job,
// uploads the result and releases the workspace.
import { claimJob, finishJob, reapStuckJobs, requeueJob } from './jobs.mjs';
import { HANDLERS } from './handlers.mjs';
import { LockBusyError, openWorkspace } from './workspace.mjs';

async function loadUser(pool, userId) {
  return (await pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0] ?? null;
}

/**
 * Run one claimed job. With `ws`, the caller already holds the workspace (the
 * web host running a job for a user whose web app is open); otherwise the
 * workspace is opened and closed here.
 */
export async function executeJob(ctx, job, { ws = null } = {}) {
  const { pool } = ctx;
  const log = ctx.log ?? (() => {});
  const user = await loadUser(pool, job.user_id);
  if (!user || user.status !== 'active') {
    await finishJob(pool, job.id, { status: 'cancelled', log: 'Account is not active.' });
    return;
  }
  const handler = HANDLERS[job.type];
  if (!handler) {
    await finishJob(pool, job.id, { status: 'failed', log: `Unknown job type ${job.type}` });
    return;
  }

  let own = null;
  if (!ws) {
    try {
      own = await openWorkspace(ctx, job.user_id, { kind: 'job' });
    } catch (err) {
      if (err instanceof LockBusyError) {
        await requeueJob(pool, job.id, { delaySeconds: 20, countAttempt: false });
        return;
      }
      throw err;
    }
  }
  const workspace = ws ?? own;

  let outcome;
  try {
    outcome = await handler(ctx, job, workspace, user);
  } catch (err) {
    outcome = { crashed: true, message: err.message, log: err.stack };
  }

  try {
    if (own) await own.close();
    else await workspace.sync();
  } catch (err) {
    log(`job ${job.id}: upload failed: ${err.message}`);
    outcome = { crashed: true, message: `Saving the workspace failed: ${err.message}`, log: outcome?.log };
  }

  if (outcome.crashed) {
    if (job.attempts < job.max_attempts) {
      await requeueJob(pool, job.id, { delaySeconds: 30 * job.attempts, log: `${outcome.message}\n${outcome.log ?? ''}` });
    } else {
      await finishJob(pool, job.id, { status: 'failed', result: { message: outcome.message }, log: outcome.log ?? outcome.message });
    }
    return;
  }
  await finishJob(pool, job.id, {
    status: outcome.ok ? 'done' : 'failed',
    result: { message: outcome.message, ...(outcome.result ?? {}) },
    log: outcome.log ?? '',
  });
}

/** Poll for jobs with `concurrency` slots until stop() is called. */
export function startWorker(ctx, { concurrency = 2, pollMs = 2000, claimer = ctx.config.instanceId } = {}) {
  const log = ctx.log ?? console.log;
  let stopping = false;
  const running = new Set();
  let reapTimer;

  async function slot() {
    while (!stopping) {
      let job = null;
      try {
        job = await claimJob(ctx.pool, claimer);
      } catch (err) {
        log(`claim failed: ${err.message}`);
      }
      if (!job) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      log(`job ${job.id} (${job.type}) for ${job.user_id}: start`);
      try {
        await executeJob(ctx, job);
      } catch (err) {
        log(`job ${job.id}: ${err.stack}`);
        await requeueJob(ctx.pool, job.id, { delaySeconds: 60, log: err.message }).catch(() => {});
      }
      log(`job ${job.id}: end`);
    }
  }

  for (let i = 0; i < concurrency; i++) {
    const p = slot();
    running.add(p);
    p.finally(() => running.delete(p));
  }
  reapTimer = setInterval(() => {
    reapStuckJobs(ctx.pool, ctx.config.jobTimeoutMinutes + 10)
      .then((n) => n && log(`requeued ${n} stuck job(s)`))
      .catch((err) => log(`reaper: ${err.message}`));
  }, 60_000);
  reapTimer.unref();

  return {
    async stop() {
      stopping = true;
      clearInterval(reapTimer);
      await Promise.allSettled([...running]);
    },
  };
}

/** Cron entry: queue a scan for every active user whose last scan is old enough. */
export async function enqueueDueScans(pool, scanIntervalHours) {
  const res = await pool.query(
    `INSERT INTO jobs(user_id, type, payload)
     SELECT u.id, 'scan', '{"reason":"schedule"}'::jsonb FROM users u
     WHERE u.status = 'active' AND u.auto_scan
       AND (u.last_scan_at IS NULL OR u.last_scan_at < now() - make_interval(hours => $1))
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.user_id = u.id AND j.type = 'scan' AND j.status IN ('queued', 'running'))
     RETURNING user_id`,
    [scanIntervalHours],
  );
  return res.rowCount;
}
