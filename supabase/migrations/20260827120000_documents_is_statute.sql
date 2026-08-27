-- Statute text (Pakistan Code) is a distinct corpus from the firm's own
-- past agreements (is_precedent) — same documents/RAG table, just tagged
-- separately so "how we've drafted this before" and "what the law says"
-- don't blend together in retrieval, and either can be filtered for
-- independently.
alter table public.documents
  add column is_statute boolean not null default false;
