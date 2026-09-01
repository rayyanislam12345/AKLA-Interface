-- One canonical "standard version" per document type, curated by associates
-- (any firm member, not admin-gated) as the primary structural/formatting
-- jump-off point for "Draft with AI", supplementing the existing
-- recency-based precedent excerpts rather than replacing them.
create table public.document_type_templates (
  id uuid primary key default gen_random_uuid(),
  document_type_id uuid not null references public.document_types(id) on delete cascade,
  content_html text not null,
  seeded_from_storage_path text,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_type_id)
);

alter table public.document_type_templates enable row level security;

create policy "Firm members can view document type templates"
  on public.document_type_templates for select
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can manage document type templates"
  on public.document_type_templates for all
  using (public.is_firm_member(auth.uid()))
  with check (public.is_firm_member(auth.uid()));

-- A curated per-matter memory, editable directly and refreshable from a
-- summary of that matter's own past AI interview transcripts, so facts
-- established in one drafting session carry forward into the next one on
-- the same matter.
create table public.matter_context (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  content text not null default '',
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (matter_id)
);

alter table public.matter_context enable row level security;

create policy "Firm members can view matter context"
  on public.matter_context for select
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can manage matter context"
  on public.matter_context for all
  using (public.is_firm_member(auth.uid()))
  with check (public.is_firm_member(auth.uid()));
