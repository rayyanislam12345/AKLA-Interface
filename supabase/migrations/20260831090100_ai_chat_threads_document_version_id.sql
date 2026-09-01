-- Redline follow-up chat needs finer scoping than a matter — a matter can
-- have several documents under review in parallel. Nullable/additive:
-- existing matter-scoped threads (Matter Chat, drafting interviews) keep
-- this null and are unaffected; RLS is row-scoped via is_firm_member(), not
-- column-scoped, so no policy changes are needed.
alter table public.ai_chat_threads
  add column document_version_id uuid references public.document_versions(id) on delete cascade;
