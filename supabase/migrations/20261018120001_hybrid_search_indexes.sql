-- Partial indexes for the hybrid search's precedent and statute legs,
-- 18 Oct 2026 (workstream C2).
--
-- RUN THIS FILE ON ITS OWN, ONE STATEMENT AT A TIME, NOT IN A TRANSACTION.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and a
-- tool that sends the whole file at once (supabase db push, the SQL editor
-- with several statements, the management API's query endpoint) wraps it
-- in one. Send each statement separately, or run the file with
--   psql "$DATABASE_URL" -f supabase/migrations/20261018120001_hybrid_search_indexes.sql
-- (psql sends statements one by one and does not open a transaction).
-- CONCURRENTLY builds each index without blocking reads or writes on
-- public.documents; the worker keeps indexing while it runs.
--
-- Apply after 20261018120000_hybrid_search_speed.sql. The function works
-- without these indexes and uses them when they exist; nothing else needs
-- deploying.
--
-- The two HNSW builds take the longest (3,579 and 2,297 rows of 1,024
-- numbers; a minute or more each on this database). The postgres role's
-- statement_timeout is 2 minutes: in psql run
--   set statement_timeout = 0;
-- first (same session). A build cut off by the timeout leaves an INVALID
-- index behind: drop index concurrently if exists <name>; and run it again.
-- Every statement is "if not exists", so the file is safe to re-run.
--
-- What each index is for (measured 18 Oct, EXPLAIN ANALYZE on live data):
--
--   documents_precedent_embedding_idx, documents_statute_embedding_idx:
--     the vector legs search one library's index. With the one shared
--     index a statute search for a question whose nearest rows are
--     precedents threw 3,674 rows away (12,100 buffers, 0.3 to 6.5 s), and
--     a precedent search half of what it read.
--   documents_statute_tsv_idx: the statute keyword leg and its word counts
--     read statute rows only; on the shared index 1,726 of 2,288 rows read
--     for one question were precedent or project rows.
--   documents_statute_act_idx, documents_statute_amends_act_idx: the rows
--     of the named Acts, by index (a scan of the table otherwise, 60 ms).
--   documents_precedent_path_idx: the precedent name leg's one probe a
--     file, and its "rows with no storage path" check, read precedent rows
--     only (the shared storage path index holds 2,176 statute rows with
--     none, 5 ms to 1.5 s).
--
-- Reversal: drop index concurrently if exists <name>; for each.

create index concurrently if not exists documents_precedent_path_idx
  on public.documents ((metadata->>'storage_path'))
  where is_precedent;

create index concurrently if not exists documents_statute_act_idx
  on public.documents ((metadata->>'act_name'))
  where is_statute;

create index concurrently if not exists documents_statute_amends_act_idx
  on public.documents ((metadata->>'amends_act'))
  where is_statute;

create index concurrently if not exists documents_statute_tsv_idx
  on public.documents using gin (tsv)
  where is_statute;

create index concurrently if not exists documents_statute_embedding_idx
  on public.documents using hnsw (embedding vector_cosine_ops)
  where is_statute;

create index concurrently if not exists documents_precedent_embedding_idx
  on public.documents using hnsw (embedding vector_cosine_ops)
  where is_precedent;
