import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Seals small secrets (webhook signing secrets) at rest with AES-256-GCM.
 * The key is derived from a master secret in the environment, so a database
 * dump alone doesn't reveal them.
 *
 * Layout: iv (12) | auth tag (16) | ciphertext
 */
function key(master: string): Buffer {
  return createHash('sha256').update(`vexa/sealed-secret/v1:${master}`).digest();
}

export function sealSecret(master: string, plaintext: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(master), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

export function openSecret(master: string, sealed: Uint8Array): string {
  const buf = Buffer.from(sealed);
  const decipher = createDecipheriv('aes-256-gcm', key(master), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
