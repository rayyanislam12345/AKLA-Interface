# chat-service

The AI Workspace's chat endpoint, moved off Supabase Edge Functions onto the
Oracle VM. `server.js` is `supabase/functions/chat/index.ts` ported to Node
and `extractText.js` is `_shared/extractText.ts`; the two pairs must be kept
in step until the edge function is retired.

## Why move it at all

Supabase kills an edge function at about 150 seconds of wall clock with no
chance to clean up. A full agreement takes longer than that to write, so
`supabase/functions/chat/index.ts` stops itself at 115s, saves the partial
reply, and has the browser call back with `continueMessageId` to resume.

That works, but every resume replays the **entire grounded system prompt** —
up to 16 retrieved sources at 8,000 characters each, roughly 32k tokens —
plus the partial written so far. The longest reply in the database is 87,556
characters; at four or five rounds that turn spent something like 215k input
tokens where one uncapped call would have spent about 32k.

Off the edge runtime there is no ceiling, so the whole mechanism goes away.

## Why this box and not the droplet

Measured 2026-09-09. Both hosts are ~1.7ms from Supabase, so latency doesn't
decide it; capacity does.

| | Oracle `instance-ocr-akla` | DigitalOcean `akla-droplet` |
|---|---|---|
| RAM free | 4.3 GB of 5.5 GB | 108 MB of 961 MB |
| Load, 1 core | 0.16 | 1.30 |
| Arch | aarch64 | x86_64 |

The droplet is already saturated running Chromium for wppconnect. Chat
assembles ~130KB prompts and holds streaming connections; it belongs on the
idle box. ARM is fine here — `mammoth`, `unpdf`, `xlsx` and `fflate` are all
pure JavaScript. Chromium is the reason WhatsApp stays on x86; keep that split.

## What the port changed, and what it kept

**Gone** — the wall-clock deadline (`GENERATION_BUDGET_MS`,
`MIN_USEFUL_SLICE_MS`) and the "save a partial at 115s" branch. A reply is
written in one pass however long it runs; Node's own 300s `requestTimeout`
is switched off for the same reason.

**Kept on purpose**
- `continueMessageId` and the `incomplete` reply shape. Replies the edge
  function left half-written (the "Continue writing" button) finish here,
  and the browser client is identical whichever endpoint it points at —
  which is what makes the rollback a config change.
- The retry on `stop_reason === "max_tokens"` — that cap is real wherever
  this runs. `MAX_CONTINUATIONS` is 8 here instead of 3 because there is no
  clock to respect.
- Stop: the browser closing the connection aborts the upstream model stream
  (`res.on("close")`), and what was written is saved with `stopped: true`.
- Review follow-ups asked in the chat are answered here (`review.js`'s
  `checkReviewInstruction`); the review panel has no chat of its own any more.
  The `redline-chat` edge function is only reached through the edge `chat`
  fallback, which is slated for removal.

**Different by being here** — the large-docx/pptx and scanned-PDF offloads go
to ocr-service on `127.0.0.1:8090` rather than across the internet.

## Working on Word files

`docxAgent.js` is the part that makes this more than a chat. When a turn is
about a `.docx` — a project document opened with **Edit**, or the firm's
standard for a document type being drafted — the file itself is the subject:
its paragraphs are listed to the model as `¶n`, the model answers with
`replace` / `insert_after` / `delete` operations against those numbers, and
those are written into that same file as Word tracked changes. Nothing is
extracted to text and rebuilt, so styles, numbering, tables, headers and
footers, fonts and every untouched paragraph come out exactly as they went
in. The result is stored in `ai-chat-files` and shown in an `ai_artifacts`
row of kind `docx`; the lawyer sees the redline in the panel and can download
it with the changes tracked or accepted, or save it onto the project as the
next version.

The changes are made in the XML directly. `@ansonlai/docx-redline-js` is a
fallback for the rare paragraph whose markup cannot be accounted for safely:
it re-parses and re-serialises the whole document per operation, which on the
firm's standard Concession Agreement (4,101 paragraphs) took ten minutes for
thirteen changes against 145ms now.

A document too long to show whole is shown where the turn is about: the
paragraphs carrying blanks when filling in a standard, the ones matching the
lawyer's message when editing, with the gaps marked so the model can ask for
more. A source that is not a Word file (a PDF, a deck) still goes through
text and comes back as a Markdown draft.

**The edge function cannot do any of this** — it has no `docxAgent` — so the
rollback below is a real downgrade, not just a change of host.

## Review writes into the working file

Review no longer rebuilds a file from the saved version it reviewed. It runs
on the conversation's working Word document (the lineage root, opened as an
opening row first if the turn started from a project version, a standard or
an upload) and writes each suggestion into that file as an `AKLA AI` tracked
change, exactly as Edit does. Each change is one `redline_suggestions` row
anchored on `artifact_id` and the Word revision ids it minted; the lawyer
decides it through `POST /changes/decide`, and `POST /changes/list` and
`POST /documents/file` read the same head file. So preview, download and
save are the same bytes. The pure renderer and record module is
`changes.js`.

Three things keep the list and the file in step. The writes to one working
document (an Edit copy, a Review copy, a decision) run one after another
under an in-process lock, from the head check to the counts; the model call
is outside it. An Edit turn inserts its change rows before its copy, and a
Review removes its copy if the rows fail, so a copy never exists without
the rows that name its changes. And every count carries `unlisted`: the
`AKLA AI` tracked changes in the head file that no row names (a file edited
before this record existed, or a turn whose rows never landed). While it is
above zero a clean copy is refused with "This file has N AI changes that are
not in the Changes list. Decide them in Word first." rather than accepting
them unseen. A change a later AI change was made inside is `needs_word` with
"A later change was made inside this one. Decide the later change first."

`/changes/list` returns the head as a summary; `/changes/decide` returns the
head's artifact row (`head.data.storagePath`, `head.data.changeCounts`),
which may be a new row or the decision row updated in place.

`REVIEW_IN_FILE=0` in `.env` restores the old branch: list-only rows on a
saved version, previewed by text match. The legacy preview path
(`POST /review`, `/review/preview`, `/review/download`) remains in any case
and is served only for rows that carry `document_version_id`; rows with
`artifact_id` never go through it.

`changes.js` must stay in all three lists in `deploy.sh` (the `scp` line,
the `mv` and the `chown`); if it is missing from any of them the service
fails to import `server.js` on the VM.

## Deploying

Port 8092 (8090 is ocr-service, 8091 the relay). `.env` needs
`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `PORT=8092`.

```bash
./chat-service/deploy.sh            # copies, stamps the commit, restarts
```

First time only: `aklachat` has to exist as a DuckDNS subdomain pointing at
`140.245.26.184` before Caddy can get a certificate; then append `Caddyfile`
to `/etc/caddy/Caddyfile` and `sudo systemctl reload caddy`. The unit file is
copied to `/etc/systemd/system/` by hand — and a file moved there from `/tmp`
keeps its `user_tmp_t` SELinux label, which systemd refuses to open
("Permission denied" in the journal): `sudo restorecon` it.

## Cutting over, and cutting back

The frontend picks the endpoint from an env var, so the switch is a Vercel
setting rather than a deploy:

```
VITE_CHAT_API_URL=https://aklachat.duckdns.org
```

**Leave the edge function deployed.** Unsetting that variable falls back to
`${VITE_SUPABASE_URL}/functions/v1/chat` and the old path serves again — which
is the rollback, and the reason not to delete anything on Supabase until this
has run for a couple of weeks.

Cut over on 2026-09-10; the edge function stays deployed as the fallback.

Worth remembering what changes operationally: chat becomes the first
user-facing service on a single free-tier VM with no redundancy. An outage
takes the AI Workspace down outright, where an ocr-service failure only
degrades ingestion.
