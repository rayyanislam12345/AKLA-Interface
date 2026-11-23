"""Acting on one message: the rules, the one Claude read, then the row line, the note, the tray.

    outcome = handle_message(db, message, matcher, rows, people, settings, classifier)

`message` is the neutral dict (intake/mailbox.py builds it for email); nothing
here knows about Graph, so a second source such as group chat text can be added
by building the same dict. `settings` comes from `load_settings(db)`.

What is written about a message (intake_messages), by outcome:

  withheld   that it happened: the rule's name, the time, the mailbox. No subject,
             no sender, no conversation, nothing the model said; even the message
             key is stored as a hash, because a Message-ID can name the sender's
             mail server.
  dropped    the sender's class and the rule. No subject, no sender.
  nothing    read, and not work (personal, automated): the category only.
             Read, work, but no transaction: subject, sender, the short fields.
  acted / trayed   subject, sender, the short fields, the project and the row.
  error      the Claude read failed: nothing of the message; tried again next run.

A message's body is never written anywhere. Nothing here logs a subject, a
sender or any text of a message.

The intake_messages row is written LAST, so a run that dies half way handles the
message again; the row line, the note and the tray item each check for their own
earlier copy first, so nothing is written twice.
"""
import hashlib
import inspect
import re
import uuid
from datetime import date

from . import actions, config, hub, usage
from .classify import NEW_PREFIX, STATUS_WORDS
from .db import in_list
from .log import warn
from .rules import DROPPED, WITHHELD, default_engine

MAX_ATTEMPTS = 3      # Claude reads that came back unusable before a message is given up on
COLUMNS = 'id,message_key,mailboxes,outcome,classification,usd'
# A row that only carries on another row's comments is never a match (as in match.py).
_CONTINUATION = re.compile(r'^(continuation of comments\b.*|.*\(contd\.?\)\s*)$', re.I)
_warned = set()


def load_settings(db, engine=None):
    """Everything handle_message needs that does not change during a run."""
    return {
        'mail_move_rows': bool(db.setting('mail_move_rows', True)),
        'mail_set_status': bool(db.setting('mail_set_status', False)),
        'mail_notes': bool(db.setting('mail_notes', True)),
        'thresholds': dict(config.thresholds()),
        'tz': config.tz(),
        'rules': engine or default_engine(),
        'intake_user_id': hub.intake_user_id(db),
    }


# ----------------------------------------------------------- seen before?

def hidden_key(key):
    """What a withheld message is filed under instead of its Message-ID."""
    return 'h:' + hashlib.sha256((key or '').encode('utf8')).hexdigest()


def find_row(db, key):
    rows = db.select('intake_messages', {'message_key': in_list([key, hidden_key(key)])}, COLUMNS)
    return rows[0] if rows else None


def known_rows(db, keys):
    """{key: its intake_messages row} for the keys already recorded (open or hidden), a few per query."""
    keys = [k for k in dict.fromkeys(keys) if k]
    by_stored = {}
    for k in keys:
        by_stored[k] = k
        by_stored[hidden_key(k)] = k
    out, stored = {}, list(by_stored)
    for start in range(0, len(stored), 40):
        for row in db.select('intake_messages', {'message_key': in_list(stored[start:start + 40])}, COLUMNS):
            out[by_stored.get(row['message_key'], row['message_key'])] = row
    return out


def _attempts(row):
    return int(((row or {}).get('classification') or {}).get('attempts') or 0)


def is_final(row):
    """False only for a message whose Claude read failed and is still to be tried again."""
    return row.get('outcome') != 'error' or _attempts(row) >= MAX_ATTEMPTS


def add_sighting(db, row, mailbox, dry_run=False):
    """The same message seen in another mailbox: only that mailbox is added."""
    seen = list(row.get('mailboxes') or [])
    if mailbox and mailbox not in seen and not dry_run:
        db.patch('intake_messages', {'id': f"eq.{row['id']}"}, {'mailboxes': seen + [mailbox]})
        row['mailboxes'] = seen + [mailbox]


# ------------------------------------------------------------- the handler

def handle_message(db, message, matcher, rows, people, settings, classifier, *, dry_run=False):
    """Handles one message and returns what happened:

    {'outcome': 'seen' | 'withheld' | 'dropped' | 'wait' | 'error' | 'nothing' | 'acted' | 'trayed',
     'rule', 'usd', 'calls', 'line', 'note', 'tray', 'proposed', 'matter_id', 'row_id', 'retry', 'plan'}

    'wait' (a Claude cap is reached) and an 'error' with retry=True mean the caller must not
    move its cursor past this message. On a dry run nothing is written; `plan` says what would be.
    """
    key = message['key']
    mailbox = message.get('mailbox') or ''
    existing = find_row(db, key)
    if existing and is_final(existing):
        add_sighting(db, existing, mailbox, dry_run)
        return {'outcome': 'seen', 'usd': 0.0, 'calls': 0}

    engine = settings.get('rules') or default_engine()
    verdict = engine.evaluate(message)
    out = {'outcome': None, 'rule': verdict.rule, 'usd': 0.0, 'calls': 0, 'line': False, 'note': None,
           'tray': False, 'proposed': False, 'matter_id': None, 'row_id': None, 'retry': False, 'plan': {}}

    if verdict.outcome == WITHHELD:
        return _close(db, message, existing, out, 'withheld', dry_run, hidden=True, rule=verdict.rule)
    if verdict.outcome == DROPPED:
        return _close(db, message, existing, out, 'dropped', dry_run, rule=verdict.rule, sender_class=verdict.sender_class)

    # Claude, within the caps. Over a cap nothing is recorded: the message waits where it is.
    if not usage.allowed(db):
        return dict(out, outcome='wait', rule='claude_cap')
    result, usd = classifier(message, verdict.hints)
    usd = float(usd or 0)
    if usd or result is not None:
        out['calls'] = 1
        out['usd'] = usd
        if not dry_run:
            usage.add(db, usd)
    spent = round(float((existing or {}).get('usd') or 0) + usd, 5)

    if result is None:
        # 'api': the call itself failed, so the message is retried for as long as it takes.
        # Anything else is this message's own answer being no good: a few tries, then given up.
        kind = getattr(classifier, 'last_failure', None) or 'unparsable'
        attempts = _attempts(existing) + (0 if kind == 'api' else 1)
        out['retry'] = attempts < MAX_ATTEMPTS
        return _close(db, message, existing, out, 'error', dry_run, rule='claude_failed', usd=spent,
                      sender_class=verdict.sender_class, classification={'error': kind, 'attempts': attempts})

    # The model's own withhold comes before anything of the message is kept.
    if result['withhold']:
        return _close(db, message, existing, out, 'withheld', dry_run, hidden=True, rule='model_withhold', usd=spent)
    if result['category'] != 'work':
        return _close(db, message, existing, out, 'nothing', dry_run, rule=f"category:{result['category']}", usd=spent,
                      sender_class=verdict.sender_class,
                      classification={'category': result['category'], 'confidence': result['confidence']})

    # Work mail from here: the subject, the sender and the short fields are kept.
    th = settings.get('thresholds') or config.thresholds()
    tz = settings.get('tz') or config.tz()
    sent = message['sent_at']
    sent_iso = sent.isoformat()
    subject = message.get('subject') or ''
    author, author_id, person = _who(message, matcher, people, engine)
    kept = dict(usd=spent, sender_class=verdict.sender_class, classification=result, subject=subject,
                sender=_sender_text(message), conversation=message.get('conversation') or None)
    seen_at = {'where': subject, 'person': person, 'date': sent_iso}

    entry, new_name = _resolve(matcher, result['transaction'], th)
    if entry is None:
        if new_name and result['confidence'] != 'low':
            out['proposed'] = _propose(db, matcher, new_name, None, seen_at, dry_run)
            out['plan']['propose_project'] = new_name
        return _close(db, message, existing, out, 'nothing', dry_run, **kept)

    code = entry.get('code')
    name = entry.get('name') or code
    deliverable = result['deliverable']
    if code:
        matter_id = matcher.matter_for_code(code, deliverable or subject)
    else:                                   # a Hub project with no code: the entry names its project itself
        matter_id = entry.get('matter_id') or next(iter(entry.get('matters') or []), None)
    usable = [r for r in rows if not r.get('archived_at') and not _CONTINUATION.match((r.get('deliverable') or '').strip())]
    candidates = [r for r in usable if matter_id and r.get('matter_id') == matter_id] or list(matcher.candidate_rows(usable, entry))
    row, score, ranked = matcher.match_row([deliverable, subject], candidates, name) if candidates else (None, 0.0, [])
    sure = row is not None and score >= th['deliverable_high'] and result['confidence'] in ('medium', 'high')
    if sure:
        matter_id = row.get('matter_id') or matter_id
    out['matter_id'] = matter_id
    out['row_id'] = row['id'] if sure else None

    group = actions.new_group()
    message_id = existing['id'] if existing else str(uuid.uuid4())
    ask = ask_line(result, sent.astimezone(tz).date())
    gist = result['gist']
    chat = f"Outlook - {mailbox} ({'Sent' if message.get('folder') == 'sentitems' else 'Inbox'})"
    wrote_action = has_line = False

    # 1. The dated line on the row.
    line = ask or gist
    if sure and settings.get('mail_move_rows', True) and line:
        changes = None
        if settings.get('mail_set_status') and result['confidence'] == 'high' and result['status'] in STATUS_WORDS:
            changes = {'status': result['status']}
            if result['currently_with']:
                changes['currently_with'] = result['currently_with']
        out['plan']['line'] = {'row': row.get('deliverable'), 'body': line, 'changes': changes}
        already = db.select('transaction_updates', {'row_id': f"eq.{row['id']}", 'source': 'eq.email',
                                                    'source_ref': f'eq.{key}'}, 'id', limit=1)
        if not dry_run and not already:
            actions.add_row_update(db, row, line, source='email', source_ref=key, at=sent_iso, author=author,
                                   author_id=author_id, changes=changes, group_id=group,
                                   detail={'from': person, 'chat': chat, 'sent': sent_iso, 'via': 'email', 'subject': subject})
            wrote_action = True
        out['line'] = not already          # False when an earlier, unfinished run already wrote it
        has_line = True

    # 2. The gist, kept as a note on the project.
    if matter_id and settings.get('mail_notes', True) and gist:
        out['note'] = _keep_note(db, message, matter_id, gist, person, sent.astimezone(tz).date(), settings, group, dry_run)
        out['plan']['note'] = gist
        wrote_action = wrote_action or out['note'] == 'added'

    # 3. A project, something to place, and no sure row: a person picks the row.
    if matter_id and not sure and (deliverable or result['action_items'] or result['status']):
        payload = {'message_id': message_id, 'message_key': key, 'person': person, 'date': sent_iso,
                   'transaction': name, 'deliverable': deliverable, 'scope': gist, 'ask': ask,
                   'status': result['status'] or '', 'via': 'email', 'matter_id': matter_id, 'subject': subject}
        guess = None
        if row is not None and score >= th['deliverable_low']:
            guess = {'row_id': row['id'], 'confidence': f'{score:.2f}', 'row_deliverable': row.get('deliverable'),
                     'others': [{'row_id': r['id'], 'deliverable': r.get('deliverable'), 'confidence': f'{s:.2f}'}
                                for s, r in ranked[1:]]}
        out['plan']['tray'] = {'deliverable': deliverable, 'guess_row': guess and guess['row_deliverable']}
        waiting = db.select('intake_tray', {'kind': 'eq.message_unsure', 'payload->>message_key': f'eq.{key}'}, 'id', limit=1)
        if not dry_run and not waiting:
            db.insert('intake_tray', {'kind': 'message_unsure', 'payload': payload, 'guess': guess})
        out['tray'] = True

    # 4. A transaction the firm is working on that the Hub has no project for.
    if not matter_id:
        out['proposed'] = _propose(db, matcher, name, code, seen_at, dry_run)
        out['plan']['propose_project'] = name

    outcome = 'trayed' if out['tray'] else ('acted' if has_line or out['note'] else 'nothing')
    out = _close(db, message, existing, out, outcome, dry_run, matter_id=matter_id, row_id=out['row_id'],
                 message_id=message_id, **kept)
    if wrote_action and not dry_run:
        # the log entries were written before the message row existed; point them at it now
        db.patch('intake_actions', {'group_id': f'eq.{group}'}, {'message_id': out['message_id']})
    return out


# ------------------------------------------------------------- the record

def _close(db, message, existing, out, outcome, dry_run, *, hidden=False, rule=None, usd=None, sender_class=None,
           classification=None, subject=None, sender=None, conversation=None, matter_id=None, row_id=None,
           message_id=None):
    """Writes (or, for a message being tried again, rewrites) the intake_messages row and returns `out`."""
    out = dict(out, outcome=outcome)
    if rule:
        out['rule'] = rule
    mailbox = message.get('mailbox') or ''
    mailboxes = list((existing or {}).get('mailboxes') or [])
    if mailbox and mailbox not in mailboxes:
        mailboxes.append(mailbox)
    fields = {
        'source': message.get('source') or 'email',
        'message_key': hidden_key(message['key']) if hidden else message['key'],
        'conversation_key': conversation, 'mailboxes': mailboxes, 'folder': message.get('folder'),
        'sender': sender, 'sender_class': sender_class, 'sent_at': message['sent_at'].isoformat(),
        'subject': subject, 'outcome': outcome, 'rule': rule, 'classification': classification,
        'matter_id': matter_id, 'row_id': row_id, 'usd': usd,
    }
    if dry_run:
        return out
    if existing:
        db.patch('intake_messages', {'id': f"eq.{existing['id']}"}, fields)
        out['message_id'] = existing['id']
    else:
        saved = db.insert('intake_messages', dict(fields, id=message_id or str(uuid.uuid4())))
        out['message_id'] = saved[0]['id'] if saved else message_id
    return out


# ------------------------------------------------------------ small parts

def _resolve(matcher, text, th):
    """(the transaction's entry or None, a new project's name or None) from the model's `transaction`."""
    text = (text or '').strip()
    if not text or text.upper() == 'NONE':
        return None, None
    new = text.upper().startswith(NEW_PREFIX)
    name = text[len(NEW_PREFIX):].strip() if new else text
    if not name:
        return None, None
    if not new:
        entry = matcher.entry_for_code(name) or matcher.entry_for_code(name.upper())
        if entry:
            return entry, None
    # a name instead of a code: it may still be one the matcher knows
    entry, score = matcher.resolve_transaction(name)
    if entry and score >= th['transaction_high']:
        return entry, None
    return None, (name if new else None)


def _who(message, matcher, people, engine):
    """(first name, profile id, display name) of the sender; the first two only for a member of the firm."""
    display = message.get('sender_name') or message.get('sender_address') or ''
    address = message.get('sender_address') or ''
    if engine.is_firm_address(address):
        for candidate in (message.get('sender_name'), address.split('@')[0].replace('.', ' ').replace('_', ' ')):
            name = matcher.person(candidate) if candidate else None
            person_id = people.id_for(name) if name else None
            if person_id:
                return name.split(' ')[0], person_id, name
    return None, None, display


def _sender_text(message):
    name, address = message.get('sender_name') or '', message.get('sender_address') or ''
    return f'{name} <{address}>' if name and address else (name or address or None)


def ask_line(result, sent_day):
    """The ask as one line with its date: "Owais Sb asks for the mark-up by 19 Oct". '' when there is none."""
    parts = []
    for item in (result.get('action_items') or [])[:2]:
        what = (item.get('what') or '').strip().rstrip('.')
        if not what:
            continue
        due = _due_text(item.get('due'), sent_day)
        parts.append(f'{what} by {due}' if due and due.lower() not in what.lower() else what)
    return '; '.join(parts)


def _due_text(due, sent_day):
    due = (due or '').strip()
    if not due:
        return ''
    try:
        day = date.fromisoformat(due[:10])
    except ValueError:
        return re.sub(r'^by\s+', '', due, flags=re.I)        # a phrase: "end of the month"
    return f'{day.day} {day:%b}' + ('' if day.year == sent_day.year else f' {day.year}')


def _keep_note(db, message, matter_id, gist, person, day, settings, group, dry_run):
    """One note per conversation per project per day: 'added', 'appended', 'kept' (this gist is
    already in it, from a run that did not finish), or None when there is no note."""
    conversation = message.get('conversation') or message['key']
    subject = message.get('subject') or '(no subject)'
    prior = db.select('intake_actions', {'kind': 'eq.note_added', 'source': 'eq.email', 'matter_id': f'eq.{matter_id}',
                                         'detail->>conversation': f'eq.{conversation}', 'detail->>day': f'eq.{day.isoformat()}'},
                      'id,note_id,detail,undone_at', order='created_at.desc', limit=1)
    if prior:
        action = prior[0]
        if action.get('undone_at') or not action.get('note_id'):
            return None                                       # a person took this thread's note back today: leave it
        note = db.one('matter_notes', {'id': f"eq.{action['note_id']}"}, 'id,content')
        if not note:
            return None
        if gist in (note.get('content') or ''):
            return 'kept'
        if not dry_run:
            detail = dict(action.get('detail') or {})
            detail['messages'] = int(detail.get('messages') or 1) + 1
            db.patch('matter_notes', {'id': f"eq.{note['id']}"}, {'content': note['content'] + '\n' + gist})
            db.patch('intake_actions', {'id': f"eq.{action['id']}"}, {'detail': detail})
        return 'appended'
    if dry_run:
        return 'added'
    author_id = settings.get('intake_user_id')
    if not author_id and 'author' not in _warned:
        _warned.add('author')
        warn('no approved profile named "Hub Intake": email notes are kept without an author')
    content = f'From email · {subject}\n{gist}'
    note = db.insert('matter_notes', {'matter_id': matter_id, 'author_id': author_id, 'content': content})[0]
    actions.record(db, 'note_added', 'email', ' '.join(content.split())[:140], source_ref=message['key'],
                   detail={'from': person, 'via': 'email', 'subject': subject, 'messages': 1,
                           'conversation': conversation, 'day': day.isoformat()},
                   group_id=group, matter_id=matter_id, note_id=note.get('id'))
    return 'added'


def _propose(db, matcher, name, code, seen, dry_run):
    """Feeds the one open `new_project` item for a transaction the Hub has no project for."""
    if dry_run:
        return True
    try:
        from . import projects          # the names builder's module; imported here so mail runs without it
    except ImportError:
        if 'projects' not in _warned:
            _warned.add('projects')
            warn('intake/projects.py is not there yet: a new project was noticed but could not be proposed')
        return False
    extra = {'source': 'email'} if 'source' in inspect.signature(projects.propose_project).parameters else {}
    answer = projects.propose_project(db, matcher, name, code=code, seen=seen, **extra)
    # it says what it did; "nothing" means the name already has a project or was already answered
    return answer.get('action') != 'nothing' if isinstance(answer, dict) else True
