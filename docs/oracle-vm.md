# The Oracle VM

One small always-on Linux box that runs the jobs Supabase Edge Functions
can't: anything needing more than ~150s of wall clock, more memory than an
isolate gets, a real filesystem, native binaries, or a schedule.

Everything below was read off the box on 2026-09-08.

## Access

| | |
|---|---|
| Public IP | `140.245.26.184` |
| SSH | `ssh -i ~/.ssh/oracle-ocr.key opc@140.245.26.184` |
| User | `opc` — has passwordless `sudo` for everything |
| Private IP | `10.0.0.222` (interface `enp0s6`) |
| Hostname | `instance-ocr-akla` |

The key lives only on the developer machine at `~/.ssh/oracle-ocr.key`
(mode `400`). It is not in the repo and must never be committed.

## The shape, and what it costs you

An Oracle Ampere A1 free-tier instance. Small, and **ARM**:

| | |
|---|---|
| OS | Oracle Linux 9.8, kernel 6.12 UEK |
| Architecture | **`aarch64` (ARM64)** |
| CPU | **1 vCPU** |
| RAM | 5.5 GB, plus a 4 GB swapfile (currently unused) |
| Disk | 30 GB root, ~20 GB free |
| Clock | **UTC/GMT.** PKT is a fixed UTC+5, no DST |

Four constraints that will bite a newcomer:

1. **ARM64.** Any wheel, binary or container must be `aarch64`. x86 builds
   will not run.
2. **One vCPU.** Nothing here can assume parallelism. OCR already runs two
   gunicorn workers; a second CPU-bound job will contend with it.
3. **Python is 3.9.25** (the system Python). Anything needing 3.10+ syntax
   — `match`, `X | Y` unions at runtime — has to bring its own interpreter.
4. **`git` is NOT installed. Neither is `docker`.** Deploy by `scp`. A
   `cd /opt/thing && git pull` will fail twice over — no binary, no checkout.

Installed and usable: `node v20.20.2`, `npm 10.8.2`, `python3 3.9.25`,
`caddy v2.11.4`, `tesseract 4.1.1`. Added 2026-10-05 for the email bot:
`python3.11` (AppStream) and `chromium` 151 (EPEL).

## What already runs here

| Service | Port | Type | What it is |
|---|---|---|---|
| `ocr-service` | `127.0.0.1:8090` | gunicorn, `Restart=always` | OCR + docx/pptx extraction the Edge Functions offload to |
| `transcription-relay` | `0.0.0.0:8091` | node, `Restart=always` | WebSocket relay holding the Deepgram key so the browser never sees it |
| `law-monitor` | — | `Type=oneshot` + timer | Daily legal-update sweep, 02:00 UTC (07:00 PKT) |
| `chat-service` | `127.0.0.1:8092` | node, `Restart=always` | The AI Workspace chat endpoint (`chat-service/`), the first user-facing service here — if it is down, the AI Workspace is down |
| `index-worker` | — | node, `Restart=always`, `Nice=10`, `MemoryMax=900M` | Reads project files for search (`chat-service/indexWorker.js`): one job at a time from `document_index_jobs`. See "The index worker" below |
| `emailbot-wa` | `127.0.0.1:3791` | node + Chromium, `Restart=always`, `Nice=10`, `MemoryMax=1200M` | WhatsApp bridge for the email watch bot (added 2026-10-05; code in the `AKLA - Email Bot` project, `deploy/oracle/`) |
| `emailbot` | — | python3.11, `Restart=always`, `Nice=10`, `MemoryMax=1200M` | Email watch: reads Ali Khan's inbox, posts work mail as images to a WhatsApp group |
| `emailbot-web` | `127.0.0.1:8093` | python3.11, `Restart=always` | Its web UI. Loopback only, no Caddy block: SSH tunnel to view |

Also listening: `sshd` on 22, `caddy` on 80/443 (and its admin API on
`127.0.0.1:2019`), plus Oracle's own `unified-monitoring-agent`, `pmcd`
and `rpcbind`. Leave those alone.

Deployed code lives in `/opt/<service>/`, owned by `opc`.

## Networking — two firewalls, not one

Externally only **22, 80 and 443** are reachable. Everything else binds to
localhost and is published through Caddy.

`/etc/caddy/Caddyfile`:

```
aklaocr.duckdns.org   { reverse_proxy 127.0.0.1:8090 }
aklarelay.duckdns.org { reverse_proxy 127.0.0.1:8091 }
aklachat.duckdns.org  { reverse_proxy 127.0.0.1:8092 }
```

Caddy gets certificates automatically. DNS is DuckDNS pointed at the
instance's public IP.

Opening a new port needs **both** layers, and forgetting the second is the
usual reason a port "is open but nothing connects":

1. On the box: `sudo firewall-cmd --permanent --add-port=NNNN/tcp && sudo firewall-cmd --reload`
2. In the **OCI console**: the subnet's Security List / NSG ingress rules.

Prefer not doing either. Bind to `127.0.0.1`, add a Caddy block, and get
TLS and a hostname for free.

## Adding a service — the pattern the three existing ones follow

```bash
# 1. Copy the code (no git on the box)
scp -i ~/.ssh/oracle-ocr.key -r ./my-service opc@140.245.26.184:/tmp/
ssh -i ~/.ssh/oracle-ocr.key opc@140.245.26.184 \
  'sudo mv /tmp/my-service /opt/ && sudo chown -R opc:opc /opt/my-service'

# 2. Its own venv (python) or npm install (node), inside /opt/my-service
ssh … 'cd /opt/my-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'

# 3. Secrets: /opt/my-service/.env, loaded by systemd's EnvironmentFile
#    chmod 600, never committed.

# 4. Unit at /etc/systemd/system/my-service.service, then:
ssh … 'sudo systemctl daemon-reload && sudo systemctl enable --now my-service'
```

**Long-running server** → `Type=simple`, `Restart=always`, bind
`127.0.0.1:<free port>`, add a Caddy block.

**Scheduled batch job** → `Type=oneshot` with a matching `.timer`, and
**never** `Restart=always`: a job that fails at 02:00 would relaunch in a
loop all day. Copy `law-monitor`'s unit — it uses `Persistent=true` so a
reboot doesn't skip a day, `RandomizedDelaySec`, and wraps the command in
`flock` so a manual run can't overlap the timer.

Both existing deploys are scripted — `law-monitor/deploy.sh` and
`transcription-relay/deploy.sh`. Copy one rather than inventing a third
shape.

## Secrets

One `.env` per service, referenced by `EnvironmentFile=` in its unit.
Values are **only** on the box — not in the repo, not in this document.
Names currently in use:

- `/opt/ocr-service/.env` — `OCR_SHARED_SECRET`, `DOMAIN`
- `/opt/transcription-relay/.env` — `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `PORT`
- `/opt/law-monitor/.env` — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SESSION_EMAIL`, `SUPABASE_SESSION_PASSWORD`, `ANTHROPIC_API_KEY`
- `/opt/emailbot/.env` — `ANTHROPIC_API_KEY`, Graph tenant/client IDs, WhatsApp group, Chromium paths
- `/opt/chat-service/.env` (also read by `index-worker`) — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `OCR_SERVICE_URL`, `OCR_SERVICE_SECRET` (same value as ocr-service's `OCR_SHARED_SECRET`), `PORT`

`ANTHROPIC_API_KEY` appears four times (emailbot too), so rotating the Anthropic key means
updating **all four** files and restarting those services — plus the Supabase
Edge Function secrets, which are separate again.

## Calling the existing services

`ocr-service` authenticates with a bearer token equal to
`OCR_SHARED_SECRET`:

```bash
curl -H "Authorization: Bearer $OCR_SHARED_SECRET" \
     --data-binary @file.pdf -H 'Content-Type: application/pdf' \
     https://aklaocr.duckdns.org/ocr/pdf
```

Endpoints: `GET /health`, `POST /ocr/pdf`, `POST /extract/docx`,
`POST /extract/pptx`.

`transcription-relay`: `GET /version` reports the deployed commit,
`POST /transcribe-file` takes an upload, and the live path is a WebSocket
at `/meeting` authenticated with a Supabase JWT.

## The index worker

`index-worker` reads project files so search and Ask AI can use them. Until
October 2026 this happened inside the browser's upload request (the
`process-document` edge function): 150 s, OCR only when a whole PDF had no
text, and the seven large scanned PDFs on the system were never read. Now:

- Saving a version (`save_document_version`) inserts a row in
  `public.document_index_jobs` (trigger on `document_versions`, migration
  `20261017090000_indexing_pipeline.sql`).
- The worker calls `claim_index_job` every 5 s when idle (`FOR UPDATE SKIP
  LOCKED`, a 20-minute lock it renews with `touch_index_job` on long files),
  downloads the file with the service role, reads it, embeds the passages
  with `voyage-law-2`, writes a summary card with Haiku, inserts the passages
  under the job's `run_id`, and calls `publish_index_run`, which deletes the
  version's older passages and marks it `indexed` in one transaction.
- On an error it calls `fail_index_job`: retried after 2 and then 4 minutes,
  and after the third attempt the version shows `failed` with a plain reason
  (`document_versions.indexing_error`) and a Try again button
  (`enqueue_index_job`).
- `systemctl stop`/a deploy: it finishes the step it is on, hands the job back
  (`release_index_job`, attempt not counted) and exits.

Code: `chat-service/indexWorker.js` and `chat-service/indexing/` (`extract.js`
reads PDF/DOCX/XLSX/XLS/PPTX/TXT/MD/CSV, `docx.js` keeps Word's clause
numbers, `chunk.js` builds 400-800-token passages under their clause heading,
`embed.js`, `card.js`, `pipeline.js`). Unit: `chat-service/index-worker.service`,
installed and restarted by `chat-service/deploy.sh`. It uses the chat-service
`.env`; nothing new is needed there.

Tools it shells out to, all already on the box: `pdfinfo`, `pdftotext`,
`pdftoppm` (poppler-utils, which ocr-service's pdf2image also needs) and
`tesseract` 4.1.1 with English data. A PDF page with under 200 visible
characters is rendered at 150 DPI and OCR'd on its own: about 12 s a page on
this core, so a 200-page scan takes about 40 minutes. Limits (env, optional):
`INDEX_MAX_PAGES` (400), `INDEX_MAX_MINUTES` (90), `INDEX_MAX_FILE_MB` (150),
`INDEX_OCR_DPI` (150), `VOYAGE_BATCH_TOKENS` (90000) and
`VOYAGE_MIN_INTERVAL_MS` (0; set ~21000 if the Voyage account is ever back on
the free tier's 3 requests a minute).

Watching it:

```bash
sudo journalctl -u index-worker -f        # one line per job: result, passages, pages, OCR pages, ms
systemctl status index-worker
```

and in SQL: `select state, count(*) from document_index_jobs group by 1;`,
`select storage_path, attempts, last_error from document_index_jobs where state = 'failed';`.

## Rules of the road for a second bot

- **Pick an unused port** and check first: `sudo ss -tlnp`. 8090, 8091,
  8092, 8093 and 3791 are taken.
- **Don't restart services you don't own.** `ocr-service` restarting
  mid-request fails a document ingestion in the web app.
- **Watch the single CPU.** `index-worker` already runs OCR at `Nice=10`.
  Anything sustained and CPU-bound should be
  `nice`d, or it will slow OCR and the live transcription relay.
- **Logs are journald**: `sudo journalctl -u <service> -f`, or
  `--since today`.
- **Check before assuming a deploy landed.** These boxes drift: the relay
  ran a stale build for two days because there is no `git pull` here to
  make staleness obvious. Stamp a version and expose it.
