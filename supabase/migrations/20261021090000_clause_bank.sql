-- Clause bank (docs/drafting-fidelity-plan-2026-10-19.md, "How it will work:
-- the wording" item 2, Appendix E and Appendix H item 3).
--
-- When the AI writes a clause it is shown the firm's own two or three
-- versions of it, found by the clause's heading, not by similarity search,
-- so a lookup costs no Voyage call (chat-service/clauseBank.js
-- clauseExamples, and the connector tool get_clause_examples).
--
-- Every precedent paragraph (public.precedent_passages, one row per
-- paragraph of a precedent's stored text) gains:
--   heading       the heading it sits under: the nearest clause or section
--                 heading above it in the precedent ("Governing Law"), read
--                 from the paragraphs themselves and, for the first
--                 paragraphs of a stored piece, from the piece's heading path
--                 (documents.heading_path, written by the index reader);
--   heading_norm  that heading normalised: label and numbers removed, lower
--                 case, "&" read as "and", punctuation dropped, simple
--                 plurals singular ("ARTICLE 14 – GOVERNING LAWS" →
--                 "governing law"); public.clause_heading_norm, kept step
--                 for step with clauseBank.js headingNorm;
--   clause_no     the number of that heading ("14.2", "Article 14",
--                 "Schedule B"), when it has one;
--   family        the style-sheet family of the precedent's document type
--                 (chat-service/styleSheets/; the types are those of
--                 scripts/drafting-packs/pack-types.json, plus Concept Note
--                 with the memo pack, the Concession Agreement and the RFP).
-- and an index on (document_type_id, heading_norm) for the lookup.
--
-- The trigger that makes the passages (index_precedent_passages, from
-- 20260921090000_precedent_passages.sql) is replaced so new precedents get
-- the four columns as they are stored; the passages themselves (ordinal and
-- body) are cut exactly as before, by public.precedent_paragraphs, so
-- nothing else changes. Existing passages are filled in place below.
--
-- What finds headings: precedents stored with paragraph breaks (the index
-- reader's text, as scripts/drafting-packs/upload_precedents.mjs stores
-- them). Precedents stored by the site's upload before that (the
-- ingest-documents edge function joins a file's words with single spaces,
-- so there are no paragraphs) mostly get no heading; the clause bank's last
-- step (a paragraph whose words name the clause) still reaches them.
--
-- How many passages each pack type has (read-only; run before and after):
--   select dt.name, public.clause_bank_family(dt.name) as family,
--          count(pp.id) as passages, count(distinct pp.storage_path) as files,
--          count(pp.heading_norm) as with_heading,
--          count(distinct pp.heading_norm) as distinct_headings
--     from public.document_types dt
--     left join public.precedent_passages pp on pp.document_type_id = dt.id
--    where public.clause_bank_family(dt.name) is not null
--    group by dt.name order by family, dt.name;
-- (Before this migration, replace public.clause_bank_family(dt.name) with
-- the list of type names in that function and drop the heading counts.)
--
-- Safe to run more than once. The backfill rewrites every precedent
-- passage once; run it at a quiet time. lock_timeout makes it give up
-- rather than queue behind a long search; just run it again.
--
-- Reversal:
--   create or replace function public.index_precedent_passages() … (the body
--     in 20260921090000_precedent_passages.sql);
--   drop index if exists public.precedent_passages_type_heading_idx;
--   alter table public.precedent_passages drop column if exists family,
--     drop column if exists heading, drop column if exists heading_norm,
--     drop column if exists clause_no;
--   drop function if exists public.precedent_passage_headings(text, text);
--   drop function if exists public.clause_title_of(text);
--   drop function if exists public.clause_label(text);
--   drop function if exists public.clause_bank_family_of(uuid);
--   drop function if exists public.clause_bank_family(text);
--   drop function if exists public.clause_heading_norm(text);

set lock_timeout = '10s';

alter table public.precedent_passages
  add column if not exists family text,
  add column if not exists heading text,
  add column if not exists heading_norm text,
  add column if not exists clause_no text;

comment on column public.precedent_passages.heading is 'The heading this paragraph sits under in its precedent (clause bank; 20261021090000_clause_bank.sql).';
comment on column public.precedent_passages.heading_norm is 'The heading normalised by public.clause_heading_norm (clauseBank.js headingNorm): what the clause bank matches on.';
comment on column public.precedent_passages.clause_no is 'The number of the heading this paragraph sits under ("14.2", "Article 14", "Schedule B"), when it has one.';
comment on column public.precedent_passages.family is 'The style-sheet family of the precedent''s document type (public.clause_bank_family; chat-service/styleSheets/).';

create index if not exists precedent_passages_type_heading_idx on public.precedent_passages (document_type_id, heading_norm);

-- ------------------------------------------------------------- normalising
-- Same steps, same order, as clauseBank.js headingNorm.
create or replace function public.clause_heading_norm(p_heading text)
returns text language sql immutable parallel safe set search_path = public as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 btrim(regexp_replace(
                   regexp_replace(
                     replace(
                       lower(regexp_replace(coalesce(p_heading, ''),
                         '^\s*(?:ARTICLE|Article|article|SECTION|Section|section|CLAUSE|Clause|clause|PART|Part|part|CHAPTER|Chapter|chapter|SCHEDULE|Schedule|schedule|ANNEXURE|Annexure|annexure|ANNEX|Annex|annex|APPENDIX|Appendix|appendix|EXHIBIT|Exhibit|exhibit)\s+(?:\d+[A-Za-z]?(?:\.\d+)*|[IVXLC]+|[A-Z]{1,2}(?=\s*(?:[-–—:.]|$)))(?![A-Za-z0-9])',
                         '')),
                       '&', ' and '),
                     '^\s*\(?[a-z0-9]{1,4}\)\s*', ''),
                   '[^a-z]+', ' ', 'g')),
                 '^the ', ''),
               '\m([a-z]{2,})ies\M', '\1y', 'g'),
             '\m([a-z]{2,}[^sui ])s\M', '\1', 'g'),
           '\s+', ' ', 'g')), '');
$$;

-- ---------------------------------------------------------------- families
-- Document type name → style-sheet family (chat-service/styleSheets/index.js
-- TYPE_STYLE_SHEETS; the test checks the two lists agree).
create or replace function public.clause_bank_family(p_type_name text)
returns text language sql immutable parallel safe set search_path = public as $$
  select case lower(btrim(translate(coalesce(p_type_name, ''), '’‘', '''''')))
    when 'letter / notice' then 'letters'
    when 'research memo' then 'memo'
    when 'concept note' then 'memo'
    when 'legal opinion' then 'opinion'
    when 'client proposal letter' then 'proposal'
    when 'meeting minutes' then 'minutes'
    when 'certificate / consent / noc' then 'consent'
    when 'board resolution' then 'board-resolution'
    when 'amendment agreement' then 'amendment'
    when 'escrow agreement' then 'escrow'
    when 'independent engineer''s agreement' then 'ie-agreement'
    when 'independent auditors'' agreement' then 'ia-agreement'
    when 'framework agreement' then 'framework'
    when 'concession agreement' then 'concession-agreement'
    else case when p_type_name ~* '\m(rfp|request for proposals?)\M' then 'rfp' end
  end;
$$;

create or replace function public.clause_bank_family_of(p_type_id uuid)
returns text language sql stable set search_path = public as $$
  select public.clause_bank_family(name) from public.document_types where id = p_type_id;
$$;

-- ------------------------------------------------------- the passage cutter
-- public.precedent_paragraphs is NOT replaced here. The live function (a
-- later migration than 20260921090000) cuts a paragraph over 2,400
-- characters by grouping whole sentences into pieces of about 2,000
-- characters, and works; precedent_passage_headings below counts a long
-- paragraph's pieces the same way, so headings land on the right ordinal.

-- ---------------------------------------------------------------- headings
-- The label at the start of a paragraph or heading-path entry, with its
-- depth (Schedule/Part 0, "14." 1, "14.2" 2, Article 14 1, a limb "(a)" 9)
-- and the words after it. As indexing/chunk.js parseLabel, simplified: a
-- single number needs its full stop ("14." not "30 days").
create or replace function public.clause_label(p_text text, out label text, out depth integer, out rest text)
language plpgsql immutable set search_path = public as $$
declare
  m text[];
begin
  m := regexp_match(p_text, '^(SCHEDULE|Schedule|ANNEXURE|Annexure|ANNEX|Annex|APPENDIX|Appendix|EXHIBIT|Exhibit|PART|Part|CHAPTER|Chapter)(?:\s+|\s*[-–—]\s*)([A-Z]{1,3}|[IVXLC]{1,7}|\d{1,3}[A-Z]?)(?![A-Za-z0-9.])\s*[-–—:.]?\s*(.*)$');
  if m is not null then
    label := initcap(m[1]) || ' ' || m[2]; depth := 0; rest := coalesce(m[3], ''); return;
  end if;
  m := regexp_match(p_text, '^(ARTICLE|Article|SECTION|Section|CLAUSE|Clause)\s+(\d{1,3}[A-Z]?(?:\.\d{1,3}){0,4}|[IVXLC]{1,7})(?![A-Za-z0-9])\.?\s*[-–—:.]?\s*(.*)$');
  if m is not null then
    label := initcap(m[1]) || ' ' || m[2];
    depth := coalesce(array_length(string_to_array(m[2], '.'), 1), 1);
    rest := coalesce(m[3], ''); return;
  end if;
  m := regexp_match(p_text, '^(\d{1,3})\.(?:\s+(.*))?$');
  if m is not null then
    label := m[1]; depth := 1; rest := coalesce(m[2], ''); return;
  end if;
  m := regexp_match(p_text, '^(\d{1,3}(?:\.\d{1,3}){1,4})\.?(?:\s+(.*))?$');
  if m is not null then
    label := m[1]; depth := array_length(string_to_array(m[1], '.'), 1); rest := coalesce(m[2], ''); return;
  end if;
  m := regexp_match(p_text, '^\(([a-z]{1,4}|[ivxlc]{1,6}|\d{1,2}|[A-Z])\)\s*(.*)$');
  if m is not null then
    label := '(' || m[1] || ')'; depth := 9; rest := coalesce(m[2], ''); return;
  end if;
  label := null; depth := null; rest := coalesce(p_text, '');
end;
$$;

-- The heading in the words after a label: the whole of them when they read
-- as a title ("Governing Law"), or a run-in heading ("Governing Law. This
-- Agreement shall …"); null when they are a clause's text.
create or replace function public.clause_title_of(p_rest text, out title text, out run_in boolean)
language plpgsql immutable set search_path = public as $$
declare
  t text := btrim(coalesce(p_rest, ''));
  m text[];
  verbs constant text := '\m(shall|will|may|must|is|are|was|were|has|have|hereby|means|mean)\M';
begin
  run_in := false;
  title := null;
  if t = '' then return; end if;
  if length(t) <= 100 and t !~ '[.;:,]$' and t ~ '^[A-Z“"‘]'
     and array_length(regexp_split_to_array(t, '\s+'), 1) <= 12 and t !~* verbs then
    title := btrim(regexp_replace(t, '\s*[-–—]+$', ''));
    return;
  end if;
  m := regexp_match(t, '^([A-Z][^.:;]{1,70}?)[.:]\s+\S');
  if m is not null and array_length(regexp_split_to_array(m[1], '\s+'), 1) <= 8 and m[1] !~* verbs
     and m[1] !~ '(^|\s)(?!(of|and|or|the|to|for|in|on|by|with|from|under|upon|a|an|at|its|their|any|all)(\s|$))[a-z]' then
    title := btrim(m[1]);
    run_in := true;
  end if;
end;
$$;

-- Each passage of a precedent's stored text (the ordinals of
-- public.precedent_paragraphs, which this walks in the same way) with the
-- heading it sits under and that heading's number. Short paragraphs, which
-- are not passages, still count as headings. p_heading_path is the stored
-- piece's heading path ("14. Termination › 14.2 Termination for
-- convenience"), the headings above its first paragraph.
create or replace function public.precedent_passage_headings(p_content text, p_heading_path text default null)
returns table(ordinal integer, heading text, clause_no text)
language plpgsql immutable set search_path = public as $$
declare
  st_depth integer[] := '{}';
  st_title text[] := '{}';
  st_label text[] := '{}';
  n integer := 0;
  para record;
  lab record;
  tit record;
  entry text;
  e_index integer := 0;
  pending_label text := null;
  pending_depth integer := null;
  handled boolean;
  ord integer := 0;
  cnt integer;
  i integer;
  cur_title text;
  cur_label text;
  b text;
begin
  -- The headings above the piece's first paragraph.
  if p_heading_path is not null and btrim(p_heading_path) <> '' then
    foreach entry in array string_to_array(p_heading_path, ' › ') loop
      e_index := e_index + 1;
      entry := btrim(split_part(entry, ' – ', 1));
      if entry = '' then continue; end if;
      select * into lab from public.clause_label(entry);
      if lab.label is not null and lab.depth < 9 then
        select * into tit from public.clause_title_of(lab.rest);
        while n > 0 and st_depth[n] >= lab.depth loop n := n - 1; end loop;
        n := n + 1;
        st_depth[n] := lab.depth; st_title[n] := coalesce(tit.title, nullif(btrim(lab.rest), '')); st_label[n] := lab.label;
      elsif lab.label is null then
        while n > 0 and st_depth[n] >= e_index loop n := n - 1; end loop;
        n := n + 1;
        st_depth[n] := e_index; st_title[n] := entry; st_label[n] := null;
      end if;
    end loop;
  end if;

  for para in
    select t.pos as k, btrim(regexp_replace(
             replace(replace(replace(replace(replace(
               regexp_replace(t.part, '<[^>]*>', ' ', 'g'),
               '&amp;', '&'), '&quot;', '"'), '&#39;', ''''), '&nbsp;', ' '), '&lt;', '<'),
             '\s+', ' ', 'g')) as body
    from regexp_split_to_table(
           regexp_replace(coalesce(p_content, ''), '<img[^>]*>', '', 'gi'),
           '</(?:p|li|h[1-6]|tr|td|div)>|<br\s*/?>|\n+', 'i') with ordinality as t(part, pos)
    order by t.pos
  loop
    b := para.body;
    if b is null or b = '' then continue; end if;
    handled := false;
    select * into lab from public.clause_label(b);

    -- "ARTICLE 14" on its own line, then "TERMINATION": the title line.
    if pending_label is not null then
      if lab.label is null and length(b) <= 100 then
        select * into tit from public.clause_title_of(b);
        if tit.title is not null and not tit.run_in then
          st_title[n] := tit.title;
          handled := true;
        end if;
      end if;
      pending_label := null;
      pending_depth := null;
    end if;

    if not handled then
      if lab.label is not null and lab.depth < 9 then
        while n > 0 and st_depth[n] >= lab.depth loop n := n - 1; end loop;
        n := n + 1;
        st_depth[n] := lab.depth; st_label[n] := lab.label; st_title[n] := null;
        if btrim(lab.rest) = '' then
          pending_label := lab.label;
          pending_depth := lab.depth;
        else
          select * into tit from public.clause_title_of(lab.rest);
          st_title[n] := tit.title;
        end if;
      elsif lab.label is null and length(b) <= 120 and b !~ '[\[●•:]' and b !~ '[.;:,]$' then
        if b !~ '[a-z]' and b ~ '[A-Z].*[A-Z].*[A-Z]' and array_length(regexp_split_to_array(b, '\s+'), 1) <= 14 then
          -- DEFINITIONS AND INTERPRETATION
          while n > 0 and st_depth[n] >= 1 loop n := n - 1; end loop;
          n := n + 1;
          st_depth[n] := 1; st_title[n] := b; st_label[n] := null;
        elsif length(b) <= 80 and b ~ '^[A-Z]' and array_length(regexp_split_to_array(b, '\s+'), 1) <= 10
              and b !~* '\m(shall|will|may|must|is|are|was|were|has|have|hereby|means|mean)\M'
              and b !~ '(^|\s)(?!(of|and|or|the|to|for|in|on|by|with|from|under|upon|a|an|at|its|their|any|all)(\s|$))[a-z]' then
          -- Brief Answer (a styled heading with no number)
          while n > 0 and st_depth[n] >= 2 loop n := n - 1; end loop;
          n := n + 1;
          st_depth[n] := 2; st_title[n] := b; st_label[n] := null;
        end if;
      end if;
    end if;

    if length(b) < 40 then continue; end if;
    cur_title := null;
    cur_label := null;
    for i in reverse n..1 loop
      if st_title[i] is not null then
        cur_title := st_title[i];
        cur_label := st_label[i];
        exit;
      end if;
    end loop;
    if length(b) <= 2400 then
      cnt := 1;
    else
      -- the live cutter's pieces: sentences grouped by running length / 2000
      select count(*) into cnt from (
        select string_agg(sentence, ' ' order by k) as piece
          from (
            select k, sentence, sum(length(sentence) + 1) over (order by k) as upto
              from (
                select row_number() over () as k, sentence
                  from regexp_split_to_table(regexp_replace(b, '([.;:])\s+', '\1' || chr(1), 'g'), chr(1)) as sentence
              ) s0
          ) s1
         group by ((upto - 1) / 2000)::bigint
      ) g
       where length(btrim(piece)) >= 40;
    end if;
    for i in 1..cnt loop
      ord := ord + 1;
      ordinal := ord;
      heading := left(cur_title, 200);
      clause_no := cur_label;
      return next;
    end loop;
  end loop;
end;
$$;

-- ------------------------------------------------------------- the trigger
-- As 20260921090000_precedent_passages.sql, plus the four columns.
create or replace function public.index_precedent_passages()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    delete from precedent_passages where document_id = new.id;
  end if;
  if new.is_precedent then
    insert into precedent_passages(document_id, storage_path, filename, document_type_id, chunk_index, ordinal, body, family, heading, heading_norm, clause_no)
    select new.id, new.metadata->>'storage_path', new.metadata->>'filename', new.document_type_id,
           nullif(new.metadata->>'chunk_index', '')::integer, p.ordinal, p.body,
           public.clause_bank_family_of(new.document_type_id),
           h.heading, public.clause_heading_norm(h.heading), h.clause_no
    from precedent_paragraphs(new.content) p
    left join precedent_passage_headings(new.content, coalesce(new.heading_path, new.metadata->>'heading_path')) h
      on h.ordinal = p.ordinal;
  end if;
  return new;
end;
$$;

-- The backfill of existing passages is 20261021090001_clause_bank_backfill.sql,
-- run in batches (one statement over 53,000 rows exceeds the API's time limit).
