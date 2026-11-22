-- LOT 11: record a decision on synchronization conflicts.
-- Resolving a conflict is a human decision that is written down (who, when, what, why).
-- It never rewrites sales, tickets or cash entries: the server keeps the first version it
-- accepted, and a resolution only closes the item in the reconciliation report.

alter table public.sync_conflicts
  add column if not exists resolved_by uuid references auth.users(id) on delete set null,
  add column if not exists resolution text,
  add column if not exists resolution_note text;

alter table public.sync_conflicts
  add constraint sync_conflicts_resolution_check
  check (resolution is null or resolution in ('keep_cloud', 'dismissed')) not valid;

create or replace function public.resolve_sync_conflict(
  p_site_id uuid,
  p_conflict_id uuid,
  p_resolution text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.sync_conflicts%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager']) then
    raise exception 'Insufficient permission to resolve conflicts' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('keep_cloud', 'dismissed') then
    raise exception 'Invalid resolution' using errcode = '22023';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'Note too long' using errcode = '22023';
  end if;

  select * into v_row from public.sync_conflicts
  where site_id = p_site_id and id = p_conflict_id for update;
  if not found then
    raise exception 'Conflict not found' using errcode = 'P0002';
  end if;
  if v_row.resolved_at is not null then
    raise exception 'Conflict already resolved' using errcode = '23505';
  end if;

  update public.sync_conflicts
  set resolved_at = now(), resolved_by = auth.uid(), resolution = p_resolution, resolution_note = v_note
  where site_id = p_site_id and id = p_conflict_id;

  perform private.write_audit(p_site_id, 'sync_conflict.resolved', 'sync_conflict', p_conflict_id::text,
    jsonb_build_object('resolution', p_resolution, 'conflict_type', v_row.conflict_type,
                       'event_id', v_row.event_id, 'note', v_note));

  return jsonb_build_object('id', p_conflict_id, 'resolution', p_resolution, 'resolved', true);
end;
$$;

revoke all on function public.resolve_sync_conflict(uuid, uuid, text, text) from public, anon;
grant execute on function public.resolve_sync_conflict(uuid, uuid, text, text) to authenticated;
