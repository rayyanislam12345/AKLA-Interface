# Law monitor

Finds new Pakistani legal developments every morning, refreshes the firm's law
library when an Act it holds actually changes, and writes the daily briefing
that appears on the Matter Hub homepage.

Runs on the same Oracle VM as `ocr-service`, under a systemd timer at 07:00 PKT.
It lives on the VM rather than a laptop because the Mandate Bot's launchd job
silently skips any morning the Mac is asleep — and because the edge-function CPU
budget can't take AI web search plus PDF extraction (see the comment at
`supabase/functions/_shared/statuteResolver.ts:86-93`, which records that exact
failure).

## What it does

Two sweeps per run, both using Claude's hosted `web_search` tool:

- **Source sweep** — one call per authority in `sources.json` (SECP, the federal
  and provincial PPP bodies, NEPRA), asking what they published in the last
  couple of days. Each prompt carries that source's already-known reference
  numbers so it doesn't re-report the same circular every morning.
- **Library sweep** — asks whether specific Acts have been amended. Acts a
  matter actually depends on are checked daily; the rest rotate ~10 a day via a
  cursor, so a full pass takes under a week instead of paying for 60-odd
  searches every morning.

**The model only ever locates a URL.** Every fact stored comes from a document
this job downloaded and read itself — the same posture `statuteResolver.ts`
takes. A finding is discarded unless it clears all of:

- the document's domain is in `allowed_domains`
- the URL actually fetches, and yields real text
- the official reference number appears in that text (or, with no reference,
  the title genuinely matches)
- it was published within `max_published_age_days`

Rejections are counted on the run row, so a sweep that starts hallucinating
shows up as a rejection count rather than as fiction in the newsletter.

## What it will and won't change in the library

| Finding | What happens |
|---|---|
| `bill`, `notice` | **Never touches the library.** A bill is not law; storing one as statute text would have the AI reasoning from something that hasn't been enacted. Reported in the briefing only. |
| `amending_instrument` | Added as **its own** library entry with `metadata.amends_act` pointing at the principal Act. A four-page amendment must never overwrite a full Act. |
| `consolidated_replacement` | The only path that replaces text, and only if the title carries no "amendment" token, the new text is within ±40% of the stored length, and a separate AI identity check confirms it is the complete consolidated Act. |
| `new_act` | Reported only. Adding every newly enacted Act automatically would grow the library without anyone choosing to rely on it. |

A replacement **ingests first, then deletes**: new chunks are written and
verified, the old text is archived to `law_library_versions`, and only then are
the old chunks removed. A failure part-way leaves the Act with its previous text
rather than with none.

`act_name` is treated as immutable — it is the key `matter_relevant_laws`,
`match_documents(filter_act_names)` and `_shared/retrieval.ts` all join on.
Re-ingesting under a "better" title would silently cut every matter off from its
statute context while the UI still showed a green "In Library" badge.

## Running it

```bash
python3 monitor.py --dry-run      # search and verify, write nothing
python3 monitor.py --sources-only # skip the rotating library sweep
python3 monitor.py --acts-only    # skip the source sweep
python3 monitor.py                # full run (what the timer does)
```

`--dry-run` is the one to reach for first: it prints every candidate, whether it
passed the evidence bar and why, what the library action would have been, and
the digest it would have written.

## Deploying

```bash
./deploy.sh          # copy, install deps, reload systemd
./deploy.sh --run    # ...then run once now and tail the log
```

`deploy.sh` also copies `scripts/precedent_backlog/supabase_io.py`, which stays
the single source of truth for talking to Supabase. It solves a non-obvious
problem: `ingest-documents` authenticates its caller with `auth.getUser()`, and
a **service-role key fails that check** — refreshing a statute needs a real
signed-in session, which `supabase_io` handles with a cached bot-account login.

Create `/opt/law-monitor/.env` once from `.env.example` (chmod 600). It is never
deployed and never committed.

```bash
journalctl -u law-monitor -n 100      # what the last run did
systemctl list-timers law-monitor.timer
```

## Editing what it watches

`sources.json` — add or remove authorities, change the rotation budget, adjust
how old a development can be. `allowed_domains` is a hard gate: **add a domain
there before adding a source that uses it**, or every finding from that source
is rejected as un-verifiable.

## Where the output goes

| Table | What it holds |
|---|---|
| `law_monitor_runs` | One row per run: counts, cursor, error. The first place to look when something seems wrong. |
| `law_updates` | Confirmed findings, unique on `dedupe_key`. A repeat sighting bumps `last_seen_at` rather than inserting again. |
| `law_update_digests` | The daily briefing, one row per day, upserted. |
| `law_library_versions` | The previous text of any Act that was replaced. |

The homepage card reads the newest digest; a matter's Relevant Laws card turns
amber for any non-bill finding matching one of its Acts, until someone dismisses
it (`matter_law_update_acks`) or clicks **Revise**.
