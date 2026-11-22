\set ON_ERROR_STOP on
\set own '00000000-0000-0000-0000-0000000000d1'
\set tec '00000000-0000-0000-0000-0000000000d2'
\set sel '00000000-0000-0000-0000-0000000000d3'
\set oth '00000000-0000-0000-0000-0000000000d4'
\set e1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'
\set g1 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1'
\set e2 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2'
\set g2 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;
create or replace function pg_temp.fails_with(p_sql text, p_state text) returns boolean
language plpgsql as $$ begin execute p_sql; return false;
exception when others then return sqlstate = p_state; end $$;

insert into auth.users(id, email) values
  (:'own', 'own@x.test'), (:'tec', 'tec@x.test'), (:'sel', 'sel@x.test'), (:'oth', 'oth@x.test');

set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_site_with_owner('Site C') as site \gset
select public.create_site_invitation(:'site', 'tec@x.test', 'technician') as i_tec \gset
select public.create_site_invitation(:'site', 'sel@x.test', 'seller') as i_sel \gset
select public.register_router(:'site', 'R1', 'ident-1', 'linux', :'e1') as r1 \gset
select public.register_router(:'site', 'R2', 'ident-2', 'linux', :'e2') as r2 \gset
select set_config('request.jwt.claim.sub', :'tec', false), set_config('request.jwt.claim.email', 'tec@x.test', false);
select public.accept_site_invitation(:'i_tec');
select set_config('request.jwt.claim.sub', :'sel', false), set_config('request.jwt.claim.email', 'sel@x.test', false);
select public.accept_site_invitation(:'i_sel');
select set_config('request.jwt.claim.sub', :'oth', false);
select public.create_site_with_owner('Site Other') as site_b \gset
reset role;

-- Gateways enroll (anonymous role, like the real flow).
set role anon;
select count(*) from public.redeem_gateway_enrollment(:'e1', :'g1');
select count(*) from public.redeem_gateway_enrollment(:'e2', :'g2');
reset role;

-- Roles and validation when enqueueing.
set role authenticated;
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot send commands',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L)', :'site', :'r1', 'health.check'), '42501'));
select set_config('request.jwt.claim.sub', :'tec', false);
select pg_temp.expect('technician cannot manage vouchers',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.create', '{"code":"A1"}'), '42501'));
select public.create_gateway_command(:'site', :'r1', 'health.check') as c_health \gset
select pg_temp.expect('technician can send a health check', :'c_health' is not null);
select set_config('request.jwt.claim.sub', :'own', false);
select pg_temp.expect('unknown operation rejected',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L)', :'site', :'r1', 'system.reboot'), '22023'));
select pg_temp.expect('voucher without code rejected',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.create', '{}'), '22023'));
select pg_temp.expect('voucher with unexpected field rejected',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.create', '{"code":"A1","cmd":"/system reset"}'), '22023'));
select pg_temp.expect('voucher code with a space rejected (22023)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.create', '{"code":"A 1"}'), '22023'));
select pg_temp.expect('voucher code with a quote rejected (22023)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.disable', '{"code":"a\"b"}'), '22023'));
select pg_temp.expect('profile with a newline rejected (22023)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.create', '{"code":"A1","profile":"x\ny"}'), '22023'));
select pg_temp.expect('voucher with data limit and app comment accepted',
  public.create_gateway_command(:'site', :'r1', 'hotspot.voucher.create', '{"code":"L1","duration_minutes":120,"data_limit_mb":500,"comment":"vc-221126-1432 cloud"}', 300, 'limits-ok') is not null);
select pg_temp.expect('a comment without the vc-/up- prefix is rejected (22023)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.create', '{"code":"L2","comment":"free text"}'), '22023'));
select pg_temp.expect('a data limit of zero is rejected (22023)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.create', '{"code":"L3","data_limit_mb":0}'), '22023'));
select pg_temp.expect('a fractional data limit is rejected (22023)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'hotspot.voucher.create', '{"code":"L4","data_limit_mb":1.5}'), '22023'));
select pg_temp.expect('payload on a no-payload operation rejected',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L)', :'site', :'r1', 'health.check', '{"x":1}'), '22023'));
select pg_temp.expect('ttl out of range rejected',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L, 5)', :'site', :'r1', 'health.check', '{}'), '22023'));
select pg_temp.expect('router used from another site rejected (42501)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L)', :'site_b', :'r1', 'health.check'), '42501'));
select public.create_gateway_command(:'site', :'r1', 'hotspot.voucher.create', '{"code":"V-1","duration_minutes":60}', 300, 'idem-1') as c_v \gset
select pg_temp.expect('idempotent creation returns the same command',
  public.create_gateway_command(:'site', :'r1', 'hotspot.voucher.create', '{"code":"V-1","duration_minutes":60}', 300, 'idem-1') = :'c_v'::uuid);
select pg_temp.expect('idempotency key reused with another payload rejected (23505)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L, %L, 300, %L)', :'site', :'r1', 'hotspot.voucher.create', '{"code":"V-2"}', 'idem-1'), '23505'));
select public.create_gateway_command(:'site', :'r2', 'health.check') as c_r2 \gset

-- Visibility.
select pg_temp.expect('owner sees 4 commands', (select count(*) from public.gateway_commands) = 4);
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot read commands', (select count(*) from public.gateway_commands) = 0);
select set_config('request.jwt.claim.sub', :'oth', false);
select pg_temp.expect('other site cannot read commands', (select count(*) from public.gateway_commands) = 0);
reset role;

-- Gateway claims: only its own router's commands, each delivered once.
set role anon;
select pg_temp.expect('gateway 1 receives its three commands in order',
  (select array_agg(operation order by issued_at, command_id) from public.claim_gateway_commands(:'g1', 10))
  = array['health.check', 'hotspot.voucher.create', 'hotspot.voucher.create']);
select pg_temp.expect('a second claim returns nothing (delivered once)',
  (select count(*) from public.claim_gateway_commands(:'g1', 10)) = 0);
select pg_temp.expect('gateway 2 only gets the command of its own router',
  (select count(*) from public.claim_gateway_commands(:'g2', 10)) = 1);
select pg_temp.expect('invalid credential rejected (28000)',
  pg_temp.fails_with(format('select * from public.claim_gateway_commands(%L)', repeat('0', 64)), '28000'));
select pg_temp.expect('malformed credential rejected (28000)',
  pg_temp.fails_with(format('select * from public.claim_gateway_commands(%L)', 'nope'), '28000'));

-- Results.
select pg_temp.expect('gateway 2 cannot report on the command of router 1 (P0002)',
  pg_temp.fails_with(format('select public.complete_gateway_command(%L, %L, true)', :'g2', :'c_v'), 'P0002'));
select pg_temp.expect('success is recorded',
  public.complete_gateway_command(:'g1', :'c_v', true, '{"created":true}') = 'succeeded');
select pg_temp.expect('retrying the same result is idempotent',
  public.complete_gateway_command(:'g1', :'c_v', true, '{"created":true}') = 'succeeded');
select pg_temp.expect('a contradictory result is rejected (22023)',
  pg_temp.fails_with(format('select public.complete_gateway_command(%L, %L, false)', :'g1', :'c_v'), '22023'));
select pg_temp.expect('failure is recorded with its error',
  public.complete_gateway_command(:'g1', :'c_health', false, '{}', 'router unreachable') = 'failed');
reset role;
select pg_temp.expect('results are stored',
  (select result->>'created' from public.gateway_commands where id = :'c_v') = 'true'
  and (select error from public.gateway_commands where id = :'c_health') = 'router unreachable');

-- Cancellation and expiry.
set role authenticated;
select set_config('request.jwt.claim.sub', :'tec', false);
select public.create_gateway_command(:'site', :'r1', 'hotspot.profile.list') as c_cancel \gset
select pg_temp.expect('pending command can be cancelled', public.cancel_gateway_command(:'site', :'c_cancel') = 'cancelled');
select pg_temp.expect('cancelling twice is idempotent', public.cancel_gateway_command(:'site', :'c_cancel') = 'cancelled');
select pg_temp.expect('a completed command cannot be cancelled (22023)',
  pg_temp.fails_with(format('select public.cancel_gateway_command(%L, %L)', :'site', :'c_health'), '22023'));
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot cancel (42501)',
  pg_temp.fails_with(format('select public.cancel_gateway_command(%L, %L)', :'site', :'c_cancel'), '42501'));
select set_config('request.jwt.claim.sub', :'tec', false);
select public.create_gateway_command(:'site', :'r1', 'hotspot.active-sessions.list', '{}', 30) as c_old \gset
reset role;
update public.gateway_commands set issued_at = now() - interval '1 hour', expires_at = now() - interval '50 minutes' where id = :'c_old';
set role anon;
select pg_temp.expect('an expired command is never delivered',
  (select count(*) from public.claim_gateway_commands(:'g1', 10)) = 0);
reset role;
select pg_temp.expect('expired command is marked expired',
  (select status from public.gateway_commands where id = :'c_old') = 'expired');

-- Revocation stops everything.
set role authenticated;
select set_config('request.jwt.claim.sub', :'tec', false);
select public.create_gateway_command(:'site', :'r2', 'hotspot.profile.list') as c_late \gset
select set_config('request.jwt.claim.sub', :'own', false);
select public.revoke_gateway(:'site', :'r2');
select pg_temp.expect('no command can be sent to a revoked router (22023)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L)', :'site', :'r2', 'health.check'), '22023'));
reset role;
select pg_temp.expect('open commands of a revoked router are cancelled',
  (select status from public.gateway_commands where id = :'c_late') = 'cancelled');
set role anon;
select pg_temp.expect('a revoked gateway cannot claim (28000)',
  pg_temp.fails_with(format('select * from public.claim_gateway_commands(%L)', :'g2'), '28000'));
select pg_temp.expect('a revoked gateway cannot report (28000)',
  pg_temp.fails_with(format('select public.complete_gateway_command(%L, %L, true)', :'g2', :'c_r2'), '28000'));
reset role;

-- Gateways cannot be abused through user-facing paths, and audit never stores payloads.
set role anon;
select pg_temp.expect('anonymous cannot enqueue (42501)',
  pg_temp.fails_with(format('select public.create_gateway_command(%L, %L, %L)', :'site', :'r1', 'health.check'), '42501'));
select pg_temp.expect('anonymous cannot read commands (42501)',
  pg_temp.fails_with('select * from public.gateway_commands', '42501'));
reset role;
select pg_temp.expect('commands are audited without their payload',
  (select count(*) from public.audit_log where action = 'command.created') = 7
  and (select count(*) from public.audit_log where action = 'command.cancelled') >= 2
  and not exists (select 1 from public.audit_log where details::text like '%V-1%'));
\echo ALL TESTS PASSED
