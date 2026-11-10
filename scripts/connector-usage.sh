#!/bin/zsh
# Who has connected claude.ai to the Hub, and who has used it.
# Needs the Supabase CLI login in the keychain (supabase login).
set -e
TOK=$(security find-generic-password -s 'Supabase CLI' -w | sed 's/^go-keyring-base64://' | base64 -d)
SQL="select p.full_name as member,
  count(distinct t.family_id) filter (where t.revoked_at is null and t.expires_at > now()) as connections,
  count(distinct a.id) as calls, max(a.created_at)::date as last_used
  from profiles p
  left join connector_tokens t on t.user_id = p.id
  left join connector_actions a on a.user_id = p.id
  where p.full_name <> 'Precedent Backlog Bot'
  group by p.id, p.full_name order by calls desc, p.full_name"
curl -s -X POST https://api.supabase.com/v1/projects/mhdufgphzalrzhzplbzf/database/query \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1]}))' "$SQL")" \
| python3 -c '
import json,sys
rows=json.load(sys.stdin)
print(f"{"Member":22} {"Connected":>9} {"Calls":>6}  Last used")
for r in rows:
    print(f"{r["member"]:22} {("yes" if r["connections"] else "no"):>9} {r["calls"]:>6}  {r["last_used"] or "never"}")'
