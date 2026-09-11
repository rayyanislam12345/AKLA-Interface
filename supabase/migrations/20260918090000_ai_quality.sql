-- Review history is pinned to an exact source version; failed runs are never clean runs.
create table public.ai_review_runs (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  status text not null default 'running' check (status in ('running','complete','failed')),
  passes jsonb not null default '{}'::jsonb,
  coverage jsonb not null default '{}'::jsonb,
  source_hash text,
  template_path text,
  error text,
  created_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.ai_review_runs enable row level security;
create policy "Firm members manage review runs" on public.ai_review_runs for all
using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
create index ai_review_runs_version_idx on public.ai_review_runs(document_version_id, created_at desc);
alter table public.redline_suggestions add column review_run_id uuid references public.ai_review_runs(id) on delete cascade;
create index redline_suggestions_run_idx on public.redline_suggestions(review_run_id);

create or replace function public.complete_ai_review(p_run_id uuid, p_suggestions jsonb, p_passes jsonb, p_coverage jsonb)
returns setof public.redline_suggestions
language plpgsql security invoker set search_path = public as $$
declare v_version uuid;
begin
  select document_version_id into v_version from ai_review_runs where id=p_run_id and status='running' for update;
  if v_version is null then raise exception 'Review run is unavailable or already completed'; end if;
  return query insert into redline_suggestions
    (document_version_id, review_run_id, clause_reference, original_text, suggested_text, rationale, review_type, status)
    select v_version, p_run_id, r->>'clause_reference', r->>'original_text', r->>'suggested_text', r->>'rationale', r->>'review_type', 'pending'
    from jsonb_array_elements(p_suggestions) r returning *;
  update ai_review_runs set status='complete', passes=p_passes, coverage=p_coverage where id=p_run_id;
end;
$$;
revoke all on function public.complete_ai_review(uuid,jsonb,jsonb,jsonb) from public;
grant execute on function public.complete_ai_review(uuid,jsonb,jsonb,jsonb) to authenticated;

-- Preserve the existing filtered vector-search settings and include linked amendments.
create or replace function public.match_documents(
  query_embedding vector,
  match_threshold double precision default 0.5,
  match_count integer default 5,
  filter_matter_id uuid default null::uuid,
  filter_document_type_id uuid default null::uuid,
  precedent_only boolean default false,
  statute_only boolean default false,
  filter_act_names text[] default null::text[]
)
returns table(
  id uuid,
  content text,
  metadata jsonb,
  matter_id uuid,
  document_type_id uuid,
  similarity double precision
)
language plpgsql
stable
set search_path to 'public', 'extensions'
as $function$
begin
  perform ('[1]'::vector <=> '[1]'::vector);
  perform set_config('hnsw.iterative_scan', 'strict_order', true);
  perform set_config('hnsw.ef_search', '100', true);

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
    and (not statute_only or documents.is_statute = true)
    and (filter_act_names is null or documents.metadata->>'act_name' = any(filter_act_names) or documents.metadata->>'amends_act' = any(filter_act_names))
    and (1 - (documents.embedding <=> query_embedding)) > match_threshold
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$function$;

create table public.ai_research_runs (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  question text not null,
  status text not null check (status in ('running','complete','partial','failed')),
  jurisdiction text,
  sources jsonb not null default '[]'::jsonb,
  unresolved jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.ai_research_runs enable row level security;
create policy "Firm members manage legal research" on public.ai_research_runs for all
using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
create index ai_research_runs_matter_idx on public.ai_research_runs(matter_id, created_at desc);
