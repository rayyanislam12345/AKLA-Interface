#!/usr/bin/env bash
# Zip the skill for sharing. Output defaults to ~/Desktop/concession-agreement.zip.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HOME/Desktop/concession-agreement.zip}"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/concession-agreement"
cp "$HERE/SKILL.md" "$HERE/INSTALL.md" "$HERE/install.sh" "$STAGE/concession-agreement/"
cp -R "$HERE/references" "$HERE/scripts" "$HERE/assets" "$STAGE/concession-agreement/"
find "$STAGE" \( -name '__pycache__' -o -name '.DS_Store' \) -prune -exec rm -rf {} + 2>/dev/null || true
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" concession-agreement)
rm -rf "$STAGE"
echo "Packaged: $OUT"
unzip -Z1 "$OUT" | grep -v '/$' | sed 's/^/  /'
