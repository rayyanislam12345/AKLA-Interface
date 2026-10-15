-- Quick wins, 16 Oct 2026. Five independent parts; every statement can be run
-- again safely (policies are dropped by name before they are created, columns
-- use "if not exists", the backfill only touches rows still 'unknown'/'pending').
--
-- (a) Indexing status backfill.
--     Project file versions still saying 'unknown' or 'pending' an hour after
--     upload become 'indexed' when search passages exist for their file
--     (documents.metadata->>'storage_path'), otherwise 'failed' -- 'failed' is
--     what the project page retries automatically, so the unread files repair
--     themselves the next time someone opens the project.
--     On 15 Oct 2026 this was 14 versions: 7 become 'indexed', 7 'failed'.
--     Reversal: update public.document_versions set indexing_status = 'unknown'
--       where id in ('da8bda08-cc95-4297-bdc8-548bacf4d7ac','b2ee2024-c1a5-4c4a-b601-b76862035b80',
--       '5fc19843-1dfc-4f50-8fbd-b6199f461dcf','4208ce37-0904-4260-abfe-76a91bfc5238',
--       '8f4de71f-23a8-4edc-b321-a36d7b7b740a','820e3bec-eeaf-47ab-ab00-7715a3a317d0',
--       'b98c733d-147e-4de6-a3a9-f12105fda3a7','e7cd536f-de80-4f36-845a-ea149e2c90d2',
--       'ef6eb285-8bc7-4e1f-8523-b34d6593eaff','2d8d01cd-d942-4237-a22b-47598bf5c741',
--       'c32ee55c-e01a-40b4-b11b-ebaf770ababc','b4a76fd0-c9ae-46a0-b706-30ffb9bcab11',
--       'df6fdf22-b639-4307-b819-c9e0837db8e9','731064d4-83ef-430d-a409-8f62e058e3d2');
--     (Only worth doing if the rows have not been re-indexed since.)
--
-- (b) The firm's drafting standards: only an administrator (has_role 'admin',
--     which founders also pass) may set, replace, restore or remove one.
--     Everyone in the firm can still read them.
--     Before: "Firm members can manage document type templates" (ALL, any member).
--     After:  three admin-only policies (insert / update / delete); the
--             existing member SELECT policy is untouched.
--     Storage: the standard files live in the precedent-library bucket under
--     standards/<type>/... and that bucket lets any member write anywhere.
--     Three RESTRICTIVE policies now require an admin for insert / update /
--     delete of objects under standards/ only; precedents elsewhere in the
--     bucket are unaffected. The snapshot trigger that keeps earlier standards
--     is SECURITY DEFINER and keeps working.
--     Reversal: drop the three "Admins ... document type templates" policies and
--       the three "Only admins ... standards" storage policies, then
--       create policy "Firm members can manage document type templates"
--         on public.document_type_templates for all
--         using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
--
-- (c) Firm skills: deleting one needs an administrator or the person who
--     created it. Before: "Firm members can delete skills" (any member).
--     Reversal: drop "Admins or the creator can delete skills", then
--       create policy "Firm members can delete skills" on public.ai_skills
--         for delete using (public.is_firm_member(auth.uid()));
--
-- (d) Project documents: deleting a document needs an administrator or the
--     person who created it (matter_documents.created_by; for a row without a
--     creator, whoever uploaded its first version). Adding and editing stay
--     open to every firm member. Deleting a single version needs an
--     administrator, the person who uploaded that version, or the document's
--     creator. (Deleting a whole document still removes all its versions:
--     the foreign key cascade is not subject to these policies.)
--     Before: matter_documents "Firm members can manage matter documents" (ALL);
--             document_versions "Firm members can delete document versions".
--     After:  matter_documents member INSERT and UPDATE policies plus
--             "Admins or the creator can delete matter documents";
--             document_versions "Admins, the uploader or the document's creator
--             can delete versions".
--     NOTE for the app: a refused delete is not an error in PostgREST, it just
--     removes nothing. The project page's delete (useMatterDocuments) removes
--     the stored files and search passages BEFORE deleting the row, so the
--     delete button must be limited to admins and the creator, and the row
--     deleted first (checking that a row came back), before this is applied.
--     Reversal: drop the four policies named in "After", then
--       create policy "Firm members can manage matter documents" on public.matter_documents
--         for all using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
--       create policy "Firm members can delete document versions" on public.document_versions
--         for delete using (public.is_firm_member(auth.uid()));
--
-- (e) Timeslips. Authors can already update and delete their own rows live
--     ("Authors and partners can update/delete timeslips"); the block below
--     only adds an author policy if no such policy exists (a fresh database
--     built from these migrations). The billable_hours / ak_billable_hours
--     columns exist live (numeric, nullable, no default) but in no migration;
--     they are recorded here so a rebuild matches. No-op on the live database.
--     Reversal: nothing to reverse live. On a fresh database, drop the two
--     "Authors can ... their own timeslips" policies if they were created.

-- (a) --------------------------------------------------------------------
update public.document_versions v
   set indexing_status = case
         when exists (select 1 from public.documents d where d.metadata->>'storage_path' = v.storage_path)
           then 'indexed'
         else 'failed'
       end
 where v.indexing_status in ('unknown', 'pending')
   and v.created_at < now() - interval '1 hour';

-- (b) --------------------------------------------------------------------
drop policy if exists "Firm members can manage document type templates" on public.document_type_templates;
drop policy if exists "Admins add document type templates" on public.document_type_templates;
drop policy if exists "Admins change document type templates" on public.document_type_templates;
drop policy if exists "Admins remove document type templates" on public.document_type_templates;
create policy "Admins add document type templates" on public.document_type_templates
  for insert with check (public.has_role(auth.uid(), 'admin'));
create policy "Admins change document type templates" on public.document_type_templates
  for update using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
create policy "Admins remove document type templates" on public.document_type_templates
  for delete using (public.has_role(auth.uid(), 'admin'));

drop policy if exists "Only admins add standards" on storage.objects;
drop policy if exists "Only admins change standards" on storage.objects;
drop policy if exists "Only admins remove standards" on storage.objects;
create policy "Only admins add standards" on storage.objects as restrictive
  for insert with check (bucket_id <> 'precedent-library' or name not like 'standards/%' or public.has_role(auth.uid(), 'admin'));
create policy "Only admins change standards" on storage.objects as restrictive
  for update
  using (bucket_id <> 'precedent-library' or name not like 'standards/%' or public.has_role(auth.uid(), 'admin'))
  with check (bucket_id <> 'precedent-library' or name not like 'standards/%' or public.has_role(auth.uid(), 'admin'));
create policy "Only admins remove standards" on storage.objects as restrictive
  for delete using (bucket_id <> 'precedent-library' or name not like 'standards/%' or public.has_role(auth.uid(), 'admin'));

-- (c) --------------------------------------------------------------------
drop policy if exists "Firm members can delete skills" on public.ai_skills;
drop policy if exists "Admins or the creator can delete skills" on public.ai_skills;
create policy "Admins or the creator can delete skills" on public.ai_skills
  for delete using (
    public.has_role(auth.uid(), 'admin')
    or (public.is_firm_member(auth.uid()) and created_by = auth.uid())
  );

-- (c2) A chat is deleted by the person who started it or an admin, as the
-- chat list now offers. All 63 live threads have created_by.
-- Reversal: drop the new policy and recreate
--   create policy "Firm members can delete chat threads" on public.ai_chat_threads
--     for delete using (public.is_firm_member(auth.uid()));
drop policy if exists "Firm members can delete chat threads" on public.ai_chat_threads;
drop policy if exists "Admins or the author can delete chat threads" on public.ai_chat_threads;
create policy "Admins or the author can delete chat threads" on public.ai_chat_threads
  for delete using (
    public.has_role(auth.uid(), 'admin')
    or (public.is_firm_member(auth.uid()) and created_by = auth.uid())
  );

-- (d) --------------------------------------------------------------------
drop policy if exists "Firm members can manage matter documents" on public.matter_documents;
drop policy if exists "Firm members can add matter documents" on public.matter_documents;
drop policy if exists "Firm members can edit matter documents" on public.matter_documents;
drop policy if exists "Admins or the creator can delete matter documents" on public.matter_documents;
create policy "Firm members can add matter documents" on public.matter_documents
  for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members can edit matter documents" on public.matter_documents
  for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
create policy "Admins or the creator can delete matter documents" on public.matter_documents
  for delete using (
    public.has_role(auth.uid(), 'admin')
    or (
      public.is_firm_member(auth.uid())
      and (
        created_by = auth.uid()
        or (
          created_by is null
          and (select v.uploaded_by from public.document_versions v
                where v.matter_document_id = matter_documents.id
                order by v.version_number limit 1) = auth.uid()
        )
      )
    )
  );

drop policy if exists "Firm members can delete document versions" on public.document_versions;
drop policy if exists "Admins, the uploader or the document's creator can delete versions" on public.document_versions;
create policy "Admins, the uploader or the document's creator can delete versions" on public.document_versions
  for delete using (
    public.has_role(auth.uid(), 'admin')
    or (
      public.is_firm_member(auth.uid())
      and (
        uploaded_by = auth.uid()
        or exists (select 1 from public.matter_documents md
                    where md.id = document_versions.matter_document_id and md.created_by = auth.uid())
      )
    )
  );

-- (e) --------------------------------------------------------------------
alter table public.matter_timeslips add column if not exists billable_hours numeric;
alter table public.matter_timeslips add column if not exists ak_billable_hours numeric;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'matter_timeslips'
       and cmd in ('UPDATE', 'ALL') and qual like '%author_id = auth.uid()%'
  ) then
    create policy "Authors can update their own timeslips" on public.matter_timeslips
      for update using (author_id = auth.uid()) with check (author_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'matter_timeslips'
       and cmd in ('DELETE', 'ALL') and qual like '%author_id = auth.uid()%'
  ) then
    create policy "Authors can delete their own timeslips" on public.matter_timeslips
      for delete using (author_id = auth.uid());
  end if;
end $$;
