/**
 * Every create endpoint takes an `Idempotency-Key` header. Retrying a request
 * with the same key returns the original response instead of doing the work
 * twice, which matters when "the work" is moving money.
 *
 * A key is tied to a fingerprint of the request. Reusing a key with a
 * different body is a client bug, and the API rejects it rather than guessing.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from './encoding.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_REPLAY_HEADER = 'Idempotent-Replayed';

/** 8–255 printable ASCII characters. UUIDs and ULIDs both fit. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,255}$/;

/** Keys are remembered for 24 hours. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export function isIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * Stable fingerprint of a request: method, path and a canonical JSON body.
 * Object keys are sorted so `{a,b}` and `{b,a}` produce the same hash.
 */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  const canonical = `${method.toUpperCase()} ${path}\n${canonicalJson(body)}`;
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}
