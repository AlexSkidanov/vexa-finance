/**
 * Webhook signatures.
 *
 * Every delivery carries
 *
 *   Vexa-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *   Vexa-Event-Id:  <event id>
 *
 * Receivers should verify the signature over the raw body, reject timestamps
 * outside a tolerance window (replay protection), and treat Vexa-Event-Id as
 * an idempotency key, since a delivery can be retried.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from './encoding.js';

export const WEBHOOK_SIGNATURE_HEADER = 'Vexa-Signature';
export const WEBHOOK_EVENT_ID_HEADER = 'Vexa-Event-Id';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export const WEBHOOK_EVENT_TYPES = [
  'transfer.settled',
  'deposit.confirmed',
  'withdrawal.sent',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const encoder = new TextEncoder();

function mac(secret: string, timestamp: number, payload: string): string {
  return bytesToHex(
    hmac(sha256, encoder.encode(secret), encoder.encode(`${timestamp}.${payload}`)),
  );
}

export function signWebhookPayload(
  secret: string,
  payload: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${mac(secret, timestamp, payload)}`;
}

export type WebhookVerification =
  | { valid: true; timestamp: number }
  | { valid: false; reason: 'malformed' | 'expired' | 'mismatch' };

/**
 * Verifies a Vexa-Signature header against the raw request body. Accepts a
 * header with several v1 entries (sent while a secret is being rotated).
 */
export function verifyWebhookSignature(input: {
  payload: string;
  header: string;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}): WebhookVerification {
  const parts = input.header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isInteger(t) || signatures.length === 0) return { valid: false, reason: 'malformed' };

  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
    return { valid: false, reason: 'expired' };
  }
  const expected = mac(input.secret, t, input.payload);
  return signatures.some((s) => constantTimeEqual(s, expected))
    ? { valid: true, timestamp: t }
    : { valid: false, reason: 'mismatch' };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
