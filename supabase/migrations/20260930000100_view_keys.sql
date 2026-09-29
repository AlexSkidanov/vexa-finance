-- View keys: read access for an auditor, scoped to a time range, revocable.
--
-- A view key is `vxview_<id>.<access secret>.<decryption key>`. The owner's
-- device re-encrypts each in-scope transfer (amount and memo) to the
-- decryption key and uploads only those ciphertexts. The API stores a hash of
-- the access secret to authorize exports and never sees the decryption key,
-- so it can't read what it serves.

alter table public.view_keys
  alter column encrypted_key drop not null,
  add column access_hash text unique check (access_hash ~ '^[0-9a-f]{64}$');

comment on column public.view_keys.encrypted_key is
  'Unused: view keys are never held by the API, only a hash of their access secret.';

create table public.view_key_records (
  view_key_id  uuid not null references public.view_keys (id) on delete cascade,
  transfer_id  uuid not null references public.transfers (id) on delete cascade,
  -- AES-256-GCM under a key derived from the view key: nonce ‖ ciphertext.
  record       bytea not null check (octet_length(record) <= 4096),
  created_at   timestamptz not null default now(),
  primary key (view_key_id, transfer_id)
);

alter table public.view_key_records enable row level security;

create policy "records of own view keys" on public.view_key_records
  for select to authenticated using (
    exists (select 1 from public.view_keys v
            where v.id = view_key_records.view_key_id and v.owner_id = (select auth.uid()))
  );

revoke insert, update, delete on public.view_key_records from anon, authenticated;
