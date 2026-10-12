-- Case-law research workspace: the tables behind caselaw-service.
--
-- Kept separate from the ai_chat_* tables on purpose. This is a different tool
-- with a different retrieval source (reported judgments, not the firm's
-- matters, precedents and statutes) and its own page; sharing the chat tables
-- would entangle two things that evolve independently.
--
-- Four tables:
--   caselaw_threads   — a research conversation (a list the lawyer manages)
--   caselaw_messages  — the turns; an assistant turn carries its sources,
--                       plan, coverage and tier in metadata
--   caselaw_runs      — the per-question audit trail: exactly which queries ran,
--                       what the pool/shortlist/grades were, and what ranked.
--                       This is how a "did it miss a case?" question is answered.
--   caselaw_cache     — judgments fetched from the source, reused for 30 days
--                       so follow-ups in a thread don't re-fetch.
--
-- Every table is firm-wide: any active firm member may read and write, matching
-- the ai_chat_* policy. caselaw-service writes under the service role (so a
-- near-expired browser token cannot lose a long run midway), and these RLS
-- policies govern any direct client access.

-- A research conversation.
create table public.caselaw_threads (
  id uuid primary key default gen_random_uuid(),
  title text,
  -- Optional link to a matter, for when research is done in a matter's context.
  -- Null for standalone research, which is the common case here.
  matter_id uuid references public.matters(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  pinned boolean not null default false,
  archived boolean not null default false
);

create index caselaw_threads_recent_idx
  on public.caselaw_threads(pinned desc, last_message_at desc nulls last);

-- A turn. role is 'user' or 'assistant'. An assistant turn's metadata holds
-- { sources, tier, plan, coverage, citationIssues, stopped }.
create table public.caselaw_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.caselaw_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index caselaw_messages_thread_created_idx
  on public.caselaw_messages(thread_id, created_at);

-- The audit trail for one question. Durable and independent of the message, so
-- a run that failed or was stopped is still inspectable. ranked holds the final
-- list with component scores; coverage holds the full query log.
create table public.caselaw_runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references public.caselaw_threads(id) on delete cascade,
  message_id uuid references public.caselaw_messages(id) on delete set null,
  question text not null,
  status text not null default 'running' check (status in ('running', 'complete', 'stopped', 'error')),
  tier text,
  plan jsonb,
  coverage jsonb,
  ranked jsonb,
  error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index caselaw_runs_thread_idx on public.caselaw_runs(thread_id, created_at);

-- Judgment cache. One row per (case_id, section): section 'summary' is metadata
-- + headnote, 'full' adds the judgment text. fetched_at drives the 30-day TTL,
-- which the service enforces on read (a cron can also prune).
create table public.caselaw_cache (
  case_id bigint not null,
  section text not null check (section in ('summary', 'full')),
  citation text,
  court text,
  year int,
  title text,
  body text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  primary key (case_id, section)
);

create index caselaw_cache_fetched_idx on public.caselaw_cache(fetched_at);

-- RLS: firm members only, on every table.
alter table public.caselaw_threads enable row level security;
alter table public.caselaw_messages enable row level security;
alter table public.caselaw_runs enable row level security;
alter table public.caselaw_cache enable row level security;

create policy "Firm members read caselaw threads" on public.caselaw_threads for select using (public.is_firm_member(auth.uid()));
create policy "Firm members write caselaw threads" on public.caselaw_threads for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members update caselaw threads" on public.caselaw_threads for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
create policy "Firm members delete caselaw threads" on public.caselaw_threads for delete using (public.is_firm_member(auth.uid()));

create policy "Firm members read caselaw messages" on public.caselaw_messages for select using (public.is_firm_member(auth.uid()));
create policy "Firm members write caselaw messages" on public.caselaw_messages for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members update caselaw messages" on public.caselaw_messages for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
create policy "Firm members delete caselaw messages" on public.caselaw_messages for delete using (public.is_firm_member(auth.uid()));

create policy "Firm members read caselaw runs" on public.caselaw_runs for select using (public.is_firm_member(auth.uid()));
create policy "Firm members write caselaw runs" on public.caselaw_runs for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members update caselaw runs" on public.caselaw_runs for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));

-- The cache holds public reported judgments, not firm data, but gate it to firm
-- members too so nothing is readable without membership.
create policy "Firm members read caselaw cache" on public.caselaw_cache for select using (public.is_firm_member(auth.uid()));
create policy "Firm members write caselaw cache" on public.caselaw_cache for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members update caselaw cache" on public.caselaw_cache for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));

-- Keep the thread list ordering honest without trusting every writer.
create or replace function public.touch_caselaw_thread_on_message()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.caselaw_threads
     set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at),
         updated_at = now()
   where id = new.thread_id;
  return new;
end;
$$;

create trigger caselaw_messages_touch_thread
  after insert on public.caselaw_messages
  for each row execute function public.touch_caselaw_thread_on_message();
