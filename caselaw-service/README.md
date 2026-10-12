# caselaw-service

Case-law research chat for the firm: an attorney asks a legal question and gets
an answer grounded in reported Pakistani judgments, with the citations it relied
on. Separate from chat-service (the AI Workspace): different retrieval source,
own page, own tables.

## How it answers one question

1. **Plan** (`retrieve.js`, Sonnet) — the question becomes a legal issue, the
   statutes/sections it turns on, any court/year constraint, and 8–12 query
   variants.
2. **Fan out + graph** (`retrieve.js`) — every variant runs through the
   [pakistancaselaw.com](https://pakistancaselaw.com/for-ai) MCP (search + question
   search), then the strongest hits are expanded through the citation graph
   (`cited_by`/`cites`) to catch judgments worded differently. ~400-case pool.
3. **Shortlist + read + grade** (`pipeline.js`, `rank.js`, Haiku) — the pool is
   shortlisted on a recall-biased signal, the shortlist's summaries are read,
   and each is graded 0–3 for relevance.
4. **Rank** (`rank.js`) — `relevance × recency × authority`: Supreme Court over
   High Court over tribunal, a landmark boost from citation count, a penalty for
   overruled judgments, and a recency curve that favours recent law without
   silencing an older leading case. Sparse questions fall back to a "related
   authority" tier instead of returning nothing.
5. **Compose** (`answer.js`, Sonnet) — the top judgments' full text grounds a
   streamed answer that cites `[Source n]`; out-of-range citations are flagged.

Every run is recorded in `caselaw_runs` (the audit trail), so a "did it miss a
case?" question can be traced to the stage that lost it.

## Endpoints

- `GET /health`, `GET /version`
- `POST /caselaw` (SSE) — body `{ question, threadId? }`, auth `Bearer <supabase JWT>`.
  Events: `meta`, `notice`, `delta`, `sources`, `done`, `error` — the same
  vocabulary chat-service streams, so the web client's reader is reused.

## Deploy

Localhost service on the Oracle VM (port 8094), Caddy block
`aklacaselaw.duckdns.org`, systemd unit, scp deploy — the pattern the sibling
services use.

First time:
1. `sudo mkdir -p /opt/caselaw-service`, create `.env` from `.env.example`.
2. Install `caselaw-service.service` to `/etc/systemd/system/`, `sudo systemctl enable caselaw-service`.
3. Append `Caddyfile` to `/etc/caddy/Caddyfile`, `sudo systemctl reload caddy`, point the DuckDNS name at the box.
4. `./deploy.sh`.

Then `npm install` on the box, and set `VITE_CASELAW_API_URL` in the web app to
`https://aklacaselaw.duckdns.org/caselaw`.

## The Pakistan Law Site hook

The firm's subscription to Pakistan Law Site is the source of official reported
text. `answer.js` is built so a verification/official-text fetch plugs in behind
one function (fetch the official text for a citation). That credentialed client
is configured with `PLS_USERNAME` / `PLS_PASSWORD` and is implemented by the
firm; the service runs fully without it (answers are grounded in the MCP).

## Local dev

With no `SUPABASE_URL`/`SERVICE_ROLE_KEY`, persistence and the cache no-op and
the pipeline still runs. `node runOnce.mjs "<question>"` runs plan → retrieve →
rank and prints the result (needs `ANTHROPIC_API_KEY`).
