"""agendas: read the daily agendas not yet seen and move the rows they describe.

A deliverable block becomes an update line on its row when both the transaction
and the deliverable are sure; otherwise it goes to the tray with the best guess.
Timesheet rows become time suggestions for the person to confirm.
"""
import os
import re
import tempfile
from datetime import datetime

from . import actions, config, hub
from .agenda import parse_agenda, parse_file_name
from .db import in_list
from .log import log, warn
from .match import Matcher, name_key
from .projects import propose_project, ready_matcher


def run_agendas(db, folder=None, use_sharepoint=False, since=None, dry_run=False, rows_sheet=None):
    # The YAML with the Hub's project names laid over it, after any project decisions made in the tray.
    matcher = ready_matcher(db, dry_run=dry_run)
    tz = config.tz()
    people = hub.People(db)
    settings = config.settings()['agendas']
    auto_create = bool(db.setting('auto_create_rows', False))
    rows = hub.rows_from_sheet(rows_sheet, matcher) if rows_sheet else hub.load_rows(db)
    seen_names, seen_hashes = _already_read(db)

    files = _files(folder, use_sharepoint, since, seen_names)
    run_id = hub.start_run(db, 'agendas')
    summary = {'files_seen': len(files), 'files_read': 0, 'files_failed': 0, 'files_skipped_dup': 0, 'blocks': 0,
               'internal_blocks': 0, 'matched': 0, 'unsure': 0, 'no_row': 0, 'created': 0, 'time_lines': 0,
               'time_trayed': 0, 'projects_proposed': 0, 'unresolved_transactions': {}, 'matches': [], 'dry_run': dry_run}
    proposed = set()             # Transaction strings already put forward as a missing project in this run
    try:
        for path in files:
            name = os.path.basename(path)
            try:
                agenda = parse_agenda(path)
            except Exception as e:
                summary['files_failed'] += 1
                db.insert('intake_tray', {'kind': 'agenda_unreadable', 'payload': {'file': name, 'error': repr(e)}})
                warn('%s: unreadable: %r', name, e)
                continue
            if agenda['sha256'] in seen_hashes:
                summary['files_skipped_dup'] += 1
                db.insert('intake_agendas', _agenda_record(agenda, people, matcher, 0, 0, 0))
                continue
            seen_hashes.add(agenda['sha256'])
            counts = _one_agenda(db, agenda, rows, matcher, people, settings, auto_create, tz, summary, proposed)
            db.insert('intake_agendas', _agenda_record(agenda, people, matcher, *counts))
            summary['files_read'] += 1
        hub.finish_run(db, run_id, True, _trim(summary))
    except Exception as e:
        hub.finish_run(db, run_id, False, _trim(summary), repr(e))
        raise
    return summary


def _already_read(db):
    names, hashes = set(), set()
    for a in db.select('intake_agendas', {}, 'file_name,sha256'):
        names.add(a['file_name'])
        hashes.add(a['sha256'])
    return names, hashes


def _files(folder, use_sharepoint, since, seen_names):
    """Local paths of the agenda files to read, newest last."""
    if use_sharepoint:
        from .graph import Graph
        g = Graph()
        rel = config.settings()['sharepoint']['agendas_folder']
        tmp = tempfile.mkdtemp(prefix='intake-agendas-')
        paths = []
        for item in g.children(rel):
            if not item['name'].lower().endswith('.docx') or item['name'] in seen_names or item['name'].startswith('~$'):
                continue
            if since and not _on_or_after(item['name'], since):
                continue
            data, _ = g.download(f'{rel}/{item["name"]}')
            local = os.path.join(tmp, item['name'])
            with open(local, 'wb') as fh:
                fh.write(data)
            paths.append(local)
        return sorted(paths, key=_sort_key)
    paths = []
    for name in os.listdir(folder):
        if not name.lower().endswith('.docx') or name.startswith('~$') or name in seen_names:
            continue
        if since and not _on_or_after(name, since):
            continue
        paths.append(os.path.join(folder, name))
    return sorted(paths, key=_sort_key)


def _on_or_after(name, since):
    _, d, _ = parse_file_name(name)
    return d is None or d >= since


def _sort_key(path):
    _, d, _ = parse_file_name(os.path.basename(path))
    return (d or datetime.min.date(), os.path.basename(path))


def _agenda_record(agenda, people, matcher, matched, trayed, time_lines):
    person = matcher.person(agenda['person'] or '') or ''
    return {'file_name': agenda['file_name'], 'person_name': person, 'person_id': people.id_for(person),
            'agenda_date': agenda['agenda_date'].isoformat() if agenda['agenda_date'] else None,
            'timesheet_date': agenda['timesheet_date'].isoformat() if agenda['timesheet_date'] else None,
            'sha256': agenda['sha256'], 'blocks': len(agenda['blocks']), 'matched': matched,
            'trayed': trayed, 'time_lines': time_lines}


def _propose(db, matcher, transaction, name, person, day, summary, proposed):
    """A Transaction string nothing answers to may be a project the Hub lacks: one tray item per
    name (projects.propose_project), and each distinct string is put forward once per run."""
    key = name_key(transaction)
    if not key or key in proposed:
        return
    proposed.add(key)
    done = propose_project(db, matcher, name=transaction, source='agenda',
                           seen={'where': name, 'person': person, 'date': day.isoformat() if day else None})
    if done.get('action') in ('proposed', 'updated', 'created'):
        summary['projects_proposed'] += 1


def _one_agenda(db, agenda, rows, matcher, people, settings, auto_create, tz, summary, proposed=None):
    proposed = set() if proposed is None else proposed
    name = agenda['file_name']
    person = matcher.person(agenda['person'] or '') or (agenda['person'] or '')
    person_id = people.id_for(person)
    day = agenda['agenda_date']
    at = datetime(day.year, day.month, day.day, settings['update_hour'], 0, tzinfo=tz) if day else None
    matched = trayed = 0
    for block in agenda['blocks']:
        if matcher.is_internal(block['transaction']) or matcher.is_internal(block['complete']):
            summary['internal_blocks'] += 1
            continue
        summary['blocks'] += 1
        entry, t_score = matcher.resolve_transaction(block['transaction'])
        candidates = matcher.candidate_rows(rows, entry) if entry else []
        row, d_score, ranked = matcher.match_row([block['complete'], block['day'], block['scope']], candidates, block['transaction'])
        grade = matcher.grade(t_score, d_score) if row else ('none' if entry is None or t_score < matcher.th['transaction_high'] else 'no_row')
        known = entry is not None and t_score >= matcher.th['transaction_high']
        if entry is None:
            summary['unresolved_transactions'][block['transaction']] = summary['unresolved_transactions'].get(block['transaction'], 0) + 1
            _propose(db, matcher, block['transaction'], name, person, day, summary, proposed)
        # code and transaction_known tell the tray whether accepting this line should also teach the
        # Hub the name (a project_names row), so the same string is never asked about again
        payload = {'person': person, 'person_id': person_id, 'transaction': block['transaction'],
                   'deliverable': block['complete'], 'day_deliverable': block['day'], 'scope': block['scope'],
                   'file': name, 'date': day.isoformat() if day else None,
                   'code': entry['code'] if entry else None, 'transaction_known': known}
        record = {'file': name, 'person': person, 'date': payload['date'], 'transaction': block['transaction'],
                  'code': entry['code'] if entry else None, 'transaction_score': round(t_score, 3),
                  'complete': block['complete'], 'day': block['day'], 'row_id': row['id'] if row else None,
                  'row_deliverable': row['deliverable'] if row else None, 'deliverable_score': round(d_score, 3),
                  'result': grade}
        if grade == 'high':
            _apply_block(db, row, block, person, person_id, at, name, settings)
            summary['matched'] += 1
            matched += 1
        elif grade == 'unsure':
            db.insert('intake_tray', {'kind': 'agenda_line_unsure', 'payload': payload,
                                      'guess': {'row_id': row['id'], 'confidence': f'{d_score:.2f}',
                                                'row_deliverable': row['deliverable'],
                                                'others': [{'row_id': r['id'], 'deliverable': r['deliverable'], 'confidence': f'{s:.2f}'}
                                                           for s, r in ranked[1:]]}})
            summary['unsure'] += 1
            trayed += 1
        else:
            new_row = _new_row(entry, block, person, matcher)
            if auto_create and entry is not None and t_score >= matcher.th['transaction_high'] and not db.offline:
                created = _create_row(db, rows, new_row, block, person, person_id, at, name)
                record['row_id'], record['result'] = created['id'], 'created'
                summary['created'] += 1
                matched += 1
            else:
                db.insert('intake_tray', {'kind': 'agenda_line_no_row', 'payload': payload,
                                          'guess': {'new_row': new_row, 'confidence': f'{t_score:.2f}'}})
                summary['no_row'] += 1
                trayed += 1
        summary['matches'].append(record)
    time_lines = _time_rows(db, agenda, rows, matcher, person, person_id, summary, proposed)
    return matched, trayed, time_lines


def _apply_block(db, row, block, person, person_id, at, name, settings):
    body = re.sub(r'\s+', ' ', block['scope'] or block['complete']).strip()
    day, complete = (block['day'] or '').strip(), (block['complete'] or '').strip()
    if day and complete and day.lower() != complete.lower() and day.lower() not in body.lower():
        body = f'{body} Day deliverable: {day}'
    status = (block['status'] or '').lower()
    # the writer says the deliverable sits with them; the row's status is never changed from an agenda
    changes = {'currently_with': person} if any(phrase in status for phrase in settings['pending_with_me']) else None
    # the line and the move go through actions, so both are logged and a person can undo them
    actions.add_row_update(db, row, body, source='agenda', source_ref=name, at=at.isoformat() if at else None,
                           author=person, author_id=person_id, changes=changes,
                           detail={'from': person, 'via': 'agenda', 'file': name})


def _new_row(entry, block, person, matcher):
    if entry and entry.get('new_row'):
        client, project = entry['new_row']
    elif entry and entry['pairs']:
        client, project = entry['pairs'][0]
    else:
        client, project = block['transaction'], ''
    return {'client': client, 'project': project, 'deliverable': (block['complete'] or block['day']).strip(' .'),
            'team': [person] if person else [], 'matter_id': matcher.matter_for(client, project, block['complete'])}


def _create_row(db, rows, new_row, block, person, person_id, at, name):
    sort_order = max((r['sort_order'] for r in rows), default=0) + 1
    created = db.insert('transaction_rows', {
        'sort_order': sort_order, 'client': new_row['client'], 'project': new_row['project'],
        'deliverable': new_row['deliverable'], 'team': new_row['team'], 'currently_with': person,
        'status': 'In Progress', 'matter_id': new_row['matter_id'], 'updated_source': 'agenda', 'updated_by': person_id})[0]
    rows.append(dict(created, archived_at=None))
    body = re.sub(r'\s+', ' ', block['scope'] or block['complete']).strip()
    # the new row and its first line are one arrival: logged together, each of them undoable
    group = actions.new_group()
    detail = {'from': person, 'via': 'agenda', 'file': name}
    actions.record(db, 'row_created', 'agenda', f"{new_row['deliverable']} \u00b7 new row", source_ref=name,
                   detail=dict(detail, client=new_row['client'], project=new_row['project']), group_id=group,
                   matter_id=new_row['matter_id'], row_id=created['id'])
    actions.add_row_update(db, created, f"Row created from {person}'s agenda: {body}", source='agenda', source_ref=name,
                           at=at.isoformat() if at else None, author=person, author_id=person_id, detail=detail,
                           group_id=group)
    return created


def _time_rows(db, agenda, rows, matcher, person, person_id, summary, proposed=None):
    proposed = set() if proposed is None else proposed
    work_date = agenda['timesheet_date']
    count = 0
    suggestions = []
    for t in agenda['time_rows']:
        if matcher.is_internal(t['transaction']) or t['hours'] is None:
            continue
        date = t['date'] or work_date
        if not date:
            continue
        entry, t_score = matcher.resolve_transaction(t['transaction'])
        row, d_score = None, 0.0
        matter_id = None
        if entry and t_score >= matcher.th['transaction_high']:
            row, d_score, _ = matcher.match_row([t['narrative']], matcher.candidate_rows(rows, entry), t['transaction'])
            if row and d_score < matcher.th['deliverable_high']:
                row = None
            matter_id = row['matter_id'] if row else (entry.get('matter_id') if len({p for p in entry['pairs']}) <= 2 else None)
        source_ref = f'{agenda["file_name"]}#{t["index"]}'
        suggestions.append({'person_id': person_id, 'person_name': person, 'work_date': date.isoformat(),
                            'transaction': t['transaction'], 'narrative': t['narrative'] or t['transaction'],
                            'hours': t['hours'], 'billable_hours': t['billable'], 'row_id': row['id'] if row else None,
                            'matter_id': matter_id, 'source_ref': source_ref})
        count += 1
        if entry is None:
            summary['unresolved_transactions'][t['transaction']] = summary['unresolved_transactions'].get(t['transaction'], 0) + 1
            db.insert('intake_tray', {'kind': 'time_no_row', 'guess': None,
                                      'payload': {'person': person, 'person_id': person_id, 'date': date.isoformat(),
                                                  'hours': f'{t["hours"]:.1f}', 'transaction': t['transaction'],
                                                  'narrative': t['narrative'], 'file': agenda['file_name'],
                                                  'code': None, 'transaction_known': False}})
            _propose(db, matcher, t['transaction'], agenda['file_name'], person, date, summary, proposed)
            summary['time_trayed'] += 1
    if suggestions:
        db.upsert('transaction_time_suggestions', suggestions, on_conflict='source_ref')
    summary['time_lines'] += count
    return count


def _trim(summary):
    """The run record keeps the match list (the Agenda Log is built from it) but not more than it needs."""
    out = dict(summary)
    out['matches'] = summary['matches'][:2000]
    return out
