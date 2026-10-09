import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@vexa/core';
import { createLogger } from '../src/logger.js';
import { createMemoryStore } from '../src/store/memory.js';
import {
  deliverDue,
  isPrivateAddress,
  MAX_ATTEMPTS,
  nextAttempt,
} from '../src/workers/webhooks.js';
import { sessionToken, TEST_ENV, testApp } from './helpers.js';

describe('webhook endpoints', () => {
  it('returns the secret once and lets you check a signature with it', async () => {
    const store = createMemoryStore();
    const { request } = testApp({ store });
    const user = randomUUID();
    const key = randomUUID();
    const body = { url: 'https://hooks.example.com/vexa', events: ['transfer.settled'] };

    const created = await (
      await request('POST', '/v1/webhooks', {
        token: sessionToken(user),
        idempotencyKey: key,
        body,
      })
    ).json();
    expect(created.secret).toMatch(/^whsec_/);

    // A retry confirms the endpoint without re-exposing the secret.
    const replay = await (
      await request('POST', '/v1/webhooks', {
        token: sessionToken(user),
        idempotencyKey: key,
        body,
      })
    ).json();
    expect(replay.id).toBe(created.id);
    expect(replay.secret).toBeUndefined();

    const list = await (await request('GET', '/v1/webhooks', { token: sessionToken(user) })).json();
    expect(list.data).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('whsec_');

    const { signWebhookPayload } = await import('@vexa/core');
    const payload = '{"id":"evt_1"}';
    const good = await request('POST', '/v1/webhooks/verify', {
      token: sessionToken(user),
      body: {
        webhookId: created.id,
        payload,
        signature: signWebhookPayload(created.secret, payload),
      },
    });
    expect(await good.json()).toMatchObject({ valid: true });
    const bad = await request('POST', '/v1/webhooks/verify', {
      token: sessionToken(user),
      body: {
        webhookId: created.id,
        payload,
        signature: signWebhookPayload('whsec_wrong', payload),
      },
    });
    expect(await bad.json()).toMatchObject({ valid: false, reason: 'mismatch' });

    expect(
      (await request('DELETE', `/v1/webhooks/${created.id}`, { token: sessionToken(user) })).status,
    ).toBe(204);
    const after = await request('GET', '/v1/webhooks', { token: sessionToken(user) });
    expect((await after.json()).data).toHaveLength(0);
  });

  it('rejects non-https and private endpoints', async () => {
    const { request } = testApp();
    for (const url of [
      'http://hooks.example.com',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest',
    ]) {
      const res = await request('POST', '/v1/webhooks', {
        token: sessionToken(randomUUID()),
        idempotencyKey: randomUUID(),
        body: { url, events: ['deposit.confirmed'] },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('webhook delivery', () => {
  async function setup(resolveTo = ['93.184.216.34']) {
    const store = createMemoryStore();
    const { request } = testApp({ store });
    const user = randomUUID();
    const hook = await (
      await request('POST', '/v1/webhooks', {
        token: sessionToken(user),
        idempotencyKey: randomUUID(),
        body: { url: 'https://hooks.example.com/vexa', events: ['transfer.settled'] },
      })
    ).json();
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const deps = {
      store,
      logger: createLogger('silent'),
      masterSecret: TEST_ENV.WEBHOOK_SIGNING_SECRET,
      resolve: async () => resolveTo,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status });
      }) as unknown as typeof fetch,
    };
    return { store, user, hook, calls, deps, setStatus: (s: number) => (status = s) };
  }

  it('signs deliveries so the receiver can verify them', async () => {
    const { store, user, hook, calls, deps } = await setup();
    await store.events.emit(user, 'transfer.settled', { transferId: 't1' });
    await store.events.emit(user, 'deposit.confirmed', { depositId: 'd1' }); // not subscribed

    expect(await deliverDue(deps)).toBe(1);
    const headers = new Headers(calls[0]!.init.headers);
    const body = calls[0]!.init.body as string;
    expect(JSON.parse(body)).toMatchObject({
      type: 'transfer.settled',
      data: { transferId: 't1' },
    });
    expect(
      verifyWebhookSignature({
        payload: body,
        header: headers.get('vexa-signature')!,
        secret: hook.secret,
      }),
    ).toMatchObject({ valid: true });
    expect(headers.get('vexa-event-id')).toBeTruthy();
    expect(calls[0]!.init.redirect).toBe('manual');

    // Delivered: nothing left to send.
    expect(await deliverDue(deps)).toBe(0);
  });

  it('retries failures with backoff and gives up after the last attempt', async () => {
    const { store, user, calls, deps, setStatus } = await setup();
    setStatus(503);
    await store.events.emit(user, 'transfer.settled', { transferId: 't1' });
    expect(await deliverDue(deps)).toBe(1);
    // Backed off: not due again yet.
    expect(await deliverDue(deps)).toBe(0);
    expect(calls).toHaveLength(1);

    expect(nextAttempt(1, 0)!.getTime()).toBe(30_000);
    expect(nextAttempt(5, 0)!.getTime()).toBe(480_000);
    expect(nextAttempt(9, 0)!.getTime()).toBe(7_680_000); // ~2h 8m before the final attempt
    expect(nextAttempt(MAX_ATTEMPTS)).toBeNull();
  });

  it('never delivers to a hostname that resolves to a private address', async () => {
    const { store, user, calls, deps } = await setup(['10.0.0.7']);
    await store.events.emit(user, 'transfer.settled', { transferId: 't1' });
    await deliverDue(deps);
    expect(calls).toHaveLength(0);
  });

  it('classifies private and public addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
