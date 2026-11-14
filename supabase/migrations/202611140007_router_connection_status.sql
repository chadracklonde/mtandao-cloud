-- Track the RouterOS link separately from the Gateway process heartbeat.
alter table public.routers
  add column if not exists router_connection_status text not null default 'unknown'
    check (router_connection_status in ('unknown','online','unavailable')),
  add column if not exists router_last_seen_at timestamptz;

create or replace function public.record_gateway_heartbeat(
  p_gateway_token_hash text,
  p_router_connection_status text default 'unknown'
)
returns table(
  router_id uuid,
  site_id uuid,
  status text,
  last_seen_at timestamptz,
  router_connection_status text,
  router_last_seen_at timestamptz
)
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
  if p_router_connection_status not in ('unknown','online','unavailable') then
    raise exception 'Invalid router connection status' using errcode = '22023';
  end if;

  select c.* into v_credential
  from public.gateway_credentials c
  where c.token_hash = p_gateway_token_hash and c.revoked_at is null
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

  update public.gateway_credentials set last_used_at = v_now where id = v_credential.id;
  update public.routers
  set status = 'online',
      last_seen_at = v_now,
      router_connection_status = p_router_connection_status,
      router_last_seen_at = case when p_router_connection_status = 'online' then v_now else router_last_seen_at end,
      updated_at = v_now
  where id = v_router.id;

  return query
  select v_router.id, v_router.site_id, 'online'::text, v_now,
         p_router_connection_status,
         case when p_router_connection_status = 'online' then v_now else v_router.router_last_seen_at end;
end;
$$;

revoke all on function public.record_gateway_heartbeat(text) from public, anon, authenticated;
revoke all on function public.record_gateway_heartbeat(text,text) from public, authenticated;
grant execute on function public.record_gateway_heartbeat(text,text) to anon;
