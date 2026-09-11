-- A "docx" artifact is a real Word file in the ai-chat-files bucket — the
-- document being edited, with the AI's changes applied to that file as
-- tracked changes — rather than Markdown to be rebuilt into one.
-- data: { storagePath, fileName, editSource, changes: [...], original? }
alter table public.ai_artifacts drop constraint if exists ai_artifacts_kind_check;
alter table public.ai_artifacts add constraint ai_artifacts_kind_check check (kind in ('draft', 'memo', 'review', 'docx'));
