-- Adds statute-corpus search to the existing semantic-search RPC, alongside
-- its existing precedent_only flag. Purely additive (new trailing optional
-- param) — rag-query's existing named-arg call never passes statute_only,
-- so it keeps defaulting to false and is unaffected.
CREATE OR REPLACE FUNCTION public.match_documents(
  query_embedding vector,
  match_threshold double precision DEFAULT 0.5,
  match_count integer DEFAULT 5,
  filter_matter_id uuid DEFAULT NULL,
  filter_document_type_id uuid DEFAULT NULL,
  precedent_only boolean DEFAULT false,
  statute_only boolean DEFAULT false
)
RETURNS TABLE(id uuid, content text, metadata jsonb, matter_id uuid, document_type_id uuid, similarity double precision)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
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
    and (not statute_only or documents.is_statute = true)
    and (1 - (documents.embedding <=> query_embedding)) > match_threshold
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$function$;
