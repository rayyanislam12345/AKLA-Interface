-- matter_notes.author_id pointed at auth.users, but useMatterNotes embeds
-- `author:profiles(full_name)` — PostgREST can only resolve that through a
-- FK to public.profiles, so the Notes query on every matter page returned
-- 400 and the card never loaded. Same repoint document_type_templates and
-- matter_context already got (20260828120500). profiles.id is the auth
-- user id, so existing rows carry over unchanged.
alter table public.matter_notes
  drop constraint if exists matter_notes_author_id_fkey,
  add constraint matter_notes_author_id_fkey
    foreign key (author_id) references public.profiles(id);
