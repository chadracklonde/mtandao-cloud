-- Periodic maintenance, run by pg_cron inside the database (no external scheduler needed):
--   every minute   : gateways without a heartbeat for 3 minutes are marked offline;
--   every 5 minutes: overdue Gateway commands and unpaid payments reach their final state.
-- All three functions are idempotent and only touch rows that are already overdue.
-- Where pg_cron is not available (for example a plain PostgreSQL used for tests) this
-- migration does nothing, so it is safe everywhere.

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: maintenance jobs were not scheduled';
    return;
  end if;

  create extension if not exists pg_cron;

  perform cron.schedule('mtandao-stale-gateways', '* * * * *',
    'select public.mark_stale_gateways_offline()');
  perform cron.schedule('mtandao-expire-commands', '*/5 * * * *',
    'select public.expire_gateway_commands()');
  perform cron.schedule('mtandao-expire-payments', '*/5 * * * *',
    'select public.expire_pending_payments()');
end;
$$;
