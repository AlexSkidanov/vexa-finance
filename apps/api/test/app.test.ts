import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateApiKey } from '@vexa/core';
import { MailDeliveryError } from '../src/lib/mailer.js';
import { createLogger } from '../src/logger.js';
import { fakeAuthProvider, sessionToken, signedClaim, testApp } from './helpers.js';

describe('health', () => {
  it('reports status, cluster and environment', async () => {
    const res = await testApp().request('GET', '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      cluster: 'mainnet-beta',
      environment: 'live',
    });
  });

  it('reports readiness', async () => {
    const res = await testApp().request('GET', '/health/ready');
    expect(await res.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });
});

describe('audit signing keys', () => {
  it('publishes the Ed25519 key and a post-quantum ML-DSA-65 key', async () => {
    const res = await testApp().request('GET', '/v1/audit/signing-key');
    const body = (await res.json()) as {
      algorithm: string;
      publicKey: string;
      keys: { algorithm: string; encoding: string; publicKey: string }[];
    };
    expect(body.algorithm).toBe('ed25519');
    expect(body.keys.map((k) => k.algorithm)).toEqual(['ed25519', 'ml-dsa-65']);
    const pq = body.keys[1]!;
    expect(pq.encoding).toBe('base64');
    expect(Buffer.from(pq.publicKey, 'base64')).toHaveLength(1952);
    // Derived, not random: the same secret always gives the same key.
    const again = (await (await testApp().request('GET', '/v1/audit/signing-key')).json()) as {
      keys: { publicKey: string }[];
    };
    expect(again.keys[1]!.publicKey).toBe(pq.publicKey);
  });
});

describe('request ids and errors', () => {
  it('generates a request id and includes it in error bodies', async () => {
    const res = await testApp().request('GET', '/v1/nope');
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^req_/);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'No route for GET /v1/nope', requestId: id },
    });
  });

  it('keeps a well-formed incoming request id', async () => {
    const res = await testApp().request('GET', '/health', {
      headers: { 'x-request-id': 'trace-abc-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('never leaks internals on unexpected errors', async () => {
    const { request } = testApp({
      auth: fakeAuthProvider({
        verifyEmailOtp: async () => {
          throw new Error('db password is hunter2');
        },
      }),
    });
    const res = await request('POST', '/v1/auth/otp/verify', {
      body: { email: 'a@b.co', token: '123456' },
    });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('hunter2');
  });
});

describe('authentication', () => {
  it('rejects anonymous requests to protected routes', async () => {
    const res = await testApp().request('GET', '/v1/me');
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('rejects a test key on a live deployment before any lookup', async () => {
    const res = await testApp().request('GET', '/v1/me', { token: generateApiKey('test') });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('wrong_environment');
  });

  it('rejects an unknown live key', async () => {
    const res = await testApp().request('GET', '/v1/me', { token: generateApiKey('live') });
    expect((await res.json()).error.code).toBe('invalid_api_key');
  });

  it('answers OTP requests identically whether or not sending worked', async () => {
    const failing = testApp({
      auth: fakeAuthProvider({
        sendEmailOtp: async () => {
          throw new Error('rate limited upstream');
        },
      }),
    });
    const ok = await testApp().request('POST', '/v1/auth/otp', { body: { email: 'a@b.co' } });
    const bad = await failing.request('POST', '/v1/auth/otp', { body: { email: 'a@b.co' } });
    expect(ok.status).toBe(202);
    expect(bad.status).toBe(202);
    expect(await ok.json()).toEqual(await bad.json());
  });

  it('tells the user when the mail provider refuses the code email', async () => {
    const { request } = testApp({
      auth: fakeAuthProvider({
        sendEmailOtp: async () => {
          throw new MailDeliveryError('smtp: 550 sender not allowed');
        },
      }),
    });
    const res = await request('POST', '/v1/auth/otp', { body: { email: 'a@b.co' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: 'upstream_unavailable', message: expect.stringContaining("couldn't send") },
    });
  });

  it('exchanges a correct OTP for a session', async () => {
    const { request } = testApp();
    const res = await request('POST', '/v1/auth/otp/verify', {
      body: { email: 'a@b.co', token: '123456' },
    });
    expect(res.status).toBe(200);
    const session = await res.json();
    const me = await request('GET', '/v1/me', { token: session.accessToken });
    expect(me.status).toBe(200);
  });

  it('rate limits OTP sends per IP', async () => {
    const { request } = testApp();
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const res = await request('POST', '/v1/auth/otp', {
        body: { email: 'a@b.co' },
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('handles', () => {
  const user = () => {
    const id = randomUUID();
    return { id, token: sessionToken(id) };
  };

  it('claims a handle and resolves it publicly', async () => {
    const { request } = testApp();
    const alice = user();
    const claim = signedClaim(alice.id, 'alice');

    const res = await request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: randomUUID(),
      body: claim,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      handle: '@alice.vexa',
      solanaPubkey: claim.solanaPubkey,
    });

    for (const spelling of ['alice', '@alice.vexa', 'ALICE']) {
      const resolved = await request('GET', `/v1/handles/${encodeURIComponent(spelling)}/resolve`);
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toEqual({
        handle: 'alice',
        display: '@alice.vexa',
        kind: 'user',
        solanaPubkey: claim.solanaPubkey,
        elgamalPubkey: claim.elgamalPubkey,
      });
    }
  });

  it('requires an idempotency key', async () => {
    const alice = user();
    const res = await testApp().request('POST', '/v1/handles/claim', {
      token: alice.token,
      body: signedClaim(alice.id, 'alice'),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('idempotency_key_missing');
  });

  it('replays a retried claim instead of failing it', async () => {
    const { request } = testApp();
    const alice = user();
    const key = randomUUID();
    const body = signedClaim(alice.id, 'alice');
    const first = await request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: key,
      body,
    });
    const second = await request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: key,
      body,
    });
    expect(second.status).toBe(first.status);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.json()).toEqual(await first.json());
  });

  it('rejects reusing an idempotency key for a different request', async () => {
    const { request } = testApp();
    const alice = user();
    const key = randomUUID();
    await request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: key,
      body: signedClaim(alice.id, 'alice'),
    });
    const res = await request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: key,
      body: signedClaim(alice.id, 'alice2'),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('idempotency_key_reused');
  });

  it('rejects a claim not signed by the Solana key it binds', async () => {
    const alice = user();
    const claim = signedClaim(alice.id, 'alice');
    const forged = { ...claim, solanaPubkey: signedClaim(alice.id, 'alice').solanaPubkey };
    const res = await testApp().request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: randomUUID(),
      body: forged,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_signature');
  });

  it("rejects replaying someone else's signed claim", async () => {
    const alice = user();
    const mallory = user();
    const res = await testApp().request('POST', '/v1/handles/claim', {
      token: mallory.token,
      idempotencyKey: randomUUID(),
      body: signedClaim(alice.id, 'alice'),
    });
    expect((await res.json()).error.code).toBe('invalid_signature');
  });

  it('enforces one handle per user and one owner per handle', async () => {
    const { request } = testApp();
    const alice = user();
    const bob = user();
    await request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: randomUUID(),
      body: signedClaim(alice.id, 'alice'),
    });

    const taken = await request('POST', '/v1/handles/claim', {
      token: bob.token,
      idempotencyKey: randomUUID(),
      body: signedClaim(bob.id, 'alice'),
    });
    expect(taken.status).toBe(409);
    expect((await taken.json()).error.code).toBe('handle_taken');

    const second = await request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: randomUUID(),
      body: signedClaim(alice.id, 'alice-two'),
    });
    expect((await second.json()).error.code).toBe('handle_already_claimed');
  });

  it('refuses reserved handles and hides them from resolution', async () => {
    const { request } = testApp();
    const alice = user();
    const res = await request('POST', '/v1/handles/claim', {
      token: alice.token,
      idempotencyKey: randomUUID(),
      body: signedClaim(alice.id, 'support'),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('reserved');
    expect((await request('GET', '/v1/handles/support/resolve')).status).toBe(404);
  });

  it('404s for unknown handles', async () => {
    expect((await testApp().request('GET', '/v1/handles/nobody/resolve')).status).toBe(404);
  });
});

describe('api keys', () => {
  it('creates a key once, authenticates with it, and revokes it', async () => {
    const { request } = testApp();
    const id = randomUUID();
    const idempotencyKey = randomUUID();

    const created = await request('POST', '/v1/api-keys', {
      token: sessionToken(id),
      idempotencyKey,
      body: { name: 'trading bot' },
    });
    expect(created.status).toBe(201);
    const key = await created.json();
    expect(key.secret).toMatch(/^vx_live_/);
    expect(key.prefix).toBe(key.secret.slice(0, 12));

    // A replay confirms the key but never re-exposes the secret.
    const replay = await request('POST', '/v1/api-keys', {
      token: sessionToken(id),
      idempotencyKey,
      body: { name: 'trading bot' },
    });
    const replayed = await replay.json();
    expect(replayed.id).toBe(key.id);
    expect(replayed.secret).toBeUndefined();

    const me = await request('GET', '/v1/me', { token: key.secret });
    expect(me.status).toBe(200);
    expect((await me.json()).userId).toBe(id);

    expect(
      (await request('DELETE', `/v1/api-keys/${key.id}`, { token: sessionToken(id) })).status,
    ).toBe(204);
    expect((await request('GET', '/v1/me', { token: key.secret })).status).toBe(401);
  });

  it('does not let an API key mint more API keys', async () => {
    const { request } = testApp();
    const id = randomUUID();
    const created = await (
      await request('POST', '/v1/api-keys', {
        token: sessionToken(id),
        idempotencyKey: randomUUID(),
        body: { name: 'a' },
      })
    ).json();
    const res = await request('POST', '/v1/api-keys', {
      token: created.secret,
      idempotencyKey: randomUUID(),
      body: { name: 'b' },
    });
    expect(res.status).toBe(403);
  });

  it("can't revoke someone else's key", async () => {
    const { request } = testApp();
    const owner = randomUUID();
    const key = await (
      await request('POST', '/v1/api-keys', {
        token: sessionToken(owner),
        idempotencyKey: randomUUID(),
        body: { name: 'a' },
      })
    ).json();
    const res = await request('DELETE', `/v1/api-keys/${key.id}`, {
      token: sessionToken(randomUUID()),
    });
    expect(res.status).toBe(404);
  });
});

describe('logging', () => {
  it('redacts amounts, tokens and secrets even if code logs them by mistake', () => {
    const lines: string[] = [];
    const logger = createLogger('info', false, { write: (line: string) => lines.push(line) });
    logger.info(
      {
        amount: '1000000',
        transfer: { amount: 5, memo: 'rent' },
        session: { accessToken: 'eyJhbGciOi', refreshToken: 'r1' },
        key: { secret: 'vx_live_abc', seed: 'deadbeef' },
      },
      'oops',
    );
    const line = lines.join('');
    for (const leaked of ['1000000', '"amount":5', 'eyJhbGciOi', 'vx_live_abc', 'deadbeef']) {
      expect(line).not.toContain(leaked);
    }
    expect(line).toContain('rent');
    expect(line).toContain('[redacted]');
  });
});
