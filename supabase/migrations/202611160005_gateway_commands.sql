-- LOT 5: typed command queue from the Cloud to Gateways.
-- Users enqueue commands through role-checked RPCs. A Gateway claims commands
-- with its permanent credential; each command is delivered at most once.

create table if not exists public.gateway_commands (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  router_id uuid not null references public.routers(id) on delete cascade,
  operation text not null check (operation in (
    'health.check', 'hotspot.voucher.create', 'hotspot.voucher.disable',
    'hotspot.profile.list', 'hotspot.active-sessions.list')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'succeeded', 'failed', 'expired', 'cancelled')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  delivered_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text check (error is null or length(error) <= 500),
  idempotency_key text check (idempotency_key is null or length(idempotency_key) between 1 and 200),
  created_by uuid,
  primary key (site_id, id),
  unique (id),
  check (expires_at > issued_at)
);

create unique index if not exists gateway_commands_idempotency_idx
  on public.gateway_commands(site_id, idempotency_key) where idempotency_key is not null;
create index if not exists gateway_commands_router_pending_idx
  on public.gateway_commands(router_id, issued_at, id) where status = 'pending';
create index if not exists gateway_commands_site_issued_idx
  on public.gateway_commands(site_id, issued_at desc, id desc);

alter table public.gateway_commands enable row level security;

-- Payloads can contain voucher codes: restricted to operational roles.
create policy "operators can read gateway commands"
on public.gateway_commands for select to authenticated
using (private.has_site_role(site_id, array['owner', 'admin', 'manager', 'technician']));

revoke all on public.gateway_commands from anon, authenticated;
grant select on public.gateway_commands to authenticated;

-- Which roles may enqueue which operation.
create or replace function private.command_roles(p_operation text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case
    when p_operation in ('hotspot.voucher.create', 'hotspot.voucher.disable')
      then array['owner', 'admin', 'manager']
    else array['owner', 'admin', 'manager', 'technician']
  end;
$$;

create or replace function private.validate_command_payload(p_operation text, p_payload jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be an object' using errcode = '22023';
  end if;
  if length(p_payload::text) > 4096 then
    raise exception 'payload is too large' using errcode = '22023';
  end if;

  if p_operation = 'hotspot.voucher.create' then
    if coalesce(jsonb_typeof(p_payload->'code'), '') <> 'string'
       or length(p_payload->>'code') not between 1 and 64
       or exists (select 1 from jsonb_object_keys(p_payload) k
                  where k not in ('code', 'profile', 'duration_minutes'))
       or (p_payload ? 'profile' and (jsonb_typeof(p_payload->'profile') <> 'string'
            or length(p_payload->>'profile') not between 1 and 120))
       or (p_payload ? 'duration_minutes' and (jsonb_typeof(p_payload->'duration_minutes') <> 'number'
            or (p_payload->>'duration_minutes')::numeric not between 1 and 525600
            or (p_payload->>'duration_minutes')::numeric <> trunc((p_payload->>'duration_minutes')::numeric))) then
      raise exception 'invalid voucher payload' using errcode = '22023';
    end if;
  elsif p_operation = 'hotspot.voucher.disable' then
    if coalesce(jsonb_typeof(p_payload->'code'), '') <> 'string'
       or length(p_payload->>'code') not between 1 and 64
       or exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'code') then
      raise exception 'invalid voucher payload' using errcode = '22023';
    end if;
  elsif p_operation in ('health.check', 'hotspot.profile.list', 'hotspot.active-sessions.list') then
    if p_payload <> '{}'::jsonb then
      raise exception 'this operation takes no payload' using errcode = '22023';
    end if;
  else
    raise exception 'unsupported operation' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.create_gateway_command(
  p_site_id uuid,
  p_router_id uuid,
  p_operation text,
  p_payload jsonb default '{}'::jsonb,
  p_ttl_seconds integer default 300,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_router public.routers%rowtype;
  v_existing public.gateway_commands%rowtype;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, private.command_roles(coalesce(p_operation, ''))) then
    raise exception 'Insufficient permission to send this command' using errcode = '42501';
  end if;

  perform private.validate_command_payload(p_operation, p_payload);
  if p_ttl_seconds is null or p_ttl_seconds not between 30 and 3600 then
    raise exception 'ttl must be between 30 and 3600 seconds' using errcode = '22023';
  end if;
  if v_key is not null and length(v_key) > 200 then
    raise exception 'idempotency key too long' using errcode = '22023';
  end if;

  select r.* into v_router
  from public.routers r
  where r.id = p_router_id and r.site_id = p_site_id
  for update;
  if not found then
    raise exception 'Router not found in this site' using errcode = 'P0002';
  end if;
  if v_router.status in ('suspended', 'revoked') then
    raise exception 'Router is suspended or revoked' using errcode = '22023';
  end if;

  if v_key is not null then
    select gc.* into v_existing
    from public.gateway_commands gc
    where gc.site_id = p_site_id and gc.idempotency_key = v_key;
    if found then
      if v_existing.router_id = p_router_id and v_existing.operation = p_operation
         and v_existing.payload = p_payload then
        return v_existing.id;
      end if;
      raise exception 'Idempotency key already used for a different command' using errcode = '23505';
    end if;
  end if;

  if (select count(*) from public.gateway_commands gc
      where gc.router_id = p_router_id and gc.status in ('pending', 'delivered')) >= 50 then
    raise exception 'Too many open commands for this router' using errcode = '53400';
  end if;

  insert into public.gateway_commands(
    site_id, router_id, operation, payload, issued_at, expires_at, idempotency_key, created_by)
  values (p_site_id, p_router_id, p_operation, p_payload, now(),
          now() + make_interval(secs => p_ttl_seconds), v_key, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.cancel_gateway_command(p_site_id uuid, p_command_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cmd public.gateway_commands%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select gc.* into v_cmd
  from public.gateway_commands gc
  where gc.site_id = p_site_id and gc.id = p_command_id
  for update;
  if not found then
    raise exception 'Command not found in this site' using errcode = 'P0002';
  end if;
  if not private.has_site_role(p_site_id, private.command_roles(v_cmd.operation)) then
    raise exception 'Insufficient permission to cancel this command' using errcode = '42501';
  end if;
  if v_cmd.status = 'cancelled' then
    return 'cancelled';
  end if;
  if v_cmd.status <> 'pending' then
    raise exception 'Only pending commands can be cancelled' using errcode = '22023';
  end if;

  update public.gateway_commands
  set status = 'cancelled', completed_at = now()
  where site_id = p_site_id and id = p_command_id;
  return 'cancelled';
end;
$$;

-- Moves overdue commands to their terminal state. Called lazily by the
-- Gateway-facing functions and safe to schedule.
create or replace function public.expire_gateway_commands()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending integer;
  v_delivered integer;
begin
  update public.gateway_commands
  set status = 'expired', completed_at = now()
  where status = 'pending' and expires_at <= now();
  get diagnostics v_pending = row_count;

  update public.gateway_commands
  set status = 'failed', completed_at = now(), error = 'gateway did not report a result'
  where status = 'delivered' and delivered_at < now() - interval '15 minutes';
  get diagnostics v_delivered = row_count;

  return v_pending + v_delivered;
end;
$$;

-- Gateway side -------------------------------------------------------------

create or replace function private.authenticate_gateway(p_gateway_token_hash text)
returns table(credential_id uuid, router_id uuid, site_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential public.gateway_credentials%rowtype;
  v_router public.routers%rowtype;
begin
  if coalesce(p_gateway_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Gateway credential' using errcode = '28000';
  end if;

  select c.* into v_credential
  from public.gateway_credentials c
  where c.token_hash = p_gateway_token_hash and c.revoked_at is null;
  if not found then
    raise exception 'Gateway credential is invalid or revoked' using errcode = '28000';
  end if;

  select r.* into v_router from public.routers r where r.id = v_credential.router_id;
  if not found or v_router.status in ('suspended', 'revoked') then
    raise exception 'Gateway is suspended or revoked' using errcode = '28000';
  end if;

  return query select v_credential.id, v_router.id, v_router.site_id;
end;
$$;

create or replace function public.claim_gateway_commands(
  p_gateway_token_hash text,
  p_limit integer default 10
)
returns table(
  command_id uuid, site_id uuid, gateway_id uuid, router_id uuid,
  operation text, issued_at timestamptz, expires_at timestamptz, payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
begin
  select * into v_auth from private.authenticate_gateway(p_gateway_token_hash);

  perform public.expire_gateway_commands();

  return query
  with picked as (
    select gc.site_id as s, gc.id as i
    from public.gateway_commands gc
    where gc.router_id = v_auth.router_id
      and gc.status = 'pending'
      and gc.expires_at > now()
    order by gc.issued_at, gc.id
    limit v_limit
    for update skip locked
  )
  update public.gateway_commands g
  set status = 'delivered', delivered_at = now()
  from picked
  where g.site_id = picked.s and g.id = picked.i
  returning g.id, g.site_id, v_auth.credential_id, g.router_id,
            g.operation, g.issued_at, g.expires_at, g.payload;
end;
$$;

create or replace function public.complete_gateway_command(
  p_gateway_token_hash text,
  p_command_id uuid,
  p_success boolean,
  p_result jsonb default '{}'::jsonb,
  p_error text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_cmd public.gateway_commands%rowtype;
  v_target text;
begin
  select * into v_auth from private.authenticate_gateway(p_gateway_token_hash);

  if p_success is null then
    raise exception 'success is required' using errcode = '22023';
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' or length(p_result::text) > 65536 then
    raise exception 'result must be an object of at most 64 KB' using errcode = '22023';
  end if;
  v_target := case when p_success then 'succeeded' else 'failed' end;

  select gc.* into v_cmd
  from public.gateway_commands gc
  where gc.id = p_command_id and gc.router_id = v_auth.router_id
  for update;
  if not found then
    raise exception 'Command not found for this Gateway' using errcode = 'P0002';
  end if;

  if v_cmd.status = v_target then
    return v_target; -- idempotent retry
  end if;
  if v_cmd.status <> 'delivered' then
    raise exception 'Command is not awaiting a result' using errcode = '22023';
  end if;

  update public.gateway_commands
  set status = v_target, completed_at = now(), result = p_result,
      error = case when p_success then null else left(coalesce(p_error, 'command failed'), 500) end
  where site_id = v_cmd.site_id and id = v_cmd.id;
  return v_target;
end;
$$;

-- A revoked or suspended router must never receive another command.
create or replace function private.cancel_commands_on_router_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('revoked', 'suspended') and new.status is distinct from old.status then
    update public.gateway_commands
    set status = 'cancelled', completed_at = now(), error = 'router ' || new.status
    where router_id = new.id and status in ('pending', 'delivered');
  end if;
  return null;
end;
$$;

create trigger routers_cancel_commands
after update of status on public.routers
for each row execute function private.cancel_commands_on_router_block();

-- Audit (payloads are never logged: they can contain voucher codes).
create or replace function private.audit_gateway_commands()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.site_id, 'command.created', 'gateway_command', new.id::text,
      jsonb_build_object('operation', new.operation, 'router_id', new.router_id));
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform private.write_audit(new.site_id, 'command.cancelled', 'gateway_command', new.id::text,
      jsonb_build_object('operation', new.operation, 'router_id', new.router_id));
  end if;
  return null;
end;
$$;

create trigger audit_gateway_commands_write
after insert or update on public.gateway_commands
for each row execute function private.audit_gateway_commands();

revoke all on function private.command_roles(text) from public, anon, authenticated;
revoke all on function private.validate_command_payload(text, jsonb) from public, anon, authenticated;
revoke all on function private.authenticate_gateway(text) from public, anon, authenticated;
revoke all on function private.cancel_commands_on_router_block() from public, anon, authenticated;
revoke all on function private.audit_gateway_commands() from public, anon, authenticated;

revoke all on function public.create_gateway_command(uuid, uuid, text, jsonb, integer, text) from public, anon;
revoke all on function public.cancel_gateway_command(uuid, uuid) from public, anon;
grant execute on function public.create_gateway_command(uuid, uuid, text, jsonb, integer, text) to authenticated;
grant execute on function public.cancel_gateway_command(uuid, uuid) to authenticated;

revoke all on function public.expire_gateway_commands() from public, anon, authenticated;
grant execute on function public.expire_gateway_commands() to service_role;

-- Gateways authenticate with their credential hash, like the heartbeat.
revoke all on function public.claim_gateway_commands(text, integer) from public, authenticated;
revoke all on function public.complete_gateway_command(text, uuid, boolean, jsonb, text) from public, authenticated;
grant execute on function public.claim_gateway_commands(text, integer) to anon;
grant execute on function public.complete_gateway_command(text, uuid, boolean, jsonb, text) to anon;
