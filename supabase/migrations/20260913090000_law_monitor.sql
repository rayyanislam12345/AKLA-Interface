-- Daily legal-update monitor.
--
-- The law library has been a snapshot: Acts are scraped once and never
-- re-checked (resolve-statute deliberately short-circuits on any Act that
-- already has chunks), so an amended Act keeps its pre-amendment text
-- indefinitely while Draft and Verify keep grounding answers in it. These
-- tables back a job on the Oracle VM that looks for new laws, amendments,
-- SROs and notices every morning, writes a daily digest, and flags the
-- matters whose Relevant Laws are affected.
--
-- Write access follows mandate_opportunities: firm members can read, and
-- nothing else has a write policy — the job writes with the service role,
-- which bypasses RLS. The one exception is the acknowledgement table, which
-- lawyers write from the app.

-- One row per run of the monitor, so a sweep that starts failing or
-- hallucinating is visible rather than silent.
create table public.law_monitor_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  -- How far the rotating library sweep got, so the next run resumes rather
  -- than re-checking the same Acts every morning.
  library_cursor text,
  sources_checked integer not null default 0,
  acts_checked integer not null default 0,
  found integer not null default 0,
  written integer not null default 0,
  rejected integer not null default 0,
  error text
);

create index law_monitor_runs_started_idx on public.law_monitor_runs(started_at desc);

-- A single confirmed development. Only written once the job has actually
-- fetched the underlying document — the AI locates a URL, it never supplies
-- the facts stored here.
create table public.law_updates (
  id uuid primary key default gen_random_uuid(),
  -- Issuing authority + official reference (SRO/circular number, or Act
  -- short title + year), normalised URL as a fallback. Without a stable key
  -- the same SECP circular would be re-reported every single morning.
  dedupe_key text not null unique,
  source_name text not null,
  authority_ref text,
  -- Matches documents.metadata->>'act_name' when the finding maps onto an
  -- Act the firm holds; null for developments outside the library. Kept as a
  -- string for the same reason matter_relevant_laws does: the library has no
  -- per-Act table to point a foreign key at.
  act_name text,
  title text not null,
  summary text,
  update_type text not null check (
    update_type in ('consolidated_replacement', 'amending_instrument', 'new_act', 'bill', 'notice')
  ),
  source_url text,
  document_url text,
  published_date date,
  discovered_at timestamptz not null default now(),
  -- A repeat sighting bumps this instead of inserting a second row.
  last_seen_at timestamptz not null default now(),
  confidence text check (confidence in ('high', 'medium', 'low')),
  -- What the monitor did to the library because of this finding. Bills and
  -- notices are never allowed to touch it.
  library_action text not null default 'none' check (
    library_action in ('none', 'ingested_amendment', 'replaced_act', 'skipped', 'failed')
  ),
  library_action_at timestamptz,
  library_action_note text,
  run_id uuid references public.law_monitor_runs(id) on delete set null
);

create index law_updates_act_name_idx on public.law_updates(act_name);
create index law_updates_discovered_idx on public.law_updates(discovered_at desc);

-- The newsletter. One row per day, upserted, so re-running the job
-- regenerates the day's digest rather than duplicating it.
create table public.law_update_digests (
  digest_date date primary key,
  summary_markdown text not null,
  update_count integer not null default 0,
  generated_at timestamptz not null default now(),
  run_id uuid references public.law_monitor_runs(id) on delete set null
);

-- The previous text of an Act whose library entry was replaced. Chunks and
-- embeddings are not kept — re-ingesting the archived text through
-- ingest-documents rebuilds them.
create table public.law_library_versions (
  id uuid primary key default gen_random_uuid(),
  act_name text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  chunk_count integer,
  archived_at timestamptz not null default now(),
  superseded_by_update_id uuid references public.law_updates(id) on delete set null
);

create index law_library_versions_act_idx on public.law_library_versions(act_name, archived_at desc);

-- How a lawyer clears the amber "this law changed" flag on one matter
-- without hiding the same development from every other matter that depends
-- on the Act.
create table public.matter_law_update_acks (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  law_update_id uuid not null references public.law_updates(id) on delete cascade,
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz not null default now(),
  unique (matter_id, law_update_id)
);

create index matter_law_update_acks_matter_idx on public.matter_law_update_acks(matter_id);

alter table public.law_monitor_runs enable row level security;
alter table public.law_updates enable row level security;
alter table public.law_update_digests enable row level security;
alter table public.law_library_versions enable row level security;
alter table public.matter_law_update_acks enable row level security;

create policy "Firm members can view monitor runs"
  on public.law_monitor_runs for select
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can view law updates"
  on public.law_updates for select
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can view law update digests"
  on public.law_update_digests for select
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can view archived law versions"
  on public.law_library_versions for select
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can view law update acks"
  on public.matter_law_update_acks for select
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can acknowledge law updates"
  on public.matter_law_update_acks for insert
  with check (public.is_firm_member(auth.uid()));

create policy "Firm members can undo an acknowledgement"
  on public.matter_law_update_acks for delete
  using (public.is_firm_member(auth.uid()));

-- statute_sources() reported min(scraped_at) per Act, which meant a
-- successful refresh still displayed the original scrape date and looked
-- like nothing had happened. The freshest chunk is what the reader cares
-- about.
create or replace function public.statute_sources()
returns table(
  act_name text,
  source text,
  source_url text,
  chunk_count bigint,
  scraped_at timestamptz
)
language sql
stable
as $$
  select
    d.metadata->>'act_name' as act_name,
    min(d.metadata->>'source') as source,
    min(d.metadata->>'source_url') as source_url,
    count(*) as chunk_count,
    coalesce(max(d.metadata->>'scraped_at')::timestamptz, max(d.created_at)) as scraped_at
  from public.documents d
  where d.is_statute = true
  group by d.metadata->>'act_name'
  order by coalesce(max(d.metadata->>'scraped_at')::timestamptz, max(d.created_at)) desc;
$$;

-- Which of a matter's documents actually cite a given Act, so "Revise" can
-- name them and preselect when there is only one. The link from an ingested
-- chunk back to its matter document runs through the storage path, which is
-- the only identifier the two share.
--
-- Matches the full formal name and, as a fallback, the name with its
-- trailing year stripped ("Contract Act, 1872" -> "Contract Act"), since
-- drafters cite both forms.
create or replace function public.matter_documents_citing_act(p_matter_id uuid, p_act_name text)
returns table(matter_document_id uuid, title text, mentions bigint)
language sql
stable
set search_path to 'public', 'extensions'
as $$
  select md.id as matter_document_id, md.title, count(*) as mentions
  from public.documents d
  join public.document_versions v on v.storage_path = d.metadata->>'storage_path'
  join public.matter_documents md on md.id = v.matter_document_id
  where d.matter_id = p_matter_id
    and (
      d.content ilike '%' || p_act_name || '%'
      or d.content ilike '%' || regexp_replace(p_act_name, ',?\s*\d{4}\s*$', '') || '%'
    )
  group by md.id, md.title
  order by count(*) desc;
$$;
