-- Filtered vector search was silently returning nothing.
--
-- documents_embedding_idx is an HNSW index, and HNSW applies the WHERE
-- clause AFTER the index has already picked its ~ef_search nearest
-- candidates. Ask a question whose nearest neighbours are all precedent
-- chunks and add `statute_only`, and every candidate is filtered away —
-- the query returns zero rows even with the similarity threshold set to
-- -1, because there was never a statute among the candidates to begin
-- with. Confirmed against the live corpus (4,507 chunks: 2,185 statute,
-- 2,320 precedent): "Stamp Act 1899 instruments chargeable with duty"
-- returned 3 statutes, while "is a concession agreement exempt from stamp
-- duty" returned none, same filter, same threshold.
--
-- That silently cost the law library its place in drafting and review
-- grounding (_shared/retrieval.ts) and in matter Q&A, and would equally
-- affect any matter-scoped or document-type-scoped search whose subject
-- is a small slice of the corpus.
--
-- pgvector 0.8's iterative index scan is the fix: keep pulling batches
-- from the index until enough rows survive the filter (bounded by
-- hnsw.max_scan_tuples, default 20,000 — comfortably more than this
-- corpus). strict_order keeps results in exact distance order, which the
-- callers rely on for their "top match" ordering and reported similarity.
--
-- The settings are applied with set_config(..., is_local => true) in the
-- body rather than as function-level SET clauses: pgvector registers its
-- GUCs only once its module is loaded into the backend, so a definition-
-- time `set hnsw.iterative_scan` is rejected ("permission denied to set
-- parameter") on a connection that hasn't touched a vector yet. The dummy
-- distance below forces that load first. is_local scopes both settings to
-- the calling transaction, which for PostgREST is the single request.
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
    and (filter_act_names is null or documents.metadata->>'act_name' = any(filter_act_names))
    and (1 - (documents.embedding <=> query_embedding)) > match_threshold
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$function$;
