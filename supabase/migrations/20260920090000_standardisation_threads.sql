-- A standardisation session is a chat about a document type rather than a
-- project: the associate builds the firm's standard master for that type
-- with the AI, from the firm's own earlier documents and the laws they
-- identify. Such a thread has no matter; it has a document type and the
-- list of Acts chosen for it.
alter table public.ai_chat_threads
  add column document_type_id uuid references public.document_types(id) on delete cascade,
  add column laws jsonb not null default '[]'::jsonb;
create index ai_chat_threads_document_type_idx on public.ai_chat_threads(document_type_id, pinned, last_message_at desc) where document_type_id is not null;
alter table public.ai_chat_threads
  add constraint ai_chat_threads_scope check (matter_id is not null or document_type_id is not null);
