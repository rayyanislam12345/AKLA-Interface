# The claude.ai connector ("AKLA Hub")

A lawyer can use the firm's documents inside their own claude.ai. The Hub
runs a small MCP server with its own sign-in; claude.ai talks to it as a
custom connector. It reads the Hub, and (since slice 2 of the connector
plan) can save new versions into projects: claude.ai asks before every
save, every save is recorded, nothing is ever deleted. Code:
`chat-service/connector/`. Built 19 Oct 2026; saving added 20 Oct.

## For a lawyer: adding it

1. In claude.ai open **Customize > Connectors > Add custom connector**.
2. Name: `AKLA Hub`. URL: `https://aklachat.duckdns.org/mcp`. Add.
3. Click **Connect**. A sign-in page from the Hub opens: enter your Hub
   email and password, and the 6-digit code from your authenticator app if
   your account uses one. Then **Sign in and connect**.
4. Back in claude.ai, start a chat with the AKLA Hub connector turned on
   (the connectors button under the message box) and ask as you would ask
   the Hub's assistant: "what does section 199 of the Companies Act say
   about arm's length", "find our precedents on liquidated damages for
   delay", "list the M6 project's documents and summarise the latest
   concession agreement".

Only approved firm members can connect; an account awaiting approval is
refused at the sign-in page. Your password stays on the Hub's server. The
connector stays connected for thirty days of use at a time; after that, or
after an administrator withdraws it, claude.ai asks you to sign in again.

## Saving from claude.ai

The sign-in page says what the connector may do: read, and save into
projects. The tools marked "saves" in the table below are the ones that
change anything: two file what Claude wrote (`save_note_to_project` as a
Markdown file, `save_draft_to_project` as a Word file in the house format),
one fills the firm's own Word standard and files the result
(`fill_standard_to_project`, see "Drafting from the firm's standard"
below), and six are small housekeeping (a project's standing instructions,
a version's label, a document's title or status, an empty document record,
a re-read of a version). What to expect:

- **It asks first.** claude.ai asks you ("Allow once / Always allow")
  before each of these runs. In claude.ai's Research mode tools run
  without asking, so under the connector's **Tool permissions** set the
  saving tools to **Needs approval**.
- **Nothing is deleted or overwritten.** A save is always a *new* version
  number under your name, labelled "saved from claude.ai" with the date
  (you can give your own label); if a colleague saved a newer version in
  the meantime, yours is refused with "A newer version exists" rather than
  buried. There is no delete tool. The housekeeping tools replace one
  field (a label, the instructions) and say what the old value was.
- **Every save is recorded.** Who, which tool, which project, document and
  version, when, and whether it went through; never the text itself.
  Administrators can see the record.
- **Caps.** 30 saves an hour and 200 a day per person; the 31st in an hour
  is refused with one sentence. Only saves that went through count: a
  refused or failed attempt is on the record but does not use up the
  allowance. The Hub itself has no such limit.
- A version saved from claude.ai is your own filing: it is not marked as
  AI-generated, the Hub's search finds it like any other, and saving is
  filing, not legal approval.
- A connection made before saving existed is read-only until you remove
  the connector and add it again.

## Drafting from the firm's standard

Where the firm has a Word standard for a document type (a concession
agreement, say), ask for the document from the facts you have: "Draft a
concession agreement for the Hyderabad bypass from these facts". Claude
opens the standard itself (`open_standard_for_filling`: the same file the
Hub drafts from, its blanks numbered, with the Hub's own fill instructions),
asks you the firm's drafting questions for that type one at a time (the
listing tells Claude to ask before any fill), reads any part of the
standard the listing left out when a change belongs there, and then, once
you say which project and title to file under and claude.ai has asked you
to allow it, fills the real standard and files the result as version 1 of
a new document in the project (`fill_standard_to_project`). One fill runs
on the Hub at a time; a second is told to try again in a minute.
Open it in Word: your facts are in the right slots, every value you did not
give is still `[●]`, each open point is an "AKLA Comments" note in the
margin, and the numbering, styles, headers and contents page are as the
firm set them. The reply names any slot it could not fill and why. The
standard in the library is never changed; if an administrator replaced it
between the opening and the fill, the fill is refused and Claude opens it
again. The filed version is your own filing, labelled "Drafted from the
firm's standard in claude.ai" with the date.

## What it can do

Every answer carries the same `[Source n]` labels the Hub's assistant uses,
so Claude can cite what it relied on.

| Tool | What it does |
|---|---|
| `search_law_library` (query, act?) | Passages from the firm's law library: words and meaning, optionally within one Act; a query naming a section gets that section whole, first |
| `read_act_section` (act, section) | One section of an Act in full |
| `search_precedents` (query, document_type?) | Clause-level passages from the precedent library, at most three from one document |
| `list_projects` (includeClosed?) | The firm's projects with their ids, your starred projects first; open ones unless asked |
| `list_project_documents` (projectId) | A project's documents, every version with its id, the current one marked |
| `search_project_documents` (projectId, query) | Passages from a project's current documents |
| `read_document` (versionId, from?, chars?) | The plain text of one version, up to 20,000 characters a call, in slices; from the Hub's stored passages, or read from the file when it has none |
| `get_document_summary` (versionId) | The index card (what it is, parties, key dates, defined terms, outline, statutes mentioned), the proof check's counts and first findings, and what changed from the version before |
| `list_acts` () | Every law the firm's law library holds, by name, so the other law tools can be given the exact name |
| `get_act_outline` (act, from?) | The section numbers and headings of one Act in order, with its official link; in pages |
| `get_document_checks` (versionId, from?, recheck?) | Every finding of the proof check on one version (blanks, undefined and unused terms, broken cross-references, number/word mismatches, numbering gaps); worked out on the spot when the Hub has not stored it (one such read at a time, kept for the next page), and a stored "could not check" is reported unless recheck is asked |
| `compare_document_versions` (fromVersionId, toVersionId, from?, includeFormatting?, recheck?) | What changed, clause by clause, between any two versions of one document; formatting-only changes left out unless asked |
| `get_firm_rules` (task?) | The Hub's own rules for a draft, an answer or a review: search the precedents and the law library first, cite [Source n], quote a statute only from a passage in front of you, the house Markdown shape, a draft written in full |
| `list_precedents` (documentType?, page?) | The precedent library by document type, each precedent with the path to give `read_precedent` |
| `find_precedent_clauses` (query, documentType?) | The Precedent tab's clause search: up to three excerpts from each precedent that matches; slower (up to about 12 seconds) and one search at a time |
| `read_precedent` (storagePath, from?, chars?) | A precedent's whole text, up to 20,000 characters a call, in slices |
| `get_project_overview` (projectId, from?) | A project on one page: client, sector, standing instructions, relevant laws, and each document's latest version with its index card and whether the Hub has read it |
| `find_document_by_title` (query, projectId?) | Documents (and projects) whose title contains the words, with their ids and latest version |
| `search_everything` (query, projectId?, kind?, allVersions?, page?) | Words, or an exact phrase in quotes, across every project's document titles, indexed text, notes and tasks; 25 results a page |
| `list_document_types` (page?) | The firm's document types by category, 100 a page: which have a Word standard, and which a drafting questionnaire |
| `read_standard` (documentTypeId, from?, chars?) | A standard's text in slices, with the format rules the Hub drafts under |
| `get_drafting_decisions` (documentTypeId, from?) | A type's drafting questionnaire as numbered decisions, with the options, the legal basis and when each is asked |
| `open_standard_for_filling` (documentTypeId, from?, paragraphs?) | The firm's Word standard opened for a fill: every paragraph with a blank numbered ¶n with its exact text, every heading and the paragraphs around each blank, the rest as gaps naming the ¶ numbers they hide (`paragraphs: "100-140"` reads any range, 200 at a time), the Hub's own fill instructions and operations protocol, and a templateHash the fill must echo; paged, the first page carrying the instructions; bracketed footnotes are said to be the firm's drafting notes, not slots; the standard is never changed |
| `list_skills` (from?) | The firm's own skills by name: what each is for, written in the Hub or uploaded as a Claude skill, whether it produces a document, who added it and when; in pages |
| `read_skill` (skillId, from?, chars?) | A skill's instructions (the SKILL.md body of an uploaded skill) in slices of up to 20,000 characters, with the files the skill carries named; its scripts and templates run only in the Hub |
| `check_text` (text, from?) | The Hub's proof check on text Claude has written, before it is filed: blanks, undefined and unused terms, broken cross-references, number/word mismatches, numbering gaps, by clause; no model, nothing saved; up to 300,000 characters, in pages (the text is sent again with each page) |
| `compare_text_with_version` (versionId, text, from?, includeFormatting?) | What Claude's redraft changes against one stored version, clause by clause, before it is filed; the version's file is read on the spot when it is not already in memory (one such read at a time, kept for the next page); no model, nothing saved |
| `save_note_to_project` (projectId, text, title?, matterDocumentId?, expectedVersionId?, label?) — saves | Text written in the chat (a note, memo, summary) filed on a project as a Markdown version, as a new document or the next version of one; always a new version number, a stale `expectedVersionId` refused with "A newer version exists"; up to 600,000 characters; the Hub reads it within a minute |
| `save_draft_to_project` (projectId, markdown, title?, documentTypeId?, matterDocumentId?, expectedVersionId?, label?) — saves | The same, rendered first to a Word file in the house format (A4, Arial 11, navy banner, numbered outline, AKLA comments in the margin; up to a minute) with the format check's notes in the reply; if the renderer fails nothing is saved and the reply offers `save_note_to_project` |
| `fill_standard_to_project` (documentTypeId, projectId, title, ops, templateHash, matterDocumentId?, label?) — saves | Fills the firm's real Word standard for a type with the facts gathered (changes against the ¶n numbers from `open_standard_for_filling`, each quoting the paragraph's current text), accepts the fills, leaves every value not given as `[●]`, puts open questions in the margin as "AKLA Comments", keeps numbering, styles and the contents page, and files the result as a new version in the project; refused if the standard was replaced since it was opened (`templateHash`); up to 300 changes a call, one fill at a time on the Hub (a second is told to try again in a minute); the reply lists what could not be filled and why, the blanks left in the body, and that the standard's footnote drafting notes remain |
| `set_project_instructions` (projectId, content) — saves | Writes the project's standing instructions (the Project Context every Hub chat and overview sees), replacing the whole text; recorded with who wrote it and when |
| `label_version` (versionId, label) — saves | Gives one version a short label (up to 120 characters), replacing any it had |
| `rename_document` (documentId or versionId, title) — saves | Changes a document's title only; its type, status and versions are untouched (the type is changed on the Hub) |
| `set_document_status` (documentId or versionId, status) — saves | Moves a document along the status line (not started → drafting → internal review → with counterparty → negotiation → finalized → executed) |
| `create_document_record` (projectId, title, documentTypeId?) — saves | An empty document record on a project, status drafting, created by the lawyer, for a first version to be saved into |
| `reindex_document` (versionId) — saves | Asks the Hub to read one version again (text, index card, checks); a version already queued or being read is left alone |

Every project, version and project passage in an answer carries an
"Open in Hub: https://…" line (the site's address is `CONNECTOR_HUB_URL`),
so the lawyer can open it where it lives. The first eight tools live in
`chat-service/connector/tools.js`; the rest are modules under
`chat-service/connector/tools/` (its README gives the shape), loaded when
the connector starts, and `MODULE_TOOL_NAMES` in tools.js lists them for
the tests.

`find_precedent_clauses` runs the Precedent tab's search, which embeds the
question and the candidate paragraphs with Voyage (the firm's account is on
the free tier, three calls a minute). Voyage takes 64 paragraphs a request,
so the connector caps the pool at 64 (the Hub's own tab embeds up to 320,
six requests): a connector search is two Voyage calls, the question and
the pool. It also runs one at a time and tells a second caller to try again
in a moment; it rewrites the question with synonyms only when
`ANTHROPIC_API_KEY` is in the connector's environment.

It uses the assistant's own search (`chat-service/libraryTools.js`,
`retrieve.js`), so what it finds is what the Hub's chat would find.

## Seeing the document beside the chat

The companion (`hub-companion/`) is a small Chrome extension that watches
a claude.ai chat for the connector's "Open in Hub" links and shows that
page of the Hub in the browser's side panel, so the document, project or
chat sits beside the conversation instead of in another tab. It puts an
"open beside" button next to each link, opens the newest one on its own,
and has a toolbar button for pasting a link by hand. The panel is the real
Hub page, signed in once inside the panel: version compare, Checks and
What changed, accept and reject, drop a file in, download a copy.

**Embed mode.** The panel opens a page with `?embed=1` on any `/ai` route
(`/ai/d/<versionId>`, `/ai/p/<matterId>`, `/ai/c/<threadId>`). In that
mode the workspace has no sidebar: a one-line header names the place and
offers "Open in the Hub", which opens the same page in a new tab without
the mode. The choice is kept in `sessionStorage` (`hub-embed`), so links
inside the workspace keep it; `?embed=0` switches it off. Links to the
site's own pages ("Open on Project Hub", "open project") open the ordinary
Hub in a new tab, because those pages are not built for a 360px panel. The
sign-in page works inside the panel and comes back to the embedded page
afterwards (`/auth?next=<route>&embed=1`, written by `ProtectedRoute`).
Being inside a frame is only a hint; the query parameter is the switch.
Code: `src/lib/embedMode.ts`, `src/ai/layout/AiLayout.tsx`.

**Framing.** Only the Hub itself and the companion may frame the Hub.
`vercel.json` sends `Content-Security-Policy: frame-ancestors 'self'
chrome-extension://djjhabnppnfpboomokbikdjdoimgogdp` on every path (next to
the catch-all rewrite). That id is fixed by the `key` field in
`hub-companion/manifest.json`, so every unpacked install and every machine
gets the same one; nothing else can show the Hub's sign-in page inside a
frame of its own. If the Chrome Web Store ever assigns a different id (the
`scripts/package.sh --no-key` route), the header must name that id too, or
the panel shows Chrome's grey "refused to connect" page instead of the Hub
(the companion's README describes the symptom). Check after a deploy with
`curl -I https://akla-interface.vercel.app/ai` that the header is there.
(`vercel.json` is JSON, so this note lives here and not in the file.)
Chrome partitions a framed site's storage by the framing site, so the
panel's sign-in is separate from the lawyer's own Hub tab: once in the
panel, once in the tab, each kept until it expires. If the browser blocks
that storage altogether (third-party cookies off), the Hub keeps the
session in memory for as long as the panel page lives and asks for the
password again next time (`src/integrations/supabase/client.ts`).

**Planned: the document inside the claude.ai page (not built; owner is
still testing the side panel, 19 Oct 2026).** The same extension can
insert its own pane into the claude.ai tab instead of using Chrome's side
panel: a fixed pane on the right, 380-520px wide and draggable, that
shrinks the page by its width (set on `document.documentElement`, never on
claude.ai's own elements, so a redesign cannot break it), with the Hub
inside and the same bar (Home, Back, paste a link, Open in tab). The
"Open beside" buttons, the follow-new-links notice and the settings stay
as they are; a setting "Where to show it: in the page / Chrome side
panel" picks the view, in-page as the default, the side panel kept as the
fallback. Work needed, about half a day: (1) a `pane.js` in the content
script that builds the pane from a `<template>` and hosts
`chrome-extension://<id>/panel.html` in an iframe (extension pages are
exempt from claude.ai's page CSP; the inner Hub frame then has two
ancestors, the extension page and claude.ai, so `vercel.json` must add
`https://claude.ai` to `frame-ancestors`); (2) `background.js` routes
"open"/"show" to the pane in that tab when the in-page view is on, and
to the side panel otherwise; (3) a toggle on the "Open beside" button's
hint and the toolbar button to show or hide the pane; (4) the pane
remembers its width in `chrome.storage.sync` and survives claude.ai's
in-app navigation (the content script re-attaches it after a route
change; a full reload rebuilds it from `storage.session.panelUrl`).
Limits: still Chrome/Edge only, nothing in the desktop or mobile apps;
the pane covers nothing but can be squeezed on a narrow window (below
~1100px it falls back to a slide-over). A later route is MCP Apps (the
connector sending a card that renders inside Claude's reply); it is the
only one that would reach the desktop and mobile apps, but field reports
say it does not yet work reliably for custom connectors on the web.

## What it cannot do (this version)

- It never **deletes** or replaces anything: a save is always a new
  version number, and a save onto a version a colleague has since
  superseded is refused with "A newer version exists". There is no delete
  tool. Reviews and tracked changes stay on the Hub for now (later slices).
- It does not see the Hub's **chats or chat files** (`ai-chat-files`),
  timesheets, clients' contact details or anything outside projects,
  documents, precedents, the firm's skills and the law library. A skill's
  scripts and templates run only in the Hub: `read_skill` gives the
  instructions, not a way to run them.
- Each tool call is on its own: source numbers start at 1 in every result
  (the Hub's chat keeps one numbering for a whole conversation).
- Case law is not included (the Hub's rule).
- Nothing is logged in the Hub about what a lawyer asked in claude.ai; the
  connector's journal records which tool was called by whom and how long it
  took, not the question.

## How it works

```
claude.ai ──https──> Caddy (aklachat.duckdns.org)
                        ├─ /mcp, /oauth/*, /.well-known/oauth-* ──> hub-connector  127.0.0.1:8095
                        └─ everything else                       ──> chat-service   127.0.0.1:8092
```

**Transport.** MCP over Streamable HTTP at `POST /mcp`, stateless: every
request gets its own MCP server, so a restart loses nothing and no session
table is needed. `GET /mcp` answers 405.

**Sign-in and tokens (OAuth 2.1).** The connector is its own authorization
server. claude.ai reads `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource`, registers itself at
`POST /oauth/register` (dynamic client registration; public client, PKCE
S256 required), sends the lawyer to `GET /oauth/authorize`, and exchanges
the code at `POST /oauth/token`. The authorize page is a server-rendered
form (`connector/pages.js`): email, password, authenticator code, and a line
naming the address the lawyer will be sent back to. The server signs the
lawyer in against Supabase Auth with the publishable key exactly as the site
does (`signInWithPassword`, then the TOTP challenge when the account's next
assurance level is aal2), checks `is_firm_member` (profiles with
`status = 'approved'`), drops that throwaway Supabase session with a *local*
sign-out (the lawyer's own Hub sessions on their laptop and phone are never
touched), and issues its own tokens:

- access token `akh_t_…`, one hour; refresh token `akh_r_…`, thirty days,
  rotated on every use in one conditional update. A rotated refresh token
  presented again within 60 seconds (a lost response, two conversations
  refreshing together) gets a fresh pair in the same sign-in; presented
  later, it counts as leaked and the whole sign-in is revoked at once.
  Authorization code `akh_a_…`, five minutes, single use.
- A client may only register redirect addresses on `claude.ai` or
  `claude.com` (and their subdomains; `CONNECTOR_REDIRECT_HOSTS` to change),
  so the firm's sign-in page cannot be pointed at an outsider's address.
  `http://localhost` is accepted only with `CONNECTOR_ALLOW_LOOPBACK=1` on a
  dev box. Two scopes exist: `hub:read` (search and read) and `hub:write`
  (save new versions into projects). The 401 challenge and the discovery
  documents name both, so claude.ai asks for both; a client that asks for
  neither is granted both (the owner's choice); a scope the connector does
  not know is dropped rather than refused, and the token response says what
  was granted. A token issued before `hub:write` existed carries `hub:read`
  only, through every refresh, until the lawyer reconnects; such a sign-in
  is never shown the saving tools and is told so if it calls one.
- Only SHA-256 hashes are stored, in `connector_clients`,
  `connector_auth_codes` and `connector_tokens`
  (`supabase/migrations/20261019150000_connector_tokens.sql`, service role
  only). No Supabase JWT is ever sent to claude.ai.
- The sign-in form is rate-limited: five failures per email *and address*,
  twenty per address, in fifteen minutes (an outsider posting wrong
  passwords for a partner's email locks out only their own address);
  registrations thirty an hour per address. Every refusal is logged with
  the email and address.
- On every `/mcp` call the bearer token is checked (cached a minute) and
  the firm membership asked afresh (one `is_firm_member` call, as the site
  pays on every query); every refresh asks too and ends the sign-in when the
  answer is no. An approval withdrawn on the Team page cuts the connector
  off on the next request.

**Data scoping.** Tools run with the service role and apply the Hub's rule
for a firm member: every approved member sees every project, document,
precedent and Act, as the site does. `list_projects` hides closed projects
unless `includeClosed` is true. Results are text, at most 30,000 characters.

**Writes** (`connector/projectWrites.js`). Every saving tool is marked for
claude.ai as not read-only *and* destructive (`WRITE` in `app.js`), so
claude.ai asks before every call ("destructive always prompts" is the only
documented rule; whether a merely not-read-only tool prompts is checked
live on the first save, after which the new-version-only saves may be
relaxed). Each one: re-checks the sign-in afresh (the token row by its
hash, not the minute's cache), counts the person's writes in
`connector_actions` (the rows with outcome `saved` or `done`, plus the
writes this process has begun and not yet recorded, so several calls in
one claude.ai turn cannot slip past the cap together: 30 in the last hour,
200 in the last day; the 31st is refused with one sentence; the counts
survive a restart because they live in the table), uploads the file to
the `matter-documents` bucket under the site's own path shape, calls
`save_document_version_as` as the lawyer
(migration `20261020120000_connector_writes.sql`: the site's
`save_document_version` with the user id as a parameter; the site's
function is now a wrapper around it), takes the upload back if the
function refuses, and writes one `connector_actions` row (who, tool,
project, document, version, label, outcome, when; never the text). The
version is the lawyer's own filing: `uploaded_by` is them,
`is_ai_generated` is false so the Hub's meaning search finds it, and the
label says "saved from claude.ai". Indexing is queued by the database
trigger on `document_versions`, as for a save on the site. Any firm member
may save into any project (there is no per-project membership on the Hub);
the record is the control.

**Housekeeping writes** (`connector/tools/housekeeping.js`). The six small
writes (instructions, label, title, status, an empty record, a re-read)
pass the same gate (`checkCaps`: the sign-in afresh, then the caps) and
leave the same `connector_actions` row, but write what the site's own page
writes rather than a version: `matter_context` upserted on `matter_id` with
`updated_by`, `document_versions.label`, `matter_documents.title` or
`.status` (the `document_status` enum; never `document_type_id`), a
`matter_documents` row with `created_by`, or the `enqueue_index_job`
function. A refusal before the statement (not found, same value, too long)
is recorded as `refused`, a database error as `failed`. None needs the
connector-writes migration beyond the `connector_actions` table.

## Administrators

Withdraw one person's access (they will be asked to sign in again; an
access token already in the minute's cache keeps working for up to a
minute, every refresh is refused at once):

```sql
update public.connector_tokens set revoked_at = now()
 where revoked_at is null
   and user_id = (select id from auth.users where email = 'name@akla.com.pk');
```

Withdraw everyone (after a suspected leak, or to force a fresh sign-in):

```sql
update public.connector_tokens set revoked_at = now() where revoked_at is null;
```

Removing a person's approval on the Team page (profiles.status) also stops
the connector on their next request, with no SQL.

See who is connected (`rotated_at` marks a refresh token already replaced
by its successor):

```sql
select u.email, t.kind, t.created_at, t.last_used_at, t.expires_at
  from public.connector_tokens t join auth.users u on u.id = t.user_id
 where t.revoked_at is null and t.rotated_at is null and t.expires_at > now()
 order by t.created_at desc;
```

Prune old rows (codes a day past expiry, tokens a week past): `select public.connector_prune();`

See what the connector has saved, and by whom (the record never holds the
document's text):

```sql
select u.email, a.tool, a.outcome, a.label, a.project_id, a.version_id, a.created_at
  from public.connector_actions a join auth.users u on u.id = a.user_id
 order by a.created_at desc limit 50;
```

The write caps are per person: 30 rows in the last hour, 200 in the last
day (`HOURLY_CAP`, `DAILY_CAP` in `connector/projectWrites.js`). To stop
one person saving without withdrawing their reading, block the saving
tools for them under Tool permissions in claude.ai; to stop everything,
withdraw their tokens as above.

**Rotating.** The connector has no signing key to rotate: tokens are random
and stored hashed. To rotate the Supabase keys, change them in
`/opt/chat-service/.env` and `sudo systemctl restart hub-connector` (and
chat-service, index-worker). To make every lawyer sign in afresh, run the
"withdraw everyone" line. To start again completely (new client ids too):
`delete from public.connector_clients;` (cascades to codes and tokens);
each lawyer then removes and re-adds the connector in claude.ai.

**Settings** (`hub-connector.service`): `CONNECTOR_PORT` (8095),
`CONNECTOR_ISSUER` (`https://aklachat.duckdns.org`; the issuer in the
discovery documents and the resource claude.ai asks for),
`CONNECTOR_REDIRECT_HOSTS` (comma-separated; default `claude.ai,claude.com`),
`CONNECTOR_HUB_URL` (the site's address for the "Open in Hub" lines on
results; default `https://akla-interface.vercel.app`) and
`CONNECTOR_ALLOW_LOOPBACK` (never on the VM). The rest comes from
`/opt/chat-service/.env`. Saving has no setting of its own: the scope
`hub:write` is granted at every sign-in, the caps are fixed in
`connector/projectWrites.js`, and the migration below must be applied.

**Logs:** `sudo journalctl -u hub-connector -f`. One line per sign-in,
registration and tool call (tool, user id, length, milliseconds), and a
line for every refusal with its reason.

## Deploying (manual, in this order)

1. **Migrations.** Apply `supabase/migrations/20261019150000_connector_tokens.sql`
   to the project (SQL editor or the management API). Safe to run twice.
   Until it is applied, the connector starts but every registration and
   sign-in fails with "Could not save…" in its journal. Then
   `supabase/migrations/20261020100000_search_project_content_as.sql`,
   which gives `search_everything` its search as the signed-in lawyer (the
   site's own `search_project_content` becomes a wrapper around it; also
   safe to run twice). Until it is applied `search_everything` answers with
   a sentence naming the migration and every other tool works. Confirm with
   `select has_function_privilege('service_role', 'public.search_project_content_as(uuid,text,uuid,text,boolean,integer,integer)', 'execute');`
   Then, before any saving tool is deployed,
   `supabase/migrations/20261020120000_connector_writes.sql`:
   `save_document_version_as` (service role only; the site's
   `save_document_version` becomes a wrapper around it, so a save on the
   site must be tried once afterwards) and the `connector_actions` record.
   Safe to run twice. Confirm with
   `select has_function_privilege('service_role', 'public.save_document_version_as(uuid,uuid,uuid,uuid,boolean,uuid,text,text,text,boolean,text,text)', 'execute');`
   and `select count(*) from public.connector_actions;`. After deploying,
   each lawyer removes and re-adds the connector in claude.ai (a token from
   before carries `hub:read` only), checks the sign-in page's wording, and
   sets the saving tools to "Needs approval" under Tool permissions.
2. **Code.** From the repo, `chat-service/deploy.sh`. It copies
   `connector/*.js` and `connector/tools/*.js` to
   `/opt/chat-service/connector/` (with `firmRules.js` and
   `documentInsight.js` at the service root), installs
   `hub-connector.service` (install + restorecon, as for the index worker),
   runs `npm install` (which adds `@modelcontextprotocol/sdk` and `zod`), and
   restarts chat-service, index-worker and hub-connector. The last lines
   print both health checks and a NOTE if Caddy is not routing yet.
3. **Caddy.** Replace the `aklachat.duckdns.org` block in
   `/etc/caddy/Caddyfile` on the VM with the one in `chat-service/Caddyfile`
   (the `@connector` matcher sends `/mcp`, `/oauth/*` and the two
   `.well-known` paths to 8095; everything else stays on 8092). Then:
   One command does this, with a backup and a validate: `bash chat-service/caddy-connector.sh`.
   Otherwise, by hand:
   `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
4. **Check.** `curl -s https://aklachat.duckdns.org/.well-known/oauth-authorization-server`
   should return the JSON with `"issuer":"https://aklachat.duckdns.org"`;
   `curl -s -X POST https://aklachat.duckdns.org/mcp` should return 401 with a
   `WWW-Authenticate` header. Then add the connector in claude.ai (steps
   above) with your own account and run one search.

Rolling back: `sudo systemctl disable --now hub-connector`, restore the
Caddy block, reload Caddy. The tables can stay.

## What cannot be known until it runs on the VM

- Which exact OAuth steps claude.ai's connector client takes in October
  2026 (whether it registers once per user or once per workspace, whether
  it sends `resource`, which redirect URI it registers). The server follows
  the published specification (RFC 8414, 9728, 7591, PKCE S256, refresh
  rotation) and accepts both public and confidential clients, so it should
  not matter; the journal shows what arrived if it does. One thing to watch:
  the redirect URI claude.ai registers must be on `claude.ai` or
  `claude.com`. If the journal shows a registration refused with
  `invalid_redirect_uri` naming another host, add that host to
  `CONNECTOR_REDIRECT_HOSTS` in `hub-connector.service` and restart.
- The 401 challenge names `/.well-known/oauth-protected-resource/mcp`
  (the RFC 9728 path-inserted form for a resource at `/mcp`); the root
  document is served too for a client that looks there first.
- Whether claude.ai's edge reaches the VM quickly enough for a search: the
  Hub's search returns within 12 seconds (its deadline); a document read
  from the file can take longer for a scanned PDF. If claude.ai times out,
  lower the chunk asked for or wait for the index worker to read the file.
- The SDK (`@modelcontextprotocol/sdk` 1.32.1, `engines >= 18`) was run
  here on Node 26; the VM has Node 20.20. The grep for Node 22-only
  builtins is clean in our code; the SDK's own `dist` was checked for the
  same names and uses none. The first start on the box is the proof.
- Saving (slice 2), once the connector-writes migration is applied and the
  connector reconnected in claude.ai: that the first save prompts "Allow
  once / Always allow" (every saving tool is marked destructive for now,
  the one documented way to make claude.ai ask; if a not-read-only tool
  also prompts on its own, the new-version-only saves can be relaxed); that
  the sign-in page's new copy shows; that `save_document_version_as`, owned
  by postgres, can still read `storage.objects` for its "uploaded file is
  unavailable" check (the site's original ran as the signed-in user); how
  long one `save_draft_to_project` takes on the box (python3, `.akla-venv`
  and `akla/build_docx.py` beside `aklaRender.js` under `/opt/chat-service`;
  the local machine has no venv, so the tests stub the renderer); and that
  `read_skill` on an uploaded skill returns the SKILL.md body (written to
  `ai_skills.instructions` at upload) rather than only its description.
