-- Pin search_path on functions the linter flagged
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

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
set search_path = public
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

-- handle_new_user is a trigger fn only; it shouldn't be publicly callable via RPC
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- has_role / is_firm_member: used inside RLS policies, don't need anon RPC access
revoke execute on function public.has_role(uuid, public.app_role) from anon;
revoke execute on function public.is_firm_member(uuid) from anon;
