-- Initial tenant foundation. Apply to a fresh Supabase project.
create extension if not exists pgcrypto;

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  country_code char(2) not null default 'CD',
  default_currency char(3) not null default 'CDF'
    check (default_currency in ('CDF','USD')),
  timezone text not null default 'Africa/Lubumbashi',
  status text not null default 'active'
    check (status in ('active','suspended','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- user_id is the UUID from Supabase Auth; do not duplicate credentials here.
create table if not exists public.site_memberships (
  site_id uuid not null references public.sites(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','admin','manager','seller','technician','viewer')),
  status text not null default 'active'
    check (status in ('invited','active','suspended')),
  created_at timestamptz not null default now(),
  primary key (site_id,user_id)
);

create index if not exists site_memberships_user_idx
  on public.site_memberships(user_id, status);

-- SECURITY DEFINER avoids recursive RLS evaluation on site_memberships.
create or replace function public.has_site_membership(p_site_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.site_memberships m
    where m.site_id = p_site_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

alter table public.sites enable row level security;
alter table public.site_memberships enable row level security;

create policy "members can read their sites"
on public.sites for select
to authenticated
using (public.has_site_membership(id));

create policy "members can read site memberships"
on public.site_memberships for select
to authenticated
using (public.has_site_membership(site_id));

-- Site creation and owner membership must be performed transactionally
-- by a trusted server-side operation, not by unrestricted client inserts.
revoke insert, update, delete on public.sites from anon, authenticated;
revoke insert, update, delete on public.site_memberships from anon, authenticated;

grant select on public.sites to authenticated;
grant select on public.site_memberships to authenticated;
