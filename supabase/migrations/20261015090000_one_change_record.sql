-- One change record for Edit and Review: a tracked change by "AKLA AI" in the
-- working Word file, found again by Word's own revision ids, decided once.
--
-- Reversal, if ever needed: drop trigger redline_suggestions_decision and
-- function stamp_redline_decision; drop constraints redline_suggestions_anchor_check,
-- redline_suggestions_decision_check, ai_review_runs_anchor_check; drop the added
-- columns on both tables; restore the four-value review_type check; restore
-- complete_ai_review from 20260918090000_ai_quality.sql; after
-- `delete ... where document_version_id is null` on both tables,
-- `alter column document_version_id set not null`.

-- 1. redline_suggestions becomes the one change record.
alter table public.redline_suggestions
  alter column document_version_id drop not null,
  add column thread_id        uuid references public.ai_chat_threads(id)  on delete cascade,
  add column artifact_id      uuid references public.ai_artifacts(id)     on delete cascade,   -- the working document (lineage root)
  add column message_id       uuid references public.ai_chat_messages(id) on delete set null,  -- the turn that made it
  add column op               text not null default 'replace' check (op in ('replace','insert_after','delete')),
  add column part             text not null default 'word/document.xml',
  add column paragraph_index  integer,                                   -- global ¶n when written; display only
  add column revision_ids     integer[] not null default '{}',           -- every w:id this change minted in `part`
  add column placement        text not null default 'placed' check (placement in ('placed','unplaced','blocked','superseded')),
  add column placement_reason text,                                      -- code from PLACEMENT_TEXT, or a verbatim message
  add column superseded_by    uuid references public.redline_suggestions(id) on delete set null,
  add column created_by       uuid references auth.users(id),
  add column decided_by       uuid references auth.users(id),
  add column decided_at       timestamptz;

-- The review_type check was declared inline (20260907090000) without a name,
-- so it is found by its definition rather than guessed.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.redline_suggestions'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%review_type%'
  loop
    execute format('alter table public.redline_suggestions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.redline_suggestions add constraint redline_suggestions_review_type_check
  check (review_type in ('legal_clauses','formatting','content_conflicts','chat','edit','standard_fill'));

-- A change belongs to a saved version (legacy, text-matched) or to a working
-- document (ids in the file). Never neither.
alter table public.redline_suggestions add constraint redline_suggestions_anchor_check
  check (document_version_id is not null or artifact_id is not null);

-- The rows already decided get a decision time; who decided is unknown.
update public.redline_suggestions set decided_at = created_at where status <> 'pending' and decided_at is null;
alter table public.redline_suggestions add constraint redline_suggestions_decision_check
  check ((status = 'pending') = (decided_at is null));

-- Who decided and when is stamped here, so the existing client (which updates
-- {status} only) is covered. The server writes as the service role, where
-- auth.uid() is null, so it passes decided_by itself.
create or replace function public.stamp_redline_decision() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then new.decided_at := null; new.decided_by := null;
    else new.decided_at := coalesce(new.decided_at, now()); end if;
  elsif new.status is distinct from old.status then
    if new.status = 'pending' then new.decided_at := null; new.decided_by := null;
    else new.decided_at := coalesce(new.decided_at, now()); new.decided_by := coalesce(new.decided_by, auth.uid()); end if;
  end if;
  return new;
end $$;
create trigger redline_suggestions_decision
  before insert or update of status, decided_by, decided_at on public.redline_suggestions
  for each row execute function public.stamp_redline_decision();

create index redline_suggestions_artifact_idx on public.redline_suggestions(artifact_id, created_at)
  where artifact_id is not null;

-- 2. A review may run on any Word file in the chat.
alter table public.ai_review_runs
  alter column document_version_id drop not null,
  add column artifact_id        uuid references public.ai_artifacts(id) on delete cascade,  -- the working document reviewed
  add column output_artifact_id uuid references public.ai_artifacts(id) on delete set null; -- the copy with the suggestions written in
alter table public.ai_review_runs add constraint ai_review_runs_anchor_check
  check (document_version_id is not null or artifact_id is not null);
create index ai_review_runs_artifact_idx on public.ai_review_runs(artifact_id, created_at desc)
  where artifact_id is not null;
update public.ai_review_runs set status = 'failed', error = 'Stopped before it finished'
  where status = 'running' and created_at < now() - interval '1 hour';

-- 3. Same signature, so review.js keeps calling it. The anchors come from the
--    run; every new key is optional, so the old four-key payload still works.
--    A row may bring its own id: the server mints one before the call and
--    matches what comes back by it, never by position.
create or replace function public.complete_ai_review(p_run_id uuid, p_suggestions jsonb, p_passes jsonb, p_coverage jsonb)
returns setof public.redline_suggestions
language plpgsql security invoker set search_path = public as $$
declare v_version uuid; v_artifact uuid; v_user uuid;
begin
  select document_version_id, artifact_id, created_by into v_version, v_artifact, v_user
    from ai_review_runs where id = p_run_id and status = 'running' for update;
  if not found then raise exception 'Review run is unavailable or already completed'; end if;
  return query insert into redline_suggestions
    (id, document_version_id, review_run_id, artifact_id, thread_id, message_id,
     clause_reference, original_text, suggested_text, rationale, review_type, status,
     op, part, paragraph_index, revision_ids, placement, placement_reason, created_by)
    select coalesce((r->>'id')::uuid, gen_random_uuid()), v_version, p_run_id, v_artifact, (r->>'thread_id')::uuid, (r->>'message_id')::uuid,
      r->>'clause_reference', r->>'original_text', r->>'suggested_text', r->>'rationale', r->>'review_type', 'pending',
      coalesce(r->>'op', 'replace'), coalesce(r->>'part', 'word/document.xml'), (r->>'paragraph_index')::int,
      coalesce((select array_agg(x::int) from jsonb_array_elements_text(coalesce(r->'revision_ids', '[]'::jsonb)) x), '{}'::int[]),
      coalesce(r->>'placement', 'placed'), r->>'placement_reason', coalesce((r->>'created_by')::uuid, v_user)
    from jsonb_array_elements(p_suggestions) r
    returning *;
  update ai_review_runs set status = 'complete', passes = p_passes, coverage = p_coverage where id = p_run_id;
end $$;
revoke all on function public.complete_ai_review(uuid,jsonb,jsonb,jsonb) from public;
grant execute on function public.complete_ai_review(uuid,jsonb,jsonb,jsonb) to authenticated;
