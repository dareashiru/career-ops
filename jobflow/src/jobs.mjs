// The job queue: rows in the Postgres `jobs` table.
//
// Postgres rather than a separate Redis queue, because every claim has to
// look at the user's workspace lock anyway. A job is only claimed when no
// other job for that user is running and no other instance holds the user's
// lock, which keeps one writer per workspace. `SKIP LOCKED` lets many workers
// poll the same table without blocking each other.

export const JOB_TYPES = ['scan', 'score'];

export async function enqueueJob(pool, { userId, type, payload = {}, runAfter = null, maxAttempts = 3 }) {
  if (!JOB_TYPES.includes(type)) throw new Error(`Unknown job type: ${type}`);
  const res = await pool.query(
    `INSERT INTO jobs(user_id, type, payload, run_after, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5) RETURNING *`,
    [userId, type, payload, runAfter, maxAttempts],
  );
  return res.rows[0];
}

/**
 * Claim the next runnable job.
 * - Workers pass no userIds: they take jobs for users nobody holds a lock on.
 * - The web host passes the users whose workspaces it has open, and takes only
 *   their jobs, running them in the open workspace.
 */
export async function claimJob(pool, claimer, { userIds = null } = {}) {
  const res = await pool.query(
    `UPDATE jobs SET status = 'running', claimed_by = $1, started_at = now(), attempts = attempts + 1
     WHERE id = (
       SELECT j.id FROM jobs j
       WHERE j.status = 'queued' AND j.run_after <= now()
         AND (
           ($2::uuid[] IS NULL AND NOT EXISTS (
              SELECT 1 FROM workspace_locks l WHERE l.user_id = j.user_id AND l.expires_at > now()))
           OR j.user_id = ANY($2::uuid[])
         )
         AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.user_id = j.user_id AND r.status = 'running')
       ORDER BY j.run_after, j.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     RETURNING *`,
    [claimer, userIds],
  );
  return res.rows[0] ?? null;
}

export async function finishJob(pool, id, { status, result = null, log = '' }) {
  await pool.query(
    `UPDATE jobs SET status = $2, result = $3, log = $4, finished_at = now() WHERE id = $1`,
    [id, status, result, String(log).slice(-20000)],
  );
}

/**
 * Put a claimed job back in the queue. `countAttempt: false` undoes the claim's
 * attempt count (used when the workspace was simply busy).
 */
export async function requeueJob(pool, id, { delaySeconds = 15, countAttempt = true, log = null } = {}) {
  await pool.query(
    `UPDATE jobs SET status = 'queued', claimed_by = NULL, started_at = NULL,
       attempts = attempts - CASE WHEN $3 THEN 0 ELSE 1 END,
       run_after = now() + make_interval(secs => $2),
       log = COALESCE($4, log)
     WHERE id = $1`,
    [id, delaySeconds, countAttempt, log],
  );
}

/** Jobs left 'running' by a crashed instance go back to the queue (or fail after max attempts). */
export async function reapStuckJobs(pool, olderThanMinutes) {
  const res = await pool.query(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
       log = COALESCE(log, '') || E'\\nThe instance running this job stopped; ' ||
             CASE WHEN attempts >= max_attempts THEN 'giving up.' ELSE 'retrying.' END,
       claimed_by = NULL, run_after = now()
     WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)
     RETURNING id`,
    [olderThanMinutes],
  );
  return res.rowCount;
}

export async function listJobs(pool, userId, limit = 20) {
  const res = await pool.query(
    `SELECT id, type, payload, status, attempts, result, created_at, started_at, finished_at
     FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return res.rows;
}

export async function getJob(pool, userId, id) {
  const res = await pool.query('SELECT * FROM jobs WHERE id = $1 AND user_id = $2', [id, userId]);
  return res.rows[0] ?? null;
}

export async function hasPendingJob(pool, userId, type) {
  const res = await pool.query(
    `SELECT 1 FROM jobs WHERE user_id = $1 AND type = $2 AND status IN ('queued', 'running') LIMIT 1`,
    [userId, type],
  );
  return res.rowCount > 0;
}
