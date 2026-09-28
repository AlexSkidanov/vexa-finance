/**
 * The API's view of the database. Routes depend on this interface, not on SQL,
 * so tests can run against an in-memory implementation.
 */
import type { ApiEnvironment, KycStatus } from '@vexa/core';

export interface ProfileRow {
  userId: string;
  handle: string | null;
  solanaPubkey: string | null;
  elgamalPubkey: string | null;
  kycStatus: KycStatus;
  tier: number;
  createdAt: Date;
}

export interface HandleRecord {
  handle: string;
  kind: 'user' | 'agent';
  solanaPubkey: string;
  elgamalPubkey: string;
}

export interface ApiKeyRow {
  id: string;
  ownerId: string;
  name: string;
  prefix: string;
  environment: ApiEnvironment;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface PasskeyRow {
  id: string;
  userId: string;
  name: string | null;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
}

export type IdempotencyBegin =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' };

/** Raised by claimHandle; the route maps each to a 409. */
export class HandleConflict extends Error {
  constructor(readonly reason: 'handle_taken' | 'handle_already_claimed' | 'pubkey_in_use') {
    super(reason);
  }
}

export interface Store {
  profiles: {
    get(userId: string): Promise<ProfileRow | null>;
    /** Atomically registers the handle and binds both keys. Throws HandleConflict. */
    claimHandle(input: {
      userId: string;
      handle: string;
      solanaPubkey: string;
      elgamalPubkey: string;
    }): Promise<ProfileRow>;
  };

  handles: {
    resolve(handle: string): Promise<HandleRecord | null>;
  };

  apiKeys: {
    create(input: {
      ownerId: string;
      name: string;
      prefix: string;
      keyHash: string;
      environment: ApiEnvironment;
    }): Promise<ApiKeyRow>;
    list(ownerId: string): Promise<ApiKeyRow[]>;
    /** Returns false if the key doesn't exist, isn't theirs, or is already revoked. */
    revoke(ownerId: string, id: string): Promise<boolean>;
    /** Looks up an unrevoked key by hash and bumps last_used_at. */
    authenticate(keyHash: string): Promise<ApiKeyRow | null>;
  };

  idempotency: {
    begin(input: {
      principal: string;
      key: string;
      method: string;
      path: string;
      requestHash: string;
    }): Promise<IdempotencyBegin>;
    complete(principal: string, key: string, status: number, body: unknown): Promise<void>;
    /** Forget an in-progress key after a server error, so the client can retry. */
    release(principal: string, key: string): Promise<void>;
  };

  passkeys: {
    listForUser(userId: string): Promise<PasskeyRow[]>;
    get(id: string): Promise<PasskeyRow | null>;
    insert(row: PasskeyRow): Promise<void>;
    markUsed(id: string, counter: number): Promise<void>;
    createChallenge(input: {
      userId: string | null;
      kind: 'registration' | 'authentication';
      challenge: string;
    }): Promise<string>;
    /** Returns the challenge once and deletes it. Null if missing, expired or the wrong kind. */
    consumeChallenge(
      id: string,
      kind: 'registration' | 'authentication',
    ): Promise<{ userId: string | null; challenge: string } | null>;
  };

  ping(): Promise<void>;
}
