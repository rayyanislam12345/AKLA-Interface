-- Server-side aggregation for the Precedent Library and Law Library pages.
-- The old client-side approach selected every chunk row from `documents`
-- and deduped in JS, which silently truncated at PostgREST's 1000-row
-- default cap once there were enough chunks to crowd out whole documents.
-- These functions aggregate in SQL instead, so the row count returned is
-- bounded by distinct source count, not raw chunk count.

create or replace function public.precedent_sources()
returns table(
  storage_path text,
  filename text,
  document_type_id uuid,
  document_type_name text,
  chunk_count bigint,
  created_at timestamptz
)
language sql
stable
as $$
  select
    d.metadata->>'storage_path' as storage_path,
    min(d.metadata->>'filename') as filename,
    d.document_type_id,
    dt.name as document_type_name,
    count(*) as chunk_count,
    min(d.created_at) as created_at
  from public.documents d
  left join public.document_types dt on dt.id = d.document_type_id
  where d.is_precedent = true
  group by d.metadata->>'storage_path', d.document_type_id, dt.name
  order by min(d.created_at) desc;
$$;

create or replace function public.statute_sources()
returns table(
  act_name text,
  source text,
  source_url text,
  chunk_count bigint,
  scraped_at timestamptz
)
language sql
stable
as $$
  select
    d.metadata->>'act_name' as act_name,
    min(d.metadata->>'source') as source,
    min(d.metadata->>'source_url') as source_url,
    count(*) as chunk_count,
    coalesce(min(d.metadata->>'scraped_at')::timestamptz, min(d.created_at)) as scraped_at
  from public.documents d
  where d.is_statute = true
  group by d.metadata->>'act_name'
  order by coalesce(min(d.metadata->>'scraped_at')::timestamptz, min(d.created_at)) desc;
$$;
