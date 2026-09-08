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
`caddy v2.11.4`, `tesseract 4.1.1`.

## What already runs here

| Service | Port | Type | What it is |
|---|---|---|---|
| `ocr-service` | `127.0.0.1:8090` | gunicorn, `Restart=always` | OCR + docx/pptx extraction the Edge Functions offload to |
| `transcription-relay` | `0.0.0.0:8091` | node, `Restart=always` | WebSocket relay holding the Deepgram key so the browser never sees it |
| `law-monitor` | — | `Type=oneshot` + timer | Daily legal-update sweep, 02:00 UTC (07:00 PKT) |

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

`ANTHROPIC_API_KEY` appears twice, so rotating the Anthropic key means
updating **both** files and restarting both services — plus the Supabase
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

## Rules of the road for a second bot

- **Pick an unused port** and check first: `sudo ss -tlnp`. 8090 and 8091
  are taken.
- **Don't restart services you don't own.** `ocr-service` restarting
  mid-request fails a document ingestion in the web app.
- **Watch the single CPU.** Anything sustained and CPU-bound should be
  `nice`d, or it will slow OCR and the live transcription relay.
- **Logs are journald**: `sudo journalctl -u <service> -f`, or
  `--since today`.
- **Check before assuming a deploy landed.** These boxes drift: the relay
  ran a stale build for two days because there is no `git pull` here to
  make staleness obvious. Stamp a version and expose it.
