-- A sale can now come from a payment instead of a synchronized event, so these two
-- columns may be empty. The check keeps every sale traceable to one origin.
-- Kept apart from migration 007 because dropping NOT NULL is flagged as a destructive
-- statement by the Supabase tooling and needs an explicit confirmation.
alter table public.sales alter column source_event_id drop not null;
alter table public.sales alter column device_id drop not null;
alter table public.sales
  add constraint sales_origin_check check (source_event_id is not null or payment_id is not null);
