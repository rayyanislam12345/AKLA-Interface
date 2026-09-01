-- The rest of the app resolves a "who last touched this" column to a
-- display name via a FK to public.profiles (e.g. matters.lead_partner_id,
-- matter_notes.author_id — see useMatters.ts/useMatterDetail.ts's
-- `alias:profiles(full_name)` embedding pattern). The initial migration
-- pointed updated_by at auth.users, which PostgREST can't embed profiles
-- data through — repoint it so the same pattern works here too.
alter table public.document_type_templates
  drop constraint document_type_templates_updated_by_fkey,
  add constraint document_type_templates_updated_by_fkey
    foreign key (updated_by) references public.profiles(id);

alter table public.matter_context
  drop constraint matter_context_updated_by_fkey,
  add constraint matter_context_updated_by_fkey
    foreign key (updated_by) references public.profiles(id);
