-- Follow-ups from the Supabase database advisor.

-- Trigger functions have no business being callable through /rest/v1/rpc.
-- Postgres invokes triggers and event triggers without checking EXECUTE, so
-- revoking it only closes the RPC path.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;

-- `rls_auto_enable` is the platform's event trigger that turns RLS on for new
-- public tables. Keep it, but don't expose it over RPC.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- Cover the foreign keys the advisor found without an index. Without these,
-- deleting an agent or a user scans `transfers` in full.
create index transfers_to_agent_idx on public.transfers (to_agent_id, created_at desc);
create index transfers_to_handle_idx on public.transfers (to_handle);
create index webauthn_challenges_user_idx on public.webauthn_challenges (user_id);
create index webauthn_challenges_expiry_idx on public.webauthn_challenges (expires_at);
