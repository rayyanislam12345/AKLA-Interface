#!/usr/bin/env python3
"""One-off, 25 Nov 2026: puts the right sender name on what the first documents runs filed.

Those runs showed WhatsApp senders by the Filer phone's contact names ("Usama Siddique
Akla", "Rayyan (<hidden id>)"). Now a firm member is shown by the name on the staff list,
and anyone else by the contact name with any number taken out. This script applies the same
rule to what was already written: the document records, the version labels, the row lines
(and a row's latest update when it is one of them), the Arrived entries, and the Needs-a-look
items. It changes nothing else, and running it twice changes nothing the second time.

    python3 intake-service/deploy/fix_whatsapp_senders.py --dry-run    # say what would change
    python3 intake-service/deploy/fix_whatsapp_senders.py              # change it

Run it after the VM has the new code (intake-service/deploy/deploy.sh), so no run files
another document the old way afterwards.
"""
import base64
import copy
import json
import os
import re
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
REF = 'mhdufgphzalrzhzplbzf'


def service_env():
    raw = subprocess.run(['security', 'find-generic-password', '-s', 'Supabase CLI', '-w'],
                         capture_output=True, text=True, check=True).stdout.strip()
    token = base64.b64decode(raw.replace('go-keyring-base64:', '')).decode()
    keys = json.loads(subprocess.run(['curl', '-s', '-H', f'Authorization: Bearer {token}',
                                      f'https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true'],
                                     capture_output=True, check=True).stdout)
    os.environ['SUPABASE_SERVICE_ROLE_KEY'] = next(k['api_key'] for k in keys if k.get('name') == 'service_role')
    os.environ['SUPABASE_URL'] = f'https://{REF}.supabase.co'


LINE = re.compile(r'^(?P<word>.*?) (?:received from .*? by WhatsApp|received by WhatsApp|sent by .*? \(.*?\)): (?P<file>.*)$')


def main():
    dry = '--dry-run' in sys.argv
    if not os.environ.get('SUPABASE_SERVICE_ROLE_KEY'):
        service_env()
    from intake import config, documents, hubdocs
    from intake.db import Db
    from intake.filer import clean_sender
    from intake.match import Matcher

    db = Db(dry_run=dry)
    matcher = Matcher(db)
    firm = documents._firm_people(db, matcher)
    aliases = {str(k).lower(): v for k, v in (getattr(matcher, 'aliases', None) or {}).items()}
    tz = config.tz()

    def resolve(text):
        """(name to show, profile id or None, firm?) for a sender as stored."""
        if not text:
            return '', None, False
        full, pid = documents.firm_member(firm, aliases, text, text)
        if full:
            return full, pid, True
        name = clean_sender(text)['name']
        return name, None, bool(re.search(r'(?<![a-z])akla(?![a-z])', text.lower()))

    changed = {'documents': 0, 'labels': 0, 'row_lines': 0, 'rows_latest': 0, 'arrived': 0, 'tray': 0}
    docs = db.select('intake_documents', {'source': 'eq.whatsapp'},
                     'id,filer_id,sender,sender_id,chat,sent_at,document_version_id,filed_name')
    for d in docs:
        old = d.get('sender') or ''
        name, pid, is_firm = resolve(old)
        if (name, pid) != (old, d.get('sender_id')):
            db.patch('intake_documents', {'id': f"eq.{d['id']}"}, {'sender': name or None, 'sender_id': pid})
            changed['documents'] += 1
            print(f"  sender: {re.sub(r'[0-9]{6,}', '<num>', old)!r} -> {name!r}")

        if d.get('document_version_id'):
            v = db.one('document_versions', {'id': f"eq.{d['document_version_id']}"}, 'id,label')
            if v and (v.get('label') or '').startswith('From WhatsApp'):
                sent = datetime.fromisoformat(d['sent_at']) if d.get('sent_at') else None
                label = hubdocs.source_label('whatsapp', d.get('chat'), name, sent, tz)
                if label != v['label']:
                    db.patch('document_versions', {'id': f"eq.{v['id']}"}, {'label': label})
                    changed['labels'] += 1

        ref = f"filer:{d['filer_id']}"
        for u in db.select('transaction_updates', {'source_ref': f'eq.{ref}', 'source': 'eq.whatsapp'}, 'id,row_id,body,author,author_id'):
            m = LINE.match(u['body'] or '')
            if not m:
                continue
            if is_firm:
                body = f"{m['word']} sent by {name or 'the firm'} ({d.get('chat') or 'WhatsApp'}): {m['file']}"
            elif name:
                body = f"{m['word']} received from {name} by WhatsApp: {m['file']}"
            else:
                body = f"{m['word']} received by WhatsApp: {m['file']}"
            author = name.split()[0] if is_firm and name else None
            if (body, author, pid if is_firm else None) == (u['body'], u.get('author'), u.get('author_id')):
                continue
            db.patch('transaction_updates', {'id': f"eq.{u['id']}"},
                     {'body': body, 'author': author, 'author_id': pid if is_firm else None})
            changed['row_lines'] += 1
            row = db.one('transaction_rows', {'id': f"eq.{u['row_id']}"}, 'id,latest_update')
            if row and row.get('latest_update') == u['body']:
                db.patch('transaction_rows', {'id': f"eq.{row['id']}"}, {'latest_update': body})
                changed['rows_latest'] += 1
            for a in db.select('intake_actions', {'update_id': f"eq.{u['id']}"}, 'id,summary,detail'):
                summary = (a['summary'] or '').replace(u['body'], body)
                detail = dict(a.get('detail') or {}, **({'from': name} if name else {}))
                db.patch('intake_actions', {'id': f"eq.{a['id']}"}, {'summary': summary, 'detail': detail})
                changed['arrived'] += 1

        for a in db.select('intake_actions', {'intake_document_id': f"eq.{d['id']}", 'kind': 'eq.version_filed'}, 'id,detail'):
            detail = dict(a.get('detail') or {})
            if name and detail.get('from') != name:
                detail['from'] = name
                db.patch('intake_actions', {'id': f"eq.{a['id']}"}, {'detail': detail})
                changed['arrived'] += 1

    # Open questions in Needs a look carry the sender too.
    for t in db.select('intake_tray', {'status': 'eq.open', 'kind': 'in.(document_no_project,document_unsure,document_undone,new_project)'},
                       'id,payload'):
        payload = copy.deepcopy(t.get('payload') or {})
        if payload.get('person'):
            payload['person'] = resolve(payload['person'])[0] or None
        for seen in payload.get('seen') or []:
            if isinstance(seen, dict) and seen.get('person'):
                seen['person'] = resolve(seen['person'])[0] or None
        if payload != t.get('payload'):
            db.patch('intake_tray', {'id': f"eq.{t['id']}"}, {'payload': payload})
            changed['tray'] += 1

    print(('would change: ' if dry else 'changed: ') + ', '.join(f'{k} {v}' for k, v in changed.items()))


if __name__ == '__main__':
    main()
