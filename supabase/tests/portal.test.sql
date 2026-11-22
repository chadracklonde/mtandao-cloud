\set ON_ERROR_STOP on
\set own '00000000-0000-0000-0000-0000000000f1'
\set e1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'
\set g1 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1'
\set t1 'c000000000000000000000000000000000000000000000000000000000000001'
\set t2 'c000000000000000000000000000000000000000000000000000000000000002'
\set t3 'c000000000000000000000000000000000000000000000000000000000000003'
\set t4 'c000000000000000000000000000000000000000000000000000000000000004'
\set tbad 'not-a-hash'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;
create or replace function pg_temp.fails_with(p_sql text, p_state text) returns boolean
language plpgsql as $$ begin execute p_sql; return false;
exception when others then return sqlstate = p_state; end $$;
-- Runs a statement as the service role (what the API uses for the portal).
create or replace function pg_temp.svc(p_sql text) returns jsonb
language plpgsql as $$ declare r jsonb; begin
  set local role service_role; execute p_sql into r; reset role; return r; end $$;

insert into auth.users(id, email) values (:'own', 'own@x.test');
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_site_with_owner('Portail Kindu') as site \gset
select public.create_site_with_owner('Autre site') as site_b \gset
select public.register_router(:'site', 'R1', 'ident-1', 'linux', :'e1') as r1 \gset
select public.create_plan(:'site', '1 heure', 500, 'CDF', 60, null, '1h') as plan \gset
select public.create_plan(:'site', 'Sans stock', 900, 'CDF', 120) as plan_empty \gset
select public.create_plan(:'site', 'Retiré', 100, 'CDF', 30) as plan_off \gset
select public.set_plan_active(:'site', :'plan_off', false);
select public.import_ticket_stock(:'site', :'plan', array['W1', 'W2', 'W3', 'W4']);
reset role;
set role anon;
select count(*) from public.redeem_gateway_enrollment(:'e1', :'g1');
reset role;

-- Privileges: portal functions are for the API (service role) only.
set role anon;
select pg_temp.expect('anonymous cannot call the portal functions (42501)',
  pg_temp.fails_with(format('select public.portal_catalog(%L)', :'site'), '42501')
  and pg_temp.fails_with(format('select public.portal_payment_status(%L, %L)', gen_random_uuid(), :'t1'), '42501'));
reset role;
set role authenticated;
select pg_temp.expect('signed-in users cannot call the portal functions either (42501)',
  pg_temp.fails_with(format('select public.portal_create_payment(%L,%L,%L,%L,null,%L)', :'site', :'plan', :'r1', '+243970000001', :'t1'), '42501'));
reset role;

-- Catalog: active plans only, with stock as a boolean.
select pg_temp.svc(format('select public.portal_catalog(%L)', :'site')) as cat \gset
select pg_temp.expect('catalog lists active plans only, cheapest first',
  (select array_agg(p->>'name' order by ord) from jsonb_array_elements(:'cat'::jsonb->'plans') with ordinality t(p, ord)) = array['1 heure', 'Sans stock']);
select pg_temp.expect('catalog reports stock availability without counts',
  (:'cat'::jsonb->'plans'->0->>'in_stock') = 'true' and (:'cat'::jsonb->'plans'->1->>'in_stock') = 'false'
  and not (:'cat'::jsonb->'plans'->0 ? 'available') and not (:'cat'::jsonb::text like '%W1%'));
select pg_temp.expect('catalog never exposes internal identifiers beyond the site and plan ids',
  not (:'cat'::jsonb::text like '%router%') and not (:'cat'::jsonb::text like '%hotspot_profile%'));
select pg_temp.expect('unknown site is not found (P0002)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_catalog(%L)', gen_random_uuid()), 'P0002'));

-- Creating a payment as a customer.
select pg_temp.svc(format('select public.portal_create_payment(%L,%L,%L,%L,%L,%L)', :'site', :'plan', :'r1', '+243970000001', 'visit-1', :'t1')) as c1 \gset
select (:'c1'::jsonb->>'payment_id') as pid1, (:'c1'::jsonb->>'provider_ref') as ref1 \gset
select pg_temp.expect('customer payment takes its amount from the plan and has a 2h portal access',
  (:'c1'::jsonb->>'amount')::numeric = 500 and (:'c1'::jsonb->>'status') = 'pending'
  and (select access_expires_at > now() + interval '119 minutes' and access_expires_at <= now() + interval '2 hours'
       from public.payments where id = :'pid1'::uuid));
select pg_temp.expect('only the token hash is stored',
  (select access_token_hash from public.payments where id = :'pid1'::uuid) = :'t1'
  and (select created_by from public.payments where id = :'pid1'::uuid) is null);
select pg_temp.expect('a phone number is required (22023)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_create_payment(%L,%L,%L,null,null,%L)', :'site', :'plan', :'r1', :'t2'), '22023'));
select pg_temp.expect('an invalid phone number is rejected (22023)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_create_payment(%L,%L,%L,%L,null,%L)', :'site', :'plan', :'r1', 'abc', :'t2'), '22023'));
select pg_temp.expect('an invalid token hash is rejected (22023)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_create_payment(%L,%L,%L,%L,null,%L)', :'site', :'plan', :'r1', '+243970000002', :'tbad'), '22023'));
select pg_temp.expect('an inactive plan cannot be bought (22023)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_create_payment(%L,%L,%L,%L,null,%L)', :'site', :'plan_off', :'r1', '+243970000002', :'t2'), '22023'));
select pg_temp.expect('a plan or router of another site is not found (P0002)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_create_payment(%L,%L,%L,%L,null,%L)', :'site_b', :'plan', :'r1', '+243970000002', :'t2'), 'P0002'));

-- Replay (double click): a fresh token works, the old one stops working.
select pg_temp.svc(format('select public.portal_create_payment(%L,%L,%L,%L,%L,%L)', :'site', :'plan', :'r1', '+243970000001', 'visit-1', :'t2')) as c1b \gset
select pg_temp.expect('a replay returns the same payment',
  (:'c1b'::jsonb->>'payment_id') = :'pid1' and (select count(*) from public.payments) = 1);
select pg_temp.expect('the replay token works and the previous one no longer does',
  pg_temp.fails_with(format('set local role service_role; select public.portal_payment_status(%L, %L)', :'pid1', :'t1'), 'P0002')
  and (pg_temp.svc(format('select public.portal_payment_status(%L, %L)', :'pid1', :'t2'))->>'status') = 'pending');

-- Status: tokens are bound to their own payment and fail uniformly.
select pg_temp.svc(format('select public.portal_create_payment(%L,%L,%L,%L,%L,%L)', :'site', :'plan', :'r1', '+243970000003', 'visit-2', :'t3')) as c2 \gset
select (:'c2'::jsonb->>'payment_id') as pid2, (:'c2'::jsonb->>'provider_ref') as ref2 \gset
select pg_temp.expect('the token of one payment cannot read another payment (P0002)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_payment_status(%L, %L)', :'pid2', :'t2'), 'P0002')
  and pg_temp.fails_with(format('set local role service_role; select public.portal_payment_status(%L, %L)', :'pid1', :'t3'), 'P0002'));
select pg_temp.expect('unknown payment, malformed token: same answer (P0002)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_payment_status(%L, %L)', gen_random_uuid(), :'t2'), 'P0002')
  and pg_temp.fails_with(format('set local role service_role; select public.portal_payment_status(%L, %L)', :'pid1', :'tbad'), 'P0002'));

-- Unpaid or unconfirmed: no voucher is ever shown.
select pg_temp.expect('pending payment shows no ticket',
  (pg_temp.svc(format('select public.portal_payment_status(%L, %L)', :'pid1', :'t2'))->'ticket') = 'null'::jsonb);

-- Webhook confirms; the Gateway is absent: paid but no code yet.
set local role service_role;
select public.process_payment_webhook('sandbox', 'evt-w1', :'ref1', 'succeeded', 500, 'CDF', '{}') ->> 'outcome' as out \gset
reset role;
select pg_temp.svc(format('select public.portal_payment_status(%L, %L)', :'pid1', :'t2')) as st \gset
select pg_temp.expect('paid but not yet activated: no code is revealed',
  :'out' = 'paid' and (:'st'::jsonb->>'status') = 'paid' and (:'st'::jsonb->>'fulfillment_status') = 'activation_pending'
  and (:'st'::jsonb->'ticket') = 'null'::jsonb and not (:'st'::text like '%W1%'));
select pg_temp.expect('after payment the portal access is extended to 24 hours',
  (select access_expires_at > now() + interval '23 hours' from public.payments where id = :'pid1'::uuid));

-- The Gateway confirms: now the customer gets the code.
set role anon;
select command_id as cmd1 from public.claim_gateway_commands(:'g1', 10) \gset
select public.complete_gateway_command(:'g1', :'cmd1', true, '{"created":true}');
reset role;
select pg_temp.svc(format('select public.portal_payment_status(%L, %L)', :'pid1', :'t2')) as st2 \gset
select pg_temp.expect('activated: the customer receives the voucher code and duration',
  (:'st2'::jsonb->>'fulfillment_status') = 'activated' and (:'st2'::jsonb->'ticket'->>'code') = 'W1'
  and (:'st2'::jsonb->'ticket'->>'duration_minutes') = '60');
select pg_temp.expect('the other customer still sees no code',
  (pg_temp.svc(format('select public.portal_payment_status(%L, %L)', :'pid2', :'t3'))->'ticket') = 'null'::jsonb);

-- Expired access is refused, even with the right token.
update public.payments set access_expires_at = now() - interval '1 second' where id = :'pid1'::uuid;
select pg_temp.expect('an expired portal access is refused even with the right token (P0002)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_payment_status(%L, %L)', :'pid1', :'t2'), 'P0002'));

-- An unpaid payment past its deadline is shown as expired.
update public.payments set expires_at = now() - interval '1 minute' where id = :'pid2'::uuid;
select pg_temp.expect('an unpaid payment past its deadline is expired',
  (pg_temp.svc(format('select public.portal_payment_status(%L, %L)', :'pid2', :'t3'))->>'status') = 'expired');

-- Abuse limits.
select pg_temp.svc(format('select public.portal_create_payment(%L,%L,%L,%L,%L,%L)', :'site', :'plan', :'r1', '+243970000009', 'a1', repeat('d', 64)));
select pg_temp.svc(format('select public.portal_create_payment(%L,%L,%L,%L,%L,%L)', :'site', :'plan', :'r1', '+243970000009', 'a2', repeat('e', 64)));
select pg_temp.svc(format('select public.portal_create_payment(%L,%L,%L,%L,%L,%L)', :'site', :'plan', :'r1', '+243970000009', 'a3', repeat('f', 64)));
select pg_temp.expect('a fourth open payment for the same phone is refused (53400)',
  pg_temp.fails_with(format('set local role service_role; select public.portal_create_payment(%L,%L,%L,%L,%L,%L)', :'site', :'plan', :'r1', '+243970000009', 'a4', repeat('9', 64)), '53400'));
select pg_temp.expect('another phone is not affected',
  (pg_temp.svc(format('select public.portal_create_payment(%L,%L,%L,%L,%L,%L)', :'site', :'plan', :'r1', '+243970000010', 'b1', repeat('8', 64)))->>'status') = 'pending');

-- Staff payments keep working and carry no portal token.
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_payment(:'site', :'plan', :'r1', null, 'staff-1') as sp \gset
reset role;
select pg_temp.expect('staff payments have no portal token',
  (select access_token_hash is null and access_expires_at is null from public.payments where id = (:'sp'::jsonb->>'payment_id')::uuid));
select pg_temp.expect('customer payments are audited without phone or token',
  (select count(*) from public.audit_log where action = 'payment.created') >= 6
  and not exists (select 1 from public.audit_log where details::text like '%243970%' or details::text like '%' || :'t2' || '%'));
\echo ALL TESTS PASSED
