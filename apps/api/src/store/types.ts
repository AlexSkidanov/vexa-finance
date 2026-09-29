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

export type TransferStatus = 'pending' | 'submitted' | 'settled' | 'failed';

/** Transfer amounts exist only inside `ciphertext`. */
export interface TransferRow {
  id: string;
  fromOwnerId: string | null;
  /** Set when an agent of `fromOwnerId` made the payment. */
  fromAgentId: string | null;
  /** Set when the recipient is an agent (its owner funding it). */
  toAgentId: string | null;
  fromPubkey: string;
  toOwnerId: string | null;
  toHandle: string | null;
  /** The recipient's cUSDC token account. */
  toPubkey: string;
  /** { groupedLo, groupedHi }: base64 grouped ElGamal ciphertexts (sender, recipient, auditor). */
  ciphertext: Record<string, string>;
  mode: 'standard' | 'stealth';
  status: TransferStatus;
  txSig: string | null;
  signatures: string[];
  memoCiphertext: Uint8Array | null;
  failureReason: string | null;
  createdAt: Date;
}

export interface MovementRow {
  id: string;
  ownerId: string;
  txSig: string | null;
  status: 'submitted' | 'confirmed' | 'failed';
  destination?: string;
  createdAt: Date;
}

export type ActivityItem =
  | { kind: 'transfer'; direction: 'sent' | 'received'; transfer: TransferRow }
  | { kind: 'deposit'; movement: MovementRow }
  | { kind: 'withdrawal'; movement: MovementRow };

export type AgentStatus = 'active' | 'paused' | 'revoked';

/** Limits are configuration, public on NEAR anyway: not balances. */
export interface PolicyRow {
  version: number;
  /** USDC base units. */
  maxPerRequest: bigint;
  dailyLimit: bigint;
  allowedRecipients: string[];
  allowedDomains: string[];
}

export interface AgentRow {
  id: string;
  ownerId: string;
  name: string | null;
  /** The agent's MPC-derived Solana address. */
  solanaPubkey: string;
  cusdcAccount: string;
  nonceAccount: string;
  authority: string;
  elgamalPubkey: string;
  status: AgentStatus;
  policy: PolicyRow;
  createdAt: Date;
}

export type TraceStep =
  | 'request'
  | 'payment_required'
  | 'quote'
  | 'policy_check'
  | 'paid'
  | 'retried'
  | 'completed'
  | 'failed';

export interface AgentTraceRow {
  id: string;
  agentId: string;
  requestId: string | null;
  step: TraceStep;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export interface ViewKeyRow {
  id: string;
  ownerId: string;
  label: string | null;
  scopeFrom: Date;
  scopeTo: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/** One exported row: public transfer metadata and the owner-encrypted record. */
export interface AuditRow {
  transferId: string;
  createdAt: Date;
  direction: 'sent' | 'received';
  counterparty: string;
  txSig: string | null;
  record: Uint8Array;
}

export interface EventRow {
  id: string;
  ownerId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface WebhookRow {
  id: string;
  ownerId: string;
  url: string;
  events: string[];
  active: boolean;
  /** Per-endpoint signing secret, encrypted with WEBHOOK_SIGNING_SECRET. */
  secretEncrypted: Uint8Array;
  createdAt: Date;
}

export interface DueDelivery {
  id: string;
  attempt: number;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  url: string;
  secretEncrypted: Uint8Array;
}

export interface Store {
  profiles: {
    get(userId: string): Promise<ProfileRow | null>;
    findByHandle(handle: string): Promise<ProfileRow | null>;
    findBySolanaPubkey(pubkey: string): Promise<ProfileRow | null>;
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

  money: {
    createTransfer(input: {
      fromOwnerId: string;
      fromPubkey: string;
      toOwnerId: string | null;
      toHandle: string | null;
      toPubkey: string;
      mode: 'standard' | 'stealth';
      fromAgentId?: string | null;
      toAgentId?: string | null;
    }): Promise<TransferRow>;
    /** Only returns the transfer if `ownerId` sent it. */
    getTransfer(id: string, ownerId: string): Promise<TransferRow | null>;
    markTransferSubmitted(id: string): Promise<void>;
    settleTransfer(
      id: string,
      input: {
        ciphertext: Record<string, string>;
        txSig: string;
        signatures: string[];
        memoCiphertext: Uint8Array | null;
      },
    ): Promise<TransferRow>;
    failTransfer(id: string, reason: string, signatures: string[]): Promise<void>;
    recordDeposit(input: {
      ownerId: string;
      txSig: string | null;
      status: MovementRow['status'];
    }): Promise<MovementRow>;
    hasDeposit(txSig: string): Promise<boolean>;
    recordWithdrawal(input: {
      ownerId: string;
      destination: string;
      txSig: string | null;
      status: MovementRow['status'];
    }): Promise<MovementRow>;
    /** Records which payment index an agent's transfer used. */
    recordAgentPayment(input: {
      transferId: string;
      agentId: string;
      index: number;
    }): Promise<void>;
    /** An agent's settled payments with index ≥ `fromIndex`, lowest first. */
    agentPayments(
      agentId: string,
      fromIndex: number,
    ): Promise<{ index: number; transfer: TransferRow }[]>;
    /** Newest first; transfers the user sent or received, plus their deposits and withdrawals. */
    activity(userId: string, opts: { limit: number; before?: Date }): Promise<ActivityItem[]>;
  };

  agents: {
    create(
      input: Omit<AgentRow, 'status' | 'createdAt' | 'policy'> & {
        policy: Omit<PolicyRow, 'version'>;
      },
    ): Promise<AgentRow>;
    /** Only returns the agent if `ownerId` owns it. */
    get(ownerId: string, id: string): Promise<AgentRow | null>;
    list(ownerId: string): Promise<AgentRow[]>;
    /** Agents that aren't revoked: what counts against the tier's agent limit. */
    countLive(ownerId: string): Promise<number>;
    /** Appends a policy version. */
    setPolicy(agentId: string, policy: Omit<PolicyRow, 'version'>): Promise<PolicyRow>;
    setStatus(agentId: string, status: AgentStatus): Promise<void>;
    trace(input: {
      agentId: string;
      ownerId: string;
      requestId: string | null;
      step: TraceStep;
      detail: Record<string, unknown>;
    }): Promise<AgentTraceRow>;
    traces(agentId: string, opts: { limit: number; requestId?: string }): Promise<AgentTraceRow[]>;
  };

  viewKeys: {
    create(input: {
      id: string;
      ownerId: string;
      label: string | null;
      scopeFrom: Date;
      scopeTo: Date;
      accessHash: string;
    }): Promise<ViewKeyRow>;
    list(ownerId: string): Promise<ViewKeyRow[]>;
    get(ownerId: string, id: string): Promise<ViewKeyRow | null>;
    /** Revokes the key and deletes its records. False if it wasn't theirs or was already revoked. */
    revoke(ownerId: string, id: string): Promise<boolean>;
    recordedTransferIds(id: string): Promise<string[]>;
    /**
     * Stores records for transfers the key's owner sent or received within its
     * scope; ignores anything else, and transfers already recorded.
     */
    addRecords(
      key: ViewKeyRow,
      records: { transferId: string; record: Uint8Array }[],
    ): Promise<number>;
    /** An unrevoked key by the hash of its access secret. */
    byAccessHash(hash: string): Promise<ViewKeyRow | null>;
    exportRows(key: ViewKeyRow): Promise<AuditRow[]>;
  };

  events: {
    /** Records an event and queues a delivery for each subscribed, active webhook. */
    emit(ownerId: string, type: string, data: Record<string, unknown>): Promise<EventRow>;
  };

  webhooks: {
    create(input: {
      ownerId: string;
      url: string;
      events: string[];
      secretEncrypted: Uint8Array;
    }): Promise<WebhookRow>;
    list(ownerId: string): Promise<WebhookRow[]>;
    get(ownerId: string, id: string): Promise<WebhookRow | null>;
    remove(ownerId: string, id: string): Promise<boolean>;
    /**
     * Claims up to `limit` due deliveries. Claimed rows are pushed back by a
     * lease, so a worker that dies mid-delivery doesn't lose them.
     */
    claimDue(limit: number, leaseSeconds: number): Promise<DueDelivery[]>;
    markDelivered(id: string, responseStatus: number): Promise<void>;
    /** Schedules a retry, or parks the delivery as dead when `nextAttemptAt` is null. */
    markFailed(
      id: string,
      responseStatus: number | null,
      nextAttemptAt: Date | null,
    ): Promise<void>;
  };

  /** Inbound chain notifications, processed by the indexer with retries. */
  chainEvents: {
    /** Returns false if this (source, externalId) was already queued. */
    enqueue(input: { source: string; externalId: string; payload: unknown }): Promise<boolean>;
    claimDue(
      limit: number,
      leaseSeconds: number,
    ): Promise<{ id: string; attempts: number; payload: unknown }[]>;
    markDone(id: string): Promise<void>;
    /** Retries at `nextAttemptAt`, or parks the event as dead when it's null. */
    markFailed(id: string, error: string, nextAttemptAt: Date | null): Promise<void>;
  };

  ping(): Promise<void>;
}
