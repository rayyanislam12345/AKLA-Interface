#!/bin/zsh
# Who has connected claude.ai to the Hub, on how many days claude.ai fetched a token for them
# (it does so whenever they use claude.ai with the connector on), when it last did, and their saves.
# Needs the Supabase CLI login in the keychain (supabase login).
set -e
TOK=$(security find-generic-password -s 'Supabase CLI' -w | sed 's/^go-keyring-base64://' | base64 -d)
SQL="select p.full_name as member,
  count(distinct t.family_id) filter (where t.revoked_at is null and t.expires_at > now()) as connections,
  count(distinct a.id) as saves, max(t.created_at) filter (where t.kind = 'access')::date as last_used,
  count(distinct t.created_at::date) filter (where t.kind = 'access') as active_days
  from profiles p
  left join connector_tokens t on t.user_id = p.id
  left join connector_actions a on a.user_id = p.id
  where p.full_name <> 'Precedent Backlog Bot'
  group by p.id, p.full_name order by last_used desc nulls last, saves desc, p.full_name"
curl -s -X POST https://api.supabase.com/v1/projects/mhdufgphzalrzhzplbzf/database/query \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1]}))' "$SQL")" \
| python3 -c '
import json,sys
rows=json.load(sys.stdin)
print(f"{"Member":22} {"Connected":>9} {"Days":>5} {"Saves":>6}  Last active")
for r in rows:
    print(f"{r["member"]:22} {("yes" if r["connections"] else "no"):>9} {r["active_days"]:>5} {r["saves"]:>6}  {r["last_used"] or "never"}")'
