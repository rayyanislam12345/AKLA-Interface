# Intake phases 2 and 3: the contracts between the parts

Written 23 Nov 2026. The schema is `supabase/migrations/20261123100000_intake_documents_names_actions.sql`
(applied live). Phase 1 is `20261111090000_transactions_hub.sql`. Read both before writing code.

## What the two phases do

- **Phase 2.** A document the WhatsApp Filer has filed on SharePoint is filed into its Hub project
  as the next version of the right document, and the Transactions row it belongs to gets a dated
  line saying so. Nothing in the Filer changes: the intake reads the Filer's own record.
- **Phase 3.** (a) Every project is known by all its names, on the Hub (`project_names`), and a
  transaction the Hub has no project for is proposed in the tray. (b) Firm mailboxes are read with
  one application consent; rules drop or withhold mail before Claude sees it; one capped Claude
  read per remaining message gives project, deliverable, ask, status word and gist; a sure match
  adds a line to the row and keeps the gist as a project note; an unsure one goes to the tray.
- Everything automatic is written to `intake_actions` and can be undone by any firm member through
  the database function `undo_intake_action(p_action_id uuid)`.

## Rules for every builder

- Do not commit, push, deploy, or write to the live database or SharePoint. Local dry runs only.
- Touch only the files your brief lists. Other builders are working in the same tree at the same
  time; a file outside your list may be mid-edit, and its tests may be red through no fault of yours.
- Python: standard library plus openpyxl, pyyaml, certifi (and `anthropic` only where the mail
  classifier needs it, imported lazily so everything else runs without it). Python 3.11 on the VM.
- Comments say what and why in plain words, as the existing files do. No secrets, real phone
  numbers or real email addresses in code, tests or fixtures.
- User-facing words: "project" (never "matter"), "Needs a look" (the tray), plain sentences.

## Foundation already written (do not rewrite)

`intake/db.py` `Db`:
- `select(table, filters, columns='*', order=None, limit=None)`, `one(...)`, `insert(table, rows)`,
  `upsert(table, rows, on_conflict)`, `patch(table, filters, data)`, `delete(table, filters)`.
- `rpc(function, args, write=True)`: POST `rpc/<function>`; on a dry run a write returns None.
- `storage_upload(bucket, path, data, content_type)`: never overwrites. `storage_remove(bucket, paths)`:
  only for an object this run uploaded and could not use.
- `setting(key, default)` reads `intake_settings`.
- Dry run: writes are printed and return made-up ids. Tests use a small in-file FakeDb
  (see `tests/test_sync.py`); extend that pattern, do not hit the network.

`intake/actions.py`:
- `new_group()`.
- `record(db, kind, source, summary, *, source_ref, detail, group_id, matter_id, row_id, document_id,
  version_id, update_id, note_id, intake_document_id, message_id, before, after)` → the action row.
- `add_row_update(db, row, body, *, source, source_ref, at, author, author_id, changes, summary,
  detail, group_id, intake_document_id, message_id)` → `(update, action)`. Adds the dated line,
  applies `changes` (`status`, `currently_with`) when they differ, logs `row_update` or `row_moved`
  with before/after. **Every automatic line on a row goes through this**, so it can be undone.

`intake/hub.py`: `load_rows`, `People(db).id_for(name)`, `start_run(db, kind)`, `finish_run(...)`,
`now_iso()`, and `intake_user_id(db)`: the id of the approved profile named "Hub Intake", or None.
A filing needs that id; when it is None the documents command files nothing and says why.

Run kinds now allowed: `agendas, sheet_sync, load, documents, mail, projects`.

## The matcher's API (owned by the names builder; everyone else only calls it)

```python
m = Matcher(db=None)            # db given: overlays the Hub's project_names and matters on the YAML
m.resolve_transaction(text)     # -> (entry, score)            unchanged from phase 1
m.entry_for_code(code)          # -> entry or None             the transaction a Filer code names
m.matter_for_code(code, text='')# -> matter_id or None         its Hub project; `text` (a title or
                                #    deliverable) picks among sister projects by 'contains' names
m.matter_for(client, project, deliverable)   # unchanged
m.candidate_rows(rows, entry)   # unchanged
m.match_row(texts, rows, transaction='')     # -> (row, score, top3) unchanged
m.grade(t_score, d_score)       # -> 'high' | 'unsure' | 'none' unchanged
m.person(text)                  # unchanged
```
An `entry` keeps its phase 1 keys (`code, pairs, new_row, aliases, matter_id, matter_rules`) and
gains `name` (the transaction's name) and `matters` (every Hub project id under the code).

## The Filer's record (read-only; phase 2's only input)

On the VM: `/opt/whatsapp-filer/state/filed.sqlite`, table `files`. Open with
`sqlite3.connect('file:<path>?mode=ro', uri=True)`. A local copy for dry runs is at
`~/AKLA - Agenda Extractor/state/filed.sqlite` (a 23 Oct snapshot; it may lack `own_number`).

Columns used: `id, created, action, sha256, quickxor, original_name, chat, sender, sent, caption,
code, transaction_name, document, title_key, filed_name, folder, web_url, duplicate_of, version_of,
reason, fields`. `fields` is JSON: `{transaction, title, document_type, party, status,
document_date, confidence, note}`.

- Take only `action = 'filed' AND web_url IS NOT NULL AND code IS NOT NULL`. A filed row with no
  `web_url` was never confirmed uploaded. Agendas and CVs have `code` NULL.
- The file is at `<DATA_ROOM_PATH>/<folder>/<filed_name>` on SharePoint: `Graph().download(rel)`
  with `rel = folder + '/' + filed_name` (any size). The Filer's tools may rename or move a file
  later and rewrite its sqlite row, so read the row fresh each run and treat a 404 as "try again
  next run" (count `attempts`; give up as `error` after 5).
- `version_of` is the sqlite id of the previous version of the same document (same code and
  title). It is the strongest signal that two files are one Hub document.
- Source: `chat` starting `Outlook - ` is email: `"Outlook - <mailbox> (Inbox|Sent)"`; `caption`
  is then the subject and `sender` is `Name <address>` or a bare name. Anything else is a WhatsApp
  group name; `sender` is a person's name or `"<pushname> (<number>)"` and `caption` is usually
  just the filename. `sent` is UTC without a "Z" (older seed rows are Pakistan local; accept both).
- Filer status words: Draft, First Draft, Revised Draft, Mark-up, Comments, Clean, Final,
  Execution Version, Executed, Signed, Received, Notes.

## Filing a version in the Hub (phase 2)

Bucket `matter-documents`. Path `<matterId>/<docId>/<uuid4>-<stem>.<ext>`; the stem is the filed
name without extension, with characters outside `[\w\s-]` removed, spaces turned to `-`, at most
180 characters. Order of work, exactly as the connector does it (`chat-service/connector/projectWrites.js`
`saveVersion`, lines 276-365; read it):

1. For a next version: read `matter_documents (id, title, matter_id, document_type_id)` and the
   latest `document_versions` row (highest `version_number`).
2. `db.storage_upload('matter-documents', path, bytes, content_type)`.
3. `db.rpc('save_document_version_as', {p_user_id, p_matter_id, p_document_type_id, p_document_id,
   p_create_new, p_expected_version_id, p_title, p_storage_path, p_file_stem, p_is_ai_generated: false,
   p_extension, p_label})` → `{matterDocumentId, versionId, versionNumber, fileName}`.
   - `p_user_id` = `hub.intake_user_id(db)`.
   - `p_document_id` is a fresh uuid4 for a new document (`p_create_new: true`), else the document.
   - For a next version `p_document_type_id` must equal the document's stored type (null included)
     and `p_expected_version_id` is the latest version's id.
   - `p_label`: where it came from, e.g. `From WhatsApp (AKLA TEAM - OFFICE) · Usama · 17 Oct 2026`
     or `From email · <sender name> · 17 Oct 2026`.
4. On an RPC error: look up `document_versions` by `storage_path`; if a row exists the save
   succeeded (use it); otherwise `storage_remove` the object and record the error.
5. Then `patch document_versions set content_hash = <sha256 hex>` and, for an extension outside
   `pdf, docx, xlsx, xls, pptx, txt, md, csv`, `indexing_status = 'unsupported'`. A trigger queues
   indexing for the rest; on a `--backfill` run set that job's `priority` to -1
   (`document_index_jobs` where `document_version_id` = the new version).
6. For a new document, set `matter_documents.status` from the Filer's status word, and
   `document_type_id` is chosen before the save from `document_types.name` matching the Filer's
   `fields.document_type` (normalised equality; else null).

Which document: within the project,
- the Hub document the `version_of` chain already landed in (via `intake_documents.filer_id`) wins;
- else an **exact** family-key match of the Filer's title against `matter_documents.title`
  (port `familyKeyOf`, `parseFileName` and `findMatchingDocument` from `src/lib/fileNames.ts`;
  tests in `tests/fileNames.test.js` show the expected behaviour) files as the next version;
- else a close match (score at least 0.75, numbers agreeing) goes to the tray as `document_unsure`;
- else it is a new document.
- A file whose sha256 equals a `content_hash` already on the project is `duplicate`: nothing filed.

Document status from the Filer's word: Draft, First Draft, Revised Draft, Clean → `drafting`;
Mark-up, Comments → `negotiation`; Received → `with_counterparty`; Final, Execution Version →
`finalized`; Executed, Signed → `executed`; Notes → leave as it is.

## The row line a filing writes (phase 2)

Only when `intake_settings.documents_move_rows` is true. Candidate rows are the project's
(`transaction_rows.matter_id` = the project, else `matcher.candidate_rows(rows, entry)`), matched
with `matcher.match_row([title, original_name], candidates, transaction_name)` and
`deliverable_high`. Sure match → `actions.add_row_update` with

- body: `"<Status word> received from <sender first name or full external name> by <WhatsApp|email>: <filed_name>"`
  when the sender is outside the firm, `"<Status word> sent by <first name> (<group or 'email'>): <filed_name>"`
  when a firm person sent it. Keep it one plain sentence.
- `source` = `whatsapp` or `email`, `source_ref` = `filer:<id>`, `at` = the message's sent time,
  `author` = the sender's first name when they are a firm person (`People`), `author_id` likewise.
- `changes` only when `documents_set_status` is true: an outside sender on a row that is
  `With Client` or `With Counterparty` → `status: 'With Client And AKLA'`. Nothing else.

No sure row → no line; the document is filed all the same. Never tray a row match for a document.

## `intake_actions` conventions (the front end renders these as written)

| kind | summary | detail |
|---|---|---|
| `version_filed` | `"<title> · v<n> filed"`, or `"<title> · new document"` for v1 | `{title, version_number, file, from, chat, sent, via: "WhatsApp"\|"email", created_document: bool, web_url, doc_status}` |
| `row_update` / `row_moved` | `"<deliverable>: <the line>"` | `{from, chat, sent, via, file?}` |
| `note_added` | the note's first 140 characters | `{from, via, subject?, messages: n}` |
| `row_created` | `"<deliverable> · new row"` | `{from, via, client, project}` |
| `project_created` | `"<project name> · new project"` | `{client, code}` |

`source` is `agenda`, `whatsapp`, `email` or `excel`. `source_ref` is the agenda file name,
`filer:<id>`, or the message key. One arrival shares one `group_id`.

## Tray kinds: payload and guess keys (Python writes them; the front end reads them)

Phase 1 kinds are unchanged, except agenda payloads gain `code` (the resolved transaction's code,
or null) and `transaction_known` (bool).

| kind | payload | guess |
|---|---|---|
| `document_no_project` | `{intake_document_id, file, title, transaction, code, person, chat, date, web_url, via}` | `{new_project: {name, client, code}}` or `{matter_id, confidence}` or null |
| `document_unsure` | same as above plus `matter_id` | `{document_id, document_title, confidence}` |
| `document_undone` | `{intake_document_id, file, title, transaction, person, chat, date, web_url, was_matter_id}` (written by the undo function) | null |
| `new_project` | `{name, code, count, seen: [{where, person, date}]}` (`name` is the string as seen; `seen` holds up to 5) | `{new_project: {name, client, code}, near: [{matter_id, name, confidence}]}` |
| `message_unsure` | `{message_id, message_key, person, date, transaction, deliverable, scope, ask, status, via: "email", matter_id}` (`message_key` is the Internet-Message-ID, the same string automatic lines carry as `source_ref`; `date` is the full sent timestamp) (`scope` is the gist, `ask` the action item, `status` a proposed status word or "") | `{row_id, confidence, row_deliverable, others: [{row_id, deliverable, confidence}]}` or null |

How each is resolved (`intake_tray.status`, `resolution`):

- `document_no_project`, `document_undone`: the person picks a project → `accepted`,
  `{matter_id}`. The intake files it on its next run and adds `{filed: true, version_id}` to the
  resolution. Drop → `dropped`; the intake marks the document `skipped`.
- `document_unsure`: "Yes, the next version" → `accepted`, `{matter_id, document_id}`; "A new
  document" → `accepted`, `{matter_id, new_document: true}`. The intake files it on its next run.
- `new_project`: "Create the project" creates the client (found by name, or new), the project
  with its `code`, its six stages, and a `project_names` row for the seen name; → `accepted`,
  `{matter_id}`. "It's this project" adds a `project_names` row (`kind: 'learned'`, `source:
  'tray'`) → `accepted`, `{matter_id}`. On its next run the intake points any `project_names`
  rows that carry only that `code` at the project and files the documents that were waiting.
- `message_unsure`: "Yes, that row" / "Another row" → the front end adds the line itself
  (`transaction_updates`, `source: 'email'`, `source_ref`: the message key, body = `ask || scope`),
  → `accepted`, `{row_id}`.
- An accepted agenda line whose payload has `transaction_known: false` and whose row has a
  project also adds a `project_names` row (`kind: 'learned'`, `source: 'tray'`, `name`: the
  payload's `transaction`), so the same name is never asked about again.

**A document whose code has no Hub project is not put in the tray one by one.** It is recorded
as `trayed` with the reason `waiting for a project (<code>)`, and the one `new_project` item for
that code carries the count and the latest few in `seen`. When the project exists (the item was
accepted, or the owner's backfill created it), the next run files everything that was waiting.
`document_no_project` is only for a filed row whose code names no transaction the intake knows.

`projects.propose_project(db, matcher, name, code=None, seen=None, client=None)` (names builder)
writes or updates that one open `new_project` item per name: callers pass
`seen = {'where': <file or subject>, 'person': <who>, 'date': <iso>}` and it keeps the latest
five and the count. It does nothing when the name already resolves to a project.

## Settings (`intake_settings`)

`file_documents` (true), `documents_move_rows` (true), `documents_set_status` (false),
`auto_create_projects` (false), `mail_enabled` (false), `mail_mailboxes` ([]), `mail_move_rows`
(true), `mail_set_status` (false), `mail_notes` (true), `claude_daily_calls` (300),
`claude_monthly_usd` (25). Phase 1: `auto_create_rows`, `sheet_sync`, `stale_after_days`.

## Mail (phase 3)

- Graph application permission `Mail.Read` on the same Entra app the Filer uses, scoped to the
  firm's mailboxes by an application access policy. The owner grants it; until then
  `mail_enabled` is false and the command does nothing but say so.
- Mailboxes: `intake_settings.mail_mailboxes`. Folders: `inbox` and `sentitems`.
- State: `intake_mail_state (mailbox, folder, delta_link, baseline_at)`. The first run for a
  folder records a baseline and reads nothing older. Save the cursor after the batch. On 400/410
  for a stored cursor, start a fresh baseline.
- One email seen in several mailboxes is handled once: `intake_messages.message_key` is the
  Internet-Message-ID; later sightings only add the mailbox to `mailboxes`.
- Rules before Claude, ported from the Email Bot (`~/AKLA - Email Bot/config/rules.yaml`,
  `src/emailbot/classify/rules.py`; read both, change neither): never-share first and final,
  then a work signal escalates, automated mail is dropped, consumer-domain mail with no work
  signal is dropped, everything else goes to Claude. **Withholding has no exceptions here**:
  sent mail is withheld like any other. The never-share list for the intake is wider than the
  bot's: add partners' matters (partnership, profit share, partners' meeting, drawings), HR
  (bonus, increment, termination of employment, resignation, leave application, medical),
  and anything marked personal or private and confidential in the **subject**. Keep the bot's
  warning: disclaimer phrases must never be on the list.
- A withheld message leaves a row with `outcome: 'withheld'`, the rule, the time, the mailbox,
  and **no subject, sender or body**. A dropped message keeps sender class and rule, no subject.
- Claude: one call per message that survives the rules, structured output, model
  `claude-haiku-5-5`, the newest message (6000 characters) separate from the older thread (2500),
  "today" anchored to the Sent date, the list of transactions (`code - name - aliases`) in the
  cached system prompt. Fields: `category` (work, personal, automated, unknown), `withhold`
  (bool, for anything the rules missed: an individual's pay, appraisal, discipline, health, or
  mail marked for one person's eyes), `transaction` (a code, or NONE), `deliverable` (the document
  or task the message is about, in the firm's words, or ""), `status` (one of the eight
  Transactions status words, only when the message plainly says the deliverable has gone to or
  come back from someone; else ""), `currently_with`, `action_items` ([{what, due, owner}]),
  `gist` (one sentence, 25 words at most, what the newest message says or asks and by when; only
  facts in it; dates as calendar dates), `confidence` (low, medium, high).
  On any failure: nothing is acted on; the message is recorded as `error` and retried next run.
- Caps: `claude_daily_calls` and `claude_monthly_usd`, counted in `intake_usage`. Over a cap,
  messages wait (they are not recorded; the cursor does not advance past them).
- Acting, in order: no transaction or not work → `nothing`. Project resolved
  (`matcher.matter_for_code`) and deliverable matched to a row (`match_row`, `deliverable_high`)
  with medium or high confidence → `add_row_update` (`mail_move_rows`): body is the ask with its
  date when there is one (`"Owais Sb asks for the mark-up by 19 Oct"`), else the gist; `changes`
  only when `mail_set_status` is true and the status word is given with high confidence. Then the
  note (`mail_notes`): one `matter_notes` row per conversation per day, `author_id` the Hub Intake
  account, content `"From email · <subject>\n<gist(s)>"`, appended to when the same conversation
  writes again the same day; logged as `note_added`. A project but no sure row →
  `message_unsure` in the tray (and the note is still kept). An unknown transaction name that the
  message plainly treats as a project → feed the `new_project` proposal.
- Group chat text is not captured by anything today (the Filer's reader saves documents only), so
  WhatsApp status words wait on a change to the Filer that its owner has to agree to. Write the
  message handling so a second source can be added: the classifier and the acting step take a
  neutral message dict, not a Graph object.
