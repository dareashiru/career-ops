// Every setting JobFlow reads, in one place. Values come from the environment
// (Render sets them from render.yaml and the dashboard).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, hostname } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${value}"`);
  return n;
}

function list(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function withScheme(value) {
  const v = String(value ?? '').trim().replace(/\/$/, '');
  return v && !/^https?:\/\//.test(v) ? `http://${v}` : v;
}

export function loadConfig(env = process.env) {
  const port = num(env.PORT, 3000);
  return {
    port,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL || '',

    // The unmodified career-ops checkout the jobs run. Default: the folder above jobflow/.
    careerOpsDir: resolve(env.CAREER_OPS_DIR || join(here, '..', '..')),
    // Local scratch space for downloaded workspaces. Never the source of truth.
    workDir: resolve(env.JOBFLOW_WORK_DIR || join(tmpdir(), 'jobflow')),
    instanceId: env.RENDER_INSTANCE_ID || `${hostname()}-${process.pid}`,

    storage: {
      driver: env.STORAGE_DRIVER || (env.S3_BUCKET ? 's3' : 'fs'),
      fsRoot: resolve(env.STORAGE_FS_ROOT || join(tmpdir(), 'jobflow-bucket')),
      bucket: env.S3_BUCKET || '',
      region: env.S3_REGION || 'auto',
      endpoint: env.S3_ENDPOINT || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      prefix: (env.S3_PREFIX ?? 'workspaces/').replace(/^\/+/, ''),
    },

    // 32 random bytes, base64. Encrypts users' own API keys at rest.
    encryptionKey: env.JOBFLOW_ENCRYPTION_KEY || '',

    auth: {
      googleClientId: env.GOOGLE_CLIENT_ID || '',
      googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
      adminEmails: list(env.ADMIN_EMAILS),
      sessionDays: num(env.SESSION_DAYS, 30),
      inviteDays: num(env.INVITE_DAYS, 14),
    },

    // Shared secret between the app and the web host. Nothing else may call the web host.
    internalToken: env.JOBFLOW_INTERNAL_TOKEN || '',
    // Render's fromService gives host:port; accept that or a full URL.
    webhostUrl: withScheme(env.WEBHOST_URL),
    webhostAdvertiseUrl: (env.WEBHOST_ADVERTISE_URL || '').replace(/\/$/, ''),
    maxWebSessions: num(env.MAX_WEB_SESSIONS, 6),
    webIdleMinutes: num(env.WEB_IDLE_MINUTES, 30),
    webPortBase: num(env.WEB_PORT_BASE, 4100),

    // Run each user's career-ops processes as their own Unix uid: auto (when root), on, off.
    sandboxUids: env.SANDBOX_UIDS || 'auto',

    lockLeaseSeconds: num(env.LOCK_LEASE_SECONDS, 120),
    syncIntervalSeconds: num(env.SYNC_INTERVAL_SECONDS, 60),

    ai: {
      baseUrl: (env.AI_BASE_URL || '').replace(/\/$/, ''),
      apiKey: env.AI_API_KEY || '',
      model: env.AI_MODEL || '',
      // Dollars per million tokens, used to turn token counts into spend.
      priceInputPerMTok: num(env.AI_PRICE_INPUT_PER_MTOK, 0),
      priceOutputPerMTok: num(env.AI_PRICE_OUTPUT_PER_MTOK, 0),
      defaultMonthlyCapUsd: num(env.DEFAULT_MONTHLY_AI_CAP_USD, 5),
    },

    scanIntervalHours: num(env.SCAN_INTERVAL_HOURS, 8),
    jobTimeoutMinutes: num(env.JOB_TIMEOUT_MINUTES, 20),
    workerConcurrency: num(env.WORKER_CONCURRENCY, 2),
  };
}
