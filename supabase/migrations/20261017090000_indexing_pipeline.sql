-- Indexing pipeline, 17 Oct 2026.
--
-- Reading a project file for search moves off the browser's upload click and
-- onto a worker on the Oracle VM (chat-service/indexWorker.js). Until now the
-- process-document edge function did it inside the upload request: 150 s of
-- wall clock, OCR only when a whole PDF had under 20 characters, 1,000-word
-- windows that ignored paragraphs, clauses and pages, no link from a passage
-- to its version, no retry and no record of why a file failed. Seven large
-- scanned PDFs were never read at all.
--
-- What this adds:
--   * public.document_index_jobs: one row per file to read. A new project
--     file version is queued automatically (trigger below). Library files
--     (precedents, statutes) use the same table later, with kind 'precedent'
--     or 'statute' and no version id.
--   * document_versions: when reading started and finished, how many
--     attempts, the reason in plain words when it failed, the page count and
--     the per-version summary card the worker writes.
--   * documents (the passage table): which version a passage belongs to, the
--     reading run that wrote it, where it sits (heading path, page, character
--     offsets), a hash of its text and a full-text vector. All nullable, so
--     the 7,000-odd existing rows stay valid; existing project rows are linked
--     to their version by storage path.
--   * enqueue_index_job(version)   - firm members: "Try again" / re-read.
--     claim_index_job(worker)      - service role: the worker takes one job.
--     touch_index_job(job, run)    - service role: a long job keeps its lock.
--     publish_index_run(job, run)  - service role: swap old passages for new
--                                    in one transaction, mark the version read.
--     fail_index_job(job, error)   - service role: retry later with backoff,
--                                    or give up after three attempts with the
--                                    reason shown on the project page.
--     release_index_job(job, run)  - service role: the worker is stopping
--                                    (a deploy); put the job back untouched.
--
-- Safe to run more than once ("if not exists", "create or replace", policies
-- and triggers dropped by name first).
--
-- Not done here: re-reading the versions saved before this runs. Once the
-- worker is up, queue them all at background priority (new uploads still go
-- first) with:
--   insert into public.document_index_jobs (document_version_id, bucket, storage_path, kind, priority)
--   select id, 'matter-documents', storage_path, 'project', -1 from public.document_versions
--    where public.index_supported_extension(storage_path)
--   on conflict (document_version_id) do nothing;
-- Their passages are replaced version by version as each finishes; until
-- then the old passages stay searchable.
--
-- Cost of running it: adding the stored tsv column rewrites the documents
-- table once (about 300 MB, roughly a minute measured against 16 Oct data:
-- computing the vectors alone took 36 s). Search on the AI Workspace waits
-- for that lock, so run it at a quiet time. lock_timeout below makes it give
-- up rather than queue behind a long query; just run it again.
--
-- Reversal (in this order):
--   drop trigger if exists document_versions_enqueue_index on public.document_versions;
--   drop function if exists public.enqueue_index_job_on_version();
--   drop function if exists public.enqueue_index_job(uuid);
--   drop function if exists public.claim_index_job(text);
--   drop function if exists public.touch_index_job(uuid, uuid);
--   drop function if exists public.publish_index_run(uuid, uuid, integer, jsonb);
--   drop function if exists public.fail_index_job(uuid, text, boolean, uuid);
--   drop function if exists public.release_index_job(uuid, uuid);
--   drop function if exists public.index_supported_extension(text);
--   drop table if exists public.document_index_jobs;
--   alter table public.documents drop column if exists tsv, drop column if exists text_hash,
--     drop column if exists char_end, drop column if exists char_start, drop column if exists page,
--     drop column if exists heading_path, drop column if exists is_ai_generated,
--     drop column if exists ingest_run_id, drop column if exists version_number,
--     drop column if exists matter_document_id, drop column if exists document_version_id;
--   drop index if exists public.documents_storage_path_idx;
--   alter table public.document_versions drop column if exists page_count, drop column if exists card,
--     drop column if exists indexing_attempts, drop column if exists indexing_error,
--     drop column if exists indexing_finished_at, drop column if exists indexing_started_at;
-- Passages written by the worker stay valid rows after the reversal (they are
-- ordinary documents rows with metadata.storage_path set).

set lock_timeout = '10s';

-- ------------------------------------------------------------------ versions
alter table public.document_versions
  add column if not exists indexing_started_at timestamptz,
  add column if not exists indexing_finished_at timestamptz,
  add column if not exists indexing_error text,
  add column if not exists indexing_attempts integer not null default 0,
  add column if not exists card jsonb,
  add column if not exists page_count integer;

comment on column public.document_versions.indexing_error is
  'Why the reader could not read this version, as a sentence a lawyer can act on. Set only when retries are exhausted.';
comment on column public.document_versions.card is
  'Per-version summary written by the index worker: summary, document_kind, parties, key_dates, defined_terms, clause_outline, has_tracked_changes, suggested_document_type_id (a suggestion only; never applied to the document).';

-- ----------------------------------------------------------------- passages
-- One statement, so the table is rewritten once (for the stored tsv).
alter table public.documents
  add column if not exists document_version_id uuid references public.document_versions(id) on delete cascade,
  add column if not exists matter_document_id uuid,
  add column if not exists version_number integer,
  add column if not exists ingest_run_id uuid,
  add column if not exists is_ai_generated boolean,
  add column if not exists heading_path text,
  add column if not exists page integer,
  add column if not exists char_start integer,
  add column if not exists char_end integer,
  add column if not exists text_hash text,
  add column if not exists tsv tsvector generated always as (to_tsvector('english', coalesce(heading_path, '') || ' ' || content)) stored;

create index if not exists documents_tsv_idx on public.documents using gin (tsv);
create index if not exists documents_document_version_id_idx on public.documents (document_version_id);
create index if not exists documents_ingest_run_id_idx on public.documents (ingest_run_id);
-- Every replace/delete of a file's passages keys on the storage path; this
-- was a sequential scan (355 ms on 14 Oct).
create index if not exists documents_storage_path_idx on public.documents ((metadata->>'storage_path'));

-- Link existing project passages to their version by storage path.
update public.documents d
   set document_version_id = v.id,
       matter_document_id = v.matter_document_id,
       version_number = v.version_number,
       is_ai_generated = v.is_ai_generated
  from public.document_versions v
 where d.document_version_id is null
   and d.matter_id is not null
   and d.metadata->>'storage_path' = v.storage_path;

-- --------------------------------------------------------------------- jobs
create table if not exists public.document_index_jobs (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid references public.document_versions(id) on delete cascade,
  bucket text not null,
  storage_path text not null,
  kind text not null default 'project' check (kind in ('project', 'precedent', 'statute')),
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  -- Higher first. Uploads and Try again are 0; a bulk re-read (backfill)
  -- uses -1 so it never holds up a file someone has just added.
  priority integer not null default 0,
  last_error text,
  run_id uuid,
  worker text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- running: the worker's lock expires at this time. queued: not before
  -- this time (the retry backoff).
  locked_until timestamptz
);
comment on table public.document_index_jobs is
  'Files waiting to be read for search, being read, read, or given up on. Written only by the functions in 20261017090000_indexing_pipeline.sql or the service role.';

-- One job row per version (a retry resets it); one live job per library file.
create unique index if not exists document_index_jobs_version_key on public.document_index_jobs (document_version_id);
create unique index if not exists document_index_jobs_library_key on public.document_index_jobs (bucket, storage_path) where document_version_id is null;
alter table public.document_index_jobs add column if not exists priority integer not null default 0;
create index if not exists document_index_jobs_claim_idx on public.document_index_jobs (state, priority desc, attempts, created_at) where state in ('queued', 'running');

alter table public.document_index_jobs enable row level security;
drop policy if exists "Firm members can view index jobs" on public.document_index_jobs;
create policy "Firm members can view index jobs" on public.document_index_jobs
  for select using (public.is_firm_member(auth.uid()));
revoke insert, update, delete, truncate on public.document_index_jobs from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.document_index_jobs from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke insert, update, delete, truncate on public.document_index_jobs from authenticated;
    grant select on public.document_index_jobs to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.document_index_jobs to service_role;
  end if;
end $$;

-- The file types the reader understands (chat-service/indexing/extract.js).
create or replace function public.index_supported_extension(p_path text)
returns boolean language sql immutable set search_path = public as $$
  select lower(coalesce(substring(p_path from '\.([A-Za-z0-9]+)$'), '')) in ('pdf', 'docx', 'xlsx', 'xls', 'pptx', 'txt', 'md', 'csv');
$$;

-- ------------------------------------------------------------------ enqueue
create or replace function public.enqueue_index_job_on_version()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.index_supported_extension(new.storage_path) then
    insert into public.document_index_jobs (document_version_id, bucket, storage_path, kind)
    values (new.id, 'matter-documents', new.storage_path, 'project')
    on conflict (document_version_id) do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists document_versions_enqueue_index on public.document_versions;
create trigger document_versions_enqueue_index
  after insert on public.document_versions
  for each row execute function public.enqueue_index_job_on_version();

-- "Try again", or a re-read after the reader improves. A queued or running
-- job is left alone; a failed or finished one starts over.
create or replace function public.enqueue_index_job(p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_path text; j public.document_index_jobs;
begin
  -- Only authenticated and service_role can execute this; a signed-in caller
  -- must be an approved firm member (every member can see every project).
  if auth.uid() is not null and not public.is_firm_member(auth.uid()) then
    raise exception 'Forbidden';
  end if;
  select storage_path into v_path from public.document_versions where id = p_version_id;
  if v_path is null then raise exception 'Document version is unavailable'; end if;
  if not public.index_supported_extension(v_path) then
    update public.document_versions set indexing_status = 'unsupported' where id = p_version_id;
    return jsonb_build_object('state', 'unsupported');
  end if;
  insert into public.document_index_jobs as dj (document_version_id, bucket, storage_path, kind)
  values (p_version_id, 'matter-documents', v_path, 'project')
  on conflict (document_version_id) do update
    set state = 'queued', attempts = 0, last_error = null, run_id = null, worker = null,
        started_at = null, finished_at = null, locked_until = null, created_at = now(), priority = 0,
        storage_path = excluded.storage_path
    where dj.state in ('failed', 'done')
  returning * into j;
  if j.id is null then
    select * into j from public.document_index_jobs where document_version_id = p_version_id;
  else
    update public.document_versions
       set indexing_status = 'pending', indexing_error = null, indexing_attempts = 0,
           indexing_started_at = null, indexing_finished_at = null
     where id = p_version_id;
  end if;
  return jsonb_build_object('jobId', j.id, 'state', j.state);
end;
$$;

-- -------------------------------------------------------------------- claim
-- Takes the next due job: queued ones whose backoff has passed (higher
-- priority first, then fresh files before retries, then oldest), or a running
-- one whose worker stopped renewing its lock.
create or replace function public.claim_index_job(p_worker text)
returns setof public.document_index_jobs language plpgsql security definer set search_path = public as $$
declare j public.document_index_jobs; v_reason text := 'Reading this file kept stopping part-way. It may be too large or damaged; try saving it again as a PDF or Word file.';
begin
  -- A worker that died on a job's last allowed attempt: give up on it.
  for j in
    select * from public.document_index_jobs
     where state = 'running' and locked_until < now() and attempts >= 3
     for update skip locked
  loop
    delete from public.documents where ingest_run_id = j.run_id;
    update public.document_index_jobs
       set state = 'failed', finished_at = now(), locked_until = null, last_error = coalesce(last_error, v_reason)
     where id = j.id;
    update public.document_versions
       set indexing_status = 'failed', indexing_error = coalesce(j.last_error, v_reason), indexing_finished_at = now()
     where id = j.document_version_id;
  end loop;

  select * into j from public.document_index_jobs
   where (state = 'queued' and (locked_until is null or locked_until <= now()))
      or (state = 'running' and locked_until < now())
   order by priority desc, attempts, created_at
   limit 1
   for update skip locked;
  if not found then return; end if;

  -- Passages half-written by a run that never finished.
  if j.run_id is not null then
    delete from public.documents where ingest_run_id = j.run_id;
  end if;

  update public.document_index_jobs
     set state = 'running', attempts = attempts + 1, started_at = now(), finished_at = null,
         locked_until = now() + interval '20 minutes', run_id = gen_random_uuid(), worker = p_worker
   where id = j.id
  returning * into j;

  if j.document_version_id is not null then
    update public.document_versions
       set indexing_status = 'pending', indexing_started_at = now(), indexing_finished_at = null,
           indexing_attempts = j.attempts
     where id = j.document_version_id;
  end if;
  return next j;
end;
$$;

-- A long job (a scanned PDF is ~12 s a page on the VM) keeps its lock.
create or replace function public.touch_index_job(p_job_id uuid, p_run_id uuid)
returns boolean language sql security definer set search_path = public as $$
  update public.document_index_jobs set locked_until = now() + interval '20 minutes'
   where id = p_job_id and run_id = p_run_id and state = 'running'
  returning true;
$$;

-- ------------------------------------------------------------------ publish
-- The run's passages are already inserted under p_run_id. In one transaction:
-- remove every other passage of this version (older runs, and the rows the
-- old edge-function path wrote under the same storage path), mark the job
-- done and the version searchable.
create or replace function public.publish_index_run(p_job_id uuid, p_run_id uuid, p_page_count integer default null, p_card jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.document_index_jobs; v_new integer; v_removed integer := 0; v_more integer;
begin
  select * into j from public.document_index_jobs where id = p_job_id for update;
  if not found or j.run_id is distinct from p_run_id or j.state <> 'running' then
    raise exception 'This reading run is no longer current';
  end if;
  select count(*) into v_new from public.documents where ingest_run_id = p_run_id;
  if v_new = 0 then raise exception 'No passages were written for this run'; end if;

  if j.document_version_id is not null then
    delete from public.documents
     where document_version_id = j.document_version_id and ingest_run_id is distinct from p_run_id;
    get diagnostics v_removed = row_count;
    delete from public.documents
     where document_version_id is null and matter_id is not null
       and metadata->>'storage_path' = j.storage_path;
    get diagnostics v_more = row_count;
    v_removed := v_removed + v_more;
  else
    delete from public.documents
     where metadata->>'storage_path' = j.storage_path
       and coalesce(metadata->>'storage_bucket', j.bucket) = j.bucket
       and ingest_run_id is distinct from p_run_id;
    get diagnostics v_removed = row_count;
  end if;

  update public.document_index_jobs
     set state = 'done', finished_at = now(), locked_until = null, last_error = null
   where id = j.id;
  if j.document_version_id is not null then
    update public.document_versions
       set indexing_status = 'indexed', indexing_finished_at = now(), indexing_error = null,
           indexing_attempts = j.attempts,
           page_count = coalesce(p_page_count, page_count),
           card = coalesce(p_card, card)
     where id = j.document_version_id;
  end if;
  return jsonb_build_object('passages', v_new, 'removed', v_removed);
end;
$$;

-- --------------------------------------------------------------------- fail
-- p_error is a plain sentence. With p_retry the job is queued again after
-- 2^attempts minutes (2, 4) and the version stays 'pending'; on the third
-- attempt, or without p_retry, it fails and the version shows the reason.
create or replace function public.fail_index_job(p_job_id uuid, p_error text, p_retry boolean default true, p_run_id uuid default null)
returns text language plpgsql security definer set search_path = public as $$
declare j public.document_index_jobs; v_error text := left(coalesce(nullif(btrim(p_error), ''), 'The file could not be read.'), 500);
begin
  select * into j from public.document_index_jobs where id = p_job_id for update;
  if not found then return 'gone'; end if;
  if p_run_id is not null and j.run_id is distinct from p_run_id then return 'stale'; end if;
  if j.run_id is not null then
    delete from public.documents where ingest_run_id = j.run_id;
  end if;
  if p_retry and j.attempts < 3 then
    update public.document_index_jobs
       set state = 'queued', last_error = v_error, finished_at = null,
           locked_until = now() + make_interval(mins => power(2, greatest(j.attempts, 1))::integer)
     where id = j.id;
    update public.document_versions
       set indexing_status = 'pending', indexing_attempts = j.attempts
     where id = j.document_version_id;
    return 'queued';
  end if;
  update public.document_index_jobs
     set state = 'failed', last_error = v_error, finished_at = now(), locked_until = null
   where id = j.id;
  update public.document_versions
     set indexing_status = 'failed', indexing_error = v_error, indexing_finished_at = now(),
         indexing_attempts = j.attempts
   where id = j.document_version_id;
  return 'failed';
end;
$$;

-- A worker stopping for a deploy hands its job back: queued again at once,
-- the attempt not counted, its half-written passages removed.
create or replace function public.release_index_job(p_job_id uuid, p_run_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare j public.document_index_jobs;
begin
  select * into j from public.document_index_jobs where id = p_job_id for update;
  if not found or j.run_id is distinct from p_run_id or j.state <> 'running' then return false; end if;
  delete from public.documents where ingest_run_id = p_run_id;
  update public.document_index_jobs
     set state = 'queued', attempts = greatest(attempts - 1, 0), locked_until = null, run_id = null, worker = null
   where id = j.id;
  update public.document_versions set indexing_attempts = greatest(j.attempts - 1, 0) where id = j.document_version_id;
  return true;
end;
$$;

-- -------------------------------------------------------------------- grants
revoke all on function public.enqueue_index_job(uuid) from public;
revoke all on function public.claim_index_job(text) from public;
revoke all on function public.touch_index_job(uuid, uuid) from public;
revoke all on function public.publish_index_run(uuid, uuid, integer, jsonb) from public;
revoke all on function public.fail_index_job(uuid, text, boolean, uuid) from public;
revoke all on function public.release_index_job(uuid, uuid) from public;
revoke all on function public.enqueue_index_job_on_version() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.enqueue_index_job(uuid) from anon;
    revoke all on function public.claim_index_job(text) from anon;
    revoke all on function public.touch_index_job(uuid, uuid) from anon;
    revoke all on function public.publish_index_run(uuid, uuid, integer, jsonb) from anon;
    revoke all on function public.fail_index_job(uuid, text, boolean, uuid) from anon;
    revoke all on function public.release_index_job(uuid, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.enqueue_index_job(uuid) to authenticated;
    revoke all on function public.claim_index_job(text) from authenticated;
    revoke all on function public.touch_index_job(uuid, uuid) from authenticated;
    revoke all on function public.publish_index_run(uuid, uuid, integer, jsonb) from authenticated;
    revoke all on function public.fail_index_job(uuid, text, boolean, uuid) from authenticated;
    revoke all on function public.release_index_job(uuid, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_index_job(uuid) to service_role;
    grant execute on function public.claim_index_job(text) to service_role;
    grant execute on function public.touch_index_job(uuid, uuid) to service_role;
    grant execute on function public.publish_index_run(uuid, uuid, integer, jsonb) to service_role;
    grant execute on function public.fail_index_job(uuid, text, boolean, uuid) to service_role;
    grant execute on function public.release_index_job(uuid, uuid) to service_role;
  end if;
end $$;

reset lock_timeout;
