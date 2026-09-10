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
- The verify skill still calls the `suggest-redline` and `redline-chat` edge
  functions over the network. Fine at 1.7ms.

**Different by being here** — the large-docx/pptx and scanned-PDF offloads go
to ocr-service on `127.0.0.1:8090` rather than across the internet.

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
