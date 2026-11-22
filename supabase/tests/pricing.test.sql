\set ON_ERROR_STOP on
\set own '00000000-0000-0000-0000-000000000a01'
\set mgr '00000000-0000-0000-0000-000000000a02'
\set sel '00000000-0000-0000-0000-000000000a03'
\set oth '00000000-0000-0000-0000-000000000a04'
\set e1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;
create or replace function pg_temp.fails_with(p_sql text, p_state text) returns boolean
language plpgsql as $$ begin execute p_sql; return false;
exception when others then return sqlstate = p_state; end $$;

insert into auth.users(id, email) values
  (:'own', 'own@x.test'), (:'mgr', 'mgr@x.test'), (:'sel', 'sel@x.test'), (:'oth', 'oth@x.test');

set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_site_with_owner('Site Tarifs', 'USD') as site \gset
select public.create_site_with_owner('Site CDF') as site_cdf \gset
select public.create_site_invitation(:'site', 'mgr@x.test', 'manager') as i_mgr \gset
select public.create_site_invitation(:'site', 'sel@x.test', 'seller') as i_sel \gset
select public.register_router(:'site', 'R1', 'ident-1', 'linux', :'e1') as r1 \gset
select set_config('request.jwt.claim.sub', :'mgr', false), set_config('request.jwt.claim.email', 'mgr@x.test', false);
select public.accept_site_invitation(:'i_mgr');
select set_config('request.jwt.claim.sub', :'sel', false), set_config('request.jwt.claim.email', 'sel@x.test', false);
select public.accept_site_invitation(:'i_sel');
select set_config('request.jwt.claim.sub', :'oth', false);
select public.create_site_with_owner('Autre', 'CDF') as site_b \gset

-- A new site starts with the five tiers listed but none configured.
select set_config('request.jwt.claim.sub', :'sel', false);
select public.site_pricing(:'site') as p0 \gset
select pg_temp.expect('a new site lists the five tiers in duration order, none configured',
  (select array_agg(e->>'tier' order by ord) from jsonb_array_elements(:'p0'::jsonb->'tiers') with ordinality t(e, ord)) = array['1h', '2h', '24h', '1w', '1m']
  and (select bool_and((e->>'configured')::boolean = false) from jsonb_array_elements(:'p0'::jsonb->'tiers') e)
  and (:'p0'::jsonb->>'complete') = 'false');
select pg_temp.expect('tier durations are 60, 120, 1440, 10080 and 43200 minutes',
  (select array_agg((e->>'duration_minutes')::int order by ord) from jsonb_array_elements(:'p0'::jsonb->'tiers') with ordinality t(e, ord)) = array[60, 120, 1440, 10080, 43200]);

-- Roles.
select pg_temp.expect('a seller cannot set prices (42501)',
  pg_temp.fails_with(format('select public.set_tier_price(%L, %L, 5)', :'site', '1h'), '42501'));
select set_config('request.jwt.claim.sub', :'oth', false);
select pg_temp.expect('another site cannot set or read prices (42501)',
  pg_temp.fails_with(format('select public.set_tier_price(%L, %L, 5)', :'site', '1h'), '42501')
  and pg_temp.fails_with(format('select public.site_pricing(%L)', :'site'), '42501'));

-- A manager sets four tiers: the site is still incomplete.
select set_config('request.jwt.claim.sub', :'mgr', false);
select public.set_tier_price(:'site', '1h', 1) as t1h \gset
select public.set_tier_price(:'site', '2h', 1.8) as t2h \gset
select public.set_tier_price(:'site', '24h', 5, null, true, 2048, '24h-profile') as t24 \gset
select public.set_tier_price(:'site', '1w', 25) as t1w \gset
select pg_temp.expect('the site is incomplete until all five tiers are priced',
  (public.site_pricing(:'site')->>'complete') = 'false'
  and (select count(*) from public.plans where site_id = :'site'::uuid and tier is not null) = 4);
select pg_temp.expect('tiers get the standard duration, a default name and the site currency',
  (select duration_minutes = 120 and name = '2 heures' and currency = 'USD' and price = 1.8 from public.plans where id = :'t2h'::uuid)
  and (select duration_minutes = 10080 and name = '1 semaine' from public.plans where id = :'t1w'::uuid));
select public.set_tier_price(:'site', '1m', 80) as t1m \gset
select pg_temp.expect('with all five tiers priced and active the site is complete',
  (public.site_pricing(:'site')->>'complete') = 'true');

-- Different sites, different prices.
select set_config('request.jwt.claim.sub', :'own', false);
select public.set_tier_price(:'site_cdf', '1h', 500) as cdf_1h \gset
select pg_temp.expect('each site has its own price and currency for the same tier',
  (select price from public.plans where id = :'t1h'::uuid) = 1 and (select currency from public.plans where id = :'t1h'::uuid) = 'USD'
  and (select price from public.plans where id = :'cdf_1h'::uuid) = 500 and (select currency from public.plans where id = :'cdf_1h'::uuid) = 'CDF');

-- Changing a price updates the same plan, and open payments keep the price they were created with.
select public.import_ticket_stock(:'site', :'t1h', array['T1', 'T2']);
select public.create_payment(:'site', :'t1h', :'r1', null, 'pay-before') as pay_before \gset
select public.set_tier_price(:'site', '1h', 2) as t1h_again \gset
select pg_temp.expect('updating a tier price edits the same plan',
  :'t1h_again' = :'t1h' and (select count(*) from public.plans where site_id = :'site'::uuid and tier = '1h') = 1
  and (select price from public.plans where id = :'t1h'::uuid) = 2);
select pg_temp.expect('an open payment keeps the price it was created with',
  (select amount from public.payments where id = (:'pay_before'::jsonb->>'payment_id')::uuid) = 1);
select public.create_payment(:'site', :'t1h', :'r1', null, 'pay-after') as pay_after \gset
select pg_temp.expect('a new payment uses the new price',
  (:'pay_after'::jsonb->>'amount')::numeric = 2);
reset role;
select pg_temp.expect('the price change is audited with the previous price',
  exists (select 1 from public.audit_log where action = 'plan.updated'
          and (details->>'previous_price')::numeric = 1 and (details->>'price')::numeric = 2));
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);

-- Validation.
select pg_temp.expect('an unknown tier is rejected (22023)',
  pg_temp.fails_with(format('select public.set_tier_price(%L, %L, 5)', :'site', '3h'), '22023'));
select pg_temp.expect('a negative price is rejected (22023)',
  pg_temp.fails_with(format('select public.set_tier_price(%L, %L, -1)', :'site', '1h'), '22023'));
select pg_temp.expect('an unsupported currency is rejected (22023)',
  pg_temp.fails_with(format('select public.set_tier_price(%L, %L, 5, %L)', :'site', '1h', 'EUR'), '22023'));
select pg_temp.expect('a null price is rejected (22023)',
  pg_temp.fails_with(format('select public.set_tier_price(%L, %L, null)', :'site', '1h'), '22023'));

-- Vouchers made from a plan carry its usage time limit, data limit, profile and the app-compatible comment.
reset role;
select pg_temp.expect('the voucher payload of a plan carries time limit, data limit, profile and comment',
  (select private.voucher_payload(p, 'X1') = jsonb_build_object('code', 'X1', 'duration_minutes', 1440,
      'profile', '24h-profile', 'data_limit_mb', 2048, 'comment', private.voucher_payload(p, 'X1')->>'comment')
          and (private.voucher_payload(p, 'X1')->>'comment') ~ '^vc-[0-9]{6}-[0-9]{4} cloud$'
   from public.plans p where p.id = :'t24'::uuid));
select pg_temp.expect('a plan without profile or data limit sends only the time limit and comment',
  (select not (private.voucher_payload(p, 'X2') ? 'profile') and not (private.voucher_payload(p, 'X2') ? 'data_limit_mb')
          and (private.voucher_payload(p, 'X2')->>'duration_minutes') = '60'
   from public.plans p where p.id = :'t1h'::uuid));
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);

-- Deactivating a tier hides it from customers and makes the site incomplete.
select public.set_tier_price(:'site', '1m', 80, null, false);
select pg_temp.expect('a deactivated tier makes the site incomplete',
  (public.site_pricing(:'site')->>'complete') = 'false');
select pg_temp.expect('pricing reports stock per tier',
  (select (e->>'stock_available')::int from jsonb_array_elements(public.site_pricing(:'site')->'tiers') e where e->>'tier' = '1h') = 2);
reset role;
set role service_role;
select public.portal_catalog(:'site') as cat \gset
reset role;
select pg_temp.expect('the portal lists active tiers shortest first with their tier code',
  (select array_agg(p->>'tier' order by ord) from jsonb_array_elements(:'cat'::jsonb->'plans') with ordinality t(p, ord)) = array['1h', '2h', '24h', '1w']);

-- Database guarantees: one plan per tier per site, and a tier fixes its duration.
select pg_temp.expect('a second plan for the same tier is impossible (23505)',
  pg_temp.fails_with(format('insert into public.plans(site_id, name, price, currency, duration_minutes, tier) values (%L, %L, 1, %L, 60, %L)', :'site', 'Doublon', 'USD', '1h'), '23505'));
select pg_temp.expect('a tier cannot carry another duration (23514)',
  pg_temp.fails_with(format('insert into public.plans(site_id, name, price, currency, duration_minutes, tier) values (%L, %L, 1, %L, 61, %L)', :'site_b', 'Faux', 'CDF', '2h'), '23514'));
set role authenticated;
select set_config('request.jwt.claim.sub', :'oth', false);
select public.create_plan(:'site_b', 'Spécial', 10, 'CDF', 90) as custom \gset
reset role;
select pg_temp.expect('custom plans without a tier remain possible',
  (select tier is null and duration_minutes = 90 from public.plans where id = :'custom'::uuid));
\echo ALL TESTS PASSED
