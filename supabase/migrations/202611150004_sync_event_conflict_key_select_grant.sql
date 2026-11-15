-- PostgreSQL may require SELECT privilege on conflict-arbiter columns for
-- INSERT ... ON CONFLICT DO NOTHING. This temporary grant is superseded by
-- the SECURITY DEFINER RPC boundary in migration 005 and is revoked there.
grant select (site_id, id) on public.sync_events to authenticated;
