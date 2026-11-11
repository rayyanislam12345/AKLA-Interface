"""python -m intake <command>: load-sheet, agendas, sheet-sync, status."""
import argparse
import sys
from datetime import date

from . import config
from .db import Db
from .log import log, warn


def main(argv=None):
    ap = argparse.ArgumentParser(prog='python -m intake', description='The Transactions Hub intake service.')
    sub = ap.add_subparsers(dest='command', required=True)

    p = sub.add_parser('load-sheet', help='one-time load of the Excel into the Hub (safe to repeat)')
    p.add_argument('xlsx')
    p.add_argument('--dry-run', action='store_true', help='print what would be written; write nothing')

    p = sub.add_parser('agendas', help='read the daily agendas not yet seen')
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument('--dir', help='a local folder of agenda .docx files')
    src.add_argument('--sharepoint', action='store_true', help='the Daily Agendas folder on SharePoint')
    p.add_argument('--since', type=date.fromisoformat, help='only files dated on or after YYYY-MM-DD')
    p.add_argument('--sheet', help='take the rows from this workbook instead of the Hub (an offline test)')
    p.add_argument('--dry-run', action='store_true')

    p = sub.add_parser('sheet-sync', help='read the sheet\'s edits back, then rewrite it from the Hub')
    p.add_argument('--path', help='a local copy of the sheet instead of the SharePoint file')
    p.add_argument('--out', help='with --dry-run: where to write the rebuilt workbook')
    p.add_argument('--dry-run', action='store_true')

    sub.add_parser('status', help='the last runs and what waits in the tray')

    args = ap.parse_args(argv)
    dry = getattr(args, 'dry_run', False)
    db = Db(dry_run=dry)
    if db.offline:
        if args.command == 'status' or (not dry and args.command != 'agendas'):
            warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; the Hub cannot be reached')
            if args.command == 'status':
                sys.exit(1)
        if not dry:
            warn('no database keys: running as a dry run')
            db.dry_run = True
    try:
        if args.command == 'load-sheet':
            from .load import load_sheet
            load_sheet(args.xlsx, db, dry_run=dry)
        elif args.command == 'agendas':
            from .agendas import run_agendas
            summary = run_agendas(db, folder=args.dir, use_sharepoint=args.sharepoint, since=args.since,
                                  dry_run=dry, rows_sheet=args.sheet)
            _print_agendas(summary)
        elif args.command == 'sheet-sync':
            from .sync import run_sync
            run_sync(db, path=args.path, dry_run=dry, out=args.out)
        elif args.command == 'status':
            _status(db)
    except Exception as e:
        log('ERROR %r', e)
        raise


def _print_agendas(summary):
    log('files: %d seen, %d read, %d failed, %d duplicates', summary['files_seen'], summary['files_read'],
        summary['files_failed'], summary['files_skipped_dup'])
    log('blocks: %d deliverable (%d internal skipped); matched %d, unsure %d, no row %d, created %d',
        summary['blocks'], summary['internal_blocks'], summary['matched'], summary['unsure'],
        summary['no_row'], summary['created'])
    log('timesheet lines: %d (%d to the tray)', summary['time_lines'], summary['time_trayed'])
    if summary['unresolved_transactions']:
        log('transaction strings not recognised: %s', summary['unresolved_transactions'])


def _status(db):
    print('Last runs:')
    for r in db.select('intake_runs', {}, 'kind,started_at,finished_at,ok,summary,error', order='started_at.desc', limit=10):
        s = r.get('summary') or {}
        brief = ', '.join(f'{k} {v}' for k, v in s.items() if isinstance(v, (int, str)) and k not in ('dry_run', 'out'))
        print(f"  {r['started_at'][:19]}  {r['kind']:<10} {'ok' if r['ok'] else ('running' if r['ok'] is None else 'FAILED')}  {brief}"
              + (f"  error: {r['error']}" if r.get('error') else ''))
    print('Open tray items:')
    counts = {}
    for t in db.select('intake_tray', {'status': 'eq.open'}, 'kind'):
        counts[t['kind']] = counts.get(t['kind'], 0) + 1
    for kind, n in sorted(counts.items()):
        print(f'  {kind:<22} {n}')
    if not counts:
        print('  none')
    open_time = db.select('transaction_time_suggestions', {'status': 'eq.open'}, 'id')
    print(f'Open time suggestions: {len(open_time)}')
    for key in ('auto_create_rows', 'sheet_sync', 'stale_after_days'):
        print(f'  setting {key} = {db.setting(key)}')
