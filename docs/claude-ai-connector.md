# The claude.ai connector ("AKLA Hub")

A lawyer can use the firm's documents inside their own claude.ai. The Hub
runs a small read-only MCP server with its own sign-in; claude.ai talks to
it as a custom connector. Code: `chat-service/connector/`. Built 19 Oct
2026.

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

## What it cannot do (this version)

- It is **read-only**: no editing, drafting into the project, saving
  versions, reviews or tracked changes. Those stay on the Hub.
- It does not see the Hub's **chats or chat files** (`ai-chat-files`), the
  firm's skills, timesheets, clients' contact details or anything outside
  projects, documents, precedents and the law library.
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
  dev box. A scope the connector does not know is narrowed to `hub:read`
  rather than refused; the token response says what was granted.
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
`/opt/chat-service/.env`.

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
   `select has_function_privilege('service_role', 'public.search_project_content_as(uuid,text,uuid,text,boolean,integer,integer)', 'execute');`.
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
