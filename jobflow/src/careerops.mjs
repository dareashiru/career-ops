// Runs one career-ops script for one user.
//
// The child sees only that user's folder (CAREER_OPS_ROOT) and a short list of
// harmless variables. JobFlow's own secrets (database, bucket, AI key,
// encryption key) are never passed down.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const PASS_THROUGH = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'PLAYWRIGHT_BROWSERS_PATH', 'NODE_OPTIONS'];
const OUTPUT_CAP = 64 * 1024;

export function childEnv(dataDir, extra = {}) {
  const env = {};
  for (const name of PASS_THROUGH) if (process.env[name]) env[name] = process.env[name];
  const home = join(dataDir, '.jobflow-tmp', 'home');
  return {
    ...env,
    HOME: home,
    TMPDIR: join(dataDir, '.jobflow-tmp'),
    NODE_ENV: 'production',
    CAREER_OPS_ROOT: dataDir,
    ...extra,
  };
}

/**
 * Run `node <careerOpsDir>/<script> ...args` against a user's folder.
 * Resolves {code, stdout, stderr, timedOut}; never rejects on a non-zero exit.
 */
export function runScript(careerOpsDir, script, args, { dataDir, uid, env = {}, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(careerOpsDir, script), ...args], {
      cwd: dataDir,
      env: childEnv(dataDir, env),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(uid !== undefined ? { uid, gid: uid } : {}),
    });
    let stdout = '';
    let stderr = '';
    const keep = (prev, chunk) => (prev + chunk).slice(-OUTPUT_CAP);
    child.stdout.on('data', (c) => { stdout = keep(stdout, c); });
    child.stderr.on('data', (c) => { stderr = keep(stderr, c); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); rejectRun(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: timedOut ? 124 : code, stdout, stderr, timedOut });
    });
  });
}

/** Fill a new, empty workspace with upstream's templates (doctor --init-templates). */
export async function initWorkspace(careerOpsDir, dataDir) {
  await mkdir(join(dataDir, '.jobflow-tmp', 'home'), { recursive: true });
  return runScript(careerOpsDir, 'doctor.mjs', ['--json', '--init-templates'], { dataDir, timeoutMs: 120_000 });
}

/** Create the per-run HOME and TMPDIR a child expects, before the folder is locked down. */
export async function prepareScratch(dataDir) {
  await mkdir(join(dataDir, '.jobflow-tmp', 'home'), { recursive: true });
}
