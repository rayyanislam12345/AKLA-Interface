-- Law monitor, phase 2: watch the notice boards.
--
-- Web search lags the authorities by days and surfaces press releases. The
-- places law actually appears — the bills pages of the National Assembly and
-- the provincial assemblies, Pakistan Code's recently-added list, PPRA's
-- rules page, OGRA's public notices — are ordinary listing pages. The
-- monitor now reads each one every morning and compares it with the
-- previous snapshot; new entries become candidates and go through the same
-- verification as everything else. The same table remembers the text hash
-- of each library Act's official source page, so a change in the official
-- text of an Act the firm holds is noticed directly.

create table public.law_watch_pages (
  url text primary key,
  name text not null,
  -- 'listing' for a notice board diffed entry by entry; 'library_source'
  -- for an Act's own official page, compared as a whole.
  kind text not null check (kind in ('listing', 'library_source')),
  act_name text,
  -- The entries seen last time: [{"text": ..., "href": ...}, ...].
  entries jsonb not null default '[]'::jsonb,
  entry_count integer not null default 0,
  -- For library sources: a hash of the page text with digits removed, so
  -- visitor counters and dates do not read as amendments.
  content_hash text,
  content_length integer,
  first_seen_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0,
  -- A page that fails for long enough is still shown on the card, so a
  -- silently dead source is visible.
  enabled boolean not null default true
);

create index law_watch_pages_kind_idx on public.law_watch_pages(kind, last_checked_at desc);

alter table public.law_watch_pages enable row level security;

create policy "Firm members can view watched pages"
  on public.law_watch_pages for select
  using (public.is_firm_member(auth.uid()));

alter table public.law_monitor_runs add column if not exists pages_checked integer not null default 0;
alter table public.law_monitor_runs add column if not exists pages_changed integer not null default 0;
