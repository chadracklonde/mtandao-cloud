-- LOT 4: sales reports and reconciliation of sales, cash entries, tickets and sync health.
-- Both functions are read-only and restricted to owner, admin, manager and viewer.

create or replace function private.report_period(p_from timestamptz, p_to timestamptz)
returns timestamptz[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_to timestamptz := coalesce(p_to, now());
  v_from timestamptz := coalesce(p_from, v_to - interval '30 days');
begin
  if v_from >= v_to then
    raise exception 'from must be before to' using errcode = '22023';
  end if;
  if v_to - v_from > interval '366 days' then
    raise exception 'period must not exceed 366 days' using errcode = '22023';
  end if;
  return array[v_from, v_to];
end;
$$;

create or replace function public.sales_report(
  p_site_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_group text default 'day'
)
returns table(
  period date,
  currency text,
  sales_count bigint,
  total_amount numeric,
  cash_amount numeric,
  mobile_money_amount numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_range timestamptz[];
  v_tz text;
begin
  if auth.uid() is null
     or not private.has_site_role(p_site_id, array['owner', 'admin', 'manager', 'viewer']) then
    raise exception 'Insufficient permission to read reports' using errcode = '42501';
  end if;
  if p_group is null or p_group not in ('day', 'month') then
    raise exception 'group must be day or month' using errcode = '22023';
  end if;
  v_range := private.report_period(p_from, p_to);

  select s.timezone into v_tz from public.sites s where s.id = p_site_id;

  return query
  select (date_trunc(p_group, sa.sold_at at time zone v_tz))::date as period,
         sa.currency::text,
         count(*),
         sum(sa.amount),
         coalesce(sum(sa.amount) filter (where sa.payment_method = 'cash'), 0),
         coalesce(sum(sa.amount) filter (where sa.payment_method = 'mobile_money'), 0)
  from public.sales sa
  where sa.site_id = p_site_id
    and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]
  group by 1, 2
  order by 1 desc, 2;
end;
$$;

create or replace function public.reconciliation_report(
  p_site_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table(kind text, reference_id uuid, occurred_at timestamptz, details jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_range timestamptz[];
begin
  if auth.uid() is null
     or not private.has_site_role(p_site_id, array['owner', 'admin', 'manager', 'viewer']) then
    raise exception 'Insufficient permission to read reports' using errcode = '42501';
  end if;
  v_range := private.report_period(p_from, p_to);

  return query
  select * from (
    -- Cash sale without a cash entry.
    select 'cash_entry_missing'::text, sa.id, sa.sold_at,
           jsonb_build_object('amount', sa.amount, 'currency', sa.currency)
    from public.sales sa
    where sa.site_id = p_site_id and sa.payment_method = 'cash'
      and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]
      and not exists (select 1 from public.cash_entries c where c.site_id = sa.site_id and c.sale_id = sa.id)

    union all
    -- Cash entry whose amount or currency differs from its sale.
    select 'cash_entry_mismatch', sa.id, sa.sold_at,
           jsonb_build_object('sale_amount', sa.amount, 'sale_currency', sa.currency,
                              'cash_amount', c.amount, 'cash_currency', c.currency)
    from public.sales sa
    join public.cash_entries c on c.site_id = sa.site_id and c.sale_id = sa.id
    where sa.site_id = p_site_id
      and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]
      and (c.amount <> sa.amount or c.currency <> sa.currency)

    union all
    -- Cash entry for a sale that was not paid in cash.
    select 'cash_entry_unexpected', sa.id, sa.sold_at,
           jsonb_build_object('payment_method', sa.payment_method, 'cash_amount', c.amount)
    from public.sales sa
    join public.cash_entries c on c.site_id = sa.site_id and c.sale_id = sa.id
    where sa.site_id = p_site_id and sa.payment_method <> 'cash'
      and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]

    union all
    -- Sale announcing a ticket code with no ticket, or a different one.
    select 'ticket_missing', sa.id, sa.sold_at,
           jsonb_build_object('ticket_code', sa.ticket_code)
    from public.sales sa
    where sa.site_id = p_site_id and sa.ticket_code is not null
      and sa.sold_at >= v_range[1] and sa.sold_at < v_range[2]
      and not exists (select 1 from public.tickets t where t.site_id = sa.site_id
                      and t.sale_id = sa.id and t.code = sa.ticket_code)

    union all
    -- Synchronization conflicts awaiting a decision.
    select 'sync_conflict_open', sc.event_id, sc.created_at,
           jsonb_build_object('conflict_type', sc.conflict_type, 'conflict_id', sc.id)
    from public.sync_conflicts sc
    where sc.site_id = p_site_id and sc.resolved_at is null
      and sc.created_at >= v_range[1] and sc.created_at < v_range[2]

    union all
    -- Events the server could not apply.
    select 'sync_event_rejected', se.id, se.received_at,
           jsonb_build_object('event_type', se.event_type, 'error', se.process_error)
    from public.sync_events se
    where se.site_id = p_site_id and se.status = 'rejected'
      and se.received_at >= v_range[1] and se.received_at < v_range[2]

    union all
    -- Events stuck in the inbox.
    select 'sync_event_stuck', se.id, se.received_at,
           jsonb_build_object('event_type', se.event_type)
    from public.sync_events se
    where se.site_id = p_site_id and se.status = 'pending'
      and se.received_at < now() - interval '10 minutes'
      and se.received_at >= v_range[1] and se.received_at < v_range[2]
  ) r(kind, reference_id, occurred_at, details)
  order by r.occurred_at desc, r.kind
  limit 500;
end;
$$;

revoke all on function private.report_period(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.sales_report(uuid, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.reconciliation_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_report(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.reconciliation_report(uuid, timestamptz, timestamptz) to authenticated;
