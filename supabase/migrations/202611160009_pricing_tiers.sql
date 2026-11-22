-- Standard pricing tiers. Every site sets its own price for each duration:
--   1h = 60 min, 2h = 120 min, 24h = 1440 min, 1w = 10080 min (7 days), 1m = 43200 min (30 days).
-- A tier is a plan with a fixed duration; custom plans (tier is null) remain possible.

alter table public.plans
  add column if not exists tier text check (tier is null or tier in ('1h', '2h', '24h', '1w', '1m'));

alter table public.plans
  add constraint plans_tier_duration_check check (
    tier is null or duration_minutes = case tier
      when '1h' then 60 when '2h' then 120 when '24h' then 1440 when '1w' then 10080 when '1m' then 43200 end);

-- One plan per tier and per site.
create unique index if not exists plans_site_tier_idx on public.plans(site_id, tier) where tier is not null;

create or replace function private.tier_info(p_tier text)
returns table(duration_minutes integer, label text, sort_order integer)
language sql
immutable
set search_path = ''
as $$
  select v.d, v.l, v.o
  from (values ('1h', 60, '1 heure', 1), ('2h', 120, '2 heures', 2), ('24h', 1440, '24 heures', 3),
               ('1w', 10080, '1 semaine', 4), ('1m', 43200, '1 mois', 5)) v(t, d, l, o)
  where v.t = p_tier;
$$;

-- Sets (creates or updates) the price of a tier for a site.
create or replace function public.set_tier_price(
  p_site_id uuid,
  p_tier text,
  p_price numeric,
  p_currency text default null,
  p_active boolean default true,
  p_data_limit_mb integer default null,
  p_hotspot_profile text default null,
  p_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_info record;
  v_site public.sites%rowtype;
  v_currency text;
  v_name text;
  v_profile text := nullif(btrim(coalesce(p_hotspot_profile, '')), '');
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager']) then
    raise exception 'Insufficient permission to manage prices' using errcode = '42501';
  end if;

  select * into v_info from private.tier_info(p_tier);
  if not found then
    raise exception 'Unknown tier; use 1h, 2h, 24h, 1w or 1m' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 or p_price > 1000000000 then
    raise exception 'Invalid price' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'active is required' using errcode = '22023';
  end if;

  select * into v_site from public.sites where id = p_site_id;
  v_currency := upper(coalesce(nullif(btrim(p_currency), ''), v_site.default_currency));
  if v_currency not in ('CDF', 'USD') then
    raise exception 'Unsupported currency; use CDF or USD' using errcode = '22023';
  end if;
  v_name := coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_info.label);

  select id into v_id from public.plans where site_id = p_site_id and tier = p_tier for update;
  if found then
    update public.plans
    set price = p_price, currency = v_currency, active = p_active,
        data_limit_mb = p_data_limit_mb, hotspot_profile = v_profile,
        name = v_name, updated_at = now()
    where site_id = p_site_id and id = v_id;
  else
    insert into public.plans(site_id, name, price, currency, duration_minutes, data_limit_mb,
                             hotspot_profile, active, tier)
    values (p_site_id, v_name, p_price, v_currency, v_info.duration_minutes, p_data_limit_mb,
            v_profile, p_active, p_tier)
    returning id into v_id;
  end if;
  return v_id;
exception
  when unique_violation then
    raise exception 'A plan with this name already exists' using errcode = '23505';
  when check_violation then
    raise exception 'Invalid price settings' using errcode = '22023';
end;
$$;

-- The five tiers of a site, configured or not, in duration order.
create or replace function public.site_pricing(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tiers jsonb;
begin
  if auth.uid() is null or not private.has_site_membership(p_site_id) then
    raise exception 'site access denied' using errcode = '42501';
  end if;

  select jsonb_agg(jsonb_build_object(
           'tier', t.t, 'label', i.label, 'duration_minutes', i.duration_minutes,
           'configured', p.id is not null,
           'plan_id', p.id, 'name', p.name, 'price', p.price, 'currency', p.currency,
           'active', coalesce(p.active, false),
           'data_limit_mb', p.data_limit_mb, 'hotspot_profile', p.hotspot_profile,
           'stock_available', case when p.id is null then 0 else (
              select count(*) from public.ticket_stock s
              where s.site_id = p.site_id and s.plan_id = p.id and s.status = 'available') end)
         order by i.sort_order)
  into v_tiers
  from (values ('1h'), ('2h'), ('24h'), ('1w'), ('1m')) t(t)
  cross join lateral private.tier_info(t.t) i
  left join public.plans p on p.site_id = p_site_id and p.tier = t.t;

  return jsonb_build_object(
    'complete', not exists (select 1 from jsonb_array_elements(v_tiers) e
                            where (e->>'configured')::boolean is false or (e->>'active')::boolean is false),
    'tiers', v_tiers);
end;
$$;

-- The customer portal lists plans chronologically (shortest first) and names their tier.
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
        'id', p.id, 'tier', p.tier, 'name', p.name, 'price', p.price, 'currency', p.currency,
        'duration_minutes', p.duration_minutes, 'data_limit_mb', p.data_limit_mb,
        'in_stock', exists (select 1 from public.ticket_stock s
                            where s.site_id = p.site_id and s.plan_id = p.id and s.status = 'available'))
        order by p.duration_minutes, p.price, p.name)
      from public.plans p where p.site_id = p_site_id and p.active), '[]'::jsonb));
end;
$$;

revoke all on function private.tier_info(text) from public, anon, authenticated;
revoke all on function public.set_tier_price(uuid, text, numeric, text, boolean, integer, text, text) from public, anon;
revoke all on function public.site_pricing(uuid) from public, anon;
grant execute on function public.set_tier_price(uuid, text, numeric, text, boolean, integer, text, text) to authenticated;
grant execute on function public.site_pricing(uuid) to authenticated;
revoke all on function public.portal_catalog(uuid) from public, anon, authenticated;
grant execute on function public.portal_catalog(uuid) to service_role;
