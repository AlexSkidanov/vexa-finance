-- Phase 3: agents.
--
-- An agent's Solana key is an MPC key held by NEAR (v1.signer), derived for
-- the policy contract and the path vexa-agent-{id}; its spend policy is
-- enforced by that contract. These tables mirror what the API needs to build
-- and track agent payments. Nothing here is a key or an amount.

alter table public.agents
  add column name            text check (char_length(name) <= 64),
  -- The agent's confidential cUSDC account and the durable nonce its payments use.
  add column cusdc_account   text check (cusdc_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  add column nonce_account   text check (nonce_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Ed25519 key the agent software authorizes its payment requests with.
  add column authority       text check (authority ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  add column elgamal_pubkey  text;

-- Which payment index each agent payment used. The agent's Pedersen openings
-- derive from the index, and its daily-limit proof covers the last 24 hours
-- of payments by index, so the SDK needs the transfer behind each index to
-- decrypt its amount locally. Kept out of `transfers`, which holds no numbers.
create table public.agent_payments (
  transfer_id    uuid primary key references public.transfers (id) on delete cascade,
  agent_id       uuid not null references public.agents (id) on delete cascade,
  payment_index  integer not null check (payment_index >= 0),
  created_at     timestamptz not null default now(),
  unique (agent_id, payment_index)
);

-- Every step an agent takes, for the owner's live trace view: an x402
-- request, the payment it required, the policy check, the payment, the
-- retry. Details describe the step (URL, recipient, outcome); never an amount.
create table public.agent_traces (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references public.agents (id) on delete cascade,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  request_id  text check (char_length(request_id) <= 128),
  step        text not null check (step in (
                'request', 'payment_required', 'quote', 'policy_check', 'paid',
                'retried', 'completed', 'failed')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index agent_traces_agent_idx on public.agent_traces (agent_id, created_at desc);
create index agent_payments_agent_idx on public.agent_payments (agent_id, payment_index desc);

alter table public.agent_payments enable row level security;
alter table public.agent_traces enable row level security;

create policy "payments of own agents" on public.agent_payments
  for select to authenticated using (
    exists (select 1 from public.agents a
            where a.id = agent_payments.agent_id and a.owner_id = (select auth.uid()))
  );

create policy "traces of own agents" on public.agent_traces
  for select to authenticated using (owner_id = (select auth.uid()));

revoke insert, update, delete on public.agent_payments, public.agent_traces from anon, authenticated;
