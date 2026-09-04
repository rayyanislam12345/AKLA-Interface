-- Diagnostic bundles uploaded from the Timekeeper desktop app when something
-- goes wrong, so support does not depend on an associate describing an error
-- from memory.
--
-- Each associate writes only into a folder named for their own user id, and
-- only admins can read any of it. A bundle is logs and counts -- never window
-- titles, narratives, or the capture database, all of which carry privileged
-- client information.
insert into storage.buckets (id, name, public)
values ('diagnostics', 'diagnostics', false)
on conflict (id) do nothing;

drop policy if exists "Associates upload their own diagnostics" on storage.objects;
create policy "Associates upload their own diagnostics"
on storage.objects for insert
with check (
  bucket_id = 'diagnostics'
  and public.is_firm_member(auth.uid())
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Associates see their own diagnostics" on storage.objects;
create policy "Associates see their own diagnostics"
on storage.objects for select
using (
  bucket_id = 'diagnostics'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.has_role(auth.uid(), 'admin')
  )
);

drop policy if exists "Admins manage diagnostics" on storage.objects;
create policy "Admins manage diagnostics"
on storage.objects for delete
using (bucket_id = 'diagnostics' and public.has_role(auth.uid(), 'admin'));
