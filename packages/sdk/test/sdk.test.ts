import { describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode, generateApiKey, handleClaimMessage } from '@vexa/core';
import { Vexa, VexaError } from '../src/index.js';

type Call = { url: string; init: RequestInit };

function mockFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>,
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more mock responses');
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

describe('Vexa client', () => {
  it('infers environment and base URL from the key prefix', () => {
    expect(new Vexa({ apiKey: generateApiKey('live') }).baseUrl).toBe('https://api.vexa.finance');
    const test = new Vexa({ apiKey: generateApiKey('test') });
    expect(test.environment).toBe('test');
    expect(test.baseUrl).toBe('https://sandbox.api.vexa.finance');
    expect(() => new Vexa({ apiKey: 'sk_live_nope' })).toThrow();
  });

  it('sends an idempotency key on create calls and reuses it across retries', async () => {
    const { fetch, calls } = mockFetch([
      new TypeError('network down'),
      { status: 503, body: { error: { code: 'upstream_unavailable', message: 'x' } } },
      { status: 201, body: { id: 'k1', secret: 'vx_live_…' } },
    ]);
    const vexa = new Vexa({ accessToken: 'tok', baseUrl: 'http://api.test', fetch, maxRetries: 3 });
    await vexa.apiKeys.create('bot');

    expect(calls).toHaveLength(3);
    const keys = calls.map((c) => header(c, 'idempotency-key'));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
    expect(header(calls[0]!, 'authorization')).toBe('Bearer tok');
  });

  it('does not retry client errors, and surfaces code and request id', async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 409,
        body: { error: { code: 'handle_taken', message: 'taken', requestId: 'req_1' } },
      },
    ]);
    const vexa = new Vexa({ accessToken: 't', baseUrl: 'http://api.test', fetch });
    const err = await vexa.apiKeys.create('x').catch((e) => e);
    expect(err).toBeInstanceOf(VexaError);
    expect(err).toMatchObject({ status: 409, code: 'handle_taken', requestId: 'req_1' });
    expect(calls).toHaveLength(1);
  });

  it('normalizes handles before resolving', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { handle: 'alice' } }]);
    await new Vexa({ baseUrl: 'http://api.test', fetch }).handles.resolve('@Alice.vexa');
    expect(calls[0]!.url).toBe('http://api.test/v1/handles/alice/resolve');
    expect(header(calls[0]!, 'idempotency-key')).toBeNull();
  });

  it('signs handle claims over the exact message the server verifies', async () => {
    const seed = ed25519.utils.randomSecretKey();
    const solanaAddress = base58Encode(ed25519.getPublicKey(seed));
    const elgamalPubkey = 'AAAA';
    const { fetch, calls } = mockFetch([
      { status: 200, body: { userId: 'u-1' } },
      { status: 201, body: { handle: '@alice.vexa' } },
    ]);
    const vexa = new Vexa({ accessToken: 't', baseUrl: 'http://api.test', fetch });
    await vexa.handles.claim('@alice', {
      solanaAddress,
      elgamalPubkey,
      sign: (m) => base58Encode(ed25519.sign(m, seed)),
    });

    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body.handle).toBe('alice');
    const expected = handleClaimMessage({
      handle: 'alice',
      userId: 'u-1',
      solanaPubkey: solanaAddress,
      elgamalPubkey,
    });
    expect(
      ed25519.verify(base58Decode(body.signature)!, expected, ed25519.getPublicKey(seed)),
    ).toBe(true);
    expect(header(calls[1]!, 'idempotency-key')).toBeTruthy();
  });

  it('adopts the session returned by verifyOtp', async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          accessToken: 'new-token',
          refreshToken: 'r',
          expiresAt: 1,
          user: { id: 'u', email: null },
        },
      },
      { status: 200, body: { userId: 'u' } },
    ]);
    const vexa = new Vexa({ baseUrl: 'http://api.test', fetch });
    await vexa.auth.verifyOtp('a@b.co', '123456');
    expect(header(calls[0]!, 'authorization')).toBeNull();
    await vexa.me();
    expect(header(calls[1]!, 'authorization')).toBe('Bearer new-token');
  });
});
