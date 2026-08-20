-- voyage-law-2 cosine similarities run lower than OpenAI's embeddings for
-- genuinely relevant matches (observed ~0.6 on a clean match against a
-- 0.7-tuned default inherited from the old OpenAI pipeline) -- 0.5 is a
-- provisional default, worth re-tuning once there's a larger precedent corpus.
create or replace function public.match_documents(
  query_embedding vector(1024),
  match_threshold float default 0.5,
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
set search_path = public, extensions
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
