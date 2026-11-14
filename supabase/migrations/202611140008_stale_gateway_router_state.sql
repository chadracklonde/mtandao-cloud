-- When a Gateway stops heartbeating, its router state becomes unknown.
create or replace function public.mark_stale_gateways_offline()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.routers
  set status = 'offline',
      router_connection_status = 'unknown',
      updated_at = now()
  where status = 'online'
    and last_seen_at < now() - interval '3 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_stale_gateways_offline() from public;
revoke all on function public.mark_stale_gateways_offline() from anon, authenticated;
