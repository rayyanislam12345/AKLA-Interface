"""sheet-sync: read the people's edits back from the Excel, then rewrite it from the Hub.

The last snapshot says what the service itself wrote. A cell that differs from
it was edited in the sheet; it is applied to the Hub unless the Hub's row also
moved since then, in which case the two values go to the tray and both stay.
"""
import os
import tempfile
from datetime import datetime, timezone

from . import config, hub, sheet
from .comments import line_key, parse_iso, split_comments
from .log import log, warn
from .match import Matcher

FIELDS = ('client', 'project', 'deliverable', 'team', 'currently_with', 'status')


def run_sync(db, path=None, dry_run=False, out=None):
    if not db.offline and not db.setting('sheet_sync', True):
        log('intake_settings.sheet_sync is off; nothing done')
        return {'skipped': 'sheet_sync off'}
    tz = config.tz()
    matcher = Matcher(db)   # the Hub's project names too, so a project made after the YAML keeps its rows
    people = hub.People(db)
    rel = config.settings()['sharepoint']['sheet_path']
    graph = None
    if path:
        with open(path, 'rb') as fh:
            data = fh.read()
        etag = None
    else:
        from .graph import Graph
        graph = Graph()
        data, etag = graph.download(rel)
    wb = sheet.open_workbook(data)
    sheet_rows = sheet.read_rows(wb)
    snapshot = db.one('transaction_sheet_snapshots', {}, 'id,written_at,file_etag,rows') if not db.offline else None
    snapshot = snapshot or {'written_at': None, 'rows': {}}
    hub_rows = hub.load_rows(db, include_archived=True)
    updates = hub.updates_for(db, [r['id'] for r in hub_rows])

    run_id = hub.start_run(db, 'sheet_sync')
    summary = {'sheet_rows': len(sheet_rows), 'hub_rows': len(hub_rows), 'edits_applied': 0, 'conflicts': 0,
               'lines_added': 0, 'rows_created': 0, 'unchanged_etag': bool(etag and etag == snapshot.get('file_etag')),
               'dry_run': dry_run}
    try:
        if not summary['unchanged_etag']:
            _read_back(db, sheet_rows, hub_rows, updates, snapshot, matcher, people, tz, summary,
                       os.path.basename(path or rel))
        else:
            log('the sheet has not changed since the last write (same eTag); read-back skipped')
        written = _write_back(db, wb, hub_rows, updates, matcher, tz)
        if dry_run or db.offline:
            out = out or os.path.join(tempfile.mkdtemp(prefix='intake-sync-'), os.path.basename(rel))
            sheet.save(wb, out)
            log('dry run: workbook written to %s, nothing uploaded', out)
            summary['out'] = out
        else:
            item = graph.upload(rel, sheet.to_bytes(wb))
            etag = item.get('eTag')
            db.insert('transaction_sheet_snapshots', {'rows': written, 'file_etag': etag})
            log('uploaded %s (%d rows)', os.path.basename(rel), len(written))
        hub.finish_run(db, run_id, True, summary)
    except Exception as e:
        hub.finish_run(db, run_id, False, summary, repr(e))
        raise
    return summary


def _sheet_value(field, row, matcher):
    if field == 'team':
        return matcher.split_team(row['team_text'])
    if field == 'currently_with':
        v = (row.get('currently_with') or '').strip()
        return None if v in ('', '-') else v
    return (row.get(field) or '').strip()


def _snap_value(field, snap, matcher):
    if snap is None:
        return None
    v = snap.get(field)
    if field == 'team':
        return list(v) if isinstance(v, list) else matcher.split_team(v or '')
    if field == 'currently_with':
        return None if v in (None, '', '-') else str(v).strip()
    return (v or '').strip()


def _hub_value(field, row):
    v = row.get(field)
    if field == 'team':
        return list(v or [])
    if field == 'currently_with':
        return None if v in (None, '', '-') else str(v).strip()
    return (v or '').strip()


def _read_back(db, sheet_rows, hub_rows, updates, snapshot, matcher, people, tz, summary, file_name):
    by_id = {r['id']: r for r in hub_rows}
    by_key = {(r['sort_order'], r['deliverable'].strip().lower()): r for r in hub_rows if not r['archived_at']}
    written_at = parse_iso(snapshot['written_at'], tz) if snapshot.get('written_at') else None
    snap_rows = snapshot.get('rows') or {}
    for s in sheet_rows:
        row = by_id.get(s['hub_id']) if s['hub_id'] else by_key.get((s['sort_order'], s['deliverable'].strip().lower()))
        if row is None:
            _create_from_sheet(db, s, hub_rows, matcher, people, tz, summary, file_name)
            continue
        snap = snap_rows.get(row['id'])
        hub_moved = bool(written_at and row.get('updated_at') and parse_iso(row['updated_at'], tz) > written_at)
        patch = {}
        for field in FIELDS:
            sheet_v, snap_v, hub_v = _sheet_value(field, s, matcher), _snap_value(field, snap, matcher), _hub_value(field, row)
            if snap is None:
                snap_v = hub_v                      # first sync: the Hub's value stands for what was written
            if sheet_v == snap_v or sheet_v == hub_v:
                continue
            if field == 'status' and sheet_v not in STATUSES:
                warn('row %s: status "%s" is not one the Hub knows; left as is', s['sort_order'], sheet_v)
                continue
            if hub_moved and hub_v != snap_v:
                db.insert('intake_tray', {'kind': 'excel_conflict', 'guess': None, 'payload': {
                    'row_id': row['id'], 'deliverable': row['deliverable'], 'field': field,
                    'sheet': sheet_v, 'hub': hub_v, 'before': snap_v}})
                summary['conflicts'] += 1
                continue
            patch[field] = sheet_v
        if patch:
            patch['updated_source'] = 'excel'
            if 'client' in patch or 'project' in patch or 'deliverable' in patch:
                patch['matter_id'] = matcher.matter_for(patch.get('client', row['client']), patch.get('project', row['project']),
                                                        patch.get('deliverable', row['deliverable']))
            db.patch('transaction_rows', {'id': f'eq.{row["id"]}'}, patch)
            row.update(patch)
            summary['edits_applied'] += len([k for k in patch if k in FIELDS])
        # new dated lines typed into the comments cell
        have = {line_key(parse_iso(u['at'], tz), u['body']) for u in updates.get(row['id'], [])}
        if snap:
            have |= {line_key(l['at'], l['body']) for l in split_comments(snap.get('comments') or '', tz)}
        new = [l for l in split_comments(s['comments'], tz) if l['at'] and line_key(l['at'], l['body']) not in have]
        if new:
            inserted = db.insert('transaction_updates', [{
                'row_id': row['id'], 'at': l['at'].isoformat(), 'author': l['author'],
                'author_id': people.id_for(l['author']), 'body': l['body'], 'source': 'excel',
                'source_ref': f'{file_name}#{s["excel_row"]}'} for l in new])
            updates.setdefault(row['id'], []).extend(inserted)
            summary['lines_added'] += len(new)


def _create_from_sheet(db, s, hub_rows, matcher, people, tz, summary, file_name):
    """A row typed into the sheet that the Hub has never seen."""
    team = matcher.split_team(s['team_text'])
    status = s['status'] if s['status'] in STATUSES else 'In Progress'
    sort_order = max((r['sort_order'] for r in hub_rows), default=0) + 1
    created = db.insert('transaction_rows', {
        'sort_order': sort_order, 'client': s['client'], 'project': s['project'], 'deliverable': s['deliverable'],
        'team': team, 'currently_with': _sheet_value('currently_with', s, matcher), 'status': status,
        'matter_id': matcher.matter_for(s['client'], s['project'], s['deliverable']), 'updated_source': 'excel'})[0]
    created.setdefault('archived_at', None)
    hub_rows.append(created)
    lines = [l for l in split_comments(s['comments'], tz, fallback_date=datetime.now(tz).date()) if l['at']]
    if lines:
        db.insert('transaction_updates', [{
            'row_id': created['id'], 'at': l['at'].isoformat(), 'author': l['author'], 'author_id': people.id_for(l['author']),
            'body': l['body'], 'source': 'excel', 'source_ref': f'{file_name}#{s["excel_row"]}'} for l in lines])
    summary['rows_created'] += 1


def _write_back(db, wb, hub_rows, updates, matcher, tz):
    """Rewrite the data rows and the Agenda Log; returns the snapshot of what was written."""
    rows, written = [], {}
    for r in sorted((r for r in hub_rows if not r.get('archived_at')), key=lambda r: r['sort_order']):
        comments = hub.comments_text(updates.get(r['id'], []), tz)
        row = {'id': r['id'], 'sort_order': r['sort_order'], 'client': r['client'], 'project': r['project'],
               'deliverable': r['deliverable'], 'team': r.get('team') or [], 'currently_with': r.get('currently_with'),
               'comments': comments, 'status': r['status']}
        rows.append(row)
        written[r['id']] = {k: row[k] for k in ('client', 'project', 'deliverable', 'team', 'currently_with', 'comments', 'status')}
    sheet.write_rows(wb, rows)
    sheet.write_agenda_log(wb, _agenda_log(db, hub_rows))
    return written


def _agenda_log(db, hub_rows):
    """One line per agenda block the intake has judged, from the agenda runs' summaries."""
    order = {r['id']: r['sort_order'] for r in hub_rows}
    entries = []
    for run in db.select('intake_runs', {'kind': 'eq.agendas', 'ok': 'is.true'}, 'summary', order='started_at.asc'):
        for m in (run.get('summary') or {}).get('matches', []):
            entries.append({
                'Agenda Date': m.get('date'), 'Employee': m.get('person'), 'Agenda File': m.get('file'),
                'Agenda Transaction': m.get('transaction'), 'Matched Transaction': m.get('code'),
                'Transaction Score': m.get('transaction_score'), 'Day Deliverable': m.get('day'),
                'Complete Deliverable': m.get('complete'), 'Matched Hub Deliverable': m.get('row_deliverable'),
                'Deliverable Score': m.get('deliverable_score'),
                'Hub Row(s)': order.get(m.get('row_id')), 'Status': RESULT_WORDS.get(m.get('result'), m.get('result')),
                'Note': '' if m.get('code') else 'transaction not recognised',
            })
    entries.sort(key=lambda e: (e['Agenda Date'] or '', e['Employee'] or ''))
    return entries


STATUSES = ('Not Started', 'In Progress', 'With Boss', 'With Client', 'With Counterparty',
            'With Client And AKLA', 'On Hold', 'Closed')
RESULT_WORDS = {'high': 'Matched', 'unsure': 'In tray (unsure)', 'none': 'In tray (no row)',
                'no_row': 'In tray (no row)', 'created': 'Row created'}
