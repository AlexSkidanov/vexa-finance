import { describe, expect, it } from 'vitest';
import { isIdempotencyKey, requestFingerprint } from '../src/idempotency.js';

describe('idempotency', () => {
  it('fingerprints ignore key order but not values', () => {
    const a = requestFingerprint('post', '/v1/x', { a: 1, b: { c: 2, d: 3 } });
    const b = requestFingerprint('POST', '/v1/x', { b: { d: 3, c: 2 }, a: 1 });
    const c = requestFingerprint('POST', '/v1/x', { a: 2, b: { c: 2, d: 3 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('accepts UUIDs and rejects short or whitespace keys', () => {
    expect(isIdempotencyKey(crypto.randomUUID())).toBe(true);
    expect(isIdempotencyKey('short')).toBe(false);
    expect(isIdempotencyKey('has spaces in it')).toBe(false);
  });
});
