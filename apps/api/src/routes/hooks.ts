import { Hono } from 'hono';
import { ErrorCode } from '@vexa/core';
import { ApiError, notFound } from '../errors.js';
import type { AppBindings } from '../context.js';
import { transactionsOf, verifyAlchemySignature } from '../indexer/alchemy.js';

/**
 * Inbound provider webhooks. These only verify and queue; the indexer worker
 * does the processing, so a slow database never makes Alchemy time out and
 * retry.
 */
export const hooks = new Hono<AppBindings>().post('/alchemy', async (c) => {
  const { env, store, logger } = c.get('deps');
  if (!env.ALCHEMY_WEBHOOK_SIGNING_KEY) throw notFound('Webhook receiver');

  const raw = await c.req.text();
  if (
    !verifyAlchemySignature(
      raw,
      c.req.header('x-alchemy-signature'),
      env.ALCHEMY_WEBHOOK_SIGNING_KEY,
    )
  ) {
    throw new ApiError(401, ErrorCode.Unauthenticated, 'Invalid Alchemy signature');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ApiError(400, ErrorCode.InvalidRequest, 'Body is not JSON');
  }

  let queued = 0;
  for (const tx of transactionsOf(payload)) {
    const signature = (tx as { signature?: unknown }).signature;
    if (typeof signature !== 'string') continue;
    // Keyed by signature: Alchemy's redeliveries are harmless.
    if (await store.chainEvents.enqueue({ source: 'alchemy', externalId: signature, payload: tx }))
      queued++;
  }
  logger.info({ queued }, 'alchemy notification received');
  return c.json({ received: true, queued });
});
