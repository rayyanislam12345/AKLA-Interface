-- Widen who can edit a timeslip's details (date/hours/task/narrative) to
-- match who can already delete one: the author, or an admin/partner
-- correcting someone else's entry. author_id itself is never part of the
-- update payload the web app sends -- this policy doesn't need to defend
-- against that separately, since the same admin/partner roles already have
-- unrestricted delete on this table.
drop policy if exists "Authors can update their own timeslips" on public.matter_timeslips;

create policy "Authors and partners can update timeslips"
  on public.matter_timeslips for update
  using (
    author_id = auth.uid()
    or public.has_role(auth.uid(), 'admin')
    or public.has_role(auth.uid(), 'partner')
  )
  with check (
    author_id = auth.uid()
    or public.has_role(auth.uid(), 'admin')
    or public.has_role(auth.uid(), 'partner')
  );
