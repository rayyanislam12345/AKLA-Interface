-- The intake, phases 2 and 3 (docs/hub-intake-plan; 23 Nov 2026).
--
-- Phase 2: a document the WhatsApp Filer has filed on SharePoint is filed into
-- its Hub project too, as the next version of the right document, and the
-- Transactions row it belongs to says so. The intake reads the Filer's own
-- record (its filed.sqlite, read-only) and never changes the Filer.
--
-- Phase 3: firm mailboxes read with one application consent; an email that
-- names a deliverable adds its ask to the row, a thread's gist is kept as a
-- project note, and a project the firm has started on but the Hub does not
-- have is proposed. A project is known by every name it goes by.
--
-- Everything the intake does on its own is written to intake_actions with
-- where it came from, and can be undone (undo_intake_action). Nothing here
-- deletes a file: an undone filing takes the version off the project and
-- leaves the file in storage and on SharePoint.
--
-- Safe to run twice. To reverse: drop the six tables and the two functions,
-- drop matters.code, and restore the two check constraints at the end.

-- ---------------------------------------------------------------------------
-- 1. Every name a project goes by
-- ---------------------------------------------------------------------------

-- The firm's short code for the transaction (ADB, PTQ, MM…), as the Filer
-- numbers its files. Two projects may share a code (PTQ: the Corridor and its
-- Escrow Agreement); a 'contains' name then says which deliverables go where.
alter table public.matters add column if not exists code text;
create index if not exists matters_code_idx on public.matters(code) where code is not null;

create table if not exists public.project_names (
  id          uuid primary key default gen_random_uuid(),
  matter_id   uuid references public.matters(id) on delete cascade,
  code        text,                                   -- a transaction the firm codes but the Hub has no project for yet
  name        text not null,
  name_key    text generated always as (btrim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g'))) stored,
  kind        text not null default 'alias'
              check (kind in ('alias',      -- another name people use: "M6", "Hyderabad Sukkur Motorway"
                              'sheet',      -- a CLIENT / PROJECT pair as the Transactions sheet writes it ("ADB / M6 Motorway")
                              'learned',    -- a name a person confirmed in the tray
                              'contains')), -- within its code, a deliverable containing this text belongs to this project
  source      text not null default 'hub' check (source in ('config', 'hub', 'tray', 'intake')),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  check (matter_id is not null or code is not null),
  check (length(btrim(name)) > 0)
);

create unique index if not exists project_names_matter_key
  on public.project_names(matter_id, kind, name_key) where matter_id is not null;
create unique index if not exists project_names_code_key
  on public.project_names(code, kind, name_key) where matter_id is null;
create index if not exists project_names_key_idx on public.project_names(name_key);

-- ---------------------------------------------------------------------------
-- 2. Documents the Filer filed, and what the intake did with each
-- ---------------------------------------------------------------------------

create table if not exists public.intake_documents (
  id                   uuid primary key default gen_random_uuid(),
  filer_id             integer not null unique,        -- the row id in the Filer's filed.sqlite
  sha256               text,
  original_name        text,                           -- as it arrived
  filed_name           text,                           -- as the Filer named it on SharePoint
  folder               text,                           -- under the Data Room
  web_url              text,
  code                 text,                           -- the Filer's transaction code
  transaction_name     text,
  title                text,                           -- the Filer's standard document title
  party                text,
  doc_status           text,                           -- the Filer's status word (Draft, Mark-up, Final…)
  document_date        date,
  source               text not null check (source in ('whatsapp', 'email')),
  chat                 text,                           -- the WhatsApp group, or "Outlook - <mailbox> (Inbox)"
  mailbox              text,
  direction            text check (direction in ('inbox', 'sent')),
  sender               text,
  sender_id            uuid references public.profiles(id) on delete set null,
  sent_at              timestamptz,
  caption              text,                           -- the WhatsApp caption, or the email subject
  matter_id            uuid references public.matters(id) on delete set null,
  matter_document_id   uuid references public.matter_documents(id) on delete set null,
  document_version_id  uuid references public.document_versions(id) on delete set null,
  version_number       integer,
  storage_path         text,                           -- kept after an undo, so the file can be placed again
  row_id               uuid references public.transaction_rows(id) on delete set null,
  outcome              text not null default 'pending'
                       check (outcome in ('pending',    -- seen, not yet handled
                                          'filed',      -- a version in the Hub
                                          'duplicate',  -- the same file is already on the project
                                          'trayed',     -- waiting for a person in Needs a look
                                          'skipped',    -- not a transaction document, or dropped by a person
                                          'undone',     -- filed, then taken back
                                          'error')),
  reason               text,
  attempts             integer not null default 0,
  created_at           timestamptz not null default now(),
  handled_at           timestamptz
);

create index if not exists intake_documents_matter_idx on public.intake_documents(matter_id, created_at desc);
create index if not exists intake_documents_outcome_idx on public.intake_documents(outcome) where outcome in ('pending', 'trayed', 'error');

-- ---------------------------------------------------------------------------
-- 3. Messages (email now; group chat text when it is captured)
-- ---------------------------------------------------------------------------

create table if not exists public.intake_messages (
  id               uuid primary key default gen_random_uuid(),
  source           text not null check (source in ('email', 'whatsapp')),
  message_key      text not null unique,               -- the Internet-Message-ID, or the chat message id
  conversation_key text,
  mailboxes        text[] not null default '{}',       -- every mailbox the same email was seen in
  folder           text,                               -- inbox | sentitems | the chat name
  sender           text,
  sender_class     text,                               -- internal | client | institutional | personal | external | unknown
  sent_at          timestamptz,
  subject          text,                               -- null on withheld mail: a withheld message leaves only that it happened
  outcome          text not null
                   check (outcome in ('dropped',       -- newsletter, bulk, personal: rules, no Claude
                                      'withheld',      -- never shared: pay, HR, partners' matters, "eyes only"
                                      'nothing',       -- read; no project, deliverable or ask in it
                                      'acted',         -- moved a row and/or kept a note
                                      'trayed',        -- waiting for a person
                                      'error')),
  rule             text,                               -- the rule that dropped or withheld it
  classification   jsonb,                              -- what Claude read: transaction, deliverable, status, action_items, gist, confidence
  matter_id        uuid references public.matters(id) on delete set null,
  row_id           uuid references public.transaction_rows(id) on delete set null,
  usd              numeric(8,5),
  created_at       timestamptz not null default now()
);

create index if not exists intake_messages_matter_idx on public.intake_messages(matter_id, sent_at desc);
create index if not exists intake_messages_conversation_idx on public.intake_messages(conversation_key);

-- Where each mailbox folder was read up to. The service role only.
create table if not exists public.intake_mail_state (
  mailbox     text not null,
  folder      text not null,
  delta_link  text,
  baseline_at timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (mailbox, folder)
);

-- What the intake has spent on Claude, by day, so the caps hold across runs.
create table if not exists public.intake_usage (
  day    date primary key,
  calls  integer not null default 0,
  usd    numeric(10,5) not null default 0
);

-- ---------------------------------------------------------------------------
-- 4. Everything the intake did on its own, with Undo
-- ---------------------------------------------------------------------------

create table if not exists public.intake_actions (
  id                  uuid primary key default gen_random_uuid(),
  group_id            uuid not null default gen_random_uuid(),   -- one arrival: the filing and the row line it caused
  kind                text not null
                      check (kind in ('version_filed',   -- a document version filed into a project
                                      'row_update',      -- a dated line added to a Transactions row
                                      'row_moved',       -- a line plus a change of status / currently with
                                      'row_created',     -- a row the intake added
                                      'note_added',      -- a project note
                                      'project_created')),
  source              text not null check (source in ('agenda', 'whatsapp', 'email', 'excel')),
  source_ref          text,                             -- the agenda file, "filer:<id>", the message key
  summary             text not null,                    -- "Common Terms Agreement · v4 filed"
  detail              jsonb not null default '{}'::jsonb,  -- from, chat, sent, file, subject, created_document…
  matter_id           uuid references public.matters(id) on delete cascade,
  row_id              uuid references public.transaction_rows(id) on delete set null,
  document_id         uuid references public.matter_documents(id) on delete set null,
  version_id          uuid references public.document_versions(id) on delete set null,
  update_id           uuid references public.transaction_updates(id) on delete set null,
  note_id             uuid references public.matter_notes(id) on delete set null,
  intake_document_id  uuid references public.intake_documents(id) on delete set null,
  message_id          uuid references public.intake_messages(id) on delete set null,
  before              jsonb,                            -- the row's fields before a move: {status, currently_with}
  after               jsonb,
  created_at          timestamptz not null default now(),
  undone_at           timestamptz,
  undone_by           uuid references public.profiles(id) on delete set null
);

create index if not exists intake_actions_recent_idx on public.intake_actions(created_at desc);
create index if not exists intake_actions_matter_idx on public.intake_actions(matter_id, created_at desc);
create index if not exists intake_actions_row_idx on public.intake_actions(row_id);
create index if not exists intake_actions_group_idx on public.intake_actions(group_id);

-- ---------------------------------------------------------------------------
-- 5. Row level security
-- ---------------------------------------------------------------------------

alter table public.project_names enable row level security;
alter table public.intake_documents enable row level security;
alter table public.intake_messages enable row level security;
alter table public.intake_mail_state enable row level security;
alter table public.intake_usage enable row level security;
alter table public.intake_actions enable row level security;

drop policy if exists "Firm members can view project names" on public.project_names;
create policy "Firm members can view project names" on public.project_names
  for select using (public.is_firm_member(auth.uid()));
drop policy if exists "Firm members can add project names" on public.project_names;
create policy "Firm members can add project names" on public.project_names
  for insert with check (public.is_firm_member(auth.uid()));
drop policy if exists "Firm members can remove project names" on public.project_names;
create policy "Firm members can remove project names" on public.project_names
  for delete using (public.is_firm_member(auth.uid()));

drop policy if exists "Firm members can view intake documents" on public.intake_documents;
create policy "Firm members can view intake documents" on public.intake_documents
  for select using (public.is_firm_member(auth.uid()));

-- A message's subject and gist are a person's mail. What it did to a project
-- is on the project (the row line, the note) for everyone; the log itself,
-- with the withheld entries, is for partners and admins.
drop policy if exists "Partners and admins can view the message log" on public.intake_messages;
create policy "Partners and admins can view the message log" on public.intake_messages
  for select using (public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'partner')
                    or public.has_role(auth.uid(), 'founder'));

drop policy if exists "Firm members can view intake usage" on public.intake_usage;
create policy "Firm members can view intake usage" on public.intake_usage
  for select using (public.is_firm_member(auth.uid()));

drop policy if exists "Firm members can view intake actions" on public.intake_actions;
create policy "Firm members can view intake actions" on public.intake_actions
  for select using (public.is_firm_member(auth.uid()));
-- intake_actions is written by the service role and by undo_intake_action only.
-- intake_mail_state has no policy: the service role only.

-- ---------------------------------------------------------------------------
-- 6. New kinds for the tray and the run log; new switches
-- ---------------------------------------------------------------------------

alter table public.intake_tray drop constraint if exists intake_tray_kind_check;
alter table public.intake_tray add constraint intake_tray_kind_check
  check (kind in ('agenda_line_no_row', 'agenda_line_unsure', 'excel_conflict', 'agenda_unreadable', 'time_no_row',
                  'document_no_project',  -- a filed document whose transaction has no Hub project
                  'document_unsure',      -- a document that may be the next version of one already on the project
                  'document_undone',      -- a filing a person undid: place it again, or drop it
                  'new_project',          -- a transaction the firm is working on that the Hub has no project for
                  'message_unsure'));     -- an email or message that names a project but not clearly which row

alter table public.intake_runs drop constraint if exists intake_runs_kind_check;
alter table public.intake_runs add constraint intake_runs_kind_check
  check (kind in ('agendas', 'sheet_sync', 'load', 'documents', 'mail', 'projects'));

insert into public.intake_settings (key, value) values
  ('file_documents', 'true'::jsonb),            -- file what the Filer filed into the Hub project too
  ('documents_move_rows', 'true'::jsonb),       -- a filed document adds a line to the row it belongs to
  ('documents_set_status', 'false'::jsonb),     -- …and may change the row's status (off until the lines are trusted)
  ('auto_create_projects', 'false'::jsonb),     -- let an unknown transaction create its project without asking
  ('mail_enabled', 'false'::jsonb),             -- read firm mailboxes (needs the admin consent first)
  ('mail_mailboxes', '[]'::jsonb),              -- the mailboxes to read
  ('mail_move_rows', 'true'::jsonb),            -- an email's ask adds a line to the row it names
  ('mail_set_status', 'false'::jsonb),          -- …and a clear status word may change the row's status
  ('mail_notes', 'true'::jsonb),                -- keep a thread's gist as a project note
  ('claude_daily_calls', '300'::jsonb),         -- the most Claude reads in a day
  ('claude_monthly_usd', '25'::jsonb)           -- the most to spend in a month
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Undo
-- ---------------------------------------------------------------------------

-- Takes back one row line (and the status / currently-with it changed, where
-- the row still holds what the intake wrote: a person's later edit stands).
create or replace function public.intake_undo_row_action(p_action public.intake_actions)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_latest record;
begin
  if p_action.update_id is not null then
    delete from public.transaction_updates where id = p_action.update_id;
  end if;
  if p_action.row_id is null then
    return;
  end if;

  if p_action.kind = 'row_created' then
    -- A row the intake added is hidden, not deleted, unless people have since written on it.
    if not exists (select 1 from public.transaction_updates u where u.row_id = p_action.row_id and u.source in ('hub', 'excel')) then
      update public.transaction_rows set archived_at = now() where id = p_action.row_id and archived_at is null;
    end if;
    return;
  end if;

  if p_action.before is not null and p_action.after is not null then
    update public.transaction_rows r
       set status = case when p_action.before ? 'status' and r.status = p_action.after->>'status'
                         then p_action.before->>'status' else r.status end,
           currently_with = case when p_action.before ? 'currently_with'
                                  and r.currently_with is not distinct from p_action.after->>'currently_with'
                                 then p_action.before->>'currently_with' else r.currently_with end
     where r.id = p_action.row_id;
  end if;

  -- The row's latest update follows whatever line is now the newest.
  select u.body, u.at, u.source into v_latest
    from public.transaction_updates u where u.row_id = p_action.row_id order by u.at desc, u.created_at desc limit 1;
  if found then
    update public.transaction_rows
       set latest_update = v_latest.body, latest_update_at = v_latest.at, updated_source = v_latest.source
     where id = p_action.row_id;
  else
    update public.transaction_rows set latest_update = null, latest_update_at = null where id = p_action.row_id;
  end if;
end $$;

revoke all on function public.intake_undo_row_action(public.intake_actions) from public, anon, authenticated;

create or replace function public.undo_intake_action(p_action_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a        public.intake_actions;
  s        public.intake_actions;
  d        public.intake_documents;
  v_number integer;
  v_doc    uuid;
  v_undone integer := 1;
begin
  if not public.is_firm_member(auth.uid()) then
    raise exception 'Only firm members can undo this.';
  end if;

  select * into a from public.intake_actions where id = p_action_id for update;
  if not found then
    raise exception 'That entry no longer exists.';
  end if;
  if a.undone_at is not null then
    return jsonb_build_object('undone', false, 'already', true);
  end if;

  if a.kind = 'version_filed' then
    if a.version_id is not null then
      select version_number, matter_document_id into v_number, v_doc from public.document_versions where id = a.version_id;
    end if;
    if v_doc is not null then
      if exists (select 1 from public.document_versions v where v.matter_document_id = v_doc and v.version_number > v_number) then
        raise exception 'A later version has been filed on top of this one. Remove it from the document''s page instead.';
      end if;
      if exists (select 1 from public.ai_review_runs where document_version_id = a.version_id)
         or exists (select 1 from public.redline_suggestions where document_version_id = a.version_id)
         or exists (select 1 from public.ai_chat_threads where document_version_id = a.version_id) then
        raise exception 'Someone has already worked on this version (a review, changes or a chat). Remove it from the document''s page instead.';
      end if;

      -- The version leaves the project; its file stays in storage and on SharePoint.
      delete from public.document_versions where id = a.version_id;
      update public.matter_documents m
         set last_version_number = coalesce((select max(v.version_number) from public.document_versions v where v.matter_document_id = m.id), 0)
       where m.id = v_doc;
      -- A document the intake created for this file, now empty, goes with it.
      if coalesce((a.detail->>'created_document')::boolean, false)
         and not exists (select 1 from public.document_versions v where v.matter_document_id = v_doc) then
        delete from public.matter_documents where id = v_doc;
      end if;
    end if;

    -- The row line the same arrival wrote goes too.
    for s in select * from public.intake_actions
              where group_id = a.group_id and id <> a.id and undone_at is null and kind in ('row_update', 'row_moved') loop
      perform public.intake_undo_row_action(s);
      update public.intake_actions set undone_at = now(), undone_by = auth.uid() where id = s.id;
      v_undone := v_undone + 1;
    end loop;

    -- The file goes back to Needs a look, so it can be placed properly or dropped.
    if a.intake_document_id is not null then
      update public.intake_documents
         set outcome = 'undone', handled_at = now(), matter_document_id = null, document_version_id = null,
             version_number = null, row_id = null, reason = 'undone by a person'
       where id = a.intake_document_id
       returning * into d;
      if found then
        insert into public.intake_tray (kind, payload, guess)
        values ('document_undone',
                jsonb_build_object('intake_document_id', d.id, 'file', d.filed_name, 'title', d.title,
                                   'transaction', coalesce(d.transaction_name, d.code), 'person', d.sender,
                                   'chat', d.chat, 'date', d.sent_at, 'web_url', d.web_url,
                                   'was_matter_id', a.matter_id),
                null);
      end if;
    end if;

  elsif a.kind in ('row_update', 'row_moved', 'row_created') then
    perform public.intake_undo_row_action(a);

  elsif a.kind = 'note_added' then
    if a.note_id is not null then
      delete from public.matter_notes where id = a.note_id;
    end if;

  else
    raise exception 'This cannot be undone from here.';
  end if;

  update public.intake_actions set undone_at = now(), undone_by = auth.uid() where id = a.id;
  return jsonb_build_object('undone', true, 'kind', a.kind, 'count', v_undone);
end $$;

revoke all on function public.undo_intake_action(uuid) from public, anon;
grant execute on function public.undo_intake_action(uuid) to authenticated;
