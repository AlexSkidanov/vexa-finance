-- =============================================================================
-- Phase 2: deposits, withdrawals, transfer execution, events and the indexer.
--
-- Same ground rules as the initial schema: no plaintext amounts. Deposit and
-- withdrawal amounts are public on-chain, but they're still not copied here;
-- a row points at its transaction signature instead.
-- =============================================================================

create type public.movement_status as enum ('submitted', 'confirmed', 'failed');

create table public.deposits (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  tx_sig      text unique,
  status      public.movement_status not null default 'submitted',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index deposits_owner_idx on public.deposits (owner_id, created_at desc);
create trigger deposits_touch before update on public.deposits
  for each row execute function public.touch_updated_at();

create table public.withdrawals (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  -- The USDC token account the funds were released to.
  destination  text not null,
  tx_sig       text unique,
  status       public.movement_status not null default 'submitted',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index withdrawals_owner_idx on public.withdrawals (owner_id, created_at desc);
create trigger withdrawals_touch before update on public.withdrawals
  for each row execute function public.touch_updated_at();

-- Every transaction of a multi-transaction transfer, in order, and why it
-- failed if it did.
alter table public.transfers
  add column signatures text[] not null default '{}',
  add column failure_reason text;

-- ---------------------------------------------------------------------------
-- Events: the log outbound webhooks are fanned out from.
-- ---------------------------------------------------------------------------

create table public.events (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  type        text not null,
  -- Ids, statuses, signatures and ciphertexts. Never a plaintext amount.
  data        jsonb not null,
  created_at  timestamptz not null default now()
);
create index events_owner_idx on public.events (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Indexer queue: inbound chain notifications (Alchemy), processed with retries
-- and parked in 'dead' after too many failures.
-- ---------------------------------------------------------------------------

create table public.chain_events (
  id               uuid primary key default gen_random_uuid(),
  source           text not null,
  external_id      text not null,
  payload          jsonb not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'processing', 'done', 'dead')),
  attempts         integer not null default 0,
  last_error       text,
  next_attempt_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (source, external_id)
);
create index chain_events_due_idx on public.chain_events (next_attempt_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.deposits     enable row level security;
alter table public.withdrawals  enable row level security;
alter table public.events       enable row level security;
alter table public.chain_events enable row level security;

create policy "own deposits" on public.deposits
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "own withdrawals" on public.withdrawals
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "own events" on public.events
  for select to authenticated using (owner_id = (select auth.uid()));

revoke insert, update, delete on public.deposits, public.withdrawals, public.events
  from anon, authenticated;
revoke all on public.chain_events from anon, authenticated;
