// Per-user workspace lock, kept as a lease row in Postgres.
//
// Only the holder may work on a user's files. The holder renews the lease
// while it works; if it crashes, the lease runs out and anyone can take it.
// Every upload checks the lease first (renew), so a holder that lost its lease
// never overwrites newer files.

export async function acquireLock(pool, userId, holder, { kind, holderUrl = null, leaseSeconds }) {
  const res = await pool.query(
    `INSERT INTO workspace_locks(user_id, holder, kind, holder_url, acquired_at, expires_at)
     VALUES ($1, $2, $3, $4, now(), now() + make_interval(secs => $5))
     ON CONFLICT (user_id) DO UPDATE
       SET holder = EXCLUDED.holder, kind = EXCLUDED.kind, holder_url = EXCLUDED.holder_url,
           acquired_at = now(), expires_at = EXCLUDED.expires_at
       WHERE workspace_locks.expires_at < now() OR workspace_locks.holder = EXCLUDED.holder
     RETURNING user_id`,
    [userId, holder, kind, holderUrl, leaseSeconds],
  );
  return res.rowCount === 1;
}

/** Extend the lease. False means the lock was lost and the caller must stop. */
export async function renewLock(pool, userId, holder, leaseSeconds) {
  const res = await pool.query(
    `UPDATE workspace_locks SET expires_at = now() + make_interval(secs => $3)
     WHERE user_id = $1 AND holder = $2 AND expires_at > now()`,
    [userId, holder, leaseSeconds],
  );
  return res.rowCount === 1;
}

export async function releaseLock(pool, userId, holder) {
  await pool.query('DELETE FROM workspace_locks WHERE user_id = $1 AND holder = $2', [userId, holder]);
}

export async function currentLock(pool, userId) {
  const res = await pool.query(
    'SELECT holder, kind, holder_url, expires_at FROM workspace_locks WHERE user_id = $1 AND expires_at > now()',
    [userId],
  );
  return res.rows[0] ?? null;
}
