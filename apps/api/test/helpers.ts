import { randomUUID } from 'node:crypto';
import { ed25519, ristretto255 } from '@noble/curves/ed25519.js';
import { base58Encode, base64Encode, handleClaimMessage, type Session } from '@vexa/core';
import { createApp } from '../src/app.js';
import type { Deps } from '../src/context.js';
import { loadEnv } from '../src/env.js';
import { createLogger } from '../src/logger.js';
import type { AuthProvider } from '../src/lib/auth-provider.js';
import type { TokenVerifier } from '../src/lib/tokens.js';
import { createMemoryStore } from '../src/store/memory.js';

export const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  API_BASE_URL: 'http://localhost:8787',
  API_KEY_ENCRYPTION_KEY: '11'.repeat(32),
  WEBHOOK_SIGNING_SECRET: '22'.repeat(32),
  VIEW_KEY_ENCRYPTION_KEY: '33'.repeat(32),
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'Vexa',
  WEBAUTHN_ORIGINS: 'http://localhost:3000',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_test_test_test',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_test_test_test',
  SUPABASE_DB_URL: 'postgresql://localhost/test',
  SOLANA_CLUSTER: 'mainnet-beta',
  LOG_LEVEL: 'silent',
});

/**
 * Sessions in tests are opaque tokens of the form `session:<userId>`, which the
 * fake verifier accepts. Everything else about auth runs for real.
 */
export function sessionToken(userId: string) {
  return `session:${userId}`;
}

const fakeTokens: TokenVerifier = {
  async verify(token) {
    const m = /^session:(.+)$/.exec(token);
    return m ? { userId: m[1]!, email: `${m[1]}@example.com` } : null;
  },
};

export function fakeAuthProvider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  const session = (userId: string): Session => ({
    accessToken: sessionToken(userId),
    refreshToken: `refresh:${userId}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, email: `${userId}@example.com` },
  });
  return {
    async sendEmailOtp() {},
    async verifyEmailOtp(_email, token) {
      return token === '123456' ? session(randomUUID()) : null;
    },
    async refresh() {
      return null;
    },
    async sessionForUser(userId) {
      return session(userId);
    },
    async getEmail(userId) {
      return `${userId}@example.com`;
    },
    ...overrides,
  };
}

export function testApp(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    env: TEST_ENV,
    logger: createLogger('silent'),
    store: createMemoryStore(),
    auth: fakeAuthProvider(),
    tokens: fakeTokens,
    version: 'test',
    ...overrides,
  };
  const app = createApp(deps);

  const request = (
    method: string,
    path: string,
    opts: {
      token?: string;
      body?: unknown;
      idempotencyKey?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

  return { app, deps, request };
}

/** A user's device: a Solana keypair and an ElGamal public key, like the SDK derives. */
export function fakeDevice() {
  const seed = ed25519.utils.randomSecretKey();
  const scalar = BigInt(Math.floor(Math.random() * 1e9) + 2);
  return {
    seed,
    solanaPubkey: base58Encode(ed25519.getPublicKey(seed)),
    elgamalPubkey: base64Encode(ristretto255.Point.BASE.multiply(scalar).toBytes()),
  };
}

export function signedClaim(userId: string, handle: string, device = fakeDevice()) {
  const message = handleClaimMessage({
    handle,
    userId,
    solanaPubkey: device.solanaPubkey,
    elgamalPubkey: device.elgamalPubkey,
  });
  return {
    handle,
    solanaPubkey: device.solanaPubkey,
    elgamalPubkey: device.elgamalPubkey,
    signature: base58Encode(ed25519.sign(message, device.seed)),
  };
}
