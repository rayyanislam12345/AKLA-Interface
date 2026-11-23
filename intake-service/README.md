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
- **documents** (every 10 minutes): reads the WhatsApp Filer's own record of what it has
  filed on SharePoint (`/opt/whatsapp-filer/state/filed.sqlite`, opened read-only; the Filer
  is never changed) and files each transaction document into its Hub project too: the next
  version of the right document, or a new one. The Transactions row it belongs to gets a dated
  line. A document whose transaction has no Hub project waits, and the tray asks once about
  the project.
- **projects**: the names a project goes by (`project_names` on the Hub: "M6", "ADB" and
  "Hyderabad Sukkur Motorway" are one project), and the coded transactions the Hub has no
  project for.
- **mail** (every 10 minutes, off until the owner turns it on): reads the firm's mailboxes
  with one application consent. Rules drop or withhold a message before anything else sees
  it; what remains is read once by Claude for project, deliverable, ask and gist; a sure
  match adds a line to the row and keeps the gist as a project note.
- **load-sheet**: the one-time load of the Excel into the Hub (safe to repeat).
- **status**: the last run of each kind, what waits in the tray, and the switches.

Nothing is ever deleted on SharePoint. Agendas and documents are placed without Claude
(aliases and word overlap); only the mail reader calls it, once per message, under two caps.

Everything the service does on its own is written to `intake_actions` with where it came
from. The Hub shows it under **Arrived**, and anyone in the firm can undo it there
(`undo_intake_action`): a filing leaves the project (its file stays in storage and on
SharePoint, and goes back to the tray to be placed again), a row line is removed and the
row's status put back, a note is removed.

The contracts between the parts are in `docs/phase-2-3-contracts.md`.

## Commands

```
cd intake-service
python3 -m intake load-sheet "<path to the xlsx>" [--dry-run]
python3 -m intake agendas --dir "<folder>" | --sharepoint  [--since 2026-10-20] [--dry-run] [--sheet <xlsx>]
python3 -m intake sheet-sync [--path <local xlsx>] [--dry-run --out <xlsx>]
python3 -m intake documents [--filer-db <filed.sqlite>] [--limit 25] [--backfill] [--dry-run]
python3 -m intake projects --seed-names | --plan <file.json> | --apply <file.json>  [--dry-run]
python3 -m intake mail [--mailbox a@akla.com.pk] [--since 2026-11-20] [--dry-run]
python3 -m intake mail --dir <folder of message .json> [--rules-only] [--write]
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

## Before documents can be filed: the "Hub Intake" account

The Hub records who filed every version, so what this service files needs an account to
be filed under. Run once, on the owner's Mac:

```
python3 intake-service/deploy/make_intake_user.py
```

It creates an approved profile named "Hub Intake" with no password and an address nothing
is delivered to, so nobody can sign in as it. Until it exists `documents` files nothing:
it only notes what it has seen, and files it (25 a run) once the account is there.

## Projects and their names

```
python3 -m intake projects --seed-names        # done once on 23 Nov 2026; safe to repeat
python3 -m intake projects --plan plan.json    # the coded transactions with no Hub project
python3 -m intake projects --apply plan.json   # creates the ones the edited plan marks to create
```

The plan is a JSON list the owner edits: set `"create": false` to leave one out, fix a
client or a name. Applying is safe to repeat. A project made this way takes its code's
names and its sheet rows, and the documents that were waiting for it are filed on the
next run. People add names on the project's page ("Also called"); a name confirmed in the
tray is remembered, so the same question is not asked twice.

## Mail: what the owner has to do first

Nothing is read until all four are done.

1. **Scope the app to the firm's mailboxes** (Exchange Online PowerShell), so the consent
   in step 2 cannot reach any other mailbox:
   ```
   Connect-ExchangeOnline -UserPrincipalName <admin>@akla.com.pk
   New-DistributionGroup -Name "Hub Intake Mailboxes" -Alias hub-intake-mailboxes -Type Security -Members <a@akla.com.pk>,<b@akla.com.pk>
   New-ApplicationAccessPolicy -AppId <AZURE_CLIENT_ID> -PolicyScopeGroupId hub-intake-mailboxes@akla.com.pk -AccessRight RestrictAccess -Description "Hub intake: Mail.Read on the listed mailboxes only"
   ```
   (`AZURE_CLIENT_ID` is the Filer's app, in `/opt/whatsapp-filer/.env`. These commands
   were written from the documentation and have not been run against the tenant.)
2. **Grant the consent**: Entra admin centre → App registrations → the Filer's app → API
   permissions → Add → Microsoft Graph → Application permissions → `Mail.Read` → Grant
   admin consent.
3. **Check** (the policy can take up to an hour): `Test-ApplicationAccessPolicy -Identity
   <a listed mailbox> -AppId <AZURE_CLIENT_ID>` says Granted, and Denied for one not listed.
4. **Turn it on**: set `intake_settings.mail_mailboxes` to the same addresses and
   `mail_enabled` to true. The first run only marks where each folder stands; it reads
   nothing older.

To see what the rules would do with a few sample messages, without any consent:
`python3 -m intake mail --dir <folder> --rules-only`.

**What is never read into the Hub.** `config/mail_rules.yaml` holds the never-share list:
pay, appraisals, HR, health, partners' own business, "eyes only", and anything marked
personal or private in the subject. It runs first, on the subject, the newest message, the
quoted thread and the attachment names, in the inbox and in sent items alike, and nothing
overrides it. A withheld message leaves one row saying that it happened and which list
caught it: no subject, no sender, no text. Mail from consumer addresses with no legal
terms, and newsletters and automated mail, are dropped the same way before Claude.

## Switches (`intake_settings`)

| key | default | what it does |
|---|---|---|
| `file_documents` | true | file what the Filer filed into the Hub project too |
| `documents_move_rows` | true | a filed document adds a line to the row it belongs to |
| `documents_set_status` | false | …and an outside sender's document may move a row from With Client / With Counterparty to With Client And AKLA |
| `auto_create_projects` | false | an unknown transaction with a code and a client creates its project without asking |
| `auto_create_rows` | false | an agenda line with no row creates the row without asking |
| `mail_enabled` | false | read the mailboxes in `mail_mailboxes` |
| `mail_move_rows` | true | an email's ask adds a line to the row it names |
| `mail_set_status` | false | …and a plain status word may change the row's status |
| `mail_notes` | true | keep a thread's gist as a project note |
| `claude_daily_calls` / `claude_monthly_usd` | 300 / 25 | the most the mail reader may read and spend |
| `sheet_sync` | true | the nightly Excel rewrite and read-back |

## Deploy

`deploy/deploy.sh` copies the code to `/opt/intake-service` on the Oracle VM, installs the
venv and starts the agendas, documents and mail timers (each starts
`intake@<command>.service`). The nightly sheet sync **writes the Excel on SharePoint**, so
its timer starts only with `deploy/deploy.sh --with-sheet-sync`. Secrets come from the chat
service's and the WhatsApp Filer's `.env` files; see `deploy/env`. The mail reader's Claude
key is the chat service's `ANTHROPIC_API_KEY`.

## Tests

`python3 -m unittest discover -s intake-service/tests` (from the repo root). The
fixtures are synthetic; no agenda or sheet content is in the repo.
