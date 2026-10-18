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
| `list_projects` (includeClosed?) | The firm's projects with their ids; open ones unless asked |
| `list_project_documents` (projectId) | A project's documents, every version with its id, the current one marked |
| `search_project_documents` (projectId, query) | Passages from a project's current documents |
| `read_document` (versionId, from?, chars?) | The plain text of one version, up to 20,000 characters a call, in slices; from the Hub's stored passages, or read from the file when it has none |
| `get_document_summary` (versionId) | The index card (what it is, parties, key dates, defined terms, outline, statutes mentioned), the proof check's counts and first findings, and what changed from the version before |

It uses the assistant's own search (`chat-service/libraryTools.js`,
`retrieve.js`), so what it finds is what the Hub's chat would find.

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
                        ├─ /mcp, /oauth/*, /.well-known/oauth-* ──> hub-connector  127.0.0.1:8094
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

**Settings** (`hub-connector.service`): `CONNECTOR_PORT` (8094),
`CONNECTOR_ISSUER` (`https://aklachat.duckdns.org`; the issuer in the
discovery documents and the resource claude.ai asks for),
`CONNECTOR_REDIRECT_HOSTS` (comma-separated; default `claude.ai,claude.com`)
and `CONNECTOR_ALLOW_LOOPBACK` (never on the VM). The rest comes from
`/opt/chat-service/.env`.

**Logs:** `sudo journalctl -u hub-connector -f`. One line per sign-in,
registration and tool call (tool, user id, length, milliseconds), and a
line for every refusal with its reason.

## Deploying (manual, in this order)

1. **Migration.** Apply `supabase/migrations/20261019150000_connector_tokens.sql`
   to the project (SQL editor or the management API). Safe to run twice.
   Until it is applied, the connector starts but every registration and
   sign-in fails with "Could not save…" in its journal.
2. **Code.** From the repo, `chat-service/deploy.sh`. It copies
   `connector/*.js` to `/opt/chat-service/connector/`, installs
   `hub-connector.service` (install + restorecon, as for the index worker),
   runs `npm install` (which adds `@modelcontextprotocol/sdk` and `zod`), and
   restarts chat-service, index-worker and hub-connector. The last lines
   print both health checks and a NOTE if Caddy is not routing yet.
3. **Caddy.** Replace the `aklachat.duckdns.org` block in
   `/etc/caddy/Caddyfile` on the VM with the one in `chat-service/Caddyfile`
   (the `@connector` matcher sends `/mcp`, `/oauth/*` and the two
   `.well-known` paths to 8094; everything else stays on 8092). Then:
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
