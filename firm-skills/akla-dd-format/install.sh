#!/bin/bash
# Install the AKLA DD format skill for Claude Code (macOS / Linux).
set -e
src="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.claude/skills/akla-dd-format"
mkdir -p "$HOME/.claude/skills"
if [ -d "$dest" ]; then
  echo "Replacing the existing copy at $dest"
  rm -rf "$dest"
fi
mkdir -p "$dest"
cp -R "$src"/SKILL.md "$src"/references "$src"/scripts "$src"/assets "$dest"/
echo "Installed to $dest"
python3 -c "import docx" 2>/dev/null || echo "Still needed:  pip3 install python-docx"
python3 -c "import pymupdf" 2>/dev/null || echo "For PDF drafts: pip3 install pymupdf"
echo "Restart Claude Code, then ask it to format a DD volume."
