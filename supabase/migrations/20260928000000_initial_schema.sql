-- =============================================================================
-- Vexa initial schema
--
-- Ground rules, enforced here and in review:
--   * No private keys, ever. Users' keys are derived client-side from their
--     passkey. Only public keys land in this database.
--   * No plaintext amounts. Transfers store ElGamal ciphertexts and proof
--     references. There is deliberately no numeric amount column on
--     `transfers`, and there must never be one.
--   * Every table has row-level security enabled. Clients using the anon or
--     authenticated role can read their own rows and nothing else; all writes
--     go through the API with the service role.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.kyc_status as enum ('none', 'pending', 'approved', 'rejected');
create type public.handle_owner_kind as enum ('user', 'agent');
create type public.agent_status as enum ('active', 'paused', 'revoked');
create type public.transfer_mode as enum ('standard', 'stealth');
create type public.transfer_status as enum (
  'pending',     -- prepared, waiting for the client's signature
  'submitted',   -- sent to Solana, not yet confirmed
  'settled',     -- confirmed on-chain
  'failed',      -- rejected on-chain or expired
  -- stealth mode only
  'routing',     -- funds sent to the one-time stealth address, 1Click swap requested
  'shielded',    -- sitting in the Zcash shielded pool
  'returning',   -- swapping back to USDC toward the recipient
  'refunded'     -- a leg timed out and funds went back to the sender
);
create type public.api_environment as enum ('live', 'test');
create type public.idempotency_state as enum ('in_progress', 'completed');
create type public.webhook_delivery_status as enum ('pending', 'delivered', 'failed', 'dead');
create type public.webauthn_challenge_kind as enum ('registration', 'authentication');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Handles
--
-- One namespace shared by users and agents, so `@name.vexa` always resolves to
-- exactly one account. Stored in canonical form: lowercase, no `@`, no suffix.
-- Format and reserved-word rules live in @vexa/core; the check below is a
-- backstop.
-- ---------------------------------------------------------------------------

create table public.handles (
  handle      text primary key
              check (handle ~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$'
                     and length(handle) between 3 and 20
                     and handle !~ '[-_]{2,}'),
  owner_kind  public.handle_owner_kind not null,
  created_at  timestamptz not null default now()
);

comment on table public.handles is
  'Global handle registry for users and agents. Canonical bare names only.';

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  handle          text unique references public.handles (handle) on update cascade,
  -- Base58 Solana address derived client-side from the user's passkey.
  solana_pubkey   text unique check (solana_pubkey ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Base64 Ristretto255 point. Public by design: senders encrypt amounts to it.
  elgamal_pubkey  text check (elgamal_pubkey ~ '^[A-Za-z0-9+/]{43}=$'),
  kyc_status      public.kyc_status not null default 'none',
  tier            smallint not null default 0 check (tier between 0 and 4),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A handle is only claimable together with both keys; they are set atomically.
  constraint profiles_handle_requires_keys
    check ((handle is null) = (solana_pubkey is null) and (handle is null) = (elgamal_pubkey is null))
);

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Every new auth user gets an empty profile.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Agents and spend policies
-- ---------------------------------------------------------------------------

create table public.agents (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  handle          text unique references public.handles (handle) on update cascade,
  -- Policy id in the NEAR policy contract.
  near_policy_id  text unique,
  -- Solana address derived by NEAR chain signatures (path vexa-agent-{id}).
  solana_pubkey   text unique check (solana_pubkey ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  status          public.agent_status not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index agents_owner_idx on public.agents (owner_id);
create trigger agents_touch before update on public.agents
  for each row execute function public.touch_updated_at();

-- Policies are versioned and append-only, so the history of what an agent was
-- allowed to do is never lost. The NEAR contract is the source of truth for
-- enforcement; this table mirrors it for the dashboard.
--
-- Limits are configuration, not balances: they are public on NEAR anyway.
create table public.policies (
  id                  uuid primary key default gen_random_uuid(),
  agent_id            uuid not null references public.agents (id) on delete cascade,
  version             integer not null check (version > 0),
  -- USDC base units (6 decimals).
  daily_limit         bigint not null check (daily_limit >= 0),
  max_per_request     bigint not null check (max_per_request >= 0),
  allowed_domains     text[] not null default '{}',
  allowed_recipients  text[] not null default '{}',
  created_at          timestamptz not null default now(),
  unique (agent_id, version),
  check (max_per_request <= daily_limit)
);

-- ---------------------------------------------------------------------------
-- Transfers
--
-- Amounts exist only as ciphertexts produced by the sender's SDK:
--   ciphertext       JSON of base64 ElGamal ciphertexts (source, destination,
--                    and auditor handles for the lo/hi amount halves)
--   memo_ciphertext  optional memo, encrypted client-side to the recipient
-- ---------------------------------------------------------------------------

create table public.transfers (
  id               uuid primary key default gen_random_uuid(),
  from_owner_id    uuid references auth.users (id) on delete set null,
  from_agent_id    uuid references public.agents (id) on delete set null,
  from_pubkey      text not null,
  to_owner_id      uuid references auth.users (id) on delete set null,
  to_agent_id      uuid references public.agents (id) on delete set null,
  to_handle        text references public.handles (handle) on update cascade,
  to_pubkey        text not null,
  ciphertext       jsonb not null,
  proof_ref        text,
  mode             public.transfer_mode not null default 'standard',
  status           public.transfer_status not null default 'pending',
  tx_sig           text unique,
  memo_ciphertext  bytea,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index transfers_from_owner_idx on public.transfers (from_owner_id, created_at desc);
create index transfers_to_owner_idx on public.transfers (to_owner_id, created_at desc);
create index transfers_from_agent_idx on public.transfers (from_agent_id, created_at desc);
create trigger transfers_touch before update on public.transfers
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- View keys (read access for auditors, scoped to a time range)
-- ---------------------------------------------------------------------------

create table public.view_keys (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  label          text,
  scope_from     timestamptz not null,
  scope_to       timestamptz not null,
  -- Wrapped with VIEW_KEY_ENCRYPTION_KEY (AES-256-GCM) by the API.
  encrypted_key  bytea not null,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now(),
  check (scope_from < scope_to)
);

create index view_keys_owner_idx on public.view_keys (owner_id);

-- ---------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------

create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  name          text not null check (length(name) between 1 and 64),
  -- First 12 characters, for display only (vx_live_4Hq2).
  prefix        text not null,
  -- HMAC-SHA256(API_KEY_ENCRYPTION_KEY, key), hex. The key itself is never stored.
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  environment   public.api_environment not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index api_keys_owner_idx on public.api_keys (owner_id);

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------

create table public.webhooks (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  url               text not null check (url ~ '^https://'),
  -- Per-endpoint signing secret, wrapped with WEBHOOK_SIGNING_SECRET.
  secret_encrypted  bytea not null,
  events            text[] not null,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index webhooks_owner_idx on public.webhooks (owner_id);
create trigger webhooks_touch before update on public.webhooks
  for each row execute function public.touch_updated_at();

create table public.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  webhook_id       uuid not null references public.webhooks (id) on delete cascade,
  event_id         uuid not null,
  event_type       text not null,
  -- Event payloads carry ids, statuses and ciphertexts, never plaintext amounts.
  payload          jsonb not null,
  status           public.webhook_delivery_status not null default 'pending',
  attempt          integer not null default 0,
  response_status  integer,
  next_attempt_at  timestamptz not null default now(),
  delivered_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (webhook_id, event_id)
);

create index webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Idempotency
--
-- `principal` is the user id. Keys are scoped per principal, so two users
-- picking the same UUID can't collide.
-- ---------------------------------------------------------------------------

create table public.idempotency_keys (
  principal        uuid not null,
  key              text not null check (length(key) between 8 and 255),
  method           text not null,
  path             text not null,
  request_hash     text not null,
  state            public.idempotency_state not null default 'in_progress',
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '24 hours',
  primary key (principal, key)
);

create index idempotency_keys_expiry_idx on public.idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Passkeys (WebAuthn)
-- ---------------------------------------------------------------------------

create table public.webauthn_credentials (
  -- base64url credential id as returned by the authenticator
  id            text primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  name          text,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_type   text not null,
  backed_up     boolean not null default false,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index webauthn_credentials_user_idx on public.webauthn_credentials (user_id);

create table public.webauthn_challenges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete cascade,
  kind        public.webauthn_challenge_kind not null,
  challenge   text not null,
  expires_at  timestamptz not null default now() + interval '5 minutes',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Handle claim: one atomic step
--
-- Registers the handle and binds it with both public keys to the profile. It
-- fails, and changes nothing, if the handle is taken, the user already has a
-- handle, or the Solana key already belongs to another account.
-- ---------------------------------------------------------------------------

create or replace function public.claim_handle(
  p_user_id uuid,
  p_handle text,
  p_solana_pubkey text,
  p_elgamal_pubkey text
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.profiles;
  existing text;
begin
  -- Lock the caller's profile row first so two concurrent claims by the same
  -- user serialize here instead of both passing the check below.
  select handle into existing from public.profiles where user_id = p_user_id for update;
  if existing is not null then
    raise exception 'handle_already_claimed' using errcode = 'P0001';
  end if;

  insert into public.handles (handle, owner_kind) values (p_handle, 'user');

  insert into public.profiles (user_id, handle, solana_pubkey, elgamal_pubkey)
  values (p_user_id, p_handle, p_solana_pubkey, p_elgamal_pubkey)
  on conflict (user_id) do update
    set handle = excluded.handle,
        solana_pubkey = excluded.solana_pubkey,
        elgamal_pubkey = excluded.elgamal_pubkey
  returning * into result;

  return result;
end;
$$;

revoke all on function public.claim_handle(uuid, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Clients may read their own rows. Every write goes through the API with the
-- service role, which bypasses RLS. Tables without a policy are invisible to
-- clients entirely.
-- ---------------------------------------------------------------------------

alter table public.handles              enable row level security;
alter table public.profiles             enable row level security;
alter table public.agents               enable row level security;
alter table public.policies             enable row level security;
alter table public.transfers            enable row level security;
alter table public.view_keys            enable row level security;
alter table public.api_keys             enable row level security;
alter table public.webhooks             enable row level security;
alter table public.webhook_deliveries   enable row level security;
alter table public.idempotency_keys     enable row level security;
alter table public.webauthn_credentials enable row level security;
alter table public.webauthn_challenges  enable row level security;

create policy "own profile" on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));

create policy "own agents" on public.agents
  for select to authenticated using (owner_id = (select auth.uid()));

create policy "policies of own agents" on public.policies
  for select to authenticated using (
    exists (select 1 from public.agents a
            where a.id = policies.agent_id and a.owner_id = (select auth.uid()))
  );

create policy "transfers sent or received" on public.transfers
  for select to authenticated using (
    from_owner_id = (select auth.uid())
    or to_owner_id = (select auth.uid())
    or exists (select 1 from public.agents a
               where a.owner_id = (select auth.uid())
                 and (a.id = transfers.from_agent_id or a.id = transfers.to_agent_id))
  );

create policy "own view keys" on public.view_keys
  for select to authenticated using (owner_id = (select auth.uid()));

create policy "own api keys" on public.api_keys
  for select to authenticated using (owner_id = (select auth.uid()));

create policy "own webhooks" on public.webhooks
  for select to authenticated using (owner_id = (select auth.uid()));

create policy "deliveries of own webhooks" on public.webhook_deliveries
  for select to authenticated using (
    exists (select 1 from public.webhooks w
            where w.id = webhook_deliveries.webhook_id and w.owner_id = (select auth.uid()))
  );

create policy "own passkeys" on public.webauthn_credentials
  for select to authenticated using (user_id = (select auth.uid()));

-- Secrets stay server-side even for their owner. Supabase grants table-wide
-- SELECT to client roles, and a column-level REVOKE does nothing while a
-- table-level grant exists, so we revoke the table and grant back only the
-- safe columns.
revoke select on public.api_keys from anon, authenticated;
grant select (id, owner_id, name, prefix, environment, last_used_at, revoked_at, created_at)
  on public.api_keys to authenticated;

revoke select on public.view_keys from anon, authenticated;
grant select (id, owner_id, label, scope_from, scope_to, revoked_at, created_at)
  on public.view_keys to authenticated;

revoke select on public.webhooks from anon, authenticated;
grant select (id, owner_id, url, events, active, created_at, updated_at)
  on public.webhooks to authenticated;

revoke select on public.webauthn_credentials from anon, authenticated;
grant select (id, user_id, name, transports, device_type, backed_up, created_at, last_used_at)
  on public.webauthn_credentials to authenticated;

-- Server-only tables: no client access at any level.
revoke all on public.idempotency_keys, public.webauthn_challenges from anon, authenticated;

-- Clients never write directly.
revoke insert, update, delete on all tables in schema public from anon, authenticated;
