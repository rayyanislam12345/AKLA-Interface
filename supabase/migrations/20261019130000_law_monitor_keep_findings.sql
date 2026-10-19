-- Law monitor, phase 1: keep what it finds.
--
-- In 47 morning runs the monitor found ~350 candidate developments and kept
-- 5, all press releases. Real amendments were found and discarded daily:
-- the library sweep asked about the last two years and the verifier then
-- rejected anything older than 30 days, and rejection reasons lived only in
-- a four-day journal on the VM. These changes give a finding three things
-- it did not have: a tier (official document in hand vs. reported in the
-- press), an incorporation status (does the library's copy of the Act
-- already include this amendment?), and a memory of every candidate seen,
-- so transient fetch failures are retried and permanent rejections are not
-- re-fetched every morning.

-- 'draft' — a regulation, rule or policy circulated for consultation. Not a
-- bill (which is a proposed Act) and not a notice (which is in force).
alter table public.law_updates drop constraint if exists law_updates_update_type_check;
alter table public.law_updates add constraint law_updates_update_type_check check (
  update_type in ('consolidated_replacement', 'amending_instrument', 'new_act', 'bill', 'notice', 'draft')
);

-- verified: the job fetched the official document and confirmed the
-- reference in it. reported: an allowlisted press report, fetched and
-- title-matched, but the official text has not been located. A reported
-- item never touches the library and never flags a matter.
alter table public.law_updates
  add column if not exists tier text not null default 'verified'
    check (tier in ('verified', 'reported'));

-- For an amending instrument: whether the replacement wording it quotes is
-- already present in the library's stored text of the principal Act.
-- 'unknown' when the amendment quotes nothing checkable. A matter only turns
-- amber for 'not_incorporated' or 'unknown'.
alter table public.law_updates
  add column if not exists incorporation text
    check (incorporation in ('incorporated', 'not_incorporated', 'unknown'));
alter table public.law_updates
  add column if not exists incorporation_note text;

-- Which sweep produced the finding, so the card and the prompts can tell a
-- web-search hit from a watched-page entry (phase 2) or a library re-check.
alter table public.law_updates
  add column if not exists found_by text not null default 'search'
    check (found_by in ('search', 'library_sweep', 'watch_page', 'library_source'));

-- Every candidate the monitor has ever looked at, one row per dedupe key.
-- Rejected candidates are not re-fetched; pending ones (the document did
-- not download) are retried from the stored url the next morning without
-- spending a search; confirmed ones point at their law_updates row.
create table public.law_monitor_candidates (
  dedupe_key text primary key,
  source_name text not null,
  found_by text not null default 'search',
  title text not null,
  authority_ref text,
  act_name text,
  update_type text,
  url text,
  published_date text,
  summary text,
  confidence text,
  status text not null check (status in ('rejected', 'pending_fetch', 'confirmed', 'reported')),
  reason text,
  -- A rejection for age, domain or a reference mismatch is final; a fetch
  -- failure is not. Only non-final rows are retried.
  final boolean not null default true,
  fetch_attempts integer not null default 0,
  times_seen integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  law_update_id uuid references public.law_updates(id) on delete set null,
  run_id uuid references public.law_monitor_runs(id) on delete set null
);

create index law_monitor_candidates_status_idx on public.law_monitor_candidates(status, last_seen_at desc);
create index law_monitor_candidates_act_idx on public.law_monitor_candidates(act_name);

alter table public.law_monitor_candidates enable row level security;

create policy "Firm members can view monitor candidates"
  on public.law_monitor_candidates for select
  using (public.is_firm_member(auth.uid()));

-- Per-run counts for the new paths.
alter table public.law_monitor_runs add column if not exists reported integer not null default 0;
alter table public.law_monitor_runs add column if not exists retried integer not null default 0;
