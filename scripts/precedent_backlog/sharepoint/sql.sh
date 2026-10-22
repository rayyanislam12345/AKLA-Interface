#!/bin/zsh
# Runs one SQL statement on the live database through the Supabase
# management API, using the Supabase CLI token from the keychain.
#   ./sql.sh "<sql>"
T=$(security find-generic-password -s 'Supabase CLI' -w | sed 's/^go-keyring-base64://' | base64 -d)
Q=$(mktemp)
python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1" > $Q
curl -s -X POST https://api.supabase.com/v1/projects/mhdufgphzalrzhzplbzf/database/query -H "Authorization: Bearer $T" -H "Content-Type: application/json" --data @$Q
rm -f $Q
