\set ON_ERROR_STOP on
\set own '00000000-0000-0000-0000-0000000000e1'
\set sel '00000000-0000-0000-0000-0000000000e2'
\set vie '00000000-0000-0000-0000-0000000000e3'
\set oth '00000000-0000-0000-0000-0000000000e4'
\set e1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'
\set g1 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1'
\set e2 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;
create or replace function pg_temp.fails_with(p_sql text, p_state text) returns boolean
language plpgsql as $$ begin execute p_sql; return false;
exception when others then return sqlstate = p_state; end $$;
-- Calls the provider webhook as the trusted service role.
create or replace function pg_temp.hook(p_event text, p_ref text, p_status text, p_amount numeric, p_cur text) returns jsonb
language plpgsql as $$ declare r jsonb; begin
  set local role service_role;
  select public.process_payment_webhook('sandbox', p_event, p_ref, p_status, p_amount, p_cur, '{}') into r;
  reset role; return r; end $$;

insert into auth.users(id, email) values
  (:'own', 'own@x.test'), (:'sel', 'sel@x.test'), (:'vie', 'vie@x.test'), (:'oth', 'oth@x.test');

set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_site_with_owner('Site P') as site \gset
select public.create_site_invitation(:'site', 'sel@x.test', 'seller') as i_sel \gset
select public.create_site_invitation(:'site', 'vie@x.test', 'viewer') as i_vie \gset
select public.register_router(:'site', 'R1', 'ident-1', 'linux', :'e1') as r1 \gset
select public.register_router(:'site', 'R2', 'ident-2', 'linux', :'e2') as r2 \gset
select public.create_plan(:'site', '1 heure', 500, 'CDF', 60, null, '1h-profile') as plan \gset
select public.create_plan(:'site', 'Inactif', 100, 'CDF', 30) as plan_off \gset
select public.set_plan_active(:'site', :'plan_off', false);
select public.import_ticket_stock(:'site', :'plan', array['P1', 'P2']);
select set_config('request.jwt.claim.sub', :'sel', false), set_config('request.jwt.claim.email', 'sel@x.test', false);
select public.accept_site_invitation(:'i_sel');
select set_config('request.jwt.claim.sub', :'vie', false), set_config('request.jwt.claim.email', 'vie@x.test', false);
select public.accept_site_invitation(:'i_vie');
select set_config('request.jwt.claim.sub', :'oth', false);
select public.create_site_with_owner('Site Other') as site_b \gset
reset role;
set role anon;
select count(*) from public.redeem_gateway_enrollment(:'e1', :'g1');
reset role;

-- Creating payments.
set role authenticated;
select set_config('request.jwt.claim.sub', :'sel', false);
select public.create_payment(:'site', :'plan', :'r1', '+243970000000', 'sale-1') as p1 \gset
select (:'p1'::jsonb ->> 'payment_id') as pid1, (:'p1'::jsonb ->> 'provider_ref') as ref1 \gset
select pg_temp.expect('payment amount comes from the plan',
  (:'p1'::jsonb ->> 'amount')::numeric = 500 and (:'p1'::jsonb ->> 'currency') = 'CDF' and (:'p1'::jsonb ->> 'status') = 'pending');
select pg_temp.expect('same idempotency key returns the same payment',
  (public.create_payment(:'site', :'plan', :'r1', null, 'sale-1') ->> 'payment_id') = :'pid1');
select pg_temp.expect('idempotency key reused for another plan rejected (23505)',
  pg_temp.fails_with(format('select public.create_payment(%L, %L, %L, null, %L)', :'site', :'plan_off', :'r1', 'sale-1'), '23505'));
select pg_temp.expect('invalid phone rejected (22023)',
  pg_temp.fails_with(format('select public.create_payment(%L, %L, %L, %L)', :'site', :'plan', :'r1', '12ab'), '22023'));
select pg_temp.expect('inactive plan rejected (22023)',
  pg_temp.fails_with(format('select public.create_payment(%L, %L, %L)', :'site', :'plan_off', :'r1'), '22023'));
select pg_temp.expect('router of another site rejected (P0002)',
  pg_temp.fails_with(format('select public.create_payment(%L, %L, %L)', :'site', :'plan', gen_random_uuid()), 'P0002'));
select set_config('request.jwt.claim.sub', :'vie', false);
select pg_temp.expect('viewer cannot create payments (42501)',
  pg_temp.fails_with(format('select public.create_payment(%L, %L, %L)', :'site', :'plan', :'r1'), '42501'));
select pg_temp.expect('viewer cannot read payments', (select count(*) from public.payments) = 0);
select set_config('request.jwt.claim.sub', :'oth', false);
select pg_temp.expect('other site cannot create payments (42501)',
  pg_temp.fails_with(format('select public.create_payment(%L, %L, %L)', :'site', :'plan', :'r1'), '42501'));
select pg_temp.expect('other site cannot read payments', (select count(*) from public.payments) = 0);
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller reads payments', (select count(*) from public.payments) = 1);
reset role;

-- Webhook access control and validation.
set role authenticated;
select pg_temp.expect('authenticated cannot call it (42501)',
  pg_temp.fails_with(format('select public.process_payment_webhook(%L,%L,%L,%L,500,%L)', 'sandbox', 'x', :'ref1', 'succeeded', 'CDF'), '42501'));
reset role;
set role anon;
select pg_temp.expect('anonymous cannot call it (42501)',
  pg_temp.fails_with(format('select public.process_payment_webhook(%L,%L,%L,%L,500,%L)', 'sandbox', 'x', :'ref1', 'succeeded', 'CDF'), '42501'));
reset role;
select pg_temp.expect('unknown status rejected (22023)',
  pg_temp.fails_with(format('select pg_temp.hook(%L,%L,%L,500,%L)', 'e-bad', :'ref1', 'weird', 'CDF'), '22023'));
select pg_temp.expect('negative amount rejected (22023)',
  pg_temp.fails_with(format('select pg_temp.hook(%L,%L,%L,-1,%L)', 'e-bad', :'ref1', 'succeeded', 'CDF'), '22023'));
select pg_temp.hook('evt-unk', 'MTD-doesnotexist', 'succeeded', 500, 'CDF') ->> 'outcome' as out \gset
select pg_temp.expect('unknown reference is unmatched and changes nothing',
  :'out' = 'unmatched' and (select count(*) from public.sales) = 0 and (select count(*) from public.payments where status <> 'pending') = 0);

-- A confirmed payment: one sale, one ticket, one pending activation command.
select pg_temp.hook('evt-1', :'ref1', 'succeeded', 500, 'CDF') ->> 'fulfillment_status' as out \gset
select pg_temp.expect('confirmed payment is paid and awaits activation',
  :'out' = 'activation_pending' and (select status from public.payments where id = :'pid1'::uuid) = 'paid');
select pg_temp.expect('the sale is recorded as mobile money linked to the payment',
  (select count(*) from public.sales where payment_id = :'pid1'::uuid and payment_method = 'mobile_money' and ticket_code = 'P1' and amount = 500) = 1);
select pg_temp.expect('the ticket and stock voucher are sold',
  (select count(*) from public.tickets where code = 'P1' and status = 'sold') = 1
  and (select status from public.ticket_stock where code = 'P1') = 'sold');
select pg_temp.expect('one activation command is queued with the plan duration and profile',
  (select count(*) from public.gateway_commands where operation = 'hotspot.voucher.create' and status = 'pending') = 1
  and (select payload from public.gateway_commands where operation = 'hotspot.voucher.create') = '{"code":"P1","duration_minutes":60,"profile":"1h-profile"}'::jsonb);
select pg_temp.hook('evt-1', :'ref1', 'succeeded', 500, 'CDF') ->> 'outcome' as out \gset
select pg_temp.expect('duplicate webhook is a no-op', :'out' = 'duplicate');
select pg_temp.hook('evt-1b', :'ref1', 'succeeded', 500, 'CDF') ->> 'outcome' as out \gset
select pg_temp.expect('another success event for a paid payment issues no second ticket', :'out' = 'already_paid');
select pg_temp.expect('still exactly one sale, ticket and command',
  (select count(*) from public.sales) = 1 and (select count(*) from public.tickets) = 1
  and (select count(*) from public.gateway_commands) = 1
  and (select count(*) from public.ticket_stock where status = 'sold') = 1);

-- Gateway absent: paid but not activated, no false activation.
select pg_temp.expect('with the Gateway absent the payment is paid but not activated',
  (select status || '/' || fulfillment_status from public.payments where id = :'pid1'::uuid) = 'paid/activation_pending'
  and (select status from public.tickets where code = 'P1') = 'sold');

-- The Gateway comes back and confirms.
set role anon;
select command_id as cmd1 from public.claim_gateway_commands(:'g1', 10) \gset
select public.complete_gateway_command(:'g1', :'cmd1', true, '{"created":true}');
reset role;
select pg_temp.expect('Gateway confirmation activates payment and ticket',
  (select fulfillment_status from public.payments where id = :'pid1'::uuid) = 'activated'
  and (select status from public.tickets where code = 'P1') = 'activated');

-- Amount mismatch is never confirmed.
set role authenticated;
select set_config('request.jwt.claim.sub', :'sel', false);
select (public.create_payment(:'site', :'plan', :'r1') ->> 'payment_id') as pid2, (public.create_payment(:'site', :'plan', :'r1', null, 'k2') ->> 'provider_ref') as ref2 \gset
reset role;
select provider_ref as ref2a from public.payments where id = :'pid2'::uuid \gset
select pg_temp.hook('evt-2', :'ref2a', 'succeeded', 400, 'CDF') ->> 'outcome' as out \gset
select pg_temp.expect('underpayment is flagged, not confirmed',
  :'out' = 'amount_mismatch'
  and (select status from public.payments where id = :'pid2'::uuid) = 'mismatch'
  and (select count(*) from public.tickets) = 1
  and (select count(*) from public.ticket_stock where status = 'sold') = 1);
select pg_temp.hook('evt-2c', :'ref2', 'succeeded', 500, 'USD') ->> 'outcome' as out \gset
select pg_temp.expect('a wrong currency is also a mismatch', :'out' = 'amount_mismatch');
select pg_temp.hook('evt-2b', :'ref2a', 'succeeded', 500, 'CDF') ->> 'outcome' as out \gset
select pg_temp.expect('a mismatching payment ignores later events', :'out' = 'ignored');

-- Failed then succeeded (out of order): money received wins.
set role authenticated;
select (public.create_payment(:'site', :'plan', :'r1', null, 'k3') ->> 'provider_ref') as ref3 \gset
reset role;
select pg_temp.hook('evt-3a', :'ref3', 'failed', 500, 'CDF') ->> 'outcome' as out \gset
select pg_temp.expect('failed webhook marks the payment failed',
  :'out' = 'failed' and (select status from public.payments where provider_ref = :'ref3') = 'failed');
select pg_temp.hook('evt-3b', :'ref3', 'succeeded', 500, 'CDF') ->> 'outcome' as out \gset
select pg_temp.expect('a late success after a failure is honoured',
  :'out' = 'paid' and (select count(*) from public.tickets) = 2);

-- Out of stock: paid, no ticket, then retry after restocking.
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select (public.create_payment(:'site', :'plan', :'r1', null, 'k4') ->> 'provider_ref') as ref4 \gset
reset role;
select pg_temp.hook('evt-4', :'ref4', 'succeeded', 500, 'CDF') ->> 'fulfillment_status' as out \gset
select pg_temp.expect('no stock left: paid but out_of_stock, no ticket',
  :'out' = 'out_of_stock'
  and (select status from public.payments where provider_ref = :'ref4') = 'paid'
  and (select count(*) from public.tickets) = 2
  and (select count(*) from public.sales) = 2);
set role authenticated;
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot retry activations (42501)',
  pg_temp.fails_with(format('select public.retry_payment_activation(%L, %L)', :'site', (select id from public.payments where provider_ref = :'ref4')), '42501'));
select set_config('request.jwt.claim.sub', :'own', false);
select public.import_ticket_stock(:'site', :'plan', array['P3']);
select public.retry_payment_activation(:'site', (select id from public.payments where provider_ref = :'ref4')) as out \gset
select pg_temp.expect('retry after restocking fulfils the payment',
  :'out' = 'activation_pending' and (select count(*) from public.tickets) = 3);
select pg_temp.expect('a paid and fulfilled payment has nothing to retry (22023)',
  pg_temp.fails_with(format('select public.retry_payment_activation(%L, %L)', :'site', :'pid1'), '22023'));
reset role;

-- Activation failure and retry; "voucher_exists" counts as activated.
update public.gateway_commands set status = 'failed', error = 'router_unavailable: RouterOS is unavailable', completed_at = now()
where status in ('delivered', 'pending') and operation = 'hotspot.voucher.create';
select pg_temp.expect('router failure leaves paid payments in activation_failed',
  (select count(*) from public.payments where fulfillment_status = 'activation_failed') = 2
  and (select count(*) from public.payments where fulfillment_status = 'activated') = 1);
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select pg_temp.expect('admin retries a failed activation',
  public.retry_payment_activation(:'site', (select id from public.payments where provider_ref = :'ref3')) = 'activation_pending');
reset role;
update public.gateway_commands set status = 'failed', error = 'voucher_exists: a voucher with this code already exists', completed_at = now()
where status = 'pending' and operation = 'hotspot.voucher.create';
select pg_temp.expect('voucher_exists counts as activated',
  (select fulfillment_status from public.payments where provider_ref = :'ref3') = 'activated'
  and (select status from public.tickets where code = (select ticket_code from public.payments where provider_ref = :'ref3')) = 'activated');

-- Expiry and revoked router.
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select (public.create_payment(:'site', :'plan', :'r2', null, 'k5') ->> 'provider_ref') as ref5 \gset
select public.import_ticket_stock(:'site', :'plan', array['P4', 'P5']);
reset role;
update public.payments set expires_at = now() - interval '1 minute' where provider_ref = :'ref5';
set role service_role;
select pg_temp.expect('overdue unpaid payments expire', public.expire_pending_payments() >= 1);
reset role;
set role authenticated;
select public.revoke_gateway(:'site', :'r2');
reset role;
select pg_temp.hook('evt-5', :'ref5', 'succeeded', 500, 'CDF') ->> 'fulfillment_status' as out \gset
select pg_temp.expect('late success on an expired payment for a revoked router: paid, activation_failed, no command',
  :'out' = 'activation_failed'
  and (select status from public.payments where provider_ref = :'ref5') = 'paid'
  and (select count(*) from public.gateway_commands where router_id = :'r2'::uuid and operation = 'hotspot.voucher.create') = 0);

-- Reconciliation, audit and privacy.
set role authenticated;
select set_config('request.jwt.claim.sub', :'vie', false);
select pg_temp.expect('reconciliation reports payment problems',
  (select array_agg(distinct kind order by kind) from public.reconciliation_report(:'site', now() - interval '1 day', now() + interval '1 day')
   where kind like 'payment_%') = array['payment_activation_failed', 'payment_amount_mismatch']);
reset role;
select pg_temp.expect('payments are audited, without the phone number',
  (select count(*) from public.audit_log where action = 'payment.created') >= 5
  and exists (select 1 from public.audit_log where action = 'payment.paid')
  and exists (select 1 from public.audit_log where action = 'payment.activated')
  and exists (select 1 from public.audit_log where action = 'payment.mismatch')
  and not exists (select 1 from public.audit_log where details::text like '%243970000000%'));
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select pg_temp.expect('webhook events are not readable by users (42501)',
  pg_temp.fails_with('select * from public.webhook_events', '42501'));
reset role;
select pg_temp.expect('every webhook event was recorded once',
  (select count(*) from public.webhook_events where event_id = 'evt-1') = 1
  and (select outcome from public.webhook_events where event_id = 'evt-unk') = 'unmatched');
\echo ALL TESTS PASSED
