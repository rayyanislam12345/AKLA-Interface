#!/usr/bin/env bash
# Deploy the legal-update monitor to the Oracle VM that already runs
# ocr-service. Same recipe as that service: scp the code, install deps into
# the venv, reload systemd.
#
# The .env is NOT deployed — create it once on the VM from .env.example.
#
#   ./deploy.sh            # deploy and reload
#   ./deploy.sh --run      # deploy, then run once immediately and tail the log
set -euo pipefail

HOST="${LAW_MONITOR_HOST:-opc@140.245.26.184}"
KEY="${LAW_MONITOR_KEY:-$HOME/.ssh/oracle-ocr.key}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

echo "Deploying law-monitor to $HOST"

# scp needs the destination directory to already exist.
ssh -i "$KEY" "$HOST" 'rm -rf /tmp/law-monitor-deploy && mkdir -p /tmp/law-monitor-deploy'

# supabase_io.py is the single source of truth in scripts/precedent_backlog/
# — it solves the ingest-documents auth problem (bot session + retries) and
# is copied in at deploy time rather than duplicated in the repo.
scp -i "$KEY" \
  "$HERE/monitor.py" \
  "$HERE/sources.json" \
  "$HERE/requirements.txt" \
  "$HERE/law-monitor.service" \
  "$HERE/law-monitor.timer" \
  "$REPO/scripts/precedent_backlog/supabase_io.py" \
  "$HOST:/tmp/law-monitor-deploy/"

ssh -i "$KEY" "$HOST" 'set -euo pipefail
sudo mkdir -p /opt/law-monitor
sudo cp /tmp/law-monitor-deploy/{monitor.py,sources.json,requirements.txt,supabase_io.py} /opt/law-monitor/
sudo cp /tmp/law-monitor-deploy/law-monitor.service /etc/systemd/system/
sudo cp /tmp/law-monitor-deploy/law-monitor.timer /etc/systemd/system/
sudo chown -R opc:opc /opt/law-monitor

if [ ! -d /opt/law-monitor/.venv ]; then
  python3 -m venv /opt/law-monitor/.venv
fi
/opt/law-monitor/.venv/bin/pip install -q -r /opt/law-monitor/requirements.txt

if [ ! -f /opt/law-monitor/.env ]; then
  echo "WARNING: /opt/law-monitor/.env is missing — create it from .env.example before the timer fires."
fi

sudo systemctl daemon-reload
sudo systemctl enable --now law-monitor.timer
rm -rf /tmp/law-monitor-deploy
systemctl list-timers law-monitor.timer --no-pager || true
'

if [ "${1:-}" = "--run" ]; then
  echo "Running once now..."
  ssh -i "$KEY" "$HOST" 'sudo systemctl start law-monitor.service && journalctl -u law-monitor -n 60 --no-pager'
fi

echo "Done."
