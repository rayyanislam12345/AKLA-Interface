create table public.mandate_opportunities (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  source text not null,
  title text not null,
  department text,
  category text,
  notice_type text,
  publish_date date,
  close_date date,
  matched_keywords text[] not null default '{}',
  notice_url text,
  document_url text,
  extra_urls text[] not null default '{}',
  tender_ref text,
  storage_folder text,
  found_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);

create index mandate_opportunities_close_date_idx on public.mandate_opportunities(close_date);
create index mandate_opportunities_source_idx on public.mandate_opportunities(source);

alter table public.mandate_opportunities enable row level security;

create policy "Firm members can view mandate opportunities"
on public.mandate_opportunities for select
using (public.is_firm_member(auth.uid()));

-- Only the sync job (service role, bypasses RLS) writes here — no
-- authenticated-user write policy, this is a scraped feed, not editable data.

insert into storage.buckets (id, name, public)
values ('mandate-documents', 'mandate-documents', false)
on conflict (id) do nothing;

create policy "Firm members can read mandate documents bucket"
on storage.objects for select
using (bucket_id = 'mandate-documents' and public.is_firm_member(auth.uid()));
