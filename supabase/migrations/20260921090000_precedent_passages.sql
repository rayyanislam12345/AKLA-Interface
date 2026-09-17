-- Clause search over the precedent library.
--
-- A precedent row is a whole agreement or a large piece of one (83,000
-- characters on average), so neither its embedding nor a text scan finds
-- clauses well: the embedding is too coarse, and ILIKE over the TOASTed
-- text took 27 seconds. Each precedent row is split here into its
-- paragraphs, one row each, with a full-text index — "liquidated damages"
-- is then an index lookup, and the paragraph is the unit the associate
-- reads.
create table public.precedent_passages (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text,
  filename text,
  document_type_id uuid,
  chunk_index integer,
  ordinal integer not null,
  body text not null,
  tsv tsvector generated always as (to_tsvector('english', body)) stored
);
create index precedent_passages_tsv_idx on public.precedent_passages using gin (tsv);
create index precedent_passages_document_idx on public.precedent_passages (document_id);
create index precedent_passages_type_idx on public.precedent_passages (document_type_id);
alter table public.precedent_passages enable row level security;
create policy "Firm members read precedent passages" on public.precedent_passages for select using (public.is_firm_member(auth.uid()));

-- A precedent row's paragraphs: block tags and line breaks end a paragraph,
-- pictures and other tags are dropped, entities decoded, and anything too
-- short to be a clause is left out. A paragraph longer than 2,400
-- characters (PDF text often has no breaks at all) is cut into pieces of
-- about 2,000 at a sentence end, so none of it is lost to search.
create or replace function public.precedent_paragraphs(p_content text)
returns table(ordinal integer, body text)
language sql immutable
as $$
  with paragraphs as (
    select row_number() over () as n, b
    from (
      select btrim(regexp_replace(
               replace(replace(replace(replace(replace(
                 regexp_replace(part, '<[^>]*>', ' ', 'g'),
                 '&amp;', '&'), '&quot;', '"'), '&#39;', ''''), '&nbsp;', ' '), '&lt;', '<'),
               '\s+', ' ', 'g')) as b
      from regexp_split_to_table(
        regexp_replace(coalesce(p_content, ''), '<img[^>]*>', '', 'gi'),
        '</(?:p|li|h[1-6]|tr|td|div)>|<br\s*/?>|\n+', 'i') as part
    ) raw
    where length(b) >= 40
  ),
  pieces as (
    select n, 0::bigint as k, b as piece from paragraphs where length(b) <= 2400
    union all
    select p.n, s.k, btrim(s.piece)
    from paragraphs p,
         lateral (
           select row_number() over () as k, piece
           from regexp_split_to_table(regexp_replace(p.b, '(.{1800,2200}?[.;:])\s+', '\1' || chr(1), 'g'), chr(1)) as piece
         ) s
    where length(p.b) > 2400
  )
  select (row_number() over (order by n, k))::integer, left(piece, 4000)
  from pieces
  where length(piece) >= 40;
$$;

create or replace function public.index_precedent_passages()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    delete from precedent_passages where document_id = new.id;
  end if;
  if new.is_precedent then
    insert into precedent_passages(document_id, storage_path, filename, document_type_id, chunk_index, ordinal, body)
    select new.id, new.metadata->>'storage_path', new.metadata->>'filename', new.document_type_id,
           nullif(new.metadata->>'chunk_index', '')::integer, p.ordinal, p.body
    from precedent_paragraphs(new.content) p;
  end if;
  return new;
end;
$$;
create trigger documents_precedent_passages
after insert or update of content, is_precedent, document_type_id on public.documents
for each row execute function public.index_precedent_passages();

-- Existing precedents.
insert into public.precedent_passages(document_id, storage_path, filename, document_type_id, chunk_index, ordinal, body)
select d.id, d.metadata->>'storage_path', d.metadata->>'filename', d.document_type_id,
       nullif(d.metadata->>'chunk_index', '')::integer, p.ordinal, p.body
from public.documents d, lateral public.precedent_paragraphs(d.content) p
where d.is_precedent;

-- The passages matching any of the phrases, best first. Each phrase is
-- matched as a phrase ("liquidated damages", not either word anywhere), with
-- English stemming so "damage" finds "damages".
create or replace function public.search_precedent_passages(p_phrases text[], p_document_type_id uuid default null, p_limit integer default 400)
returns table(id bigint, document_id uuid, storage_path text, filename text, document_type_id uuid, chunk_index integer, ordinal integer, body text, rank real)
language plpgsql stable security invoker set search_path = public as $$
declare q tsquery;
begin
  if not public.is_firm_member(auth.uid()) and auth.role() <> 'service_role' then raise exception 'Forbidden'; end if;
  select string_agg('(' || phraseto_tsquery('english', ph)::text || ')', ' | ')::tsquery into q
  from unnest(p_phrases) ph where length(btrim(ph)) > 1 and phraseto_tsquery('english', ph)::text <> '';
  if q is null then return; end if;
  return query
    select pp.id, pp.document_id, pp.storage_path, pp.filename, pp.document_type_id, pp.chunk_index, pp.ordinal, pp.body, ts_rank_cd(pp.tsv, q)
    from precedent_passages pp
    where pp.tsv @@ q and (p_document_type_id is null or pp.document_type_id = p_document_type_id)
    order by ts_rank_cd(pp.tsv, q) desc
    limit least(greatest(p_limit, 1), 1000);
end;
$$;
grant execute on function public.search_precedent_passages(text[], uuid, integer) to authenticated, service_role;
