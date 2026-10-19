-- The safety precondition before the site simplification
-- (docs/site-simplification-2026-10-18.md, row 1): the database half.
--
-- Nothing here deletes, moves or rewrites a row. It closes the holes the
-- review found so that every later cut is safe, and it creates the bucket
-- the export script (scripts/export-before-cuts.mjs) writes to. Safe to run
-- twice: every policy is dropped before it is created, the bucket insert is
-- idempotent.
--
-- What it does
--   A. Library rows and files cannot be deleted from the site. RESTRICTIVE
--      policies deny DELETE on the Acts and precedents in public.documents
--      (is_statute / is_precedent), on the tables derived from them
--      (precedent_passages, law_library_versions), on ai_artifacts, and on
--      the 'law-library' and 'precedent-library' buckets. A RESTRICTIVE
--      policy is ANDed with the permissive ones, which stay exactly as they
--      are. It binds every role that is subject to row-level security; the
--      service_role key bypasses RLS, so the chat-service (server.js:64),
--      the law monitor (monitor.py) and the precedent backlog script are
--      untouched.
--   B. ai_skills: insert, update and delete only for admin-tier roles
--      (has_role(_, 'admin'), which already answers true for founders);
--      select stays with firm members.
--   C. A chat with no project and no document type (a "general" chat) is
--      seen, changed and deleted only by the person who started it and by
--      admins. Its messages and its files in ai-chat-files follow the same
--      rule. Project and standardisation chats are unchanged. This is the
--      rule src/hooks/useChat.ts (useChatThreads) applies on the client
--      today, moved into the database.
--   D. The private 'admin-exports' bucket: read by admins, written only
--      with the service_role key.
--
-- Names used here and the migration that defines each
--   public.documents.is_precedent      20260820061256_rag_store_and_redlines.sql
--   public.documents.is_statute        20260827120000_documents_is_statute.sql
--   public.precedent_passages          20260921090000_precedent_passages.sql
--   public.law_library_versions        20260913090000_law_monitor.sql
--   public.ai_artifacts, ai_skills     20260915090000_ai_chat_workspace.sql
--   public.ai_chat_threads, _messages  20260820061316_notes_tasks_chat_storage.sql
--   ai_chat_threads.document_type_id   20260920090000_standardisation_threads.sql
--   public.has_role(uuid, app_role)    20260916090001_founder_admin_permissions.sql
--   bucket law-library                 20260901090000_matter_relevant_laws.sql
--   bucket precedent-library           20260820061316_notes_tasks_chat_storage.sql
--   bucket ai-chat-files               20260915090000_ai_chat_workspace.sql
--
-- How a refused DELETE looks from the site: row-level security filters rows
-- rather than raising an error, so a delete the policies refuse reports
-- "0 rows" and succeeds. The library delete buttons
-- (src/hooks/useLawLibrary.ts useDeleteStatuteSource,
-- src/hooks/usePrecedentLibrary.ts useDeletePrecedentSource) will therefore
-- appear to work and change nothing until they are moved behind the
-- chat-service or given an admin exception, which is the owner's "who may
-- delete what" decision in the review.

-- A ----------------------------------------------------------------------
-- A1. public.documents holds the law library (is_statute), the precedent
-- library (is_precedent) and project text in one table. Today "Firm members
-- can manage documents" (FOR ALL, 20260820061256) lets any approved member
-- delete any Act or precedent. This permits a delete only when the row is
-- neither, so re-indexing a project file (process-document deletes the
-- previous project rows by matter_id) and the project-document hooks are
-- unaffected. Both columns are NOT NULL DEFAULT false.
drop policy if exists "Library rows are not deleted from the site" on public.documents;
create policy "Library rows are not deleted from the site" on public.documents
  as restrictive for delete
  using (not is_statute and not is_precedent or public.has_role(auth.uid(), 'admin'));

-- A2. public.precedent_passages has only a select policy for members
-- ("Firm members read precedent passages"), so no member can delete a
-- passage directly today; passages go only when their documents row goes
-- (ON DELETE CASCADE, which A1 now stops for the site). The restrictive
-- policy is added anyway so a later permissive policy cannot reopen it.
drop policy if exists "Precedent passages are not deleted from the site" on public.precedent_passages;
create policy "Precedent passages are not deleted from the site" on public.precedent_passages
  as restrictive for delete
  using (false);

-- A3. public.law_library_versions (the archived text of each Act the law
-- monitor replaced) also has only a select policy for members; same
-- reasoning as A2.
drop policy if exists "Archived law versions are not deleted from the site" on public.law_library_versions;
create policy "Archived law versions are not deleted from the site" on public.law_library_versions
  as restrictive for delete
  using (false);

-- A4. public.ai_artifacts: "Firm members can delete artifacts" lets any
-- member delete any draft, memo or review. Nothing in src/ deletes an
-- artifact row directly and the chat-service uses the service role, so no
-- site path changes. An artifact still goes with its thread or its project
-- (ON DELETE CASCADE on thread_id and matter_id); the cascade runs as the
-- table owner, outside RLS. Project Delete moving to admins is the other
-- half of row 1 and is not in this migration.
drop policy if exists "Artifacts are not deleted from the site" on public.ai_artifacts;
create policy "Artifacts are not deleted from the site" on public.ai_artifacts
  as restrictive for delete
  using (false);

-- A5. The two library buckets. The member delete policies on
-- 'law-library' (20260901090000) and 'precedent-library' (20260820061316)
-- stay; this denies the delete for both buckets whatever they say.
-- "Only admins remove standards" (20261016090000, restrictive) is also
-- still in force and is now redundant for deletes, which is harmless.
-- Side effects on the site: useDeletePrecedentSource's storage remove and
-- the clean-up removes after a failed precedent or standard upload
-- (usePrecedentLibrary.ts, useDocumentTypeTemplates.ts discardUpload)
-- become no-ops, so a failed upload leaves its file in the bucket.
drop policy if exists "Library files are not deleted from the site" on storage.objects;
create policy "Library files are not deleted from the site" on storage.objects
  as restrictive for delete
  using (bucket_id not in ('law-library', 'precedent-library') or public.has_role(auth.uid(), 'admin'));

-- B ----------------------------------------------------------------------
-- ai_skills. Before: any firm member could insert and update
-- (20260915090000), and an admin or the creator could delete
-- (20261016090000). After: admin-tier only for all three writes.
-- "Firm members can view skills" (select) is kept as it is.
-- The site's custom-skill form (useSaveCustomSkill / useDeleteCustomSkill
-- in src/hooks/useChat.ts) will refuse non-admins from here on: the insert
-- raises an RLS error, the update and delete report 0 rows. The review
-- counts 0 custom-prompt skills and removes the form in row 7.
-- /skills/upload and /skills/delete in chat-service/server.js write with
-- the service role and are not gated by this; the server-side admin check
-- on /skills/upload is the other half of this item, outside the database.
drop policy if exists "Firm members can create skills" on public.ai_skills;
drop policy if exists "Firm members can update skills" on public.ai_skills;
drop policy if exists "Firm members can delete skills" on public.ai_skills;
drop policy if exists "Admins or the creator can delete skills" on public.ai_skills;
drop policy if exists "Admins add skills" on public.ai_skills;
drop policy if exists "Admins change skills" on public.ai_skills;
drop policy if exists "Admins remove skills" on public.ai_skills;
create policy "Admins add skills" on public.ai_skills
  for insert with check (public.has_role(auth.uid(), 'admin'));
create policy "Admins change skills" on public.ai_skills
  for update
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));
create policy "Admins remove skills" on public.ai_skills
  for delete using (public.has_role(auth.uid(), 'admin'));

-- C ----------------------------------------------------------------------
-- C1. ai_chat_threads. A thread is "general" when matter_id and
-- document_type_id are both null (20261014120000 removed the constraint
-- that required one of them; useChat.ts lists general chats by created_by).
-- The four restrictive policies below let a general thread through only
-- for its author or an admin and let every other thread through
-- unconditionally, so the permissive member policies decide those as
-- before. The insert rule stops a member starting a general chat under
-- someone else's name; the site inserts created_by = the signed-in user
-- (useChat.ts) and the chat-service writes with the service role.
-- The existing delete policy "Admins or the author can delete chat
-- threads" (20261016090000) already says this for deletes; the restrictive
-- one makes it hold even if that policy is later widened.
drop policy if exists "General chats are seen by their author and admins" on public.ai_chat_threads;
create policy "General chats are seen by their author and admins" on public.ai_chat_threads
  as restrictive for select
  using (
    matter_id is not null
    or document_type_id is not null
    or created_by = auth.uid()
    or public.has_role(auth.uid(), 'admin')
  );

drop policy if exists "General chats are started by their author" on public.ai_chat_threads;
create policy "General chats are started by their author" on public.ai_chat_threads
  as restrictive for insert
  with check (
    matter_id is not null
    or document_type_id is not null
    or created_by = auth.uid()
    or public.has_role(auth.uid(), 'admin')
  );

drop policy if exists "General chats are changed by their author and admins" on public.ai_chat_threads;
create policy "General chats are changed by their author and admins" on public.ai_chat_threads
  as restrictive for update
  using (
    matter_id is not null
    or document_type_id is not null
    or created_by = auth.uid()
    or public.has_role(auth.uid(), 'admin')
  )
  with check (
    matter_id is not null
    or document_type_id is not null
    or created_by = auth.uid()
    or public.has_role(auth.uid(), 'admin')
  );

drop policy if exists "General chats are deleted by their author and admins" on public.ai_chat_threads;
create policy "General chats are deleted by their author and admins" on public.ai_chat_threads
  as restrictive for delete
  using (
    matter_id is not null
    or document_type_id is not null
    or created_by = auth.uid()
    or public.has_role(auth.uid(), 'admin')
  );

-- C2. ai_chat_messages. Its policies do not go through the thread (they
-- are plain is_firm_member checks), so without this any member who knew a
-- thread id could read a private chat's messages. One restrictive policy
-- for all four commands: a message is reachable only when its thread is.
-- The subquery runs under the caller's own thread policies, so it agrees
-- with C1 by construction. The touch-thread trigger is SECURITY DEFINER
-- and is unaffected.
drop policy if exists "Messages of a general chat follow the chat" on public.ai_chat_messages;
create policy "Messages of a general chat follow the chat" on public.ai_chat_messages
  as restrictive for all
  using (
    exists (
      select 1 from public.ai_chat_threads t
      where t.id = thread_id
        and (
          t.matter_id is not null
          or t.document_type_id is not null
          or t.created_by = auth.uid()
          or public.has_role(auth.uid(), 'admin')
        )
    )
  )
  with check (
    exists (
      select 1 from public.ai_chat_threads t
      where t.id = thread_id
        and (
          t.matter_id is not null
          or t.document_type_id is not null
          or t.created_by = auth.uid()
          or public.has_role(auth.uid(), 'admin')
        )
    )
  );

-- C3. Files attached to a general chat. uploadChatFile (useChat.ts) stores
-- them in ai-chat-files under 'general/<user id>/<timestamp>-<name>';
-- project files go under '<matter id>/' and standardisation files under
-- 'standards/<type id>/'. Only the 'general/' prefix is restricted, to its
-- owner and admins; the bucket's member policies decide the rest as before.
-- The chat-service reads attachments with the service role.
drop policy if exists "General chat files are seen by their author and admins" on storage.objects;
create policy "General chat files are seen by their author and admins" on storage.objects
  as restrictive for all
  using (
    bucket_id <> 'ai-chat-files'
    or name not like 'general/%'
    or name like ('general/' || auth.uid()::text || '/%')
    or public.has_role(auth.uid(), 'admin')
  )
  with check (
    bucket_id <> 'ai-chat-files'
    or name not like 'general/%'
    or name like ('general/' || auth.uid()::text || '/%')
    or public.has_role(auth.uid(), 'admin')
  );

-- D ----------------------------------------------------------------------
-- The bucket scripts/export-before-cuts.mjs writes to. Private; admins can
-- list and download; nobody but the service_role key can write, because
-- no insert, update or delete policy names the bucket and
-- "Library files are not deleted from the site" does not cover it.
insert into storage.buckets (id, name, public)
values ('admin-exports', 'admin-exports', false)
on conflict (id) do nothing;

drop policy if exists "Admins read exports" on storage.objects;
create policy "Admins read exports" on storage.objects
  for select using (bucket_id = 'admin-exports' and public.has_role(auth.uid(), 'admin'));
