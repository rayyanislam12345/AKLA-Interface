-- Screen captures travel with the activity they belong to, so a supervisor
-- drafting someone's timesheet sees what that person's own machine would have
-- shown the model: which document, who was on the call.
--
-- Each machine writes only into a folder named for its own user; that person
-- and supervisors can read it; the machine and supervisors can delete. The
-- machine prunes its uploads on the same schedule it prunes its disk, so the
-- bucket holds about a week per person. Nothing the privacy blocklist would
-- redact is ever captured in the first place, so nothing of the kind is here.
insert into storage.buckets (id, name, public)
values ('timekeeper-captures', 'timekeeper-captures', false)
on conflict (id) do nothing;

drop policy if exists "Machines upload their own captures" on storage.objects;
create policy "Machines upload their own captures"
on storage.objects for insert
with check (
  bucket_id = 'timekeeper-captures'
  and public.is_firm_member(auth.uid())
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Machines replace their own captures" on storage.objects;
create policy "Machines replace their own captures"
on storage.objects for update
using (
  bucket_id = 'timekeeper-captures'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Captures are seen by their owner and supervisors" on storage.objects;
create policy "Captures are seen by their owner and supervisors"
on storage.objects for select
using (
  bucket_id = 'timekeeper-captures'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_supervisor(auth.uid())
  )
);

drop policy if exists "Captures are removed by their owner and supervisors" on storage.objects;
create policy "Captures are removed by their owner and supervisors"
on storage.objects for delete
using (
  bucket_id = 'timekeeper-captures'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_supervisor(auth.uid())
  )
);

-- The activity row names the captures taken during it, as object paths in
-- the bucket, so the reader never has to list the bucket to find them.
alter table public.timekeeper_activity
  add column if not exists captures jsonb not null default '[]'::jsonb;
