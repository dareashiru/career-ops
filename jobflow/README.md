# JobFlow

JobFlow is a thin multi-user layer around **unmodified** career-ops. Each person
gets an account and a private career-ops workspace; the matching, scoring, CV
and tracking logic stays upstream's. Design plan:
https://claude.ai/artifact/LqeXqRfbvjUuaKCpuPKFJd

Everything JobFlow adds lives in this folder (plus `render.yaml` at the repo
root). No career-ops file is edited, so upstream releases can be taken as-is.

## What phase 1 does

| Plan item | Where |
|---|---|
| Accounts and sign-in (invite-only beta) | `src/auth.mjs`: one-time invite links, plus Google sign-in when configured |
| One folder per user | `src/sync.mjs`, `src/storage.mjs`: `workspaces/<user-id>/` in an S3/R2 bucket |
| One web app per user | `src/webhost.mjs`: upstream `web/` started per signed-in user against their folder, behind `src/app.mjs` |
| Server-side scans and scoring | `src/jobs.mjs`, `src/handlers.mjs`, `src/worker.mjs`: a job queue running `scan.mjs` and `openai-eval.mjs` |
| Monthly AI cap per user | `src/meter-proxy.mjs`, `src/usage.mjs`: every AI call is metered; the cap is checked before and during a job |
| Bring your own key | `user_ai_keys`, AES-256-GCM encrypted; never capped, never shown again |
| Export and import | Settings page: download the workspace as `.tar.gz`, or import a local career-ops folder |

The JobFlow pages (`/jobflow`, `src/pages.mjs`) are the start of our own front
end: home, score a job, scan, AI use, settings, admin. Everything else on the
domain is the user's own upstream career-ops web app.

## How a request and a job flow

```
browser ── jobflow-app (public) ── checks session ──┬─ /jobflow/*  JobFlow pages
                                                    └─ everything else → jobflow-webhost
jobflow-webhost (private): per user, lock → download folder → run upstream web/ as that
                           user's own uid → upload changes every minute → release when idle
jobflow-worker: claim job → lock → download → run career-ops script → upload → release
jobflow-scan-schedule (cron, hourly): queue a scan for users not scanned in SCAN_INTERVAL_HOURS
```

**Workspace lock.** One row per user in `workspace_locks`, held as a lease
(renewed every `LOCK_LEASE_SECONDS / 3`). A crashed instance stops renewing,
the lease runs out and anyone can take over. Every upload re-checks the lease,
so a holder that lost its lock never overwrites newer files.

**Queue.** Jobs are rows in Postgres, not a Redis queue: a claim must look at
the user's lock anyway (`claimJob` skips users another instance holds and users
with a job already running), and `FOR UPDATE SKIP LOCKED` lets many workers
poll safely. When a user's web app is open, the web host holds their lock and
runs their jobs in the open folder, so the app and the job never write two
copies. Jobs left running by a crashed instance are requeued.

**Isolation.** The app decides the user from the session cookie and tells the
web host; nothing the browser sends can name another user. JobFlow's cookies
and routing headers are stripped before the upstream app sees a request. When
JobFlow runs as root (it does in the container), each open workspace gets its
own Unix uid (20000-29999) and mode-700 folder, and every career-ops process
for it runs as that uid. Child processes get only the user's folder and a
short list of harmless variables, never the database URL, bucket keys, AI key
or encryption key.

**AI metering.** A scoring job runs upstream's `openai-eval.mjs` against a
loopback proxy with a throwaway token. The proxy forwards with the real key
(JobFlow's or the user's), reads token counts from the reply, records them in
`ai_usage`, and refuses calls once a JobFlow-paid user reaches their cap.

## Run it locally

Needs Node 22.13+, Postgres, and `npm install` in the repo root, `web/` (plus
`npx next build`) and `jobflow/`.

```bash
createdb jobflow
export DATABASE_URL=postgres://localhost/jobflow
export JOBFLOW_INTERNAL_TOKEN=dev-token
export JOBFLOW_ENCRYPTION_KEY=$(openssl rand -base64 32)
export ADMIN_EMAILS=you@example.com
export STORAGE_DRIVER=fs STORAGE_FS_ROOT=/tmp/jobflow-bucket JOBFLOW_WORK_DIR=/tmp/jobflow-work
# Optional, for scoring on JobFlow's key (any OpenAI-compatible endpoint):
export AI_BASE_URL=... AI_API_KEY=... AI_MODEL=... AI_PRICE_INPUT_PER_MTOK=... AI_PRICE_OUTPUT_PER_MTOK=...

node jobflow/src/main.mjs invite you@example.com   # prints a one-time sign-in link
node jobflow/src/main.mjs all                      # app on :3000, web host on :3001, worker
```

## Tests

```bash
cd jobflow && npm test
```

Database tests use `TEST_DATABASE_URL` (default
`postgres://jobflow:jobflow@127.0.0.1/jobflow_test`; the database is wiped) and
are skipped without one. `test/isolation.spec.mjs` is the gate-1 check from the
plan: two users, a stand-in web app, and the ways one might try to read the
other's files. Run it as root to cover the per-uid sandbox. `test/score.spec.mjs`
scores a job end to end through the real career-ops scripts and a mock AI.

## Deploy on Render

`render.yaml` defines the app (web), web host (private service), worker,
hourly cron and Postgres, all from `jobflow/Dockerfile`. Before applying it:

1. Create an S3 or Cloudflare R2 bucket with **versioning on** and default
   encryption; make an access key limited to that bucket.
2. Generate `JOBFLOW_ENCRYPTION_KEY` (`openssl rand -base64 32`). Use the same
   value on every service, and keep a copy: losing it makes saved user keys unreadable.
3. Optional Google sign-in: an OAuth client with redirect URI
   `<PUBLIC_URL>/jobflow/auth/google/callback`.
4. Apply the Blueprint and fill the `sync: false` values (bucket, keys, `PUBLIC_URL`,
   `ADMIN_EMAILS`, AI settings).
5. Sign in as an admin: put your email in `ADMIN_EMAILS`, then run
   `node jobflow/src/main.mjs invite you@example.com` from a Render shell, or sign
   in with Google. Invite testers from `/jobflow/admin`.

Settings are in `src/config.mjs`. The main ones: `DEFAULT_MONTHLY_AI_CAP_USD`
(5), `SCAN_INTERVAL_HOURS` (8, so about three scans a day), `MAX_WEB_SESSIONS`
per web host instance (6), `WEB_IDLE_MINUTES` (30), `SYNC_INTERVAL_SECONDS` (60).

## Taking an upstream release

1. Merge the upstream release tag into this fork (JobFlow touches no upstream file).
2. `node test-all.mjs` in the repo root, then `cd jobflow && npm test`.
3. Deploy. Testers' files need no migration: they are plain career-ops folders.

## Known limits (phase 1)

- The upstream web app's assistant and "run a CLI" features need an AI coding
  CLI, which the image does not include; those buttons will fail. Scoring runs
  through JobFlow's job queue instead.
- PDFs are rendered by the upstream web app inside each user's session; there
  is no separate PDF job yet.
- A web host crash can lose up to one sync interval (60 s) of edits made in the
  web app. Bucket versioning keeps earlier copies.
- Per-user uids isolate users on one instance; they are not a container per user.
