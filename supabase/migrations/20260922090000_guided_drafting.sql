-- Guided drafting: a document type can carry a questionnaire of drafting
-- decisions (chat-service/questionnaire.js), and a draft of that type keeps
-- its progress — the answers given and the question being asked — on its
-- conversation.
alter table public.document_types add column questionnaire text;
alter table public.ai_chat_threads add column questionnaire jsonb;
update public.document_types set questionnaire = 'rfp_federal_ppp' where id = '2179ed80-e868-424f-9c72-29d5c6d88648';
