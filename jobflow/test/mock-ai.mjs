// A stand-in OpenAI-compatible provider for tests: answers every chat
// completion with a fixed career-ops-shaped evaluation and reports token usage.
import http from 'node:http';

export const MOCK_USAGE = { prompt_tokens: 12000, completion_tokens: 1500 };

const REPLY = `# Evaluation: Example Co — Staff Engineer

## A) Role summary
A test role.

## B) Match with CV
Strong match.

## G) Posting legitimacy
High confidence.

---SCORE_SUMMARY---
COMPANY: Example Co
ROLE: Staff Engineer
SCORE: 4.2
ARCHETYPE: Platform
LEGITIMACY: High Confidence
---END_SUMMARY---
`;

export function startMockAi({ stream = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls.push({ url: req.url, auth: req.headers.authorization, body });
    const parsed = JSON.parse(body || '{}');
    if (stream || parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: REPLY } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ choices: [], usage: { ...MOCK_USAGE, total_tokens: MOCK_USAGE.prompt_tokens + MOCK_USAGE.completion_tokens } });
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock', object: 'chat.completion', model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
      usage: { ...MOCK_USAGE, total_tokens: MOCK_USAGE.prompt_tokens + MOCK_USAGE.completion_tokens },
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, calls, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) });
    });
  });
}

