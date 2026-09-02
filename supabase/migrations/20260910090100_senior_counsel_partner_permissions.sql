-- Every RLS policy that grants Partner an extra permission gets the same
-- grant for Senior Counsel, kept in lockstep — a new enum value alone
-- confers no access.
drop policy if exists "Partners and admins can delete clients" on public.clients;
create policy "Partners and admins can delete clients"
on public.clients for delete
using (
  has_role(auth.uid(), 'admin'::app_role)
  or has_role(auth.uid(), 'partner'::app_role)
  or has_role(auth.uid(), 'senior_counsel'::app_role)
);

drop policy if exists "Authors and partners can delete timeslips" on public.matter_timeslips;
create policy "Authors and partners can delete timeslips"
on public.matter_timeslips for delete
using (
  author_id = auth.uid()
  or has_role(auth.uid(), 'admin'::app_role)
  or has_role(auth.uid(), 'partner'::app_role)
  or has_role(auth.uid(), 'senior_counsel'::app_role)
);

drop policy if exists "Authors and partners can update timeslips" on public.matter_timeslips;
create policy "Authors and partners can update timeslips"
on public.matter_timeslips for update
using (
  author_id = auth.uid()
  or has_role(auth.uid(), 'admin'::app_role)
  or has_role(auth.uid(), 'partner'::app_role)
  or has_role(auth.uid(), 'senior_counsel'::app_role)
)
with check (
  author_id = auth.uid()
  or has_role(auth.uid(), 'admin'::app_role)
  or has_role(auth.uid(), 'partner'::app_role)
  or has_role(auth.uid(), 'senior_counsel'::app_role)
);

drop policy if exists "Partners and admins can delete matters" on public.matters;
create policy "Partners and admins can delete matters"
on public.matters for delete
using (
  has_role(auth.uid(), 'admin'::app_role)
  or has_role(auth.uid(), 'partner'::app_role)
  or has_role(auth.uid(), 'senior_counsel'::app_role)
);
