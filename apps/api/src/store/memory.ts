import { randomUUID } from 'node:crypto';
import {
  HandleConflict,
  type ActivityItem,
  type AgentRow,
  type AgentTraceRow,
  type AuditRow,
  type StealthRouteRow,
  type ViewKeyRow,
  type EventRow,
  type MovementRow,
  type DueDelivery,
  type TransferRow,
  type WebhookRow,
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
  const transfers = new Map<string, TransferRow>();
  const agents = new Map<string, AgentRow>();
  const agentPayments: { transferId: string; agentId: string; index: number }[] = [];
  const traces: AgentTraceRow[] = [];
  const stealthRoutes = new Map<string, StealthRouteRow & { due: number; lease: number }>();
  const viewKeys = new Map<string, ViewKeyRow & { accessHash: string }>();
  const viewRecords = new Map<string, Map<string, Uint8Array>>();
  const deposits: MovementRow[] = [];
  const withdrawals: MovementRow[] = [];
  const events: EventRow[] = [];
  const hooks = new Map<string, WebhookRow>();
  const chainEvents = new Map<
    string,
    {
      id: string;
      key: string;
      attempts: number;
      payload: unknown;
      status: string;
      due: number;
      error?: string;
    }
  >();
  const deliveries = new Map<
    string,
    Omit<DueDelivery, 'url' | 'secretEncrypted'> & {
      webhookId: string;
      status: 'pending' | 'delivered' | 'dead';
      nextAttemptAt: number;
      responseStatus: number | null;
    }
  >();

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
      async findBySolanaPubkey(pubkey) {
        return [...profiles.values()].find((p) => p.solanaPubkey === pubkey) ?? null;
      },
      async findByHandle(handle) {
        return [...profiles.values()].find((p) => p.handle === handle) ?? null;
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

    money: {
      async createTransfer(t) {
        const row: TransferRow = {
          id: randomUUID(),
          ...t,
          fromAgentId: t.fromAgentId ?? null,
          toAgentId: t.toAgentId ?? null,
          ciphertext: {},
          status: 'pending',
          txSig: null,
          signatures: [],
          memoCiphertext: null,
          failureReason: null,
          createdAt: new Date(),
        };
        transfers.set(row.id, row);
        return row;
      },
      async getTransfer(id, ownerId) {
        const t = transfers.get(id);
        return t && t.fromOwnerId === ownerId ? t : null;
      },
      async markTransferSubmitted(id) {
        const t = transfers.get(id);
        if (t?.status === 'pending') t.status = 'submitted';
      },
      async settleTransfer(id, input) {
        const t = transfers.get(id)!;
        Object.assign(t, { status: 'settled', ...input });
        return t;
      },
      async failTransfer(id, reason, signatures) {
        const t = transfers.get(id);
        if (t) Object.assign(t, { status: 'failed', failureReason: reason, signatures });
      },
      async setTransferStatus(id, status) {
        const t = transfers.get(id);
        if (t) t.status = status as TransferRow['status'];
      },
      async addTransferCiphertext(id, ciphertext) {
        const t = transfers.get(id);
        if (t) t.ciphertext = { ...t.ciphertext, ...ciphertext };
      },
      async transferById(id) {
        return transfers.get(id) ?? null;
      },
      async recordAgentPayment(p) {
        agentPayments.push(p);
      },
      async agentPayments(agentId, fromIndex) {
        return agentPayments
          .filter((p) => p.agentId === agentId && p.index >= fromIndex)
          .map((p) => ({ index: p.index, transfer: transfers.get(p.transferId)! }))
          .filter((p) => p.transfer.status === 'settled')
          .sort((a, b) => a.index - b.index);
      },
      async recordDeposit({ ownerId, txSig, status }) {
        const row: MovementRow = {
          id: randomUUID(),
          ownerId,
          txSig,
          status,
          createdAt: new Date(),
        };
        deposits.push(row);
        return row;
      },
      async hasDeposit(txSig) {
        return deposits.some((d) => d.txSig === txSig);
      },
      async recordWithdrawal({ ownerId, destination, txSig, status }) {
        const row: MovementRow = {
          id: randomUUID(),
          ownerId,
          txSig,
          status,
          destination,
          createdAt: new Date(),
        };
        withdrawals.push(row);
        return row;
      },
      async activity(userId, { limit, before }) {
        const cutoff = before?.getTime() ?? Infinity;
        const items: ActivityItem[] = [
          ...[...transfers.values()]
            .filter(
              (t) => t.status === 'settled' && (t.fromOwnerId === userId || t.toOwnerId === userId),
            )
            .map((transfer) => ({
              kind: 'transfer' as const,
              direction:
                transfer.fromOwnerId === userId ? ('sent' as const) : ('received' as const),
              transfer,
            })),
          ...deposits
            .filter((d) => d.ownerId === userId)
            .map((movement) => ({ kind: 'deposit' as const, movement })),
          ...withdrawals
            .filter((w) => w.ownerId === userId)
            .map((movement) => ({ kind: 'withdrawal' as const, movement })),
        ];
        const at = (i: ActivityItem) =>
          i.kind === 'transfer' ? i.transfer.createdAt : i.movement.createdAt;
        return items
          .filter((i) => at(i).getTime() < cutoff)
          .sort((a, b) => at(b).getTime() - at(a).getTime())
          .slice(0, limit);
      },
    },

    agents: {
      async create(a) {
        const row: AgentRow = {
          ...a,
          status: 'active',
          policy: { ...a.policy, version: 1 },
          createdAt: new Date(),
        };
        agents.set(row.id, row);
        return row;
      },
      async get(ownerId, id) {
        const a = agents.get(id);
        return a && a.ownerId === ownerId ? a : null;
      },
      async list(ownerId) {
        return [...agents.values()].filter((a) => a.ownerId === ownerId);
      },
      async countLive(ownerId) {
        return [...agents.values()].filter((a) => a.ownerId === ownerId && a.status !== 'revoked')
          .length;
      },
      async setPolicy(agentId, policy) {
        const a = agents.get(agentId)!;
        a.policy = { ...policy, version: a.policy.version + 1 };
        return a.policy;
      },
      async setStatus(agentId, status) {
        const a = agents.get(agentId);
        if (a) a.status = status;
      },
      async trace(t) {
        const row: AgentTraceRow = {
          id: randomUUID(),
          agentId: t.agentId,
          requestId: t.requestId,
          step: t.step,
          detail: t.detail,
          createdAt: new Date(),
        };
        traces.push(row);
        return row;
      },
      async traces(agentId, { limit, requestId }) {
        return traces
          .filter((t) => t.agentId === agentId && (!requestId || t.requestId === requestId))
          .reverse()
          .slice(0, limit);
      },
    },

    stealth: {
      async create(r) {
        const row = {
          ...r,
          status: 'awaiting_funds' as const,
          zcashAddress: null,
          leg1DepositAddress: null,
          leg2DepositAddress: null,
          zcashTxid: null,
          leg2Attempts: 0,
          attempts: 0,
          lastError: null,
          signatures: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          due: Date.now(),
          lease: 0,
        };
        stealthRoutes.set(r.transferId, row);
        return row;
      },
      async get(transferId, senderId) {
        const r = stealthRoutes.get(transferId);
        return r && r.senderId === senderId ? r : null;
      },
      async claimDue(limit, leaseSeconds) {
        const now = Date.now();
        const due = [...stealthRoutes.values()]
          .filter(
            (r) =>
              !['settled', 'refunded', 'failed'].includes(r.status) &&
              r.due <= now &&
              r.lease <= now,
          )
          .slice(0, limit);
        for (const r of due) r.lease = now + leaseSeconds * 1000;
        return due;
      },
      async update(transferId, patch) {
        const r = stealthRoutes.get(transferId);
        if (!r) return;
        const { nextAttemptAt, ...rest } = patch;
        Object.assign(r, rest, { updatedAt: new Date(), lease: 0 });
        if (nextAttemptAt) r.due = nextAttemptAt.getTime();
      },
    },

    viewKeys: {
      async create(v) {
        const row = { ...v, revokedAt: null, createdAt: new Date() };
        viewKeys.set(v.id, row);
        viewRecords.set(v.id, new Map());
        return row;
      },
      async list(ownerId) {
        return [...viewKeys.values()].filter((v) => v.ownerId === ownerId);
      },
      async get(ownerId, id) {
        const v = viewKeys.get(id);
        return v && v.ownerId === ownerId ? v : null;
      },
      async revoke(ownerId, id) {
        const v = viewKeys.get(id);
        if (!v || v.ownerId !== ownerId || v.revokedAt) return false;
        v.revokedAt = new Date();
        viewRecords.get(id)?.clear();
        return true;
      },
      async recordedTransferIds(id) {
        return [...(viewRecords.get(id)?.keys() ?? [])];
      },
      async addRecords(key, records) {
        const map = viewRecords.get(key.id)!;
        let added = 0;
        for (const r of records) {
          const t = transfers.get(r.transferId);
          const mine = t && (t.fromOwnerId === key.ownerId || t.toOwnerId === key.ownerId);
          const inScope = t && t.createdAt >= key.scopeFrom && t.createdAt < key.scopeTo;
          if (mine && inScope && !map.has(r.transferId)) {
            map.set(r.transferId, r.record);
            added++;
          }
        }
        return added;
      },
      async byAccessHash(hash) {
        return [...viewKeys.values()].find((v) => v.accessHash === hash && !v.revokedAt) ?? null;
      },
      async exportRows(key) {
        const rows: AuditRow[] = [];
        for (const [transferId, record] of viewRecords.get(key.id) ?? []) {
          const t = transfers.get(transferId);
          if (!t || t.createdAt < key.scopeFrom || t.createdAt >= key.scopeTo) continue;
          const sent = t.fromOwnerId === key.ownerId;
          rows.push({
            transferId,
            createdAt: t.createdAt,
            direction: sent ? 'sent' : 'received',
            counterparty: sent ? (t.toHandle ?? t.toPubkey) : t.fromPubkey,
            txSig: t.txSig,
            record,
          });
        }
        return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
    },

    events: {
      async emit(ownerId, type, data) {
        const row: EventRow = { id: randomUUID(), ownerId, type, data, createdAt: new Date() };
        events.push(row);
        for (const w of hooks.values()) {
          if (w.ownerId !== ownerId || !w.active || !w.events.includes(type)) continue;
          const id = randomUUID();
          deliveries.set(id, {
            id,
            webhookId: w.id,
            attempt: 0,
            eventId: row.id,
            eventType: type,
            payload: { id: row.id, type, createdAt: row.createdAt.toISOString(), data },
            status: 'pending',
            nextAttemptAt: Date.now(),
            responseStatus: null,
          });
        }
        return row;
      },
    },

    webhooks: {
      async create({ ownerId, url, events: types, secretEncrypted }) {
        const row: WebhookRow = {
          id: randomUUID(),
          ownerId,
          url,
          events: types,
          active: true,
          secretEncrypted,
          createdAt: new Date(),
        };
        hooks.set(row.id, row);
        return row;
      },
      async list(ownerId) {
        return [...hooks.values()].filter((w) => w.ownerId === ownerId && w.active);
      },
      async get(ownerId, id) {
        const w = hooks.get(id);
        return w && w.ownerId === ownerId && w.active ? w : null;
      },
      async remove(ownerId, id) {
        const w = hooks.get(id);
        if (!w || w.ownerId !== ownerId || !w.active) return false;
        w.active = false;
        return true;
      },
      async claimDue(limit, leaseSeconds) {
        const now = Date.now();
        const due = [...deliveries.values()]
          .filter(
            (d) =>
              d.status === 'pending' && d.nextAttemptAt <= now && hooks.get(d.webhookId)?.active,
          )
          .slice(0, limit);
        return due.map((d) => {
          d.attempt += 1;
          d.nextAttemptAt = now + leaseSeconds * 1000;
          const w = hooks.get(d.webhookId)!;
          const { webhookId: _w, status: _s, nextAttemptAt: _n, responseStatus: _r, ...rest } = d;
          return { ...rest, url: w.url, secretEncrypted: w.secretEncrypted };
        });
      },
      async markDelivered(id, responseStatus) {
        const d = deliveries.get(id);
        if (d) Object.assign(d, { status: 'delivered', responseStatus });
      },
      async markFailed(id, responseStatus, nextAttemptAt) {
        const d = deliveries.get(id);
        if (!d) return;
        d.responseStatus = responseStatus;
        if (nextAttemptAt) d.nextAttemptAt = nextAttemptAt.getTime();
        else d.status = 'dead';
      },
    },

    chainEvents: {
      async enqueue({ source, externalId, payload }) {
        const key = `${source}:${externalId}`;
        if ([...chainEvents.values()].some((e) => e.key === key)) return false;
        const id = randomUUID();
        chainEvents.set(id, { id, key, attempts: 0, payload, status: 'pending', due: Date.now() });
        return true;
      },
      async claimDue(limit, leaseSeconds) {
        const now = Date.now();
        return [...chainEvents.values()]
          .filter((e) => (e.status === 'pending' || e.status === 'processing') && e.due <= now)
          .slice(0, limit)
          .map((e) => {
            Object.assign(e, {
              status: 'processing',
              attempts: e.attempts + 1,
              due: now + leaseSeconds * 1000,
            });
            return { id: e.id, attempts: e.attempts, payload: e.payload };
          });
      },
      async markDone(id) {
        const e = chainEvents.get(id);
        if (e) e.status = 'done';
      },
      async markFailed(id, error, nextAttemptAt) {
        const e = chainEvents.get(id);
        if (!e) return;
        Object.assign(e, { error, status: nextAttemptAt ? 'pending' : 'dead' });
        if (nextAttemptAt) e.due = nextAttemptAt.getTime();
      },
    },

    async ping() {},
  };
}
