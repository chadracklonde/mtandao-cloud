\set ON_ERROR_STOP on
\set own '00000000-0000-0000-0000-0000000000c1'
\set sel '00000000-0000-0000-0000-0000000000c2'
\set vie '00000000-0000-0000-0000-0000000000c3'
\set oth '00000000-0000-0000-0000-0000000000c4'
\set dev 'dddddddd-dddd-dddd-dddd-dddddddddddd'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;
create or replace function pg_temp.fails_with(p_sql text, p_state text) returns boolean
language plpgsql as $$ begin execute p_sql; return false;
exception when others then return sqlstate = p_state; end $$;

insert into auth.users(id, email) values
  (:'own', 'own@x.test'), (:'sel', 'sel@x.test'), (:'vie', 'vie@x.test'), (:'oth', 'oth@x.test');

set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_site_with_owner('Site R') as site \gset
select public.create_site_invitation(:'site', 'sel@x.test', 'seller') as i_sel \gset
select public.create_site_invitation(:'site', 'vie@x.test', 'viewer') as i_vie \gset
select set_config('request.jwt.claim.sub', :'sel', false), set_config('request.jwt.claim.email', 'sel@x.test', false);
select public.accept_site_invitation(:'i_sel');
select set_config('request.jwt.claim.sub', :'vie', false), set_config('request.jwt.claim.email', 'vie@x.test', false);
select public.accept_site_invitation(:'i_vie');
select set_config('request.jwt.claim.sub', :'oth', false);
select public.create_site_with_owner('Site Other') as site_b \gset

-- Sales through the real ingestion path. Site timezone is Africa/Lubumbashi (UTC+2):
-- 2026-11-30T23:30Z falls on 2026-12-01 locally.
select set_config('request.jwt.claim.sub', :'own', false);
select public.ingest_sync_events(:'site', jsonb_build_array(
  jsonb_build_object('id','e0000000-0000-0000-0000-0000000000a1','site_id',:'site','device_id',:'dev','event_type','sale.recorded','schema_version',1,'occurred_at','2026-11-10T08:00:00Z',
    'payload', jsonb_build_object('sale_id','50000000-0000-0000-0000-0000000000a1','amount',10,'currency','USD','payment_method','cash','ticket_code','R-1')),
  jsonb_build_object('id','e0000000-0000-0000-0000-0000000000a2','site_id',:'site','device_id',:'dev','event_type','sale.recorded','schema_version',1,'occurred_at','2026-11-10T09:00:00Z',
    'payload', jsonb_build_object('sale_id','50000000-0000-0000-0000-0000000000a2','amount',5.5,'currency','USD','payment_method','mobile_money','ticket_code','R-2')),
  jsonb_build_object('id','e0000000-0000-0000-0000-0000000000a3','site_id',:'site','device_id',:'dev','event_type','sale.recorded','schema_version',1,'occurred_at','2026-11-30T23:30:00Z',
    'payload', jsonb_build_object('sale_id','50000000-0000-0000-0000-0000000000a3','amount',2000,'currency','CDF','payment_method','cash')),
  jsonb_build_object('id','e0000000-0000-0000-0000-0000000000a4','site_id',:'site','device_id',:'dev','event_type','sale.recorded','schema_version',1,'occurred_at','2026-11-11T09:00:00Z',
    'payload', jsonb_build_object('sale_id','50000000-0000-0000-0000-0000000000a1','amount',99,'currency','USD','payment_method','cash','ticket_code','R-1')),
  jsonb_build_object('id','e0000000-0000-0000-0000-0000000000a5','site_id',:'site','device_id',:'dev','event_type','sale.recorded','schema_version',1,'occurred_at','2026-11-12T09:00:00Z',
    'payload', jsonb_build_object('sale_id','50000000-0000-0000-0000-0000000000a5','amount',-3,'currency','USD','payment_method','cash'))
));

-- Daily report.
select pg_temp.expect('daily report groups by local day and currency',
  (select count(*) from public.sales_report(:'site', '2026-11-01Z', '2026-12-05Z', 'day')) = 2
  and (select sales_count from public.sales_report(:'site', '2026-11-01Z', '2026-12-05Z', 'day')
       where period = '2026-12-01' and currency = 'CDF') = 1);
select pg_temp.expect('daily report splits cash and mobile money',
  (select total_amount = 15.5 and cash_amount = 10 and mobile_money_amount = 5.5
   from public.sales_report(:'site', '2026-11-01Z', '2026-12-05Z', 'day')
   where period = '2026-11-10' and currency = 'USD'));
select pg_temp.expect('monthly report merges days',
  (select count(*) from public.sales_report(:'site', '2026-11-01Z', '2026-12-05Z', 'month')) = 2
  and (select total_amount from public.sales_report(:'site', '2026-11-01Z', '2026-12-05Z', 'month')
       where period = '2026-11-01' and currency = 'USD') = 15.5);
select pg_temp.expect('period filter excludes other days',
  (select count(*) from public.sales_report(:'site', '2026-11-30Z', '2026-12-05Z', 'day')) = 1);
select pg_temp.expect('conflicting and invalid sales are not counted as sales',
  (select sum(sales_count) from public.sales_report(:'site', '2026-11-01Z', '2026-12-05Z', 'day')) = 3);

-- Input validation.
select pg_temp.expect('bad group rejected',
  pg_temp.fails_with(format('select * from public.sales_report(%L, null, null, %L)', :'site', 'year'), '22023'));
select pg_temp.expect('inverted period rejected',
  pg_temp.fails_with(format('select * from public.sales_report(%L, %L, %L)', :'site', '2026-12-01Z', '2026-11-01Z'), '22023'));
select pg_temp.expect('period over 366 days rejected',
  pg_temp.fails_with(format('select * from public.sales_report(%L, %L, %L)', :'site', '2024-01-01Z', '2026-01-01Z'), '22023'));

-- Healthy data: only sync problems are reported (1 conflict, 1 rejected event).
select pg_temp.expect('reconciliation reports sync conflict and rejected event only',
  (select count(*) from public.reconciliation_report(:'site', '2026-11-01Z', '2026-12-05Z')) = 2
  and exists (select 1 from public.reconciliation_report(:'site', '2026-11-01Z', '2026-12-05Z') where kind = 'sync_conflict_open')
  and exists (select 1 from public.reconciliation_report(:'site', '2026-11-01Z', '2026-12-05Z') where kind = 'sync_event_rejected'));
reset role;

-- Simulate data drift (e.g. manual correction) and detect each kind.
update public.cash_entries set amount = 9 where sale_id = '50000000-0000-0000-0000-0000000000a1';
delete from public.cash_entries where sale_id = '50000000-0000-0000-0000-0000000000a3';
insert into public.cash_entries(site_id, sale_id, amount, currency, occurred_at)
  values (:'site', '50000000-0000-0000-0000-0000000000a2', 5.5, 'USD', now());
delete from public.tickets where code = 'R-2';
insert into public.sync_events(site_id, id, device_id, event_type, schema_version, occurred_at, payload, received_at)
  values (:'site', 'e0000000-0000-0000-0000-0000000000a9', :'dev', 'sale.recorded', 1, '2026-11-20T00:00:00Z', '{}', '2026-11-20T00:00:00Z');

set role authenticated;
select set_config('request.jwt.claim.sub', :'vie', false);
select pg_temp.expect('viewer detects every discrepancy kind',
  (select array_agg(kind order by kind) from public.reconciliation_report(:'site', '2026-11-01Z', '2026-12-05Z'))
  = array['cash_entry_mismatch', 'cash_entry_missing', 'cash_entry_unexpected',
          'sync_conflict_open', 'sync_event_rejected', 'sync_event_stuck', 'ticket_missing']);

-- Access control and isolation.
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot read the sales report',
  pg_temp.fails_with(format('select * from public.sales_report(%L)', :'site'), '42501'));
select pg_temp.expect('seller cannot read reconciliation',
  pg_temp.fails_with(format('select * from public.reconciliation_report(%L)', :'site'), '42501'));
select set_config('request.jwt.claim.sub', :'oth', false);
select pg_temp.expect('other site cannot read this report',
  pg_temp.fails_with(format('select * from public.sales_report(%L)', :'site'), '42501'));
select pg_temp.expect('other site has an empty report',
  (select count(*) from public.sales_report(:'site_b', '2026-11-01Z', '2026-12-05Z')) = 0);
reset role;
set role anon;
select pg_temp.expect('anonymous users cannot call reports',
  pg_temp.fails_with(format('select * from public.sales_report(%L)', :'site'), '42501'));
reset role;
\echo ALL TESTS PASSED
