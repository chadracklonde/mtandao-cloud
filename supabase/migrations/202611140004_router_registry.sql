-- Router registry and one-time gateway enrollment.
create table if not exists public.routers (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  router_identity text not null,
  routeros_version text,
  gateway_kind text not null check (gateway_kind in ('android','linux')),
  status text not null default 'pending'
    check (status in ('pending','online','offline','suspended','revoked')),
  last_seen_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id, router_identity),
  unique(id, site_id)
);

create index if not exists routers_site_status_idx
  on public.routers(site_id, status);

create table if not exists public.gateway_enrollments (
  id uuid primary key default gen_random_uuid(),
  router_id uuid not null references public.routers(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

alter table public.routers enable row level security;
alter table public.gateway_enrollments enable row level security;

create policy "site members can read routers"
on public.routers for select to authenticated
using (public.has_site_membership(site_id));

revoke insert, update, delete on public.routers from anon, authenticated;
revoke all on public.gateway_enrollments from anon, authenticated;

create or replace function public.register_router(
  p_site_id uuid,
  p_name text,
  p_router_identity text,
  p_gateway_kind text,
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
  v_router_id uuid;
  v_token text := trim(coalesce(p_enrollment_token_hash, ''));
  v_identity text := trim(coalesce(p_router_identity, ''));
  v_name text := trim(coalesce(p_name, ''));
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select role into v_role from public.site_memberships
  where site_id = p_site_id and user_id = v_actor and status = 'active';

  if v_role is null or v_role not in ('owner','admin','technician') then
    raise exception 'Insufficient permission to register routers' using errcode = '42501';
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Invalid router name' using errcode = '22023';
  end if;
  if length(v_identity) < 2 or length(v_identity) > 128 then
    raise exception 'Invalid RouterOS identity' using errcode = '22023';
  end if;
  if p_gateway_kind not in ('android','linux') then
    raise exception 'Invalid gateway kind' using errcode = '22023';
  end if;
  if length(v_token) <> 64 or v_token !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid enrollment token hash' using errcode = '22023';
  end if;

  insert into public.routers(site_id,name,router_identity,gateway_kind,status,created_by)
  values (p_site_id,v_name,v_identity,p_gateway_kind,'pending',v_actor)
  returning id into v_router_id;

  insert into public.gateway_enrollments(router_id,token_hash,expires_at,created_by)
  values (v_router_id,v_token,now() + interval '15 minutes',v_actor);

  return v_router_id;
end;
$$;

revoke all on function public.register_router(uuid,text,text,text,text) from public;
revoke all on function public.register_router(uuid,text,text,text,text) from anon;
grant execute on function public.register_router(uuid,text,text,text,text) to authenticated;
