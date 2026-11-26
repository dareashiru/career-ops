// Sign-in for the invite-only beta.
//
// Two ways in, both tied to an email an admin invited:
//   - Google sign-in (OpenID Connect), when GOOGLE_CLIENT_ID/SECRET are set;
//   - a one-time invite link, which also works with no Google setup at all.
// A signed-in browser holds a random session token in an HttpOnly cookie; the
// database stores only its SHA-256.
import { randomToken, sha256 } from './crypto.mjs';
import { audit } from './db.mjs';

export const SESSION_COOKIE = 'jf_session';
const STATE_COOKIE = 'jf_oauth_state';

export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAgeSeconds, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export async function createInvite(pool, config, { email, createdBy }) {
  const token = randomToken();
  await pool.query(
    `INSERT INTO invites(token_hash, email, created_by, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(token), normaliseEmail(email), createdBy ?? null, config.auth.inviteDays],
  );
  return { token, url: `${config.publicUrl}/jobflow/invite/${token}` };
}

/** An email may sign in if it already has an account or holds an unexpired invite. */
async function findOrCreateUser(pool, config, email, name) {
  email = normaliseEmail(email);
  const existing = (await pool.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];
  if (existing) return existing.status === 'active' ? existing : null;
  const invited = (await pool.query(
    'SELECT 1 FROM invites WHERE email = $1 AND expires_at > now() AND used_at IS NULL LIMIT 1',
    [email],
  )).rowCount > 0;
  const isAdmin = config.auth.adminEmails.includes(email);
  if (!invited && !isAdmin) return null;
  const user = (await pool.query(
    'INSERT INTO users(email, name, is_admin) VALUES ($1, $2, $3) RETURNING *',
    [email, name ?? null, isAdmin],
  )).rows[0];
  await pool.query('UPDATE invites SET used_at = now() WHERE email = $1 AND used_at IS NULL', [email]);
  await audit(pool, { userId: user.id, actorId: user.id, action: 'account.created' });
  return user;
}

export async function redeemInvite(pool, config, token) {
  const row = (await pool.query(
    'SELECT email FROM invites WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL',
    [sha256(String(token))],
  )).rows[0];
  if (!row) return null;
  const user = await findOrCreateUser(pool, config, row.email);
  if (user) await pool.query('UPDATE invites SET used_at = now() WHERE token_hash = $1', [sha256(String(token))]);
  return user;
}

export async function createSession(pool, config, userId) {
  const token = randomToken();
  await pool.query(
    `INSERT INTO sessions(token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, config.auth.sessionDays],
  );
  return token;
}

export function sessionCookie(config, token) {
  return cookie(SESSION_COOKIE, token, {
    maxAgeSeconds: config.auth.sessionDays * 86400,
    secure: config.publicUrl.startsWith('https://'),
  });
}

export function clearSessionCookie(config) {
  return cookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: config.publicUrl.startsWith('https://') });
}

/** The signed-in, active user for a request, or null. */
export async function userFromRequest(pool, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const res = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)],
  );
  return res.rows[0] ?? null;
}

export async function destroySession(pool, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

// --- Google OpenID Connect -------------------------------------------------

export function googleEnabled(config) {
  return Boolean(config.auth.googleClientId && config.auth.googleClientSecret);
}

export function googleStart(config) {
  const state = randomToken(16);
  const params = new URLSearchParams({
    client_id: config.auth.googleClientId,
    redirect_uri: `${config.publicUrl}/jobflow/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return {
    location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    cookie: cookie(STATE_COOKIE, state, { maxAgeSeconds: 600, secure: config.publicUrl.startsWith('https://') }),
  };
}

/**
 * Finish Google sign-in. The ID token comes straight from Google's token
 * endpoint over TLS (code flow), so its claims are checked but its signature
 * need not be (OpenID Connect Core 3.1.3.7).
 */
export async function googleCallback(pool, config, req, query, fetchImpl = fetch) {
  const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
  if (!expected || query.get('state') !== expected) return { error: 'Sign-in expired. Please try again.' };
  const code = query.get('code');
  if (!code) return { error: 'Google did not return a sign-in code.' };
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.auth.googleClientId,
      client_secret: config.auth.googleClientSecret,
      redirect_uri: `${config.publicUrl}/jobflow/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return { error: 'Google sign-in failed.' };
  const { id_token: idToken } = await res.json();
  let claims;
  try {
    claims = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return { error: 'Google sign-in returned an unreadable token.' };
  }
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== config.auth.googleClientId || !(claims.exp * 1000 > Date.now())) {
    return { error: 'Google sign-in token was not valid.' };
  }
  if (!claims.email || claims.email_verified !== true) return { error: 'Your Google email is not verified.' };
  const user = await findOrCreateUser(pool, config, claims.email, claims.name);
  if (!user) return { error: `${claims.email} has not been invited to the JobFlow beta yet.` };
  return { user };
}
