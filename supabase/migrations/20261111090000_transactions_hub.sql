-- The Transactions Hub: the firm's one-row-per-deliverable sheet, kept on the
-- Hub instead of by hand in Excel (docs/hub-intake-plan: phase 1, 11 Nov 2026).
--
-- The Hub is the master copy. The Excel on SharePoint stays editable: the
-- intake service rewrites it from these rows every night and, before it does,
-- reads back any cell a person changed in the sheet since the last write
-- (transaction_sheet_snapshots holds what was written). A cell both sides
-- changed is not guessed at; it goes to the tray.
--
-- Rows move from three sources: a person's edit on the Hub, an edit in the
-- Excel, and the daily agendas (one "Transaction / Complete Deliverable /
-- Scope of Task" block per deliverable), which the intake service parses
-- without Claude. An agenda line that matches no row goes to the tray with a
-- drafted row; intake_settings.auto_create_rows (off) lets it create the row
-- itself once the matching is trusted.

-- One row per deliverable, in the sheet's own columns and status words.
create table public.transaction_rows (
  id              uuid primary key default gen_random_uuid(),
  sort_order      int not null,                       -- the sheet's Sr. No. order
  client          text not null,                      -- as written in the sheet
  project         text not null,
  deliverable     text not null,
  team            text[] not null default '{}',       -- full names, one per member
  currently_with  text,                               -- free text: a name, "Boss", "EY and PTQ Team", "-"
  status          text not null default 'Not Started'
                  check (status in ('Not Started', 'In Progress', 'With Boss', 'With Client',
                                    'With Counterparty', 'With Client And AKLA', 'On Hold', 'Closed')),
  latest_update   text,                               -- the newest transaction_updates line, for the table
  latest_update_at timestamptz,
  matter_id       uuid references public.matters(id) on delete set null,  -- the Hub project, when one exists
  updated_source  text not null default 'load'
                  check (updated_source in ('load', 'hub', 'excel', 'agenda', 'email', 'whatsapp')),
  updated_by      uuid references public.profiles(id) on delete set null,
  archived_at     timestamptz,                        -- a row removed from the sheet is kept, hidden
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index transaction_rows_matter_idx on public.transaction_rows(matter_id);
create index transaction_rows_status_idx on public.transaction_rows(status) where archived_at is null;

create trigger update_transaction_rows_updated_at
before update on public.transaction_rows
for each row execute function public.update_updated_at_column();

-- The dated lines of a row's "Comments / Latest Update" cell, one each, as the
-- sheet writes them: "October 14, 2026 [09:05 - Usama] - No change since the last update."
create table public.transaction_updates (
  id          uuid primary key default gen_random_uuid(),
  row_id      uuid not null references public.transaction_rows(id) on delete cascade,
  at          timestamptz not null,
  author      text,                                   -- the name as stamped ("Usama"); null on an unstamped line
  author_id   uuid references public.profiles(id) on delete set null,
  body        text not null,
  source      text not null
              check (source in ('load', 'hub', 'excel', 'agenda', 'email', 'whatsapp')),
  source_ref  text,                                   -- the agenda file, the mail id, the sheet row
  created_at  timestamptz not null default now()
);

create index transaction_updates_row_idx on public.transaction_updates(row_id, at desc);

-- Items the intake could not place, each with its best guess ready to accept.
create table public.intake_tray (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null
               check (kind in ('agenda_line_no_row',   -- a Transaction / Deliverable block matching no row
                               'agenda_line_unsure',   -- a block with a low-confidence match
                               'excel_conflict',       -- a cell changed on the Hub and in the sheet since the last write
                               'agenda_unreadable',    -- a file the parser could not read
                               'time_no_row')),        -- a timesheet line matching no row
  payload      jsonb not null,                         -- what arrived (the parsed block, the two cell values, …)
  guess        jsonb,                                  -- {row_id} | {new_row:{client,project,deliverable,team}} | {confidence}
  status       text not null default 'open' check (status in ('open', 'accepted', 'dropped')),
  resolution   jsonb,                                  -- what was done: {row_id} or {created_row_id} or {kept:'hub'|'excel'}
  resolved_by  uuid references public.profiles(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index intake_tray_open_idx on public.intake_tray(created_at) where status = 'open';

-- Hours from the agendas' Daily Timesheet tables, waiting for the person to
-- confirm; a confirmed line becomes a matter_timeslips row (when its row has
-- a Hub project) in the person's own name.
create table public.transaction_time_suggestions (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid references public.profiles(id) on delete set null,
  person_name   text not null,
  work_date     date not null,
  transaction   text not null,                        -- the timesheet's Transaction cell
  narrative     text not null,
  hours         numeric(5,2) not null,
  billable_hours numeric(5,2),
  row_id        uuid references public.transaction_rows(id) on delete set null,
  matter_id     uuid references public.matters(id) on delete set null,
  source_ref    text not null,                        -- agenda file + table row
  status        text not null default 'open' check (status in ('open', 'confirmed', 'dropped')),
  timeslip_id   uuid references public.matter_timeslips(id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (source_ref)
);

create index transaction_time_suggestions_person_idx
  on public.transaction_time_suggestions(person_id, work_date desc) where status = 'open';

-- Each agenda file the intake has read, so a file is read once.
create table public.intake_agendas (
  id             uuid primary key default gen_random_uuid(),
  file_name      text not null unique,
  person_name    text not null,
  person_id      uuid references public.profiles(id) on delete set null,
  agenda_date    date,                                -- the day the agenda is for
  timesheet_date date,                                -- the day the timesheet covers (usually the day before)
  sha256         text not null,
  blocks         int not null default 0,              -- deliverable blocks found
  matched        int not null default 0,
  trayed         int not null default 0,
  time_lines     int not null default 0,
  read_at        timestamptz not null default now()
);

-- What the intake last wrote to the Excel, cell by cell per row id, so the next
-- run can tell a person's edit in the sheet from its own writing.
create table public.transaction_sheet_snapshots (
  id          uuid primary key default gen_random_uuid(),
  written_at  timestamptz not null default now(),
  file_etag   text,
  rows        jsonb not null                          -- {row_id: {client, project, deliverable, team, currently_with, comments, status}}
);

-- Every run of the intake, for the admin to see what happened.
create table public.intake_runs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('agendas', 'sheet_sync', 'load')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  summary     jsonb not null default '{}'::jsonb,
  error       text
);

-- Switches the admin can turn without a deploy.
create table public.intake_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.intake_settings (key, value) values
  ('auto_create_rows', 'false'::jsonb),              -- let a confident unmatched agenda line create its row
  ('stale_after_days', '10'::jsonb),                 -- a row with no update for this long is marked stale
  ('sheet_sync', 'true'::jsonb);                     -- write the Excel nightly and read its edits back

-- Everyone in the firm sees everything, as with the Excel; everyone may move a
-- row (stamped with their name and time). Only the service role deletes rows;
-- the tray and suggestions are resolved, never deleted, by members.
alter table public.transaction_rows enable row level security;
alter table public.transaction_updates enable row level security;
alter table public.intake_tray enable row level security;
alter table public.transaction_time_suggestions enable row level security;
alter table public.intake_agendas enable row level security;
alter table public.transaction_sheet_snapshots enable row level security;
alter table public.intake_runs enable row level security;
alter table public.intake_settings enable row level security;

create policy "Firm members can view transaction rows" on public.transaction_rows
  for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can add transaction rows" on public.transaction_rows
  for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members can move transaction rows" on public.transaction_rows
  for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view transaction updates" on public.transaction_updates
  for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can add transaction updates" on public.transaction_updates
  for insert with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view the tray" on public.intake_tray
  for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can resolve the tray" on public.intake_tray
  for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view time suggestions" on public.transaction_time_suggestions
  for select using (public.is_firm_member(auth.uid()));
create policy "People can resolve their own time suggestions" on public.transaction_time_suggestions
  for update using (person_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
  with check (person_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

create policy "Firm members can view intake agendas" on public.intake_agendas
  for select using (public.is_firm_member(auth.uid()));
create policy "Admins can view sheet snapshots" on public.transaction_sheet_snapshots
  for select using (public.has_role(auth.uid(), 'admin'));
create policy "Firm members can view intake runs" on public.intake_runs
  for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can view intake settings" on public.intake_settings
  for select using (public.is_firm_member(auth.uid()));
create policy "Admins can change intake settings" on public.intake_settings
  for update using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

-- A row's "latest update" column follows its newest update line.
create or replace function public.transaction_row_follow_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.transaction_rows r
     set latest_update = new.body,
         latest_update_at = new.at,
         updated_source = new.source,
         updated_by = coalesce(new.author_id, r.updated_by)
   where r.id = new.row_id
     and (r.latest_update_at is null or new.at >= r.latest_update_at);
  return new;
end $$;

create trigger transaction_updates_follow
after insert on public.transaction_updates
for each row execute function public.transaction_row_follow_update();
