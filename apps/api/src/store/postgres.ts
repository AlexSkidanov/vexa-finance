import postgres from 'postgres';
import {
  HandleConflict,
  type ActivityItem,
  type EventRow,
  type MovementRow,
  type TransferRow,
  type ApiKeyRow,
  type HandleRecord,
  type IdempotencyBegin,
  type PasskeyRow,
  type ProfileRow,
  type Store,
} from './types.js';

/**
 * Store backed by Supabase Postgres over the session pooler. The API connects
 * as the database owner, so row-level security doesn't apply here. RLS guards
 * clients that talk to Supabase directly, and this code checks ownership
 * explicitly in every query that touches a user's rows.
 */
export function createPostgresStore(url: string): Store & { close(): Promise<void> } {
  const sql = postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // The Supabase pooler doesn't support prepared statements in transaction
    // mode; turning them off keeps us portable across both pooler modes.
    prepare: false,
    onnotice: () => {},
    transform: { undefined: null },
  });

  const toProfile = (r: postgres.Row): ProfileRow => ({
    userId: r.user_id,
    handle: r.handle,
    solanaPubkey: r.solana_pubkey,
    elgamalPubkey: r.elgamal_pubkey,
    kycStatus: r.kyc_status,
    tier: r.tier,
    createdAt: r.created_at,
  });

  const toApiKey = (r: postgres.Row): ApiKeyRow => ({
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    prefix: r.prefix,
    environment: r.environment,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  });

  const toTransfer = (r: postgres.Row): TransferRow => ({
    id: r.id,
    fromOwnerId: r.from_owner_id,
    fromPubkey: r.from_pubkey,
    toOwnerId: r.to_owner_id,
    toHandle: r.to_handle,
    toPubkey: r.to_pubkey,
    ciphertext: r.ciphertext ?? {},
    mode: r.mode,
    status: r.status,
    txSig: r.tx_sig,
    signatures: r.signatures ?? [],
    memoCiphertext: r.memo_ciphertext ? new Uint8Array(r.memo_ciphertext) : null,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
  });

  const toMovement = (r: postgres.Row): MovementRow => ({
    id: r.id,
    ownerId: r.owner_id,
    txSig: r.tx_sig,
    status: r.status,
    ...(r.destination ? { destination: r.destination } : {}),
    createdAt: r.created_at,
  });

  const toPasskey = (r: postgres.Row): PasskeyRow => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    publicKey: new Uint8Array(r.public_key as Buffer),
    counter: Number(r.counter),
    transports: r.transports,
    deviceType: r.device_type,
    backedUp: r.backed_up,
  });

  return {
    profiles: {
      async get(userId) {
        const [row] = await sql`select * from public.profiles where user_id = ${userId}`;
        return row ? toProfile(row) : null;
      },

      async findByHandle(handle) {
        const [row] = await sql`select * from public.profiles where handle = ${handle}`;
        return row ? toProfile(row) : null;
      },

      async claimHandle({ userId, handle, solanaPubkey, elgamalPubkey }) {
        try {
          const [row] = await sql`
            select * from public.claim_handle(${userId}, ${handle}, ${solanaPubkey}, ${elgamalPubkey})`;
          return toProfile(row!);
        } catch (e) {
          if (e instanceof postgres.PostgresError) {
            if (e.message === 'handle_already_claimed')
              throw new HandleConflict('handle_already_claimed');
            if (e.code === '23505') {
              if (e.constraint_name === 'handles_pkey') throw new HandleConflict('handle_taken');
              if (e.constraint_name === 'profiles_solana_pubkey_key')
                throw new HandleConflict('pubkey_in_use');
            }
          }
          throw e;
        }
      },
    },

    handles: {
      async resolve(handle) {
        const [row] = await sql`
          select h.handle, h.owner_kind as kind,
                 coalesce(p.solana_pubkey, a.solana_pubkey) as solana_pubkey,
                 p.elgamal_pubkey
          from public.handles h
          left join public.profiles p on p.handle = h.handle
          left join public.agents a on a.handle = h.handle and a.status <> 'revoked'
          where h.handle = ${handle}`;
        // Agents get their ElGamal key in Phase 3; until then only users resolve.
        if (!row?.solana_pubkey || !row.elgamal_pubkey) return null;
        return {
          handle: row.handle,
          kind: row.kind,
          solanaPubkey: row.solana_pubkey,
          elgamalPubkey: row.elgamal_pubkey,
        } satisfies HandleRecord;
      },
    },

    apiKeys: {
      async create({ ownerId, name, prefix, keyHash, environment }) {
        const [row] = await sql`
          insert into public.api_keys (owner_id, name, prefix, key_hash, environment)
          values (${ownerId}, ${name}, ${prefix}, ${keyHash}, ${environment})
          returning *`;
        return toApiKey(row!);
      },
      async list(ownerId) {
        const rows = await sql`
          select * from public.api_keys where owner_id = ${ownerId} order by created_at desc`;
        return rows.map(toApiKey);
      },
      async revoke(ownerId, id) {
        const rows = await sql`
          update public.api_keys set revoked_at = now()
          where id = ${id} and owner_id = ${ownerId} and revoked_at is null
          returning id`;
        return rows.length > 0;
      },
      async authenticate(keyHash) {
        const [row] = await sql`
          update public.api_keys set last_used_at = now()
          where key_hash = ${keyHash} and revoked_at is null
          returning *`;
        return row ? toApiKey(row) : null;
      },
    },

    idempotency: {
      async begin({ principal, key, method, path, requestHash }): Promise<IdempotencyBegin> {
        // Clear out an expired record for this key first so it can be reused.
        await sql`
          delete from public.idempotency_keys
          where principal = ${principal} and key = ${key} and expires_at < now()`;
        const inserted = await sql`
          insert into public.idempotency_keys (principal, key, method, path, request_hash)
          values (${principal}, ${key}, ${method}, ${path}, ${requestHash})
          on conflict (principal, key) do nothing
          returning key`;
        if (inserted.length > 0) return { kind: 'new' };

        const [row] = await sql`
          select * from public.idempotency_keys where principal = ${principal} and key = ${key}`;
        if (!row) return { kind: 'new' };
        if (row.request_hash !== requestHash || row.method !== method || row.path !== path) {
          return { kind: 'mismatch' };
        }
        if (row.state === 'in_progress') return { kind: 'in_progress' };
        return { kind: 'replay', status: row.response_status, body: row.response_body };
      },
      async complete(principal, key, status, body) {
        await sql`
          update public.idempotency_keys
          set state = 'completed', response_status = ${status}, response_body = ${sql.json(body as postgres.JSONValue)}
          where principal = ${principal} and key = ${key}`;
      },
      async release(principal, key) {
        await sql`
          delete from public.idempotency_keys
          where principal = ${principal} and key = ${key} and state = 'in_progress'`;
      },
    },

    passkeys: {
      async listForUser(userId) {
        const rows = await sql`select * from public.webauthn_credentials where user_id = ${userId}`;
        return rows.map(toPasskey);
      },
      async get(id) {
        const [row] = await sql`select * from public.webauthn_credentials where id = ${id}`;
        return row ? toPasskey(row) : null;
      },
      async insert(p) {
        await sql`
          insert into public.webauthn_credentials
            (id, user_id, name, public_key, counter, transports, device_type, backed_up)
          values (${p.id}, ${p.userId}, ${p.name}, ${Buffer.from(p.publicKey)}, ${p.counter},
                  ${p.transports}, ${p.deviceType}, ${p.backedUp})`;
      },
      async markUsed(id, counter) {
        await sql`
          update public.webauthn_credentials
          set counter = ${counter}, last_used_at = now() where id = ${id}`;
      },
      async createChallenge({ userId, kind, challenge }) {
        const [row] = await sql`
          insert into public.webauthn_challenges (user_id, kind, challenge)
          values (${userId}, ${kind}, ${challenge}) returning id`;
        return row!.id as string;
      },
      async consumeChallenge(id, kind) {
        const [row] = await sql`
          delete from public.webauthn_challenges
          where id = ${id} and kind = ${kind} and expires_at > now()
          returning user_id, challenge`;
        return row ? { userId: row.user_id, challenge: row.challenge } : null;
      },
    },

    money: {
      async createTransfer(t) {
        const [row] = await sql`
          insert into public.transfers
            (from_owner_id, from_pubkey, to_owner_id, to_handle, to_pubkey, ciphertext, mode, status)
          values (${t.fromOwnerId}, ${t.fromPubkey}, ${t.toOwnerId}, ${t.toHandle}, ${t.toPubkey},
                  '{}'::jsonb, ${t.mode}, 'pending')
          returning *`;
        return toTransfer(row!);
      },
      async getTransfer(id, ownerId) {
        const [row] = await sql`
          select * from public.transfers where id = ${id} and from_owner_id = ${ownerId}`;
        return row ? toTransfer(row) : null;
      },
      async markTransferSubmitted(id) {
        await sql`update public.transfers set status = 'submitted' where id = ${id} and status = 'pending'`;
      },
      async settleTransfer(id, t) {
        const [row] = await sql`
          update public.transfers
          set status = 'settled', ciphertext = ${sql.json(t.ciphertext)}, tx_sig = ${t.txSig},
              signatures = ${t.signatures},
              memo_ciphertext = ${t.memoCiphertext ? Buffer.from(t.memoCiphertext) : null}
          where id = ${id}
          returning *`;
        return toTransfer(row!);
      },
      async failTransfer(id, reason, signatures) {
        await sql`
          update public.transfers set status = 'failed', failure_reason = ${reason}, signatures = ${signatures}
          where id = ${id}`;
      },
      async recordDeposit({ ownerId, txSig, status }) {
        const [row] = await sql`
          insert into public.deposits (owner_id, tx_sig, status) values (${ownerId}, ${txSig}, ${status})
          returning *`;
        return toMovement(row!);
      },
      async recordWithdrawal({ ownerId, destination, txSig, status }) {
        const [row] = await sql`
          insert into public.withdrawals (owner_id, destination, tx_sig, status)
          values (${ownerId}, ${destination}, ${txSig}, ${status})
          returning *`;
        return toMovement(row!);
      },
      async activity(userId, { limit, before }) {
        const cutoff = before ?? new Date('9999-01-01');
        const [transfers, deposits, withdrawals] = await Promise.all([
          sql`
            select * from public.transfers
            where (from_owner_id = ${userId} or to_owner_id = ${userId})
              and status = 'settled' and created_at < ${cutoff}
            order by created_at desc limit ${limit}`,
          sql`
            select * from public.deposits
            where owner_id = ${userId} and created_at < ${cutoff}
            order by created_at desc limit ${limit}`,
          sql`
            select * from public.withdrawals
            where owner_id = ${userId} and created_at < ${cutoff}
            order by created_at desc limit ${limit}`,
        ]);
        const items: ActivityItem[] = [
          ...transfers.map((r) => {
            const transfer = toTransfer(r);
            return {
              kind: 'transfer' as const,
              direction:
                transfer.fromOwnerId === userId ? ('sent' as const) : ('received' as const),
              transfer,
            };
          }),
          ...deposits.map((r) => ({ kind: 'deposit' as const, movement: toMovement(r) })),
          ...withdrawals.map((r) => ({ kind: 'withdrawal' as const, movement: toMovement(r) })),
        ];
        const at = (i: ActivityItem) =>
          i.kind === 'transfer' ? i.transfer.createdAt : i.movement.createdAt;
        return items.sort((a, b) => at(b).getTime() - at(a).getTime()).slice(0, limit);
      },
    },

    events: {
      async emit(ownerId, type, data) {
        const [row] = await sql`
          insert into public.events (owner_id, type, data)
          values (${ownerId}, ${type}, ${sql.json(data as postgres.JSONValue)})
          returning *`;
        return {
          id: row!.id,
          ownerId: row!.owner_id,
          type: row!.type,
          data: row!.data,
          createdAt: row!.created_at,
        } satisfies EventRow;
      },
    },

    async ping() {
      await sql`select 1`;
    },

    close: () => sql.end({ timeout: 5 }),
  };
}
