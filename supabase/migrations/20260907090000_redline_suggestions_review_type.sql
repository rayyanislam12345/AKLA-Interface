-- "Run AI Review" now runs three separate, purpose-built passes instead of
-- one generic one -- legal clause correctness/citations, formatting
-- consistency, and content conflicts (against precedent and against other
-- documents on the same matter). This tags each suggestion with which pass
-- produced it so the UI can group them. Existing rows (all pre-dating the
-- three-pass design) backfill to 'content_conflicts', the closest match to
-- the old generic behavior.
alter table public.redline_suggestions
  add column review_type text not null default 'content_conflicts'
  check (review_type in ('legal_clauses', 'formatting', 'content_conflicts', 'chat'));
