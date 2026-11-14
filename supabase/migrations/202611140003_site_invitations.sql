-- Site invitations with role escalation controls and single-use acceptance.
create table if not exists public.site_invitations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','manager','seller','technician','viewer')),
  status text not null default 'pending'
    check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  constraint site_invitations_valid_expiry check (expires_at > created_at)
);

create unique index if not exists site_invitations_one_pending_email
  on public.site_invitations(site_id, lower(email))
  where status = 'pending';

create index if not exists site_invitations_site_created_idx
  on public.site_invitations(site_id, created_at desc);

alter table public.site_invitations enable row level security;

create policy "site admins can read invitations"
on public.site_invitations for select
to authenticated
using (
  exists (
    select 1 from public.site_memberships m
    where m.site_id = site_invitations.site_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role in ('owner','admin')
  )
);

revoke insert, update, delete on public.site_invitations from anon, authenticated;

create or replace function public.create_site_invitation(
  p_site_id uuid,
  p_email text,
  p_role text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_email text := lower(trim(coalesce(p_email, '')));
  v_actor_role text;
  v_invitation_id uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if v_email = '' or length(v_email) > 254
     or v_email !~* '^[A-Z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'Invalid email address' using errcode = '22023';
  end if;

  if p_role not in ('admin','manager','seller','technician','viewer') then
    raise exception 'Invalid invitation role' using errcode = '22023';
  end if;

  select m.role into v_actor_role
  from public.site_memberships m
  where m.site_id = p_site_id
    and m.user_id = v_actor
    and m.status = 'active';

  if v_actor_role is null then
    raise exception 'Site membership required' using errcode = '42501';
  end if;
  if v_actor_role not in ('owner','admin') then
    raise exception 'Insufficient role to invite members' using errcode = '42501';
  end if;
  if v_actor_role = 'admin' and p_role = 'admin' then
    raise exception 'Only the owner can invite an administrator' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.site_memberships m
    join auth.users u on u.id = m.user_id
    where m.site_id = p_site_id and m.status = 'active'
      and lower(u.email) = v_email
  ) then
    raise exception 'This user is already an active member' using errcode = '23505';
  end if;

  update public.site_invitations
  set status = 'expired'
  where site_id = p_site_id and lower(email) = v_email
    and status = 'pending' and expires_at <= now();

  insert into public.site_invitations(site_id, email, role, invited_by)
  values (p_site_id, v_email, p_role, v_actor)
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$$;

create or replace function public.accept_site_invitation(p_invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  v_invitation public.site_invitations%rowtype;
begin
  if v_user_id is null or v_email = '' then
    raise exception 'Authenticated email required' using errcode = '28000';
  end if;

  select * into v_invitation
  from public.site_invitations
  where id = p_invitation_id
  for update;

  if not found then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  if v_invitation.status <> 'pending' then
    raise exception 'Invitation is no longer pending' using errcode = '22023';
  end if;
  if v_invitation.expires_at <= now() then
    update public.site_invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'Invitation has expired' using errcode = '22023';
  end if;
  if v_invitation.email <> v_email then
    raise exception 'Invitation email does not match authenticated account' using errcode = '42501';
  end if;

  insert into public.site_memberships(site_id, user_id, role, status)
  values (v_invitation.site_id, v_user_id, v_invitation.role, 'active');

  update public.site_invitations
  set status = 'accepted', accepted_at = now()
  where id = p_invitation_id;

  return v_invitation.site_id;
end;
$$;

revoke all on function public.create_site_invitation(uuid, text, text) from public;
revoke all on function public.create_site_invitation(uuid, text, text) from anon;
grant execute on function public.create_site_invitation(uuid, text, text) to authenticated;

revoke all on function public.accept_site_invitation(uuid) from public;
revoke all on function public.accept_site_invitation(uuid) from anon;
grant execute on function public.accept_site_invitation(uuid) to authenticated;
