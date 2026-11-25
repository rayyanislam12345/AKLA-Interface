"""documents: what the WhatsApp Filer filed on SharePoint, filed into its Hub project too.

The Filer's own record (filed.sqlite, read-only) is the only input. For each file it
filed under a transaction code, the intake finds the Hub project, finds the document
the file is the next version of (or sees it is a new one), downloads the file from
SharePoint, files it, and adds a dated line to the Transactions row it belongs to.
Everything it does is written to intake_actions, so a person can undo it.

One run, in order:
  1. carries out what people decided in Needs a look (place it in this project; it is
     the next version of that document; a new document; drop it);
  2. takes, oldest first and at most `limit` a run: documents that were waiting for a
     project that now exists, documents an earlier run could not finish, and the
     Filer's new rows.

What it will not do: file the same file twice (one record per Filer id; a file whose
hash is already on the project is a duplicate; an upload's path is written down before
the upload, so a save that went through unseen is found again, not repeated),
overwrite or delete anything, or let one bad document stop the rest.
"""
import hashlib
import inspect
import difflib
import re
import uuid

from . import actions, config, filenames, hub, hubdocs
from .db import in_list
from .filer import Filer, FilerError, is_eligible
from .graph import GraphError
from .log import log, warn

DEFAULT_LIMIT = 25              # documents a run takes on, so a backlog trickles in and indexing is not flooded
MAX_ATTEMPTS = hubdocs.MAX_ATTEMPTS
WAITING = 'waiting for a project'
TRAY_KINDS = ('document_no_project', 'document_unsure', 'document_undone')
NO_ACCOUNT = ("The Hub has no 'Hub Intake' account yet, so nothing can be filed. "
              'See intake-service/README.md.')
SWITCHED_OFF = 'Filing documents into the Hub is switched off (intake_settings.file_documents); nothing was done.'
SHAREPOINT_DOWN = 'SharePoint could not be reached; it will be tried again on the next run'
MOVED_BY_OUTSIDER = ('With Client', 'With Counterparty')        # an outside sender brings these rows back
STATUS_AFTER_OUTSIDER = 'With Client And AKLA'
_FIRM_TAG = re.compile(r'(?<![A-Za-z])AKLA(?![A-Za-z])')         # a contact saved as "... AKLA" is the firm's own
_CONTINUATION = re.compile(r'^(continuation of comments\b.*|.*\(contd\.?\)\s*)$', re.I)
# What identifies and describes a document in intake_documents; refreshed when the Filer renames or moves it.
_WATCHED = ('sha256', 'filed_name', 'folder', 'web_url', 'code', 'title', 'doc_status')


class _Later(Exception):
    """Not now, and not this document's fault: it stays pending and no attempt is counted."""


class _NotFound(Exception):
    """SharePoint has no file at the Filer's path (it may have been renamed or moved)."""


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

def run_documents(db, filer_db=None, limit=None, backfill=False, dry_run=False, graph=None, matcher=None):
    """Files what the Filer filed into the Hub. Returns the run's summary.

    filer_db   path of the Filer's filed.sqlite (default: FILER_DB, else /opt/whatsapp-filer/state/filed.sqlite)
    limit      the most documents one run takes on (default 25; 0 for no limit). Decisions people
               made in Needs a look are always carried out and do not count.
    backfill   a bulk run: indexing of what it files is queued behind everyone else's uploads
    dry_run    read everything, download nothing, write nothing; one line per document says what would happen
    graph      a Graph to download with (made when first needed)
    matcher    a Matcher (made from the Hub's names when not given)
    """
    dry_run = bool(dry_run or getattr(db, 'dry_run', False))
    limit = DEFAULT_LIMIT if limit is None else max(0, int(limit))
    summary = {'seen': 0, 'handled': 0, 'filed': 0, 'new_documents': 0, 'next_versions': 0, 'duplicates': 0,
               'waiting': 0, 'still_waiting': 0, 'trayed': 0, 'skipped': 0, 'pending': 0, 'postponed': 0,
               'not_found': 0, 'errors': 0, 'row_lines': 0, 'decisions': 0, 'left': 0, 'limit': limit,
               'dry_run': dry_run, 'backfill': bool(backfill), 'note': None, 'error': None, 'documents': []}

    if not _on(db.setting('file_documents', True)):
        summary['note'] = SWITCHED_OFF
        log(SWITCHED_OFF)
        return summary

    reader = Filer(filer_db)
    try:
        eligible = reader.rows()
    except FilerError as e:
        summary['error'] = str(e)
        warn('%s', e)
        if not dry_run:
            hub.finish_run(db, hub.start_run(db, 'documents'), False, _trim(summary), str(e))
        return summary

    run = _Run(db, reader, eligible, matcher or _matcher(db), graph, limit, bool(backfill), dry_run, summary)
    run_id = None if dry_run else hub.start_run(db, 'documents')
    try:
        if run.user_id is None:
            summary['note'] = NO_ACCOUNT
            log(NO_ACCOUNT)
        if run.user_id is None and not dry_run:
            _record_pending(run)
        else:
            _settle_decisions(run)
            for fid, frow, irow in _queue(run):
                _attempt(run, fid, frow, irow)
        if run_id is not None:
            hub.finish_run(db, run_id, True, _trim(summary))
    except Exception as e:
        if run_id is not None:
            try:
                hub.finish_run(db, run_id, False, _trim(summary), repr(e))
            except Exception as again:
                warn('the run record could not be closed: %r', again)
        raise
    if dry_run:
        log('dry run: %s', ', '.join(f'{k} {v}' for k, v in summary.items() if isinstance(v, int) and not isinstance(v, bool) and v))
    return summary


class _Run:
    """What one run knows: the settings, the people, and what it has read so far."""

    def __init__(self, db, reader, eligible, matcher, graph, limit, backfill, dry_run, summary):
        self.db, self.filer, self.matcher, self.graph = db, reader, matcher, graph
        self.limit, self.backfill, self.dry_run, self.summary = limit, backfill, dry_run, summary
        self.eligible = eligible
        self.by_id = {r['id']: r for r in eligible}
        self.tz = config.tz()
        self.user_id = hub.intake_user_id(db)
        self.move_rows = _on(db.setting('documents_move_rows', True))
        self.set_status = _on(db.setting('documents_set_status', False))
        self.high = (getattr(matcher, 'th', None) or config.thresholds())['deliverable_high']
        self.firm = _firm_people(db, matcher)
        self.decided = set()        # filer ids a tray decision is about: step 2 leaves them alone
        self.landed = {}            # filer id -> {'matter_id', 'document_id'}: placed in this run
        self.unsettled = set()      # filer ids tried in this run and not placed
        self.sharepoint_down = None
        self.record_failures = 0
        self._projects, self._rows, self._types, self._names = {}, None, None, {}

    # ---- read once, kept for the run
    def documents(self, matter_id):
        if matter_id not in self._projects:
            self._projects[matter_id] = hubdocs.project_documents(self.db, matter_id)
        return self._projects[matter_id]

    def rows(self):
        if self._rows is None:
            self._rows = hub.load_rows(self.db)
        return self._rows

    def types(self):
        if self._types is None:
            self._types = hubdocs.load_document_types(self.db)
        return self._types

    def project_name(self, matter_id):
        if matter_id not in self._names:
            known = (getattr(self.matcher, 'projects', None) or {}).get(matter_id) or {}
            name = known.get('name')
            if not name:
                row = self.db.one('matters', {'id': f'eq.{matter_id}'}, 'id,name')
                name = (row or {}).get('name')
            self._names[matter_id] = name or str(matter_id)
        return self._names[matter_id]

    def filer_row(self, filer_id):
        if filer_id not in self.by_id:
            self.by_id[filer_id] = self.filer.row(filer_id)
        return self.by_id[filer_id]

    def ancestors(self, frow):
        """The Filer ids this file is a version of, nearest first."""
        out, seen, current = [], {frow['id']}, _int(frow.get('version_of'))
        while current and current not in seen and len(out) < 25:
            out.append(current)
            seen.add(current)
            current = _int((self.filer_row(current) or {}).get('version_of'))
        return out

    # ---- writes (none on a dry run)
    def patch_row(self, irow, data):
        """Writes fields on a document's row, then on the copy in hand (so the copy never says more
        than the Hub does). On a dry run only the copy changes."""
        if irow is None:
            return
        if not self.dry_run and irow.get('id'):
            self.db.patch('intake_documents', {'id': f"eq.{irow['id']}"}, data)
        irow.update(data)

    def ensure_row(self, frow, irow):
        """The document's intake_documents row: made on first sight (outcome 'pending' by the
        table's default, so a conflict can never reset an outcome), refreshed when the Filer
        has since renamed or moved the file."""
        facts = _describe(self, frow)
        if irow is None:
            if self.dry_run:
                return dict(facts, id=None, outcome='pending', attempts=0)
            saved = self.db.upsert('intake_documents', facts, on_conflict='filer_id')
            row = dict(facts, **(saved[0] if saved else {}))
            row.setdefault('outcome', 'pending')
            row.setdefault('attempts', 0)
            return row
        if any((irow.get(k) or None) != (facts.get(k) or None) for k in _WATCHED):
            self.patch_row(irow, facts)
        return irow


def _matcher(db):
    from .match import Matcher
    takes_db = 'db' in inspect.signature(Matcher.__init__).parameters
    if takes_db:
        from .projects import ready_matcher
        matcher = ready_matcher(db)
    else:
        matcher = Matcher()
    for need in ('entry_for_code', 'matter_for_code'):
        if not hasattr(matcher, need):
            raise RuntimeError(f'intake.match.Matcher has no {need}(); the documents command needs it '
                               '(intake-service/docs/phase-2-3-contracts.md).')
    return matcher


def _on(value):
    """A switch from intake_settings (jsonb true/false) as a bool."""
    if isinstance(value, str):
        return value.strip().lower() in ('true', '1', 'yes', 'on')
    return bool(value)


def _int(value):
    try:
        return int(value) if value not in (None, '') else None
    except (TypeError, ValueError):
        return None


def _trim(summary):
    """The run record keeps the per-document list, but not more of it than a page can show."""
    out = dict(summary)
    out['documents'] = summary['documents'][:200]
    return out


# ---------------------------------------------------------------------------
# Who sent it
# ---------------------------------------------------------------------------

def _firm_people(db, matcher):
    """{lower-case full name: (Full Name, profile id or None)}: the Hub's approved profiles, and
    the names the intake's own people list knows (so a dry run without a database still tells a
    firm person from an outside one)."""
    out = {}
    for name in getattr(matcher, 'names', None) or ():
        if name and name.strip():
            out[name.strip().lower()] = (name.strip(), None)
    for p in db.select('profiles', {}, 'id,full_name,status'):
        name = (p.get('full_name') or '').strip()
        if not name or name == hub.INTAKE_PROFILE_NAME or p.get('status', 'approved') != 'approved':
            continue
        out[name.lower()] = (name, p['id'])
    return out


def _known_person(run, text):
    """A firm person by a name people use for them, or (None, None). Stricter than People.id_for:
    a shared first name alone ("Ahmed Raza" for Ahmed Yasin) never makes an outsider one of the firm."""
    if not text:
        return None, None
    known = run.matcher.person(text)
    hit = run.firm.get((known or '').strip().lower())
    if hit:
        return hit
    words = text.lower().split()
    if len(words) >= 2:
        # "Ali Khan" for "Ali Asgher Khan": every word is in the full name and the first names agree
        hits = [v for k, v in run.firm.items() if k.split()[0] == words[0] and set(words) <= set(k.split())]
        if len(hits) == 1:
            return hits[0]
    return None, None


_LABEL_WORDS = {'akla', 'c/o', 'co'}


def firm_member(firm, aliases, contact, raw=''):
    """(Full Name, profile id) for a WhatsApp contact who is one of the firm, else (None, None).

    Staff are saved on the Filer's phone under their first name, with "AKLA" added, with a role
    ("Senior Counsel", "- AKLA Trainee"), or as a push name when unsaved, so the contact name is
    matched to the staff list rather than shown. The first word must be a firm person's first
    name (or a known short form), and then one of these must hold, so an outsider who merely
    shares a first name ("Ahmed Raza") is not taken for one of the firm:
      - the contact is that one word ("Umer", or an unsaved "Rayyan");
      - the contact carries AKLA, in any case ("Usama Siddique Akla", "Huroom Khan AKLA");
      - a later word is close to a later word of the full name ("Siddique" for "Siddiqui").
    firm     {lower-case full name: (Full Name, id)}
    aliases  {lower-case short form: Full Name}"""
    text = re.sub(r'\s*\([^()]*\)', ' ', raw or contact or '')          # numbers and "(ADB)"-style notes
    words = [w for w in re.findall(r"[a-z]+", text.lower())]
    if not words:
        return None, None
    tagged = 'akla' in words
    words = [w for w in words if w not in _LABEL_WORDS]
    if not words:
        return None, None
    hit = firm.get(' '.join(words))
    if hit:
        return hit
    first, rest = words[0], words[1:]
    by_first = {}
    for key, value in firm.items():
        by_first.setdefault(key.split()[0], []).append(value)
    named = aliases.get(first)
    if named:
        candidates = [firm[named.lower()]] if named.lower() in firm else []
    else:
        candidates = by_first.get(first, [])
    if len(candidates) != 1:
        if rest and len(candidates) > 1:       # two people share the first name: the surname decides
            candidates = [c for c in candidates if _surname_close(rest, c[0])]
        if len(candidates) != 1:
            return None, None
    full = candidates[0]
    if not rest or tagged or _surname_close(rest, full[0]):
        return full
    return None, None


def _surname_close(rest, full_name):
    later = full_name.lower().split()[1:]
    return any(difflib.SequenceMatcher(None, w, x).ratio() >= 0.8 for w in rest for x in later if len(w) > 2)


def _who(run, frow):
    """The sender: {'name' as shown, 'full' (the firm person's full name), 'first', 'firm', 'id'}.

    WhatsApp: a firm person is a saved contact whose name is a profile's (or a known short form of
    one), or a contact the phone labels AKLA. Email: anything from Sent Items, an address on the
    mailbox's own domain, or a sender whose name is exactly a profile's."""
    name = frow.get('sender_name') or ''
    raw = frow.get('sender') or ''
    saved = frow.get('sender_saved', True)
    full, pid = run.firm.get(name.lower(), (None, None)) if name else (None, None)
    firm = full is not None
    if frow.get('source') == 'email':
        ours = lambda address: address.rsplit('@', 1)[-1].lower() if address and '@' in address else None
        if frow.get('direction') == 'sent' or (ours(frow.get('sender_email')) and
                                               ours(frow.get('sender_email')) == ours(frow.get('mailbox'))):
            firm = True
            if not full:
                full, pid = _known_person(run, name)
    elif not firm:
        # WhatsApp: matched to the staff list; anyone else keeps the contact name (no number).
        aliases = {str(k).lower(): v for k, v in (getattr(run.matcher, 'aliases', None) or {}).items()}
        full, pid = firm_member(run.firm, aliases, name, raw)
        # A contact the phone labels AKLA but not on the staff list yet (a new trainee) is still
        # the firm's own; they are shown by the contact name until the Hub has them.
        firm = full is not None or bool(re.search(r'(?<![a-z])akla(?![a-z])', raw.lower()))
    shown = full or name
    return {'name': name, 'full': full, 'first': shown.split()[0] if shown else '', 'firm': firm, 'id': pid}


def _via(frow):
    return 'WhatsApp' if frow.get('source') == 'whatsapp' else 'email'


def _sent_iso(frow):
    return frow['sent_at'].isoformat() if frow.get('sent_at') else None


def _describe(run, frow):
    """What intake_documents says about a file, from the Filer's row."""
    who = _who(run, frow)
    return {
        'filer_id': frow['id'], 'sha256': frow.get('sha256'), 'original_name': frow.get('original_name'),
        'filed_name': frow.get('filed_name'), 'folder': frow.get('folder'), 'web_url': frow.get('web_url'),
        'code': frow.get('code'), 'transaction_name': frow.get('transaction_name'), 'title': frow.get('title') or None,
        'party': frow.get('party'), 'doc_status': frow.get('doc_status'), 'document_date': frow.get('document_date'),
        'source': frow.get('source') or 'whatsapp', 'chat': frow.get('chat'), 'mailbox': frow.get('mailbox'),
        'direction': frow.get('direction'), 'sender': (who['full'] or who['name']) or None, 'sender_id': who['id'],
        'sent_at': _sent_iso(frow), 'caption': frow.get('caption'),
    }


def _payload(frow, irow, who):
    """A tray item's payload for a document (docs/phase-2-3-contracts.md)."""
    return {'intake_document_id': irow.get('id'), 'file': frow.get('filed_name'), 'title': frow.get('title'),
            'transaction': frow.get('transaction_name') or frow.get('code'), 'code': frow.get('code'),
            'person': (who['full'] or who['name']) or None, 'chat': frow.get('chat'), 'date': _sent_iso(frow),
            'web_url': frow.get('web_url'), 'via': _via(frow)}


# ---------------------------------------------------------------------------
# What there is to do
# ---------------------------------------------------------------------------

def _known_ids(db):
    return {int(r['filer_id']) for r in hubdocs.select_all(db, 'intake_documents', {}, 'filer_id', key='filer_id')}


def _record_pending(run):
    """No Hub Intake account: nothing can be filed, but what the Filer filed is written down as
    pending, so it is filed (oldest first, `limit` a run) once the account exists."""
    known = _known_ids(run.db)
    new = [r for r in run.eligible if r['id'] not in known]
    run.summary['seen'] = len(new)
    for start in range(0, len(new), 100):
        chunk = new[start:start + 100]
        try:
            run.db.upsert('intake_documents', [_describe(run, r) for r in chunk], on_conflict='filer_id')
            run.summary['pending'] += len(chunk)
        except Exception as e:
            run.summary['errors'] += len(chunk)
            warn('could not record %d documents as pending: %s', len(chunk), hubdocs._brief(e))


def _queue(run):
    """[(filer id, the Filer's row or None, the intake_documents row or None)], oldest first, at
    most `limit`: documents an earlier run left pending or failed on (fewer than five attempts),
    documents that waited for a project that now exists, and rows the Hub has not recorded yet."""
    db, summary = run.db, run.summary
    known = _known_ids(db)
    new = [r['id'] for r in run.eligible if r['id'] not in known]
    summary['seen'] = len(new)
    entries = {}
    for irow in hubdocs.select_all(db, 'intake_documents', {'outcome': in_list(['pending', 'error']),
                                                           'attempts': f'lt.{MAX_ATTEMPTS}'}, '*', key='filer_id'):
        entries[int(irow['filer_id'])] = irow
    for irow in hubdocs.select_all(db, 'intake_documents', {'outcome': 'eq.trayed', 'reason': f'like.{WAITING}*'},
                                   '*', key='filer_id'):
        fid = int(irow['filer_id'])
        frow = run.filer_row(fid)
        if not is_eligible(frow) or run.matcher.matter_for_code(frow['code'], frow.get('title') or ''):
            entries[fid] = irow                      # its project exists now (or the Filer withdrew the file)
        else:
            summary['still_waiting'] += 1
    todo = [(fid, run.by_id.get(fid), entries.get(fid))
            for fid in sorted(set(entries) | set(new)) if fid not in run.decided]
    if run.limit and len(todo) > run.limit:
        summary['left'] = len(todo) - run.limit
        todo = todo[:run.limit]
    return todo


# ---------------------------------------------------------------------------
# Decisions people made in Needs a look
# ---------------------------------------------------------------------------

def _settle_decisions(run):
    """Accepted or dropped document items whose resolution has no `filed` key yet. Accepted: the
    person chose the project (and, for an unsure match, the document or "a new document"); the file
    is filed there and the resolution gains {filed: true, version_id}. Dropped: the document is
    marked skipped. An item that cannot be carried out is closed with {filed: false, reason}."""
    db, summary = run.db, run.summary
    items = db.select('intake_tray', {'kind': in_list(TRAY_KINDS), 'status': in_list(['accepted', 'dropped']),
                                      'resolution->>filed': 'is.null'},
                      'id,kind,status,payload,resolution', order='resolved_at.asc', limit=200)
    for item in items:
        try:
            _settle_one(run, item)
        except Exception as e:
            summary['errors'] += 1
            warn('Needs a look item %s could not be carried out: %s', item.get('id'), hubdocs._brief(e))


def _settle_one(run, item):
    db, summary = run.db, run.summary
    payload, resolution = item.get('payload') or {}, item.get('resolution') or {}
    doc_id = payload.get('intake_document_id')
    irow = db.one('intake_documents', {'id': f'eq.{doc_id}'}, '*') if doc_id else None
    if not irow:
        return _close(run, item, False, reason='the document record is gone')
    fid = int(irow['filer_id'])
    run.decided.add(fid)
    name = irow.get('filed_name') or f'filer:{fid}'

    if item['status'] == 'dropped':
        if irow.get('outcome') in ('trayed', 'undone', 'pending', 'error'):
            run.patch_row(irow, {'outcome': 'skipped', 'reason': 'dropped by a person', 'handled_at': hub.now_iso()})
            summary['skipped'] += 1
            log('filer:%s  %s  ->  %s', fid, name, 'would be marked skipped (dropped by a person)' if run.dry_run
                else 'skipped (dropped by a person)')
        return _close(run, item, False)

    if irow.get('outcome') == 'filed':
        return _close(run, item, True, version_id=irow.get('document_version_id'))
    if irow.get('outcome') in ('duplicate', 'skipped'):
        return _close(run, item, False, reason=irow.get('reason') or irow['outcome'])
    matter_id = resolution.get('matter_id') or (payload.get('matter_id') if item['kind'] == 'document_unsure' else None)
    if not matter_id:
        warn('Needs a look item %s was accepted without a project; nothing to file', item.get('id'))
        return _close(run, item, False, reason='no project was chosen')
    if (irow.get('attempts') or 0) >= MAX_ATTEMPTS:
        return _close(run, item, False, reason=irow.get('reason') or 'it could not be filed')

    summary['decisions'] += 1
    decision = {'matter_id': matter_id, 'document_id': resolution.get('document_id'),
                'new_document': bool(resolution.get('new_document'))}
    result = _attempt(run, fid, run.by_id.get(fid), irow, decision)
    outcome = result['outcome']
    if outcome == 'filed':
        _close(run, item, True, version_id=result.get('version_id'))
    elif outcome in ('duplicate', 'trayed', 'waiting', 'skipped', 'settled'):
        _close(run, item, False, reason=result.get('reason') or outcome)
    elif (irow.get('attempts') or 0) >= MAX_ATTEMPTS:
        _close(run, item, False, reason=result.get('reason') or 'it could not be filed')
    # otherwise it is tried again on the next run; the item stays as it is


def _close(run, item, filed, **extra):
    """Writes what became of a decision into the item's resolution, so it is not read again."""
    if run.dry_run:
        return
    resolution = dict(item.get('resolution') or {}, filed=filed, **{k: v for k, v in extra.items() if v is not None})
    run.db.patch('intake_tray', {'id': f"eq.{item['id']}"}, {'resolution': resolution})


# ---------------------------------------------------------------------------
# One document
# ---------------------------------------------------------------------------

def _attempt(run, fid, frow, irow, decision=None):
    """Handles one document and never raises for that document's own trouble: the failure is
    recorded on its row and the run carries on. Returns {'outcome', 'reason', 'version_id'}."""
    summary = run.summary
    rec = {'filer_id': fid, 'file': (frow or irow or {}).get('filed_name'), 'code': (frow or irow or {}).get('code')}
    summary['documents'].append(rec)
    summary['handled'] += 1
    result = {'outcome': 'error', 'reason': None, 'version_id': None}
    try:
        frow = frow or run.filer_row(fid)
        if not is_eligible(frow):
            reason = "no longer in the Filer's record as a filed document"
            if irow is not None:
                run.patch_row(irow, {'outcome': 'skipped', 'reason': reason, 'handled_at': hub.now_iso()})
            summary['skipped'] += 1
            log('filer:%s  %s  ->  skipped: %s', fid, rec['file'], reason)
            result.update(outcome='skipped', reason=reason)
        else:
            rec['file'] = frow.get('filed_name')
            irow = run.ensure_row(frow, irow)
            if not _open(irow, decision):
                # Settled already (a record that was there after all): never handled a second time.
                result.update(outcome='settled', reason=irow.get('reason'), version_id=irow.get('document_version_id'))
                summary['handled'] -= 1
            else:
                result.update(_handle(run, frow, irow, decision))
    except _Later as e:
        run.unsettled.add(fid)
        summary['postponed'] += 1
        result.update(outcome='postponed', reason=str(e))
        note = {'reason': str(e)}
        if irow is not None and irow.get('outcome') == 'trayed' and decision is None:
            note['outcome'] = 'pending'       # it was waiting for its project; now it only waits for the next run
        _record(run, irow, note)
        log('filer:%s  %s  ->  not yet: %s', fid, rec['file'], e)
    except _NotFound:
        run.unsettled.add(fid)
        summary['not_found'] += 1
        reason = 'not found on SharePoint at the place the Filer recorded (renamed or moved?)'
        result.update(outcome='not_found', reason=reason)
        _fail(run, irow, reason, stay_pending=True)
        warn('filer:%s  %s  ->  %s; attempt %s of %s', fid, rec['file'], reason,
             (irow or {}).get('attempts'), MAX_ATTEMPTS)
    except Exception as e:
        run.unsettled.add(fid)
        summary['errors'] += 1
        reason = hubdocs._brief(e)
        result.update(outcome='error', reason=reason)
        _fail(run, irow, reason)
        warn('filer:%s  %s  ->  could not be filed: %s', fid, rec['file'], reason)
    rec.update(outcome=result['outcome'], reason=result.get('reason'),
               **{k: result[k] for k in ('project', 'document', 'version', 'row') if result.get(k) is not None})
    return result


def _open(irow, decision):
    """True while a document may still be filed: pending, failed and due another try, or waiting for
    its project; and, when a person has decided in Needs a look, waiting there or undone."""
    outcome = irow.get('outcome') or 'pending'
    if irow.get('document_version_id') or outcome in ('filed', 'duplicate', 'skipped'):
        return False
    if outcome in ('pending', 'error'):
        return True
    if decision is not None:
        return outcome in ('trayed', 'undone')
    return outcome == 'trayed' and (irow.get('reason') or '').startswith(WAITING)


def _record(run, irow, data):
    """Writes a failure or a postponement on the document's row. If the Hub cannot even take that,
    three times running, the run stops: nothing more can be recorded, so nothing more should be filed."""
    try:
        run.patch_row(irow, data)
        run.record_failures = 0
    except Exception as e:
        run.record_failures += 1
        warn('could not record that on the document: %s', hubdocs._brief(e))
        if run.record_failures >= 3:
            raise RuntimeError('the Hub is not taking writes; the run was stopped') from None


def _fail(run, irow, reason, stay_pending=False):
    """Counts an attempt. A missing file stays pending until the fifth attempt; anything else is an
    error at once and is tried again on later runs while it has fewer than five attempts.

    An undone filing being placed again stays 'undone' until it is given up: its storage_path is
    still the file the undo left in storage, which is kept, and only a row that is pending or in
    error has a path the intake may clear (see _handle)."""
    if irow is None:
        return
    attempts = (irow.get('attempts') or 0) + 1
    given_up = attempts >= MAX_ATTEMPTS
    if given_up:
        outcome = 'error'
    elif irow.get('outcome') == 'undone':
        outcome = 'undone'
    else:
        outcome = 'pending' if stay_pending else 'error'
    data = {'attempts': attempts, 'reason': reason[:300], 'outcome': outcome}
    if given_up:
        data['handled_at'] = hub.now_iso()
    _record(run, irow, data)


def _handle(run, frow, irow, decision=None):
    """The steps for one document. Returns the result; raises for anything that stopped it."""
    db, summary, fid = run.db, run.summary, frow['id']
    who = _who(run, frow)
    title = frow.get('title') or filenames.parse_file_name(frow.get('filed_name') or '')['title']
    say = lambda text: log('filer:%s  %s  ->  %s', fid, frow.get('filed_name'), text)

    # ---- a save an earlier run made and could not finish recording (found by the path written down first)
    kept = irow.get('storage_path')
    if kept and not irow.get('document_version_id') and irow.get('outcome') in ('pending', 'error'):
        version = hubdocs.version_at_path(db, kept)
        if version:
            return _adopt(run, frow, irow, who, version, say)
        if not run.dry_run:
            try:
                db.storage_remove(hubdocs.BUCKET, [kept])      # an upload of ours that no version uses
            except Exception as e:
                raise _Later(f"the Hub's storage could not be reached ({hubdocs._brief(e)})") from None
            run.patch_row(irow, {'storage_path': None})

    # ---- the project
    entry = run.matcher.entry_for_code(frow['code'])
    matter_id = (decision or {}).get('matter_id')
    if not matter_id:
        if entry is None:
            return _tray_no_project(run, frow, irow, who, say)
        matter_id = run.matcher.matter_for_code(frow['code'], title)
        if not matter_id:
            return _wait_for_project(run, frow, irow, who, say)
    project = run.project_name(matter_id)
    documents = run.documents(matter_id)

    # ---- the same file is already on the project
    same = hubdocs.find_by_hash(documents, frow.get('sha256'))
    if same:
        return _duplicate(run, frow, irow, matter_id, same, say)

    # ---- which document
    target = None
    if decision and decision.get('document_id'):
        target = next((d for d in documents if d['id'] == decision['document_id']), None)
        if target is None:
            raise RuntimeError('the document chosen in Needs a look is no longer on that project')
    elif not (decision and decision.get('new_document')):
        choice = hubdocs.choose_document(db, documents, title, matter_id=matter_id, ancestors=run.ancestors(frow),
                                         landed=run.landed, unsettled=run.unsettled)
        if choice['kind'] == 'wait':
            raise _Later(f"the earlier version (filer:{choice['ancestor']}) is to be filed first")
        if choice['kind'] == 'unsure':
            return _tray_unsure(run, frow, irow, who, matter_id, choice, say)
        target = choice['document']
    doc_title = target['title'] if target else title
    number = hubdocs.next_version_number(target)

    if run.dry_run:
        return _plan(run, frow, who, matter_id, project, target, doc_title, number, entry, say)
    if not run.user_id:
        raise _Later(NO_ACCOUNT)

    # ---- the file itself, from SharePoint
    data = _download(run, frow)
    if not data:
        raise RuntimeError('the file on SharePoint is empty')
    content_hash = hashlib.sha256(data).hexdigest()
    same = hubdocs.find_by_hash(documents, content_hash)
    if same:
        return _duplicate(run, frow, irow, matter_id, same, say)

    # ---- file it. The path is written on the document's row before the upload, so a save whose
    #      answer is lost is recognised on the next run instead of being made twice.
    doc_id = target['id'] if target else str(uuid.uuid4())
    path = hubdocs.storage_path(matter_id, doc_id, frow['filed_name'])
    run.patch_row(irow, {'matter_id': matter_id, 'storage_path': path, 'outcome': 'pending', 'reason': None})
    sender = who['full'] or who['name']        # a firm member by their real name; anyone else as WhatsApp has them
    saved = hubdocs.file_version(
        db, user_id=run.user_id, matter_id=matter_id, title=doc_title, file_name=frow['filed_name'], data=data,
        label=hubdocs.source_label(frow.get('source'), frow.get('chat'), sender, frow.get('sent_at'), run.tz),
        document=target, document_id=doc_id,
        document_type_id=None if target else hubdocs.document_type_id(run.types(), frow.get('document_type')),
        doc_status=frow.get('doc_status'), content_hash=content_hash, backfill=run.backfill, path=path)
    return _after_save(run, frow, irow, who, matter_id, doc_title, saved, entry, say)


def _download(run, frow):
    """The file's bytes from SharePoint.

    A 404 is this file's own trouble (_NotFound: counted, tried again). Any other failure is
    checked against SharePoint itself: if SharePoint answers, the trouble is this file's (too big
    to fetch in time, locked) and an attempt is counted; if it does not (the app's secret, a
    throttle, no network), the run stops downloading and no document is charged for it."""
    if run.sharepoint_down:
        raise _Later(SHAREPOINT_DOWN)
    rel = '/'.join(p for p in ((frow.get('folder') or '').strip('/'), frow.get('filed_name') or '') if p)
    try:
        if run.graph is None:
            from .graph import Graph
            run.graph = Graph()
        data, _ = run.graph.download(rel)
        return data
    except GraphError as e:
        if e.status == 404:
            raise _NotFound() from None
        reason = f'SharePoint refused the file ({hubdocs._brief(e)})'
    except Exception as e:
        reason = f'the file could not be downloaded ({hubdocs._brief(e) or e.__class__.__name__})'
    if _sharepoint_answers(run):
        raise RuntimeError(reason)
    run.sharepoint_down = reason
    warn('SharePoint is not answering (%s); no more downloads this run', reason)
    raise _Later(SHAREPOINT_DOWN)


def _sharepoint_answers(run):
    """One small question to SharePoint (the drive itself), to tell its trouble from one file's."""
    try:
        drive, _ = run.graph.data_room()
        run.graph.call('GET', f'/drives/{drive}?$select=id', retries=1)
        return True
    except Exception:
        return False


# ---- the ways a document ends

def _tray_no_project(run, frow, irow, who, say):
    """The Filer's code names no transaction the intake knows: one item in Needs a look."""
    reason = f"no transaction is known for the code {frow['code']}"
    guess = None
    name = frow.get('transaction_name') or ''
    entry, score = run.matcher.resolve_transaction(name) if name else (None, 0.0)
    near = (entry or {}).get('matter_id') or next(iter((entry or {}).get('matters') or []), None)
    if near and score >= 0.6:
        guess = {'matter_id': near, 'confidence': f'{score:.2f}'}
    elif name:
        guess = {'new_project': {'name': name, 'client': '', 'code': frow['code']}}
    if not run.dry_run:
        _to_tray(run, 'document_no_project', irow, _payload(frow, irow, who), guess)
        run.patch_row(irow, {'outcome': 'trayed', 'reason': reason, 'handled_at': hub.now_iso()})
    run.summary['trayed'] += 1
    say(f'Needs a look: {reason}')
    return {'outcome': 'trayed', 'reason': reason}


def _to_tray(run, kind, irow, payload, guess):
    """One open item per document and kind: if an earlier attempt put it there and then failed to
    say so on the document's row, it is not put there a second time."""
    already = run.db.select('intake_tray', {'kind': f'eq.{kind}', 'status': 'eq.open',
                                            'payload->>intake_document_id': f"eq.{irow['id']}"}, 'id', limit=1)
    if not already:
        run.db.insert('intake_tray', {'kind': kind, 'payload': payload, 'guess': guess})


def _wait_for_project(run, frow, irow, who, say):
    """A known transaction with no Hub project: the document waits, and the one "new project" item
    for its code counts it. It is filed by the first run after the project exists."""
    reason = f"{WAITING} ({frow['code']})"
    first_time = irow.get('outcome') != 'trayed' or not (irow.get('reason') or '').startswith(WAITING)
    if not run.dry_run and first_time:
        run.patch_row(irow, {'outcome': 'trayed', 'reason': reason, 'handled_at': hub.now_iso()})
        _propose(run, frow, who)
    run.summary['waiting'] += 1
    say(reason)
    return {'outcome': 'waiting', 'reason': reason}


def _propose(run, frow, who):
    """Feeds the "new project" proposal (intake/projects.py). Its trouble is never the document's."""
    try:
        import importlib
        projects = importlib.import_module(__package__ + '.projects')
        projects.propose_project(run.db, run.matcher, name=frow.get('transaction_name') or frow['code'],
                                 code=frow['code'],
                                 seen={'where': frow.get('filed_name'), 'person': (who['full'] or who['name']) or None,
                                       'date': _sent_iso(frow)},
                                 source=frow.get('source') if frow.get('source') in ('whatsapp', 'email') else 'whatsapp')
    except Exception as e:
        warn('the project for %s could not be proposed: %s', frow['code'], hubdocs._brief(e))


def _duplicate(run, frow, irow, matter_id, same, say):
    document, version = same
    reason = f"already on the project: {document['title']} v{version.get('version_number')}"
    run.patch_row(irow, {'outcome': 'duplicate', 'reason': reason, 'matter_id': matter_id,
                         'matter_document_id': document['id'], 'handled_at': hub.now_iso()})
    run.landed[frow['id']] = {'matter_id': matter_id, 'document_id': document['id']}
    run.summary['duplicates'] += 1
    say(f'{reason}; nothing to file')
    return {'outcome': 'duplicate', 'reason': reason, 'project': run.project_name(matter_id), 'document': document['title']}


def _tray_unsure(run, frow, irow, who, matter_id, choice, say):
    """A title close to a document's, but not the same: a person says whether it is the next version."""
    document = choice['document']
    reason = (f"{choice['same_title']} documents on the project are titled {document['title']!r}"
              if choice.get('same_title') else f"may be the next version of {document['title']!r}")
    if not run.dry_run:
        _to_tray(run, 'document_unsure', irow, dict(_payload(frow, irow, who), matter_id=matter_id),
                 {'document_id': document['id'], 'document_title': document['title'],
                  'confidence': f"{choice['score']:.2f}"})
        run.patch_row(irow, {'outcome': 'trayed', 'reason': reason, 'matter_id': matter_id, 'handled_at': hub.now_iso()})
    run.summary['trayed'] += 1
    say(f"Needs a look in {run.project_name(matter_id)}: {reason} ({choice['score']:.2f})")
    return {'outcome': 'trayed', 'reason': reason, 'project': run.project_name(matter_id), 'document': document['title']}


def _plan(run, frow, who, matter_id, project, target, doc_title, number, entry, say):
    """A dry run: says what would be filed, and remembers it so later files in the run see it."""
    doc_id = target['id'] if target else f"new:{frow['id']}"
    hubdocs.note_version(run.documents(matter_id), matter_id, doc_id, doc_title, f"dry:{frow['id']}", number,
                         (frow.get('sha256') or '').lower() or None)
    run.landed[frow['id']] = {'matter_id': matter_id, 'document_id': doc_id}
    row, body, changes = _row_line(run, frow, who, matter_id, entry) if run.move_rows else (None, None, None)
    line = 'no row'
    if row:
        line = f"row line on {row.get('deliverable')!r}: {body}" + (f" (status to {changes['status']})" if changes else '')
    what = f'{doc_title!r}, v{number}' if target else f'new document {doc_title!r}, v1'
    _count_filed(run, created=target is None, row=row)
    say(f'would file in {project}: {what}; {line}')
    return {'outcome': 'would_file', 'project': project, 'document': doc_title, 'version': number,
            'row': row.get('deliverable') if row else None}


def _count_filed(run, created, row):
    s = run.summary
    s['filed'] += 1
    s['new_documents' if created else 'next_versions'] += 1
    if row:
        s['row_lines'] += 1


def _adopt(run, frow, irow, who, version, say):
    """An earlier run saved this file and stopped before it could say so. The version is found by
    its storage path; what was left undone (the hash, the row line, the log entry) is done now."""
    db = run.db
    doc = db.one('matter_documents', {'id': f"eq.{version['matter_document_id']}"},
                 'id,title,matter_id,document_type_id,status,created_by')
    if not doc:
        raise RuntimeError('a version was saved, but its document is gone')
    created = version.get('version_number') == 1 and doc.get('created_by') == run.user_id
    if run.dry_run:
        say(f"already saved as v{version.get('version_number')} of {doc['title']!r}; its record would be finished")
        return {'outcome': 'would_file', 'project': run.project_name(doc['matter_id']), 'document': doc['title'],
                'version': version.get('version_number')}
    path = irow['storage_path']
    saved = {'matter_document_id': doc['id'], 'version_id': version['id'], 'version_number': version.get('version_number'),
             'file_name': version.get('file_name'), 'storage_path': path, 'created': created, 'recovered': True,
             'content_hash': (version.get('content_hash') or frow.get('sha256') or '').lower() or None}
    if saved['content_hash']:
        hubdocs.finish_version(db, saved, extension=path.rsplit('.', 1)[-1], content_hash=saved['content_hash'],
                               backfill=run.backfill, doc_status=frow.get('doc_status') if created else None)
    entry = run.matcher.entry_for_code(frow['code'])
    return _after_save(run, frow, irow, who, doc['matter_id'], doc['title'], saved, entry, say, adopted=True)


def _after_save(run, frow, irow, who, matter_id, doc_title, saved, entry, say, adopted=False):
    """The version is on file: the row line, the log entry (one group, so undoing the filing takes
    the line with it), and the document's row closed as filed."""
    db, fid = run.db, frow['id']
    source, ref = frow.get('source') or 'whatsapp', f'filer:{fid}'
    person = (who['full'] or who['name']) or None
    about = {'from': person, 'chat': frow.get('chat'), 'sent': _sent_iso(frow), 'via': _via(frow)}
    group, row_id, logged, line_settled, row = actions.new_group(), None, False, False, None

    if adopted:
        # What the earlier attempt already wrote is not written again.
        for a in db.select('intake_actions', {'intake_document_id': f"eq.{irow['id']}", 'undone_at': 'is.null'},
                           'id,kind,group_id,row_id,version_id'):
            if a['kind'] in ('row_update', 'row_moved'):
                group, row_id, line_settled = a['group_id'], a.get('row_id'), True
            elif a['kind'] == 'version_filed' and a.get('version_id') == saved['version_id']:
                group, logged, line_settled = a['group_id'], True, True
        if not line_settled:
            stray = db.select('transaction_updates', {'source_ref': f'eq.{ref}'}, 'id,row_id,body', limit=1)
            if stray:        # the line went in but its log entry did not: log it, so it can be undone
                on_row = next((r for r in run.rows() if r['id'] == stray[0]['row_id']), {})
                actions.record(db, 'row_update', source, f"{on_row.get('deliverable') or 'Row'}: {stray[0].get('body')}",
                               source_ref=ref, detail=dict(about, file=frow.get('filed_name')), group_id=group,
                               matter_id=on_row.get('matter_id'), row_id=stray[0]['row_id'], update_id=stray[0]['id'],
                               intake_document_id=irow['id'])
                row_id, line_settled = stray[0]['row_id'], True

    note = None
    if run.move_rows and not line_settled:
        try:
            row, body, changes = _row_line(run, frow, who, matter_id, entry)
            if row:
                actions.add_row_update(
                    db, row, body, source=source, source_ref=ref, at=_sent_iso(frow),
                    author=who['first'] if who['firm'] and who['first'] else None,
                    author_id=who['id'] if who['firm'] else None, changes=changes,
                    detail=dict(about, file=frow.get('filed_name')), group_id=group, intake_document_id=irow['id'])
                row_id = row['id']
        except Exception as e:
            # The filing stands without its line; a line is never worth failing a filing for.
            row, note = None, f'filed; the row line could not be written ({hubdocs._brief(e)})'
            warn('filer:%s  %s', fid, note)

    created = bool(saved.get('created'))
    number = saved.get('version_number')
    if not logged:
        actions.record(
            db, 'version_filed', source, f'{doc_title} · new document' if created and number == 1 else f'{doc_title} · v{number} filed',
            source_ref=ref, group_id=group, matter_id=matter_id, document_id=saved['matter_document_id'],
            version_id=saved['version_id'], intake_document_id=irow['id'],
            detail=dict(about, title=doc_title, version_number=number, file=frow.get('filed_name'),
                        created_document=created, web_url=frow.get('web_url'), doc_status=frow.get('doc_status')))
    run.patch_row(irow, {'outcome': 'filed', 'matter_id': matter_id, 'matter_document_id': saved['matter_document_id'],
                         'document_version_id': saved['version_id'], 'version_number': number,
                         'storage_path': saved['storage_path'], 'row_id': row_id, 'reason': note,
                         'handled_at': hub.now_iso()})

    hubdocs.note_version(run.documents(matter_id), matter_id, saved['matter_document_id'], doc_title, saved['version_id'],
                         number, saved.get('content_hash'), storage_path=saved['storage_path'])
    run.landed[fid] = {'matter_id': matter_id, 'document_id': saved['matter_document_id']}
    _count_filed(run, created, row)
    project = run.project_name(matter_id)
    say(f"filed in {project}: " + (f'new document {doc_title!r}' if created else f'{doc_title!r}, v{number}')
        + (f"; row line on {row.get('deliverable')!r}" if row else '; no row'))
    return {'outcome': 'filed', 'version_id': saved['version_id'], 'project': project, 'document': doc_title,
            'version': number, 'row': row.get('deliverable') if row else None, 'reason': note}


# ---------------------------------------------------------------------------
# The row line
# ---------------------------------------------------------------------------

def row_line(status_word, who, source, chat, file_name):
    """The one sentence a filing adds to its Transactions row.

    From outside the firm:  "Mark-up received from <name> by WhatsApp: <file>"
    From a firm person:     "Mark-up sent by <their name on the staff list> (<group, or 'email'>): <file>"
    """
    word = (status_word or '').strip() or 'Document'
    via = 'WhatsApp' if source == 'whatsapp' else 'email'
    if who.get('firm'):
        where = chat if source == 'whatsapp' and chat else via
        return f"{word} sent by {who.get('full') or who.get('first') or 'the firm'} ({where}): {file_name}"
    if who.get('name'):
        return f"{word} received from {who['name']} by {via}: {file_name}"
    return f'{word} received by {via}: {file_name}'


def _row_line(run, frow, who, matter_id, entry):
    """(row, body, changes) for the row a filed document belongs to, or (None, None, None) when no
    row is a sure match. Candidates are the project's own rows, else the transaction's."""
    rows = run.rows()
    candidates = [r for r in rows if r.get('matter_id') == matter_id and not r.get('archived_at')
                  and not _CONTINUATION.match((r.get('deliverable') or '').strip())]
    if not candidates and entry is not None:
        candidates = run.matcher.candidate_rows(rows, entry)
    if not candidates:
        return None, None, None
    arrived = filenames.parse_file_name(filenames.clean_original_name(frow.get('original_name') or ''))['title']
    row, score, _ = run.matcher.match_row([frow.get('title') or '', arrived], candidates, frow.get('transaction_name') or '')
    if not row or score < run.high:
        return None, None, None
    body = row_line(frow.get('doc_status'), who, frow.get('source'), frow.get('chat'), frow.get('filed_name'))
    changes = None
    if run.set_status and not who['firm'] and row.get('status') in MOVED_BY_OUTSIDER:
        changes = {'status': STATUS_AFTER_OUTSIDER}
    return row, body, changes
