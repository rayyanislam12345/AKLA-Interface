-- Non-billable time is still work, and still belongs to a matter.
--
-- Fixing an internal precedent sheet, or matter administration, is time an
-- associate should be able to record and account for -- it just must not reach
-- an invoice. Uploading it and marking it here is better than the two
-- alternatives: leaving it uncaptured, or letting it silently inflate a bill.
--
-- Defaults true so every row already uploaded stays billable.
alter table public.matter_timeslips
  add column if not exists billable boolean not null default true;

create index if not exists matter_timeslips_billable_idx
  on public.matter_timeslips(matter_id, billable);
