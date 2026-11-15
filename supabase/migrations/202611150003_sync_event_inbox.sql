-- Durable, tenant-scoped inbox for offline client events.
create table if not exists public.sync_events (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null,
  device_id uuid not null,
  event_type text not null check (length(event_type) between 1 and 120),
  schema_version integer not null check (schema_version >= 1),
  occurred_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  idempotency_key text,
  received_at timestamptz not null default now(),
  primary key (site_id, id),
  check (idempotency_key is null or length(idempotency_key) <= 200)
);

create index if not exists sync_events_site_received_idx
  on public.sync_events(site_id, received_at desc);
create index if not exists sync_events_site_device_occurred_idx
  on public.sync_events(site_id, device_id, occurred_at);

alter table public.sync_events enable row level security;

create policy "site members can submit sync events"
on public.sync_events for insert
to authenticated
with check (public.has_site_membership(site_id));

create policy "site members can read sync acknowledgements"
on public.sync_events for select
to authenticated
using (public.has_site_membership(site_id));

revoke all on public.sync_events from anon, authenticated;
grant insert, select on public.sync_events to authenticated;

create or replace function public.ingest_sync_events(
  p_site_id uuid,
  p_events jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_inserted integer;
  v_ids uuid[];
begin
  if auth.uid() is null or not public.has_site_membership(p_site_id) then
    raise exception using errcode = '42501', message = 'site access denied';
  end if;

  if jsonb_typeof(p_events) <> 'array' then
    raise exception using errcode = '22023', message = 'events must be an array';
  end if;

  v_count := jsonb_array_length(p_events);
  if v_count < 1 or v_count > 100 then
    raise exception using errcode = '22023', message = 'batch must contain between 1 and 100 events';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_events) e(value)
    where jsonb_typeof(e.value) <> 'object'
      or (e.value->>'id') is null
      or (e.value->>'site_id') is distinct from p_site_id::text
      or (e.value->>'device_id') is null
      or coalesce(e.value->>'event_type', '') = ''
      or length(e.value->>'event_type') > 120
      or coalesce((e.value->>'schema_version')::integer, 0) < 1
      or (e.value->>'occurred_at') is null
      or jsonb_typeof(e.value->'payload') <> 'object'
      or length(coalesce(e.value->>'idempotency_key', '')) > 200
  ) then
    raise exception using errcode = '22023', message = 'one or more events are invalid';
  end if;

  insert into public.sync_events (
    site_id, id, device_id, event_type, schema_version,
    occurred_at, payload, idempotency_key
  )
  select
    p_site_id,
    (e.value->>'id')::uuid,
    (e.value->>'device_id')::uuid,
    e.value->>'event_type',
    (e.value->>'schema_version')::integer,
    (e.value->>'occurred_at')::timestamptz,
    e.value->'payload',
    nullif(e.value->>'idempotency_key', '')
  from jsonb_array_elements(p_events) e(value)
  on conflict (site_id, id) do nothing;

  get diagnostics v_inserted = row_count;

  select array_agg((e.value->>'id')::uuid)
  into v_ids
  from jsonb_array_elements(p_events) e(value);

  return jsonb_build_object(
    'site_id', p_site_id,
    'received_count', v_count,
    'inserted_count', v_inserted,
    'acknowledged_event_ids', to_jsonb(v_ids)
  );
end;
$$;

revoke all on function public.ingest_sync_events(uuid, jsonb) from public, anon;
grant execute on function public.ingest_sync_events(uuid, jsonb) to authenticated;
