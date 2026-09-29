import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import {
  base58Encode,
  CreateWebhookRequest,
  verifyWebhookSignature,
  VerifyWebhookRequest,
} from '@vexa/core';
import { notFound } from '../errors.js';
import type { AppBindings } from '../context.js';
import { authenticate, principalOf } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { openSecret, sealSecret } from '../lib/secrets.js';
import { parseBody } from '../lib/validate.js';
import type { WebhookRow } from '../store/types.js';

const summary = (w: WebhookRow) => ({
  id: w.id,
  url: w.url,
  events: w.events,
  createdAt: w.createdAt.toISOString(),
});

/**
 * Outbound webhooks. Each endpoint gets its own signing secret, returned once
 * at creation and stored sealed. See @vexa/core's webhooks.ts for the
 * signature scheme; the SDK exports the same verifier.
 */
export const webhooks = new Hono<AppBindings>()
  .post('/', authenticate(), idempotent({ redact: ['secret'] }), async (c) => {
    const { store, env } = c.get('deps');
    const { userId } = principalOf(c);
    const { url, events } = await parseBody(c, CreateWebhookRequest);
    const secret = `whsec_${base58Encode(randomBytes(32))}`;
    const row = await store.webhooks.create({
      ownerId: userId,
      url,
      events: [...new Set(events)],
      secretEncrypted: sealSecret(env.WEBHOOK_SIGNING_SECRET, secret),
    });
    return c.json({ ...summary(row), secret }, 201);
  })

  .get('/', authenticate(), async (c) => {
    const { userId } = principalOf(c);
    return c.json({ data: (await c.get('deps').store.webhooks.list(userId)).map(summary) });
  })

  .delete('/:id', authenticate(), async (c) => {
    const { userId } = principalOf(c);
    const id = c.req.param('id');
    const ok =
      /^[0-9a-f-]{36}$/i.test(id) && (await c.get('deps').store.webhooks.remove(userId, id));
    if (!ok) throw notFound('Webhook');
    return c.body(null, 204);
  })

  /**
   * Checks a delivery's signature with the endpoint's stored secret. Useful
   * when wiring up a receiver; production receivers should verify locally
   * with `verifyWebhookSignature` from the SDK instead of calling this.
   */
  .post('/verify', authenticate(), async (c) => {
    const { store, env } = c.get('deps');
    const { userId } = principalOf(c);
    const { webhookId, payload, signature } = await parseBody(c, VerifyWebhookRequest);
    const hook = await store.webhooks.get(userId, webhookId);
    if (!hook) throw notFound('Webhook');
    const secret = openSecret(env.WEBHOOK_SIGNING_SECRET, hook.secretEncrypted);
    return c.json(verifyWebhookSignature({ payload, header: signature, secret }));
  });
