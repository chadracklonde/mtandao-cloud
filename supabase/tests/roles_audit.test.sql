\set ON_ERROR_STOP on
\set own '00000000-0000-0000-0000-0000000000a1'
\set adm '00000000-0000-0000-0000-0000000000a2'
\set sel '00000000-0000-0000-0000-0000000000a3'
\set tec '00000000-0000-0000-0000-0000000000a4'
\set vie '00000000-0000-0000-0000-0000000000a5'
\set out '00000000-0000-0000-0000-0000000000a6'
\set hash '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void
language plpgsql as $$ begin
  if not p_ok then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name; end $$;

-- Returns true when the statement fails with insufficient_privilege (42501).
create or replace function pg_temp.denied(p_sql text) returns boolean
language plpgsql as $$ begin
  execute p_sql; return false;
exception when insufficient_privilege then return true; end $$;

insert into auth.users(id, email) values
  (:'own', 'own@x.test'), (:'adm', 'adm@x.test'), (:'sel', 'sel@x.test'),
  (:'tec', 'tec@x.test'), (:'vie', 'vie@x.test'), (:'out', 'out@x.test');

-- Site created by the owner; audit row written with the actor.
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select public.create_site_with_owner('Audit Site') as site \gset
reset role;
select pg_temp.expect('site creation is audited with its actor',
  exists (select 1 from public.audit_log where site_id = :'site'::uuid
          and action = 'site.created' and actor_user_id = :'own'::uuid)
  and exists (select 1 from public.audit_log where site_id = :'site'::uuid
          and action = 'member.added' and entity_id = :'own' and details->>'role' = 'owner'));

-- Owner invites everyone; invitees accept.
set role authenticated;
select public.create_site_invitation(:'site', 'adm@x.test', 'admin') as i_adm \gset
select public.create_site_invitation(:'site', 'sel@x.test', 'seller') as i_sel \gset
select public.create_site_invitation(:'site', 'tec@x.test', 'technician') as i_tec \gset
select public.create_site_invitation(:'site', 'vie@x.test', 'viewer') as i_vie \gset

select set_config('request.jwt.claim.sub', :'adm', false), set_config('request.jwt.claim.email', 'adm@x.test', false);
select public.accept_site_invitation(:'i_adm');
select set_config('request.jwt.claim.sub', :'sel', false), set_config('request.jwt.claim.email', 'sel@x.test', false);
select public.accept_site_invitation(:'i_sel');
select set_config('request.jwt.claim.sub', :'tec', false), set_config('request.jwt.claim.email', 'tec@x.test', false);
select public.accept_site_invitation(:'i_tec');
select set_config('request.jwt.claim.sub', :'vie', false), set_config('request.jwt.claim.email', 'vie@x.test', false);
select public.accept_site_invitation(:'i_vie');
reset role;
select pg_temp.expect('invitations created and accepted are audited',
  (select count(*) from public.audit_log where action = 'invitation.created') = 4
  and (select count(*) from public.audit_log where action = 'invitation.accepted') = 4
  and (select count(*) from public.audit_log where action = 'member.added') = 5);

-- Role matrix for invitations.
set role authenticated;
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot invite',
  pg_temp.denied(format('select public.create_site_invitation(%L, %L, %L)', :'site', 'n1@x.test', 'viewer')));
select set_config('request.jwt.claim.sub', :'vie', false);
select pg_temp.expect('viewer cannot invite',
  pg_temp.denied(format('select public.create_site_invitation(%L, %L, %L)', :'site', 'n2@x.test', 'viewer')));
select set_config('request.jwt.claim.sub', :'tec', false);
select pg_temp.expect('technician cannot invite',
  pg_temp.denied(format('select public.create_site_invitation(%L, %L, %L)', :'site', 'n3@x.test', 'viewer')));
select set_config('request.jwt.claim.sub', :'adm', false);
select pg_temp.expect('admin cannot invite another admin',
  pg_temp.denied(format('select public.create_site_invitation(%L, %L, %L)', :'site', 'n4@x.test', 'admin')));
select pg_temp.expect('admin can invite a manager',
  public.create_site_invitation(:'site', 'n5@x.test', 'manager') is not null);
select set_config('request.jwt.claim.sub', :'out', false);
select pg_temp.expect('non-member cannot invite',
  pg_temp.denied(format('select public.create_site_invitation(%L, %L, %L)', :'site', 'n6@x.test', 'viewer')));

-- Role matrix for routers and gateways.
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot register a router',
  pg_temp.denied(format('select public.register_router(%L, %L, %L, %L, %L)', :'site', 'R', 'ident', 'linux', :'hash')));
select set_config('request.jwt.claim.sub', :'tec', false);
select public.register_router(:'site', 'Router A', 'ident-a', 'linux', :'hash') as router \gset
select pg_temp.expect('technician can register a router', :'router' is not null);
select pg_temp.expect('technician cannot revoke a gateway',
  pg_temp.denied(format('select public.revoke_gateway(%L, %L)', :'site', :'router')));
select set_config('request.jwt.claim.sub', :'vie', false);
select pg_temp.expect('viewer cannot revoke a gateway',
  pg_temp.denied(format('select public.revoke_gateway(%L, %L)', :'site', :'router')));
select set_config('request.jwt.claim.sub', :'adm', false);
select public.revoke_gateway(:'site', :'router');
select public.reenroll_gateway(:'site', :'router',
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210');
reset role;
select pg_temp.expect('router lifecycle is audited with actor',
  exists (select 1 from public.audit_log where action = 'router.registered' and actor_user_id = :'tec'::uuid)
  and exists (select 1 from public.audit_log where action = 'gateway.revoked' and actor_user_id = :'adm'::uuid)
  and exists (select 1 from public.audit_log where action = 'gateway.reenrollment_started' and actor_user_id = :'adm'::uuid));

-- Audit log visibility: owners/admins only.
set role authenticated;
select set_config('request.jwt.claim.sub', :'own', false);
select pg_temp.expect('owner reads the audit log', (select count(*) from public.audit_log) >= 10);
select set_config('request.jwt.claim.sub', :'adm', false);
select pg_temp.expect('admin reads the audit log', (select count(*) from public.audit_log) >= 10);
select set_config('request.jwt.claim.sub', :'tec', false);
select pg_temp.expect('technician cannot read the audit log', (select count(*) from public.audit_log) = 0);
select set_config('request.jwt.claim.sub', :'sel', false);
select pg_temp.expect('seller cannot read the audit log', (select count(*) from public.audit_log) = 0);
select set_config('request.jwt.claim.sub', :'out', false);
select pg_temp.expect('non-member cannot read the audit log', (select count(*) from public.audit_log) = 0);

-- Append-only, and not writable by clients.
select set_config('request.jwt.claim.sub', :'own', false);
select pg_temp.expect('users cannot insert audit rows',
  pg_temp.denied(format('insert into public.audit_log(site_id, action, entity_type) values (%L, %L, %L)', :'site', 'x', 'x')));
select pg_temp.expect('users cannot update audit rows',
  pg_temp.denied('update public.audit_log set action = ''tampered'''));
select pg_temp.expect('users cannot delete audit rows',
  pg_temp.denied('delete from public.audit_log'));
reset role;
do $$ begin
  begin update public.audit_log set action = 'tampered'; raise exception 'FAIL: update allowed';
  exception when insufficient_privilege then raise notice 'ok - even the owner role cannot update audit rows'; end;
  begin delete from public.audit_log; raise exception 'FAIL: delete allowed';
  exception when insufficient_privilege then raise notice 'ok - even the owner role cannot delete audit rows'; end;
  begin truncate public.audit_log; raise exception 'FAIL: truncate allowed';
  exception when insufficient_privilege then raise notice 'ok - even the owner role cannot truncate audit rows'; end;
end $$;
\echo ALL TESTS PASSED
