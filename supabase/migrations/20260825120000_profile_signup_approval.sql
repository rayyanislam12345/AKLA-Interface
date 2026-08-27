-- Self-service signup with manual admin approval. New accounts start
-- 'pending' and are invisible to the rest of the firm until an admin
-- approves them — see TeamPage's "Pending Approvals" section.
create type public.profile_status as enum ('pending', 'approved', 'rejected');

alter table public.profiles
  add column status public.profile_status not null default 'pending';

-- Grandfather every existing account so this migration doesn't lock out
-- anyone already using the app — only new self-signups start pending.
update public.profiles set status = 'approved';

-- is_firm_member() is the chokepoint nearly every other RLS policy in the
-- app already reads through (matters, clients, documents, etc.), so gating
-- it on approval status is enough to lock a pending signup out of firm data
-- without touching every table's policies individually.
create or replace function public.is_firm_member(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = _user_id and status = 'approved'
  )
$$;

-- A pending/rejected user still needs to read their own row (so the app can
-- show them an "awaiting approval" screen) even though is_firm_member now
-- excludes them from the existing firm-wide "view all profiles" policy.
create policy "Users can view their own profile"
on public.profiles for select
using (auth.uid() = id);

-- Admins need to see pending/rejected rows to act on them — the firm-wide
-- view policy alone won't surface those once is_firm_member excludes them.
create policy "Admins can view all profiles"
on public.profiles for select
using (public.has_role(auth.uid(), 'admin'));

-- Admins approve/reject by updating another user's row directly.
create policy "Admins can update any profile"
on public.profiles for update
using (public.has_role(auth.uid(), 'admin'));

-- Structural guard, not just a UI omission: nobody can self-approve by
-- calling the REST API directly. Only an admin's own write can move status
-- — same pattern as protect_whatsapp_matter_link() for whatsapp_matters.matter_id.
create or replace function public.protect_profile_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_role(auth.uid(), 'admin') then
    new.status := old.status;
  end if;
  return new;
end;
$$;

create trigger protect_profile_status_trigger
before update on public.profiles
for each row execute function public.protect_profile_status();
