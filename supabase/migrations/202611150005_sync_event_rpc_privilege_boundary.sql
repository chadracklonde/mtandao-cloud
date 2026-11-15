-- The RPC performs an explicit membership check before writing. Run it as
-- its trusted owner so ON CONFLICT can safely resolve duplicate event IDs
-- without granting authenticated users table read access. Direct table writes
-- remain protected by RLS.
alter function public.ingest_sync_events(uuid, jsonb) security definer;
revoke select (site_id, id) on public.sync_events from authenticated;
