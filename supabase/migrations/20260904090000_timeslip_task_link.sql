-- Time is billed against a task, not just a matter: researching a standard and
-- drafting the motion it supports are separate lines on a timesheet. The hub
-- already tracks tasks per matter, so a timeslip points at one rather than
-- inventing a parallel notion of "task".
--
-- Nullable: work legitimately happens outside any assigned task, and refusing
-- to record it would lose billable time.
alter table public.matter_timeslips
  add column if not exists hub_task_id uuid
    references public.matter_tasks(id) on delete set null;

create index if not exists matter_timeslips_task_idx
  on public.matter_timeslips(hub_task_id);
