-- Document content hash, 16 Oct 2026.
--
-- The project page now takes many files at once (drag a folder or a .zip onto
-- the Documents card). Before each file is sent the browser computes its
-- SHA-256; after the version is saved the page writes it here. A file whose
-- hash is already on a version in the same project is shown as "Already in
-- the project" and skipped, so re-dropping a folder, or the browser's "(1)"
-- copy of a download, does not add the same file twice.
--
-- Until this runs, the page notices the missing column once, stops trying to
-- write it, and falls back to comparing file name and size with the versions
-- already in the project. Nothing else depends on it.
--
-- Safe to run more than once. Versions saved before this run have no hash;
-- the name-and-size check still covers them.
-- Reversal: drop index if exists public.document_versions_content_hash_idx;
--           alter table public.document_versions drop column if exists content_hash;

alter table public.document_versions add column if not exists content_hash text;

comment on column public.document_versions.content_hash is
  'Lower-case hex SHA-256 of the uploaded file, computed in the browser at upload. Used to skip a file already in the project.';

create index if not exists document_versions_content_hash_idx
  on public.document_versions (content_hash)
  where content_hash is not null;
