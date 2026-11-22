\set ON_ERROR_STOP on
\set own '00000000-0000-0000-0000-0000000000d1'
\set sel '00000000-0000-0000-0000-0000000000d2'
\set dev 'dddddddd-dddd-dddd-dddd-dddddddddddd'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;
create or replace function pg_temp.fails_with(p_sql text, p_state text) returns boolean
language plpgsql as $$ begin execute p_sql; return false;
exception when others then return sqlstate = p_state; end $$;

insert into auth.users(id, email) values (:'own', 'own@x.test'), (:'sel', 'sel@x.test');
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_site_with_owner('Site C') as site \gset
select public.create_site_invitation(:'site', 'sel@x.test', 'seller') as i_sel \gset
select set_config('request.jwt.claim.sub', :'sel', false), set_config('request.jwt.claim.email', 'sel@x.test', false);
select public.accept_site_invitation(:'i_sel');
select set_config('request.jwt.claim.sub', :'own', false);

select public.ingest_sync_events(:'site', jsonb_build_array(
  jsonb_build_object('id','e0000000-0000-0000-0000-0000000000b1','site_id',:'site','device_id',:'dev','event_type','sale.recorded','schema_version',1,'occurred_at','2026-11-10T08:00:00Z',
    'payload', jsonb_build_object('sale_id','50000000-0000-0000-0000-0000000000b1','amount',10,'currency','USD','payment_method','cash','ticket_code','C-1')),
  jsonb_build_object('id','e0000000-0000-0000-0000-0000000000b2','site_id',:'site','device_id',:'dev','event_type','sale.recorded','schema_version',1,'occurred_at','2026-11-11T08:00:00Z',
    'payload', jsonb_build_object('sale_id','50000000-0000-0000-0000-0000000000b1','amount',99,'currency','USD','payment_method','cash','ticket_code','C-1'))
));
select id as cid from public.sync_conflicts where site_id = :'site' \gset
select pg_temp.expect('one open conflict', (select count(*) from public.sync_conflicts where resolved_at is null) = 1);

select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot resolve',
  pg_temp.fails_with(format('select public.resolve_sync_conflict(%L, %L, ''dismissed'')', :'site', :'cid'), '42501'));

select set_config('request.jwt.claim.sub', :'own', false);
select pg_temp.expect('invalid resolution refused',
  pg_temp.fails_with(format('select public.resolve_sync_conflict(%L, %L, ''delete_sale'')', :'site', :'cid'), '22023'));
select pg_temp.expect('unknown conflict refused',
  pg_temp.fails_with(format('select public.resolve_sync_conflict(%L, %L, ''dismissed'')', :'site', gen_random_uuid()), 'P0002'));

select public.resolve_sync_conflict(:'site', :'cid', 'keep_cloud', '  vérifié avec le vendeur ');
select pg_temp.expect('conflict closed with author and decision',
  (select resolved_at is not null and resolved_by = :'own' and resolution = 'keep_cloud'
          and resolution_note = 'vérifié avec le vendeur' from public.sync_conflicts where id = :'cid'));
select pg_temp.expect('resolving twice refused',
  pg_temp.fails_with(format('select public.resolve_sync_conflict(%L, %L, ''dismissed'')', :'site', :'cid'), '23505'));
select pg_temp.expect('sale left untouched', (select amount from public.sales where site_id = :'site') = 10);
select pg_temp.expect('decision is audited',
  (select count(*) from public.audit_log where site_id = :'site' and action = 'sync_conflict.resolved') = 1);
select pg_temp.expect('reconciliation no longer lists it',
  (select count(*) from public.reconciliation_report(:'site', '2026-01-01Z', '2027-01-01Z') where kind = 'sync_conflict_open') = 0);

-- Another site's owner cannot touch it.
reset role; insert into auth.users(id, email) values ('00000000-0000-0000-0000-0000000000d3', 'o@x.test'); set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', false);
select public.create_site_with_owner('Other') as site_b \gset
select pg_temp.expect('cross-site resolution refused',
  pg_temp.fails_with(format('select public.resolve_sync_conflict(%L, %L, ''dismissed'')', :'site_b', :'cid'), 'P0002'));
select 'PASSED';
