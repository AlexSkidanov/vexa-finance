import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from '../src/webhooks.js';
import { CreateWebhookRequest } from '../src/schemas.js';

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'transfer.settled' });

  it('verifies what it signs', () => {
    const header = signWebhookPayload(secret, payload, 1_800_000_000);
    expect(verifyWebhookSignature({ payload, header, secret, now: 1_800_000_010 })).toEqual({
      valid: true,
      timestamp: 1_800_000_000,
    });
  });

  it('rejects tampered payloads, wrong secrets and replays', () => {
    const header = signWebhookPayload(secret, payload, 1_800_000_000);
    const now = 1_800_000_000;
    expect(verifyWebhookSignature({ payload: payload + ' ', header, secret, now }).valid).toBe(
      false,
    );
    expect(verifyWebhookSignature({ payload, header, secret: 'other', now }).valid).toBe(false);
    expect(verifyWebhookSignature({ payload, header, secret, now: now + 301 })).toEqual({
      valid: false,
      reason: 'expired',
    });
    expect(verifyWebhookSignature({ payload, header: 'garbage', secret, now })).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('accepts any of several signatures during secret rotation', () => {
    const t = 1_800_000_000;
    const a = signWebhookPayload('old', payload, t).split(',')[1];
    const b = signWebhookPayload(secret, payload, t).split(',')[1];
    expect(
      verifyWebhookSignature({ payload, header: `t=${t},${a},${b}`, secret, now: t }).valid,
    ).toBe(true);
  });

  it('only delivers to public https endpoints', () => {
    const ok = (url: string) =>
      CreateWebhookRequest.safeParse({ url, events: ['transfer.settled'] }).success;
    expect(ok('https://hooks.example.com/vexa')).toBe(true);
    expect(ok('http://hooks.example.com/vexa')).toBe(false);
    expect(ok('https://localhost/x')).toBe(false);
    expect(ok('https://127.0.0.1/x')).toBe(false);
    expect(ok('https://10.0.0.5/x')).toBe(false);
    expect(ok('https://192.168.1.1/x')).toBe(false);
    expect(ok('https://169.254.169.254/latest/meta-data')).toBe(false);
  });
});
