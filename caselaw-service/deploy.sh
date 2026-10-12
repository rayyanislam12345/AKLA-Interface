#!/usr/bin/env bash
# Deploys caselaw-service to the Oracle VM.
#
# Like the sibling services, the box is NOT a git checkout (no .git, no git
# binary), so this copies the files, stamps the commit for GET /version, and
# restarts. First deploy: create /opt/caselaw-service/.env from .env.example,
# install the systemd unit and the Caddy block (see README), then run this.
set -euo pipefail
cd "$(dirname "$0")"

HOST="${CASELAW_HOST:-opc@140.245.26.184}"
KEY="${CASELAW_KEY:-$HOME/.ssh/oracle-ocr.key}"
DEST=/opt/caselaw-service

COMMIT=$(git rev-parse HEAD)
COMMITTED_AT=$(git log -1 --format=%cI)
STAMP=$(mktemp)
printf '{"commit":"%s","committedAt":"%s","deployedAt":"%s"}\n' \
  "$COMMIT" "$COMMITTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAMP"

# package-lock.json is intentionally omitted: there is none in the repo, and
# `npm install` on the box (below) resolves and writes one there.
FILES="server.js mcpClient.js parse.js retrieve.js rank.js pipeline.js answer.js anthropic.js store.js package.json"

TS=$(date -u +%Y%m%d%H%M)
echo "Backing up the running copy…"
ssh -i "$KEY" "$HOST" "test -f $DEST/server.js && sudo cp $DEST/server.js $DEST/server.js.bak-$TS || true"

echo "Copying the service files and the version stamp…"
scp -i "$KEY" $FILES "$STAMP" "$HOST:/tmp/"
MOVE=""; for f in $FILES; do MOVE="$MOVE /tmp/$f"; done
ssh -i "$KEY" "$HOST" "sudo mkdir -p $DEST && sudo mv $MOVE $DEST/ && sudo mv /tmp/$(basename "$STAMP") $DEST/DEPLOYED_VERSION && sudo chown -R opc:opc $DEST"
rm -f "$STAMP"

echo "Checking dependencies…"
ssh -i "$KEY" "$HOST" "cd $DEST && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 && echo '  dependencies ok'"

echo "Restarting…"
ssh -i "$KEY" "$HOST" "sudo systemctl restart caselaw-service && sleep 2 && systemctl is-active caselaw-service"

echo "Health:"
ssh -i "$KEY" "$HOST" "curl -s -m 5 http://127.0.0.1:8094/health"
echo
