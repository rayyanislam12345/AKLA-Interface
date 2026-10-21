#!/usr/bin/env bash
# Publishes a new version of the companion to the Chrome Web Store, so every
# installed copy updates on its own within a few hours.
#
#   hub-companion/scripts/release.sh            # bump the last number (0.4.0 -> 0.4.1)
#   hub-companion/scripts/release.sh 0.5.0      # or set the version
#   hub-companion/scripts/release.sh --dry-run  # bump and package only
#
# Needs four values, kept OUTSIDE the repository in ~/.akla/cws.env (created
# once; docs/companion-web-store.md says how to get them):
#   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN  (Google OAuth, for the
#   Chrome Web Store API) and CWS_EXTENSION_ID (the store's id for the item).
# Uses the Chrome Web Store API v1.1: upload the zip, then publish it.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

dry=0
want=""
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    *) want="$a" ;;
  esac
done

current="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
original="$(cat manifest.json)"
if [[ -z "$want" ]]; then
  want="$(python3 -c "v='$current'.split('.'); v[-1]=str(int(v[-1])+1); print('.'.join(v))")"
fi
python3 - "$want" <<'EOF'
import json, re, sys
v = sys.argv[1]
if not re.fullmatch(r"\d+(\.\d+){1,3}", v):
    sys.exit(f"Not a version Chrome accepts: {v}")
m = json.load(open("manifest.json"))
m["version"] = v
json.dump(m, open("manifest.json", "w"), indent=2)
open("manifest.json", "a").write("\n")
EOF
echo "Version $current -> $want"

scripts/package.sh --no-key > /dev/null
zip="dist/akla-hub-companion-${want}.zip"
echo "Packaged $zip"

if [[ $dry -eq 1 ]]; then
  printf '%s\n' "$original" > manifest.json
  echo "Dry run: packaged, not uploaded; manifest.json left at $current."
  exit 0
fi

env_file="${CWS_ENV:-$HOME/.akla/cws.env}"
[[ -f "$env_file" ]] || { echo "No $env_file: see docs/companion-web-store.md, 'One-command releases'."; exit 2; }
# shellcheck disable=SC1090
set -a; . "$env_file"; set +a
: "${CWS_CLIENT_ID:?}" "${CWS_CLIENT_SECRET:?}" "${CWS_REFRESH_TOKEN:?}" "${CWS_EXTENSION_ID:?}"

token="$(curl -fsS https://oauth2.googleapis.com/token \
  -d client_id="$CWS_CLIENT_ID" -d client_secret="$CWS_CLIENT_SECRET" \
  -d refresh_token="$CWS_REFRESH_TOKEN" -d grant_type=refresh_token \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')"

echo "Uploading…"
up="$(curl -sS -X PUT -H "Authorization: Bearer $token" -H "x-goog-api-version: 2" \
  -T "$zip" "https://www.googleapis.com/upload/chromewebstore/v1.1/items/$CWS_EXTENSION_ID")"
echo "$up" | python3 -c 'import json,sys
r=json.load(sys.stdin); s=r.get("uploadState")
print("  upload:", s, "; ".join(e.get("error_detail","") for e in r.get("itemError",[])))
sys.exit(0 if s in ("SUCCESS","IN_PROGRESS") else 1)'

echo "Publishing…"
pub="$(curl -sS -X POST -H "Authorization: Bearer $token" -H "x-goog-api-version: 2" -H "Content-Length: 0" \
  "https://www.googleapis.com/chromewebstore/v1.1/items/$CWS_EXTENSION_ID/publish")"
echo "$pub" | python3 -c 'import json,sys
r=json.load(sys.stdin); print("  publish:", ", ".join(r.get("status",[])), "; ".join(r.get("statusDetail",[])))'
echo "Done. Chrome updates installed copies within a few hours (after the store's review, if one is triggered)."
echo "Commit hub-companion/manifest.json (version $want)."
