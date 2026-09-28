import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface VerifiedToken {
  userId: string;
  email: string | null;
}

export interface TokenVerifier {
  /** Returns the user for a valid, unexpired Supabase access token, or null. */
  verify(token: string): Promise<VerifiedToken | null>;
}

/**
 * Verifies Supabase access tokens locally, without a network round trip per
 * request.
 *
 * Projects on asymmetric signing keys (ES256/RS256) publish their public keys
 * at /auth/v1/.well-known/jwks.json. jose caches that set and refetches when
 * it sees an unknown `kid`, so key rotation in the dashboard just works.
 * Projects still on the legacy shared HS256 secret pass it as `legacySecret`.
 */
export function createSupabaseTokenVerifier(opts: {
  supabaseUrl: string;
  legacySecret?: string;
}): TokenVerifier {
  const issuer = `${opts.supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  const legacyKey = opts.legacySecret ? new TextEncoder().encode(opts.legacySecret) : null;

  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString());
        const common = { issuer, audience: 'authenticated', clockTolerance: 5 };
        if (header.alg === 'HS256') {
          if (!legacyKey) return null;
          ({ payload } = await jwtVerify(token, legacyKey, { ...common, algorithms: ['HS256'] }));
        } else {
          ({ payload } = await jwtVerify(token, jwks, {
            ...common,
            algorithms: ['ES256', 'RS256'],
          }));
        }
      } catch {
        return null;
      }
      if (typeof payload.sub !== 'string' || payload.role !== 'authenticated') return null;
      return {
        userId: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
      };
    },
  };
}
