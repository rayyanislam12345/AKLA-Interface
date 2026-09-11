#!/usr/bin/env bash
# Deploys chat-service to the Oracle VM.
#
# This box is NOT a git checkout — it has no .git directory and no git binary
# — so "cd /opt/chat-service && git pull" fails twice over. Copy the
# files, stamp the commit so GET /version can report what is actually
# running, then restart.
set -euo pipefail
cd "$(dirname "$0")"

HOST="${CHAT_HOST:-opc@140.245.26.184}"
KEY="${CHAT_KEY:-$HOME/.ssh/oracle-ocr.key}"
DEST=/opt/chat-service

COMMIT=$(git rev-parse HEAD)
COMMITTED_AT=$(git log -1 --format=%cI)
STAMP=$(mktemp)
printf '{"commit":"%s","committedAt":"%s","deployedAt":"%s"}\n' \
  "$COMMIT" "$COMMITTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAMP"

TS=$(date -u +%Y%m%d%H%M)
echo "Backing up the running copy…"
ssh -i "$KEY" "$HOST" "test -f $DEST/server.js && sudo cp $DEST/server.js $DEST/server.js.bak-$TS || true"

echo "Copying the service files and the version stamp…"
scp -i "$KEY" server.js extractText.js docxAgent.js research.js sourcePolicy.js review.js docxChecks.js chatState.js package.json "$STAMP" "$HOST:/tmp/"
ssh -i "$KEY" "$HOST" "sudo mv /tmp/server.js /tmp/extractText.js /tmp/docxAgent.js /tmp/research.js /tmp/sourcePolicy.js /tmp/review.js /tmp/docxChecks.js /tmp/chatState.js /tmp/package.json $DEST/ && sudo mv /tmp/$(basename "$STAMP") $DEST/DEPLOYED_VERSION && sudo chown opc:opc $DEST/server.js $DEST/extractText.js $DEST/docxAgent.js $DEST/research.js $DEST/sourcePolicy.js $DEST/review.js $DEST/docxChecks.js $DEST/chatState.js $DEST/package.json $DEST/DEPLOYED_VERSION"
rm -f "$STAMP"

# Only reinstall when the manifest actually changed — npm install on every
# deploy is slow and can pull a newer minor of a dependency unasked.
echo "Checking dependencies…"
ssh -i "$KEY" "$HOST" "cd $DEST && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 && echo '  dependencies ok'"

echo "Restarting…"
ssh -i "$KEY" "$HOST" "sudo systemctl restart chat-service && sleep 2 && systemctl is-active chat-service"

echo "Running version:"
ssh -i "$KEY" "$HOST" "curl -s -m 5 http://127.0.0.1:8092/health"
echo
