import { Hono } from 'hono';
import {
  apiKeyDisplayPrefix,
  CreateApiKeyRequest,
  generateApiKey,
  hashApiKey,
  type ApiKeySummary,
  type CreatedApiKey,
} from '@vexa/core';
import { notFound } from '../errors.js';
import type { AppBindings } from '../context.js';
import { authenticate, principalOf } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { parseBody } from '../lib/validate.js';
import type { ApiKeyRow } from '../store/types.js';

const summary = (k: ApiKeyRow): ApiKeySummary => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  environment: k.environment,
  createdAt: k.createdAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
});

/**
 * API keys are for servers and agents. Creating or revoking one requires a
 * signed-in session, so a leaked key can't be used to mint more keys.
 */
export const apiKeys = new Hono<AppBindings>()
  .post('/', authenticate({ sessionOnly: true }), idempotent({ redact: ['secret'] }), async (c) => {
    const { env, store } = c.get('deps');
    const { userId } = principalOf(c);
    const { name } = await parseBody(c, CreateApiKeyRequest);

    const secret = generateApiKey(env.API_ENVIRONMENT);
    const row = await store.apiKeys.create({
      ownerId: userId,
      name,
      prefix: apiKeyDisplayPrefix(secret),
      keyHash: hashApiKey(secret, env.API_KEY_ENCRYPTION_KEY),
      environment: env.API_ENVIRONMENT,
    });
    // The only time the full key is ever returned. It's redacted from the
    // idempotency record, so a replay confirms the key exists without exposing
    // it again. A client that lost the response should revoke the key and
    // create a new one.
    return c.json({ ...summary(row), secret } satisfies CreatedApiKey, 201);
  })

  .get('/', authenticate(), async (c) => {
    const { userId } = principalOf(c);
    const keys = await c.get('deps').store.apiKeys.list(userId);
    return c.json({ data: keys.map(summary) });
  })

  .delete('/:id', authenticate({ sessionOnly: true }), async (c) => {
    const { userId } = principalOf(c);
    const id = c.req.param('id');
    const ok =
      /^[0-9a-f-]{36}$/i.test(id) && (await c.get('deps').store.apiKeys.revoke(userId, id));
    if (!ok) throw notFound('API key');
    return c.body(null, 204);
  });
