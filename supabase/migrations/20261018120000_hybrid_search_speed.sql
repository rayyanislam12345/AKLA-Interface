-- Hybrid search, faster, 18 Oct 2026 (workstream C2).
--
-- REQUIRES 20261017120000_hybrid_search.sql (it replaces that function with
-- the same signature, legs, fusion and filters).
--
-- On the live library search_passages took 15 to 26 s for one precedent
-- call and up to 6 s for a statute call; the evaluation, which runs two to
-- four phrasings at once per scope, hit the 30 s statement timeout on every
-- precedent and statute question. Measured with EXPLAIN ANALYZE, 18 Oct:
--
--   * precedent name leg: 18.8 s. "In how many files' names does each word
--     appear" (name_df) was inlined by the planner into a correlated
--     subquery, so the GROUP BY over all 3,579 precedent rows ran once per
--     row (12 million unnest rows); the file names were also re-read and
--     parsed row by row (3,579 rows for 155 files).
--   * statute vector leg with named Acts: 1.4 to 5.1 s. The filtered HNSW
--     scan cannot find 40 rows of one Act among the nearest neighbours, so
--     the iterative scan walked the whole index (7,256 rows removed by the
--     filter, 22,000 buffers).
--   * statute vector leg without Acts: 0.3 to 6.5 s for a question whose
--     nearest rows are precedents (3,674 rows removed by the filter).
--   * per-word frequency checks: up to 16 counts of up to 5,000 precedent
--     paragraphs (or 500 statute rows) each, 50 ms to 1.8 s a call.
--
-- What this changes (results are the same; checked row for row against
-- the 17 Oct function on live data):
--
--   * precedent name leg: the library's files are listed once by a skip
--     scan of the storage path index (155 probes, not 3,579 rows), each
--     file's name is parsed once, name_df is materialized, and only a
--     matched file's rows are read to find its row closest to the query.
--     A precedent row without a storage path is still its own file.
--   * precedent "common word" check: read from the planner's statistics
--     for precedent_passages.tsv (pg_stats most_common_elems, via
--     public.precedent_common_lexemes, security definer because pg_stats
--     hides a row-secured table's statistics from signed-in users) instead
--     of counting paragraphs. A word is common when its estimated number of
--     paragraphs is at least 5,000, as before. When the table has no
--     statistics yet, the paragraphs are counted as before.
--   * statute with named Acts: the Acts' rows are listed first and every
--     leg runs on that list, the vector leg by exact distance (an Act is at
--     most a few hundred rows), as the project scope already does.
--   * project scope: the name leg's word counts are materialized (the same
--     correlated re-count as precedents, on a project's few hundred rows).
--   * keyword legs: passages with the same score at the 40th place are
--     taken in id order (they were taken in whatever order the scan gave,
--     so two runs could differ in the last one or two places).
--
-- 20261018120001_hybrid_search_indexes.sql adds partial indexes for the
-- precedent and statute legs (HNSW per library, a statute-only full-text
-- index, Act names, precedent storage paths). This function works without
-- them and uses them when they exist. Apply this file first, then that one,
-- statement by statement, outside a transaction.
--
-- Safe to run more than once (create or replace; grants repeated).
--
-- Reversal: re-run 20261017120000_hybrid_search.sql, then
--   drop function if exists public.precedent_common_lexemes(text[], integer);

do $$
begin
  if to_regprocedure('public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer)') is null then
    raise exception 'Apply 20261017120000_hybrid_search.sql first: this migration replaces search_passages.';
  end if;
end $$;

-- Which of the given lexemes are in at least min_passages precedent
-- paragraphs, by the planner's statistics. Null when precedent_passages has
-- no statistics yet (the caller then counts). Only this one column's
-- statistics are read: word frequencies, no text.
create or replace function public.precedent_common_lexemes(terms text[], min_passages integer)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
           when s.elems is null or c.reltuples is null or c.reltuples <= 0 then null
           else coalesce(array(
                  select e.w
                    from unnest(s.elems, s.freqs) as e(w, f)
                   where e.w = any(terms) and e.f * c.reltuples >= min_passages), '{}')
         end
    from (select 1) one
    left join lateral (
      select st.most_common_elems::text::text[] as elems, st.most_common_elem_freqs as freqs
        from pg_catalog.pg_stats st
       where st.schemaname = 'public' and st.tablename = 'precedent_passages' and st.attname = 'tsv'
       limit 1) s on true
    left join lateral (
      select greatest(pc.reltuples, 0)::double precision as reltuples
        from pg_catalog.pg_class pc
       where pc.oid = to_regclass('public.precedent_passages')) c on true
$$;

revoke all on function public.precedent_common_lexemes(text[], integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.precedent_common_lexemes(text[], integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.precedent_common_lexemes(text[], integer) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.precedent_common_lexemes(text[], integer) to service_role;
  end if;
end $$;

create or replace function public.search_passages(
  query_text text,
  query_embedding vector,
  scope text,
  matter_id uuid default null,
  act_names text[] default null,
  document_type_id uuid default null,
  all_versions boolean default false,
  exclude_document_id uuid default null,
  k integer default 40
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  heading_path text,
  page integer,
  document_version_id uuid,
  matter_document_id uuid,
  version_number integer,
  vector_rank integer,
  keyword_rank integer,
  rrf_score double precision,
  name_rank integer
)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $fn$
#variable_conflict use_column
declare
  v_scope text := search_passages.scope;
  v_matter uuid := search_passages.matter_id;
  v_acts text[] := nullif(search_passages.act_names, '{}');
  v_type uuid := search_passages.document_type_id;
  v_all boolean := coalesce(search_passages.all_versions, false);
  v_exclude uuid := search_passages.exclude_document_id;
  v_emb vector := search_passages.query_embedding;
  v_k integer := least(greatest(coalesce(search_passages.k, 40), 1), 200);
  v_text text := left(coalesce(search_passages.query_text, ''), 4000);
  v_q_and tsquery;
  v_q tsquery;                 -- the keyword leg's query: every word, or the OR fallback
  v_q_any tsquery;             -- any of the query's words (picking a precedent row's paragraph)
  v_terms text[] := '{}';      -- the query's content words as lexemes, in order (at most 16)
  v_tq tsquery[] := '{}';      -- the same, one tsquery each, for counting how many a passage holds
  v_or text[] := '{}';
  v_fallback boolean := false;
  v_hits integer := 0;
  v_df integer;
  v_common integer;            -- a word in at least this many of the scope's passages is "common"
  v_name_min integer;
  v_ids uuid[] := '{}';
  v_skip text[];               -- common words, from the statistics (precedent)
  t text;
begin
  if v_scope is null or v_scope not in ('project', 'precedent', 'statute') then
    raise exception 'search_passages: scope must be project, precedent or statute, not %', coalesce(v_scope, 'null');
  end if;
  if v_scope = 'project' and v_matter is null then
    return;
  end if;

  if v_emb is not null then
    -- Loads pgvector into this backend so its settings exist, then lets a
    -- filtered HNSW scan keep going until enough rows survive the filter
    -- (see 20260912090200_match_documents_iterative_scan.sql).
    perform v_emb <=> v_emb;
    perform set_config('hnsw.iterative_scan', 'strict_order', true);
    perform set_config('hnsw.ef_search', '100', true);
  end if;

  -- The query's words.
  select coalesce(array_agg(x.lexeme order by x.pos), '{}') into v_terms
    from (select u.lexeme, u.positions[1] as pos
            from unnest(to_tsvector('english', v_text)) u
           where u.lexeme !~ '[''\\]'
           order by u.positions[1]
           limit 16) x;
  select coalesce(array_agg(('''' || w || '''')::tsquery), '{}') into v_tq from unnest(v_terms) w;
  if cardinality(v_terms) > 0 then
    v_q_any := array_to_string(array(select '''' || w || '''' from unnest(v_terms) w), ' | ')::tsquery;
  end if;
  v_q_and := websearch_to_tsquery('english', v_text);
  if numnode(v_q_and) = 0 then v_q_and := null; end if;
  -- A file's name must hold a third of the query's words, and at least two
  -- of them when the query has two or more.
  v_name_min := case when cardinality(v_terms) = 0 then 1000
                     else least(cardinality(v_terms), greatest(2, ceil(cardinality(v_terms) / 3.0)::integer)) end;

  -- ------------------------------------------------------------- project
  if v_scope = 'project' then
    with cur as (
      select distinct on (dv.matter_document_id) dv.id, dv.storage_path
        from public.document_versions dv
        join public.matter_documents md on md.id = dv.matter_document_id
       where md.matter_id = v_matter and not coalesce(dv.is_ai_generated, false)
       order by dv.matter_document_id, dv.version_number desc
    )
    select coalesce(array_agg(d.id), '{}') into v_ids
      from public.documents d
     where d.matter_id = v_matter
       and not coalesce(d.is_precedent, false) and not coalesce(d.is_statute, false)
       and (v_type is null or d.document_type_id = v_type)
       and (v_exclude is null or (
             d.matter_document_id is distinct from v_exclude
             and not exists (select 1 from public.document_versions xv
                              where xv.matter_document_id = v_exclude and xv.storage_path = d.metadata->>'storage_path')))
       and (v_all
            or d.document_version_id in (select cur.id from cur)
            or (d.document_version_id is null and d.metadata->>'storage_path' in (select cur.storage_path from cur)));

    if v_q_and is not null then
      select count(*) into v_hits from (select 1 from public.documents d where d.id = any(v_ids) and d.tsv @@ v_q_and limit 5) s;
    end if;
    if v_hits < 5 and cardinality(v_terms) > 0 then
      v_fallback := true;
      v_common := greatest(10, ceil(cardinality(v_ids) * 0.5)::integer);
      foreach t in array v_terms loop
        select count(*) into v_df from (select 1 from public.documents d where d.id = any(v_ids) and d.tsv @@ ('''' || t || '''')::tsquery limit v_common) s;
        if v_df < v_common then v_or := v_or || t; end if;
      end loop;
      if cardinality(v_or) = 0 then v_or := v_terms; end if;
      v_q := array_to_string(array(select '''' || w || '''' from unnest(v_or) w), ' | ')::tsquery;
    else
      v_q := v_q_and;
    end if;

    return query
    with vec as (
      select x.id, (row_number() over (order by x.dist, x.id))::integer as r
        from (select d.id, d.embedding <=> v_emb as dist
                from public.documents d
               where v_emb is not null and d.id = any(v_ids) and d.embedding is not null
               -- Exact distances (+ 0 keeps the HNSW index out): a project
               -- is a few hundred rows, and an approximate scan filtered
               -- down to one project can miss its nearest passages.
               order by (d.embedding <=> v_emb) + 0
               limit v_k) x
    ),
    kw as (
      select x.id, (row_number() over (order by x.score desc, x.id))::integer as r
        from (select c.id,
                     (case when v_fallback then (select count(*) from unnest(v_tq) q where c.tsv @@ q) else 0 end)
                       + ts_rank_cd(c.tsv, v_q, 32) as score
                from (select d.id, d.tsv from public.documents d
                       where v_q is not null and d.id = any(v_ids) and d.tsv @@ v_q
                       order by ts_rank(d.tsv, v_q) desc
                       limit greatest(v_k * 8, 300)) c
               order by 2 desc, 1
               limit v_k) x
    ),
    -- Materialized, here and in name_df: inlined, the planner re-ran the
    -- word count below once per passage.
    named as materialized (
      select d.id, coalesce(d.matter_document_id::text, d.metadata->>'storage_path', d.id::text) as f,
             array(select w from unnest(v_terms) w where nt.v @@ ('''' || w || '''')::tsquery) as hit_terms,
             d.embedding
        from public.documents d
        left join public.matter_documents md on md.id = d.matter_document_id
        cross join lateral (select to_tsvector('english', regexp_replace(coalesce(md.title, '') || ' ' || coalesce(d.metadata->>'filename', ''), '[^[:alnum:]]+', ' ', 'g')) as v) nt
       where d.id = any(v_ids) and cardinality(v_terms) > 0
    ),
    -- In how many files' names each word appears: one or two is telling
    -- ("SHA0522", "novation") even alone.
    name_df as materialized (
      select w, count(distinct n.f) as files from named n, unnest(n.hit_terms) w group by w
    ),
    nm as (
      select y.id, (row_number() over (order by y.hits desc, y.dist, y.id))::integer as r
        from (select distinct on (n.f) n.id, cardinality(n.hit_terms) as hits,
                     case when v_emb is null or n.embedding is null then 2 else n.embedding <=> v_emb end as dist
                from named n
               where cardinality(n.hit_terms) >= v_name_min
                  or exists (select 1 from name_df x where x.w = any(n.hit_terms) and x.files <= 2 and length(x.w) >= 3)
               order by n.f, 3, n.id) y
       order by y.hits desc, y.dist
       limit v_k
    ),
    fused as (
      select u.id, min(u.vr) as vr, min(u.kr) as kr, min(u.nr) as nr
        from (select vec.id, vec.r as vr, null::integer as kr, null::integer as nr from vec
              union all select kw.id, null, kw.r, null from kw
              union all select nm.id, null, null, nm.r from nm) u
       group by u.id
    ),
    ranked as (
      select f.id, f.vr, f.kr, f.nr,
             coalesce(1.0 / (60 + f.vr), 0) + coalesce(1.0 / (60 + f.kr), 0) + coalesce(1.0 / (60 + f.nr), 0) as rrf,
             row_number() over (partition by coalesce(d.document_version_id::text, d.metadata->>'storage_path', d.id::text)
                                order by coalesce(1.0 / (60 + f.vr), 0) + coalesce(1.0 / (60 + f.kr), 0) + coalesce(1.0 / (60 + f.nr), 0) desc, f.id) as n
        from fused f join public.documents d on d.id = f.id
    )
    select d.id, d.content,
           coalesce(d.metadata, '{}'::jsonb) || jsonb_build_object('document_title', md.title, 'version_file_name', dv.file_name),
           d.heading_path, d.page,
           coalesce(d.document_version_id, dv.id), coalesce(d.matter_document_id, dv.matter_document_id),
           coalesce(d.version_number, dv.version_number),
           r.vr, r.kr, r.rrf::double precision, r.nr
      from ranked r
      join public.documents d on d.id = r.id
      left join public.document_versions dv
        on dv.id = d.document_version_id
        or (d.document_version_id is null and dv.storage_path = d.metadata->>'storage_path')
      left join public.matter_documents md on md.id = coalesce(d.matter_document_id, dv.matter_document_id)
     where r.n <= 3
     order by r.rrf desc, d.id
     limit v_k;
    return;
  end if;

  -- ----------------------------------------------------------- precedent
  if v_scope = 'precedent' then
    if v_q_and is not null then
      select count(*) into v_hits
        from (select 1 from public.precedent_passages pp
               where pp.tsv @@ v_q_and and (v_type is null or pp.document_type_id = v_type) limit 5) s;
    end if;
    if v_hits < 5 and cardinality(v_terms) > 0 then
      v_fallback := true;
      v_common := 5000;
      -- The statistics say which words are in 5,000 paragraphs or more
      -- (library-wide, a document type filter aside); counting them cost
      -- up to 16 scans of 5,000 paragraphs. Counted only when the table
      -- has no statistics yet.
      v_skip := public.precedent_common_lexemes(v_terms, v_common);
      if v_skip is not null then
        v_or := array(select u.w from unnest(v_terms) with ordinality u(w, n) where u.w <> all(v_skip) order by u.n);
      else
        foreach t in array v_terms loop
          select count(*) into v_df
            from (select 1 from public.precedent_passages pp
                   where pp.tsv @@ ('''' || t || '''')::tsquery and (v_type is null or pp.document_type_id = v_type) limit v_common) s;
          if v_df < v_common then v_or := v_or || t; end if;
        end loop;
      end if;
      if cardinality(v_or) = 0 then v_or := v_terms; end if;
      v_q := array_to_string(array(select '''' || w || '''' from unnest(v_or) w), ' | ')::tsquery;
    else
      v_q := v_q_and;
    end if;

    return query
    with recursive vec_rows as (
      select x.id as doc, (row_number() over (order by x.dist, x.id))::integer as r
        from (select d.id, d.embedding <=> v_emb as dist
                from public.documents d
               where v_emb is not null and d.is_precedent and d.embedding is not null
                 and (v_type is null or d.document_type_id = v_type)
               order by d.embedding <=> v_emb
               limit v_k) x
    ),
    -- The library's files, one row each, by a skip scan of the storage
    -- path index: one probe a file (155), not every row (3,579). A file's
    -- rows share its file name.
    files as (
      (select d.metadata->>'storage_path' as f, d.metadata->>'filename' as fn
         from public.documents d
        where cardinality(v_terms) > 0 and d.is_precedent and d.metadata->>'storage_path' is not null
          and (v_type is null or d.document_type_id = v_type)
        order by d.metadata->>'storage_path'
        limit 1)
      union all
      (select nx.f, nx.fn
         from files
         cross join lateral (
           select d.metadata->>'storage_path' as f, d.metadata->>'filename' as fn
             from public.documents d
            where d.is_precedent and d.metadata->>'storage_path' > files.f
              and (v_type is null or d.document_type_id = v_type)
            order by d.metadata->>'storage_path'
            limit 1) nx)
    ),
    -- A row with no storage path is a file of its own.
    named as materialized (
      select fl.f, fl.row_id,
             array(select w from unnest(v_terms) w where nt.v @@ ('''' || w || '''')::tsquery) as hit_terms
        from (select files.f, null::uuid as row_id, files.fn from files
              union all
              select d.id::text, d.id, d.metadata->>'filename'
                from public.documents d
               where cardinality(v_terms) > 0 and d.is_precedent and d.metadata->>'storage_path' is null
                 and (v_type is null or d.document_type_id = v_type)) fl
        cross join lateral (select to_tsvector('english', regexp_replace(coalesce(fl.fn, ''), '[^[:alnum:]]+', ' ', 'g')) as v) nt
    ),
    -- In how many files' names each word appears (computed once: inlined,
    -- the planner re-ran this count once per row).
    name_df as materialized (
      select w, count(*) as files from named n, unnest(n.hit_terms) w group by w
    ),
    name_hit as (
      select n.f, n.row_id, cardinality(n.hit_terms) as hits
        from named n
       where cardinality(n.hit_terms) >= v_name_min
          or exists (select 1 from name_df x where x.w = any(n.hit_terms) and x.files <= 2 and length(x.w) >= 3)
    ),
    -- Each named file by its row closest to the query.
    name_rows as (
      select y.id as doc, (row_number() over (order by y.hits desc, y.dist, y.id))::integer as r
        from (select nh.hits, b.id, b.dist
                from name_hit nh
                cross join lateral (
                  select d.id, case when v_emb is null or d.embedding is null then 2 else d.embedding <=> v_emb end as dist
                    from public.documents d
                   where nh.row_id is null and d.is_precedent and d.metadata->>'storage_path' = nh.f
                     and (v_type is null or d.document_type_id = v_type)
                   order by 2, d.id
                   limit 1) b
              union all
              select nh.hits, d.id, case when v_emb is null or d.embedding is null then 2 else d.embedding <=> v_emb end
                from name_hit nh join public.documents d on d.id = nh.row_id) y
       order by y.hits desc, y.dist
       limit v_k
    ),
    -- A row found by meaning or by name is represented by its paragraph
    -- that holds most of the query's words (its first, when none does).
    row_paragraphs as (
      select h.leg, h.r, coalesce(p.pid, f.pid) as pid
        from (select 'v'::text as leg, vr.doc, vr.r from vec_rows vr
              union all select 'n'::text, nr.doc, nr.r from name_rows nr) h
        left join lateral (
          select c.pid
            from (select pp.id as pid, pp.ordinal, pp.tsv
                    from public.precedent_passages pp
                   where v_q_any is not null and pp.document_id = h.doc and pp.tsv @@ v_q_any
                   order by ts_rank(pp.tsv, v_q_any) desc
                   limit 20) c
           order by (select count(*) from unnest(v_tq) q where c.tsv @@ q) desc, ts_rank_cd(c.tsv, v_q_any, 32) desc, c.ordinal
           limit 1) p on true
        left join lateral (
          select pp.id as pid from public.precedent_passages pp where pp.document_id = h.doc order by pp.ordinal limit 1) f on true
       where coalesce(p.pid, f.pid) is not null
    ),
    kw as (
      select x.pid, (row_number() over (order by x.score desc, x.pid))::integer as r
        from (select c.pid,
                     (case when v_fallback then (select count(*) from unnest(v_tq) q where c.tsv @@ q) else 0 end)
                       + ts_rank_cd(c.tsv, v_q, 32) as score
                from (select pp.id as pid, pp.tsv from public.precedent_passages pp
                       where v_q is not null and pp.tsv @@ v_q and (v_type is null or pp.document_type_id = v_type)
                       order by ts_rank(pp.tsv, v_q) desc
                       limit greatest(v_k * 8, 300)) c
               order by 2 desc, 1
               limit v_k) x
    ),
    fused as (
      select u.pid, min(u.vr) as vr, min(u.kr) as kr, min(u.nr) as nr
        from (select rp.pid, rp.r as vr, null::integer as kr, null::integer as nr from row_paragraphs rp where rp.leg = 'v'
              union all select rp.pid, null, null, rp.r from row_paragraphs rp where rp.leg = 'n'
              union all select kw.pid, null, kw.r, null from kw) u
       group by u.pid
    ),
    ranked as (
      select f.pid, f.vr, f.kr, f.nr,
             coalesce(1.0 / (60 + f.vr), 0) + coalesce(1.0 / (60 + f.kr), 0) + coalesce(1.0 / (60 + f.nr), 0) as rrf,
             row_number() over (partition by coalesce(pp.storage_path, pp.document_id::text)
                                order by coalesce(1.0 / (60 + f.vr), 0) + coalesce(1.0 / (60 + f.kr), 0) + coalesce(1.0 / (60 + f.nr), 0) desc, f.pid) as n
        from fused f join public.precedent_passages pp on pp.id = f.pid
    )
    select d.id, pp.body,
           coalesce(d.metadata, '{}'::jsonb) || jsonb_build_object('passage_ordinal', pp.ordinal, 'passage_id', pp.id),
           d.heading_path, d.page, d.document_version_id, d.matter_document_id, d.version_number,
           r.vr, r.kr, r.rrf::double precision, r.nr
      from ranked r
      join public.precedent_passages pp on pp.id = r.pid
      join public.documents d on d.id = pp.document_id
     where r.n <= 3
     order by r.rrf desc, pp.id
     limit v_k;
    return;
  end if;

  -- ------------------------------------------------------------- statute
  -- Named Acts: their rows first (a few hundred at most), then every leg on
  -- that list, the vector leg by exact distance, as for a project. A
  -- filtered HNSW scan cannot find 40 rows of one Act among the nearest
  -- neighbours and walked the whole index (1.4 to 5 s).
  if v_acts is not null then
    select coalesce(array_agg(d.id), '{}') into v_ids
      from public.documents d
     where d.is_statute
       and (d.metadata->>'act_name' = any(v_acts) or d.metadata->>'amends_act' = any(v_acts));
    if cardinality(v_ids) = 0 then
      return;
    end if;
  end if;

  if v_q_and is not null then
    if v_acts is null then
      select count(*) into v_hits
        from (select 1 from public.documents d
               where d.is_statute and d.tsv @@ v_q_and
                 and (v_type is null or d.document_type_id = v_type)
               limit 5) s;
    else
      select count(*) into v_hits
        from (select 1 from public.documents d
               where d.id = any(v_ids) and d.tsv @@ v_q_and
                 and (v_type is null or d.document_type_id = v_type)
               limit 5) s;
    end if;
  end if;
  if v_hits < 5 and cardinality(v_terms) > 0 then
    v_fallback := true;
    v_common := case when v_acts is null then 500 else 100 end;
    foreach t in array v_terms loop
      if v_acts is null then
        select count(*) into v_df
          from (select 1 from public.documents d
                 where d.is_statute and d.tsv @@ ('''' || t || '''')::tsquery
                 limit v_common) s;
      else
        select count(*) into v_df
          from (select 1 from public.documents d
                 where d.id = any(v_ids) and d.tsv @@ ('''' || t || '''')::tsquery
                 limit v_common) s;
      end if;
      if v_df < v_common then v_or := v_or || t; end if;
    end loop;
    if cardinality(v_or) = 0 then v_or := v_terms; end if;
    v_q := array_to_string(array(select '''' || w || '''' from unnest(v_or) w), ' | ')::tsquery;
  else
    v_q := v_q_and;
  end if;

  return query
  with vec as (
    select x.id, (row_number() over (order by x.dist, x.id))::integer as r
      from (select d.id, d.embedding <=> v_emb as dist
              from public.documents d
             where v_emb is not null and v_acts is null and d.is_statute and d.embedding is not null
               and (v_type is null or d.document_type_id = v_type)
             order by d.embedding <=> v_emb
             limit v_k) x
    union all
    select x.id, (row_number() over (order by x.dist, x.id))::integer as r
      from (select d.id, d.embedding <=> v_emb as dist
              from public.documents d
             where v_emb is not null and v_acts is not null and d.id = any(v_ids) and d.embedding is not null
               and (v_type is null or d.document_type_id = v_type)
             -- Exact distances (+ 0 keeps the HNSW index out).
             order by (d.embedding <=> v_emb) + 0
             limit v_k) x
  ),
  kw as (
    select x.id, (row_number() over (order by x.score desc, x.id))::integer as r
      from (select c.id,
                   (case when v_fallback then (select count(*) from unnest(v_tq) q where c.tsv @@ q) else 0 end)
                     + ts_rank_cd(c.tsv, v_q, 32) as score
              from (select u.id, u.tsv
                      from (select d.id, d.tsv from public.documents d
                             where v_q is not null and v_acts is null and d.is_statute and d.tsv @@ v_q
                               and (v_type is null or d.document_type_id = v_type)
                            union all
                            select d.id, d.tsv from public.documents d
                             where v_q is not null and v_acts is not null and d.id = any(v_ids) and d.tsv @@ v_q
                               and (v_type is null or d.document_type_id = v_type)) u
                     order by ts_rank(u.tsv, v_q) desc
                     limit greatest(v_k * 8, 300)) c
             order by 2 desc, 1
             limit v_k) x
  ),
  fused as (
    select u.id, min(u.vr) as vr, min(u.kr) as kr
      from (select vec.id, vec.r as vr, null::integer as kr from vec
            union all select kw.id, null, kw.r from kw) u
     group by u.id
  ),
  ranked as (
    select f.id, f.vr, f.kr,
           coalesce(1.0 / (60 + f.vr), 0) + coalesce(1.0 / (60 + f.kr), 0) as rrf,
           row_number() over (partition by coalesce(d.metadata->>'act_name', d.metadata->>'storage_path', d.id::text)
                              order by coalesce(1.0 / (60 + f.vr), 0) + coalesce(1.0 / (60 + f.kr), 0) desc, f.id) as n
      from fused f join public.documents d on d.id = f.id
  )
  select d.id, d.content, coalesce(d.metadata, '{}'::jsonb), d.heading_path, d.page,
         d.document_version_id, d.matter_document_id, d.version_number,
         r.vr, r.kr, r.rrf::double precision, null::integer
    from ranked r join public.documents d on d.id = r.id
   where v_acts is not null or r.n <= 3
   order by r.rrf desc, d.id
   limit v_k;
end;
$fn$;

comment on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer) is
  'Hybrid passage search for one scope (project | precedent | statute): vector + keyword (+ file name) legs fused by reciprocal rank, current versions only unless all_versions, at most 3 passages a file. Called by chat-service/retrieve.js. See 20261017120000_hybrid_search.sql and 20261018120000_hybrid_search_speed.sql.';

revoke all on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer) to service_role;
  end if;
end $$;
