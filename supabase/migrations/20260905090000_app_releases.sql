-- Releases of the Timekeeper desktop app, so associates are updated without
-- anyone reinstalling by hand.
--
-- SECURITY: a row here causes every associate's machine to download and run an
-- installer. Write access is therefore admin-only, and the sha256 recorded
-- here -- not one served alongside the download -- is what the client checks
-- the file against. Anyone who can write this table has code execution across
-- the firm, so this policy is the whole trust boundary.
create table public.app_releases (
  id           uuid primary key default gen_random_uuid(),
  version      text not null unique,
  notes        text,
  storage_path text not null,
  sha256       text not null check (char_length(sha256) = 64),
  mandatory    boolean not null default false,
  published_at timestamptz not null default now(),
  created_by   uuid references auth.users(id)
);

create index app_releases_published_idx on public.app_releases(published_at desc);

alter table public.app_releases enable row level security;

create policy "Firm members can see releases"
  on public.app_releases for select
  using (public.is_firm_member(auth.uid()));

create policy "Admins publish releases"
  on public.app_releases for all
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

insert into storage.buckets (id, name, public)
values ('app-releases', 'app-releases', false)
on conflict (id) do nothing;

create policy "Firm members can download releases"
on storage.objects for select
using (bucket_id = 'app-releases' and public.is_firm_member(auth.uid()));

create policy "Admins can upload releases"
on storage.objects for insert
with check (bucket_id = 'app-releases' and public.has_role(auth.uid(), 'admin'));

create policy "Admins can replace releases"
on storage.objects for update
using (bucket_id = 'app-releases' and public.has_role(auth.uid(), 'admin'));

create policy "Admins can delete releases"
on storage.objects for delete
using (bucket_id = 'app-releases' and public.has_role(auth.uid(), 'admin'));
