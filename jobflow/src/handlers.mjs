// What each job type does, given an open workspace folder.
//
// Each handler only chains upstream career-ops scripts. It returns
// {ok, message, result, log}: ok=false is a normal outcome the user should
// see (closed posting, AI limit reached), not a crash, and is not retried.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runScript } from './careerops.mjs';
import { startMeterProxy } from './meter-proxy.mjs';
import { resolveAiAccess } from './usage.mjs';

const tail = (s, n = 4000) => String(s ?? '').slice(-n);

export async function runScan(ctx, job, ws) {
  const { config, pool } = ctx;
  const res = await runScript(config.careerOpsDir, 'scan.mjs', ['--quiet'], {
    dataDir: ws.dir, uid: ws.uid,
    timeoutMs: config.jobTimeoutMinutes * 60_000,
  });
  await pool.query('UPDATE users SET last_scan_at = now() WHERE id = $1', [job.user_id]);
  const log = `$ node scan.mjs --quiet (exit ${res.code})\n${tail(res.stdout)}\n${tail(res.stderr, 2000)}`;
  if (res.code !== 0 && /portals\.yml not found/.test(res.stdout + res.stderr)) {
    return { ok: false, message: 'Add the companies you want to watch first (Portals, in career-ops), then scan again.', log };
  }
  if (res.code !== 0) {
    return { ok: false, message: res.timedOut ? 'The scan took too long and was stopped.' : 'The scan did not finish. See the log.', log };
  }
  const summary = res.stdout.trim().split('\n').filter(Boolean).slice(-6).join('\n');
  return { ok: true, message: 'Scan finished.', result: { summary }, log };
}

/** Parse the score and report path that openai-eval.mjs prints. */
export function parseEvalOutput(stdout) {
  const score = stdout.match(/Score:\s*([\d.]+)\s*\/\s*5/);
  const report = stdout.match(/(reports\/[^\s`'"]+\.md)/);
  return { score: score ? Number(score[1]) : null, report: report ? report[1] : null };
}

export async function runScore(ctx, job, ws, user) {
  const { config, pool } = ctx;
  const url = typeof job.payload.url === 'string' ? job.payload.url.trim() : '';
  let text = typeof job.payload.text === 'string' ? job.payload.text : '';
  const logs = [];
  const tmp = join(ws.dir, '.jobflow-tmp', `job-${job.id}`);
  await mkdir(tmp, { recursive: true });
  const timeoutMs = config.jobTimeoutMinutes * 60_000;

  if (!text.trim()) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'Give a job link or paste the job description.' };
    const fetched = await runScript(config.careerOpsDir, 'fetch-jd.mjs', [url], { dataDir: ws.dir, uid: ws.uid, timeoutMs: 120_000 });
    logs.push(`$ node fetch-jd.mjs <url> (exit ${fetched.code})`);
    if (fetched.code === 3) {
      return { ok: false, message: 'That posting looks closed.', result: { closed: true, evidence: tail(fetched.stdout, 500) }, log: logs.join('\n') };
    }
    if (fetched.code !== 0 || !fetched.stdout.trim()) {
      return {
        ok: false,
        message: "Couldn't read the job description from that link. Paste the description text instead.",
        log: logs.join('\n'),
      };
    }
    text = fetched.stdout;
  }

  // Upstream rule: postings are untrusted. Run the posting guard and score the cleaned text.
  const raw = join(tmp, 'posting.txt');
  const clean = join(tmp, 'posting.clean.txt');
  await writeFile(raw, text, 'utf8');
  await ws.own(tmp);
  const guard = await runScript(config.careerOpsDir, 'posting-guard.mjs', ['--in', raw, '--out', clean], { dataDir: ws.dir, uid: ws.uid, timeoutMs: 60_000 });
  logs.push(`$ node posting-guard.mjs (exit ${guard.code})\n${tail(guard.stdout, 1500)}`);
  if (!existsSync(clean)) return { ok: false, message: 'The posting guard could not process this text.', log: logs.join('\n') };

  const access = await resolveAiAccess(pool, config, user);
  if (access.error) return { ok: false, message: access.error, log: logs.join('\n') };

  const proxy = await startMeterProxy({ pool, config, user, access, fetchImpl: ctx.fetchImpl });
  let evalRun;
  try {
    const args = ['--file', clean];
    if (url) args.push('--posting-url', url);
    evalRun = await runScript(config.careerOpsDir, 'openai-eval.mjs', args, {
      dataDir: ws.dir, uid: ws.uid,
      timeoutMs,
      env: { OPENAI_BASE_URL: proxy.baseUrl, OPENAI_API_KEY: proxy.token, OPENAI_MODEL: access.model },
    });
  } finally {
    await proxy.close();
  }
  logs.push(`$ node openai-eval.mjs (exit ${evalRun.code})\n${tail(evalRun.stdout)}\n${tail(evalRun.stderr, 2000)}`);
  const usage = { inputTokens: proxy.totals.input, outputTokens: proxy.totals.output, costMicro: proxy.totals.costMicro, keySource: access.keySource };
  if (evalRun.code !== 0) {
    return { ok: false, message: evalRun.timedOut ? 'Scoring took too long and was stopped.' : 'Scoring did not finish. See the log.', result: { usage }, log: logs.join('\n') };
  }

  // Fold the new tracker row into data/applications.md (upstream's only write path for new rows).
  const merge = await runScript(config.careerOpsDir, 'merge-tracker.mjs', [], { dataDir: ws.dir, uid: ws.uid, timeoutMs: 120_000 });
  logs.push(`$ node merge-tracker.mjs (exit ${merge.code})\n${tail(merge.stdout, 1500)}`);

  const parsed = parseEvalOutput(evalRun.stdout);
  return {
    ok: true,
    message: parsed.score !== null ? `Scored ${parsed.score}/5.` : 'Scored.',
    result: { ...parsed, url: url || null, usage },
    log: logs.join('\n'),
  };
}

export const HANDLERS = { scan: runScan, score: runScore };
