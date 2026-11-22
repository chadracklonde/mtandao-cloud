-- LOT 1: idempotent processing of the sync inbox into business tables.
-- Event type supported in this lot: 'sale.recorded'.

alter table public.sync_events
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'processed', 'conflict', 'rejected')),
  add column if not exists processed_at timestamptz,
  add column if not exists process_error text;

create index if not exists sync_events_site_status_idx
  on public.sync_events(site_id, status)
  where status = 'pending';

create table if not exists public.sales (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null,
  source_event_id uuid not null,
  device_id uuid not null,
  amount numeric(14, 2) not null check (amount >= 0),
  currency char(3) not null check (currency in ('CDF', 'USD')),
  payment_method text not null check (payment_method in ('cash', 'mobile_money')),
  plan_name text check (plan_name is null or length(plan_name) <= 120),
  ticket_code text check (ticket_code is null or length(ticket_code) <= 64),
  sold_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (site_id, id),
  unique (site_id, source_event_id),
  foreign key (site_id, source_event_id) references public.sync_events(site_id, id)
);

create table if not exists public.tickets (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  code text not null check (length(code) between 1 and 64),
  sale_id uuid not null,
  status text not null default 'sold' check (status in ('sold', 'activated', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  primary key (site_id, id),
  unique (site_id, code),
  unique (site_id, sale_id),
  foreign key (site_id, sale_id) references public.sales(site_id, id)
);

create table if not exists public.cash_entries (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  sale_id uuid not null,
  direction text not null default 'in' check (direction in ('in', 'out')),
  amount numeric(14, 2) not null check (amount >= 0),
  currency char(3) not null check (currency in ('CDF', 'USD')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (site_id, id),
  unique (site_id, sale_id),
  foreign key (site_id, sale_id) references public.sales(site_id, id)
);

create table if not exists public.sync_conflicts (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  conflict_type text not null check (
    conflict_type in ('sale_mismatch', 'ticket_code_taken', 'concurrent_duplicate')
  ),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (site_id, id),
  unique (site_id, event_id),
  foreign key (site_id, event_id) references public.sync_events(site_id, id)
);

alter table public.sales enable row level security;
alter table public.tickets enable row level security;
alter table public.cash_entries enable row level security;
alter table public.sync_conflicts enable row level security;

create policy "site members can read sales"
on public.sales for select to authenticated
using (private.has_site_membership(site_id));

create policy "site members can read tickets"
on public.tickets for select to authenticated
using (private.has_site_membership(site_id));

create policy "site members can read cash entries"
on public.cash_entries for select to authenticated
using (private.has_site_membership(site_id));

create policy "site members can read sync conflicts"
on public.sync_conflicts for select to authenticated
using (private.has_site_membership(site_id));

-- Writes only happen through the SECURITY DEFINER processing functions.
revoke all on public.sales, public.tickets, public.cash_entries, public.sync_conflicts
  from anon, authenticated;
grant select on public.sales, public.tickets, public.cash_entries, public.sync_conflicts
  to authenticated;

-- Processes one pending event. Returns the final status.
-- Business writes of an event are atomic: any failure rolls them back and the
-- event is marked 'rejected'. Divergences are kept in sync_conflicts.
create or replace function private.process_sync_event(p_site_id uuid, p_event_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.sync_events%rowtype;
  v_sale_id uuid;
  v_amount numeric;
  v_currency text;
  v_method text;
  v_plan text;
  v_code text;
  v_sold_at timestamptz;
  v_existing public.sales%rowtype;
  v_status text := 'processed';
  v_conflict_type text;
  v_details jsonb := '{}'::jsonb;
begin
  select * into v_event
  from public.sync_events
  where site_id = p_site_id and id = p_event_id
  for update;

  if not found then
    return 'missing';
  end if;
  if v_event.status <> 'pending' then
    return v_event.status;
  end if;

  begin
    if v_event.event_type <> 'sale.recorded' then
      raise exception using errcode = '22023', message = 'unsupported event_type';
    end if;

    if coalesce(jsonb_typeof(v_event.payload->'amount'), '') <> 'number' then
      raise exception using errcode = '22023', message = 'amount must be a number';
    end if;

    v_sale_id := (v_event.payload->>'sale_id')::uuid;
    v_amount := (v_event.payload->>'amount')::numeric;
    v_currency := v_event.payload->>'currency';
    v_method := v_event.payload->>'payment_method';
    v_plan := nullif(btrim(v_event.payload->>'plan_name'), '');
    v_code := nullif(btrim(v_event.payload->>'ticket_code'), '');
    v_sold_at := coalesce((v_event.payload->>'sold_at')::timestamptz, v_event.occurred_at);

    if v_sale_id is null then
      raise exception using errcode = '22023', message = 'sale_id is required';
    end if;
    if v_amount < 0 then
      raise exception using errcode = '22023', message = 'amount must be >= 0';
    end if;
    if v_currency is null or v_currency not in ('CDF', 'USD') then
      raise exception using errcode = '22023', message = 'unsupported currency';
    end if;
    if v_method is null or v_method not in ('cash', 'mobile_money') then
      raise exception using errcode = '22023', message = 'unsupported payment_method';
    end if;

    select * into v_existing
    from public.sales
    where site_id = p_site_id and id = v_sale_id;

    if found then
      -- Same sale seen again: a no-op if identical, otherwise a conflict.
      if v_existing.amount = v_amount
         and v_existing.currency = v_currency
         and v_existing.payment_method = v_method
         and v_existing.ticket_code is not distinct from v_code then
        v_status := 'processed';
      else
        v_status := 'conflict';
        v_conflict_type := 'sale_mismatch';
        v_details := jsonb_build_object(
          'sale_id', v_sale_id,
          'existing_event_id', v_existing.source_event_id,
          'existing', jsonb_build_object(
            'amount', v_existing.amount, 'currency', v_existing.currency,
            'payment_method', v_existing.payment_method,
            'ticket_code', v_existing.ticket_code),
          'incoming', jsonb_build_object(
            'amount', v_amount, 'currency', v_currency,
            'payment_method', v_method, 'ticket_code', v_code)
        );
      end if;
    elsif v_code is not null and exists (
      select 1 from public.tickets t where t.site_id = p_site_id and t.code = v_code
    ) then
      v_status := 'conflict';
      v_conflict_type := 'ticket_code_taken';
      v_details := jsonb_build_object('sale_id', v_sale_id, 'ticket_code', v_code);
    else
      insert into public.sales (
        site_id, id, source_event_id, device_id, amount, currency,
        payment_method, plan_name, ticket_code, sold_at
      ) values (
        p_site_id, v_sale_id, v_event.id, v_event.device_id, v_amount, v_currency,
        v_method, v_plan, v_code, v_sold_at
      );

      if v_code is not null then
        insert into public.tickets (site_id, code, sale_id)
        values (p_site_id, v_code, v_sale_id);
      end if;

      if v_method = 'cash' then
        insert into public.cash_entries (site_id, sale_id, amount, currency, occurred_at)
        values (p_site_id, v_sale_id, v_amount, v_currency, v_sold_at);
      end if;
    end if;
  exception
    when unique_violation then
      -- Concurrent insert of the same sale or ticket code: business writes
      -- of this block are rolled back; keep the event for review.
      v_status := 'conflict';
      v_conflict_type := 'concurrent_duplicate';
      v_details := jsonb_build_object('error', sqlerrm);
    when others then
      update public.sync_events
      set status = 'rejected', processed_at = now(), process_error = left(sqlerrm, 500)
      where site_id = p_site_id and id = p_event_id;
      return 'rejected';
  end;

  if v_status = 'conflict' then
    insert into public.sync_conflicts (site_id, event_id, conflict_type, details)
    values (p_site_id, p_event_id, v_conflict_type, v_details)
    on conflict (site_id, event_id) do nothing;
  end if;

  update public.sync_events
  set status = v_status, processed_at = now(), process_error = null
  where site_id = p_site_id and id = p_event_id;

  return v_status;
end;
$$;

revoke all on function private.process_sync_event(uuid, uuid) from public, anon, authenticated;

-- Ingestion now processes newly inserted events in the same transaction.
create or replace function public.ingest_sync_events(
  p_site_id uuid,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_new uuid[];
  v_ids uuid[];
  v_id uuid;
  v_status text;
  v_processed integer := 0;
  v_conflicts integer := 0;
  v_rejected integer := 0;
begin
  if auth.uid() is null or not private.has_site_membership(p_site_id) then
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
      or coalesce(btrim(e.value->>'event_type'), '') = ''
      or length(e.value->>'event_type') > 120
      or coalesce((e.value->>'schema_version')::integer, 0) < 1
      or (e.value->>'occurred_at') is null
      or coalesce(jsonb_typeof(e.value->'payload'), '') <> 'object'
      or length(coalesce(e.value->>'idempotency_key', '')) > 200
  ) then
    raise exception using errcode = '22023', message = 'one or more events are invalid';
  end if;

  with ins as (
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
    on conflict (site_id, id) do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_new from ins;

  for v_id in
    select se.id
    from public.sync_events se
    where se.site_id = p_site_id and se.id = any(v_new)
    order by se.occurred_at, se.id
  loop
    v_status := private.process_sync_event(p_site_id, v_id);
    if v_status = 'processed' then v_processed := v_processed + 1;
    elsif v_status = 'conflict' then v_conflicts := v_conflicts + 1;
    elsif v_status = 'rejected' then v_rejected := v_rejected + 1;
    end if;
  end loop;

  select array_agg((e.value->>'id')::uuid)
  into v_ids
  from jsonb_array_elements(p_events) e(value);

  return jsonb_build_object(
    'site_id', p_site_id,
    'received_count', v_count,
    'inserted_count', coalesce(array_length(v_new, 1), 0),
    'processed_count', v_processed,
    'conflict_count', v_conflicts,
    'rejected_count', v_rejected,
    'acknowledged_event_ids', to_jsonb(v_ids)
  );
end;
$$;

revoke all on function public.ingest_sync_events(uuid, jsonb) from public, anon;
grant execute on function public.ingest_sync_events(uuid, jsonb) to authenticated;

-- Retry path for events left pending (for example inserted before this
-- migration). Intended for a trusted worker only.
create or replace function public.process_pending_sync_events(
  p_site_id uuid,
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_done integer := 0;
begin
  for v_id in
    select se.id
    from public.sync_events se
    where se.site_id = p_site_id and se.status = 'pending'
    order by se.occurred_at, se.id
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  loop
    perform private.process_sync_event(p_site_id, v_id);
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;

revoke all on function public.process_pending_sync_events(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.process_pending_sync_events(uuid, integer) to service_role;
