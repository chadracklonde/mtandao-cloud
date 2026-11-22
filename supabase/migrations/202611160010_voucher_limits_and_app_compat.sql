-- Vouchers created from the Cloud carry the same limits as tickets made with
-- Mikhmon or the Mtandao Ticket app:
--   duration_minutes -> RouterOS limit-uptime (usage time limit, runs from the first login)
--   data_limit_mb    -> RouterOS limit-bytes-total (1 MB = 1 048 576 bytes, like the app)
--   comment          -> "vc-DDMMYY-HHMM <note>": the app's Hotspot profile script only logs
--                       the sale, marks the ticket used and arms its expiry for users whose
--                       comment starts with "vc-" or "up-".

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
       or (p_payload->>'code') !~ '^[A-Za-z0-9_.-]{1,64}$'
       or exists (select 1 from jsonb_object_keys(p_payload) k
                  where k not in ('code', 'profile', 'duration_minutes', 'data_limit_mb', 'comment'))
       or (p_payload ? 'profile' and (jsonb_typeof(p_payload->'profile') <> 'string'
            or (p_payload->>'profile') !~ '^[A-Za-z0-9 _.-]{1,120}$'))
       or (p_payload ? 'duration_minutes' and (jsonb_typeof(p_payload->'duration_minutes') <> 'number'
            or (p_payload->>'duration_minutes')::numeric not between 1 and 525600
            or (p_payload->>'duration_minutes')::numeric <> trunc((p_payload->>'duration_minutes')::numeric)))
       or (p_payload ? 'data_limit_mb' and (jsonb_typeof(p_payload->'data_limit_mb') <> 'number'
            or (p_payload->>'data_limit_mb')::numeric not between 1 and 10000000
            or (p_payload->>'data_limit_mb')::numeric <> trunc((p_payload->>'data_limit_mb')::numeric)))
       or (p_payload ? 'comment' and (jsonb_typeof(p_payload->'comment') <> 'string'
            or (p_payload->>'comment') !~ '^(vc|up)-[0-9]{6}-[0-9]{4}( [A-Za-z0-9 .''-]{1,30})?$')) then
      raise exception 'invalid voucher payload' using errcode = '22023';
    end if;
  elsif p_operation = 'hotspot.voucher.disable' then
    if coalesce(jsonb_typeof(p_payload->'code'), '') <> 'string'
       or (p_payload->>'code') !~ '^[A-Za-z0-9_.-]{1,64}$'
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

-- The activation payload built from a plan; single source for fulfillment and retries.
create or replace function private.voucher_payload(p_plan public.plans, p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'code', p_code,
    'duration_minutes', p_plan.duration_minutes,
    'profile', p_plan.hotspot_profile,
    'data_limit_mb', p_plan.data_limit_mb,
    'comment', 'vc-' || to_char(now() at time zone (select s.timezone from public.sites s where s.id = p_plan.site_id),
                               'DDMMYY-HH24MI') || ' cloud'));
$$;
revoke all on function private.voucher_payload(public.plans, text) from public, anon, authenticated;

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

  -- System-created commands may wait up to 24 hours for an absent Gateway.
  insert into public.gateway_commands(site_id, router_id, operation, payload, issued_at, expires_at)
  values (v_pay.site_id, v_pay.router_id, 'hotspot.voucher.create',
          private.voucher_payload(v_plan, v_stock.code), now(), now() + interval '24 hours')
  returning id into v_command_id;

  update public.payments
  set sale_id = v_sale_id, ticket_code = v_stock.code, activation_command_id = v_command_id,
      fulfillment_status = 'activation_pending', updated_at = now()
  where id = v_pay.id;
  return 'activation_pending';
end;
$$;

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

  insert into public.gateway_commands(site_id, router_id, operation, payload, issued_at, expires_at, created_by)
  values (v_pay.site_id, v_pay.router_id, 'hotspot.voucher.create',
          private.voucher_payload(v_plan, v_pay.ticket_code), now(), now() + interval '24 hours', auth.uid())
  returning id into v_command_id;

  update public.payments
  set activation_command_id = v_command_id, fulfillment_status = 'activation_pending', updated_at = now()
  where id = v_pay.id;
  return 'activation_pending';
end;
$$;

revoke all on function private.fulfill_payment(uuid) from public, anon, authenticated;
revoke all on function public.retry_payment_activation(uuid, uuid) from public, anon;
grant execute on function public.retry_payment_activation(uuid, uuid) to authenticated;
