// Moves one user's workspace between the bucket and a local folder.
//
// download() writes every object under workspaces/<user-id>/ to the folder and
// returns a manifest {relativePath: sha256}. upload() compares the folder with
// that manifest and sends only what changed: new and edited files are put,
// deleted files are removed from the bucket. Bucket versioning keeps the old
// copies, so a bad upload can be rolled back per file.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Never synced: dependencies, VCS data, caches and our own scratch files.
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.next', '.jobflow-tmp']);
const SKIP_FILES = new Set(['.DS_Store']);
// Upstream lock and reservation files belong to one run on one machine.
const SKIP_PATTERNS = [/\.lock$/, /\.lockdir(\/|$)/, /(^|\/)\.reserve-/];
// A workspace is Markdown, YAML and a few PDFs. Refuse anything absurd.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function userPrefix(prefix, userId) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error(`Bad user id: ${userId}`);
  return `${prefix}${userId}/`;
}

const hash = (buf) => createHash('sha256').update(buf).digest('hex');

function skipped(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  if (SKIP_FILES.has(parts.at(-1))) return true;
  return SKIP_PATTERNS.some((re) => re.test(rel));
}

/** Resolve a bucket-relative path inside dir, refusing anything that escapes it. */
function safeJoin(dir, rel) {
  const full = resolve(dir, ...rel.split('/'));
  const back = relative(dir, full);
  if (!back || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error(`Refusing path outside the workspace: ${rel}`);
  }
  return full;
}

export async function download(storage, prefix, userId, dir) {
  const base = userPrefix(prefix, userId);
  const manifest = {};
  await mkdir(dir, { recursive: true });
  for (const obj of await storage.list(base)) {
    const rel = obj.key.slice(base.length);
    if (!rel || rel.endsWith('/') || skipped(rel)) continue;
    const body = await storage.get(obj.key);
    const full = safeJoin(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
    manifest[rel] = hash(body);
  }
  return manifest;
}

export async function scan(dir) {
  const files = {};
  async function walk(current) {
    for (const e of await readdir(current, { withFileTypes: true })) {
      const full = join(current, e.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (skipped(rel)) continue;
      const st = await lstat(full);
      if (st.isSymbolicLink()) continue; // never follow links out of the workspace
      if (st.isDirectory()) await walk(full);
      else if (st.isFile() && st.size <= MAX_FILE_BYTES) files[rel] = full;
    }
  }
  await walk(dir);
  return files;
}

/** Upload what changed since `manifest`. Returns the new manifest and a summary. */
export async function upload(storage, prefix, userId, dir, manifest) {
  const base = userPrefix(prefix, userId);
  const next = {};
  const summary = { put: 0, deleted: 0 };
  const files = await scan(dir);
  for (const [rel, full] of Object.entries(files)) {
    const body = await readFile(full);
    const h = hash(body);
    next[rel] = h;
    if (manifest[rel] !== h) {
      await storage.put(base + rel, body);
      summary.put++;
    }
  }
  for (const rel of Object.keys(manifest)) {
    if (!(rel in next)) {
      await storage.delete(base + rel);
      summary.deleted++;
    }
  }
  return { manifest: next, summary };
}

export function changed(summary) {
  return summary.put + summary.deleted > 0;
}
