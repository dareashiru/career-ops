// Shared test setup: a clean database, a folder standing in for the bucket,
// and a config pointing at both. Database tests need TEST_DATABASE_URL (or a
// local Postgres at the default below) and are skipped without one.
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.mjs';
import { migrate } from '../src/db.mjs';
import { createStorage } from '../src/storage.mjs';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://jobflow:jobflow@127.0.0.1/jobflow_test';

export async function databaseAvailable() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export async function setup(envOverrides = {}) {
  // Work folders live under /tmp so sandboxed uids can traverse to them.
  const base = await mkdtemp(join(envOverrides.JOBFLOW_TEST_TMP || tmpdir(), 'jobflow-test-'));
  await chmod(base, 0o711); // sandboxed uids must be able to pass through to their folder
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: join(base, 'bucket'),
    JOBFLOW_WORK_DIR: join(base, 'work'),
    JOBFLOW_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    JOBFLOW_INTERNAL_TOKEN: 'test-internal-token',
    PUBLIC_URL: 'http://jobflow.test',
    LOCK_LEASE_SECONDS: '30',
    ...envOverrides,
  });
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const storage = createStorage(config.storage);
  const ctx = { pool, storage, config, log: () => {} };
  return { ctx, pool, storage, config, base };
}

export async function makeUser(pool, email, extra = {}) {
  const res = await pool.query(
    'INSERT INTO users(email, is_admin, monthly_ai_cap_cents) VALUES ($1, $2, $3) RETURNING *',
    [email, extra.isAdmin ?? false, extra.capCents ?? null],
  );
  return res.rows[0];
}
