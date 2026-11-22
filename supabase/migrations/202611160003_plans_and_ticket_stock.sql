-- LOT 3: plan catalog and ticket stock.
-- Writes go through SECURITY DEFINER RPCs that enforce roles.

create table if not exists public.plans (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  price numeric(14, 2) not null check (price >= 0),
  currency char(3) not null check (currency in ('CDF', 'USD')),
  duration_minutes integer not null check (duration_minutes between 1 and 525600),
  data_limit_mb integer check (data_limit_mb is null or data_limit_mb > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (site_id, id),
  unique (site_id, name)
);

-- Voucher codes grant network access: only managers and above may read them.
create table if not exists public.ticket_stock (
  site_id uuid not null references public.sites(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  plan_id uuid not null,
  code text not null check (length(code) between 1 and 64),
  status text not null default 'available' check (status in ('available', 'reserved', 'sold', 'void')),
  imported_at timestamptz not null default now(),
  primary key (site_id, id),
  unique (site_id, code),
  foreign key (site_id, plan_id) references public.plans(site_id, id)
);

create index if not exists ticket_stock_site_plan_status_idx
  on public.ticket_stock(site_id, plan_id, status);

alter table public.plans enable row level security;
alter table public.ticket_stock enable row level security;

create policy "site members can read plans"
on public.plans for select to authenticated
using (private.has_site_membership(site_id));

create policy "managers can read ticket stock"
on public.ticket_stock for select to authenticated
using (private.has_site_role(site_id, array['owner', 'admin', 'manager']));

revoke all on public.plans, public.ticket_stock from anon, authenticated;
grant select on public.plans, public.ticket_stock to authenticated;

create index if not exists sales_site_sold_idx on public.sales(site_id, sold_at desc, id desc);
create index if not exists tickets_site_created_idx on public.tickets(site_id, created_at desc, id desc);
create index if not exists cash_entries_site_occurred_idx on public.cash_entries(site_id, occurred_at desc, id desc);

-- Catalog changes are audited like other sensitive operations.
create or replace function private.audit_plans()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.site_id, 'plan.created', 'plan', new.id::text,
      jsonb_build_object('name', new.name, 'price', new.price, 'currency', new.currency));
  elsif new.active is distinct from old.active or new.price is distinct from old.price
        or new.name is distinct from old.name then
    perform private.write_audit(new.site_id, 'plan.updated', 'plan', new.id::text,
      jsonb_build_object('name', new.name, 'price', new.price, 'active', new.active,
                         'previous_price', old.price, 'previous_active', old.active));
  end if;
  return null;
end;
$$;

create trigger audit_plans_write
after insert or update on public.plans
for each row execute function private.audit_plans();

create or replace function public.create_plan(
  p_site_id uuid,
  p_name text,
  p_price numeric,
  p_currency text,
  p_duration_minutes integer,
  p_data_limit_mb integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager']) then
    raise exception 'Insufficient permission to manage plans' using errcode = '42501';
  end if;

  insert into public.plans(site_id, name, price, currency, duration_minutes, data_limit_mb)
  values (p_site_id, btrim(coalesce(p_name, '')), p_price, upper(coalesce(p_currency, '')),
          p_duration_minutes, p_data_limit_mb)
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'A plan with this name already exists' using errcode = '23505';
  when check_violation or not_null_violation then
    raise exception 'Invalid plan' using errcode = '22023';
end;
$$;

create or replace function public.set_plan_active(p_site_id uuid, p_plan_id uuid, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_site_role(p_site_id, array['owner', 'admin', 'manager']) then
    raise exception 'Insufficient permission to manage plans' using errcode = '42501';
  end if;
  if p_active is null then
    raise exception 'active is required' using errcode = '22023';
  end if;

  update public.plans
  set active = p_active, updated_at = now()
  where site_id = p_site_id and id = p_plan_id;
  if not found then
    raise exception 'Plan not found in this site' using errcode = 'P0002';
  end if;
  return p_plan_id;
end;
$$;

-- Imports voucher codes. Duplicates (already in stock or repeated in the
-- batch) are skipped, so re-importing the same file is safe.
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

  if exists (select 1 from unnest(v_clean) c where length(c) > 64) then
    raise exception 'Codes must be at most 64 characters' using errcode = '22023';
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

-- Stock counters for every member; codes themselves stay restricted.
create or replace function public.ticket_stock_summary(p_site_id uuid)
returns table(plan_id uuid, plan_name text, available bigint, reserved bigint, sold bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.has_site_membership(p_site_id) then
    raise exception 'site access denied' using errcode = '42501';
  end if;
  return query
  select p.id, p.name,
         count(*) filter (where s.status = 'available'),
         count(*) filter (where s.status = 'reserved'),
         count(*) filter (where s.status = 'sold')
  from public.plans p
  left join public.ticket_stock s on s.site_id = p.site_id and s.plan_id = p.id
  where p.site_id = p_site_id
  group by p.id, p.name
  order by p.name;
end;
$$;

revoke all on function public.create_plan(uuid, text, numeric, text, integer, integer) from public, anon;
revoke all on function public.set_plan_active(uuid, uuid, boolean) from public, anon;
revoke all on function public.import_ticket_stock(uuid, uuid, text[]) from public, anon;
revoke all on function public.ticket_stock_summary(uuid) from public, anon;
grant execute on function public.create_plan(uuid, text, numeric, text, integer, integer) to authenticated;
grant execute on function public.set_plan_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.import_ticket_stock(uuid, uuid, text[]) to authenticated;
grant execute on function public.ticket_stock_summary(uuid) to authenticated;
