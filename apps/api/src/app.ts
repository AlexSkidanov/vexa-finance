import { transparency } from './routes/transparency.js';
import { audit, viewKeys } from './routes/view-keys.js';
import { agents } from './routes/agents.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ErrorCode } from '@vexa/core';
import { ApiError } from './errors.js';
import type { AppBindings, Deps } from './context.js';
import { onError, onNotFound } from './middleware/errors.js';
import { requestContext } from './middleware/request-context.js';
import { apiKeys } from './routes/api-keys.js';
import { auth } from './routes/auth.js';
import { handles } from './routes/handles.js';
import { health } from './routes/health.js';
import { me } from './routes/me.js';
import { money } from './routes/money.js';
import { webhooks } from './routes/webhooks.js';
import { hooks } from './routes/hooks.js';

/**
 * Builds the Hono app from its dependencies. Kept separate from the server
 * entry point so tests can construct an app with in-memory fakes and call
 * `app.request()` without opening a socket.
 */
export function createApp(deps: Deps) {
  const app = new Hono<AppBindings>();

  app.use('*', requestContext(deps));
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: deps.env.WEBAUTHN_ORIGINS,
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
      exposeHeaders: [
        'X-Request-Id',
        'Idempotent-Replayed',
        'Retry-After',
        'X-Vexa-Signature',
        'X-Vexa-Signature-ML-DSA-65',
      ],
      maxAge: 600,
    }),
  );
  // Provider webhooks can batch many transactions; everything else is small.
  const tooLarge = () => {
    throw new ApiError(413, ErrorCode.InvalidRequest, 'Request body is too large');
  };
  app.use('/v1/hooks/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge }));
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/v1/hooks/')) return next();
    return bodyLimit({ maxSize: 64 * 1024, onError: tooLarge })(c, next);
  });

  app.route('/health', health);
  app.route('/v1/auth', auth);
  app.route('/v1/me', me);
  app.route('/v1/handles', handles);
  app.route('/v1/api-keys', apiKeys);
  app.route('/v1/webhooks', webhooks);
  app.route('/v1/hooks', hooks);
  app.route('/v1/agents', agents);
  app.route('/v1/view-keys', viewKeys);
  app.route('/v1/audit', audit);
  app.route('/v1/transparency', transparency);
  app.route('/v1', money);

  app.onError(onError);
  app.notFound(onNotFound);
  return app;
}

export type App = ReturnType<typeof createApp>;
