-- Tracked changes on a stored version (slice 4 of
-- docs/connector-expansion-plan-2026-10-19.md): the claude.ai connector's
-- apply_tracked_changes files a client's draft, marked up by "AKLA AI", as
-- the next version of the same project document, and records one
-- redline_suggestions row per change anchored to that NEW version
-- (document_version_id set, artifact_id and thread_id null, review_type
-- 'edit', the Word revision ids it minted). The anchor check of
-- 20261015090000 (document_version_id or artifact_id) already admits such a
-- row, so redline_suggestions itself is unchanged.
--
-- What was missing is where a decision goes. In a chat, deciding a change
-- writes a new copy of the file as the working document's head
-- (ai_artifacts). A stored version is the firm's record and is never
-- rewritten, so the decided file is kept beside it: one row per version
-- naming the file in the matter-documents bucket that holds every decision
-- made so far (chat-service/versionChanges.js). The version's own file and
-- storage_path never change; the index, the comparisons and the hashes the
-- connector prints stay true. A later decision moves the row on, guarded by
-- the path it expects to replace (zero rows updated = someone else decided
-- first). make_clean_copy, the Hub's download and a further mark-up all
-- read the head when there is one.
--
-- The service role writes (chat-service, the connector); firm members may
-- read, so the site can show the decided file. Safe to run twice.
-- Reversal: drop table public.version_change_heads.

create table if not exists public.version_change_heads (
  document_version_id uuid primary key references public.document_versions(id) on delete cascade,
  storage_path        text not null unique,                 -- in matter-documents, under <matter>/<document>/<version>/
  file_name           text,
  updated_by          uuid references auth.users(id),
  updated_at          timestamptz not null default now()
);

alter table public.version_change_heads enable row level security;

drop policy if exists "Firm members can view version change heads" on public.version_change_heads;
create policy "Firm members can view version change heads" on public.version_change_heads
  for select using (public.is_firm_member(auth.uid()));

revoke all on table public.version_change_heads from public, anon, authenticated;
grant select on table public.version_change_heads to authenticated;
grant all on table public.version_change_heads to service_role;

-- The rows of one version's Changes list are read by version, without a
-- chat: the existing index on document_version_id serves it, narrowed here
-- to the rows that carry revision ids.
create index if not exists redline_suggestions_version_changes_idx
  on public.redline_suggestions(document_version_id, created_at)
  where artifact_id is null and review_type = 'edit';
