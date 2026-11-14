-- Secure, atomic site creation for an authenticated Supabase user.
-- The caller never supplies an owner user_id: auth.uid() is authoritative.
create or replace function public.create_site_with_owner(
  p_name text,
  p_default_currency text default 'CDF',
  p_timezone text default 'Africa/Lubumbashi'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_site_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_currency text := upper(trim(coalesce(p_default_currency, '')));
  v_timezone text := trim(coalesce(p_timezone, ''));
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Site name must contain between 2 and 120 characters'
      using errcode = '22023';
  end if;

  if v_currency not in ('CDF', 'USD') then
    raise exception 'Unsupported currency; use CDF or USD'
      using errcode = '22023';
  end if;

  if v_timezone = '' or not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = v_timezone
  ) then
    raise exception 'Invalid timezone' using errcode = '22023';
  end if;

  insert into public.sites (name, default_currency, timezone)
  values (v_name, v_currency, v_timezone)
  returning id into v_site_id;

  insert into public.site_memberships (site_id, user_id, role, status)
  values (v_site_id, v_user_id, 'owner', 'active');

  return v_site_id;
end;
$$;

revoke all on function public.create_site_with_owner(text, text, text) from public;
revoke all on function public.create_site_with_owner(text, text, text) from anon;
grant execute on function public.create_site_with_owner(text, text, text) to authenticated;

comment on function public.create_site_with_owner(text, text, text) is
  'Creates a site and its authenticated owner membership atomically.';
