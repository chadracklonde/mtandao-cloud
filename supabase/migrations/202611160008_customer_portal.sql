-- LOT 8: public customer portal.
-- Customers are anonymous. Every portal function is callable only with the
-- service role (from the API), never directly by anon or authenticated users.
-- A customer proves ownership of a payment with a random access token whose
-- SHA-256 hash is stored here; the token itself is shown once and never stored.

alter table public.payments
  add column if not exists access_token_hash text check (access_token_hash is null or access_token_hash ~ '^[a-f0-9]{64}$'),
  add column if not exists access_expires_at timestamptz;

create unique index if not exists payments_access_token_idx
  on public.payments(access_token_hash) where access_token_hash is not null;

-- Once money is received, the customer keeps access for 24 hours to read the voucher.
create or replace function private.extend_portal_access()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.access_token_hash is not null then
    new.access_expires_at := greatest(coalesce(new.access_expires_at, now()), now() + interval '24 hours');
  end if;
  return new;
end;
$$;

create trigger payments_extend_portal_access
before update of status on public.payments
for each row execute function private.extend_portal_access();

-- Shared creation logic for staff (create_payment) and customers (portal).
create or replace function private.create_payment_core(
  p_site_id uuid,
  p_plan_id uuid,
  p_router_id uuid,
  p_phone text,
  p_idempotency_key text,
  p_created_by uuid,
  p_token_hash text,
  p_access_ttl interval
)
returns public.payments
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
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
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
        return v_existing;
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
    customer_phone, idempotency_key, created_by, expires_at, access_token_hash, access_expires_at)
  values (
    p_site_id, p_plan_id, p_router_id, 'sandbox',
    'MTD-' || replace(gen_random_uuid()::text, '-', ''),
    v_plan.price, v_plan.currency, v_phone, v_key, p_created_by, now() + interval '30 minutes',
    p_token_hash, case when p_token_hash is not null then now() + p_access_ttl end)
  returning * into v_pay;
  return v_pay;
end;
$$;

create or replace function private.payment_summary(p_pay public.payments)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('payment_id', p_pay.id, 'provider_ref', p_pay.provider_ref,
    'amount', p_pay.amount, 'currency', p_pay.currency, 'status', p_pay.status,
    'expires_at', p_pay.expires_at);
$$;

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
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager', 'seller']) then
    raise exception 'Insufficient permission to create payments' using errcode = '42501';
  end if;
  return private.payment_summary(
    private.create_payment_core(p_site_id, p_plan_id, p_router_id, p_customer_phone,
                                p_idempotency_key, auth.uid(), null, null));
end;
$$;

-- Portal: what a customer may see before paying.
create or replace function public.portal_catalog(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
begin
  select * into v_site from public.sites where id = p_site_id and status = 'active';
  if not found then
    raise exception 'Site not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'site', jsonb_build_object('id', v_site.id, 'name', v_site.name, 'currency', v_site.default_currency),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'price', p.price, 'currency', p.currency,
        'duration_minutes', p.duration_minutes, 'data_limit_mb', p.data_limit_mb,
        'in_stock', exists (select 1 from public.ticket_stock s
                            where s.site_id = p.site_id and s.plan_id = p.id and s.status = 'available'))
        order by p.price, p.name)
      from public.plans p where p.site_id = p_site_id and p.active), '[]'::jsonb));
end;
$$;

-- Portal: start a payment. A phone number is mandatory, and open payments are capped
-- per phone number and per site to limit abuse by anonymous visitors.
create or replace function public.portal_create_payment(
  p_site_id uuid,
  p_plan_id uuid,
  p_router_id uuid,
  p_customer_phone text,
  p_idempotency_key text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments%rowtype;
  v_phone text := nullif(btrim(coalesce(p_customer_phone, '')), '');
begin
  if coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid access token hash' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'A phone number is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sites where id = p_site_id and status = 'active') then
    raise exception 'Site not found' using errcode = 'P0002';
  end if;

  if (select count(*) from public.payments
      where site_id = p_site_id and customer_phone = v_phone and status = 'pending'
        and created_at > now() - interval '30 minutes') >= 3
     or (select count(*) from public.payments
         where site_id = p_site_id and status = 'pending' and expires_at > now()) >= 500 then
    raise exception 'Too many open payments' using errcode = '53400';
  end if;

  v_pay := private.create_payment_core(p_site_id, p_plan_id, p_router_id, v_phone,
                                       p_idempotency_key, null, p_token_hash, interval '2 hours');

  if v_pay.created_at < now() then
    -- Idempotent replay (double click, reload): give the customer a fresh working token.
    if v_pay.status <> 'pending' or v_pay.created_by is not null then
      raise exception 'Payment already processed' using errcode = '22023';
    end if;
    update public.payments
    set access_token_hash = p_token_hash, access_expires_at = now() + interval '2 hours'
    where id = v_pay.id
    returning * into v_pay;
  end if;

  return private.payment_summary(v_pay) || jsonb_build_object('access_expires_at', v_pay.access_expires_at);
end;
$$;

-- Portal: payment status. The token must match this exact payment and must not
-- have expired. All failures look alike so tokens cannot be probed.
create or replace function public.portal_payment_status(p_payment_id uuid, p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pay public.payments%rowtype;
  v_plan_name text;
  v_status text;
  v_ticket jsonb := null;
begin
  if coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Not found' using errcode = 'P0002';
  end if;

  select * into v_pay from public.payments
  where id = p_payment_id and access_token_hash = p_token_hash and access_expires_at > now();
  if not found then
    raise exception 'Not found' using errcode = 'P0002';
  end if;

  select name into v_plan_name from public.plans where site_id = v_pay.site_id and id = v_pay.plan_id;
  v_status := case when v_pay.status = 'pending' and v_pay.expires_at <= now() then 'expired' else v_pay.status end;

  -- The voucher is shown only once the router has confirmed it: never a code that does not work yet.
  if v_pay.fulfillment_status = 'activated' then
    select jsonb_build_object('code', v_pay.ticket_code, 'duration_minutes', pl.duration_minutes)
    into v_ticket
    from public.plans pl where pl.site_id = v_pay.site_id and pl.id = v_pay.plan_id;
  end if;

  return jsonb_build_object(
    'payment_id', v_pay.id, 'provider_ref', v_pay.provider_ref, 'plan', v_plan_name,
    'amount', v_pay.amount, 'currency', v_pay.currency,
    'status', v_status, 'fulfillment_status', v_pay.fulfillment_status,
    'expires_at', v_pay.expires_at, 'access_expires_at', v_pay.access_expires_at,
    'ticket', v_ticket);
end;
$$;

revoke all on function private.extend_portal_access() from public, anon, authenticated;
revoke all on function private.create_payment_core(uuid, uuid, uuid, text, text, uuid, text, interval) from public, anon, authenticated;
revoke all on function private.payment_summary(public.payments) from public, anon, authenticated;

revoke all on function public.create_payment(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.create_payment(uuid, uuid, uuid, text, text) to authenticated;

revoke all on function public.portal_catalog(uuid) from public, anon, authenticated;
revoke all on function public.portal_create_payment(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.portal_payment_status(uuid, text) from public, anon, authenticated;
grant execute on function public.portal_catalog(uuid) to service_role;
grant execute on function public.portal_create_payment(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.portal_payment_status(uuid, text) to service_role;
