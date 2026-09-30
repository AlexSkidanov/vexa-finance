import postgres from 'postgres';
import {
  HandleConflict,
  type ActivityItem,
  type AgentRow,
  type AgentTraceRow,
  type StealthRouteRow,
  type ViewKeyRow,
  type PolicyRow,
  type EventRow,
  type MovementRow,
  type TransferRow,
  type WebhookRow,
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
    fromAgentId: r.from_agent_id,
    toAgentId: r.to_agent_id,
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

  const toPolicy = (r: postgres.Row): PolicyRow => ({
    version: r.version,
    maxPerRequest: BigInt(r.max_per_request),
    dailyLimit: BigInt(r.daily_limit),
    allowedRecipients: r.allowed_recipients ?? [],
    allowedDomains: r.allowed_domains ?? [],
  });

  // An agent with its latest policy version.
  const agentSelect = sql`
    select a.*, p.version, p.max_per_request, p.daily_limit, p.allowed_recipients, p.allowed_domains
    from public.agents a
    join lateral (
      select * from public.policies where agent_id = a.id order by version desc limit 1
    ) p on true`;

  const toAgent = (r: postgres.Row): AgentRow => ({
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    solanaPubkey: r.solana_pubkey,
    cusdcAccount: r.cusdc_account,
    nonceAccount: r.nonce_account,
    authority: r.authority,
    elgamalPubkey: r.elgamal_pubkey,
    status: r.status,
    policy: toPolicy(r),
    createdAt: r.created_at,
  });

  const toTrace = (r: postgres.Row): AgentTraceRow => ({
    id: r.id,
    agentId: r.agent_id,
    requestId: r.request_id,
    step: r.step,
    detail: r.detail ?? {},
    createdAt: r.created_at,
  });

  const toRoute = (r: postgres.Row): StealthRouteRow => ({
    transferId: r.transfer_id,
    senderId: r.sender_id,
    status: r.status,
    entryAddress: r.entry_address,
    exitAddress: r.exit_address,
    zcashAddress: r.zcash_address,
    leg1DepositAddress: r.leg1_deposit_address,
    leg2DepositAddress: r.leg2_deposit_address,
    zcashTxid: r.zcash_txid,
    leg2Attempts: r.leg2_attempts,
    recipientCusdc: r.recipient_cusdc,
    senderCusdc: r.sender_cusdc,
    attempts: r.attempts,
    lastError: r.last_error,
    signatures: r.signatures ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const toViewKey = (r: postgres.Row): ViewKeyRow => ({
    id: r.id,
    ownerId: r.owner_id,
    label: r.label,
    scopeFrom: r.scope_from,
    scopeTo: r.scope_to,
    revokedAt: r.revoked_at,
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

  const toWebhook = (r: postgres.Row): WebhookRow => ({
    id: r.id,
    ownerId: r.owner_id,
    url: r.url,
    events: r.events,
    active: r.active,
    secretEncrypted: new Uint8Array(r.secret_encrypted),
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

      async findBySolanaPubkey(pubkey) {
        const [row] = await sql`select * from public.profiles where solana_pubkey = ${pubkey}`;
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
            (from_owner_id, from_agent_id, from_pubkey, to_owner_id, to_agent_id, to_handle,
             to_pubkey, ciphertext, mode, status)
          values (${t.fromOwnerId}, ${t.fromAgentId ?? null}, ${t.fromPubkey}, ${t.toOwnerId},
                  ${t.toAgentId ?? null}, ${t.toHandle}, ${t.toPubkey}, '{}'::jsonb, ${t.mode},
                  'pending')
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
      async setTransferStatus(id, status) {
        await sql`update public.transfers set status = ${status} where id = ${id}`;
      },
      async addTransferCiphertext(id, ciphertext) {
        await sql`
          update public.transfers set ciphertext = ciphertext || ${sql.json(ciphertext)}
          where id = ${id}`;
      },
      async transferById(id) {
        const [row] = await sql`select * from public.transfers where id = ${id}`;
        return row ? toTransfer(row) : null;
      },
      async recordAgentPayment(p) {
        await sql`
          insert into public.agent_payments (transfer_id, agent_id, payment_index)
          values (${p.transferId}, ${p.agentId}, ${p.index})`;
      },
      async agentPayments(agentId, fromIndex) {
        const rows = await sql`
          select p.payment_index, t.* from public.agent_payments p
          join public.transfers t on t.id = p.transfer_id
          where p.agent_id = ${agentId} and p.payment_index >= ${fromIndex} and t.status = 'settled'
          order by p.payment_index`;
        return rows.map((r) => ({ index: r.payment_index as number, transfer: toTransfer(r) }));
      },
      async recordDeposit({ ownerId, txSig, status }) {
        const [row] = await sql`
          insert into public.deposits (owner_id, tx_sig, status) values (${ownerId}, ${txSig}, ${status})
          returning *`;
        return toMovement(row!);
      },
      async hasDeposit(txSig) {
        const rows = await sql`select 1 from public.deposits where tx_sig = ${txSig}`;
        return rows.length > 0;
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

    agents: {
      async create(a) {
        return sql.begin(async (tx) => {
          await tx`
            insert into public.agents
              (id, owner_id, name, near_policy_id, solana_pubkey, cusdc_account, nonce_account,
               authority, elgamal_pubkey)
            values (${a.id}, ${a.ownerId}, ${a.name}, ${a.id}, ${a.solanaPubkey}, ${a.cusdcAccount},
                    ${a.nonceAccount}, ${a.authority}, ${a.elgamalPubkey})`;
          await tx`
            insert into public.policies
              (agent_id, version, max_per_request, daily_limit, allowed_recipients, allowed_domains)
            values (${a.id}, 1, ${a.policy.maxPerRequest.toString()}, ${a.policy.dailyLimit.toString()},
                    ${a.policy.allowedRecipients}, ${a.policy.allowedDomains})`;
          const [row] = await tx`${agentSelect} where a.id = ${a.id}`;
          return toAgent(row!);
        });
      },
      async get(ownerId, id) {
        const [row] = await sql`${agentSelect} where a.id = ${id} and a.owner_id = ${ownerId}`;
        return row ? toAgent(row) : null;
      },
      async list(ownerId) {
        const rows = await sql`${agentSelect} where a.owner_id = ${ownerId} order by a.created_at`;
        return rows.map(toAgent);
      },
      async countLive(ownerId) {
        const [row] = await sql`
          select count(*)::int as n from public.agents
          where owner_id = ${ownerId} and status <> 'revoked'`;
        return row!.n as number;
      },
      async setPolicy(agentId, p) {
        const [row] = await sql`
          insert into public.policies
            (agent_id, version, max_per_request, daily_limit, allowed_recipients, allowed_domains)
          select ${agentId}, coalesce(max(version), 0) + 1, ${p.maxPerRequest.toString()},
                 ${p.dailyLimit.toString()}, ${p.allowedRecipients}, ${p.allowedDomains}
          from public.policies where agent_id = ${agentId}
          returning *`;
        return toPolicy(row!);
      },
      async setStatus(agentId, status) {
        await sql`update public.agents set status = ${status} where id = ${agentId}`;
      },
      async trace(t) {
        const [row] = await sql`
          insert into public.agent_traces (agent_id, owner_id, request_id, step, detail)
          values (${t.agentId}, ${t.ownerId}, ${t.requestId}, ${t.step}, ${sql.json(t.detail as never)})
          returning *`;
        return toTrace(row!);
      },
      async traces(agentId, { limit, requestId }) {
        const rows = await sql`
          select * from public.agent_traces
          where agent_id = ${agentId} ${requestId ? sql`and request_id = ${requestId}` : sql``}
          order by created_at desc limit ${limit}`;
        return rows.map(toTrace);
      },
    },

    stealth: {
      async create(r) {
        const [row] = await sql`
          insert into public.stealth_routes
            (transfer_id, sender_id, entry_address, exit_address, recipient_cusdc, sender_cusdc)
          values (${r.transferId}, ${r.senderId}, ${r.entryAddress}, ${r.exitAddress},
                  ${r.recipientCusdc}, ${r.senderCusdc})
          returning *`;
        return toRoute(row!);
      },
      async get(transferId, senderId) {
        const [row] = await sql`
          select * from public.stealth_routes
          where transfer_id = ${transferId} and sender_id = ${senderId}`;
        return row ? toRoute(row) : null;
      },
      async claimDue(limit, leaseSeconds) {
        const rows = await sql`
          update public.stealth_routes r
          set lease_until = now() + ${leaseSeconds} * interval '1 second'
          where r.transfer_id in (
            select transfer_id from public.stealth_routes
            where status not in ('settled', 'refunded', 'failed')
              and next_attempt_at <= now()
              and (lease_until is null or lease_until <= now())
            order by next_attempt_at
            limit ${limit}
            for update skip locked
          )
          returning r.*`;
        return rows.map(toRoute);
      },
      async update(transferId, p) {
        const set: Record<string, unknown> = { lease_until: null };
        if (p.status) set.status = p.status;
        if (p.zcashAddress !== undefined) set.zcash_address = p.zcashAddress;
        if (p.leg1DepositAddress !== undefined) set.leg1_deposit_address = p.leg1DepositAddress;
        if (p.leg2DepositAddress !== undefined) set.leg2_deposit_address = p.leg2DepositAddress;
        if (p.zcashTxid !== undefined) set.zcash_txid = p.zcashTxid;
        if (p.attempts !== undefined) set.attempts = p.attempts;
        if (p.leg2Attempts !== undefined) set.leg2_attempts = p.leg2Attempts;
        if (p.lastError !== undefined) set.last_error = p.lastError?.slice(0, 1000) ?? null;
        if (p.signatures !== undefined) set.signatures = p.signatures;
        if (p.nextAttemptAt) set.next_attempt_at = p.nextAttemptAt;
        await sql`update public.stealth_routes set ${sql(set)} where transfer_id = ${transferId}`;
      },
    },

    viewKeys: {
      async create(v) {
        const [row] = await sql`
          insert into public.view_keys (id, owner_id, label, scope_from, scope_to, access_hash)
          values (${v.id}, ${v.ownerId}, ${v.label}, ${v.scopeFrom}, ${v.scopeTo}, ${v.accessHash})
          returning *`;
        return toViewKey(row!);
      },
      async list(ownerId) {
        const rows = await sql`
          select * from public.view_keys where owner_id = ${ownerId} order by created_at desc`;
        return rows.map(toViewKey);
      },
      async get(ownerId, id) {
        const [row] = await sql`
          select * from public.view_keys where id = ${id} and owner_id = ${ownerId}`;
        return row ? toViewKey(row) : null;
      },
      async revoke(ownerId, id) {
        return sql.begin(async (tx) => {
          const rows = await tx`
            update public.view_keys set revoked_at = now()
            where id = ${id} and owner_id = ${ownerId} and revoked_at is null
            returning id`;
          if (rows.length === 0) return false;
          await tx`delete from public.view_key_records where view_key_id = ${id}`;
          return true;
        });
      },
      async recordedTransferIds(id) {
        const rows = await sql`
          select transfer_id from public.view_key_records where view_key_id = ${id}`;
        return rows.map((r) => r.transfer_id as string);
      },
      async addRecords(key, records) {
        let added = 0;
        for (const r of records) {
          const rows = await sql`
            insert into public.view_key_records (view_key_id, transfer_id, record)
            select ${key.id}, t.id, ${Buffer.from(r.record)}
            from public.transfers t
            where t.id = ${r.transferId}
              and (t.from_owner_id = ${key.ownerId} or t.to_owner_id = ${key.ownerId})
              and t.created_at >= ${key.scopeFrom} and t.created_at < ${key.scopeTo}
            on conflict do nothing
            returning transfer_id`;
          added += rows.length;
        }
        return added;
      },
      async byAccessHash(hash) {
        const [row] = await sql`
          select * from public.view_keys where access_hash = ${hash} and revoked_at is null`;
        return row ? toViewKey(row) : null;
      },
      async exportRows(key) {
        const rows = await sql`
          select t.id, t.created_at, t.from_owner_id, t.from_pubkey, t.to_handle, t.to_pubkey,
                 t.tx_sig, r.record
          from public.view_key_records r
          join public.transfers t on t.id = r.transfer_id
          where r.view_key_id = ${key.id}
            and t.created_at >= ${key.scopeFrom} and t.created_at < ${key.scopeTo}
          order by t.created_at`;
        return rows.map((r) => {
          const sent = r.from_owner_id === key.ownerId;
          return {
            transferId: r.id,
            createdAt: r.created_at,
            direction: sent ? ('sent' as const) : ('received' as const),
            counterparty: sent ? (r.to_handle ?? r.to_pubkey) : r.from_pubkey,
            txSig: r.tx_sig,
            record: new Uint8Array(r.record),
          };
        });
      },
    },

    events: {
      async emit(ownerId, type, data) {
        return sql.begin(async (tx) => {
          const [row] = await tx`
            insert into public.events (owner_id, type, data)
            values (${ownerId}, ${type}, ${tx.json(data as postgres.JSONValue)})
            returning *`;
          const event: EventRow = {
            id: row!.id,
            ownerId: row!.owner_id,
            type: row!.type,
            data: row!.data,
            createdAt: row!.created_at,
          };
          const payload = {
            id: event.id,
            type: event.type,
            createdAt: event.createdAt.toISOString(),
            data: event.data,
          };
          await tx`
            insert into public.webhook_deliveries (webhook_id, event_id, event_type, payload)
            select id, ${event.id}, ${type}, ${tx.json(payload as postgres.JSONValue)}
            from public.webhooks
            where owner_id = ${ownerId} and active and ${type} = any(events)`;
          return event;
        }) as Promise<EventRow>;
      },
    },

    webhooks: {
      async create({ ownerId, url, events, secretEncrypted }) {
        const [row] = await sql`
          insert into public.webhooks (owner_id, url, events, secret_encrypted)
          values (${ownerId}, ${url}, ${events}, ${Buffer.from(secretEncrypted)})
          returning *`;
        return toWebhook(row!);
      },
      async list(ownerId) {
        const rows = await sql`
          select * from public.webhooks where owner_id = ${ownerId} and active order by created_at desc`;
        return rows.map(toWebhook);
      },
      async get(ownerId, id) {
        const [row] = await sql`
          select * from public.webhooks where owner_id = ${ownerId} and id = ${id} and active`;
        return row ? toWebhook(row) : null;
      },
      async remove(ownerId, id) {
        const rows = await sql`
          update public.webhooks set active = false
          where owner_id = ${ownerId} and id = ${id} and active returning id`;
        return rows.length > 0;
      },
      async claimDue(limit, leaseSeconds) {
        const rows = await sql`
          with due as (
            select d.id from public.webhook_deliveries d
            join public.webhooks w on w.id = d.webhook_id
            where d.status = 'pending' and d.next_attempt_at <= now() and w.active
            order by d.next_attempt_at
            limit ${limit}
            for update of d skip locked
          )
          update public.webhook_deliveries d
          set next_attempt_at = now() + make_interval(secs => ${leaseSeconds}), attempt = d.attempt + 1
          from due, public.webhooks w
          where d.id = due.id and w.id = d.webhook_id
          returning d.id, d.attempt, d.event_id, d.event_type, d.payload, w.url, w.secret_encrypted`;
        return rows.map((r) => ({
          id: r.id,
          attempt: r.attempt,
          eventId: r.event_id,
          eventType: r.event_type,
          payload: r.payload,
          url: r.url,
          secretEncrypted: new Uint8Array(r.secret_encrypted),
        }));
      },
      async markDelivered(id, responseStatus) {
        await sql`
          update public.webhook_deliveries
          set status = 'delivered', response_status = ${responseStatus}, delivered_at = now()
          where id = ${id}`;
      },
      async markFailed(id, responseStatus, nextAttemptAt) {
        await sql`
          update public.webhook_deliveries
          set status = ${nextAttemptAt ? 'pending' : 'dead'}, response_status = ${responseStatus},
              next_attempt_at = coalesce(${nextAttemptAt}, next_attempt_at)
          where id = ${id}`;
      },
    },

    chainEvents: {
      async enqueue({ source, externalId, payload }) {
        const rows = await sql`
          insert into public.chain_events (source, external_id, payload)
          values (${source}, ${externalId}, ${sql.json(payload as postgres.JSONValue)})
          on conflict (source, external_id) do nothing
          returning id`;
        return rows.length > 0;
      },
      async claimDue(limit, leaseSeconds) {
        const rows = await sql`
          update public.chain_events e
          set status = 'processing', attempts = e.attempts + 1,
              next_attempt_at = now() + make_interval(secs => ${leaseSeconds})
          where e.id in (
            select id from public.chain_events
            where (status = 'pending' and next_attempt_at <= now())
               or (status = 'processing' and next_attempt_at <= now())
            order by next_attempt_at
            limit ${limit}
            for update skip locked
          )
          returning e.id, e.attempts, e.payload`;
        return rows.map((r) => ({ id: r.id, attempts: r.attempts, payload: r.payload }));
      },
      async markDone(id) {
        await sql`update public.chain_events set status = 'done', last_error = null where id = ${id}`;
      },
      async markFailed(id, error, nextAttemptAt) {
        await sql`
          update public.chain_events
          set status = ${nextAttemptAt ? 'pending' : 'dead'}, last_error = ${error.slice(0, 1000)},
              next_attempt_at = coalesce(${nextAttemptAt}, next_attempt_at)
          where id = ${id}`;
      },
    },

    async ping() {
      await sql`select 1`;
    },

    close: () => sql.end({ timeout: 5 }),
  };
}
