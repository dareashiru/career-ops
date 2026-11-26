// Small crypto helpers: AES-256-GCM for stored secrets, SHA-256 for tokens.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyBytes(encryptionKey) {
  const key = Buffer.from(encryptionKey || '', 'base64');
  if (key.length !== 32) {
    throw new Error('JOBFLOW_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }
  return key;
}

/** Encrypt a secret. Output: "v1.<iv>.<tag>.<ciphertext>", each part base64url. */
export function encryptSecret(plaintext, encryptionKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(encryptionKey), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptSecret(sealed, encryptionKey) {
  const [version, iv, tag, body] = String(sealed).split('.');
  if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(encryptionKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
