/**
 * API keys look like `vx_live_<32 random bytes, base58>` or `vx_test_...`.
 *
 * The prefix tells both the server and the SDK which environment a key belongs
 * to, so the SDK can pick the right base URL and the server can refuse a test
 * key on a live deployment before touching the database.
 *
 * Only a keyed hash of the key is stored. The server peppers it with
 * API_KEY_ENCRYPTION_KEY, so a leaked database dump can't be brute-forced
 * offline without that secret too.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Decode, base58Encode, bytesToHex, hexToBytes } from './encoding.js';

export type ApiEnvironment = 'live' | 'test';

export const API_KEY_PREFIX: Record<ApiEnvironment, string> = {
  live: 'vx_live_',
  test: 'vx_test_',
};

const API_KEY_PATTERN = /^vx_(live|test)_([1-9A-HJ-NP-Za-km-z]{40,50})$/;

/** Returns the environment for a well-formed key, or null. */
export function apiKeyEnvironment(key: string): ApiEnvironment | null {
  const m = API_KEY_PATTERN.exec(key);
  if (!m) return null;
  return base58Decode(m[2]!)?.length === 32 ? (m[1] as ApiEnvironment) : null;
}

export function isApiKey(value: string): boolean {
  return apiKeyEnvironment(value) !== null;
}

export function generateApiKey(environment: ApiEnvironment): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return API_KEY_PREFIX[environment] + base58Encode(bytes);
}

/** HMAC-SHA256(pepper, key) as hex. `pepperHex` is API_KEY_ENCRYPTION_KEY. */
export function hashApiKey(key: string, pepperHex: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(pepperHex), new TextEncoder().encode(key)));
}

/**
 * The part of a key that's safe to show in a dashboard so people can tell
 * their keys apart: `vx_live_4Hq2…`.
 */
export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, 12);
}
