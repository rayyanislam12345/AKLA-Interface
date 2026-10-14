#!/usr/bin/env bash
# Install the concession-agreement skill into ~/.claude/skills, replacing any existing copy.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/skills/concession-agreement"
mkdir -p "$DEST"
rm -rf "$DEST/references" "$DEST/scripts" "$DEST/assets"
cp "$HERE/SKILL.md" "$DEST/"
cp -R "$HERE/references" "$HERE/scripts" "$HERE/assets" "$DEST/"
find "$DEST" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
echo "Installed to $DEST"
python3 -c "import docx" 2>/dev/null || echo "Still needed:  pip3 install python-docx"
python3 -c "import lxml" 2>/dev/null || echo "Still needed:  pip3 install lxml"
