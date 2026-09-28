import { randomUUID } from 'node:crypto';
import {
  HandleConflict,
  type ApiKeyRow,
  type PasskeyRow,
  type ProfileRow,
  type Store,
} from './types.js';

/**
 * In-memory Store with the same semantics as the Postgres one, including the
 * conflict rules in claim_handle(). Used by the route tests.
 */
export function createMemoryStore(): Store {
  const profiles = new Map<string, ProfileRow>();
  const handles = new Map<string, 'user' | 'agent'>();
  const apiKeys = new Map<string, ApiKeyRow & { keyHash: string }>();
  const idem = new Map<
    string,
    {
      method: string;
      path: string;
      hash: string;
      state: 'in_progress' | 'completed';
      status?: number;
      body?: unknown;
    }
  >();
  const passkeys = new Map<string, PasskeyRow>();
  const challenges = new Map<string, { userId: string | null; kind: string; challenge: string }>();

  const profile = (userId: string): ProfileRow =>
    profiles.get(userId) ?? {
      userId,
      handle: null,
      solanaPubkey: null,
      elgamalPubkey: null,
      kycStatus: 'none',
      tier: 0,
      createdAt: new Date(),
    };

  return {
    profiles: {
      async get(userId) {
        return profile(userId);
      },
      async claimHandle({ userId, handle, solanaPubkey, elgamalPubkey }) {
        const current = profile(userId);
        if (current.handle) throw new HandleConflict('handle_already_claimed');
        if (handles.has(handle)) throw new HandleConflict('handle_taken');
        if ([...profiles.values()].some((p) => p.solanaPubkey === solanaPubkey)) {
          throw new HandleConflict('pubkey_in_use');
        }
        handles.set(handle, 'user');
        const next = { ...current, handle, solanaPubkey, elgamalPubkey };
        profiles.set(userId, next);
        return next;
      },
    },

    handles: {
      async resolve(handle) {
        const p = [...profiles.values()].find((x) => x.handle === handle);
        if (!p?.solanaPubkey || !p.elgamalPubkey) return null;
        return {
          handle,
          kind: 'user',
          solanaPubkey: p.solanaPubkey,
          elgamalPubkey: p.elgamalPubkey,
        };
      },
    },

    apiKeys: {
      async create({ ownerId, name, prefix, keyHash, environment }) {
        const row = {
          id: randomUUID(),
          ownerId,
          name,
          prefix,
          keyHash,
          environment,
          createdAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
        };
        apiKeys.set(row.id, row);
        const { keyHash: _hash, ...rest } = row;
        return rest;
      },
      async list(ownerId) {
        return [...apiKeys.values()]
          .filter((k) => k.ownerId === ownerId)
          .map(({ keyHash: _hash, ...rest }) => rest);
      },
      async revoke(ownerId, id) {
        const k = apiKeys.get(id);
        if (!k || k.ownerId !== ownerId || k.revokedAt) return false;
        k.revokedAt = new Date();
        return true;
      },
      async authenticate(keyHash) {
        const k = [...apiKeys.values()].find((x) => x.keyHash === keyHash && !x.revokedAt);
        if (!k) return null;
        k.lastUsedAt = new Date();
        const { keyHash: _hash, ...rest } = k;
        return rest;
      },
    },

    idempotency: {
      async begin({ principal, key, method, path, requestHash }) {
        const id = `${principal}:${key}`;
        const row = idem.get(id);
        if (!row) {
          idem.set(id, { method, path, hash: requestHash, state: 'in_progress' });
          return { kind: 'new' };
        }
        if (row.hash !== requestHash || row.method !== method || row.path !== path)
          return { kind: 'mismatch' };
        if (row.state === 'in_progress') return { kind: 'in_progress' };
        return { kind: 'replay', status: row.status!, body: row.body };
      },
      async complete(principal, key, status, body) {
        const row = idem.get(`${principal}:${key}`);
        if (row) Object.assign(row, { state: 'completed', status, body });
      },
      async release(principal, key) {
        const id = `${principal}:${key}`;
        if (idem.get(id)?.state === 'in_progress') idem.delete(id);
      },
    },

    passkeys: {
      async listForUser(userId) {
        return [...passkeys.values()].filter((p) => p.userId === userId);
      },
      async get(id) {
        return passkeys.get(id) ?? null;
      },
      async insert(row) {
        passkeys.set(row.id, row);
      },
      async markUsed(id, counter) {
        const p = passkeys.get(id);
        if (p) p.counter = counter;
      },
      async createChallenge({ userId, kind, challenge }) {
        const id = randomUUID();
        challenges.set(id, { userId, kind, challenge });
        return id;
      },
      async consumeChallenge(id, kind) {
        const c = challenges.get(id);
        challenges.delete(id);
        return c && c.kind === kind ? { userId: c.userId, challenge: c.challenge } : null;
      },
    },

    async ping() {},
  };
}
