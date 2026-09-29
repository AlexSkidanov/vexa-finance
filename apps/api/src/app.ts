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
      exposeHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw new ApiError(413, ErrorCode.InvalidRequest, 'Request body is too large');
      },
    }),
  );

  app.route('/health', health);
  app.route('/v1/auth', auth);
  app.route('/v1/me', me);
  app.route('/v1/handles', handles);
  app.route('/v1/api-keys', apiKeys);
  app.route('/v1/webhooks', webhooks);
  app.route('/v1', money);

  app.onError(onError);
  app.notFound(onNotFound);
  return app;
}

export type App = ReturnType<typeof createApp>;
