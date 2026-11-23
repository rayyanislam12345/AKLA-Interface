"""mail: read the firm's mailboxes and move the rows the mail is about.

    run_mail(db)                                the timer's run (every 10 minutes)
    run_mail_from_folder(db, 'samples/')        an offline try on saved messages: no Graph, no consent

Per mailbox and folder (inbox, sentitems): the delta read gives the new message
ids; what is already recorded is skipped without fetching it; the rest is fetched
a few at a time and handled oldest first by intake/messages.py.

The cursor. A delta link stands for the whole batch, so it is saved only when
every message of the batch has reached a recorded outcome. A batch that stopped
early (a Claude cap was reached, a Claude read failed, a fetch failed, the
--limit ran out) is simply read again next run; the messages already recorded
are recognised by their key and cost one database read between them. Nothing
is kept anywhere but intake_mail_state and intake_messages.

One mailbox failing (no consent, not covered by the access policy, unknown
address) is logged in plain words and the others carry on.

The log never carries a subject, a sender or any text of a message: counts and
rule names only. A dry run also prints the line, note or tray item it would
write, for work mail only.
"""
import json
import os
from datetime import datetime, timezone

from . import config, hub, mailbox as mb, messages, usage
from .db import DbError
from .log import log, warn
from .rules import default_engine

# A run that found nothing to read leaves no intake_runs row: at one run every ten
# minutes the list of runs would otherwise be nothing but empty mail runs.
RECORD_QUIET_RUNS = False


def new_summary(dry_run=False):
    return {'enabled': True, 'dry_run': dry_run, 'mailboxes': 0, 'folders_read': 0, 'baselined': 0, 'rebaselined': 0,
            'seen': 0, 'already_recorded': 0, 'handled': 0, 'withheld': 0, 'dropped': 0, 'nothing': 0, 'acted': 0,
            'trayed': 0, 'error': 0, 'waiting': 0, 'fetch_failed': 0, 'lines_added': 0, 'notes_added': 0,
            'notes_appended': 0, 'tray_items': 0, 'projects_proposed': 0, 'claude_calls': 0, 'usd': 0.0,
            'cursors_saved': 0, 'unfinished': [], 'by_rule': {}, 'mailbox_errors': {}}


def _matcher(db):
    if db is None:
        from .match import Matcher
        return Matcher()
    from .projects import ready_matcher
    return ready_matcher(db)


def run_mail(db, mailboxes=None, dry_run=False, graph=None, classifier=None, limit=None, matcher=None, since=None):
    """Reads every listed mailbox once and returns the summary.

    mailboxes   addresses to read instead of intake_settings.mail_mailboxes
    dry_run     read and classify, write nothing, save no cursor
    graph       the Graph client (default: intake.graph.Graph())
    classifier  callable (message, hints) -> (result or None, usd) (default: classify.Classifier(matcher))
    limit       stop after handling this many messages (the rest are read next run)
    since       dry run only: read mail received from this time on, whatever the stored cursor says
    """
    summary = new_summary(dry_run)
    if not db.setting('mail_enabled', False):
        summary['enabled'] = False
        log('mail: reading is switched off (mail_enabled is false). It waits for the firm\'s admin to grant '
            'the Mail.Read consent; then set mail_enabled to true and list the mailboxes in mail_mailboxes.')
        return summary
    boxes = mailboxes if mailboxes is not None else (db.setting('mail_mailboxes', []) or [])
    boxes = list(dict.fromkeys(b.strip().lower() for b in boxes if b and b.strip()))
    if not boxes:
        log('mail: no mailboxes to read (mail_mailboxes is empty).')
        return summary
    if since is not None and not dry_run:
        warn('mail: --since is for dry runs only; ignored')
        since = None
    if graph is None and not config.has_graph():
        warn('mail: the Microsoft Graph keys (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) are not set; '
             'no mailbox can be read')
        summary['mailbox_errors']['graph'] = 'the Microsoft Graph keys are not set'
        return summary

    run = _Run(db, dry_run, summary, limit)
    try:
        matcher = matcher or _matcher(db)
        run.context = (matcher, hub.load_rows(db), hub.People(db), messages.load_settings(db))
        if classifier is None:
            from .classify import Classifier
            classifier = Classifier(matcher)
        run.classifier = classifier
        if graph is None:
            from .graph import Graph
            graph = Graph()
        summary['mailboxes'] = len(boxes)
        for box in boxes:
            for folder in mb.FOLDERS:
                if run.full():
                    summary['unfinished'].append(f'{box}/{folder}')
                    continue
                try:
                    _read_folder(run, graph, box, folder, since)
                except Exception as e:
                    # Graph said no, the network failed, or the database refused a write: this
                    # mailbox's trouble, not the run's. Anything else is a fault in the code: raise it.
                    if getattr(e, 'status', None) is None and not isinstance(e, (DbError, OSError)):
                        raise
                    if _mailbox_error(run, box, folder, e):
                        break
        if summary['waiting']:
            summary['claude'] = usage.spent(db)
        _report(summary)
        run.finish(not summary['mailbox_errors'])
    except Exception as e:
        run.finish(False, f'{type(e).__name__}')
        raise
    return summary


def run_mail_from_folder(db, folder, mailbox='sample@akla.com.pk', mail_folder='inbox', dry_run=True, classifier=None,
                         limit=None, matcher=None, rules_only=False):
    """An offline try: every `.json` file in `folder` holds one message as Graph returns it
    (GET /users/{id}/messages/{id}); a file may add "mailbox" and "folder" ("inbox" or
    "sentitems") of its own. No Graph call is made and no cursor is touched.

    dry_run     True by default: nothing is written, and the summary says what would be
    rules_only  stop after the rules (no Claude, no key needed): shows what is withheld, dropped or read
    """
    summary = new_summary(dry_run)
    summary['rules_only'] = rules_only
    loaded = []
    for name in sorted(os.listdir(folder)):
        if not name.lower().endswith('.json'):
            continue
        try:
            with open(os.path.join(folder, name), encoding='utf8') as fh:
                node = json.load(fh)
            loaded.append(mb.to_neutral(node, node.get('mailbox') or mailbox, node.get('folder') or mail_folder))
        except Exception as e:
            summary['fetch_failed'] += 1
            warn('mail: %s is not a Graph message (%s)', name, type(e).__name__)
    loaded.sort(key=lambda m: m['sent_at'])
    summary['seen'] = len(loaded)

    if rules_only:
        engine = default_engine()
        for message in loaded[:limit]:
            verdict = engine.evaluate(message)
            outcome = 'to_read' if verdict.outcome == 'read' else verdict.outcome
            summary[outcome] = summary.get(outcome, 0) + 1
            summary['by_rule'][verdict.rule] = summary['by_rule'].get(verdict.rule, 0) + 1
            summary['handled'] += 1
        _report(summary)
        return summary

    run = _Run(db, dry_run, summary, limit)
    try:
        matcher = matcher or _matcher(db)
        run.context = (matcher, hub.load_rows(db), hub.People(db), messages.load_settings(db))
        if classifier is None:
            from .classify import Classifier
            classifier = Classifier(matcher)
        run.classifier = classifier
        if loaded:
            run.begin()
        for message in loaded:
            if run.full() or not run.handle(message):
                summary['unfinished'].append(folder)
                break
        if summary['waiting']:
            summary['claude'] = usage.spent(db)
        _report(summary)
        run.finish(True)
    except Exception as e:
        run.finish(False, f'{type(e).__name__}')
        raise
    return summary


class _Run:
    """What one run carries around: the matcher and rows, the counts, and the run record."""

    def __init__(self, db, dry_run, summary, limit):
        self.db, self.dry_run, self.summary, self.limit = db, dry_run, summary, limit
        self.context = None
        self.classifier = None
        self.run_id = None

    def begin(self):
        """Opens the run record the first time there is something to record (never on a dry run)."""
        if self.run_id is None and not self.dry_run:
            self.run_id = hub.start_run(self.db, 'mail')

    def full(self):
        return self.limit is not None and self.summary['handled'] >= self.limit

    def handle(self, message):
        """Handles one message and counts it. False when the folder must stop here."""
        matcher, rows, people, settings = self.context
        out = messages.handle_message(self.db, message, matcher, rows, people, settings, self.classifier,
                                      dry_run=self.dry_run)
        s = self.summary
        s['claude_calls'] += out.get('calls') or 0
        s['usd'] = round(s['usd'] + (out.get('usd') or 0), 5)
        outcome = out['outcome']
        if outcome == 'seen':
            s['already_recorded'] += 1
            return True
        if outcome == 'wait':
            s['waiting'] += 1
            return False
        s['handled'] += 1
        s[outcome] += 1
        if outcome in ('withheld', 'dropped'):
            s['by_rule'][out['rule']] = s['by_rule'].get(out['rule'], 0) + 1
        s['lines_added'] += 1 if out.get('line') else 0
        s['notes_added'] += 1 if out.get('note') == 'added' else 0
        s['notes_appended'] += 1 if out.get('note') == 'appended' else 0
        s['tray_items'] += 1 if out.get('tray') else 0
        s['projects_proposed'] += 1 if out.get('proposed') else 0
        if self.dry_run and out.get('plan'):
            # work mail only reaches here with a plan; withheld and dropped mail never has one
            log('  would: %s', json.dumps(out['plan'], ensure_ascii=False, default=str)[:400])
        return not (outcome == 'error' and out.get('retry'))

    def finish(self, ok, error=None):
        if not ok or RECORD_QUIET_RUNS:
            self.begin()
        if self.run_id is not None:
            hub.finish_run(self.db, self.run_id, ok, self.summary, error)


def _read_folder(run, graph, box, folder, since):
    db, summary = run.db, run.summary
    now = datetime.now(timezone.utc)
    state = None if since is not None else mb.load_state(db, box, folder)
    baseline = mb.parse_time((state or {}).get('baseline_at'))
    link = (state or {}).get('delta_link')

    items = new_link = None
    if link:
        try:
            items, new_link = mb.read_delta(graph, link)
        except mb.CursorExpired:
            warn('mail: %s %s: the saved place in the folder is no longer accepted; starting afresh from now '
                 '(mail that arrived since the last run is not read)', box, folder)
            summary['rebaselined'] += 1
            baseline = None
            run.begin()
    if items is None:
        # The first read of a folder (or a fresh start): only mail received from the baseline on.
        if since is not None:
            baseline = since
        elif baseline is None:
            baseline = now
            if not link:
                summary['baselined'] += 1
            run.begin()
            if not run.dry_run:
                # kept before anything is read, so a run that stops early starts from the same moment
                mb.save_state(db, box, folder, None, baseline.isoformat())
        items, new_link = mb.read_first(graph, box, folder, baseline)
    summary['folders_read'] += 1

    # Delta also reports old mail that was merely touched (marked read, moved): never read those.
    items = [i for i in items if baseline is None or i['received'] is None or i['received'] >= baseline]
    items.sort(key=lambda i: i['received'] or now)
    summary['seen'] += len(items)

    known = messages.known_rows(db, [i['key'] for i in items])
    pending = []
    for item in items:
        row = known.get(item['key']) if item['key'] else None
        if row and messages.is_final(row):
            messages.add_sighting(db, row, box, run.dry_run)
            summary['already_recorded'] += 1
        else:
            pending.append(item)
    if pending:
        run.begin()

    done = True
    for start in range(0, len(pending), mb.BATCH):
        if run.full():
            done = False
            break
        chunk = pending[start:start + mb.BATCH]
        nodes, failed = mb.fetch_messages(graph, box, [i['id'] for i in chunk])
        if failed:
            summary['fetch_failed'] += len(failed)
            done = False
        batch = sorted((mb.to_neutral(n, box, folder) for n in nodes), key=lambda m: m['sent_at'])
        stopped = False
        for message in batch:
            if run.full() or not run.handle(message):
                stopped = True
                break
        if stopped:
            done = False
            break

    if not done:
        summary['unfinished'].append(f'{box}/{folder}')
    elif new_link and not run.dry_run:
        mb.save_state(db, box, folder, new_link, (baseline or now).isoformat())
        summary['cursors_saved'] += 1


def _mailbox_error(run, box, folder, error):
    """Logs why a folder could not be read, in plain words. True when the whole mailbox should be skipped."""
    status = getattr(error, 'status', None)
    if status in (401, 403):
        reason = ('no permission to read it: the Mail.Read consent has not been granted, '
                  'or the access policy does not cover this mailbox')
    elif status == 404:
        reason = 'no such mailbox (or it has no mail folders)'
    elif status:
        reason = f'Microsoft Graph answered {status}'
    else:
        # only the kind of error: a database error's own text can quote the row it failed on
        reason = f'stopped by an error ({type(error).__name__})'
    warn('mail: %s %s: %s', box, folder, reason)
    run.begin()
    run.summary['mailbox_errors'][f'{box}/{folder}' if status not in (401, 403, 404) else box] = reason
    return status in (401, 403, 404)


def _report(s):
    if not (s['seen'] or s['handled'] or s['waiting'] or s['unfinished'] or s['baselined'] or s['rebaselined']):
        log('mail%s: nothing new in %d mailbox(es)', ' (dry run)' if s['dry_run'] else '', s['mailboxes'])
        return
    rules = ', '.join(f'{rule} {n}' for rule, n in sorted(s['by_rule'].items()))
    log('mail%s: %d new, %d already recorded, %d handled: withheld %d, dropped %d, nothing %d, acted %d, '
        'to the tray %d, errors %d, waiting on a Claude cap %d',
        ' (dry run)' if s['dry_run'] else '', s['seen'], s['already_recorded'], s['handled'], s['withheld'],
        s['dropped'], s['nothing'], s['acted'], s['trayed'], s['error'], s['waiting'])
    if rules:
        log('mail: by rule: %s', rules)
    log('mail: row lines %d, notes %d (+%d added to), tray items %d, projects proposed %d; Claude calls %d, $%.4f',
        s['lines_added'], s['notes_added'], s['notes_appended'], s['tray_items'], s['projects_proposed'],
        s['claude_calls'], s['usd'])
    if s['unfinished']:
        log('mail: not finished this run (read again next run): %s', ', '.join(s['unfinished']))
    if s.get('claude'):
        c = s['claude']
        log('mail: Claude so far: %d of %d reads today, $%.2f of $%.2f this month',
            c['calls_today'], c['daily_calls'], c['usd_month'], c['monthly_usd'])
