/**
 * Delivers queued webhook events.
 *
 * Every couple of seconds it claims due deliveries (with a lease, so a
 * crashed worker's deliveries are retried), signs and POSTs each one, and
 * records the outcome. Failures back off exponentially from 30 seconds,
 * doubling each time, so the 10 attempts span about 4 hours 15 minutes; after
 * the last one a delivery is parked as dead.
 *
 * Outbound requests are a classic SSRF vector, so every delivery resolves the
 * endpoint's hostname and refuses private, loopback and link-local addresses,
 * never follows redirects, and times out after 10 seconds.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { signWebhookPayload, WEBHOOK_EVENT_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from '@vexa/core';
import type { Logger } from '../logger.js';
import { openSecret } from '../lib/secrets.js';
import type { DueDelivery, Store } from '../store/types.js';

export const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;

export function nextAttempt(attempt: number, now = Date.now()): Date | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  return new Date(now + Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
}

/** True for addresses a webhook must never reach. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast and reserved
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80')
  );
}

export interface WebhookWorkerDeps {
  store: Store;
  logger: Logger;
  masterSecret: string;
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
}

async function defaultResolve(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/** Delivers one batch. Exposed for tests; the worker calls it on a timer. */
export async function deliverDue(deps: WebhookWorkerDeps, limit = 20): Promise<number> {
  const due = await deps.store.webhooks.claimDue(limit, 60);
  await Promise.all(due.map((d) => deliver(deps, d)));
  return due.length;
}

async function deliver(deps: WebhookWorkerDeps, d: DueDelivery): Promise<void> {
  const log = deps.logger.child({ deliveryId: d.id, eventId: d.eventId, attempt: d.attempt });
  const fail = async (status: number | null, reason: string) => {
    const next = nextAttempt(d.attempt);
    await deps.store.webhooks.markFailed(d.id, status, next);
    log.warn({ status, reason, dead: next === null }, 'webhook delivery failed');
  };

  try {
    const url = new URL(d.url);
    const addresses = await (deps.resolve ?? defaultResolve)(url.hostname.replace(/^\[|\]$/g, ''));
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      // Not retried: a private destination is a configuration problem, not a blip.
      await deps.store.webhooks.markFailed(d.id, null, null);
      log.warn({ host: url.hostname }, 'webhook destination resolves to a private address');
      return;
    }

    const body = JSON.stringify(d.payload);
    const secret = openSecret(deps.masterSecret, d.secretEncrypted);
    const res = await (deps.fetch ?? fetch)(d.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Vexa-Webhooks/1',
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(secret, body),
        [WEBHOOK_EVENT_ID_HEADER]: d.eventId,
      },
      body,
    });
    if (res.status >= 200 && res.status < 300) {
      await deps.store.webhooks.markDelivered(d.id, res.status);
      log.info({ status: res.status }, 'webhook delivered');
    } else {
      await fail(res.status, `HTTP ${res.status}`);
    }
  } catch (err) {
    await fail(null, err instanceof Error ? err.message : String(err));
  }
}

export function startWebhookWorker(deps: WebhookWorkerDeps, intervalMs = 2000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await deliverDue(deps);
    } catch (err) {
      deps.logger.error({ err }, 'webhook worker tick failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
