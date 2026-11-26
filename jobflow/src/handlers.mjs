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
  const log = `$ node scan.mjs --quiet (exit ${res.code})\n${tail(res.stdout)}\n${tail(res.stderr, 2000)}`;
  if (res.code !== 0 && /portals\.yml not found/.test(res.stdout + res.stderr)) {
    return { ok: false, message: 'Add the companies you want to watch first (Portals, in career-ops), then scan again.', log };
  }
  if (res.code !== 0) {
    return { ok: false, message: res.timedOut ? 'The scan took too long and was stopped.' : 'The scan did not finish. See the log.', log };
  }
  // Only a finished scan counts, so a failed one is retried at the next scheduled run.
  await pool.query('UPDATE users SET last_scan_at = now() WHERE id = $1', [job.user_id]);
  const summary = res.stdout.trim().split('\n').filter(Boolean).slice(-6).join('\n');
  return { ok: true, message: 'Scan finished.', result: { summary }, log };
}

/** Parse the score and report path that openai-eval.mjs prints. */
export function parseEvalOutput(stdout) {
  const score = stdout.match(/Score:\s*([\d.]+)\s*\/\s*5/);
  const report = stdout.match(/(reports\/[^\s`'"]+\.md)/);
  return { score: score ? Number(score[1]) : null, report: report ? report[1] : null };
}

/**
 * Decide which link a job is scored under, following upstream's "Aggregator
 * Listings -- Confirm at the Employer" rule through its confirm-at-employer.mjs.
 * Returns {url} (the employer's link, canonical from here on) or {fail} with
 * the outcome to show. A job-board page is never fetched: the JD comes from
 * the employer's link or from the text the user pasted.
 */
export async function confirmEmployerUrl(ctx, ws, { url, company, title, tmp, logs }) {
  const input = join(tmp, 'posting.json');
  await writeFile(input, JSON.stringify({ url, company, title }), 'utf8');
  await ws.own(tmp);
  const run = await runScript(ctx.config.careerOpsDir, 'confirm-at-employer.mjs', ['--input', input, '--json'], {
    dataDir: ws.dir, uid: ws.uid, timeoutMs: 120_000,
  });
  logs.push(`$ node confirm-at-employer.mjs (exit ${run.code})\n${tail(run.stdout, 1500)}`);
  return interpretConfirmation(run, { company });
}

const BOARD_LINK_HELP = 'Job boards like LinkedIn keep listings up after a role is filled, so JobFlow scores only roles it can find on the employer\'s own site.';

export function interpretConfirmation(run, { company }) {
  let r = null;
  try { r = run.code === 0 ? JSON.parse(run.stdout) : null; } catch { r = null; }
  if (!r?.verdict) {
    return { fail: { ok: false, message: "Couldn't check that link. Try again later, or paste the job description without the link." } };
  }
  const closed = (employerUrl) => ({ fail: { ok: false, message: 'That posting looks closed.', result: { closed: true, url: employerUrl, evidence: r.evidence } } });
  if (r.verdict === 'employer_url') return r.live === 'closed' ? closed(r.employerUrl) : { url: r.employerUrl };
  if (r.verdict === 'found' && (r.match === 'origin' || r.match === 'exact')) {
    return r.live === 'closed' ? closed(r.employerUrl) : { url: r.employerUrl, confirmed: r.match };
  }
  if (r.verdict === 'found') {
    return { fail: { ok: false, message: `A similar role is on the employer's site: ${r.employerUrl}. If it is the same job, score that link.`, result: { candidate: r.employerUrl } } };
  }
  if (r.verdict === 'unidentified') {
    return { fail: { ok: false, message: `That link is from a job board. Give the employer's own link for this role, or add the company and job title so JobFlow can look for it. ${BOARD_LINK_HELP}` } };
  }
  const near = (r.near || []).slice(0, 3).map((n) => `${n.title}: ${n.url}`);
  return {
    fail: {
      ok: false,
      message: `Couldn't find this role on ${company || 'the employer'}'s own job site. If you have the employer's link, score that instead. ${BOARD_LINK_HELP}`,
      result: near.length ? { near } : undefined,
    },
  };
}

export async function runScore(ctx, job, ws, user) {
  const { config, pool } = ctx;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  let url = str(job.payload.url);
  const company = str(job.payload.company);
  const title = str(job.payload.title);
  let text = typeof job.payload.text === 'string' ? job.payload.text : '';
  const logs = [];
  const tmp = join(ws.dir, '.jobflow-tmp', `job-${job.id}`);
  await mkdir(tmp, { recursive: true });
  const timeoutMs = config.jobTimeoutMinutes * 60_000;

  if (url && !/^https?:\/\//i.test(url)) return { ok: false, message: 'The job link should start with https://' };
  if (url) {
    const confirmed = await confirmEmployerUrl(ctx, ws, { url, company, title, tmp, logs });
    if (confirmed.fail) return { ...confirmed.fail, log: logs.join('\n') };
    url = confirmed.url;
  }

  if (!text.trim()) {
    if (!url) return { ok: false, message: 'Give a job link or paste the job description.' };
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
  logs.push(`$ node merge-tracker.mjs (exit ${merge.code})\n${tail(merge.stdout, 1500)}\n${tail(merge.stderr, 1500)}`);
  const parsed = parseEvalOutput(evalRun.stdout);
  if (merge.code !== 0) {
    // The report exists but the tracker row does not: say so instead of "Scored".
    return {
      ok: false,
      message: `The report was written${parsed.report ? ` (${parsed.report})` : ''}, but adding it to your tracker failed. See the log.`,
      result: { ...parsed, url: url || null, usage, trackerMerged: false },
      log: logs.join('\n'),
    };
  }

  return {
    ok: true,
    message: parsed.score !== null ? `Scored ${parsed.score}/5.` : 'Scored.',
    result: { ...parsed, url: url || null, usage },
    log: logs.join('\n'),
  };
}

export const HANDLERS = { scan: runScan, score: runScore };
