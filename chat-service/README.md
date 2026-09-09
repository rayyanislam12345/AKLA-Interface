# chat-service

The AI Workspace's chat endpoint, moved off Supabase Edge Functions onto the
Oracle VM. Not yet ported — this directory holds the deployment scaffolding
so the port itself is the only work left.

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

## Port checklist

Source is `supabase/functions/chat/index.ts` (Deno) plus
`supabase/functions/_shared/extractText.ts`.

**Mechanical**
- `Deno.env.get("X")` → `process.env.X`
- `serve()` from deno std → `http.createServer`; SSE is `res.write("event: …\ndata: …\n\n")` rather than enqueuing onto a `ReadableStream`
- Drop `import "https://deno.land/x/xhr@0.1.0/mod.ts"` — a Deno-only shim
- esm.sh URLs → the npm dependencies already listed in `package.json`

**Delete outright** — these exist only because of the edge timeout
- `GENERATION_BUDGET_MS`, `MIN_USEFUL_SLICE_MS`, `continueInstruction()`
- the `incomplete` branch that saves a partial and returns early
- `continueMessageId` / `resumeMessage` handling
- in `src/hooks/useChat.ts`: `MAX_CONTINUATION_ROUNDS` and the
  `while (round.incomplete …)` loop in `send`

**Keep**
- `anthropicComplete`'s retry on `stop_reason === "max_tokens"`. That cap is
  real and independent of where this runs — only the wall-clock deadline goes.
- `MarkdownMessage`'s unterminated-`<artifact>` placeholder; harmless, and it
  still covers a reply cut short for other reasons.

**Copy from `transcription-relay/server.js`**
- `verifySupabaseToken` — the same JWT check, already proven on this box.

**Note**
- `extractText`'s large-docx/pptx offload to ocr-service becomes a call to
  `127.0.0.1:8090` — same machine, so it gets faster.
- The verify skill calls the `suggest-redline` and `redline-chat` edge
  functions. Those stay on Supabase and are reached over the network — fine
  at 1.7ms.

## Deploying

Port 8092 (8090 is ocr-service, 8091 the relay). `.env` needs
`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `PORT=8092`.

```bash
./chat-service/deploy.sh            # copies, stamps the commit, restarts
```

Then append `Caddyfile` to `/etc/caddy/Caddyfile` and reload Caddy.

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

Worth remembering what changes operationally: chat becomes the first
user-facing service on a single free-tier VM with no redundancy. An outage
takes the AI Workspace down outright, where an ocr-service failure only
degrades ingestion.
