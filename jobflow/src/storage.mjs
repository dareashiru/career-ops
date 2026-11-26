// Object storage for workspaces. Two drivers with the same four calls:
//   s3 — S3 or Cloudflare R2 (production)
//   fs — a local folder that stands in for the bucket (development and tests)
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export function createStorage(cfg) {
  if (cfg.driver === 's3') return createS3Storage(cfg);
  if (cfg.driver === 'fs') return createFsStorage(cfg);
  throw new Error(`Unknown STORAGE_DRIVER "${cfg.driver}" (use s3 or fs)`);
}

function assertKey(key) {
  if (!key || key.startsWith('/') || key.split('/').some((p) => p === '..' || p === '')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

function createFsStorage({ fsRoot }) {
  const pathOf = (key) => {
    assertKey(key);
    return join(fsRoot, ...key.split('/'));
  };
  return {
    async list(prefix) {
      const base = join(fsRoot, ...prefix.split('/').filter(Boolean));
      const out = [];
      async function walk(dir) {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile()) out.push({ key: relative(fsRoot, full).split(sep).join('/'), size: (await stat(full)).size });
        }
      }
      await walk(base);
      return out;
    },
    async get(key) { return readFile(pathOf(key)); },
    async put(key, body) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    async delete(key) { await rm(pathOf(key), { force: true }); },
  };
}

function createS3Storage({ bucket, region, endpoint, accessKeyId, secretAccessKey }) {
  if (!bucket) throw new Error('S3_BUCKET is not set');
  let clientPromise;
  const sdk = () => import('@aws-sdk/client-s3');
  const client = () => {
    clientPromise ??= sdk().then(({ S3Client }) => new S3Client({
      region,
      endpoint,
      forcePathStyle: Boolean(endpoint),
      credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
    }));
    return clientPromise;
  };
  return {
    async list(prefix) {
      const { ListObjectsV2Command } = await sdk();
      const s3 = await client();
      const out = [];
      let token;
      do {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of res.Contents ?? []) out.push({ key: o.Key, size: o.Size });
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key) {
      assertKey(key);
      const { GetObjectCommand } = await sdk();
      const res = await (await client()).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body.transformToByteArray());
    },
    async put(key, body) {
      assertKey(key);
      const { PutObjectCommand } = await sdk();
      await (await client()).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    },
    async delete(key) {
      assertKey(key);
      const { DeleteObjectCommand } = await sdk();
      await (await client()).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
