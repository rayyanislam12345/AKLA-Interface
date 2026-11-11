"""load-sheet: the one-time load of the Excel into transaction_rows and transaction_updates.

Safe to run again: a row is found by its Sr. No. and deliverable and updated;
an update line already there (same day, same words) is not added twice.
Ends by writing a sheet snapshot so the first sheet-sync has a baseline.
"""
import os
from datetime import date

from . import config, hub, sheet
from .agenda import parse_date
from .comments import line_key, parse_iso, split_comments
from .log import log
from .match import Matcher


def load_sheet(path, db, dry_run=False):
    tz = config.tz()
    matcher = Matcher()
    people = hub.People(db)
    sheet_date = parse_date(os.path.basename(path)) or date.today()
    wb = sheet.open_workbook(path)
    rows = sheet.read_rows(wb)
    log('%s: %d rows', os.path.basename(path), len(rows))

    existing = {(r['sort_order'], r['deliverable'].strip().lower()): r for r in hub.load_rows(db, include_archived=True)}
    run_id = hub.start_run(db, 'load')
    summary = {'file': os.path.basename(path), 'rows': len(rows), 'rows_created': 0, 'rows_updated': 0,
               'lines': 0, 'lines_added': 0, 'unknown_people': [], 'no_entry': []}
    snapshot = {}
    try:
        for r in rows:
            team = matcher.split_team(r['team_text'])
            for name in team:
                if name not in matcher.names and name not in summary['unknown_people']:
                    summary['unknown_people'].append(name)
            if matcher.entry_for_pair(r['client'], r['project']) is None:
                pair = f'{r["client"]} / {r["project"]}'
                if pair not in summary['no_entry']:
                    summary['no_entry'].append(pair)
            record = {
                'sort_order': r['sort_order'], 'client': r['client'], 'project': r['project'],
                'deliverable': r['deliverable'], 'team': team, 'currently_with': r['currently_with'],
                'status': r['status'], 'matter_id': matcher.matter_for(r['client'], r['project'], r['deliverable']),
                'updated_source': 'load',
            }
            key = (r['sort_order'], r['deliverable'].strip().lower())
            if key in existing:
                row_id = existing[key]['id']
                db.patch('transaction_rows', {'id': f'eq.{row_id}'}, record)
                summary['rows_updated'] += 1
            else:
                row_id = db.insert('transaction_rows', record)[0]['id']
                summary['rows_created'] += 1
            lines = split_comments(r['comments'], tz, fallback_date=sheet_date)
            summary['lines'] += len(lines)
            have = set()
            if key in existing:
                for u in hub.updates_for(db, [row_id]).get(row_id, []):
                    have.add(line_key(parse_iso(u['at'], tz), u['body']))
            new = []
            for line in lines:
                if line_key(line['at'], line['body']) in have:
                    continue
                new.append({'row_id': row_id, 'at': line['at'].isoformat(), 'author': line['author'],
                            'author_id': people.id_for(line['author']), 'body': line['body'],
                            'source': 'load', 'source_ref': f'{os.path.basename(path)}#{r["excel_row"]}'})
            if new:
                db.insert('transaction_updates', new)
                summary['lines_added'] += len(new)
            snapshot[row_id] = {'client': r['client'], 'project': r['project'], 'deliverable': r['deliverable'],
                                'team': team, 'currently_with': r['currently_with'],
                                'comments': r['comments'], 'status': r['status']}
        db.insert('transaction_sheet_snapshots', {'rows': snapshot, 'file_etag': None})
        hub.finish_run(db, run_id, True, summary)
    except Exception as e:
        hub.finish_run(db, run_id, False, summary, repr(e))
        raise
    if dry_run:
        log('dry run: nothing written. %d rows, %d comment lines; unknown people %s; pairs without a config entry %s',
            len(rows), summary['lines'], summary['unknown_people'], summary['no_entry'])
    return summary
