#!/usr/bin/env python3
"""One-off, 25 Nov 2026: takes a sender's hidden WhatsApp number out of what the first
documents run wrote ("Rayyan (1969…:32)" becomes "Rayyan"). It changes only that
bracket, in the text of rows the intake itself wrote. Safe to run twice.

    python3 intake-service/deploy/clean_hidden_numbers.py
"""
import base64
import json
import subprocess

REF = 'mhdufgphzalrzhzplbzf'
BRACKET = r'\s*\([^()]*\d{6,}[^()]*\)'      # a bracket holding a run of six or more digits

SQL = f"""
with a as (update public.intake_actions set summary = regexp_replace(summary, '{BRACKET}', '', 'g'),
                  detail = regexp_replace(detail::text, '{BRACKET}', '', 'g')::jsonb
            where summary ~ '\\d{{7,}}[:@]' or detail::text ~ '\\d{{7,}}[:@]' returning 1),
     u as (update public.transaction_updates set body = regexp_replace(body, '{BRACKET}', '', 'g')
            where source in ('whatsapp', 'email') and body ~ '\\d{{7,}}[:@]' returning 1),
     r as (update public.transaction_rows set latest_update = regexp_replace(latest_update, '{BRACKET}', '', 'g')
            where latest_update ~ '\\d{{7,}}[:@]' returning 1),
     d as (update public.intake_documents set sender = regexp_replace(sender, '{BRACKET}', '', 'g')
            where sender ~ '\\d{{7,}}[:@]' returning 1),
     v as (update public.document_versions set label = regexp_replace(label, '{BRACKET}', '', 'g')
            where label like 'From %' and label ~ '\\d{{7,}}[:@]' returning 1),
     t as (update public.intake_tray set payload = regexp_replace(payload::text, '{BRACKET}', '', 'g')::jsonb
            where payload::text ~ '\\d{{7,}}[:@]' returning 1)
select (select count(*) from a) actions, (select count(*) from u) row_lines, (select count(*) from r) rows_latest,
       (select count(*) from d) documents, (select count(*) from v) version_labels, (select count(*) from t) tray
"""

raw = subprocess.run(['security', 'find-generic-password', '-s', 'Supabase CLI', '-w'],
                     capture_output=True, text=True, check=True).stdout.strip()
token = base64.b64decode(raw.replace('go-keyring-base64:', '')).decode()
out = subprocess.run(['curl', '-s', '-X', 'POST', '-H', f'Authorization: Bearer {token}', '-H', 'Content-Type: application/json',
                      '--data-binary', '@-', f'https://api.supabase.com/v1/projects/{REF}/database/query'],
                     input=json.dumps({'query': SQL}).encode(), capture_output=True, check=True).stdout
print('cleaned:', out.decode())
