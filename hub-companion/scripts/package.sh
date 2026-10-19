#!/usr/bin/env bash
# Zips the extension for the Chrome Web Store (or for handing to a colleague
# to load unpacked). README, tests, this scripts folder and OS clutter stay
# out. The zip lands in hub-companion/dist/.
#
#   scripts/package.sh            # dist/akla-hub-companion-<version>.zip
#   scripts/package.sh --no-key   # same, with the "key" field removed from
#                                 # manifest.json, for a Web Store upload that
#                                 # refuses a manifest key
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

version="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
mkdir -p dist
out="dist/akla-hub-companion-${version}.zip"
rm -f "$out"

if [[ "${1:-}" == "--no-key" ]]; then
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  rsync -a --exclude README.md --exclude tests --exclude scripts --exclude dist \
    --exclude '.DS_Store' --exclude '*.pem' ./ "$stage/"
  python3 - "$stage/manifest.json" <<'EOF'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m.pop("key", None)
json.dump(m, open(p, "w"), indent=2)
EOF
  (cd "$stage" && zip -qr "$here/$out" . -x '.DS_Store' '*/.DS_Store')
else
  zip -qr "$out" . -x 'README.md' 'tests/*' 'scripts/*' 'dist/*' '.DS_Store' '*/.DS_Store' '*.pem'
fi

echo "Wrote $out"
unzip -l "$out"
