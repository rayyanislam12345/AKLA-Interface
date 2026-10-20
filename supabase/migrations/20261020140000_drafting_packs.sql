-- Drafting packs (docs/drafting-fidelity-plan-2026-10-19.md, slice 2,
-- Appendix H items 2 and 4).
--
-- A pack is the firm's own Word file for a kind of document, cut by
-- scripts/drafting-packs/build_pack.py and uploaded as that type's Word
-- standard by scripts/drafting-packs/upload_packs.mjs. It is an ordinary
-- standard row with three more columns:
--   kinds       the paragraph kinds the drafting engine writes with
--               (chat-service/docxAgent.js validateKinds is the contract);
--   fingerprint the pack's format fingerprint (chat-service/formatFingerprint.js);
--   pack_mode   'form' (settled text with blanks) or 'shell' (fixed parts and
--               one example of each paragraph kind; the body is written).
-- Every filing of a standard keeps them too (document_template_versions), so
-- a draft keeps writing in its pack's kinds after the standard is replaced.
--
-- Idempotent: every statement can run twice.

alter table public.document_type_templates
  add column if not exists kinds jsonb,
  add column if not exists fingerprint jsonb,
  add column if not exists pack_mode text;

alter table public.document_template_versions
  add column if not exists kinds jsonb,
  add column if not exists fingerprint jsonb,
  add column if not exists pack_mode text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_type_templates_pack_mode_check') then
    alter table public.document_type_templates
      add constraint document_type_templates_pack_mode_check check (pack_mode in ('form', 'shell'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_template_versions_pack_mode_check') then
    alter table public.document_template_versions
      add constraint document_template_versions_pack_mode_check check (pack_mode in ('form', 'shell'));
  end if;
end
$$;

comment on column public.document_type_templates.kinds is 'Drafting pack: the paragraph, table and footnote kinds the drafting engine writes with (docxAgent.js validateKinds). Null for a standard that is not a pack.';
comment on column public.document_type_templates.fingerprint is 'Drafting pack: the format fingerprint of the pack file (formatFingerprint.js).';
comment on column public.document_type_templates.pack_mode is 'Drafting pack: form (settled text with blanks) or shell (fixed parts and one example of each paragraph kind). Null for a standard that is not a pack.';

-- The snapshot trigger (20260918090100) keeps every filing of a standard;
-- it now keeps the pack columns as well. Same name and signature, so the
-- trigger itself is unchanged. A filing is never rewritten (on conflict do
-- nothing, as before); upload_packs.mjs writes the pack columns of the
-- filing it makes itself.
create or replace function public.snapshot_document_template() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.storage_path is not null then
    insert into document_template_versions(document_type_id,storage_path,filename,content_html,format_rules,kinds,fingerprint,pack_mode,created_by)
    values(new.document_type_id,new.storage_path,new.filename,new.content_html,new.format_rules,new.kinds,new.fingerprint,new.pack_mode,new.updated_by)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

-- The wave-1 kinds of document that had no type (owner's decisions of 20
-- October 2026). Only where no type of that name exists, in any case.
-- Research Memo, Legal Opinion, Client Proposal Letter, Meeting Minutes,
-- Escrow Agreement and the IE/IA agreements exist already; Framework
-- Agreement is an existing type too.
insert into public.document_types (name, category)
select v.name, v.category
from (values
  ('Letter / Notice', 'Meetings & Correspondence'),
  ('Amendment Agreement', 'General/Commercial'),
  ('Board Resolution', 'General/Legal'),
  ('Certificate / Consent / NOC', 'General/Legal')
) as v(name, category)
where not exists (select 1 from public.document_types d where lower(d.name) = lower(v.name));
