#!/usr/bin/env bash
# Deploy the intake service to the Oracle VM (/opt/intake-service, units intake@.service
# and the two timers). Same recipe as law-monitor/deploy.sh: copy the code, install the
# deps into the venv, reload systemd, enable the timers.
#
#   intake-service/deploy/deploy.sh          deploy and enable the timers
#   intake-service/deploy/deploy.sh --run    deploy, then run the agendas once and show the log
#
# No .env is copied: the units read /opt/chat-service/.env and /opt/whatsapp-filer/.env
# (see deploy/env). Nothing in the Hub or on SharePoint is touched by deploying.
set -euo pipefail

HOST="${INTAKE_HOST:-opc@140.245.26.184}"
KEY="${INTAKE_KEY:-$HOME/.ssh/oracle-ocr.key}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/intake-service

echo "Deploying intake-service to $HOST:$DEST"
COPYFILE_DISABLE=1 tar czf /tmp/intake-service.tgz -C "$HERE" intake config deploy requirements.txt README.md
scp -q -i "$KEY" /tmp/intake-service.tgz "$HOST:/tmp/"

ssh -i "$KEY" "$HOST" "set -euo pipefail
  sudo mkdir -p $DEST && sudo chown opc:opc $DEST
  cd $DEST && tar xzf /tmp/intake-service.tgz && rm /tmp/intake-service.tgz
  [ -x venv/bin/python ] || /usr/bin/python3.11 -m venv venv
  venv/bin/pip install -q --upgrade pip && venv/bin/pip install -q -r requirements.txt
  sudo cp deploy/intake@.service deploy/intake-agendas.timer deploy/intake-sheet-sync.timer /etc/systemd/system/
  sudo mkdir -p /etc/systemd/system/intake@sheet-sync.service.d
  sudo cp deploy/intake@sheet-sync.service.d/override.conf /etc/systemd/system/intake@sheet-sync.service.d/
  for f in /opt/chat-service/.env /opt/whatsapp-filer/.env; do [ -f \$f ] || echo \"WARNING: \$f is missing; the units read it\"; done
  sudo systemctl daemon-reload
  sudo systemctl enable --now intake-agendas.timer intake-sheet-sync.timer
  systemctl list-timers 'intake-*' --no-pager || true"

if [ "${1:-}" = "--run" ]; then
  echo "Running the agendas once now..."
  ssh -i "$KEY" "$HOST" 'sudo systemctl start intake@agendas.service; journalctl -u intake@agendas -n 60 --no-pager'
fi
echo "Done. Check with: ssh $HOST \"cd $DEST && venv/bin/python -m intake status\""
