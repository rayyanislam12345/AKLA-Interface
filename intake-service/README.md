# Intake service

The firm's Transactions Hub sheet (one row per deliverable) now lives in the Hub's
database as the master copy. This service keeps it fed and keeps the Excel on
SharePoint in step:

- **agendas** (daily, 07:30): reads every new Daily Agenda from
  `Automated Inbox/Daily Agendas`. Each deliverable block is matched to a row
  and becomes a dated update line on it; the timesheet table becomes time
  suggestions for the person to confirm. Anything it cannot place goes to the tray.
- **sheet-sync** (nightly, 23:30): downloads the Excel, applies the cells people
  changed in it since the last write to the Hub, then rewrites the sheet from the
  Hub's rows (same look, long status words, comments rebuilt) and fills the
  "Agenda Log" sheet. A cell changed on both sides goes to the tray; neither side is overwritten.
- **load-sheet**: the one-time load of the Excel into the Hub (safe to repeat).
- **status**: the last runs and what waits in the tray.

Nothing is ever deleted on SharePoint. No Claude calls: matching is aliases and word overlap.

## Commands

```
cd intake-service
python3 -m intake load-sheet "<path to the xlsx>" [--dry-run]
python3 -m intake agendas --dir "<folder>" | --sharepoint  [--since 2026-10-20] [--dry-run] [--sheet <xlsx>]
python3 -m intake sheet-sync [--path <local xlsx>] [--dry-run --out <xlsx>]
python3 -m intake status
```

`--dry-run` prints every write it would make and makes none. `agendas --sheet`
takes the rows from a workbook instead of the Hub, so a dry run works with no keys.

## On the Mac: the one-time load and a dry run

Keys: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment, in
`intake-service/.env`, or in the repo's `.env` (see `deploy/env`). Deps:
`pip install -r intake-service/requirements.txt` (openpyxl, pyyaml, certifi).

1. `python3 -m intake load-sheet "<the sheet>" --dry-run`, read the counts
   (rows, comment lines, unknown people, pairs without a config entry).
2. `python3 -m intake load-sheet "<the sheet>"`. Writes the rows and their update
   lines and a first snapshot of the sheet. Running it again updates, never duplicates.
3. `python3 -m intake agendas --dir "<Daily Agendas folder>" --since 2026-10-20 --dry-run`.
4. `python3 -m intake sheet-sync --path "<the sheet>" --dry-run --out /tmp/hub-check.xlsx`
   and open the result: rows 1-5 untouched, the data rows from the Hub, column I
   (Hub ID) hidden, the Agenda Log filled.

The first real `sheet-sync` matches rows with no Hub ID by Sr. No. and
deliverable and writes the ids into the hidden column; after that the id is the key.

## Config

- `config/transactions.yaml`: the extractor's `matters` list (codes, aliases) plus
  `hub_clients`: for each transaction the sheet's CLIENT / PROJECT pairs, the
  spellings agendas use, the Hub project (`matter_id`) and `matter_rules` that send
  one deliverable to another project (PTQ escrow rows, the PC Ordinance rows).
  `internal_transactions` lists what is never a deliverable.
- `config/people.yaml`: the profiles' full names and the initials and misspellings used for them.
- `config/settings.yaml`: thresholds (transaction 0.8, deliverable 0.75 for a sure
  match, 0.45 below which there is no match), the 08:00 stamp for agenda lines,
  the sheet layout, the SharePoint paths.
- `intake_settings` in the database: `auto_create_rows` (off: a confident unmatched
  line creates its own row instead of waiting in the tray), `sheet_sync` (off stops
  the nightly rewrite), `stale_after_days`.

## The tray (`intake_tray.kind`)

- `agenda_line_no_row`: a block whose transaction is known but no row fits; the guess is a drafted row.
- `agenda_line_unsure`: a block that fits a row, but not surely (or two rows equally); the guess is the best row and the runners-up.
- `excel_conflict`: a cell changed in the sheet and on the Hub since the last write; both values shown, both kept.
- `agenda_unreadable`: a file the parser could not open.
- `time_no_row`: a timesheet line under a transaction the config does not know.

Time lines whose transaction is known always become `transaction_time_suggestions`
(with the row and Hub project when the narrative names one); they are not trayed.

## Deploy

`deploy/deploy.sh` copies the code to `/opt/intake-service` on the Oracle VM,
installs the venv and enables `intake-agendas.timer` and `intake-sheet-sync.timer`
(both start `intake@<command>.service`). Secrets come from the chat service's and
the WhatsApp Filer's `.env` files; see `deploy/env`.

## Tests

`python3 -m unittest discover -s intake-service/tests` (from the repo root). The
fixtures are synthetic; no agenda or sheet content is in the repo.
