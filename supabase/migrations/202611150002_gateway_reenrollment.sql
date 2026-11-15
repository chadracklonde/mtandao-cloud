-- Re-enroll a previously revoked router with a fresh one-time token.
-- All previous permanent credentials remain revoked.
create or replace function public.reenroll_gateway(
  p_site_id uuid,
  p_router_id uuid,
  p_enrollment_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_router public.routers%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if coalesce(p_enrollment_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid enrollment token hash' using errcode = '22023';
  end if;

  select sm.role into v_role
  from public.site_memberships sm
  where sm.site_id = p_site_id
    and sm.user_id = v_actor
    and sm.status = 'active';

  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'Insufficient permission to re-enroll Gateway' using errcode = '42501';
  end if;

  select r.* into v_router
  from public.routers r
  where r.id = p_router_id and r.site_id = p_site_id
  for update;

  if not found then
    raise exception 'Router not found in this site' using errcode = 'P0002';
  end if;

  if v_router.status <> 'revoked' then
    raise exception 'Only revoked routers can be re-enrolled' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.gateway_credentials gc
    where gc.router_id = p_router_id and gc.revoked_at is null
  ) then
    raise exception 'Router has an active Gateway credential' using errcode = '23505';
  end if;

  insert into public.gateway_enrollments(router_id, token_hash, expires_at, created_by)
  values (p_router_id, p_enrollment_token_hash, now() + interval '15 minutes', v_actor);

  update public.routers
  set status = 'pending',
      router_connection_status = 'unknown',
      router_last_seen_at = null,
      updated_at = now()
  where id = p_router_id;

  return p_router_id;
end;
$$;

revoke all on function public.reenroll_gateway(uuid, uuid, text) from public, anon;
grant execute on function public.reenroll_gateway(uuid, uuid, text) to authenticated;
