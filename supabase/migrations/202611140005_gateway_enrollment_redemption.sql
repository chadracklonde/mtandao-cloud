-- One-time enrollment redemption and long-lived Gateway credentials.
create table if not exists public.gateway_credentials (
  id uuid primary key default gen_random_uuid(),
  router_id uuid not null references public.routers(id) on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists gateway_credentials_router_active_idx
  on public.gateway_credentials(router_id)
  where revoked_at is null;

alter table public.gateway_credentials enable row level security;
revoke all on public.gateway_credentials from anon, authenticated;

create or replace function public.redeem_gateway_enrollment(
  p_enrollment_token_hash text,
  p_gateway_token_hash text
)
returns table(router_id uuid, site_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enrollment public.gateway_enrollments%rowtype;
  v_site_id uuid;
begin
  if coalesce(p_enrollment_token_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_gateway_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid enrollment credentials' using errcode = '22023';
  end if;

  select e.* into v_enrollment
  from public.gateway_enrollments e
  where e.token_hash = p_enrollment_token_hash
  for update;

  if not found
     or v_enrollment.consumed_at is not null
     or v_enrollment.expires_at <= now() then
    raise exception 'Enrollment token is invalid, expired, or already used'
      using errcode = '28000';
  end if;

  select r.site_id into v_site_id
  from public.routers r
  where r.id = v_enrollment.router_id
    and r.status not in ('suspended', 'revoked')
  for update;

  if not found then
    raise exception 'Router is unavailable for enrollment' using errcode = '28000';
  end if;

  insert into public.gateway_credentials(router_id, token_hash)
  values (v_enrollment.router_id, p_gateway_token_hash);

  update public.gateway_enrollments
  set consumed_at = now()
  where id = v_enrollment.id;

  return query select v_enrollment.router_id, v_site_id;
end;
$$;

revoke all on function public.redeem_gateway_enrollment(text,text) from public;
revoke all on function public.redeem_gateway_enrollment(text,text) from authenticated;
grant execute on function public.redeem_gateway_enrollment(text,text) to anon;
