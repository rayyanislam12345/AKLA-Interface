-- RAG store: doubles as matter context and firm-wide precedent library.
-- embedding dim is provisional (1536, matching OpenAI text-embedding-3-small,
-- the currently-proven pipeline) pending the final embeddings-provider decision.
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  matter_id uuid references public.matters(id) on delete cascade,
  document_type_id uuid references public.document_types(id),
  is_precedent boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger update_documents_updated_at
before update on public.documents
for each row execute function public.update_updated_at_column();

create index documents_embedding_idx on public.documents using hnsw (embedding vector_cosine_ops);
create index documents_matter_id_idx on public.documents(matter_id);
create index documents_document_type_id_idx on public.documents(document_type_id);

create or replace function public.match_documents(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 5,
  filter_matter_id uuid default null,
  filter_document_type_id uuid default null,
  precedent_only boolean default false
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  matter_id uuid,
  document_type_id uuid,
  similarity float
)
language plpgsql
stable
as $$
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    documents.matter_id,
    documents.document_type_id,
    1 - (documents.embedding <=> query_embedding) as similarity
  from public.documents
  where
    (filter_matter_id is null or documents.matter_id = filter_matter_id)
    and (filter_document_type_id is null or documents.document_type_id = filter_document_type_id)
    and (not precedent_only or documents.is_precedent = true)
    and (1 - (documents.embedding <=> query_embedding)) > match_threshold
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Structured AI review output on a document version
create type public.redline_status as enum ('pending', 'accepted', 'rejected');

create table public.redline_suggestions (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  clause_reference text,
  original_text text,
  suggested_text text,
  rationale text,
  status public.redline_status not null default 'pending',
  created_at timestamptz not null default now()
);

create index redline_suggestions_document_version_id_idx on public.redline_suggestions(document_version_id);

alter table public.documents enable row level security;
alter table public.redline_suggestions enable row level security;

create policy "Firm members can view documents" on public.documents for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can manage documents" on public.documents for all using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view redline suggestions" on public.redline_suggestions for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can manage redline suggestions" on public.redline_suggestions for all using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
