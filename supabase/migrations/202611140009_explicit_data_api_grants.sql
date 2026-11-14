-- Explicit Data API grants for the tenant foundation.
-- New Supabase projects no longer automatically expose newly created public tables.
-- RLS remains the row-level authorization boundary.

revoke all on function public.has_site_membership(uuid) from public, anon;
grant execute on function public.has_site_membership(uuid) to authenticated;

grant select on public.routers to authenticated;
grant select on public.site_invitations to authenticated;

-- The stale-gateway transition is intended for a trusted scheduler only.
revoke all on function public.mark_stale_gateways_offline() from public, anon, authenticated;
grant execute on function public.mark_stale_gateways_offline() to service_role;
