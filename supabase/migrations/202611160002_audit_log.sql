-- LOT 2: append-only audit trail for sensitive tenant operations.
-- Audit rows are written by triggers so no code path can skip them.
-- actor_user_id is auth.uid() and is null for system/service operations.

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  site_id uuid not null,
  actor_user_id uuid,
  action text not null check (length(action) between 1 and 80),
  entity_type text not null check (length(entity_type) between 1 and 40),
  entity_id text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz not null default now()
);

create index if not exists audit_log_site_time_idx
  on public.audit_log(site_id, occurred_at desc, id desc);

alter table public.audit_log enable row level security;

-- Role helper kept out of the exposed schema, like private.has_site_membership.
create or replace function private.has_site_role(p_site_id uuid, p_roles text[])
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
      and m.role = any (p_roles)
  );
$$;

revoke all on function private.has_site_role(uuid, text[]) from public, anon;
grant execute on function private.has_site_role(uuid, text[]) to authenticated;

create policy "owners and admins can read audit log"
on public.audit_log for select to authenticated
using (private.has_site_role(site_id, array['owner', 'admin']));

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

-- Immutability: nobody (including service_role) can alter or remove entries.
create or replace function private.audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '42501', message = 'audit_log is append-only';
end;
$$;

create trigger audit_log_no_update
before update or delete on public.audit_log
for each row execute function private.audit_log_immutable();

create trigger audit_log_no_truncate
before truncate on public.audit_log
for each statement execute function private.audit_log_immutable();

create or replace function private.write_audit(
  p_site_id uuid, p_action text, p_entity_type text, p_entity_id text, p_details jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log(site_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_site_id, (select auth.uid()), p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

revoke all on function private.write_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- Sites
create or replace function private.audit_sites()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(new.id, 'site.created', 'site', new.id::text,
    jsonb_build_object('name', new.name, 'default_currency', new.default_currency));
  return null;
end;
$$;

create trigger audit_sites_insert
after insert on public.sites
for each row execute function private.audit_sites();

-- Memberships
create or replace function private.audit_memberships()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.site_id, 'member.added', 'membership', new.user_id::text,
      jsonb_build_object('role', new.role, 'status', new.status));
  elsif new.role is distinct from old.role or new.status is distinct from old.status then
    perform private.write_audit(new.site_id, 'member.updated', 'membership', new.user_id::text,
      jsonb_build_object('from', jsonb_build_object('role', old.role, 'status', old.status),
                         'to', jsonb_build_object('role', new.role, 'status', new.status)));
  end if;
  return null;
end;
$$;

create trigger audit_memberships_write
after insert or update on public.site_memberships
for each row execute function private.audit_memberships();

-- Invitations
create or replace function private.audit_invitations()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.site_id, 'invitation.created', 'invitation', new.id::text,
      jsonb_build_object('email', new.email, 'role', new.role));
  elsif new.status is distinct from old.status then
    perform private.write_audit(new.site_id, 'invitation.' || new.status, 'invitation', new.id::text,
      jsonb_build_object('email', new.email, 'role', new.role));
  end if;
  return null;
end;
$$;

create trigger audit_invitations_write
after insert or update on public.site_invitations
for each row execute function private.audit_invitations();

-- Routers / Gateways (heartbeat-driven online/offline flips are not audited).
create or replace function private.audit_routers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.site_id, 'router.registered', 'router', new.id::text,
      jsonb_build_object('name', new.name, 'gateway_kind', new.gateway_kind));
  elsif new.status is distinct from old.status then
    if new.status = 'revoked' then
      perform private.write_audit(new.site_id, 'gateway.revoked', 'router', new.id::text,
        jsonb_build_object('name', new.name));
    elsif old.status = 'revoked' and new.status = 'pending' then
      perform private.write_audit(new.site_id, 'gateway.reenrollment_started', 'router', new.id::text,
        jsonb_build_object('name', new.name));
    elsif new.status = 'suspended' or old.status = 'suspended' then
      perform private.write_audit(new.site_id, 'router.status_changed', 'router', new.id::text,
        jsonb_build_object('from', old.status, 'to', new.status));
    end if;
  end if;
  return null;
end;
$$;

create trigger audit_routers_write
after insert or update on public.routers
for each row execute function private.audit_routers();
