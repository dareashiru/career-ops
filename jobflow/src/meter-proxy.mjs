// A one-job, loopback-only proxy for OpenAI-compatible AI calls.
//
// A scoring job runs upstream's openai-eval.mjs with OPENAI_BASE_URL pointed
// here and a throwaway token as its key. The proxy:
//   - checks the throwaway token, so only this job's child can use it;
//   - refuses the call once the user's monthly cap is spent (JobFlow key only);
//   - forwards it with the real key, which the child process never sees;
//   - reads the token counts from the reply (plain JSON or a stream) and
//     records them in ai_usage.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomToken } from './crypto.mjs';
import { costMicroUsd, monthUsage, recordUsage } from './usage.mjs';

const MAX_BODY = 8 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { rejectBody(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

/** Pull prompt/completion token counts out of an OpenAI-shaped usage object. */
export function usageOf(obj) {
  const u = obj?.usage ?? obj?.x_groq?.usage;
  if (!u) return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens);
  const output = Number(u.completion_tokens ?? u.output_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output };
}

/** Last usage object reported in a server-sent-events body. */
export function usageFromSse(text) {
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const u = usageOf(JSON.parse(data));
      if (u) found = u;
    } catch { /* partial or non-JSON line */ }
  }
  return found;
}

/**
 * Start the proxy. Returns {baseUrl, token, totals, close()}.
 * @param {{pool, config, user, access, fetchImpl?}} opts  access comes from resolveAiAccess()
 */
export async function startMeterProxy({ pool, config, user, access, fetchImpl = fetch }) {
  const token = randomToken(24);
  const totals = { input: 0, output: 0, costMicro: 0, requests: 0 };

  async function overCap() {
    if (access.keySource !== 'jobflow') return false;
    const usage = await monthUsage(pool, user.id);
    return usage.jobflow.costMicro >= access.capMicro;
  }

  const server = createServer(async (req, res) => {
    const send = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type: 'jobflow_proxy' } }));
    };
    try {
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, 'Bad proxy token');
      if (req.method !== 'POST' || !req.url.startsWith('/v1/')) return send(404, 'Not found');
      if (await overCap()) return send(429, 'Monthly AI limit reached for this account');

      const body = await readBody(req);
      const upstream = await fetchImpl(`${access.baseUrl}${req.url.slice(3)}`, {
        method: 'POST',
        headers: {
          'content-type': req.headers['content-type'] || 'application/json',
          authorization: `Bearer ${access.apiKey}`,
          ...(req.headers.accept ? { accept: req.headers.accept } : {}),
        },
        body,
      });

      const type = upstream.headers.get('content-type') || 'application/json';
      res.writeHead(upstream.status, { 'content-type': type });
      let text = '';
      if (upstream.body) {
        for await (const chunk of Readable.fromWeb(upstream.body)) {
          res.write(chunk);
          text += chunk.toString('utf8');
          if (text.length > 4 * MAX_BODY) text = text.slice(-MAX_BODY);
        }
      }
      // Record before finishing the reply, so the next call from this job already sees the spend.
      if (upstream.ok) {
        let u = null;
        if (type.includes('event-stream')) u = usageFromSse(text);
        else { try { u = usageOf(JSON.parse(text)); } catch { u = null; } }
        if (!u) {
          // No usage reported: estimate from size so the cap still holds (~4 chars per token).
          u = { input: Math.ceil(body.length / 4), output: Math.ceil(text.length / 4) };
        }
        // Spend is priced for JobFlow's key only; a user's own key is billed to them by their provider.
        const costMicro = access.keySource === 'jobflow' ? costMicroUsd(config.ai, u.input, u.output) : 0;
        totals.input += u.input;
        totals.output += u.output;
        totals.costMicro += costMicro;
        totals.requests += 1;
        await recordUsage(pool, {
          userId: user.id, keySource: access.keySource, inputTokens: u.input, outputTokens: u.output, costMicro,
        });
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) send(502, `AI provider call failed: ${err.message}`);
      else res.end();
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    token,
    totals,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}
