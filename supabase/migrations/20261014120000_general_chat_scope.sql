-- A chat with no project: the AI Assistant's front door.
--
-- Until now a conversation had to belong to a project or to a standardisation
-- session (one document type). Associates reached the AI only from inside a
-- project, three clicks in. A "general" scope — neither — lets the assistant
-- open from the sidebar with no project chosen; a project is context the
-- lawyer attaches, not a prerequisite.

-- The scope check rejected a thread with neither id. Replace it with nothing:
-- the three states (project, standardisation, general) are all valid.
alter table public.ai_chat_threads drop constraint if exists ai_chat_threads_scope;

-- General threads are personal: listed by their creator. The other scopes
-- are shared firm-wide and unchanged.
create index if not exists ai_chat_threads_general_recent_idx
  on public.ai_chat_threads(created_by, pinned desc, last_message_at desc nulls last)
  where matter_id is null and document_type_id is null;

-- Law research in a general chat has no project to attach the run to.
alter table public.ai_research_runs alter column matter_id drop not null;
