-- Align the Cloud with the Gateway: voucher codes and Hotspot profiles must
-- match the formats the Gateway is willing to send to RouterOS. A code accepted
-- here is therefore always executable there.
--   code    : [A-Za-z0-9_.-]{1,64}
--   profile : [A-Za-z0-9 _.-]{1,120}

create or replace function private.validate_command_payload(p_operation text, p_payload jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be an object' using errcode = '22023';
  end if;
  if length(p_payload::text) > 4096 then
    raise exception 'payload is too large' using errcode = '22023';
  end if;

  if p_operation = 'hotspot.voucher.create' then
    if coalesce(jsonb_typeof(p_payload->'code'), '') <> 'string'
       or (p_payload->>'code') !~ '^[A-Za-z0-9_.-]{1,64}$'
       or exists (select 1 from jsonb_object_keys(p_payload) k
                  where k not in ('code', 'profile', 'duration_minutes'))
       or (p_payload ? 'profile' and (jsonb_typeof(p_payload->'profile') <> 'string'
            or (p_payload->>'profile') !~ '^[A-Za-z0-9 _.-]{1,120}$'))
       or (p_payload ? 'duration_minutes' and (jsonb_typeof(p_payload->'duration_minutes') <> 'number'
            or (p_payload->>'duration_minutes')::numeric not between 1 and 525600
            or (p_payload->>'duration_minutes')::numeric <> trunc((p_payload->>'duration_minutes')::numeric))) then
      raise exception 'invalid voucher payload' using errcode = '22023';
    end if;
  elsif p_operation = 'hotspot.voucher.disable' then
    if coalesce(jsonb_typeof(p_payload->'code'), '') <> 'string'
       or (p_payload->>'code') !~ '^[A-Za-z0-9_.-]{1,64}$'
       or exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'code') then
      raise exception 'invalid voucher payload' using errcode = '22023';
    end if;
  elsif p_operation in ('health.check', 'hotspot.profile.list', 'hotspot.active-sessions.list') then
    if p_payload <> '{}'::jsonb then
      raise exception 'this operation takes no payload' using errcode = '22023';
    end if;
  else
    raise exception 'unsupported operation' using errcode = '22023';
  end if;
end;
$$;

-- Existing stock is left untouched; the constraint applies to new rows.
alter table public.ticket_stock
  add constraint ticket_stock_code_format check (code ~ '^[A-Za-z0-9_.-]{1,64}$') not valid;

create or replace function public.import_ticket_stock(
  p_site_id uuid,
  p_plan_id uuid,
  p_codes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean text[];
  v_inserted integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager']) then
    raise exception 'Insufficient permission to import ticket stock' using errcode = '42501';
  end if;
  if not exists (select 1 from public.plans where site_id = p_site_id and id = p_plan_id) then
    raise exception 'Plan not found in this site' using errcode = 'P0002';
  end if;
  if p_codes is null or coalesce(array_length(p_codes, 1), 0) not between 1 and 1000 then
    raise exception 'Import between 1 and 1000 codes at a time' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct btrim(c)), '{}') into v_clean
  from unnest(p_codes) c
  where btrim(coalesce(c, '')) <> '';

  if exists (select 1 from unnest(v_clean) c where c !~ '^[A-Za-z0-9_.-]{1,64}$') then
    raise exception 'Codes may only contain letters, digits, dot, dash and underscore (max 64)'
      using errcode = '22023';
  end if;

  insert into public.ticket_stock(site_id, plan_id, code)
  select p_site_id, p_plan_id, c from unnest(v_clean) c
  on conflict (site_id, code) do nothing;
  get diagnostics v_inserted = row_count;

  perform private.write_audit(p_site_id, 'ticket_stock.imported', 'plan', p_plan_id::text,
    jsonb_build_object('submitted', coalesce(array_length(p_codes, 1), 0),
                       'distinct', coalesce(array_length(v_clean, 1), 0),
                       'inserted', v_inserted));

  return jsonb_build_object('submitted', array_length(p_codes, 1),
                            'inserted', v_inserted,
                            'skipped', coalesce(array_length(v_clean, 1), 0) - v_inserted);
end;
$$;
