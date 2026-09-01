-- Per-matter curated list of relevant statutes. The actual text still
-- lives in the shared documents table (is_statute=true) — this table only
-- records which Acts are relevant to which matter, so AI context for that
-- matter can be scoped to them instead of a whole-library search.
create table public.matter_relevant_laws (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  act_name text not null,
  status text not null default 'available' check (status in ('available', 'needs_upload')),
  source text not null check (source in ('manual_selected', 'manual_typed', 'auto_detected')),
  added_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (matter_id, act_name)
);

alter table public.matter_relevant_laws enable row level security;

create policy "Firm members can view matter relevant laws"
  on public.matter_relevant_laws for select
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can manage matter relevant laws"
  on public.matter_relevant_laws for all
  using (public.is_firm_member(auth.uid()))
  with check (public.is_firm_member(auth.uid()));

-- New bucket for the manual-upload fallback when a typed/detected Act can't
-- be found via scraping — statute PDFs have never touched Storage before
-- (the local scraper posts extracted text straight to ingest-documents).
insert into storage.buckets (id, name, public)
values ('law-library', 'law-library', false)
on conflict (id) do nothing;

create policy "Firm members can read law library bucket"
on storage.objects for select
using (bucket_id = 'law-library' and public.is_firm_member(auth.uid()));

create policy "Firm members can write law library bucket"
on storage.objects for insert
with check (bucket_id = 'law-library' and public.is_firm_member(auth.uid()));

create policy "Firm members can update law library bucket"
on storage.objects for update
using (bucket_id = 'law-library' and public.is_firm_member(auth.uid()));

create policy "Firm members can delete law library bucket"
on storage.objects for delete
using (bucket_id = 'law-library' and public.is_firm_member(auth.uid()));
