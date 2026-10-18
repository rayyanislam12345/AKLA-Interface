-- Hybrid search, one call per scope, 19 Oct 2026 (workstream C2).
--
-- REQUIRES 20261017120000_hybrid_search.sql and
-- 20261018120000_hybrid_search_speed.sql (the legs, the fusion, the filters
-- are theirs; this replaces the function with the same legs and two more
-- parameters, and adds precedent_lexeme_df beside precedent_common_lexemes).
--
-- Until now chat-service/retrieve.js sent search_passages once per phrasing
-- (the question by words alone, the question with its embedding, and up to
-- three Haiku phrasings): five calls per scope, fifteen per chat turn, two
-- questions at a time in the evaluation. PostgREST reaches the database
-- through about ten connections, a call the client stops waiting for at its
-- deadline runs on for up to the role's 30 s statement timeout, and so the
-- pool jammed: on 18 Oct the evaluation's tools run returned nothing for 51
-- of 60 searches. Now a scope is searched in at most two calls:
--
--   1. at once, the question by its words (no embedding: the keyword and
--      name legs, no Voyage call) — the safety net;
--   2. when the one embedding call is back, the full hybrid search carrying
--      the question's embedding AND its phrasings, each with its own
--      embedding, in `phrasings`: [{"text": "...", "embedding": [...]}].
--
-- Inside one call the question is phrasing 1 and the phrasings 2..4. Each
-- runs its own vector leg (its embedding, when it has one) and keyword leg
-- (every word, else the OR fallback over its uncommon words, as before); the
-- name leg runs once, for the question. Fusion, as retrieve.js fused the
-- lists of its calls: a passage's score under one phrasing is 1/(60 + rank)
-- summed over the legs that found it (the name leg counts for every
-- phrasing), its fused score is the best of those, ties broken by their sum
-- (found by more phrasings wins), then id; vector_rank, keyword_rank and
-- name_rank report the best rank in each leg; at most three passages a file
-- (per Act when no Act is named), k in all.
--
-- `phrasings` is jsonb, not vector[]: PostgREST casts a JSON array of arrays
-- into vector[] as a two-dimensional array of numbers and fails ("Vector
-- contents must start with ["). An embedding is read as a float8 array and
-- cast to vector.
--
-- `max_ms`: how long the call may take. The function reads the clock between
-- its legs and stops with 57014 (query_canceled) once over it, so a call the
-- client has abandoned does not run every leg. It cannot stop a leg that is
-- running: a `set local statement_timeout` inside a function does NOT bound
-- the statement that is already running it — Postgres arms the timer when
-- the top-level statement starts (start_xact_command → enable_statement_
-- timeout) and setting the GUC later changes nothing until the next
-- statement (verified on the live database, 19 Oct: set_config('statement_
-- timeout','500',true) then pg_sleep(2) in one statement ran for 2.0 s; as
-- two statements the second was cancelled). The hard bound comes from
-- PostgREST instead: its pre-request function (below) runs as a statement of
-- its own before the RPC, in the same transaction, and sets the local
-- statement_timeout from the request's X-Statement-Timeout-Ms header (never
-- above the role's own). retrieve.js sends both: the header for the hard
-- bound, max_ms for the checks between legs.
--
-- Per-call cost (EXPLAIN ANALYZE, live data, 19 Oct): the words-only
-- precedent call for "example of a drag along clause in a joint venture
-- agreement" runs in 75-90 ms on a warm session; its 4.5 s was the first
-- call on a fresh session (the same 17,870 buffers, every node 30-60x
-- slower: catalog caches and the function's plans being built), which every
-- new PostgREST connection pays once, and after a minute's idleness the
-- instance's cache is cold: the OR keyword leg then reads every paragraph
-- that holds any of the words from disk (1,615 paragraphs, 1.5 s; 1,309
-- statute rows, 3 s), the HNSW legs 0.5-0.6 s. So a precedent or statute
-- keyword candidate must now hold one of the phrasing's rarest three
-- uncommon words (the ranking is unchanged: how many of the words it
-- holds, then ts_rank_cd), the precedent word counts come from the
-- statistics (precedent_lexeme_df, no counting scans), and the legs are
-- separate, smaller statements, which plan faster.
--
-- The function's signature changes (two parameters with defaults), so the
-- old one is dropped first: PostgREST cannot choose between two overloads
-- that both accept the same nine arguments. retrieve.js keeps working while
-- the function is missing (it falls back to match_documents for a minute).
--
-- Safe to run more than once. Reversal: drop function if exists
-- public.search_passages(text, vector, text, uuid, text[], uuid, boolean,
-- uuid, integer, jsonb, integer); drop function if exists
-- public.precedent_lexeme_df(text[]); then re-run the 17 Oct and 18 Oct files;
-- and, for the pre-request: alter role authenticator reset
-- pgrst.db_pre_request; notify pgrst, 'reload config'; drop function
-- public.pgrst_pre_request();

do $$
begin
  if to_regprocedure('public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer)') is null
     and to_regprocedure('public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer, jsonb, integer)') is null then
    raise exception 'Apply 20261017120000_hybrid_search.sql and 20261018120000_hybrid_search_speed.sql first: this migration replaces search_passages.';
  end if;
end $$;

-- Each lexeme's estimated number of precedent paragraphs, from the planner's
-- statistics on precedent_passages.tsv (pg_stats most_common_elems), aligned
-- with `terms`: null for a lexeme not among the most common (rare: fewer
-- paragraphs than the least common listed), and the whole result null when
-- the table has no statistics yet (the caller then counts). Security
-- definer because pg_stats hides a row-secured table's statistics from
-- signed-in users; only word frequencies are read, no text. Replaces
-- precedent_common_lexemes (18 Oct), which stays for its callers.
create or replace function public.precedent_lexeme_df(terms text[])
returns real[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
           when s.elems is null or c.reltuples is null or c.reltuples <= 0 then null
           else array(select (select (e.f * c.reltuples)::real
                                from unnest(s.elems, s.freqs) as e(w, f)
                               where e.w = t.w
                               limit 1)
                        from unnest(terms) with ordinality as t(w, n)
                       order by t.n)
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

revoke all on function public.precedent_lexeme_df(text[]) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.precedent_lexeme_df(text[]) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.precedent_lexeme_df(text[]) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.precedent_lexeme_df(text[]) to service_role;
  end if;
end $$;

drop function if exists public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer);

create or replace function public.search_passages(
  query_text text,
  query_embedding vector,
  scope text,
  matter_id uuid default null,
  act_names text[] default null,
  document_type_id uuid default null,
  all_versions boolean default false,
  exclude_document_id uuid default null,
  k integer default 40,
  phrasings jsonb default null,
  max_ms integer default null
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
  v_started timestamptz := clock_timestamp();
  v_scope text := search_passages.scope;
  v_matter uuid := search_passages.matter_id;
  v_acts text[] := nullif(search_passages.act_names, '{}');
  v_type uuid := search_passages.document_type_id;
  v_all boolean := coalesce(search_passages.all_versions, false);
  v_exclude uuid := search_passages.exclude_document_id;
  v_k integer := least(greatest(coalesce(search_passages.k, 40), 1), 200);
  v_max integer := search_passages.max_ms;
  v_phr jsonb := case when jsonb_typeof(search_passages.phrasings) = 'array' then search_passages.phrasings else '[]'::jsonb end;
  v_texts text[];              -- phrasing 1 is the question, then the phrasings (four at most)
  v_n integer;
  v_p integer;
  v_text text;
  v_emb vector;                -- the phrasing's embedding, null when it has none
  v_q_and tsquery;
  v_q tsquery;                 -- the keyword leg's ranking query: every word, or the OR fallback
  v_q_req tsquery;             -- what a keyword candidate must hold: every word, or one of the rarest few
  v_q_any tsquery;             -- any of the phrasing's words (picking a precedent row's paragraph)
  v_terms text[] := '{}';      -- the phrasing's content words as lexemes, in order (at most 16)
  v_tq tsquery[] := '{}';      -- the same, one tsquery each, for counting how many a passage holds
  v_or text[] := '{}';
  v_fallback boolean := false;
  v_hits integer := 0;
  v_df real[];                 -- each term's passages in the scope (counted, or estimated from the statistics; null: rare, uncounted)
  v_cnt integer;
  v_req text[];
  v_common integer;            -- a word in at least this many of the scope's passages is "common"
  v_name_min integer;
  v_ids uuid[] := '{}';
  v_hit jsonb := '[]'::jsonb;  -- every leg's hits: [{p, leg: v | k | n, id, r}]
  v_leg jsonb;
  v_elapsed numeric;
  t text;
begin
  if v_scope is null or v_scope not in ('project', 'precedent', 'statute') then
    raise exception 'search_passages: scope must be project, precedent or statute, not %', coalesce(v_scope, 'null');
  end if;
  if v_scope = 'project' and v_matter is null then
    return;
  end if;

  -- The question and its phrasings (texts; an embedding each, read below).
  v_texts := array[left(coalesce(search_passages.query_text, ''), 4000)]
          || array(select left(coalesce(e->>'text', ''), 4000) from jsonb_array_elements(v_phr) e limit 3);
  v_n := cardinality(v_texts);

  -- Any embedding at hand (the question's, else the first phrasing's).
  v_emb := search_passages.query_embedding;
  if v_emb is null then
    select array_agg(x.v::double precision order by x.o)::vector into v_emb
      from (select e->'embedding' as emb from jsonb_array_elements(v_phr) e where jsonb_typeof(e->'embedding') = 'array' limit 1) f,
           jsonb_array_elements_text(f.emb) with ordinality x(v, o);
  end if;
  if v_emb is not null then
    -- Loads pgvector into this backend so its settings exist, then lets a
    -- filtered HNSW scan keep going until enough rows survive the filter
    -- (see 20260912090200_match_documents_iterative_scan.sql).
    perform v_emb <=> v_emb;
    perform set_config('hnsw.iterative_scan', 'strict_order', true);
    perform set_config('hnsw.ef_search', '100', true);
  end if;

  -- ------------------------------------------------- the scope's rows
  -- project: the current version of each document (or every version);
  -- statute with named Acts: the Acts' rows.
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
    if cardinality(v_ids) = 0 then
      return;
    end if;
  elsif v_scope = 'statute' and v_acts is not null then
    select coalesce(array_agg(d.id), '{}') into v_ids
      from public.documents d
     where d.is_statute
       and (d.metadata->>'act_name' = any(v_acts) or d.metadata->>'amends_act' = any(v_acts));
    if cardinality(v_ids) = 0 then
      return;
    end if;
  end if;

  -- ------------------------------------------------- the legs, a phrasing at a time
  for v_p in 1..v_n loop
    -- Out of time: stop here rather than run the rest for nobody.
    if v_max is not null then
      v_elapsed := extract(epoch from clock_timestamp() - v_started) * 1000;
      if v_elapsed >= v_max then
        raise exception 'search_passages: out of time (% ms of % allowed) before phrasing %', round(v_elapsed), v_max, v_p
          using errcode = 'query_canceled';
      end if;
    end if;

    v_text := v_texts[v_p];
    if v_p = 1 then
      v_emb := search_passages.query_embedding;
    elsif jsonb_typeof(v_phr->(v_p - 2)->'embedding') = 'array' then
      select array_agg(x.v::double precision order by x.o)::vector into v_emb
        from jsonb_array_elements_text(v_phr->(v_p - 2)->'embedding') with ordinality x(v, o);
    else
      v_emb := null;
    end if;

    -- The phrasing's words.
    select coalesce(array_agg(x.lexeme order by x.pos), '{}') into v_terms
      from (select u.lexeme, u.positions[1] as pos
              from unnest(to_tsvector('english', v_text)) u
             where u.lexeme !~ '[''\\]'
             order by u.positions[1]
             limit 16) x;
    select coalesce(array_agg(('''' || w || '''')::tsquery), '{}') into v_tq from unnest(v_terms) w;
    v_q_any := null;
    if cardinality(v_terms) > 0 then
      v_q_any := array_to_string(array(select '''' || w || '''' from unnest(v_terms) w), ' | ')::tsquery;
    end if;
    v_q_and := websearch_to_tsquery('english', v_text);
    if numnode(v_q_and) = 0 then v_q_and := null; end if;
    -- A file's name must hold a third of the question's words, and at least
    -- two of them when the question has two or more.
    v_name_min := case when cardinality(v_terms) = 0 then 1000
                       else least(cardinality(v_terms), greatest(2, ceil(cardinality(v_terms) / 3.0)::integer)) end;

    -- Every word, or — when fewer than five passages hold every word — any
    -- of the phrasing's words that are not common in the scope, ranked by
    -- how many of the words a passage holds. A precedent or statute
    -- candidate must then hold one of the rarest three of those words
    -- (v_q_req): on a cold cache the leg's cost is reading every paragraph
    -- that holds any word (1,615 rows, 1.5 s for "example of a drag along
    -- clause in a joint venture agreement"; 1,309 statute rows, 3 s for
    -- "is an LD clause a penalty"), and a passage holding only the
    -- commoner words does not rank anyway. A project is small: any word.
    v_hits := 0;
    v_fallback := false;
    v_or := '{}';
    v_q := null;
    v_q_req := null;
    if v_q_and is not null then
      if v_scope = 'project' or (v_scope = 'statute' and v_acts is not null) then
        select count(*) into v_hits from (select 1 from public.documents d where d.id = any(v_ids) and d.tsv @@ v_q_and limit 5) s;
      elsif v_scope = 'statute' then
        select count(*) into v_hits
          from (select 1 from public.documents d
                 where d.is_statute and d.tsv @@ v_q_and and (v_type is null or d.document_type_id = v_type)
                 limit 5) s;
      else
        select count(*) into v_hits
          from (select 1 from public.precedent_passages pp
                 where pp.tsv @@ v_q_and and (v_type is null or pp.document_type_id = v_type) limit 5) s;
      end if;
    end if;
    if v_hits < 5 and cardinality(v_terms) > 0 then
      v_fallback := true;
      v_df := null;
      if v_scope = 'precedent' then
        -- The statistics say how many paragraphs hold each word (library-
        -- wide, a document type filter aside): common at 5,000 or more.
        -- Counted only when the table has no statistics yet.
        v_common := 5000;
        v_df := public.precedent_lexeme_df(v_terms);
      else
        v_common := case when v_scope = 'project' then greatest(10, ceil(cardinality(v_ids) * 0.5)::integer)
                         when v_acts is null then 500 else 100 end;
      end if;
      if v_df is null then
        v_df := '{}';
        foreach t in array v_terms loop
          if v_scope = 'precedent' then
            select count(*) into v_cnt
              from (select 1 from public.precedent_passages pp
                     where pp.tsv @@ ('''' || t || '''')::tsquery and (v_type is null or pp.document_type_id = v_type) limit v_common) s;
          elsif v_scope = 'statute' and v_acts is null then
            select count(*) into v_cnt
              from (select 1 from public.documents d
                     where d.is_statute and d.tsv @@ ('''' || t || '''')::tsquery
                     limit v_common) s;
          else
            select count(*) into v_cnt
              from (select 1 from public.documents d where d.id = any(v_ids) and d.tsv @@ ('''' || t || '''')::tsquery limit v_common) s;
          end if;
          v_df := v_df || v_cnt::real;
        end loop;
      end if;
      -- The uncommon words, in the phrasing's order (every word when all are common).
      v_or := array(select u.w from unnest(v_terms, v_df) with ordinality u(w, df, n)
                     where u.df is null or u.df < v_common order by u.n);
      if cardinality(v_or) = 0 then v_or := v_terms; end if;
      v_q := array_to_string(array(select '''' || w || '''' from unnest(v_or) w), ' | ')::tsquery;
      if v_scope = 'project' then
        v_q_req := v_q;
      else
        -- The rarest three of them: uncounted (rarer than any the
        -- statistics list) first, then by count. A word no passage holds
        -- cannot be one: counted 0, or uncounted and not found by one
        -- index probe (a misspelling would otherwise take a place).
        v_req := '{}';
        foreach t in array array(select u.w from unnest(v_terms, v_df) with ordinality u(w, df, n)
                                  where (u.df is null or u.df < v_common) and u.df is distinct from 0
                                  order by (u.df is null) desc, u.df, u.n) loop
          exit when cardinality(v_req) >= 3;
          if v_df[array_position(v_terms, t)] is null then
            if v_scope = 'precedent' then
              perform 1 from public.precedent_passages pp
                where pp.tsv @@ ('''' || t || '''')::tsquery and (v_type is null or pp.document_type_id = v_type) limit 1;
            elsif v_acts is null then
              perform 1 from public.documents d where d.is_statute and d.tsv @@ ('''' || t || '''')::tsquery limit 1;
            else
              perform 1 from public.documents d where d.id = any(v_ids) and d.tsv @@ ('''' || t || '''')::tsquery limit 1;
            end if;
            if not found then continue; end if;
          end if;
          v_req := v_req || t;
        end loop;
        if cardinality(v_req) = 0 then v_req := v_or; end if;
        v_q_req := array_to_string(array(select '''' || w || '''' from unnest(v_req) w), ' | ')::tsquery;
      end if;
    else
      v_q := v_q_and;
      v_q_req := v_q_and;
    end if;

    -- ------------------------------------------------------------- project
    if v_scope = 'project' then
      -- Meaning: exact distances over the project's rows (+ 0 keeps the
      -- HNSW index out: a project is a few hundred rows, and an approximate
      -- scan filtered down to one project can miss its nearest passages).
      select coalesce(jsonb_agg(jsonb_build_object('p', v_p, 'leg', 'v', 'id', x.id, 'r', x.r)), '[]') into v_leg
        from (select y.id, (row_number() over (order by y.dist, y.id))::integer as r
                from (select d.id, d.embedding <=> v_emb as dist
                        from public.documents d
                       where v_emb is not null and d.id = any(v_ids) and d.embedding is not null
                       order by (d.embedding <=> v_emb) + 0
                       limit v_k) y) x;
      v_hit := v_hit || v_leg;
      -- Words.
      select coalesce(jsonb_agg(jsonb_build_object('p', v_p, 'leg', 'k', 'id', x.id, 'r', x.r)), '[]') into v_leg
        from (select c.id, (row_number() over (order by c.score desc, c.id))::integer as r
                from (select c0.id,
                             (case when v_fallback then (select count(*) from unnest(v_tq) q where c0.tsv @@ q) else 0 end)
                               + ts_rank_cd(c0.tsv, v_q, 32) as score
                        from (select d.id, d.tsv from public.documents d
                               where v_q is not null and d.id = any(v_ids) and d.tsv @@ v_q_req
                               order by ts_rank(d.tsv, v_q) desc
                               limit greatest(v_k * 8, 300)) c0
                       order by 2 desc, 1
                       limit v_k) c) x;
      v_hit := v_hit || v_leg;
      -- Names, for the question: files whose title or file name holds a
      -- third of its words, or one word that names at most two files.
      if v_p = 1 and cardinality(v_terms) > 0 then
        with named as materialized (
          select d.id, coalesce(d.matter_document_id::text, d.metadata->>'storage_path', d.id::text) as f,
                 array(select w from unnest(v_terms) w where nt.v @@ ('''' || w || '''')::tsquery) as hit_terms,
                 d.embedding
            from public.documents d
            left join public.matter_documents md on md.id = d.matter_document_id
            cross join lateral (select to_tsvector('english', regexp_replace(coalesce(md.title, '') || ' ' || coalesce(d.metadata->>'filename', ''), '[^[:alnum:]]+', ' ', 'g')) as v) nt
           where d.id = any(v_ids)
        ),
        name_df as materialized (
          select w, count(distinct n.f) as files from named n, unnest(n.hit_terms) w group by w
        )
        select coalesce(jsonb_agg(jsonb_build_object('p', 1, 'leg', 'n', 'id', x.id, 'r', x.r)), '[]') into v_leg
          from (select y.id, (row_number() over (order by y.hits desc, y.dist, y.id))::integer as r
                  from (select distinct on (n.f) n.id, cardinality(n.hit_terms) as hits,
                               case when v_emb is null or n.embedding is null then 2 else n.embedding <=> v_emb end as dist
                          from named n
                         where cardinality(n.hit_terms) >= v_name_min
                            or exists (select 1 from name_df x where x.w = any(n.hit_terms) and x.files <= 2 and length(x.w) >= 3)
                         order by n.f, 3, n.id) y
                 order by y.hits desc, y.dist
                 limit v_k) x;
        v_hit := v_hit || v_leg;
      end if;

    -- ----------------------------------------------------------- precedent
    elsif v_scope = 'precedent' then
      -- Rows found by meaning (this phrasing) and, for the question, by file
      -- name — one row a file, its row closest to the question — each
      -- represented by its paragraph that holds most of the phrasing's
      -- words (its first, when none does).
      with recursive files as (
        (select d.metadata->>'storage_path' as f, d.metadata->>'filename' as fn
           from public.documents d
          where v_p = 1 and cardinality(v_terms) > 0 and d.is_precedent and d.metadata->>'storage_path' is not null
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
      named as materialized (
        select fl.f, fl.row_id,
               array(select w from unnest(v_terms) w where nt.v @@ ('''' || w || '''')::tsquery) as hit_terms
          from (select files.f, null::uuid as row_id, files.fn from files
                union all
                select d.id::text, d.id, d.metadata->>'filename'
                  from public.documents d
                 where v_p = 1 and cardinality(v_terms) > 0 and d.is_precedent and d.metadata->>'storage_path' is null
                   and (v_type is null or d.document_type_id = v_type)) fl
          cross join lateral (select to_tsvector('english', regexp_replace(coalesce(fl.fn, ''), '[^[:alnum:]]+', ' ', 'g')) as v) nt
      ),
      name_df as materialized (
        select w, count(*) as files from named n, unnest(n.hit_terms) w group by w
      ),
      name_hit as (
        select n.f, n.row_id, cardinality(n.hit_terms) as hits
          from named n
         where cardinality(n.hit_terms) >= v_name_min
            or exists (select 1 from name_df x where x.w = any(n.hit_terms) and x.files <= 2 and length(x.w) >= 3)
      ),
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
      vec_rows as (
        select x.id as doc, (row_number() over (order by x.dist, x.id))::integer as r
          from (select d.id, d.embedding <=> v_emb as dist
                  from public.documents d
                 where v_emb is not null and d.is_precedent and d.embedding is not null
                   and (v_type is null or d.document_type_id = v_type)
                 order by d.embedding <=> v_emb
                 limit v_k) x
      )
      select coalesce(jsonb_agg(jsonb_build_object('p', v_p, 'leg', h.leg, 'id', coalesce(pg.pid, f.pid), 'r', h.r)), '[]') into v_leg
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
           limit 1) pg on true
        left join lateral (
          select pp.id as pid from public.precedent_passages pp where pp.document_id = h.doc order by pp.ordinal limit 1) f on true
       where coalesce(pg.pid, f.pid) is not null;
      v_hit := v_hit || v_leg;
      -- Words, over the paragraphs.
      select coalesce(jsonb_agg(jsonb_build_object('p', v_p, 'leg', 'k', 'id', x.pid, 'r', x.r)), '[]') into v_leg
        from (select c.pid, (row_number() over (order by c.score desc, c.pid))::integer as r
                from (select c0.pid,
                             (case when v_fallback then (select count(*) from unnest(v_tq) q where c0.tsv @@ q) else 0 end)
                               + ts_rank_cd(c0.tsv, v_q, 32) as score
                        from (select pp.id as pid, pp.tsv from public.precedent_passages pp
                               where v_q is not null and pp.tsv @@ v_q_req and (v_type is null or pp.document_type_id = v_type)
                               order by ts_rank(pp.tsv, v_q) desc
                               limit greatest(v_k * 8, 300)) c0
                       order by 2 desc, 1
                       limit v_k) c) x;
      v_hit := v_hit || v_leg;

    -- ------------------------------------------------------------- statute
    else
      -- Meaning: the library's HNSW index, or exact distances over the named
      -- Acts' rows (a filtered HNSW scan cannot find 40 rows of one Act among
      -- the nearest neighbours and walked the whole index).
      select coalesce(jsonb_agg(jsonb_build_object('p', v_p, 'leg', 'v', 'id', x.id, 'r', x.r)), '[]') into v_leg
        from (select y.id, (row_number() over (order by y.dist, y.id))::integer as r
                from (select d.id, d.embedding <=> v_emb as dist
                        from public.documents d
                       where v_emb is not null and v_acts is null and d.is_statute and d.embedding is not null
                         and (v_type is null or d.document_type_id = v_type)
                       order by d.embedding <=> v_emb
                       limit v_k) y
               union all
               select y.id, (row_number() over (order by y.dist, y.id))::integer as r
                from (select d.id, d.embedding <=> v_emb as dist
                        from public.documents d
                       where v_emb is not null and v_acts is not null and d.id = any(v_ids) and d.embedding is not null
                         and (v_type is null or d.document_type_id = v_type)
                       order by (d.embedding <=> v_emb) + 0
                       limit v_k) y) x;
      v_hit := v_hit || v_leg;
      -- Words.
      select coalesce(jsonb_agg(jsonb_build_object('p', v_p, 'leg', 'k', 'id', x.id, 'r', x.r)), '[]') into v_leg
        from (select c.id, (row_number() over (order by c.score desc, c.id))::integer as r
                from (select c0.id,
                             (case when v_fallback then (select count(*) from unnest(v_tq) q where c0.tsv @@ q) else 0 end)
                               + ts_rank_cd(c0.tsv, v_q, 32) as score
                        from (select u.id, u.tsv
                                from (select d.id, d.tsv from public.documents d
                                       where v_q is not null and v_acts is null and d.is_statute and d.tsv @@ v_q_req
                                         and (v_type is null or d.document_type_id = v_type)
                                      union all
                                      select d.id, d.tsv from public.documents d
                                       where v_q is not null and v_acts is not null and d.id = any(v_ids) and d.tsv @@ v_q_req
                                         and (v_type is null or d.document_type_id = v_type)) u
                               order by ts_rank(u.tsv, v_q) desc
                               limit greatest(v_k * 8, 300)) c0
                       order by 2 desc, 1
                       limit v_k) c) x;
      v_hit := v_hit || v_leg;
    end if;
  end loop;

  -- ------------------------------------------------- fusion
  -- A passage's score under one phrasing: 1/(60 + rank) over the legs that
  -- found it there (the name leg, run for the question, counts for every
  -- phrasing). Its fused score: the best of those; ties to the one more
  -- phrasings found; at most three passages a file.
  if v_scope = 'precedent' then
    return query
    with h as (
      select x.p, x.leg, x.id as pid, x.r from jsonb_to_recordset(v_hit) as x(p integer, leg text, id bigint, r integer)
    ),
    per as (
      select h.p, h.pid, min(h.r) filter (where h.leg = 'v') as vr, min(h.r) filter (where h.leg = 'k') as kr
        from h where h.leg in ('v', 'k') group by h.p, h.pid
    ),
    nm as (select h.pid, min(h.r) as nr from h where h.leg = 'n' group by h.pid),
    scored as (
      select coalesce(per.pid, nm.pid) as pid, per.vr, per.kr, nm.nr,
             coalesce(1.0 / (60 + per.vr), 0) + coalesce(1.0 / (60 + per.kr), 0) + coalesce(1.0 / (60 + nm.nr), 0) as rrf
        from per full join nm on nm.pid = per.pid
    ),
    fused as (
      select s.pid, max(s.rrf) as rrf, sum(s.rrf) as rrf_sum, min(s.vr) as vr, min(s.kr) as kr, min(s.nr) as nr
        from scored s group by s.pid
    ),
    ranked as (
      select f.pid, f.vr, f.kr, f.nr, f.rrf, f.rrf_sum,
             row_number() over (partition by coalesce(pp.storage_path, pp.document_id::text) order by f.rrf desc, f.rrf_sum desc, f.pid) as n
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
     order by r.rrf desc, r.rrf_sum desc, pp.id
     limit v_k;
    return;
  end if;

  return query
  with h as (
    select x.p, x.leg, x.id, x.r from jsonb_to_recordset(v_hit) as x(p integer, leg text, id uuid, r integer)
  ),
  per as (
    select h.p, h.id, min(h.r) filter (where h.leg = 'v') as vr, min(h.r) filter (where h.leg = 'k') as kr
      from h where h.leg in ('v', 'k') group by h.p, h.id
  ),
  nm as (select h.id, min(h.r) as nr from h where h.leg = 'n' group by h.id),
  scored as (
    select coalesce(per.id, nm.id) as id, per.vr, per.kr, nm.nr,
           coalesce(1.0 / (60 + per.vr), 0) + coalesce(1.0 / (60 + per.kr), 0) + coalesce(1.0 / (60 + nm.nr), 0) as rrf
      from per full join nm on nm.id = per.id
  ),
  fused as (
    select s.id, max(s.rrf) as rrf, sum(s.rrf) as rrf_sum, min(s.vr) as vr, min(s.kr) as kr, min(s.nr) as nr
      from scored s group by s.id
  ),
  ranked as (
    select f.id, f.vr, f.kr, f.nr, f.rrf, f.rrf_sum,
           row_number() over (partition by case when v_scope = 'project'
                                                then coalesce(d.document_version_id::text, d.metadata->>'storage_path', d.id::text)
                                                else coalesce(d.metadata->>'act_name', d.metadata->>'storage_path', d.id::text) end
                              order by f.rrf desc, f.rrf_sum desc, f.id) as n
      from fused f join public.documents d on d.id = f.id
  )
  select d.id, d.content,
         case when v_scope = 'project'
              then coalesce(d.metadata, '{}'::jsonb) || jsonb_build_object('document_title', md.title, 'version_file_name', dv.file_name)
              else coalesce(d.metadata, '{}'::jsonb) end,
         d.heading_path, d.page,
         case when v_scope = 'project' then coalesce(d.document_version_id, dv.id) else d.document_version_id end,
         case when v_scope = 'project' then coalesce(d.matter_document_id, dv.matter_document_id) else d.matter_document_id end,
         case when v_scope = 'project' then coalesce(d.version_number, dv.version_number) else d.version_number end,
         r.vr, r.kr, r.rrf::double precision, r.nr
    from ranked r
    join public.documents d on d.id = r.id
    left join public.document_versions dv
      on v_scope = 'project'
     and (dv.id = d.document_version_id
          or (d.document_version_id is null and dv.storage_path = d.metadata->>'storage_path'))
    left join public.matter_documents md on v_scope = 'project' and md.id = coalesce(d.matter_document_id, dv.matter_document_id)
   where (v_scope = 'statute' and v_acts is not null) or r.n <= 3
   order by r.rrf desc, r.rrf_sum desc, d.id
   limit v_k;
end;
$fn$;

comment on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer, jsonb, integer) is
  'Hybrid passage search for one scope (project | precedent | statute) in one call: the question and up to three phrasings (phrasings: [{text, embedding}]), each with vector + keyword legs (+ the question''s file-name leg), fused by reciprocal rank (best phrasing, ties by sum), current versions only unless all_versions, at most 3 passages a file. max_ms: stops between legs once over it (57014). Called by chat-service/retrieve.js. See 20261019090000_search_passages_one_call.sql.';

revoke all on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer, jsonb, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer, jsonb, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer, jsonb, integer) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.search_passages(text, vector, text, uuid, text[], uuid, boolean, uuid, integer, jsonb, integer) to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The hard bound: PostgREST's pre-request function.
--
-- PostgREST runs the function named by the authenticator role's
-- pgrst.db_pre_request setting as a statement of its own, after the role and
-- its settings are applied and before the request's query, in the same
-- transaction. A `set local statement_timeout` there bounds the query that
-- follows — which a SET inside the query's own function cannot (see the top
-- of this file). This one reads the request's X-Statement-Timeout-Ms header
-- (digits; 1,000 ms at least) and sets the local statement_timeout to it,
-- never above the role's own (30 s for service_role, 8 s for authenticated),
-- so a caller can only ask for less time, never more. Without the header it
-- does nothing; a malformed header is ignored. It runs for every request of
-- the API, so it is small and never raises.
--
-- The setting is made below only when the authenticator role has no
-- pgrst.db_pre_request yet (an existing one is not replaced), and PostgREST
-- is told to reload. If the role cannot be altered from here (a notice says
-- so), run as the project owner:
--   alter role authenticator set pgrst.db_pre_request = 'public.pgrst_pre_request';
--   notify pgrst, 'reload config';

create or replace function public.pgrst_pre_request()
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_asked bigint;
  v_role_ms bigint;
begin
  begin
    v_asked := nullif(left(regexp_replace(coalesce(current_setting('request.headers', true)::json->>'x-statement-timeout-ms', ''), '[^0-9]', '', 'g'), 9), '')::bigint;
  exception when others then
    v_asked := null;
  end;
  if v_asked is null then
    return;
  end if;
  select s.setting::bigint into v_role_ms from pg_catalog.pg_settings s where s.name = 'statement_timeout';
  v_asked := greatest(v_asked, 1000);
  if coalesce(v_role_ms, 0) > 0 then
    v_asked := least(v_asked, v_role_ms);
  end if;
  perform set_config('statement_timeout', v_asked::text, true);
end;
$$;

comment on function public.pgrst_pre_request() is
  'PostgREST pre-request: sets the transaction''s statement_timeout from the X-Statement-Timeout-Ms request header (at least 1000, never above the role''s own), so an RPC the client stops waiting for is cancelled in the database too. See 20261019090000_search_passages_one_call.sql.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.pgrst_pre_request() to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.pgrst_pre_request() to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.pgrst_pre_request() to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant execute on function public.pgrst_pre_request() to authenticator;
  end if;
end $$;

do $$
declare
  v_current text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role here (not a PostgREST database): pgrst.db_pre_request not set.';
    return;
  end if;
  select c.setting into v_current
    from pg_roles r, unnest(coalesce(r.rolconfig, '{}'::text[])) as c(setting)
   where r.rolname = 'authenticator' and c.setting like 'pgrst.db_pre_request=%'
   limit 1;
  if v_current is not null then
    if v_current = 'pgrst.db_pre_request=public.pgrst_pre_request' then
      raise notice 'authenticator already runs public.pgrst_pre_request before each request.';
    else
      raise notice 'authenticator already has a pre-request function (%); left as it is. To use the statement timeout header, have it call public.pgrst_pre_request().', v_current;
    end if;
    return;
  end if;
  begin
    execute 'alter role authenticator set pgrst.db_pre_request = ''public.pgrst_pre_request''';
    raise notice 'authenticator now runs public.pgrst_pre_request before each request (PostgREST told to reload its config).';
  exception when others then
    raise notice 'Could not set pgrst.db_pre_request on authenticator (%). Run as the project owner: alter role authenticator set pgrst.db_pre_request = ''public.pgrst_pre_request''; notify pgrst, ''reload config'';', sqlerrm;
  end;
end $$;

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
