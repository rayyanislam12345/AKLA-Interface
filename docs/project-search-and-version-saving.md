# Project search and safer version saving

The Search navigation item searches document titles, filenames and indexed text, project notes, and task titles. Search can be restricted to one project or result type. Latest document versions are shown by default; users can include historical versions. Results link to the matching version, note or task in its project. Document results also offer the original file for download.

AI document panels explicitly offer **New document** or **New version**. New versions use the source version ID as a precondition. The database serializes saves to a document and refuses a stale source instead of silently saving over someone else's work. Version numbers are allocated on the server and are not reused after deletion. Ordinary uploads and meeting documents use the same saving function.

Each upload has a unique storage path. Retrying an uncertain database request with that same path returns the already committed version. A failed indexing operation does not undo the save. The document list shows indexing state and offers a retry for failed or unconfirmed indexing. Old files start with an unconfirmed status, since existing extracted text alone does not establish that ingestion finished successfully.

## Rollout

Apply these new migrations in order, after the existing AI document integrity migration:

1. `20260918090200_project_search.sql`
2. `20260918090300_safe_document_versions.sql`

Then deploy `process-document` and the frontend. The historical `20260918090100_ai_document_integrity.sql` is unchanged. The old `save_ai_document` RPC remains available and delegates to the stronger implementation for client compatibility.

The search migration backfills a separate full-text index from all existing project document text. Large source records are indexed in overlapping sections; backfill time and storage growth depend on the existing corpus. Documents that never completed extraction remain searchable by title and filename; use **Retry indexing** for text search.

The search RPC runs with the caller's database permissions, checks firm membership, and joins accessible projects. The helper index also checks source document and project access. This preserves current permissions; it does not introduce a new project membership model.

These changes have been verified locally. Production rollout and live authentication/storage verification are separate from the local test results.

## Verification

- `npm run test:ai`: PostgreSQL-compatible PGlite tests cover new/first-version saves, retries, stale competing saves, monotonic version numbering after deletion, legacy API compatibility, project access, long-document search, historical filters, and index refresh/deletion. The existing AI integrity tests also run.
- `npm run typecheck` and `npm run build`.
- With Vite running at `http://127.0.0.1:5178`, run `node tests/browser-smoke.mjs` (uses locally installed Chrome). The browser fixtures mock Supabase requests and do not write production data. They exercise search filters, escaped snippets, version links, uncertain-save retries and indexing failure reporting, plus the existing editor table export check.

PGlite runs these database checks on one connection; the tests do not constitute a multi-connection production load test. Staged blobs retained after an uncertain or rejected save may require later orphan cleanup; cleanup must check database references before deleting anything.
