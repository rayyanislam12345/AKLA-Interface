-- Skills uploaded as a Claude skill .zip: stored with Anthropic and run in
-- its code execution sandbox, so their scripts and templates are used.
-- Skills written in the app stay plain instructions.
alter table public.ai_skills
  add column kind text not null default 'instructions' check (kind in ('instructions', 'claude_skill')),
  add column anthropic_skill_id text unique,
  add column anthropic_version_id text,
  add column skill_files jsonb not null default '[]'::jsonb;

alter table public.ai_skills
  add constraint ai_skills_claude_skill_has_id check (kind <> 'claude_skill' or anthropic_skill_id is not null);

-- A skill can hand back files that are not Word documents (a PDF, a
-- spreadsheet); they are kept as downloadable file results.
alter table public.ai_artifacts drop constraint if exists ai_artifacts_kind_check;
alter table public.ai_artifacts add constraint ai_artifacts_kind_check check (kind in ('draft', 'memo', 'review', 'docx', 'file'));
