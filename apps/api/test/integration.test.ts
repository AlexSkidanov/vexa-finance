/**
 * Runs the real Postgres store, Supabase Auth and JWT verification against the
 * project in .env. Opt in with VEXA_INTEGRATION=1:
 *
 *   VEXA_INTEGRATION=1 pnpm --filter @vexa/api test
 *
 * Creates throwaway users through the Supabase admin API and deletes them,
 * along with their handles, when it's done.
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashApiKey, generateApiKey } from '@vexa/core';
import { createSupabaseAuthProvider } from '../src/lib/auth-provider.js';
import { createSupabaseTokenVerifier } from '../src/lib/tokens.js';
import { createPostgresStore } from '../src/store/postgres.js';
import { HandleConflict } from '../src/store/types.js';
import { createLogger } from '../src/logger.js';
import { loadEnv } from '../src/env.js';
import { createApp } from '../src/app.js';
import { fakeDevice, offlineChain, signedClaim, TEST_VAULT } from './helpers.js';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const enabled = process.env.VEXA_INTEGRATION === '1';

describe.skipIf(!enabled)('integration: Supabase + Postgres', () => {
  const env = enabled ? loadEnv() : (undefined as never);
  const store = enabled ? createPostgresStore(env.SUPABASE_DB_URL) : (undefined as never);
  const admin = enabled
    ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : (undefined as never);
  const users: string[] = [];
  const handlesToDelete: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  async function newUser() {
    const { data, error } = await admin.auth.admin.createUser({
      email: `integration-${randomUUID()}@example.com`,
      email_confirm: true,
    });
    if (error) throw error;
    users.push(data.user.id);
    return data.user.id;
  }

  beforeAll(async () => {
    await store.ping();
  });

  afterAll(async () => {
    for (const id of users) await admin.auth.admin.deleteUser(id);
    // Handles outlive their owners on purpose (no recycling), so clean up by hand.
    const sql = (await import('postgres')).default(env.SUPABASE_DB_URL, { max: 1, prepare: false });
    if (handlesToDelete.length)
      await sql`delete from public.handles where handle in ${sql(handlesToDelete)}`;
    await sql.end();
    await store.close();
  });

  it('creates a profile for every new auth user', async () => {
    const id = await newUser();
    const profile = await store.profiles.get(id);
    expect(profile).toMatchObject({ userId: id, handle: null, kycStatus: 'none', tier: 0 });
  });

  it('mints a real session for a user and verifies it against the project JWKS', async () => {
    const id = await newUser();
    const provider = createSupabaseAuthProvider({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
    const session = await provider.sessionForUser(id);
    const verifier = createSupabaseTokenVerifier({
      supabaseUrl: env.SUPABASE_URL,
      legacySecret: env.SUPABASE_JWT_SECRET,
    });
    expect(await verifier.verify(session.accessToken)).toMatchObject({ userId: id });
    expect(await verifier.verify(session.accessToken.slice(0, -4) + 'AAAA')).toBeNull();
  });

  it('claims handles atomically and maps every conflict', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const handle = `it-${suffix}`;
    handlesToDelete.push(handle, `it2-${suffix}`);
    const device = fakeDevice();

    const profile = await store.profiles.claimHandle({ userId: alice, handle, ...pick(device) });
    expect(profile.handle).toBe(handle);
    expect(await store.handles.resolve(handle)).toMatchObject({
      kind: 'user',
      solanaPubkey: device.solanaPubkey,
    });

    await expect(
      store.profiles.claimHandle({ userId: bob, handle, ...pick(fakeDevice()) }),
    ).rejects.toEqual(new HandleConflict('handle_taken'));
    await expect(
      store.profiles.claimHandle({ userId: alice, handle: `it2-${suffix}`, ...pick(fakeDevice()) }),
    ).rejects.toEqual(new HandleConflict('handle_already_claimed'));
    await expect(
      store.profiles.claimHandle({ userId: bob, handle: `it2-${suffix}`, ...pick(device) }),
    ).rejects.toEqual(new HandleConflict('pubkey_in_use'));

    // The failed claims must not leave a dangling handle behind.
    expect(await store.handles.resolve(`it2-${suffix}`)).toBeNull();
  });

  it('runs the idempotency state machine in Postgres', async () => {
    const principal = await newUser();
    const key = randomUUID();
    const begin = (hash: string) =>
      store.idempotency.begin({ principal, key, method: 'POST', path: '/v1/x', requestHash: hash });

    expect(await begin('h1')).toEqual({ kind: 'new' });
    expect(await begin('h1')).toEqual({ kind: 'in_progress' });
    expect(await begin('h2')).toEqual({ kind: 'mismatch' });
    await store.idempotency.complete(principal, key, 201, { ok: true });
    expect(await begin('h1')).toEqual({ kind: 'replay', status: 201, body: { ok: true } });
  });

  it('stores only the hash of an API key and authenticates by it', async () => {
    const owner = await newUser();
    const secret = generateApiKey('live');
    const hash = hashApiKey(secret, env.API_KEY_ENCRYPTION_KEY);
    const row = await store.apiKeys.create({
      ownerId: owner,
      name: 'it',
      prefix: secret.slice(0, 12),
      keyHash: hash,
      environment: 'live',
    });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect((await store.apiKeys.authenticate(hash))?.id).toBe(row.id);
    expect(await store.apiKeys.revoke(owner, row.id)).toBe(true);
    expect(await store.apiKeys.authenticate(hash)).toBeNull();
  });

  it('serves a full claim over HTTP with a real session', async () => {
    const id = await newUser();
    const auth = createSupabaseAuthProvider({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
    const app = createApp({
      env,
      logger: createLogger('silent'),
      store,
      auth,
      tokens: createSupabaseTokenVerifier({ supabaseUrl: env.SUPABASE_URL }),
      chain: offlineChain,
      vault: TEST_VAULT,
      version: 'it',
    });
    const session = await auth.sessionForUser(id);
    const handle = `it3-${suffix}`;
    handlesToDelete.push(handle);

    const res = await app.request('/v1/handles/claim', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(signedClaim(id, handle)),
    });
    expect(res.status).toBe(201);
    const resolved = await app.request(`/v1/handles/${handle}/resolve`);
    expect(resolved.status).toBe(200);
  });
});

function pick(d: ReturnType<typeof fakeDevice>) {
  return { solanaPubkey: d.solanaPubkey, elgamalPubkey: d.elgamalPubkey };
}
