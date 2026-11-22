-- LOT 7: payments (sandbox provider) with idempotent webhooks and fulfillment.
-- A confirmed payment allocates a stock voucher, records the sale and queues the
-- activation command for the Gateway. Activation is only reported once the
-- Gateway confirms it; while the Gateway is absent the payment stays
-- "paid / activation_pending".

-- Plans know which RouterOS Hotspot profile their vouchers use.
alter table public.plans
  add column if not exists hotspot_profile text
    check (hotspot_profile is null or hotspot_profile ~ '^[A-Za-z0-9 _.-]{1,120}$');

drop function if exists public.create_plan(uuid, text, numeric, text, integer, integer);
create or replace function public.create_plan(
  p_site_id uuid,
  p_name text,
  p_price numeric,
  p_currency text,
  p_duration_minutes integer,
  p_data_limit_mb integer default null,
  p_hotspot_profile text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager']) then
    raise exception 'Insufficient permission to manage plans' using errcode = '42501';
  end if;

  insert into public.plans(site_id, name, price, currency, duration_minutes, data_limit_mb, hotspot_profile)
  values (p_site_id, btrim(coalesce(p_name, '')), p_price, upper(coalesce(p_currency, '')),
          p_duration_minutes, p_data_limit_mb, nullif(btrim(coalesce(p_hotspot_profile, '')), ''))
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'A plan with this name already exists' using errcode = '23505';
  when check_violation or not_null_violation then
    raise exception 'Invalid plan' using errcode = '22023';
end;
$$;
revoke all on function public.create_plan(uuid, text, numeric, text, integer, integer, text) from public, anon;
grant execute on function public.create_plan(uuid, text, numeric, text, integer, integer, text) to authenticated;

-- Sales can now originate from a payment instead of a synchronized event.
alter table public.sales alter column source_event_id drop not null;
alter table public.sales alter column device_id drop not null;
alter table public.sales add column if not exists payment_id uuid;
alter table public.sales
  add constraint sales_origin_check check (source_event_id is not null or payment_id is not null);
create unique index if not exists sales_payment_idx on public.sales(site_id, payment_id) where payment_id is not null;

create table if not exists public.payments (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  plan_id uuid not null,
  router_id uuid not null references public.routers(id),
  provider text not null check (provider in ('sandbox')),
  provider_ref text not null check (length(provider_ref) between 8 and 100),
  amount numeric(14, 2) not null check (amount >= 0),
  currency char(3) not null check (currency in ('CDF', 'USD')),
  customer_phone text check (customer_phone is null or customer_phone ~ '^\+?[0-9]{8,15}$'),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'expired', 'mismatch', 'cancelled')),
  fulfillment_status text not null default 'none'
    check (fulfillment_status in ('none', 'activation_pending', 'activated', 'activation_failed', 'out_of_stock')),
  ticket_code text,
  sale_id uuid,
  activation_command_id uuid,
  idempotency_key text check (idempotency_key is null or length(idempotency_key) between 1 and 200),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paid_at timestamptz,
  primary key (site_id, id),
  unique (id),
  unique (provider, provider_ref),
  foreign key (site_id, plan_id) references public.plans(site_id, id)
);

create unique index if not exists payments_idempotency_idx
  on public.payments(site_id, idempotency_key) where idempotency_key is not null;
create index if not exists payments_site_created_idx on public.payments(site_id, created_at desc, id desc);
create index if not exists payments_activation_command_idx on public.payments(activation_command_id)
  where activation_command_id is not null;

-- Provider callbacks. Only trusted server code (service role) reads or writes them.
create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null check (length(event_id) between 1 and 200),
  provider_ref text not null,
  event_status text not null check (event_status in ('succeeded', 'failed')),
  amount numeric(14, 2) not null,
  currency char(3) not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  site_id uuid,
  payment_id uuid,
  outcome text,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);

alter table public.payments enable row level security;
alter table public.webhook_events enable row level security;

create policy "sellers and managers can read payments"
on public.payments for select to authenticated
using (private.has_site_role(site_id, array['owner', 'admin', 'manager', 'seller']));

revoke all on public.payments, public.webhook_events from anon, authenticated;
grant select on public.payments to authenticated;

-- Audit: money-related state changes (never the customer phone).
create or replace function private.audit_payments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_details jsonb := jsonb_build_object('amount', new.amount, 'currency', new.currency,
                                        'plan_id', new.plan_id, 'provider', new.provider);
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.site_id, 'payment.created', 'payment', new.id::text, v_details);
    return null;
  end if;
  if new.status is distinct from old.status and new.status <> 'expired' then
    perform private.write_audit(new.site_id, 'payment.' || new.status, 'payment', new.id::text, v_details);
  end if;
  if new.fulfillment_status is distinct from old.fulfillment_status and new.fulfillment_status <> 'none' then
    perform private.write_audit(new.site_id, 'payment.' || new.fulfillment_status, 'payment', new.id::text, v_details);
  end if;
  return null;
end;
$$;

create trigger audit_payments_write
after insert or update on public.payments
for each row execute function private.audit_payments();

-- Creating a payment (assisted sale). The amount always comes from the plan.
create or replace function public.create_payment(
  p_site_id uuid,
  p_plan_id uuid,
  p_router_id uuid,
  p_customer_phone text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.plans%rowtype;
  v_router public.routers%rowtype;
  v_existing public.payments%rowtype;
  v_pay public.payments%rowtype;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_phone text := nullif(btrim(coalesce(p_customer_phone, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager', 'seller']) then
    raise exception 'Insufficient permission to create payments' using errcode = '42501';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{8,15}$' then
    raise exception 'Invalid phone number' using errcode = '22023';
  end if;
  if v_key is not null and length(v_key) > 200 then
    raise exception 'idempotency key too long' using errcode = '22023';
  end if;

  -- A replay returns the existing payment even if the plan was deactivated since.
  if v_key is not null then
    select pm.* into v_existing from public.payments pm
    where pm.site_id = p_site_id and pm.idempotency_key = v_key;
    if found then
      if v_existing.plan_id = p_plan_id and v_existing.router_id = p_router_id then
        return jsonb_build_object('payment_id', v_existing.id, 'provider_ref', v_existing.provider_ref,
          'amount', v_existing.amount, 'currency', v_existing.currency, 'status', v_existing.status,
          'expires_at', v_existing.expires_at);
      end if;
      raise exception 'Idempotency key already used for a different payment' using errcode = '23505';
    end if;
  end if;

  select p.* into v_plan from public.plans p where p.site_id = p_site_id and p.id = p_plan_id;
  if not found then
    raise exception 'Plan not found in this site' using errcode = 'P0002';
  end if;
  if not v_plan.active then
    raise exception 'Plan is not active' using errcode = '22023';
  end if;

  select r.* into v_router from public.routers r where r.id = p_router_id and r.site_id = p_site_id;
  if not found then
    raise exception 'Router not found in this site' using errcode = 'P0002';
  end if;
  if v_router.status in ('suspended', 'revoked') then
    raise exception 'Router is suspended or revoked' using errcode = '22023';
  end if;

  insert into public.payments(
    site_id, plan_id, router_id, provider, provider_ref, amount, currency,
    customer_phone, idempotency_key, created_by, expires_at)
  values (
    p_site_id, p_plan_id, p_router_id, 'sandbox',
    'MTD-' || replace(gen_random_uuid()::text, '-', ''),
    v_plan.price, v_plan.currency, v_phone, v_key, auth.uid(), now() + interval '30 minutes')
  returning * into v_pay;

  return jsonb_build_object('payment_id', v_pay.id, 'provider_ref', v_pay.provider_ref,
    'amount', v_pay.amount, 'currency', v_pay.currency, 'status', v_pay.status,
    'expires_at', v_pay.expires_at);
end;
$$;

-- Fulfillment: stock voucher + sale + ticket + activation command. Safe to call
-- again for a payment that is out of stock; it never fulfills a payment twice.
create or replace function private.fulfill_payment(p_payment_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments%rowtype;
  v_plan public.plans%rowtype;
  v_router public.routers%rowtype;
  v_stock public.ticket_stock%rowtype;
  v_sale_id uuid;
  v_payload jsonb;
  v_command_id uuid;
begin
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found or v_pay.status <> 'paid' or v_pay.sale_id is not null then
    return coalesce(v_pay.fulfillment_status, 'none');
  end if;

  select * into v_plan from public.plans where site_id = v_pay.site_id and id = v_pay.plan_id;

  select s.* into v_stock
  from public.ticket_stock s
  where s.site_id = v_pay.site_id and s.plan_id = v_pay.plan_id and s.status = 'available'
  order by s.imported_at, s.code
  limit 1
  for update skip locked;

  if not found then
    update public.payments set fulfillment_status = 'out_of_stock', updated_at = now() where id = v_pay.id;
    return 'out_of_stock';
  end if;

  update public.ticket_stock set status = 'sold' where site_id = v_stock.site_id and id = v_stock.id;

  v_sale_id := gen_random_uuid();
  insert into public.sales(site_id, id, source_event_id, device_id, payment_id, amount, currency,
                           payment_method, plan_name, ticket_code, sold_at)
  values (v_pay.site_id, v_sale_id, null, null, v_pay.id, v_pay.amount, v_pay.currency,
          'mobile_money', v_plan.name, v_stock.code, v_pay.paid_at);
  insert into public.tickets(site_id, code, sale_id) values (v_pay.site_id, v_stock.code, v_sale_id);

  select * into v_router from public.routers where id = v_pay.router_id;
  if v_router.status in ('suspended', 'revoked') then
    update public.payments
    set sale_id = v_sale_id, ticket_code = v_stock.code, fulfillment_status = 'activation_failed', updated_at = now()
    where id = v_pay.id;
    return 'activation_failed';
  end if;

  v_payload := jsonb_build_object('code', v_stock.code, 'duration_minutes', v_plan.duration_minutes);
  if v_plan.hotspot_profile is not null then
    v_payload := v_payload || jsonb_build_object('profile', v_plan.hotspot_profile);
  end if;
  -- System-created commands may wait up to 24 hours for an absent Gateway.
  insert into public.gateway_commands(site_id, router_id, operation, payload, issued_at, expires_at)
  values (v_pay.site_id, v_pay.router_id, 'hotspot.voucher.create', v_payload, now(), now() + interval '24 hours')
  returning id into v_command_id;

  update public.payments
  set sale_id = v_sale_id, ticket_code = v_stock.code, activation_command_id = v_command_id,
      fulfillment_status = 'activation_pending', updated_at = now()
  where id = v_pay.id;
  return 'activation_pending';
end;
$$;

-- Provider webhook entry point. The API verifies the provider signature first;
-- this function is reachable only with the service role.
create or replace function public.process_payment_webhook(
  p_provider text,
  p_event_id text,
  p_provider_ref text,
  p_status text,
  p_amount numeric,
  p_currency text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event uuid;
  v_pay public.payments%rowtype;
  v_outcome text;
  v_fulfillment text;
begin
  if p_provider is null or p_provider not in ('sandbox')
     or coalesce(length(p_event_id), 0) not between 1 and 200
     or coalesce(length(p_provider_ref), 0) not between 1 and 100
     or p_status is null or p_status not in ('succeeded', 'failed')
     or p_amount is null or p_amount < 0
     or p_currency is null or p_currency not in ('CDF', 'USD')
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or length(p_payload::text) > 16384 then
    raise exception 'Invalid webhook' using errcode = '22023';
  end if;

  insert into public.webhook_events(provider, event_id, provider_ref, event_status, amount, currency, payload)
  values (p_provider, p_event_id, p_provider_ref, p_status, p_amount, p_currency, p_payload)
  on conflict (provider, event_id) do nothing
  returning id into v_event;

  if v_event is null then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  select * into v_pay from public.payments
  where provider = p_provider and provider_ref = p_provider_ref
  for update;

  if not found then
    update public.webhook_events set outcome = 'unmatched' where id = v_event;
    return jsonb_build_object('outcome', 'unmatched');
  end if;

  update public.webhook_events set site_id = v_pay.site_id, payment_id = v_pay.id where id = v_event;

  if p_status = 'failed' then
    if v_pay.status in ('pending', 'expired') then
      update public.payments set status = 'failed', updated_at = now() where id = v_pay.id;
      v_outcome := 'failed';
    else
      v_outcome := 'ignored';
    end if;
  elsif v_pay.status = 'paid' then
    v_outcome := 'already_paid';
  elsif v_pay.status = 'mismatch' then
    v_outcome := 'ignored';
  elsif p_amount <> v_pay.amount or p_currency <> v_pay.currency then
    update public.payments set status = 'mismatch', updated_at = now() where id = v_pay.id;
    v_outcome := 'amount_mismatch';
  else
    -- Money was received: honour it even if the payment had expired or failed earlier.
    update public.payments set status = 'paid', paid_at = now(), updated_at = now() where id = v_pay.id;
    v_fulfillment := private.fulfill_payment(v_pay.id);
    v_outcome := 'paid';
  end if;

  update public.webhook_events set outcome = v_outcome where id = v_event;
  return jsonb_build_object('outcome', v_outcome, 'payment_id', v_pay.id, 'fulfillment_status', v_fulfillment);
end;
$$;

-- Activation follows the Gateway: only a confirmed command activates a ticket.
create or replace function private.payment_command_finished()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments%rowtype;
  v_activated boolean;
begin
  if new.operation <> 'hotspot.voucher.create'
     or new.status not in ('succeeded', 'failed', 'expired', 'cancelled')
     or new.status is not distinct from old.status then
    return null;
  end if;

  select * into v_pay from public.payments
  where activation_command_id = new.id and fulfillment_status = 'activation_pending'
  for update;
  if not found then
    return null;
  end if;

  -- "voucher_exists" means a previous attempt did create it: the ticket is live.
  v_activated := new.status = 'succeeded' or (new.status = 'failed' and coalesce(new.error, '') like 'voucher_exists:%');
  update public.payments
  set fulfillment_status = case when v_activated then 'activated' else 'activation_failed' end, updated_at = now()
  where id = v_pay.id;
  if v_activated then
    update public.tickets set status = 'activated' where site_id = v_pay.site_id and code = v_pay.ticket_code;
  end if;
  return null;
end;
$$;

create trigger payments_follow_activation_command
after update of status on public.gateway_commands
for each row execute function private.payment_command_finished();

-- Re-attempt a failed activation or a payment that was out of stock.
create or replace function public.retry_payment_activation(p_site_id uuid, p_payment_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments%rowtype;
  v_plan public.plans%rowtype;
  v_router public.routers%rowtype;
  v_payload jsonb;
  v_command_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager']) then
    raise exception 'Insufficient permission to retry activations' using errcode = '42501';
  end if;

  select * into v_pay from public.payments
  where site_id = p_site_id and id = p_payment_id for update;
  if not found then
    raise exception 'Payment not found in this site' using errcode = 'P0002';
  end if;
  if v_pay.status <> 'paid' or v_pay.fulfillment_status not in ('activation_failed', 'out_of_stock') then
    raise exception 'This payment has nothing to retry' using errcode = '22023';
  end if;

  if v_pay.fulfillment_status = 'out_of_stock' then
    return private.fulfill_payment(v_pay.id);
  end if;

  select * into v_router from public.routers where id = v_pay.router_id;
  if v_router.status in ('suspended', 'revoked') then
    raise exception 'Router is suspended or revoked' using errcode = '22023';
  end if;
  select * into v_plan from public.plans where site_id = v_pay.site_id and id = v_pay.plan_id;

  v_payload := jsonb_build_object('code', v_pay.ticket_code, 'duration_minutes', v_plan.duration_minutes);
  if v_plan.hotspot_profile is not null then
    v_payload := v_payload || jsonb_build_object('profile', v_plan.hotspot_profile);
  end if;
  insert into public.gateway_commands(site_id, router_id, operation, payload, issued_at, expires_at, created_by)
  values (v_pay.site_id, v_pay.router_id, 'hotspot.voucher.create', v_payload, now(), now() + interval '24 hours', auth.uid())
  returning id into v_command_id;

  update public.payments
  set activation_command_id = v_command_id, fulfillment_status = 'activation_pending', updated_at = now()
  where id = v_pay.id;
  return 'activation_pending';
end;
$$;

-- Marks unpaid payments past their deadline. Safe to schedule.
create or replace function public.expire_pending_payments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.payments set status = 'expired', updated_at = now()
  where status = 'pending' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.fulfill_payment(uuid) from public, anon, authenticated;
revoke all on function private.payment_command_finished() from public, anon, authenticated;
revoke all on function private.audit_payments() from public, anon, authenticated;

revoke all on function public.create_payment(uuid, uuid, uuid, text, text) from public, anon;
revoke all on function public.retry_payment_activation(uuid, uuid) from public, anon;
grant execute on function public.create_payment(uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.retry_payment_activation(uuid, uuid) to authenticated;

revoke all on function public.process_payment_webhook(text, text, text, text, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.process_payment_webhook(text, text, text, text, numeric, text, jsonb) to service_role;
revoke all on function public.expire_pending_payments() from public, anon, authenticated;
grant execute on function public.expire_pending_payments() to service_role;

-- Reconciliation now also reports payment problems.
create or replace function public.reconciliation_report(
  p_site_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table(kind text, reference_id uuid, occurred_at timestamptz, details jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_range timestamptz[];
begin
  if auth.uid() is null
     or not private.has_site_role(p_site_id, array['owner', 'admin', 'manager', 'viewer']) then
    raise exception 'Insufficient permission to read reports' using errcode = '42501';
  end if;
  v_range := private.report_period(p_from, p_to);

  return query
  select * from (
    select 'cash_entry_missing'::text, sa.id, sa.sold_at,
           jsonb_build_object('amount', sa.amount, 'currency', sa.currency)
    from public.sales sa
    where sa.site_id = p_site_id and sa.payment_method = 'cash'
      and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]
      and not exists (select 1 from public.cash_entries c where c.site_id = sa.site_id and c.sale_id = sa.id)

    union all
    select 'cash_entry_mismatch', sa.id, sa.sold_at,
           jsonb_build_object('sale_amount', sa.amount, 'sale_currency', sa.currency,
                              'cash_amount', c.amount, 'cash_currency', c.currency)
    from public.sales sa
    join public.cash_entries c on c.site_id = sa.site_id and c.sale_id = sa.id
    where sa.site_id = p_site_id
      and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]
      and (c.amount <> sa.amount or c.currency <> sa.currency)

    union all
    select 'cash_entry_unexpected', sa.id, sa.sold_at,
           jsonb_build_object('payment_method', sa.payment_method, 'cash_amount', c.amount)
    from public.sales sa
    join public.cash_entries c on c.site_id = sa.site_id and c.sale_id = sa.id
    where sa.site_id = p_site_id and sa.payment_method <> 'cash'
      and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]

    union all
    select 'ticket_missing', sa.id, sa.sold_at,
           jsonb_build_object('ticket_code', sa.ticket_code)
    from public.sales sa
    where sa.site_id = p_site_id and sa.ticket_code is not null
      and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]
      and not exists (select 1 from public.tickets t where t.site_id = sa.site_id
                      and t.sale_id = sa.id and t.code = sa.ticket_code)

    union all
    select 'sync_conflict_open', sc.event_id, sc.created_at,
           jsonb_build_object('conflict_type', sc.conflict_type, 'conflict_id', sc.id)
    from public.sync_conflicts sc
    where sc.site_id = p_site_id and sc.resolved_at is null
      and sc.created_at >= v_range[1] and sc.created_at < v_range[2]

    union all
    select 'sync_event_rejected', se.id, se.received_at,
           jsonb_build_object('event_type', se.event_type, 'error', se.process_error)
    from public.sync_events se
    where se.site_id = p_site_id and se.status = 'rejected'
      and se.received_at >= v_range[1] and se.received_at < v_range[2]

    union all
    select 'sync_event_stuck', se.id, se.received_at,
           jsonb_build_object('event_type', se.event_type)
    from public.sync_events se
    where se.site_id = p_site_id and se.status = 'pending'
      and se.received_at < now() - interval '10 minutes'
      and se.received_at >= v_range[1] and se.received_at < v_range[2]

    union all
    -- Payment received for another amount or currency than the plan price.
    select 'payment_amount_mismatch', pm.id, coalesce(pm.paid_at, pm.updated_at),
           jsonb_build_object('expected_amount', pm.amount, 'expected_currency', pm.currency)
    from public.payments pm
    where pm.site_id = p_site_id and pm.status = 'mismatch'
      and pm.updated_at >= v_range[1] and pm.updated_at < v_range[2]

    union all
    -- Money received but no voucher left to deliver.
    select 'payment_out_of_stock', pm.id, pm.paid_at,
           jsonb_build_object('plan_id', pm.plan_id, 'amount', pm.amount, 'currency', pm.currency)
    from public.payments pm
    where pm.site_id = p_site_id and pm.fulfillment_status = 'out_of_stock'
      and pm.paid_at >= v_range[1] and pm.paid_at < v_range[2]

    union all
    -- Paid and ticket allocated, but the router never confirmed the activation.
    select 'payment_activation_failed', pm.id, pm.paid_at,
           jsonb_build_object('ticket_code', pm.ticket_code, 'command_id', pm.activation_command_id)
    from public.payments pm
    where pm.site_id = p_site_id and pm.fulfillment_status = 'activation_failed'
      and pm.paid_at >= v_range[1] and pm.paid_at < v_range[2]

    union all
    select 'payment_activation_stuck', pm.id, pm.paid_at,
           jsonb_build_object('ticket_code', pm.ticket_code, 'command_id', pm.activation_command_id)
    from public.payments pm
    where pm.site_id = p_site_id and pm.fulfillment_status = 'activation_pending'
      and pm.paid_at < now() - interval '1 hour'
      and pm.paid_at >= v_range[1] and pm.paid_at < v_range[2]
  ) r(kind, reference_id, occurred_at, details)
  order by r.occurred_at desc, r.kind
  limit 500;
end;
$$;
revoke all on function public.reconciliation_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.reconciliation_report(uuid, timestamptz, timestamptz) to authenticated;
