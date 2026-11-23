#!/usr/bin/env bash
# Deploy the intake service to the Oracle VM (/opt/intake-service, the unit intake@.service
# and its timers). Same recipe as law-monitor/deploy.sh: copy the code, install the deps
# into the venv, reload systemd, enable the timers.
#
#   intake-service/deploy/deploy.sh                     deploy; start the agendas, documents and mail timers
#   intake-service/deploy/deploy.sh --with-sheet-sync   ...and the nightly Excel sync as well
#   intake-service/deploy/deploy.sh --run               deploy, then run the agendas once and show the log
#
# The nightly sheet sync WRITES the Transactions Excel on SharePoint, so it starts only
# when asked for by name. The documents timer files nothing until the "Hub Intake"
# account exists (deploy/make_intake_user.py); the mail timer does nothing until the
# owner has granted the consent and turned mail_enabled on.
#
# No .env is copied: the units read /opt/chat-service/.env and /opt/whatsapp-filer/.env
# (see deploy/env). Deploying itself touches nothing in the Hub or on SharePoint.
set -euo pipefail

HOST="${INTAKE_HOST:-opc@140.245.26.184}"
KEY="${INTAKE_KEY:-$HOME/.ssh/oracle-ocr.key}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/intake-service

echo "Deploying intake-service to $HOST:$DEST"
COPYFILE_DISABLE=1 tar czf /tmp/intake-service.tgz -C "$HERE" intake config deploy requirements.txt README.md
scp -q -i "$KEY" /tmp/intake-service.tgz "$HOST:/tmp/"

TIMERS="intake-agendas.timer intake-documents.timer intake-mail.timer"
case " $* " in *" --with-sheet-sync "*) TIMERS="$TIMERS intake-sheet-sync.timer" ;; esac

ssh -i "$KEY" "$HOST" "set -euo pipefail
  sudo mkdir -p $DEST && sudo chown opc:opc $DEST
  cd $DEST && tar xzf /tmp/intake-service.tgz && rm /tmp/intake-service.tgz
  [ -x venv/bin/python ] || /usr/bin/python3.11 -m venv venv
  venv/bin/pip install -q --upgrade pip && venv/bin/pip install -q -r requirements.txt
  sudo cp deploy/intake@.service deploy/intake-*.timer /etc/systemd/system/
  for cmd in sheet-sync documents mail; do
    sudo mkdir -p /etc/systemd/system/intake@\$cmd.service.d
    sudo cp deploy/intake@\$cmd.service.d/override.conf /etc/systemd/system/intake@\$cmd.service.d/
  done
  for f in /opt/chat-service/.env /opt/whatsapp-filer/.env; do [ -f \$f ] || echo \"WARNING: \$f is missing; the units read it\"; done
  [ -r /opt/whatsapp-filer/state/filed.sqlite ] || echo 'WARNING: the Filer record (/opt/whatsapp-filer/state/filed.sqlite) cannot be read; documents will not be filed'
  sudo systemctl daemon-reload
  sudo systemctl enable --now $TIMERS
  systemctl list-timers 'intake-*' --no-pager || true
  venv/bin/python -m intake status || true"

case " $* " in *" --run "*)
  echo "Running the agendas once now..."
  ssh -i "$KEY" "$HOST" 'sudo systemctl start intake@agendas.service; journalctl -u intake@agendas -n 60 --no-pager' ;;
esac
echo "Done. Check with: ssh $HOST \"cd $DEST && venv/bin/python -m intake status\""
