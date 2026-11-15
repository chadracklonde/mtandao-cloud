-- Revoke a Gateway and invalidate every credential and pending enrollment.
create or replace function public.revoke_gateway(p_site_id uuid, p_router_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_router_id uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select sm.role into v_role
  from public.site_memberships sm
  where sm.site_id = p_site_id
    and sm.user_id = v_actor
    and sm.status = 'active';

  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'Insufficient permission to revoke Gateway' using errcode = '42501';
  end if;

  select r.id into v_router_id
  from public.routers r
  where r.id = p_router_id and r.site_id = p_site_id
  for update;

  if not found then
    raise exception 'Router not found in this site' using errcode = 'P0002';
  end if;

  update public.gateway_credentials
  set revoked_at = coalesce(revoked_at, now())
  where router_id = v_router_id and revoked_at is null;

  update public.gateway_enrollments
  set consumed_at = coalesce(consumed_at, now())
  where router_id = v_router_id and consumed_at is null;

  update public.routers
  set status = 'revoked',
      router_connection_status = 'unknown',
      updated_at = now()
  where id = v_router_id;

  return v_router_id;
end;
$$;

revoke all on function public.revoke_gateway(uuid, uuid) from public, anon;
grant execute on function public.revoke_gateway(uuid, uuid) to authenticated;
