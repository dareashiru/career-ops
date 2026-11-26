// Server-rendered JobFlow pages. This is the start of JobFlow's own front end;
// screens move here from the upstream web app one at a time.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#2f5d50;--accent-ink:#fff;--bad:#a33;--good:#2f6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecece8;--muted:#a3a39c;--line:#33332f;--accent:#7fb8a6;--accent-ink:#10201b;--bad:#e78;--good:#8c8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
header b{font-size:17px;margin-right:auto}header a{color:var(--ink);text-decoration:none}header form{margin:0}
main{max-width:860px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
h1{font-size:22px;margin:4px 0 16px}h2{font-size:17px;margin:0 0 10px}
p.muted,.muted{color:var(--muted)}
input,textarea,select{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
textarea{min-height:120px}label{display:block;margin:10px 0 4px;font-weight:600}
button,.btn{display:inline-block;padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:inherit;cursor:pointer;text-decoration:none}
button.secondary,.btn.secondary{background:transparent;color:var(--ink);border-color:var(--line)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
.wrap{overflow-x:auto}.ok{color:var(--good)}.bad{color:var(--bad)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);padding:10px;border-radius:8px;font-size:13px;max-height:480px;overflow:auto}
.flash{padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);margin-bottom:16px}
.meter{height:8px;background:var(--line);border-radius:4px;overflow:hidden}.meter>div{height:100%;background:var(--accent)}
`;

export function layout({ title, user, body, flash = '', refreshSeconds = 0 }) {
  const nav = user ? `
    <a href="/jobflow">Home</a>
    <a href="/" target="_blank" rel="noopener">Open career-ops</a>
    <a href="/jobflow/settings">Settings</a>
    ${user.is_admin ? '<a href="/jobflow/admin">Admin</a>' : ''}
    <form method="post" action="/jobflow/logout"><button class="secondary" type="submit">Sign out</button></form>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}
<title>${esc(title)} · JobFlow</title><style>${STYLE}</style></head>
<body><header><b>JobFlow</b>${nav}</header><main>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${body}</main></body></html>`;
}

export function loginPage({ googleEnabled, error }) {
  return layout({
    title: 'Sign in',
    flash: error,
    body: `<div class="card"><h1>Sign in to JobFlow</h1>
<p class="muted">JobFlow is invite-only during the beta.</p>
${googleEnabled ? '<p><a class="btn" href="/jobflow/auth/google">Sign in with Google</a></p>' : ''}
<p class="muted">Got an invite link? Open it to sign in. Ask whoever invited you for a new one if it has expired.</p></div>`,
  });
}

export function invitePage({ token }) {
  return layout({
    title: 'Accept invite',
    body: `<div class="card"><h1>Welcome to JobFlow</h1>
<p>Your job search workspace is ready to be created.</p>
<form method="post" action="/jobflow/invite/${esc(token)}"><button type="submit">Sign in</button></form></div>`,
  });
}

function money(micro) {
  return `$${(micro / 1e6).toFixed(2)}`;
}

function jobLabel(job) {
  if (job.type === 'scan') return 'Scan job boards';
  const target = job.payload?.url || (job.payload?.text ? 'pasted description' : '');
  return `Score ${target ? esc(target).slice(0, 80) : 'a job'}`;
}

function statusCell(job) {
  const cls = job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : 'muted';
  const msg = job.result?.message ? ` · ${esc(job.result.message)}` : '';
  return `<span class="${cls}">${esc(job.status)}</span>${msg}`;
}

export function dashboardPage({ user, jobs, usage, capMicro, hasOwnKey, flash }) {
  const spent = usage.jobflow.costMicro;
  const pct = capMicro > 0 ? Math.min(100, Math.round((spent / capMicro) * 100)) : 100;
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  return layout({
    title: 'Home',
    user,
    flash,
    refreshSeconds: active ? 10 : 0,
    body: `<h1>Hi${user.name ? ` ${esc(user.name.split(' ')[0])}` : ''}</h1>
<div class="card"><h2>Your career-ops workspace</h2>
<p class="muted">Your CV, profile, tracker and reports. The first open takes a few seconds while your files load.</p>
<p><a class="btn" href="/" target="_blank" rel="noopener">Open career-ops</a></p></div>

<div class="card"><h2>Score a job</h2>
<form method="post" action="/jobflow/score">
<label for="url">Job link</label><input id="url" name="url" type="url" placeholder="https://jobs.example.com/...">
<p class="muted">Best is the employer's own link. For a LinkedIn or other job-board link, add the company and job title so JobFlow can find the role on the employer's site.</p>
<label for="company">Company</label><input id="company" name="company" maxlength="200">
<label for="title">Job title</label><input id="title" name="title" maxlength="300">
<label for="text">Or paste the job description</label><textarea id="text" name="text"></textarea>
<p><button type="submit">Score it</button></p></form>
<p class="muted">Scoring reads your CV and profile, writes a report, and adds the job to your tracker as Evaluated. Nothing is ever submitted for you.</p></div>

<div class="card"><h2>Scan job boards</h2>
<p class="muted">Checks the companies in your portals list for new openings${user.auto_scan ? ' (also runs automatically a few times a day)' : ''}.
${user.last_scan_at ? `Last scan: ${esc(new Date(user.last_scan_at).toUTCString())}.` : 'Not scanned yet.'}</p>
<form method="post" action="/jobflow/scan"><button type="submit">Scan now</button></form></div>

<div class="card"><h2>AI use this month</h2>
${hasOwnKey ? '<p>Scoring uses your own AI key, so JobFlow does not limit it.</p>' : `
<div class="meter"><div style="width:${pct}%"></div></div>
<p>${money(spent)} of your ${money(capMicro)} monthly limit used.</p>`}
<p class="muted">${usage.jobflow.requests + usage.user.requests} AI calls, ${(usage.jobflow.inputTokens + usage.user.inputTokens).toLocaleString('en-US')} tokens in, ${(usage.jobflow.outputTokens + usage.user.outputTokens).toLocaleString('en-US')} out.</p></div>

<div class="card"><h2>Recent jobs</h2>
${jobs.length ? `<div class="wrap"><table><tr><th>What</th><th>Status</th><th>When</th></tr>
${jobs.map((j) => `<tr><td><a href="/jobflow/jobs/${j.id}">${jobLabel(j)}</a>${j.result?.score != null ? ` · <b>${esc(j.result.score)}/5</b>` : ''}</td>
<td>${statusCell(j)}</td><td class="muted">${esc(new Date(j.created_at).toISOString().slice(0, 16).replace('T', ' '))} UTC</td></tr>`).join('')}
</table></div>` : '<p class="muted">Nothing yet.</p>'}</div>`,
  });
}

export function jobPage({ user, job }) {
  const active = job.status === 'queued' || job.status === 'running';
  return layout({
    title: `Job ${job.id}`,
    user,
    refreshSeconds: active ? 5 : 0,
    body: `<p><a href="/jobflow">← Home</a></p><div class="card"><h1>${jobLabel(job)}</h1>
<p>Status: ${statusCell(job)}</p>
${job.result?.score != null ? `<p>Score: <b>${esc(job.result.score)}/5</b>${job.result.report ? ` · report saved as <code>${esc(job.result.report)}</code>` : ''}</p>` : ''}
${job.result?.summary ? `<pre>${esc(job.result.summary)}</pre>` : ''}
${Array.isArray(job.result?.near) && job.result.near.length ? `<p>Closest roles on the employer's site:</p><ul>${job.result.near.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
${job.log ? `<details><summary>Log</summary><pre>${esc(job.log)}</pre></details>` : ''}</div>`,
  });
}

export function settingsPage({ user, ownKey, flash, defaultModel }) {
  return layout({
    title: 'Settings',
    user,
    flash,
    body: `<h1>Settings</h1>
<div class="card"><h2>Your own AI key (optional)</h2>
<p class="muted">By default JobFlow pays for scoring, up to your monthly limit. Add a key from any OpenAI-compatible provider to use your own account instead, with no JobFlow limit. The key is stored encrypted and used only for your jobs.</p>
${ownKey ? `<p>Using <b>${esc(ownKey.model)}</b> at <code>${esc(ownKey.base_url)}</code>.</p>
<form method="post" action="/jobflow/settings/ai-key/delete"><button class="secondary" type="submit">Remove my key</button></form>` : `
<form method="post" action="/jobflow/settings/ai-key">
<label for="base_url">API base URL</label><input id="base_url" name="base_url" type="url" required placeholder="https://api.openai.com/v1">
<label for="model">Model</label><input id="model" name="model" required placeholder="${esc(defaultModel || 'model id')}">
<label for="api_key">API key</label><input id="api_key" name="api_key" type="password" required autocomplete="off">
<p><button type="submit">Save key</button></p></form>`}</div>

<div class="card"><h2>Scheduled scans</h2>
<form method="post" action="/jobflow/settings/auto-scan" class="row">
<span>Automatic scans are <b>${user.auto_scan ? 'on' : 'off'}</b>.</span>
<input type="hidden" name="auto_scan" value="${user.auto_scan ? 'off' : 'on'}">
<button class="secondary" type="submit">Turn ${user.auto_scan ? 'off' : 'on'}</button></form></div>

<div class="card"><h2>Your files</h2>
<p class="muted">Download everything in your workspace, or bring in a career-ops folder you already use on your computer (a .tar.gz of it). Imported files replace files with the same name.</p>
<p class="row"><a class="btn secondary" href="/jobflow/export">Download my workspace</a></p>
<label for="import">Import a .tar.gz</label><input id="import" type="file" accept=".tar.gz,.tgz,application/gzip">
<p><button type="button" id="import-btn">Import</button> <span id="import-status" class="muted"></span></p>
<script>
document.getElementById('import-btn').addEventListener('click', async () => {
  const f = document.getElementById('import').files[0];
  const status = document.getElementById('import-status');
  if (!f) { status.textContent = 'Choose a file first.'; return; }
  status.textContent = 'Importing…';
  const res = await fetch('/jobflow/import', { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: f });
  status.textContent = (await res.json().catch(() => ({}))).message || (res.ok ? 'Done.' : 'Import failed.');
});
</script></div>`,
  });
}

export function adminPage({ user, users, invites, newInviteUrl, flash, defaultCapUsd }) {
  return layout({
    title: 'Admin',
    user,
    flash,
    body: `<h1>Admin</h1>
<div class="card"><h2>Invite someone</h2>
<form method="post" action="/jobflow/admin/invite" class="row">
<input name="email" type="email" required placeholder="friend@example.com" style="flex:1;min-width:200px">
<button type="submit">Create invite link</button></form>
${newInviteUrl ? `<p>Send this link to them (it works once):</p><pre>${esc(newInviteUrl)}</pre>` : ''}
${invites.length ? `<p class="muted">Open invites: ${invites.map((i) => esc(i.email)).join(', ')}</p>` : ''}</div>

<div class="card"><h2>People</h2><div class="wrap"><table>
<tr><th>Email</th><th>AI this month</th><th>Monthly limit (USD)</th><th></th></tr>
${users.map((u) => `<tr><td>${esc(u.email)}${u.is_admin ? ' · admin' : ''}${u.status !== 'active' ? ' · <span class="bad">disabled</span>' : ''}</td>
<td>$${(Number(u.spent_micro) / 1e6).toFixed(2)}</td>
<td><form method="post" action="/jobflow/admin/users/${u.id}" class="row">
<input name="cap_usd" inputmode="decimal" style="width:90px" value="${u.monthly_ai_cap_cents == null ? '' : (u.monthly_ai_cap_cents / 100).toFixed(2)}" placeholder="${esc(defaultCapUsd)}">
<select name="status" style="width:110px"><option value="active"${u.status === 'active' ? ' selected' : ''}>active</option><option value="disabled"${u.status !== 'active' ? ' selected' : ''}>disabled</option></select>
<button class="secondary" type="submit">Save</button></form></td></tr>`).join('')}
</table></div><p class="muted">An empty limit uses the default ($${esc(defaultCapUsd)}).</p></div>`,
  });
}

export function messagePage({ user, title, message, refreshSeconds = 0, status }) {
  return layout({
    title,
    user,
    refreshSeconds,
    body: `<div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p>${status ? `<p class="muted">${esc(status)}</p>` : ''}</div>`,
  });
}

/** Shown on the first visit to "/" while the user's web app starts. */
export function openingPage({ user }) {
  return layout({
    title: 'Opening your workspace',
    user,
    body: `<div class="card"><h1>Opening your workspace…</h1>
<p class="muted">Loading your files and starting career-ops. This usually takes under a minute.</p>
<p id="msg" class="muted"></p></div>
<script>
(async () => {
  const msg = document.getElementById('msg');
  for (let i = 0; i < 40; i++) {
    const res = await fetch('/jobflow/open', { method: 'POST' }).catch(() => null);
    if (res && res.ok) { location.reload(); return; }
    const body = res ? await res.json().catch(() => ({})) : {};
    msg.textContent = body.message || 'Still working…';
    await new Promise((r) => setTimeout(r, 5000));
  }
  msg.textContent = 'This is taking longer than usual. Try again in a minute.';
})();
</script>`,
  });
}
