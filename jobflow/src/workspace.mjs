// Opens a user's workspace on this instance: take the lock, download the
// folder, and hand back a handle that can sync it and close it.
//
//   const ws = await openWorkspace(ctx, userId, { kind: 'job' });
//   try { ...run career-ops in ws.dir... } finally { await ws.close(); }
//
// While open, the lease is renewed in the background. sync() uploads what
// changed; close() uploads, releases the lock and deletes the local copy.
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock, releaseLock, renewLock } from './lock.mjs';
import { download, upload } from './sync.mjs';
import { initWorkspace, prepareScratch } from './careerops.mjs';
import { allocateUid, chownTree, lockDown, releaseUid, sandboxEnabled } from './sandbox.mjs';

export class LockBusyError extends Error {
  constructor(userId) {
    super(`Workspace ${userId} is in use elsewhere`);
    this.code = 'LOCK_BUSY';
  }
}

export class LockLostError extends Error {
  constructor(userId) {
    super(`Lost the lock on workspace ${userId}; not uploading`);
    this.code = 'LOCK_LOST';
  }
}

/**
 * @param {{pool, storage, config, log?}} ctx
 * @param {string} userId
 * @param {{kind: 'job'|'web', holder?: string, holderUrl?: string}} opts
 */
export async function openWorkspace(ctx, userId, { kind, holder, holderUrl } = {}) {
  const { pool, storage, config } = ctx;
  const log = ctx.log ?? (() => {});
  const lease = config.lockLeaseSeconds;
  holder ??= `${config.instanceId}:${randomUUID()}`;

  if (!(await acquireLock(pool, userId, holder, { kind, holderUrl, leaseSeconds: lease }))) {
    throw new LockBusyError(userId);
  }

  const wsRoot = join(config.workDir, 'ws');
  const dir = join(wsRoot, `${userId}-${randomUUID().slice(0, 8)}`);
  const sandbox = sandboxEnabled(config);
  let uid;
  let manifest;
  let lost = false;
  let closed = false;
  // Renew at a third of the lease so one slow query never lets it lapse.
  const heartbeat = setInterval(async () => {
    try {
      if (!(await renewLock(pool, userId, holder, lease))) {
        lost = true;
        log(`lock lost for ${userId}`);
      }
    } catch (err) {
      log(`lock renew failed for ${userId}: ${err.message}`);
    }
  }, Math.max(1000, (lease * 1000) / 3));
  heartbeat.unref();

  try {
    await mkdir(dir, { recursive: true });
    // Others may pass through the parent but not list it.
    if (sandbox) {
      await chmod(config.workDir, 0o711);
      await chmod(wsRoot, 0o711);
    }
    manifest = await download(storage, config.storage.prefix, userId, dir);
    if (Object.keys(manifest).length === 0) {
      // First open: fill the folder with upstream's templates, then save it.
      const res = await initWorkspace(config.careerOpsDir, dir);
      if (res.code !== 0) log(`doctor --init-templates exited ${res.code}: ${res.stderr.slice(-500)}`);
      ({ manifest } = await upload(storage, config.storage.prefix, userId, dir, {}));
    }
    await prepareScratch(dir);
    if (sandbox) {
      uid = allocateUid();
      await lockDown(dir, uid);
    }
  } catch (err) {
    if (uid !== undefined) releaseUid(uid);
    clearInterval(heartbeat);
    await releaseLock(pool, userId, holder).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  let syncing = Promise.resolve();
  const ws = {
    userId,
    dir,
    holder,
    /** The uid career-ops processes for this workspace run as (undefined when not sandboxed). */
    uid,
    /** Hand a file or folder JobFlow wrote inside the workspace over to the workspace's uid. */
    async own(path) {
      if (uid !== undefined) await chownTree(path, uid);
    },
    get lost() { return lost; },
    /** Upload changes. Throws LockLostError if another instance took over. */
    sync() {
      // Syncs run one at a time; a failed one does not block the next.
      const run = syncing.catch(() => {}).then(async () => {
        if (lost || !(await renewLock(pool, userId, holder, lease))) {
          lost = true;
          throw new LockLostError(userId);
        }
        const res = await upload(storage, config.storage.prefix, userId, dir, manifest);
        manifest = res.manifest;
        if (res.summary.oversized.length) {
          log(`workspace ${userId}: not uploading ${res.summary.oversized.length} file(s) over the size limit`);
        }
        return res.summary;
      });
      syncing = run;
      return run;
    },
    /** Final upload, release the lock, remove the local copy. Safe to call twice. */
    async close({ upload: doUpload = true } = {}) {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        if (doUpload) await ws.sync();
      } finally {
        if (!lost) await releaseLock(pool, userId, holder).catch(() => {});
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        if (uid !== undefined) releaseUid(uid);
      }
    },
  };
  return ws;
}
