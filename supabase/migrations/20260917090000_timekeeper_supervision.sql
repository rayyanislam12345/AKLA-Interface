-- Supervised timekeeping: an admin plans each lawyer's day, watches it, retags
-- it, and drafts and files their timesheet -- from any machine, including a
-- Mac that runs no capture of its own.
--
-- Three tables carry that, all keyed by the lawyer whose day it is:
--
--   timekeeper_plans     what each person is to work on today (written by a
--                        supervisor, read by that person's Timekeeper, which
--                        declares it in place of the morning prompt)
--   timekeeper_activity  the person's day as their machine resolved it: each
--                        stretch of activity with the matter and task it was
--                        attributed to (written by that machine, read back
--                        by supervisors)
--   timekeeper_tags      a supervisor's correction to that attribution, by
--                        window title or by one block of time away; the
--                        person's machine applies it and learns from it
--
-- Supervisor here means the same three roles that may already read the firm's
-- live activity board: admin, partner and senior counsel.

create or replace function public.is_supervisor(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_role(_user_id, 'admin')
      or public.has_role(_user_id, 'partner')
      or public.has_role(_user_id, 'senior_counsel')
$$;

-- ----------------------------------------------------------------- plans --

create table if not exists public.timekeeper_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  day         date not null,
  matter_id   uuid not null references public.matters(id) on delete cascade,
  task_id     uuid references public.matter_tasks(id) on delete cascade,
  -- Words that identify the task on screen, from the agenda it came from.
  -- The person's machine learns them, as it would had they imported it.
  keywords    jsonb not null default '[]'::jsonb,
  assigned_by uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One line per person, day and task; a bare matter counts as its own line.
create unique index if not exists timekeeper_plans_line_idx
  on public.timekeeper_plans(user_id, day, matter_id,
                             coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists timekeeper_plans_user_day_idx
  on public.timekeeper_plans(user_id, day desc);

create trigger update_timekeeper_plans_updated_at
before update on public.timekeeper_plans
for each row execute function public.update_updated_at_column();

alter table public.timekeeper_plans enable row level security;

drop policy if exists "Everyone reads their own plan, supervisors read all" on public.timekeeper_plans;
create policy "Everyone reads their own plan, supervisors read all"
  on public.timekeeper_plans for select
  using (user_id = auth.uid() or public.is_supervisor(auth.uid()));

drop policy if exists "Supervisors write plans" on public.timekeeper_plans;
create policy "Supervisors write plans"
  on public.timekeeper_plans for all
  using (public.is_supervisor(auth.uid()))
  with check (public.is_supervisor(auth.uid()));

-- -------------------------------------------------------------- activity --

create table if not exists public.timekeeper_activity (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  day         date not null,
  segment_id  integer not null,          -- the row's id on the person's machine
  started_at  double precision not null, -- epoch seconds, as captured
  ended_at    double precision not null,
  kind        text not null check (kind in ('active', 'passive', 'idle', 'locked', 'away')),
  app         text,
  title       text,                      -- null when the machine redacted it
  matter_id   uuid references public.matters(id) on delete set null,
  task_id     uuid references public.matter_tasks(id) on delete set null,
  matter_name text,                      -- a standing bucket has no hub matter
  task_title  text,
  billable    boolean not null default true,
  is_work     boolean not null default true,
  confirmed   boolean not null default false,   -- the person (or a supervisor) said so
  updated_at  timestamptz not null default now(),
  primary key (user_id, day, segment_id)
);

create index if not exists timekeeper_activity_user_day_idx
  on public.timekeeper_activity(user_id, day desc, started_at);

alter table public.timekeeper_activity enable row level security;

-- Each machine writes only the row of the person signed into it.
drop policy if exists "Write only your own activity" on public.timekeeper_activity;
create policy "Write only your own activity"
  on public.timekeeper_activity for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_firm_member(auth.uid()));

drop policy if exists "Supervisors see the firm, everyone sees themselves" on public.timekeeper_activity;
create policy "Supervisors see the firm, everyone sees themselves"
  on public.timekeeper_activity for select
  using (user_id = auth.uid() or public.is_supervisor(auth.uid()));

-- ------------------------------------------------------------------ tags --

create table if not exists public.timekeeper_tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  -- Exactly one of these identifies what is being tagged: a window title,
  -- which tags every visit to that window on every day, or one block of
  -- time away from the keyboard, which tags that block alone.
  title       text,
  day         date,
  segment_id  integer,
  -- The title, or "<day>#<segment_id>": one plain column to upsert on, so a
  -- retag replaces the earlier answer. Set by the client; checked here.
  key         text not null,
  matter_id   uuid references public.matters(id) on delete set null,
  task_id     uuid references public.matter_tasks(id) on delete set null,
  is_work     boolean not null default true,
  tagged_by   uuid references public.profiles(id),
  applied_at  timestamptz,               -- set by the person's machine once learned
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, key),
  check ((title is not null and segment_id is null and key = title)
      or (title is null and segment_id is not null and day is not null
          and key = day::text || '#' || segment_id::text))
);

create index if not exists timekeeper_tags_user_updated_idx
  on public.timekeeper_tags(user_id, updated_at desc);

create trigger update_timekeeper_tags_updated_at
before update on public.timekeeper_tags
for each row execute function public.update_updated_at_column();

alter table public.timekeeper_tags enable row level security;

drop policy if exists "Everyone reads their own tags, supervisors read all" on public.timekeeper_tags;
create policy "Everyone reads their own tags, supervisors read all"
  on public.timekeeper_tags for select
  using (user_id = auth.uid() or public.is_supervisor(auth.uid()));

drop policy if exists "Supervisors write tags" on public.timekeeper_tags;
create policy "Supervisors write tags"
  on public.timekeeper_tags for all
  using (public.is_supervisor(auth.uid()))
  with check (public.is_supervisor(auth.uid()));

-- The person's machine records that it has learned a tag. It may touch that
-- one column on its own rows and nothing else.
drop policy if exists "Machines acknowledge their own tags" on public.timekeeper_tags;
create policy "Machines acknowledge their own tags"
  on public.timekeeper_tags for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ------------------------------------------------------------- timeslips --

-- A supervisor who drafts a lawyer's timesheet files it under that lawyer's
-- name: the time is theirs, whoever pressed the button. This is the one
-- place someone may write a row with another person's author_id, and it is
-- limited to the roles that may already edit and delete anyone's entries.
drop policy if exists "Supervisors can record time for others" on public.matter_timeslips;
create policy "Supervisors can record time for others"
  on public.matter_timeslips for insert
  with check (public.is_supervisor(auth.uid()));

drop policy if exists "Supervisors can update anyone's timeslips" on public.matter_timeslips;
create policy "Supervisors can update anyone's timeslips"
  on public.matter_timeslips for update
  using (public.is_supervisor(auth.uid()))
  with check (public.is_supervisor(auth.uid()));
