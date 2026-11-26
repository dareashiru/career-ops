// AI usage and the monthly cap.
//
// Every AI call a job makes goes through the metering proxy (meter-proxy.mjs),
// which records tokens here. Calls on JobFlow's key count against the user's
// monthly cap; calls on the user's own key are recorded but never capped.
import { decryptSecret } from './crypto.mjs';

export function monthStart(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Cost in millionths of a dollar for a token count at the configured prices ($ per million tokens). */
export function costMicroUsd(ai, inputTokens, outputTokens) {
  return Math.round(inputTokens * ai.priceInputPerMTok + outputTokens * ai.priceOutputPerMTok);
}

export async function recordUsage(pool, { userId, keySource, inputTokens, outputTokens, costMicro }) {
  await pool.query(
    `INSERT INTO ai_usage(user_id, month, key_source, input_tokens, output_tokens, cost_microusd, requests)
     VALUES ($1, $2, $3, $4, $5, $6, 1)
     ON CONFLICT (user_id, month, key_source) DO UPDATE SET
       input_tokens = ai_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = ai_usage.output_tokens + EXCLUDED.output_tokens,
       cost_microusd = ai_usage.cost_microusd + EXCLUDED.cost_microusd,
       requests = ai_usage.requests + 1`,
    [userId, monthStart(), keySource, inputTokens, outputTokens, costMicro],
  );
}

export async function monthUsage(pool, userId) {
  const res = await pool.query(
    `SELECT key_source, input_tokens, output_tokens, cost_microusd, requests
     FROM ai_usage WHERE user_id = $1 AND month = $2`,
    [userId, monthStart()],
  );
  const empty = () => ({ inputTokens: 0, outputTokens: 0, costMicro: 0, requests: 0 });
  const out = { jobflow: empty(), user: empty() };
  for (const r of res.rows) {
    out[r.key_source] = {
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      costMicro: Number(r.cost_microusd),
      requests: r.requests,
    };
  }
  return out;
}

export function capMicroUsd(user, ai) {
  const cents = user.monthly_ai_cap_cents ?? Math.round(ai.defaultMonthlyCapUsd * 100);
  return cents * 10_000;
}

/**
 * Which AI endpoint and key a user's job should use.
 * Returns {keySource, baseUrl, model, apiKey, capMicro} or {error}.
 */
export async function resolveAiAccess(pool, config, user) {
  const own = (await pool.query(
    'SELECT base_url, model, key_ciphertext FROM user_ai_keys WHERE user_id = $1',
    [user.id],
  )).rows[0];
  if (own) {
    return {
      keySource: 'user',
      baseUrl: own.base_url,
      model: own.model,
      apiKey: decryptSecret(own.key_ciphertext, config.encryptionKey),
      capMicro: Infinity,
    };
  }
  const { ai } = config;
  if (!ai.baseUrl || !ai.apiKey || !ai.model) {
    return { error: 'Scoring is not set up yet. Add your own AI key in Settings, or ask the admin to set the JobFlow AI key.' };
  }
  const usage = await monthUsage(pool, user.id);
  const capMicro = capMicroUsd(user, ai);
  if (usage.jobflow.costMicro >= capMicro) {
    return {
      error: `You have reached this month's AI limit ($${(capMicro / 1e6).toFixed(2)}). `
        + 'It resets on the 1st, or you can add your own AI key in Settings.',
    };
  }
  return { keySource: 'jobflow', baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey, capMicro };
}
