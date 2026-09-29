-- Stealth transfers: USDC leaves the sender for a one-time address, crosses
-- the Zcash shielded pool through NEAR Intents (1Click), and returns as USDC
-- at another one-time address that pays the recipient confidentially.
--
-- One row per route, driven by the API's stealth worker. It holds addresses
-- and statuses, never amounts: the worker reads amounts from chain and from
-- 1Click's own records while it routes, and keeps them in memory only.

create type public.stealth_status as enum (
  'awaiting_funds',   -- prepared; the sender's withdrawal to the entry address hasn't landed
  'routing',          -- USDC → ZEC in flight at 1Click
  'shielded',         -- ZEC in Vexa's shielded wallet, waiting out a random delay
  'returning',        -- ZEC → USDC in flight at 1Click
  'settling',         -- USDC at the exit address, being paid to the recipient
  'settled',
  'refunding',        -- something failed; paying the sender back
  'refunded',
  'failed'            -- needs a person: see last_error
);

create table public.stealth_routes (
  transfer_id          uuid primary key references public.transfers (id) on delete cascade,
  sender_id            uuid not null references auth.users (id) on delete cascade,
  status               public.stealth_status not null default 'awaiting_funds',
  -- One-time Solana addresses, derived from STEALTH_ROUTE_SEED and the route id.
  entry_address        text not null,
  exit_address         text not null,
  -- The shielded Zcash address (unified, Orchard) this route's ZEC lands in.
  zcash_address        text,
  -- 1Click deposit addresses: their status endpoint is keyed by these.
  leg1_deposit_address text,
  leg2_deposit_address text,
  zcash_txid           text,
  -- Where the money ends up: the recipient, or the sender when refunding.
  recipient_cusdc      text not null,
  sender_cusdc         text not null,
  -- Tries at the ZEC → USDC leg (1Click can refund it back to the wallet).
  leg2_attempts        integer not null default 0,
  attempts             integer not null default 0,
  next_attempt_at      timestamptz not null default now(),
  lease_until          timestamptz,
  last_error           text,
  signatures           text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index stealth_routes_due_idx on public.stealth_routes (next_attempt_at)
  where status not in ('settled', 'refunded', 'failed');
create trigger stealth_routes_touch before update on public.stealth_routes
  for each row execute function public.touch_updated_at();

alter table public.stealth_routes enable row level security;
create policy "own stealth routes" on public.stealth_routes
  for select to authenticated using (sender_id = (select auth.uid()));
revoke insert, update, delete on public.stealth_routes from anon, authenticated;
