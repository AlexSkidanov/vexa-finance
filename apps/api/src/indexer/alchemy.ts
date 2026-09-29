/**
 * Alchemy address-activity webhooks for Solana.
 *
 * Alchemy POSTs `{ webhookId, id, type: 'ADDRESS_ACTIVITY', event: { network,
 * slot, transaction: [...] } }`, each transaction in a snake_case,
 * Geyser-style shape:
 *
 *   { signature, transaction: [{ signatures, message: [{ account_keys,
 *     instructions: [{ program_id_index, data (base58), ... }], ... }] }],
 *     meta: [{ err?, fee, ... }], index, is_vote }
 *
 * Verified against a real delivery. The signature header is
 * `x-alchemy-signature`: hex HMAC-SHA256 of the raw body under the webhook's
 * signing key.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { base58Decode } from '@vexa/core';

export function verifyAlchemySignature(
  rawBody: string,
  header: string | undefined,
  signingKey: string,
): boolean {
  if (!header || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac('sha256', signingKey).update(rawBody, 'utf8').digest();
  return timingSafeEqual(expected, Buffer.from(header, 'hex'));
}

export interface ChainTransaction {
  signature: string;
  accountKeys: string[];
  instructions: { program: string; data: Uint8Array }[];
  failed: boolean;
}

type Json = Record<string, unknown>;
const first = (v: unknown): Json | undefined =>
  Array.isArray(v) ? (v[0] as Json) : (v as Json | undefined);

/** The transactions in a delivery. Malformed entries are skipped, not fatal. */
export function transactionsOf(payload: unknown): Json[] {
  const event = (payload as Json | undefined)?.event as Json | undefined;
  const list = event?.transaction;
  return Array.isArray(list) ? (list as Json[]) : [];
}

export function parseTransaction(raw: unknown): ChainTransaction | null {
  const tx = raw as Json;
  const signature = typeof tx?.signature === 'string' ? tx.signature : null;
  const message = first(first(tx?.transaction)?.message);
  const keys = message?.account_keys;
  if (!signature || !Array.isArray(keys)) return null;
  const accountKeys = keys.filter((k): k is string => typeof k === 'string');
  const instructions = (Array.isArray(message?.instructions) ? message.instructions : [])
    .map((ix) => {
      const i = ix as Json;
      const program = accountKeys[Number(i.program_id_index)];
      const data = typeof i.data === 'string' ? base58Decode(i.data) : new Uint8Array();
      return program && data ? { program, data } : null;
    })
    .filter((x): x is { program: string; data: Uint8Array } => x !== null);
  const meta = first(tx.meta);
  return { signature, accountKeys, instructions, failed: meta?.err != null };
}
