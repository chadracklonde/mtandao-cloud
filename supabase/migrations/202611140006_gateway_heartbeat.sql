-- Authenticated Gateway heartbeat and stale-device state transition.
create or replace function public.record_gateway_heartbeat(p_gateway_token_hash text)
returns table(router_id uuid, site_id uuid, status text, last_seen_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential public.gateway_credentials%rowtype;
  v_router public.routers%rowtype;
  v_now timestamptz := now();
begin
  if coalesce(p_gateway_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Gateway credential' using errcode = '28000';
  end if;

  select c.* into v_credential
  from public.gateway_credentials c
  where c.token_hash = p_gateway_token_hash
    and c.revoked_at is null
  for update;

  if not found then
    raise exception 'Gateway credential is invalid or revoked' using errcode = '28000';
  end if;

  select r.* into v_router
  from public.routers r
  where r.id = v_credential.router_id
  for update;

  if not found or v_router.status in ('suspended', 'revoked') then
    raise exception 'Gateway is suspended or revoked' using errcode = '28000';
  end if;

  update public.gateway_credentials
  set last_used_at = v_now
  where id = v_credential.id;

  update public.routers
  set status = 'online', last_seen_at = v_now, updated_at = v_now
  where id = v_router.id;

  return query
  select v_router.id, v_router.site_id, 'online'::text, v_now;
end;
$$;

revoke all on function public.record_gateway_heartbeat(text) from public;
revoke all on function public.record_gateway_heartbeat(text) from authenticated;
grant execute on function public.record_gateway_heartbeat(text) to anon;

-- Run this function from a trusted scheduler. A Gateway is stale after 3 minutes.
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
  set status = 'offline', updated_at = now()
  where status = 'online'
    and last_seen_at < now() - interval '3 minutes';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_stale_gateways_offline() from public;
revoke all on function public.mark_stale_gateways_offline() from anon, authenticated;
