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
scp -i "$KEY" server.js libraryTools.js retrieve.js agreement.js agreementFlow.js extractText.js docxAgent.js research.js lawLibrary.js precedentSearch.js questionnaire.js sourcePolicy.js review.js docxChecks.js formatFingerprint.js suggestionMerge.js claudeSkills.js aklaRender.js contextBudget.js chatState.js changes.js indexWorker.js proofCheck.js versionCompare.js firmRules.js documentInsight.js versionChanges.js draftingPacks.js clauseBank.js decisions.js skeletonCheck.js draftChecks.js package.json "$STAMP" "$HOST:/tmp/"
# The index worker's reader (indexing/*.js) and its systemd unit. The unit is
# copied with install + restorecon, not mv: SELinux is enforcing and a file
# moved from /tmp keeps its user_tmp_t label, which systemd refuses to read.
ssh -i "$KEY" "$HOST" "rm -rf /tmp/indexing && mkdir -p /tmp/indexing"
scp -i "$KEY" indexing/*.js "$HOST:/tmp/indexing/"
scp -i "$KEY" index-worker.service "$HOST:/tmp/index-worker.service"
ssh -i "$KEY" "$HOST" "sudo rm -rf $DEST/indexing && sudo mv /tmp/indexing $DEST/indexing && sudo chown -R opc:opc $DEST/indexing && sudo install -m 644 -o root -g root /tmp/index-worker.service /etc/systemd/system/index-worker.service && sudo rm -f /tmp/index-worker.service && sudo restorecon /etc/systemd/system/index-worker.service && sudo systemctl daemon-reload && sudo systemctl enable index-worker >/dev/null 2>&1 && echo '  index worker unit installed'"
# The firm's drafting data, read from beside the modules when they are
# imported: the style sheets (styleSheets/index.js and its JSON, imported by
# firmRules.js and proofCheck.js), the drafting decisions (decisions/*.json,
# read by decisions.js) and the clause lists (skeletons/*.json, read by
# skeletonCheck.js). Each folder is replaced whole, as indexing/ is.
for d in styleSheets decisions skeletons; do
  ssh -i "$KEY" "$HOST" "rm -rf /tmp/$d && mkdir -p /tmp/$d"
  files=("$d"/*.json)
  for f in "$d"/*.js; do if [ -f "$f" ]; then files+=("$f"); fi; done
  scp -i "$KEY" "${files[@]}" "$HOST:/tmp/$d/"
  ssh -i "$KEY" "$HOST" "sudo rm -rf $DEST/$d && sudo mv /tmp/$d $DEST/$d && sudo chown -R opc:opc $DEST/$d"
done
# The reader shells out to poppler (pdfinfo, pdftotext, pdftoppm) and tesseract.
ssh -i "$KEY" "$HOST" "for t in pdfinfo pdftotext pdftoppm tesseract; do command -v \$t >/dev/null || echo \"  WARNING: \$t is not installed; the index worker needs it\"; done"
# The claude.ai connector (connector/*.js and its tool modules under
# connector/tools/) and its unit, the same way: it imports libraryTools.js,
# retrieve.js, firmRules.js and indexing/ from $DEST, so it ships in the
# same deploy. Port 8095; Caddy routes /mcp, /oauth/* and the .well-known
# documents to it (see Caddyfile and docs/claude-ai-connector.md).
ssh -i "$KEY" "$HOST" "rm -rf /tmp/connector && mkdir -p /tmp/connector/tools"
scp -i "$KEY" connector/*.js "$HOST:/tmp/connector/"
scp -i "$KEY" connector/tools/*.js "$HOST:/tmp/connector/tools/"
scp -i "$KEY" hub-connector.service "$HOST:/tmp/hub-connector.service"
ssh -i "$KEY" "$HOST" "sudo rm -rf $DEST/connector && sudo mv /tmp/connector $DEST/connector && sudo chown -R opc:opc $DEST/connector && sudo install -m 644 -o root -g root /tmp/hub-connector.service /etc/systemd/system/hub-connector.service && sudo rm -f /tmp/hub-connector.service && sudo restorecon /etc/systemd/system/hub-connector.service && sudo systemctl daemon-reload && sudo systemctl enable hub-connector >/dev/null 2>&1 && echo '  hub connector unit installed'"
# The AKLA Word renderer: the firm's generator, its emblem, and its Python needs.
ssh -i "$KEY" "$HOST" "rm -rf /tmp/akla && mkdir -p /tmp/akla"
scp -i "$KEY" akla/build_docx.py akla/akla-logo.png akla/requirements.txt "$HOST:/tmp/akla/"
ssh -i "$KEY" "$HOST" "sudo mv /tmp/server.js /tmp/libraryTools.js /tmp/retrieve.js /tmp/agreement.js /tmp/agreementFlow.js /tmp/extractText.js /tmp/docxAgent.js /tmp/research.js /tmp/lawLibrary.js /tmp/precedentSearch.js /tmp/questionnaire.js /tmp/sourcePolicy.js /tmp/review.js /tmp/docxChecks.js /tmp/formatFingerprint.js /tmp/suggestionMerge.js /tmp/claudeSkills.js /tmp/aklaRender.js /tmp/contextBudget.js /tmp/chatState.js /tmp/changes.js /tmp/indexWorker.js /tmp/proofCheck.js /tmp/versionCompare.js /tmp/firmRules.js /tmp/documentInsight.js /tmp/versionChanges.js /tmp/draftingPacks.js /tmp/clauseBank.js /tmp/decisions.js /tmp/skeletonCheck.js /tmp/draftChecks.js /tmp/package.json $DEST/ && sudo rm -rf $DEST/akla && sudo mv /tmp/akla $DEST/akla && sudo mv /tmp/$(basename "$STAMP") $DEST/DEPLOYED_VERSION && sudo chown opc:opc $DEST/server.js $DEST/libraryTools.js $DEST/retrieve.js $DEST/agreement.js $DEST/agreementFlow.js $DEST/extractText.js $DEST/docxAgent.js $DEST/research.js $DEST/lawLibrary.js $DEST/precedentSearch.js $DEST/questionnaire.js $DEST/sourcePolicy.js $DEST/review.js $DEST/docxChecks.js $DEST/formatFingerprint.js $DEST/suggestionMerge.js $DEST/claudeSkills.js $DEST/aklaRender.js $DEST/contextBudget.js $DEST/chatState.js $DEST/changes.js $DEST/indexWorker.js $DEST/proofCheck.js $DEST/versionCompare.js $DEST/firmRules.js $DEST/documentInsight.js $DEST/versionChanges.js $DEST/draftingPacks.js $DEST/clauseBank.js $DEST/decisions.js $DEST/skeletonCheck.js $DEST/draftChecks.js $DEST/package.json $DEST/DEPLOYED_VERSION && sudo chown -R opc:opc $DEST/akla"
rm -f "$STAMP"

# Only reinstall when the manifest actually changed — npm install on every
# deploy is slow and can pull a newer minor of a dependency unasked.
echo "Checking dependencies…"
ssh -i "$KEY" "$HOST" "cd $DEST && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 && echo '  dependencies ok'"

echo "Checking the Word renderer's Python…"
ssh -i "$KEY" "$HOST" "cd $DEST && (test -x .akla-venv/bin/python || sudo -u opc python3 -m venv .akla-venv) && sudo -u opc .akla-venv/bin/pip install -q -r akla/requirements.txt && echo '  renderer ok'"

# The agreement pipeline runs the concession skill's own compiler and checker
# on this box. Ship the skill beside the service and give its scripts the one
# package they need (lxml) in a venv of their own.
echo "Copying the concession skill…"
ssh -i "$KEY" "$HOST" "rm -rf /tmp/concession-agreement"
scp -q -r -i "$KEY" ../firm-skills/concession-agreement "$HOST:/tmp/concession-agreement"
ssh -i "$KEY" "$HOST" "sudo mkdir -p $DEST/skills && sudo rm -rf $DEST/skills/concession-agreement && sudo mv /tmp/concession-agreement $DEST/skills/concession-agreement && sudo chown -R opc:opc $DEST/skills"
ssh -i "$KEY" "$HOST" "cd $DEST && (test -x .skills-venv/bin/python || sudo -u opc python3.11 -m venv .skills-venv) && sudo -u opc .skills-venv/bin/pip install -q lxml && echo '  skill scripts ok'"

# A restart cuts off any reply still being written, and the lawyer is left
# with "Load failed" and nothing saved. Wait until nothing is in progress.
# FORCE=1 skips the wait.
if [ "${FORCE:-0}" != "1" ]; then
  echo "Waiting for requests in progress to finish…"
  for i in $(seq 1 180); do
    busy=$(ssh -i "$KEY" "$HOST" "curl -s -m 5 http://127.0.0.1:8092/health" | sed -n 's/.*"inFlight":\([0-9]*\).*/\1/p')
    # A service from before this check reports no count; treat it as unknown
    # and wait a short while for anything running on it.
    if [ -z "$busy" ]; then
      [ "$i" -ge 3 ] && break
    elif [ "$busy" = "0" ]; then
      break
    else
      [ $((i % 6)) -eq 1 ] && echo "  $busy request(s) still running…"
    fi
    sleep 10
  done
fi

echo "Restarting…"
ssh -i "$KEY" "$HOST" "sudo systemctl restart chat-service && sleep 2 && systemctl is-active chat-service"
# The worker hands back the file it is reading (release_index_job) and picks
# it up again on start; it waits quietly if the migration is not applied yet.
echo "Restarting the index worker…"
ssh -i "$KEY" "$HOST" "sudo systemctl restart index-worker && sleep 2 && systemctl is-active index-worker && sudo journalctl -u index-worker -n 3 --no-pager -o cat"

# The connector keeps no session (one MCP server per request), so a restart
# costs a lawyer's claude.ai at most one retried call.
echo "Restarting the hub connector…"
ssh -i "$KEY" "$HOST" "sudo systemctl restart hub-connector && sleep 2 && systemctl is-active hub-connector && sudo journalctl -u hub-connector -n 3 --no-pager -o cat"

echo "Running version:"
ssh -i "$KEY" "$HOST" "curl -s -m 5 http://127.0.0.1:8092/health"
echo
echo "Connector:"
ssh -i "$KEY" "$HOST" "curl -s -m 5 http://127.0.0.1:8095/health"
echo
# Caddy is not touched here: when the Caddyfile changed, copy its aklachat
# block into /etc/caddy/Caddyfile by hand and `sudo systemctl reload caddy`
# (docs/claude-ai-connector.md, "Deploying").
ssh -i "$KEY" "$HOST" "grep -q '127.0.0.1:8095' /etc/caddy/Caddyfile || echo '  NOTE: /etc/caddy/Caddyfile does not route to the connector yet; see docs/claude-ai-connector.md'"
