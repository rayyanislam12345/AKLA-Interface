-- Billable time uploaded from Timekeeper, the associates' desktop capture app.
--
-- Only entries the associate has reviewed and approved are ever uploaded, so a
-- row here is a deliberate assertion about billable time, not raw capture.
-- Visibility is firm-wide, matching the access model everywhere else in the
-- hub; authorship is not -- an associate may only write their own time.
create table public.matter_timeslips (
  id          uuid primary key default gen_random_uuid(),
  matter_id   uuid not null references public.matters(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  work_date   date not null,
  hours       numeric(5,2) not null check (hours > 0),
  task_code   text,
  narrative   text not null,
  source      text not null default 'timekeeper',
  -- The slip's id in the author's local Timekeeper database. Re-uploading a
  -- day the associate has corrected updates the existing rows instead of
  -- appending a second copy of the same work.
  external_id text,
  uploaded_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (author_id, external_id)
);

create index matter_timeslips_matter_date_idx
  on public.matter_timeslips(matter_id, work_date desc);
create index matter_timeslips_author_idx on public.matter_timeslips(author_id);

create trigger update_matter_timeslips_updated_at
before update on public.matter_timeslips
for each row execute function public.update_updated_at_column();

alter table public.matter_timeslips enable row level security;

create policy "Firm members can view all timeslips"
  on public.matter_timeslips for select
  using (public.is_firm_member(auth.uid()));

-- Write access is deliberately narrower than read access: time entries are
-- attributable to a person, and nobody should be able to bill under another
-- lawyer's name.
create policy "Authors can insert their own timeslips"
  on public.matter_timeslips for insert
  with check (public.is_firm_member(auth.uid()) and author_id = auth.uid());

create policy "Authors can update their own timeslips"
  on public.matter_timeslips for update
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy "Authors and partners can delete timeslips"
  on public.matter_timeslips for delete
  using (
    author_id = auth.uid()
    or public.has_role(auth.uid(), 'admin')
    or public.has_role(auth.uid(), 'partner')
  );
