import type { Context, MiddlewareHandler } from 'hono';
import { apiKeyEnvironment, ErrorCode, hashApiKey } from '@vexa/core';
import { ApiError, unauthenticated } from '../errors.js';
import type { AppBindings, Principal } from '../context.js';

/**
 * Resolves the caller from `Authorization: Bearer <token>`, where the token is
 * either a Supabase access token (browser and app sessions) or a `vx_` API key
 * (servers and agents).
 *
 * `authenticate()` rejects anonymous requests; `optionalAuth()` lets them
 * through with no principal set.
 */
export function authenticate(opts: { sessionOnly?: boolean } = {}): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const principal = await resolvePrincipal(c);
    if (!principal) throw unauthenticated();
    if (opts.sessionOnly && principal.via !== 'session') {
      throw new ApiError(
        403,
        ErrorCode.Forbidden,
        'This action requires a signed-in session, not an API key',
      );
    }
    c.set('principal', principal);
    await next();
  };
}

export function optionalAuth(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const principal = await resolvePrincipal(c);
    if (principal) c.set('principal', principal);
    await next();
  };
}

async function resolvePrincipal(c: Context<AppBindings>): Promise<Principal | null> {
  const header = c.req.header('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw unauthenticated('Authorization header must be "Bearer <token>"');
  const token = m[1]!;
  const { env, store, tokens } = c.get('deps');

  if (token.startsWith('vx_')) {
    const environment = apiKeyEnvironment(token);
    if (!environment) throw new ApiError(401, ErrorCode.InvalidApiKey, 'Malformed API key');
    // Refuse before touching the database: a test key on a live deployment
    // (or vice versa) is always a configuration mistake worth surfacing clearly.
    if (environment !== env.API_ENVIRONMENT) {
      throw new ApiError(
        401,
        ErrorCode.WrongEnvironment,
        `This is a ${environment} key, but this API serves the ${env.API_ENVIRONMENT} environment`,
      );
    }
    const key = await store.apiKeys.authenticate(hashApiKey(token, env.API_KEY_ENCRYPTION_KEY));
    if (!key) throw new ApiError(401, ErrorCode.InvalidApiKey, 'API key is invalid or revoked');
    return { userId: key.ownerId, email: null, via: 'api_key', apiKeyId: key.id };
  }

  const verified = await tokens.verify(token);
  if (!verified) throw unauthenticated('Session is invalid or expired');
  return { userId: verified.userId, email: verified.email, via: 'session' };
}

/** For handlers behind authenticate(): the principal is guaranteed to be set. */
export function principalOf(c: Context<AppBindings>): Principal {
  const p = c.get('principal');
  if (!p) throw unauthenticated();
  return p;
}
