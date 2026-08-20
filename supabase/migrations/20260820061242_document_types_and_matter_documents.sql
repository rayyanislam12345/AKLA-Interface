-- The firm's contract taxonomy, admin-editable
create table public.document_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null,
  required_fields jsonb not null default '[]'::jsonb,
  typical_stage text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger update_document_types_updated_at
before update on public.document_types
for each row execute function public.update_updated_at_column();

insert into public.document_types (name, category) values
  ('Concession Agreement', 'Project & Concession'),
  ('Concession Direct Agreement', 'Project & Concession'),
  ('Site License Agreement', 'Project & Concession'),
  ('EPC Contract', 'Construction & Engineering'),
  ('Independent Engineer''s Agreement', 'Construction & Engineering'),
  ('Design Agreement', 'Construction & Engineering'),
  ('Common Terms Agreement (CTA)', 'Financing & Security'),
  ('Interfinance Agreement', 'Financing & Security'),
  ('Islamic Finance Agreement', 'Financing & Security'),
  ('Intercreditor Agreement', 'Financing & Security'),
  ('Escrow Agreement', 'Financing & Security'),
  ('Equity and Funding Utilization Agreement', 'Equity & Commercial'),
  ('Price Escalation Agreement', 'Equity & Commercial'),
  ('Independent Auditors'' Agreement', 'Assurance');

-- A document instance living on a matter
create type public.document_status as enum (
  'not_started', 'drafting', 'internal_review', 'with_counterparty', 'negotiation', 'finalized', 'executed'
);

create table public.matter_documents (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  document_type_id uuid references public.document_types(id),
  title text not null,
  status public.document_status not null default 'not_started',
  owner_id uuid references public.profiles(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger update_matter_documents_updated_at
before update on public.matter_documents
for each row execute function public.update_updated_at_column();

create index matter_documents_matter_id_idx on public.matter_documents(matter_id);

-- Version history per matter document
create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  matter_document_id uuid not null references public.matter_documents(id) on delete cascade,
  version_number int not null,
  storage_path text not null,
  is_ai_generated boolean not null default false,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (matter_document_id, version_number)
);

create index document_versions_matter_document_id_idx on public.document_versions(matter_document_id);

alter table public.document_types enable row level security;
alter table public.matter_documents enable row level security;
alter table public.document_versions enable row level security;

create policy "Firm members can view document types" on public.document_types for select using (public.is_firm_member(auth.uid()));
create policy "Admins manage document types" on public.document_types for all using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

create policy "Firm members can view matter documents" on public.matter_documents for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can manage matter documents" on public.matter_documents for all using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view document versions" on public.document_versions for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can create document versions" on public.document_versions for insert with check (public.is_firm_member(auth.uid()));
