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
5. **Official text** (`pls.js`, `plsParse.js`) — the top six judgments are
   looked up on Pakistan Law Site by citation and, where the site carries them,
   its official reported text replaces the other source's text.
6. **Compose** (`answer.js`, Sonnet) — the top judgments' full text grounds a
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

## Pakistan Law Site (official text)

The firm works with the publisher directly and has its permission to read the
site by program; the publisher has no API, so the service signs in with the
firm's own account (`PLS_USERNAME` / `PLS_PASSWORD` in `.env`).

- **What it does.** For each of the top six judgments it parses the citation
  ("2018 SCMR 365", "2014 PLD Supreme Court 47"), runs the site's citation
  search, picks the row (by court, then parties, for PLD pages that repeat
  across courts), fetches the judgment and checks its opening lines really are
  that citation and those parties before using it. A source grounded this way is
  marked `grounding: "official"` and the page shows "official text".
- **What it does not cover.** Journals the site does not publish (PLJ, P.S.C.,
  neutral citations such as SCP / SHC / LHC) are skipped.
- **One session at a time.** Each account allows a single session. The
  firm's accounts are listed as `PLS_USERNAME`, `PLS_USERNAME_2`, `_3`…; the
  service uses the first one that is free and skips a busy one for a minute. The service
  signs in only while answering, signs out after `PLS_IDLE_MS` of quiet (and on
  shutdown), and never forces another session off. If a lawyer is using the
  account the answer goes ahead without the official text and the coverage note
  says so; sign-in is then not retried for a minute.
- **Not yet used for search.** The site also has a keyword search
  (`GET /Login/ElasticSearchTest?q=&page=`) and a question search
  (`GET /Login/AIElasticSearch?q=&page=`), both returning Elasticsearch JSON
  with the headnote in each hit. Retrieval still runs on the MCP alone.
- **If the site changes.** `node plsMap.mjs` signs in, saves the first pages
  and page scripts into `.pls-pages/` (git-ignored) and signs out, so the
  parsers can be brought back in line. `node --test` covers the parsing.

## Local dev

With no `SUPABASE_URL`/`SERVICE_ROLE_KEY`, persistence and the cache no-op and
the pipeline still runs. `node runOnce.mjs "<question>"` runs plan → retrieve →
rank and prints the result (needs `ANTHROPIC_API_KEY`).
