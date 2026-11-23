"""The WhatsApp Filer's own record of what it filed (filed.sqlite), read and never written.

The Filer keeps one row per file it handled, in the table `files`. Phase 2 of the
intake reads that record and nothing else: the Filer itself is not changed. The
database is opened read-only (sqlite's mode=ro), every question is asked on a
connection that is opened, read and closed at once, so the Filer is never kept
waiting on a lock, and nothing here can write.

    reader = Filer()                    # /opt/whatsapp-filer/state/filed.sqlite, or FILER_DB, or a path
    for row in reader.rows():           # filed, confirmed on SharePoint, with a transaction code; oldest first
        row['title'], row['doc_status'], row['source'], row['sent_at'], row['sender_name'] ...
    reader.row(812)                     # one row by its id, whatever its action

A row is the Filer's columns as they are, plus what the intake needs worked out
from them: `fields` parsed, the source (WhatsApp or email, the mailbox and the
direction) read from `chat`, `sent` as a time with a zone, the sender's name cleaned.
"""
import json
import os
import re
import sqlite3
import urllib.parse
from datetime import date, datetime, timezone

from . import filenames

DEFAULT_PATH = '/opt/whatsapp-filer/state/filed.sqlite'

# The columns the intake reads. A column an older copy of the record lacks (own_number was
# added on 26 Oct 2026) reads as None.
COLUMNS = ('id', 'created', 'action', 'sha256', 'quickxor', 'original_name', 'chat', 'sender', 'sent', 'caption',
           'code', 'number', 'own_number', 'transaction_name', 'document', 'title_key', 'filed_name', 'folder',
           'web_url', 'duplicate_of', 'version_of', 'reason', 'fields')
FIELD_KEYS = ('transaction', 'title', 'document_type', 'party', 'status', 'document_date', 'confidence', 'note')

# Only these are the intake's business: filed, confirmed uploaded (a web_url), and a transaction's
# document (agendas and CVs carry no code).
ELIGIBLE = "action = 'filed' AND web_url IS NOT NULL AND web_url <> '' AND code IS NOT NULL AND code <> ''"


class FilerError(RuntimeError):
    """The Filer's record could not be read; the message says why in plain words."""


def db_path(path=None):
    """Where the record is: the argument, else the FILER_DB environment variable, else the VM's path."""
    return path or os.environ.get('FILER_DB') or DEFAULT_PATH


class Filer:
    def __init__(self, path=None):
        self.path = db_path(path)
        self._columns = None

    # ---- the wire: open read-only, ask, close
    def _query(self, sql, args=()):
        if not os.path.isfile(self.path):
            raise FilerError(f"The Filer's record was not found at {self.path}. "
                             'Set FILER_DB (or pass the path) to where its filed.sqlite is.')
        uri = 'file:' + urllib.parse.quote(os.path.abspath(self.path)) + '?mode=ro'
        try:
            conn = sqlite3.connect(uri, uri=True, timeout=10)
        except sqlite3.Error as e:
            raise FilerError(f"The Filer's record at {self.path} could not be opened: {e}") from None
        try:
            conn.row_factory = sqlite3.Row
            if self._columns is None:
                present = {r[1] for r in conn.execute('PRAGMA table_info(files)').fetchall()}
                if not present:
                    raise FilerError(f"{self.path} has no 'files' table; it is not the Filer's filed.sqlite.")
                self._columns = [c for c in COLUMNS if c in present]
                if 'id' not in self._columns:
                    raise FilerError(f"The 'files' table in {self.path} has no id column.")
            return [dict(r) for r in conn.execute(sql.format(columns=', '.join(self._columns)), args).fetchall()]
        except sqlite3.Error as e:
            raise FilerError(f"The Filer's record at {self.path} could not be read: {e}") from None
        finally:
            conn.close()

    def _need(self, *columns):
        """False when this copy of the record lacks a column the question needs."""
        self._query('SELECT {columns} FROM files LIMIT 0')
        return all(c in self._columns for c in columns)

    # ---- questions
    def rows(self, after_id=None, limit=None):
        """The rows the intake handles (filed, a web_url, a code), oldest first, parsed."""
        if not self._need('action', 'web_url', 'code'):
            return []
        sql = 'SELECT {columns} FROM files WHERE ' + ELIGIBLE
        args = []
        if after_id is not None:
            sql += ' AND id > ?'
            args.append(int(after_id))
        sql += ' ORDER BY id'
        if limit:
            sql += ' LIMIT ?'
            args.append(int(limit))
        return [parse_row(r) for r in self._query(sql, args)]

    def rows_to_handle(self, known_ids=(), limit=None):
        """The handled kind of row whose id the Hub has not recorded yet, oldest first, at most `limit`."""
        known = set(known_ids)
        out = [r for r in self.rows() if r['id'] not in known]
        return out[:limit] if limit else out

    def row(self, filer_id):
        """One row by its id, whatever its action, parsed; None when there is none."""
        try:
            found = self._query('SELECT {columns} FROM files WHERE id = ?', (int(filer_id),))
        except (TypeError, ValueError):
            return None
        return parse_row(found[0]) if found else None

    def counts(self):
        """{'rows': n, 'eligible': n}: how much the record holds and how much of it is the intake's."""
        total = self._query('SELECT COUNT(*) AS id FROM files')[0]['id']
        eligible = len(self.rows())
        return {'rows': total, 'eligible': eligible}


def is_eligible(row):
    """True for a row the intake files: filed, confirmed uploaded, and a transaction's document."""
    return bool(row and row.get('action') == 'filed' and row.get('web_url') and row.get('code'))


# ---------------------------------------------------------------------------
# One row, parsed
# ---------------------------------------------------------------------------

def parse_row(raw):
    """The Filer's columns (None where this copy lacks one) plus:

    fields         the `fields` JSON as a dict with every key present ('' when missing)
    title          the Filer's standard document title (fields.title, else `document`, else from the name)
    document_type, party, doc_status, document_date ('YYYY-MM-DD' or None)
    source         'whatsapp' or 'email';  mailbox, direction ('inbox' | 'sent' | None) for email
    sent_at        when the message was sent, as an aware UTC datetime (None when unreadable)
    sender_name    the sender's name without a phone number, an address or a contact-book label
    sender_email   the address, for email, when the Filer kept one
    sender_saved   False when WhatsApp gave only a push name and a number (not in the Filer's contacts)
    """
    row = {c: raw.get(c) for c in COLUMNS}
    fields = parse_fields(raw.get('fields'))
    named = filenames.parse_filer_name(row.get('filed_name') or '') or {}
    row['fields'] = fields
    row['title'] = _text(fields['title']) or _text(row.get('document')) or _text(named.get('title'))
    row['document_type'] = _text(fields['document_type']) or None
    row['party'] = _text(fields['party']) or _text(named.get('party')) or None
    row['doc_status'] = _text(fields['status']) or _text(named.get('status')) or None
    row['document_date'] = _iso_day(fields['document_date']) or named.get('date')
    row['source'], row['mailbox'], row['direction'] = parse_source(row.get('chat'))
    row['sent_at'] = parse_sent(row.get('sent'))
    sender = clean_sender(row.get('sender'))
    row['sender_name'], row['sender_email'], row['sender_saved'] = sender['name'], sender['email'], sender['saved']
    return row


def _text(value):
    return re.sub(r'\s+', ' ', str(value)).strip() if value not in (None, '') else ''


def _iso_day(value):
    try:
        return date.fromisoformat(str(value).strip()[:10]).isoformat() if value else None
    except ValueError:
        return None


def parse_fields(text):
    """The `fields` column (what Claude read from the file) as a dict; every key present."""
    data = {}
    if isinstance(text, dict):
        data = text
    elif text:
        try:
            loaded = json.loads(text)
            data = loaded if isinstance(loaded, dict) else {}
        except (TypeError, ValueError):
            data = {}
    out = {k: '' for k in FIELD_KEYS}
    out.update({k: v for k, v in data.items() if v is not None})
    return out


_OUTLOOK = re.compile(r'^Outlook - (?P<mailbox>.+?)\s*\((?P<folder>Inbox|Sent)\)\s*$', re.I)


def parse_source(chat):
    """('email', mailbox, 'inbox' | 'sent') for "Outlook - <mailbox> (Inbox|Sent)";
    ('whatsapp', None, None) for anything else, which is a WhatsApp group's name."""
    chat = (chat or '').strip()
    if not chat.lower().startswith('outlook - '):
        return 'whatsapp', None, None
    m = _OUTLOOK.match(chat)
    if not m:
        return 'email', chat[len('Outlook - '):].strip() or None, None
    return 'email', m.group('mailbox').strip(), m.group('folder').lower()


_SENT_FORMATS = ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%d/%m/%Y, %H:%M:%S', '%d/%m/%Y, %H:%M', '%d/%m/%Y %H:%M')


def parse_sent(value, naive=timezone.utc):
    """`sent` as an aware UTC datetime, or None.

    The Filer writes UTC without a "Z" ("2026-10-17T12:00:15"). A value with a "Z" or an offset is
    taken as it says; a bare date is midnight; epoch seconds are read too. A value with no zone
    is taken as `naive` (UTC). The seed rows of 23 Oct 2026 were written in Pakistan time, and
    nothing in a row says which it is, so those read five hours late; pass naive= to read them right."""
    if value in (None, ''):
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value / 1000 if value > 1e11 else value, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    else:
        text = str(value).strip()
        if re.fullmatch(r'\d{9,13}', text):
            return parse_sent(int(text), naive)
        if text[-1:] in ('Z', 'z'):
            text = text[:-1] + '+00:00'
        parsed = None
        candidates = [text, text.replace(' ', 'T', 1)]
        if re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+', text):         # fractions of any length
            candidates.append(re.sub(r'\.\d+', '', text, count=1))
        for candidate in candidates:
            try:
                parsed = datetime.fromisoformat(candidate)
                break
            except ValueError:
                continue
        if parsed is None:
            for fmt in _SENT_FORMATS:
                try:
                    parsed = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
        if parsed is None:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=naive)
    return parsed.astimezone(timezone.utc)


_ADDRESS = re.compile(r'^\s*(?P<name>.*?)\s*<\s*(?P<email>[^<>\s]+@[^<>\s]+)\s*>\s*$')
_BARE_ADDRESS = re.compile(r'^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$')
_NUMBER_SUFFIX = re.compile(r'\s*\(\s*\+?[\d\s\-]{6,}\)\s*$')
_BARE_NUMBER = re.compile(r'^\+?[\d\s\-()]{6,}$')
_CARE_OF = re.compile(r'\s+c/o\b.*$', re.I)
_LABEL = re.compile(r'\s+[-–—]\s+.*$')                 # "Haya Ansari - AKLA Trainee"
_TRAILING_CAPS = re.compile(r'(?:\s+[A-Z]{2,6})+$')    # "Ayaan Qureshi AKLA", "Rayyan Baba USA"


def clean_sender(text):
    """{'name', 'email', 'saved'} from the Filer's `sender`.

    Email: "Name <address>", a bare name, or a bare address (the name is then the address).
    WhatsApp: a contact's name as the Filer's phone has it, or "<push name> (<number>)" for a
    number it has not saved; the number is dropped, and so is a contact-book label after the
    name ("- AKLA Trainee", "C/o ...", a trailing "AKLA"). A sender that is only a number has no name."""
    raw = re.sub(r'\s+', ' ', text or '').strip()
    if not raw:
        return {'name': '', 'email': None, 'saved': True}
    m = _ADDRESS.match(raw)
    if m:
        name = m.group('name').strip(' "\'')
        return {'name': name or m.group('email'), 'email': m.group('email').lower(), 'saved': True}
    if _BARE_ADDRESS.match(raw):
        return {'name': raw, 'email': raw.lower(), 'saved': True}
    saved = True
    if _NUMBER_SUFFIX.search(raw):
        saved = False
        raw = _NUMBER_SUFFIX.sub('', raw)
    if not raw or _BARE_NUMBER.match(raw):
        return {'name': '', 'email': None, 'saved': False}
    name = raw.lstrip('~ ').strip(' "\'')
    name = _CARE_OF.sub('', name)
    name = _LABEL.sub('', name)
    if not name.isupper():                             # a name written all in capitals is left whole
        shorter = _TRAILING_CAPS.sub('', name)
        if shorter.strip():
            name = shorter
    return {'name': name.strip(' -–—,.'), 'email': None, 'saved': saved}
