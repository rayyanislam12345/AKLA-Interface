-- Search index cleanup (RAG audit finding 2). NOT a migration. Run by hand in
-- the Supabase SQL editor, as one script.
--
-- What it removes from public.documents (the AI's search passages):
--   (i)  surplus copies of firm-library (precedent) passages. The same file was
--        indexed two to four times (repeat clicks / retries), so a search hands
--        back the same clause several times. One row is kept per
--        (storage_path, chunk_index): the copy from that file's most complete
--        indexing run, newest first. The stored files themselves are untouched.
--   (ii) project passages whose file is no longer any version of any project
--        document (deleted documents and versions), which the AI can still
--        quote today. Rows without a storage_path and rows under an hour old
--        are never touched.
-- Deleting a passage also removes, by cascade, its rows in
-- public.precedent_passages ("Find a clause") and public.document_search_chunks
-- (project search), which are derived from it.
--
-- HOW TO USE: approved by Rayyan on 16 Oct 2026; this copy COMMITS. Paste the whole file into the Supabase SQL editor and run it once.
-- inside the transaction, reports what is left, and then ROLLS BACK, so
-- nothing changes. Read the counts. If they match what you expect, change the
-- last line from ROLLBACK to COMMIT and run it again.

begin;

-- ---------------------------------------------------------------- counts first

-- (i) surplus precedent copies
with ranked as (
  select d.id,
         row_number() over (
           partition by d.metadata->>'storage_path', d.metadata->>'chunk_index'
           order by run.rows_in_run desc, d.created_at desc, d.id
         ) as rn
    from public.documents d
    join (
      select metadata->>'storage_path' as storage_path, metadata->>'upload_date' as upload_date, count(*) as rows_in_run
        from public.documents
       where is_precedent
       group by 1, 2
    ) run on run.storage_path = d.metadata->>'storage_path'
         and run.upload_date is not distinct from d.metadata->>'upload_date'
   where d.is_precedent
     and d.metadata->>'storage_path' is not null
     and d.metadata->>'chunk_index' is not null
)
select 'i. surplus precedent copies' as step,
       count(*) as passages_to_delete,
       count(distinct d.metadata->>'storage_path') as files_affected,
       (select count(*) from public.precedent_passages pp where pp.document_id in (select id from ranked where rn > 1)) as find_a_clause_rows_cascading,
       pg_size_pretty(sum(length(d.content))::bigint) as text_removed
  from ranked r join public.documents d on d.id = r.id
 where r.rn > 1;

-- (ii) project passages for files that no longer belong to any version
select 'ii. orphan project passages' as step,
       count(*) as passages_to_delete,
       count(distinct d.metadata->>'storage_path') as files_affected,
       (select count(*) from public.document_search_chunks c where c.source_document_id in (
          select d2.id from public.documents d2
           where d2.matter_id is not null
             and not coalesce(d2.is_precedent, false)
             and not coalesce(d2.is_statute, false)
             and d2.metadata->>'storage_path' is not null
             and d2.created_at < now() - interval '1 hour'
             and not exists (select 1 from public.document_versions v where v.storage_path = d2.metadata->>'storage_path')
       )) as project_search_rows_cascading
  from public.documents d
 where d.matter_id is not null
   and not coalesce(d.is_precedent, false)
   and not coalesce(d.is_statute, false)
   and d.metadata->>'storage_path' is not null
   and d.created_at < now() - interval '1 hour'
   and not exists (select 1 from public.document_versions v where v.storage_path = d.metadata->>'storage_path');

-- ---------------------------------------------------------------- the deletes

-- (i)
with ranked as (
  select d.id,
         row_number() over (
           partition by d.metadata->>'storage_path', d.metadata->>'chunk_index'
           order by run.rows_in_run desc, d.created_at desc, d.id
         ) as rn
    from public.documents d
    join (
      select metadata->>'storage_path' as storage_path, metadata->>'upload_date' as upload_date, count(*) as rows_in_run
        from public.documents
       where is_precedent
       group by 1, 2
    ) run on run.storage_path = d.metadata->>'storage_path'
         and run.upload_date is not distinct from d.metadata->>'upload_date'
   where d.is_precedent
     and d.metadata->>'storage_path' is not null
     and d.metadata->>'chunk_index' is not null
)
delete from public.documents d
 using ranked r
 where d.id = r.id and r.rn > 1;

-- (ii)
delete from public.documents d
 where d.matter_id is not null
   and not coalesce(d.is_precedent, false)
   and not coalesce(d.is_statute, false)
   and d.metadata->>'storage_path' is not null
   and d.created_at < now() - interval '1 hour'
   and not exists (select 1 from public.document_versions v where v.storage_path = d.metadata->>'storage_path');

-- ---------------------------------------------------------------- what is left

select 'after' as step,
       (select count(*) from (
          select 1 from public.documents where is_precedent
           group by metadata->>'storage_path', metadata->>'chunk_index' having count(*) > 1) x) as precedent_positions_still_duplicated,
       (select count(*) from public.documents where is_precedent) as precedent_passages_left,
       (select count(distinct metadata->>'storage_path') from public.documents where is_precedent) as precedent_files_left,
       (select count(*) from public.documents d
         where d.matter_id is not null and not coalesce(d.is_precedent, false) and not coalesce(d.is_statute, false)
           and not exists (select 1 from public.document_versions v where v.storage_path = d.metadata->>'storage_path')) as orphan_project_passages_left;

-- Approved 16 Oct 2026 after reading the counts (993 duplicates, 70 orphans): commits.
commit;
