// Per-workspace Unix users.
//
// When JobFlow runs as root (as it does in its container), each open
// workspace gets its own uid from 20000-29999. Its folder is chowned to that
// uid with mode 700, and every career-ops process for that user (jobs and the
// web app) runs as that uid. A process for one user then cannot read another
// user's folder on the same instance, even through a bug in career-ops.
import { chmod, chown, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const FIRST_UID = 20000;
const LAST_UID = 29999;
const inUse = new Set();

export function sandboxEnabled(config) {
  if (config.sandboxUids === 'off') return false;
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  if (config.sandboxUids === 'on' && !root) throw new Error('SANDBOX_UIDS=on needs JobFlow to run as root');
  return root;
}

export function allocateUid() {
  for (let uid = FIRST_UID; uid <= LAST_UID; uid++) {
    if (!inUse.has(uid)) {
      inUse.add(uid);
      return uid;
    }
  }
  throw new Error('No free sandbox uid on this instance');
}

export function releaseUid(uid) {
  inUse.delete(uid);
}

/** chown -R, without following symlinks. */
export async function chownTree(path, uid) {
  const st = await lstat(path);
  if (st.isSymbolicLink()) return;
  await chown(path, uid, uid);
  if (st.isDirectory()) {
    for (const name of await readdir(path)) await chownTree(join(path, name), uid);
  }
}

export async function lockDown(dir, uid) {
  await chownTree(dir, uid);
  await chmod(dir, 0o700);
}
