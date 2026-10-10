/**
 * View keys: time-scoped, revocable read access for an auditor.
 *
 * A view key is `vxview_<id>.<access secret>.<decryption key>`:
 *
 * - the **access secret** lets its holder fetch the export from the API,
 *   which stores only its SHA-256;
 * - the **decryption key** never leaves the owner's and auditor's devices.
 *   The owner's device decrypts each transfer in scope and re-encrypts its
 *   amount and memo to this key (AES-256-GCM); those records are all the API
 *   stores and serves.
 *
 * Both halves derive from the owner's passkey (`UserKeys.viewRoot`) and the
 * view key's id, so the owner can re-derive a key to add transfers made after
 * it was issued (`vexa.viewKeys.sync`). Revoking deletes the records.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { base58DecodeStrict, base58Encode, base64Decode } from '../encoding.js';

const SALT = new TextEncoder().encode('vexa.finance');
const info = (s: string) => new TextEncoder().encode(s);
const PREFIX = 'vxview_';

export interface ViewKey {
  id: string;
  accessSecret: Uint8Array;
  decryptionKey: Uint8Array;
}

export function deriveViewKey(viewRoot: Uint8Array, id: string): ViewKey {
  return {
    id,
    accessSecret: hkdf(sha256, viewRoot, SALT, info(`vexa/view-key/v1/${id}/access`), 32),
    decryptionKey: hkdf(sha256, viewRoot, SALT, info(`vexa/view-key/v1/${id}/decrypt`), 32),
  };
}

export function encodeViewKey(key: ViewKey): string {
  return `${PREFIX}${key.id}.${base58Encode(key.accessSecret)}.${base58Encode(key.decryptionKey)}`;
}

export function decodeViewKey(s: string): ViewKey {
  if (!s.startsWith(PREFIX)) throw new Error('not a Vexa view key');
  const [id, access, decrypt] = s.slice(PREFIX.length).split('.');
  if (!id || !access || !decrypt) throw new Error('malformed view key');
  return {
    id,
    accessSecret: base58DecodeStrict(access, 'view key'),
    decryptionKey: base58DecodeStrict(decrypt, 'view key'),
  };
}

/** What the API stores to authorize exports: hex SHA-256 of the access secret. */
export function viewKeyAccessHash(accessSecret: Uint8Array): string {
  return bytesToHex(sha256(accessSecret));
}

/** The `viewKey` query parameter for GET /v1/audit/export: id and access secret only. */
export function viewKeyAccessToken(key: ViewKey): string {
  return `${key.id}.${base58Encode(key.accessSecret)}`;
}

export interface ViewRecord {
  /** USDC base units. */
  amount: bigint;
  memo: string | null;
}

const recordKey = (decryptionKey: Uint8Array) =>
  hkdf(sha256, decryptionKey, SALT, info('vexa/view-record/v1'), 32);

/** nonce (12) ‖ AES-256-GCM(amount, memo), bound to the transfer id. */
export function encryptViewRecord(
  decryptionKey: Uint8Array,
  transferId: string,
  record: ViewRecord,
): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ amount: record.amount.toString(), memo: record.memo }),
  );
  const sealed = gcm(recordKey(decryptionKey), nonce, info(transferId)).encrypt(plaintext);
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce);
  out.set(sealed, 12);
  return out;
}

export function decryptViewRecord(
  decryptionKey: Uint8Array,
  transferId: string,
  sealed: Uint8Array,
): ViewRecord {
  const plaintext = gcm(recordKey(decryptionKey), sealed.subarray(0, 12), info(transferId)).decrypt(
    sealed.subarray(12),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
    amount: string;
    memo: string | null;
  };
  return { amount: BigInt(parsed.amount), memo: parsed.memo };
}

/** Checks the API's Ed25519 signature on an audit export (base58 signature and key). */
export function verifyAuditExport(csv: string, signature: string, publicKey: string): boolean {
  try {
    return ed25519.verify(
      base58DecodeStrict(signature, 'signature'),
      new TextEncoder().encode(csv),
      base58DecodeStrict(publicKey, 'public key'),
    );
  } catch {
    return false;
  }
}

/**
 * Checks the API's post-quantum ML-DSA-65 (FIPS 204) signature on an audit
 * export: base64 signature and public key, signed over the exact CSV bytes with
 * an empty context string. An auditor who keeps the export can still trust it
 * after a quantum computer can forge Ed25519.
 */
export function verifyAuditExportMlDsa(csv: string, signature: string, publicKey: string): boolean {
  const sig = base64Decode(signature);
  const key = base64Decode(publicKey);
  if (!sig || !key || sig.length !== 3309 || key.length !== 1952) return false;
  try {
    return ml_dsa65.verify(sig, new TextEncoder().encode(csv), key);
  } catch {
    return false;
  }
}
