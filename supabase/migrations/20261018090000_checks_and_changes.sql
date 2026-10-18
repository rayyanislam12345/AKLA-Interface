-- Checks and changes, 18 Oct 2026.
--
-- When the index worker (chat-service/indexWorker.js) reads a project file
-- version, it now also proof-checks it (chat-service/proofCheck.js: blanks
-- and placeholders, terms used but not defined, definitions never used,
-- cross-references to clauses or schedules that do not exist, numbers whose
-- words and figures disagree, gaps in clause numbering) and compares it with
-- the version saved before it (chat-service/versionCompare.js: what changed,
-- clause by clause, with the nature of each change). The project page's
-- preview shows both as tabs beside the document.
--
-- What this adds:
--   * document_versions.proof_check              jsonb  the check's result, or
--                                                       { error } / { skipped }
--   * document_versions.changes_from_previous    jsonb  the comparison, or
--                                                       { error } / { skipped }
--   * document_versions.compared_with_version_id uuid   the version compared with
--                                                       (null for a first version)
--   * record_version_checks(version, run, proof_check, changes, compared_with)
--       service role only: the worker writes the three columns after
--       publish_index_run. A run that is no longer the version's latest
--       reading writes nothing (returns false).
--
-- Reading the columns needs nothing new: firm members can already see
-- document_versions. Until this is applied the worker logs "checks not saved"
-- once per file and carries on; the preview says "Not checked yet".
--
-- Apply after 20261017090000_indexing_pipeline.sql (record_version_checks
-- looks up document_index_jobs). Safe to run more than once.
--
-- To fill the columns for versions read before this was applied, read them
-- again, behind new uploads (the old passages stay searchable until each
-- re-read publishes; each costs one embedding pass and one card call):
--   select public.enqueue_index_job(v.id) from public.document_versions v
--     join public.document_index_jobs j on j.document_version_id = v.id
--    where j.state = 'done' and v.proof_check is null;
--   update public.document_index_jobs set priority = -1
--    where state = 'queued' and kind = 'project' and attempts = 0 and priority = 0
--      and document_version_id in (select id from public.document_versions where proof_check is null);
--
-- Reversal:
--   drop function if exists public.record_version_checks(uuid, uuid, jsonb, jsonb, uuid);
--   alter table public.document_versions drop column if exists compared_with_version_id,
--     drop column if exists changes_from_previous, drop column if exists proof_check;

set lock_timeout = '10s';

alter table public.document_versions
  add column if not exists proof_check jsonb,
  add column if not exists changes_from_previous jsonb,
  add column if not exists compared_with_version_id uuid references public.document_versions(id) on delete set null;

comment on column public.document_versions.proof_check is
  'Proof check written by the index worker (chat-service/proofCheck.js): { version, checked_at, counts, total, items[{ category, severity, where, text, note, find }], omitted, notes }, or { error } / { skipped } with a plain sentence.';
comment on column public.document_versions.changes_from_previous is
  'What changed since the previous version (chat-service/versionCompare.js): { version, compared_at, previous{ version_id, version_number, file_name }, counts, natures, shown, hidden, items[{ where, kind, nature, before, after, noise? }], omitted, notes, identical?, unrelated? }, or { error } / { skipped }.';
comment on column public.document_versions.compared_with_version_id is
  'The version changes_from_previous was compared with: the one saved just before this one.';

create or replace function public.record_version_checks(
  p_version_id uuid,
  p_run_id uuid,
  p_proof_check jsonb default null,
  p_changes jsonb default null,
  p_compared_with uuid default null
)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_run_id is not null and not exists (
    select 1 from public.document_index_jobs where document_version_id = p_version_id and run_id = p_run_id
  ) then
    return false; -- a newer reading of this version has started; it will write its own
  end if;
  update public.document_versions
     set proof_check = p_proof_check,
         changes_from_previous = p_changes,
         compared_with_version_id = case
           when p_compared_with is not null and exists (select 1 from public.document_versions where id = p_compared_with)
             then p_compared_with
           else null
         end
   where id = p_version_id;
  return found;
end;
$$;

revoke all on function public.record_version_checks(uuid, uuid, jsonb, jsonb, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.record_version_checks(uuid, uuid, jsonb, jsonb, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.record_version_checks(uuid, uuid, jsonb, jsonb, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.record_version_checks(uuid, uuid, jsonb, jsonb, uuid) to service_role;
  end if;
end $$;

reset lock_timeout;
