\set ON_ERROR_STOP on
\set own '00000000-0000-0000-0000-0000000000b1'
\set mgr '00000000-0000-0000-0000-0000000000b2'
\set sel '00000000-0000-0000-0000-0000000000b3'
\set oth '00000000-0000-0000-0000-0000000000b4'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;
create or replace function pg_temp.denied(p_sql text) returns boolean
language plpgsql as $$ begin execute p_sql; return false;
exception when insufficient_privilege then return true; end $$;

-- True when the statement fails with exactly the expected SQLSTATE.
create or replace function pg_temp.fails_with(p_sql text, p_state text) returns boolean
language plpgsql as $$ begin execute p_sql; return false;
exception when others then return sqlstate = p_state; end $$;

insert into auth.users(id, email) values
  (:'own', 'own@x.test'), (:'mgr', 'mgr@x.test'), (:'sel', 'sel@x.test'), (:'oth', 'oth@x.test');

set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_site_with_owner('Site A') as site \gset
select public.create_site_invitation(:'site', 'mgr@x.test', 'manager') as i_mgr \gset
select public.create_site_invitation(:'site', 'sel@x.test', 'seller') as i_sel \gset
select set_config('request.jwt.claim.sub', :'mgr', false), set_config('request.jwt.claim.email', 'mgr@x.test', false);
select public.accept_site_invitation(:'i_mgr');
select set_config('request.jwt.claim.sub', :'sel', false), set_config('request.jwt.claim.email', 'sel@x.test', false);
select public.accept_site_invitation(:'i_sel');
select set_config('request.jwt.claim.sub', :'oth', false);
select public.create_site_with_owner('Site B') as site_b \gset

-- Plans: managers manage, sellers only read.
select set_config('request.jwt.claim.sub', :'mgr', false);
select public.create_plan(:'site', '1 heure', 500, 'cdf', 60) as plan \gset
select pg_temp.expect('manager creates a plan (currency normalized)',
  (select currency from public.plans where id = :'plan') = 'CDF');
select pg_temp.expect('duplicate plan name rejected (23505)',
  pg_temp.fails_with(format('select public.create_plan(%L, %L, 1, %L, 5)', :'site', '1 heure', 'USD'), '23505'));
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot create a plan',
  pg_temp.denied(format('select public.create_plan(%L, %L, 1, %L, 5)', :'site', 'Autre', 'USD')));
select pg_temp.expect('seller reads plans', (select count(*) from public.plans) = 1);
select pg_temp.expect('seller cannot deactivate a plan',
  pg_temp.denied(format('select public.set_plan_active(%L, %L, false)', :'site', :'plan')));

-- Invalid plan values are rejected.
select set_config('request.jwt.claim.sub', :'mgr', false);
select pg_temp.expect('negative price rejected (22023)',
  pg_temp.fails_with(format('select public.create_plan(%L, %L, -1, %L, 5)', :'site', 'Neg', 'CDF'), '22023'));
select pg_temp.expect('unsupported currency rejected (22023)',
  pg_temp.fails_with(format('select public.create_plan(%L, %L, 1, %L, 5)', :'site', 'Eur', 'EUR'), '22023'));
select pg_temp.expect('zero duration rejected (22023)',
  pg_temp.fails_with(format('select public.create_plan(%L, %L, 1, %L, 0)', :'site', 'Zero', 'CDF'), '22023'));

-- Stock import is idempotent and restricted.
select pg_temp.expect('manager imports stock',
  (public.import_ticket_stock(:'site', :'plan', array['A1', 'A2', 'A2', ' A3 ', '']) ->> 'inserted') = '3');
select pg_temp.expect('re-import inserts nothing',
  (public.import_ticket_stock(:'site', :'plan', array['A1', 'A2', 'A3']) ->> 'inserted') = '0');
select pg_temp.expect('manager reads stock codes', (select count(*) from public.ticket_stock) = 3);
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot import stock',
  pg_temp.denied(format('select public.import_ticket_stock(%L, %L, array[%L])', :'site', :'plan', 'Z1')));
select pg_temp.expect('seller cannot read stock codes', (select count(*) from public.ticket_stock) = 0);
select pg_temp.expect('seller sees stock counters',
  (select available from public.ticket_stock_summary(:'site')) = 3);

-- Isolation: other site's owner sees nothing and cannot act on this site.
select set_config('request.jwt.claim.sub', :'oth', false);
select pg_temp.expect('other site sees no plans', (select count(*) from public.plans) = 0);
select pg_temp.expect('other site cannot import into this plan',
  pg_temp.denied(format('select public.import_ticket_stock(%L, %L, array[%L])', :'site', :'plan', 'Z1')));
select pg_temp.expect('other site cannot read counters',
  pg_temp.denied(format('select * from public.ticket_stock_summary(%L)', :'site')));
select pg_temp.expect('own site has no plan to import into (P0002)',
  pg_temp.fails_with(format('select public.import_ticket_stock(%L, %L, array[%L])', :'site_b', :'plan', 'Q1'), 'P0002'));

-- Audit trail of catalog operations.
select set_config('request.jwt.claim.sub', :'own', false);
select public.set_plan_active(:'site', :'plan', false);
select pg_temp.expect('catalog operations are audited',
  (select count(*) from public.audit_log where action = 'plan.created') = 1
  and (select count(*) from public.audit_log where action = 'plan.updated') = 1
  and (select count(*) from public.audit_log where action = 'ticket_stock.imported') = 2);
reset role;
\echo ALL TESTS PASSED
