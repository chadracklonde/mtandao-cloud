\set ON_ERROR_STOP on
\set s1 '11111111-1111-1111-1111-111111111111'
\set s2 '22222222-2222-2222-2222-222222222222'
\set u1 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set u2 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set dev 'dddddddd-dddd-dddd-dddd-dddddddddddd'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;

insert into public.sites(id, name) values (:'s1', 'Site 1'), (:'s2', 'Site 2');
insert into public.site_memberships(site_id, user_id, role) values
  (:'s1', :'u1', 'owner'), (:'s2', :'u2', 'owner');

create or replace function pg_temp.ev(p_site uuid, p_id uuid, p_payload jsonb, p_type text default 'sale.recorded')
returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'id', p_id, 'site_id', p_site, 'device_id', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'event_type', p_type, 'schema_version', 1, 'occurred_at', '2026-11-16T10:00:00Z',
    'payload', p_payload)) $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);

-- 1. A sale event creates one sale, one ticket and one cash entry.
select pg_temp.expect('first ingest inserts and processes',
  (public.ingest_sync_events(:'s1',
    pg_temp.ev(:'s1', 'e0000000-0000-0000-0000-000000000001',
      '{"sale_id":"50000000-0000-0000-0000-000000000001","amount":5.5,"currency":"USD","payment_method":"cash","ticket_code":"T-001","plan_name":"1h"}'))
   ->> 'processed_count') = '1');

-- 2. Same event sent twice: still one write.
select pg_temp.expect('resend is acknowledged without new insert',
  (public.ingest_sync_events(:'s1',
    pg_temp.ev(:'s1', 'e0000000-0000-0000-0000-000000000001',
      '{"sale_id":"50000000-0000-0000-0000-000000000001","amount":5.5,"currency":"USD","payment_method":"cash","ticket_code":"T-001"}'))
   ->> 'inserted_count') = '0');

-- 3. Same sale under a new event id and identical content: no-op.
select public.ingest_sync_events(:'s1',
  pg_temp.ev(:'s1', 'e0000000-0000-0000-0000-000000000002',
    '{"sale_id":"50000000-0000-0000-0000-000000000001","amount":5.5,"currency":"USD","payment_method":"cash","ticket_code":"T-001"}'));

select pg_temp.expect('one sale, one ticket, one cash entry',
  (select count(*) from public.sales) = 1
  and (select count(*) from public.tickets) = 1
  and (select count(*) from public.cash_entries) = 1);

-- 4. Divergent replay of the same sale: conflict, original untouched.
select pg_temp.expect('sale mismatch is a conflict',
  (public.ingest_sync_events(:'s1',
    pg_temp.ev(:'s1', 'e0000000-0000-0000-0000-000000000003',
      '{"sale_id":"50000000-0000-0000-0000-000000000001","amount":9,"currency":"USD","payment_method":"cash","ticket_code":"T-001"}'))
   ->> 'conflict_count') = '1');
select pg_temp.expect('original sale unchanged',
  (select amount from public.sales) = 5.5);

-- 5. Ticket code reused by another sale: conflict, no second sale.
select pg_temp.expect('ticket code reuse is a conflict',
  (public.ingest_sync_events(:'s1',
    pg_temp.ev(:'s1', 'e0000000-0000-0000-0000-000000000004',
      '{"sale_id":"50000000-0000-0000-0000-000000000002","amount":1,"currency":"CDF","payment_method":"mobile_money","ticket_code":"T-001"}'))
   ->> 'conflict_count') = '1');
select pg_temp.expect('no second sale after ticket conflict', (select count(*) from public.sales) = 1);

-- 6. Invalid payload is rejected but still acknowledged.
select pg_temp.expect('invalid payload is rejected and acknowledged',
  (public.ingest_sync_events(:'s1',
    pg_temp.ev(:'s1', 'e0000000-0000-0000-0000-000000000005',
      '{"sale_id":"50000000-0000-0000-0000-000000000003","amount":-1,"currency":"CDF","payment_method":"cash"}'))
   ->> 'rejected_count') = '1');

-- 7. Unknown event type is rejected.
select pg_temp.expect('unsupported event type is rejected',
  (public.ingest_sync_events(:'s1',
    pg_temp.ev(:'s1', 'e0000000-0000-0000-0000-000000000006', '{}', 'device.pinged'))
   ->> 'rejected_count') = '1');

-- 8. Members read business tables; payloads stay private.
select pg_temp.expect('member reads own conflicts', (select count(*) from public.sync_conflicts) = 2);
do $$ begin
  begin perform 1 from public.sync_events; raise exception 'FAIL: sync_events readable';
  exception when insufficient_privilege then raise notice 'ok - sync_events not readable'; end;
  begin insert into public.sales(site_id,id,source_event_id,device_id,amount,currency,payment_method,sold_at)
    values ('11111111-1111-1111-1111-111111111111', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'CDF', 'cash', now());
    raise exception 'FAIL: direct sales insert allowed';
  exception when insufficient_privilege then raise notice 'ok - direct sales insert denied'; end;
end $$;

-- 9. Site isolation.
select set_config('request.jwt.claim.sub', :'u2', false);
select pg_temp.expect('other site sees nothing',
  (select count(*) from public.sales) = 0 and (select count(*) from public.tickets) = 0
  and (select count(*) from public.cash_entries) = 0 and (select count(*) from public.sync_conflicts) = 0);
do $$ begin
  begin perform public.ingest_sync_events('11111111-1111-1111-1111-111111111111',
    '[{"id":"e0000000-0000-0000-0000-000000000009"}]'::jsonb);
    raise exception 'FAIL: cross-site ingest allowed';
  exception when insufficient_privilege then raise notice 'ok - cross-site ingest denied'; end;
  begin perform public.process_pending_sync_events('22222222-2222-2222-2222-222222222222', 10);
    raise exception 'FAIL: authenticated can run worker';
  exception when insufficient_privilege then raise notice 'ok - worker function denied to users'; end;
end $$;
reset role;

-- 10. Worker processes legacy pending events.
insert into public.sync_events(site_id, id, device_id, event_type, schema_version, occurred_at, payload)
values (:'s1', 'e0000000-0000-0000-0000-000000000010', :'dev', 'sale.recorded', 1, now(),
  '{"sale_id":"50000000-0000-0000-0000-000000000010","amount":2,"currency":"CDF","payment_method":"mobile_money"}');
set role service_role;
select pg_temp.expect('worker processes pending events',
  public.process_pending_sync_events(:'s1', 10) = 1);
reset role;
select pg_temp.expect('legacy sale created without cash entry',
  (select count(*) from public.sales where site_id = :'s1') = 2
  and (select count(*) from public.cash_entries where site_id = :'s1') = 1);
\echo ALL TESTS PASSED
