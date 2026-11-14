-- Harden tenant helper visibility and align grants with the current Data API defaults.
-- Keep helper functions out of the exposed public API schema.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.has_site_membership(p_site_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.site_memberships m
    where m.site_id = p_site_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

revoke all on function private.has_site_membership(uuid) from public, anon;
grant execute on function private.has_site_membership(uuid) to authenticated;

drop policy if exists "members can read their sites" on public.sites;
create policy "members can read their sites"
on public.sites for select to authenticated
using (private.has_site_membership(id));

drop policy if exists "members can read site memberships" on public.site_memberships;
create policy "members can read site memberships"
on public.site_memberships for select to authenticated
using (private.has_site_membership(site_id));

drop policy if exists "site members can read routers" on public.routers;
create policy "site members can read routers"
on public.routers for select to authenticated
using (private.has_site_membership(site_id));

drop function if exists public.has_site_membership(uuid);

-- These tables must never be readable with the public anon key.
revoke all on all tables in schema public from anon;

-- Cover the gateway_enrollments -> routers foreign key for deletes/updates.
create index if not exists gateway_enrollments_router_id_idx
  on public.gateway_enrollments(router_id);
