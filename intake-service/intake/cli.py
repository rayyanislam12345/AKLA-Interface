"""python -m intake <command>: load-sheet, agendas, sheet-sync, documents, projects, mail, status."""
import argparse
import sys
from datetime import date, datetime, timezone

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

    p = sub.add_parser('documents', help='file what the WhatsApp Filer filed into the Hub projects too')
    p.add_argument('--filer-db', help="the Filer's filed.sqlite (default: FILER_DB, else /opt/whatsapp-filer/state/filed.sqlite)")
    p.add_argument('--limit', type=int, help='the most documents this run takes on (default 25; 0 for no limit)')
    p.add_argument('--backfill', action='store_true', help='a bulk run: its indexing waits behind everyone else\'s uploads')
    p.add_argument('--dry-run', action='store_true', help='say what would be filed where; download and write nothing')

    p = sub.add_parser('projects', help='the names projects go by, and the projects the Hub is missing')
    what = p.add_mutually_exclusive_group(required=True)
    what.add_argument('--seed-names', action='store_true', help='copy the names config/transactions.yaml knows onto the Hub (safe to repeat)')
    what.add_argument('--plan', metavar='FILE', help='write the list of coded transactions with no Hub project, for the owner to edit')
    what.add_argument('--apply', metavar='FILE', help='create the projects an edited plan file marks to create (safe to repeat)')
    p.add_argument('--filer-db', help="with --plan: count each code's filed documents in the Filer's filed.sqlite")
    p.add_argument('--dry-run', action='store_true')

    p = sub.add_parser('mail', help='read the firm mailboxes (off until the owner grants the consent and turns it on)')
    p.add_argument('--mailbox', action='append', help='read this address instead of the list in the settings (repeatable)')
    p.add_argument('--limit', type=int, help='the most messages this run handles')
    p.add_argument('--since', type=date.fromisoformat, help='with --dry-run: preview mail received on or after YYYY-MM-DD')
    p.add_argument('--dir', help='an offline try: a folder of .json files, each one message as Graph returns it')
    p.add_argument('--rules-only', action='store_true', help='with --dir: only show what the rules would withhold, drop or read')
    p.add_argument('--write', action='store_true', help='with --dir: really act on the sample messages (default is a dry run)')
    p.add_argument('--dry-run', action='store_true')

    sub.add_parser('status', help='the last runs and what waits in the tray')

    args = ap.parse_args(argv)
    dry = getattr(args, 'dry_run', False)
    db = Db(dry_run=dry)
    if db.offline:
        if args.command == 'status' or (not dry and args.command not in ('agendas', 'mail', 'projects')):
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
        elif args.command == 'documents':
            from .documents import run_documents
            summary = run_documents(db, filer_db=args.filer_db, limit=args.limit, backfill=args.backfill, dry_run=db.dry_run)
            if (summary or {}).get('error'):
                sys.exit(1)        # so systemd shows a run that could not read the Filer's record as failed
        elif args.command == 'projects':
            _projects(db, args)
        elif args.command == 'mail':
            from .mail import run_mail, run_mail_from_folder
            if args.dir:
                run_mail_from_folder(None if args.rules_only else db, args.dir,
                                     mailbox=args.mailbox[0] if args.mailbox else 'sample@akla.com.pk',
                                     dry_run=not args.write or db.dry_run, rules_only=args.rules_only, limit=args.limit)
            else:
                since = datetime.combine(args.since, datetime.min.time(), tzinfo=timezone.utc) if args.since else None
                run_mail(db, mailboxes=args.mailbox or None, dry_run=db.dry_run, limit=args.limit, since=since)
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


def _projects(db, args):
    """--seed-names, then --plan FILE (the owner edits it), then --apply FILE."""
    from . import names, projects
    from .match import Matcher
    if args.seed_names:
        summary = names.seed_names(db)
        log('names: %d added, %d already there; project codes set: %d', summary.get('names_added', 0),
            summary.get('names_existing', 0), summary.get('codes_set', 0))
        if summary.get('code_conflicts'):
            log('codes the Hub already holds differently (left alone): %s', summary['code_conflicts'])
        return
    matcher = Matcher(db)
    if args.plan:
        plan = projects.plan_projects(db, matcher, filer_db=args.filer_db)
        projects.write_plan(args.plan, plan)
        log('%d coded transactions have no Hub project. The list is in %s:', len(plan), args.plan)
        for item in plan:
            log('  %-5s %-55s client: %s', item['code'], item['name'], item.get('client') or '(to fill in)')
        log('Edit the file (set "create": false to leave one out, fix a client or a name), then: python -m intake projects --apply %s', args.plan)
        return
    summary = projects.apply_plan(db, matcher, projects.read_plan(args.apply))
    log('projects: %d created, %d already there, %d left out, %d with no client or name', summary.get('created', 0),
        summary.get('already_there', 0), summary.get('left_out', 0), summary.get('no_name', 0))


def _status(db):
    # The documents and mail runs come round every ten minutes, so the newest ten runs
    # would all be theirs: show the last run of each kind instead.
    print('Last run of each kind:')
    for kind in ('load', 'agendas', 'sheet_sync', 'documents', 'mail', 'projects'):
        for r in db.select('intake_runs', {'kind': f'eq.{kind}'}, 'kind,started_at,finished_at,ok,summary,error',
                           order='started_at.desc', limit=1):
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
    waiting = db.select('intake_documents', {'outcome': 'in.(pending,trayed,error)'}, 'outcome')
    filed = db.select('intake_documents', {'outcome': 'eq.filed'}, 'id')
    print(f'Documents: {len(filed)} filed into projects, {len(waiting)} waiting')
    print(f"  the Hub Intake account: {'there' if _intake_user(db) else 'MISSING (nothing can be filed; run deploy/make_intake_user.py)'}")
    for key in ('auto_create_rows', 'sheet_sync', 'stale_after_days', 'file_documents', 'documents_move_rows',
                'documents_set_status', 'auto_create_projects', 'mail_enabled', 'mail_mailboxes'):
        print(f'  setting {key} = {db.setting(key)}')


def _intake_user(db):
    from .hub import intake_user_id
    return intake_user_id(db)
