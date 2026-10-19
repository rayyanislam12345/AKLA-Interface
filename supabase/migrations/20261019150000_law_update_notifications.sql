-- Law monitor, phase 3: tell people.
--
-- Until now a legal development reached an associate only if they happened
-- to look at the homepage card or open a matter whose Relevant Laws card
-- had turned amber. These tables let the morning run tell each person
-- directly: in the Hub (a bell in the header) and, once a mail key is
-- configured on the VM, by one email per morning.
--
-- Who is told what:
--   * the team of every matter that depends on an affected Act — lead
--     partner, creator, task assignees, anyone who has recorded time on it —
--     for verified amendments, re-issues and new Acts touching that Act;
--   * everyone approved, for bills, drafts, new Acts and amendments to any
--     library Act (switchable per person);
--   * nobody, for press reports or amendments the library copy already
--     includes.

create table public.law_update_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  law_update_id uuid not null references public.law_updates(id) on delete cascade,
  -- Set when the person is told because of a specific matter; null for a
  -- firm-wide notification.
  matter_id uuid references public.matters(id) on delete cascade,
  reason text not null check (reason in ('matter', 'firm')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  emailed_at timestamptz
);

-- One row per person per update per matter (null matter counts as one).
create unique index law_update_notifications_unique_idx
  on public.law_update_notifications(user_id, law_update_id, coalesce(matter_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index law_update_notifications_user_idx
  on public.law_update_notifications(user_id, read_at, created_at desc);
create index law_update_notifications_email_idx
  on public.law_update_notifications(emailed_at, created_at) where emailed_at is null;

alter table public.law_update_notifications enable row level security;

create policy "People see their own law notifications"
  on public.law_update_notifications for select
  using (auth.uid() = user_id);

create policy "People mark their own law notifications read"
  on public.law_update_notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Writes come from the monitor with the service role, which bypasses RLS.

create table public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Bills, drafts, new Acts and amendments to library Acts, firm-wide.
  firm_wide_law_updates boolean not null default true,
  -- One email per morning with whatever is new for this person.
  email_law_updates boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

create policy "People see their own notification preferences"
  on public.notification_preferences for select
  using (auth.uid() = user_id);

create policy "People set their own notification preferences"
  on public.notification_preferences for insert
  with check (auth.uid() = user_id);

create policy "People change their own notification preferences"
  on public.notification_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- The people who work on a matter, as the Hub can tell: the lead partner,
-- whoever opened it, anyone assigned a task on it, and anyone who has
-- recorded time on it. There is no separate membership table, and this is
-- what "works on" means in practice.
create or replace function public.matter_team(p_matter_id uuid)
returns table(user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct u.user_id
  from (
    select lead_partner_id as user_id from public.matters where id = p_matter_id
    union all
    select created_by from public.matters where id = p_matter_id
    union all
    select assignee_id from public.matter_tasks where matter_id = p_matter_id
    union all
    select author_id from public.matter_timeslips where matter_id = p_matter_id
  ) u
  join public.profiles p on p.id = u.user_id and p.status = 'approved'
  where u.user_id is not null;
$$;

revoke execute on function public.matter_team(uuid) from public, anon;
grant execute on function public.matter_team(uuid) to authenticated, service_role;

-- The matters that depend on an Act, with their teams, in one call for the
-- monitor.
create or replace function public.law_update_recipients(p_act_name text)
returns table(matter_id uuid, matter_name text, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.name, t.user_id
  from public.matter_relevant_laws rl
  join public.matters m on m.id = rl.matter_id
  cross join lateral public.matter_team(m.id) t
  where rl.act_name = p_act_name
    and rl.status = 'available'
    -- The app reads any spelling of "closed" as closed (useMatters.ts).
    and lower(regexp_replace(coalesce(m.status, ''), '[\s_-]+', '', 'g')) <> 'closed';
$$;

revoke execute on function public.law_update_recipients(text) from public, anon;
grant execute on function public.law_update_recipients(text) to service_role;

-- Unread count for the bell, cheap enough to poll.
create or replace function public.unread_law_notification_count()
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::integer from public.law_update_notifications
  where user_id = auth.uid() and read_at is null;
$$;

grant execute on function public.unread_law_notification_count() to authenticated;

alter table public.law_monitor_runs add column if not exists notified integer not null default 0;
alter table public.law_monitor_runs add column if not exists emailed integer not null default 0;
