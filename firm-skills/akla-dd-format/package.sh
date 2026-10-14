#!/bin/bash
# Build the zip to send an associate.  ./package.sh [output.zip]
set -e
src="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$HOME/Desktop/akla-dd-format.zip}"
tmp="$(mktemp -d)"
mkdir -p "$tmp/akla-dd-format"
cp -R "$src"/SKILL.md "$src"/INSTALL.md "$src"/install.sh \
      "$src"/references "$src"/scripts "$src"/assets "$tmp/akla-dd-format"/
find "$tmp" \( -name '__pycache__' -o -name '.DS_Store' \) -exec rm -rf {} + 2>/dev/null || true
rm -f "$out"
(cd "$tmp" && zip -qr "$out" akla-dd-format)
rm -rf "$tmp"
echo "$out"
unzip -Z1 "$out" | grep -v '/$' | sed 's/^/  /'
