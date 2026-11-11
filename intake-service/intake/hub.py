"""What every command needs from the Hub: the rows, the people, and a run record."""
import uuid
from datetime import datetime, timezone

from . import config, sheet
from .comments import rebuild_comments, split_comments
from .db import in_list
from .log import log

ROW_COLUMNS = 'id,sort_order,client,project,deliverable,team,currently_with,status,matter_id,archived_at,updated_at,latest_update_at'


def load_rows(db, include_archived=False):
    filters = {} if include_archived else {'archived_at': 'is.null'}
    return db.select('transaction_rows', filters, ROW_COLUMNS, order='sort_order.asc')


def rows_from_sheet(path, matcher):
    """Rows in the Hub's shape straight from a workbook, for a dry run with no database."""
    tz = config.tz()
    out = []
    for r in sheet.read_rows(sheet.open_workbook(path)):
        lines = split_comments(r['comments'], tz)
        out.append({
            'id': r['hub_id'] or str(uuid.uuid4()), 'sort_order': r['sort_order'], 'client': r['client'],
            'project': r['project'], 'deliverable': r['deliverable'], 'team': matcher.split_team(r['team_text']),
            'currently_with': r['currently_with'], 'status': r['status'],
            'matter_id': matcher.matter_for(r['client'], r['project'], r['deliverable']),
            'archived_at': None, 'updated_at': None,
            'latest_update_at': max((l['at'] for l in lines if l['at']), default=None),
        })
    return out


def updates_for(db, row_ids):
    if not row_ids:
        return {}
    out = {rid: [] for rid in row_ids}
    for start in range(0, len(row_ids), 100):
        chunk = row_ids[start:start + 100]
        for u in db.select('transaction_updates', {'row_id': in_list(chunk)}, 'id,row_id,at,author,body,source', order='at.asc'):
            out.setdefault(u['row_id'], []).append(u)
    return out


def comments_text(updates, tz):
    from .comments import parse_iso
    return rebuild_comments([{'at': parse_iso(u['at'], tz), 'author': u.get('author'), 'body': u['body']} for u in updates], tz)


class People:
    """profiles by full name, and a first name when it names exactly one person."""
    def __init__(self, db):
        self.by_name, self.by_first = {}, {}
        for p in db.select('profiles', {}, 'id,full_name'):
            name = (p.get('full_name') or '').strip()
            if not name:
                continue
            self.by_name[name.lower()] = p['id']
            self.by_first.setdefault(name.split(' ')[0].lower(), set()).add(p['id'])

    def id_for(self, name):
        if not name:
            return None
        key = name.strip().lower()
        if key in self.by_name:
            return self.by_name[key]
        first = self.by_first.get(key.split(' ')[0])
        return next(iter(first)) if first and len(first) == 1 else None


def start_run(db, kind):
    rows = db.insert('intake_runs', {'kind': kind, 'started_at': now_iso()})
    return rows[0]['id'] if rows else None


def finish_run(db, run_id, ok, summary, error=None):
    db.patch('intake_runs', {'id': f'eq.{run_id}'},
             {'finished_at': now_iso(), 'ok': ok, 'summary': summary, 'error': error})
    log('run %s: %s', 'ok' if ok else 'FAILED', _summary_line(summary))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def _summary_line(summary):
    return ', '.join(f'{k} {v}' for k, v in summary.items() if isinstance(v, (int, float, str)))
