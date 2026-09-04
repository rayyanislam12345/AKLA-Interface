-- A running picture of what each lawyer is working on, refreshed by the
-- Timekeeper desktop app every few minutes.
--
-- One row per person per day, upserted -- this is a current state, not a log,
-- and keeping it that way bounds both the table and what can be inferred from
-- it. It carries totals and the matter in hand; never window titles, document
-- names or screenshots, which stay on the associate's machine.
create table if not exists public.live_activity (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  day             date not null,
  as_of           timestamptz not null default now(),
  tracked_seconds integer not null default 0,
  billable_hours  numeric(6,2) not null default 0,
  other_hours     numeric(6,2) not null default 0,
  state           text not null default 'working'
                  check (state in ('working', 'away', 'idle', 'paused')),
  current_matter  text,
  current_task    text,
  by_matter       jsonb not null default '[]'::jsonb,
  primary key (user_id, day)
);

create index if not exists live_activity_day_idx on public.live_activity(day desc, as_of desc);

alter table public.live_activity enable row level security;

-- Everyone writes only their own row. Nobody can post activity as someone else.
drop policy if exists "Write only your own activity" on public.live_activity;
create policy "Write only your own activity"
  on public.live_activity for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_firm_member(auth.uid()));

-- Reading the firm's activity is a supervisory act, so it is limited to those
-- who supervise. An associate can still read their own row, which matters:
-- nothing should be collected about someone that they cannot themselves see.
drop policy if exists "Supervisors see the firm, everyone sees themselves" on public.live_activity;
create policy "Supervisors see the firm, everyone sees themselves"
  on public.live_activity for select
  using (
    user_id = auth.uid()
    or public.has_role(auth.uid(), 'admin')
    or public.has_role(auth.uid(), 'partner')
    or public.has_role(auth.uid(), 'senior_counsel')
  );
