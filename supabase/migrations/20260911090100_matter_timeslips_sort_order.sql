-- Lets a lawyer manually drag-reorder their Today's Timesheet rows instead
-- of them re-sorting on every save. Null sort_order (existing rows) falls
-- back to upload order in the frontend query.

alter table public.matter_timeslips
  add column if not exists sort_order integer;

create index if not exists matter_timeslips_sort_idx
  on public.matter_timeslips(author_id, work_date, sort_order);
