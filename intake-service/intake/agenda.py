"""Read a Daily Agenda .docx: the deliverable blocks and the Daily Timesheet table.

Only zipfile and regex over word/document.xml, as the Agenda Extractor's
tools/timesheet_entries.py does (its date and cell helpers are copied here).
Nothing is imported across repos.
"""
import hashlib
import html
import os
import re
import zipfile
from datetime import date, datetime, timedelta

PARA = re.compile(r'<w:p[ >].*?</w:p>', re.S)
TABLE = re.compile(r'<w:tbl>.*?</w:tbl>', re.S)
ROW = re.compile(r'<w:tr[ >].*?</w:tr>', re.S)
CELL = re.compile(r'<w:tc>.*?</w:tc>', re.S)
LABEL = re.compile(r'^\s*([A-Za-z][A-Za-z &/]{1,40}?)\s*:\s*(.*)$', re.S)
FILE_NAME = re.compile(r'^(?P<prefix>.*?Daily Agenda)\s*-?\s*(?P<person>[^\[]+?)\s*\[(?P<date>[^\]]+)\]', re.I)

# What each label means, whatever the file calls it.
LABELS = {
    'transaction': 'transaction', 'client': 'transaction', 'project': 'transaction',
    'scope of task': 'scope', 'scope of work': 'scope', 'scope': 'scope', 'task': 'scope',
    'complete deliverable': 'complete', 'deliverable': 'complete', 'completed deliverable': 'complete',
    'day deliverable': 'day', 'days deliverable': 'day', "day's deliverable": 'day',
    'deliverable assigned by': 'assigned_by', 'assigned by': 'assigned_by',
    'current deliverable status': 'status', 'current status': 'status', 'status': 'status',
    # the Founder's Desk form: a discussion, not a deliverable
    'matter': 'matter', 'team members': 'team', 'team member': 'team', 'direction': 'direction', 'directon': 'direction',
}
ROLE_LABELS = ('associate', 'senior counsel', 'intern', 'trainee associate', 'prepared by', 'automation and data analyst',
               'junior associate', 'partner', 'counsel', 'analyst', 'name', 'employee')
INTERNAL_ROWS = re.compile(r'^(total|percentage|sr\.? ?no)', re.I)


def texts(xml):
    """Paragraph texts in order, blanks dropped, entities decoded."""
    out = []
    for p in PARA.findall(xml):
        t = ''.join(re.findall(r'<w:t(?: [^>]*)?>([^<]*)</w:t>', p))
        t = html.unescape(t).replace(' ', ' ').strip()
        if t:
            out.append(t)
    return out


def cell_text(cell):
    return '\n'.join(texts(cell)).strip()


def parse_date(value):
    """'October 30, 2026', 'October 21 2026', 'November 07- 08, 2025' (first day) or None."""
    if not value:
        return None
    value = value.replace('Feburary', 'February').replace('Ocotber', 'October').replace('Sepetember', 'September')
    m = re.search(r'([A-Za-z]+)\s+(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\W*\s*(20\d\d)', value)
    if not m:
        return None
    for fmt in ('%B %d %Y', '%b %d %Y'):
        try:
            return datetime.strptime(' '.join(m.groups()), fmt).date()
        except ValueError:
            pass
    return None


def parse_file_name(name):
    """(person, date, variant) from 'Revised Daily Agenda - Moiz Ali Khan [October 23, 2026].docx'."""
    stem = os.path.splitext(os.path.basename(name))[0]
    m = FILE_NAME.match(stem)
    if not m:
        return None, None, 'other'
    prefix = m.group('prefix').lower()
    variant = 'founders_desk' if 'founder' in prefix else ('revised' if 'revised' in prefix else 'agenda')
    return m.group('person').strip(' -'), parse_date(m.group('date')), variant


def number(value):
    try:
        return float(str(value).replace(',', '').strip())
    except (TypeError, ValueError):
        return None


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _label(text):
    m = LABEL.match(text)
    if not m:
        return None, text
    key = re.sub(r'\s+', ' ', m.group(1).strip().lower())
    return key, m.group(2).strip()


def _blocks(paragraphs):
    """The deliverable blocks between 'Deliverables' and 'Daily Timesheet', and the header lines."""
    head = {'person': None, 'role': None, 'agenda_date': None, 'timesheet_date': None, 'notes': []}
    blocks, current, section = [], None, 'head'
    for text in paragraphs:
        low = text.lower().strip(' :')
        if low in ('daily timesheet', 'timesheet'):
            section = 'timesheet'
            continue
        if low in ('deliverables', 'discussions'):
            section = 'body'
            continue
        key, value = _label(text)
        if key == 'date':
            if section == 'timesheet':
                head['timesheet_date'] = head['timesheet_date'] or parse_date(value)
            else:
                head['agenda_date'] = head['agenda_date'] or parse_date(value)
            continue
        if key in ROLE_LABELS and section != 'timesheet':
            head['person'], head['role'] = head['person'] or value.strip(' .'), head['role'] or key
            continue
        if section == 'timesheet':
            continue
        if text.startswith('*') or text.startswith('['):
            head['notes'].append(text.strip('*[] '))
            continue
        field = LABELS.get(key or '')
        if field == 'transaction':
            current = {'transaction': value, 'scope': '', 'complete': '', 'day': '', 'assigned_by': '',
                       'status': '', 'matter': '', 'team': '', 'direction': ''}
            blocks.append(current)
        elif field and current is not None:
            current[field] = (current[field] + '\n' + value).strip() if current[field] else value
        elif current is not None and not key:
            # a continuation line of the last field (a long scope wrapped into a new paragraph)
            last = next((f for f in ('status', 'assigned_by', 'day', 'complete', 'scope') if current[f]), None)
            if last and last != 'status':
                current[last] = current[last] + '\n' + text
    return head, blocks


def _header_map(cells):
    """Column index for each timesheet column, from the header texts."""
    cols = {}
    for i, c in enumerate(cells):
        t = re.sub(r'[^a-z ]', '', c.lower())
        t = re.sub(r'\s+', ' ', t).strip()
        if not t:
            continue
        if 'transaction' in t:
            cols['transaction'] = i
        elif 'matter' in t or 'description' in t or 'narrative' in t:
            cols['narrative'] = i
        elif 'ak' in t.split() and 'billable' in t:
            cols['ak_billable'] = i
        elif 'billable' in t:
            cols['billable'] = i
        elif 'hours' in t:
            cols['hours'] = i
        elif t == 'date':
            cols['date'] = i
    return cols if 'transaction' in cols and 'hours' in cols else None


def _timesheet(xml):
    """Data rows of the first table whose header names a Transaction column."""
    rows_out, warnings = [], []
    for table in TABLE.findall(xml):
        rows = ROW.findall(table)
        cols, start = None, 0
        for i, row in enumerate(rows[:3]):
            cols = _header_map([cell_text(c) for c in CELL.findall(row)])
            if cols:
                start = i + 1
                break
        if not cols:
            continue
        for index, row in enumerate(rows[start:], 1):
            cells = [cell_text(c) for c in CELL.findall(row)]
            if not cells or INTERNAL_ROWS.match(cells[0]) or len(cells) <= cols['transaction']:
                continue
            transaction = cells[cols['transaction']]
            narrative = cells[cols['narrative']] if cols.get('narrative') is not None and len(cells) > cols['narrative'] else ''
            if not transaction and not narrative:
                continue
            hours = number(cells[cols['hours']]) if len(cells) > cols['hours'] else None
            billable = number(cells[cols['billable']]) if cols.get('billable') is not None and len(cells) > cols['billable'] else None
            row_date = parse_date(cells[cols['date']]) if cols.get('date') is not None and len(cells) > cols['date'] else None
            rows_out.append({'index': index, 'transaction': transaction.strip(), 'narrative': narrative.strip(),
                             'hours': hours, 'billable': billable, 'date': row_date})
        return rows_out, warnings
    return rows_out, warnings


def parse_agenda(path):
    """Everything the intake needs from one file, or raises on an unreadable one."""
    name = os.path.basename(path)
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf8')
    outside = TABLE.sub('', xml)
    head, blocks = _blocks(texts(outside))
    time_rows, warnings = _timesheet(xml)
    file_person, file_date, variant = parse_file_name(name)
    person = head['person'] or file_person
    agenda_date = head['agenda_date'] or file_date
    timesheet_date = head['timesheet_date']
    if not timesheet_date:
        dated = [r['date'] for r in time_rows if r['date']]
        timesheet_date = dated[0] if dated else (previous_working_day(agenda_date) if agenda_date else None)
        if time_rows and not dated:
            warnings.append('timesheet date missing; taken as the working day before the agenda')
    deliverable_blocks, skipped = [], 0
    for b in blocks:
        if not (b['scope'] or b['complete'] or b['day']):
            skipped += 1          # a Founder's Desk discussion, or an empty block
            continue
        deliverable_blocks.append(b)
    return {
        'file_name': name, 'sha256': sha256(path), 'variant': variant, 'person': person, 'role': head['role'],
        'agenda_date': agenda_date, 'timesheet_date': timesheet_date, 'notes': head['notes'],
        'blocks': deliverable_blocks, 'discussion_blocks': skipped, 'time_rows': time_rows, 'warnings': warnings,
    }


def previous_working_day(d):
    d = d - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d
