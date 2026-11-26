-- JobFlow's own database. It holds accounts, sessions, jobs, locks and usage.
-- Career data (CV, tracker, reports) stays in each user's workspace files.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text,
  is_admin      boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- NULL means the deployment default (DEFAULT_MONTHLY_AI_CAP_USD).
  monthly_ai_cap_cents integer CHECK (monthly_ai_cap_cents IS NULL OR monthly_ai_cap_cents >= 0),
  auto_scan     boolean NOT NULL DEFAULT true,
  last_scan_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  token_hash  text PRIMARY KEY,
  email       text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- A user's own AI key ("bring your own key"), encrypted with JOBFLOW_ENCRYPTION_KEY.
CREATE TABLE user_ai_keys (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_url       text NOT NULL,
  model          text NOT NULL,
  key_ciphertext text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per user while some instance works on their files. A lease, not a
-- session lock: a crashed holder stops renewing and the row expires.
CREATE TABLE workspace_locks (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  holder      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('job', 'web')),
  holder_url  text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('scan', 'score')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after    timestamptz NOT NULL DEFAULT now(),
  claimed_by   text,
  started_at   timestamptz,
  finished_at  timestamptz,
  result       jsonb,
  log          text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_queue_idx ON jobs(run_after, id) WHERE status = 'queued';
CREATE INDEX jobs_user_idx ON jobs(user_id, created_at DESC);

-- AI spend per user per calendar month (UTC), split by whose key paid.
CREATE TABLE ai_usage (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month         date NOT NULL,
  key_source    text NOT NULL CHECK (key_source IN ('jobflow', 'user')),
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_microusd bigint NOT NULL DEFAULT 0,
  requests      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month, key_source)
);

-- Who did what to whose workspace. Coach access (phase 2) writes here too.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_user_idx ON audit_log(user_id, at DESC);
