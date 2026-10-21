-- Clause lists and drafting decisions as data (docs/drafting-fidelity-plan-
-- 2026-10-19.md, slice 4; Appendix H item 1, the skeleton and decisions
-- half; the style_sheet column belongs to slice 3).
--
--   skeleton   the type's clause list: { key, typeName, source,
--              completeLevels, headingKinds, items: [{ id, heading, level,
--              presence: always | optional | decision, decision?, when?,
--              absentWhen?, match: heading | slot, slot?, pattern?,
--              synonyms?, not_used_form? }] }. chat-service/skeletonCheck.js
--              checks a draft against it before it is filed.
--   decisions  the type's drafting decisions, in the shape of the
--              questionnaire engine (chat-service/decisions.js): { key,
--              name, closing, questions: [{ id, title, question, location,
--              basis, options, appliesWhen?, auto?, hide? }] }.
--
-- Both are written by scripts/drafting-packs/seed_skeletons.mjs from
-- chat-service/skeletons/<key>.json and chat-service/decisions/<key>.json.
-- A type without them falls back to those files by its name
-- (questionnaire.js questionnaireFor, skeletonCheck.js skeletonFor). The
-- old `questionnaire` text column (a key into the code's questionnaires)
-- is kept for one release.
--
-- Idempotent: every statement can run twice.

alter table public.document_types
  add column if not exists skeleton jsonb,
  add column if not exists decisions jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_types_skeleton_shape_check') then
    alter table public.document_types
      add constraint document_types_skeleton_shape_check
      check (skeleton is null or jsonb_typeof(skeleton) = 'array' or (jsonb_typeof(skeleton) = 'object' and jsonb_typeof(skeleton -> 'items') = 'array'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_types_decisions_shape_check') then
    alter table public.document_types
      add constraint document_types_decisions_shape_check
      check (decisions is null or jsonb_typeof(decisions) = 'array' or (jsonb_typeof(decisions) = 'object' and jsonb_typeof(decisions -> 'questions') = 'array'));
  end if;
end
$$;

comment on column public.document_types.skeleton is 'Clause list: the parts the firm expects in this kind of document, in order, each always, optional or turned on by a drafting decision (chat-service/skeletonCheck.js). Seeded by scripts/drafting-packs/seed_skeletons.mjs.';
comment on column public.document_types.decisions is 'Drafting decisions asked one at a time before or while drafting (chat-service/decisions.js, questionnaire.js). Seeded by scripts/drafting-packs/seed_skeletons.mjs. Replaces the questionnaire key after one release.';
