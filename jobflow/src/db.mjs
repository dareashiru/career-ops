import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function createPool(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const ssl = /sslmode=require/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined;
  return new pg.Pool({ connectionString: databaseUrl, max: 10, ssl });
}

/** Apply every migrations/NNN_*.sql not applied yet, in order, each in a transaction. */
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    // Serialise concurrent deploys: only one instance migrates at a time.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const files = readdirSync(join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(here, 'migrations', file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

export async function audit(pool, { userId, actorId, action, detail = {} }) {
  await pool.query(
    'INSERT INTO audit_log(user_id, actor_id, action, detail) VALUES ($1, $2, $3, $4)',
    [userId ?? null, actorId ?? null, action, detail],
  );
}
