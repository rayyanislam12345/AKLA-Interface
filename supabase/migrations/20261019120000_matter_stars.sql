-- Project stars, 19 Oct 2026.
--
-- The AI workspace (/ai) lets each lawyer star the projects they are working
-- on, so those sit at the top of its sidebar and its project picker. A star
-- is personal: one row per person and project, seen and changed only by
-- that person (RLS on user_id = auth.uid()).
--
-- What this adds:
--   * public.matter_stars (user_id, matter_id, created_at)
--       primary key (user_id, matter_id); both sides cascade, so deleting a
--       project or a user takes its stars with it.
--
-- Until this is applied the workspace treats every project as unstarred and
-- says starring is not switched on yet (src/hooks/useMatterStars.ts).
-- Safe to run more than once.

create table if not exists public.matter_stars (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  matter_id  uuid        not null references public.matters(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, matter_id)
);

create index if not exists matter_stars_matter_id_idx on public.matter_stars (matter_id);

alter table public.matter_stars enable row level security;

drop policy if exists "Own stars" on public.matter_stars;
create policy "Own stars" on public.matter_stars
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- update as well: starring is an upsert (insert … on conflict do update),
-- and Postgres checks the update privilege for that statement even when
-- nothing conflicts. RLS ("Own stars", for all) keeps it to your own rows.
grant select, insert, update, delete on public.matter_stars to authenticated;
