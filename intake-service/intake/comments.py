"""The sheet's COMMENTS / LATEST UPDATE cell: dated lines, one per update.

A cell reads, blank line between lines, oldest first:
    September 24, 2026 - Memorandum prepared.
    October 14, 2026 [12:05 - Usama] - Boss to review the volume.
The first form has no time and no author; the second is stamped. Split turns
the cell into transaction_updates rows and rebuild writes them back the same way.
"""
import re
from datetime import datetime

MONTHS = ('January|February|March|April|May|June|July|August|September|October|November|December')
_TYPOS = {'Feburary': 'February', 'Ocotber': 'October', 'Sepetember': 'September', 'Septmber': 'September'}
LINE = re.compile(
    rf'^\s*({MONTHS})\s+(\d{{1,2}}),?\s+(20\d\d)'            # the date
    r'\s*(?:\[\s*(?:(\d{1,2}):(\d{2}))?\s*(?:[-–]?\s*([^\]\d][^\]]*?))?\s*\])?'  # [HH:MM - Name], [HH:MM] or [Name]
    r'\s*[-–:]?\s*(.*)$', re.S)
STARTS_WITH_DATE = re.compile(rf'\n(?=\s*(?:{MONTHS})\s+\d{{1,2}},?\s+20\d\d\s*(?:\[|[-–]))')


def _fix_typos(text):
    for wrong, right in _TYPOS.items():
        text = text.replace(wrong, right)
    return text


def split_comments(text, tz, fallback_date=None):
    """[{at, author, body, stamped}] oldest first as written. An undated first
    chunk gets fallback_date (a date) at 00:00; an undated later chunk joins the line before it."""
    lines = []
    if not text or not str(text).strip():
        return lines
    text = _fix_typos(str(text).replace('\r\n', '\n').replace('\r', '\n'))
    chunks = []
    for chunk in re.split(r'\n\s*\n', text):
        chunks.extend(c for c in STARTS_WITH_DATE.split(chunk) if c and c.strip())
    for chunk in chunks:
        m = LINE.match(chunk)
        if not m:
            if lines:
                lines[-1]['body'] = (lines[-1]['body'] + '\n' + chunk.strip()).strip()
            elif fallback_date:
                lines.append({'at': datetime(fallback_date.year, fallback_date.month, fallback_date.day, tzinfo=tz),
                              'author': None, 'body': chunk.strip(), 'stamped': False})
            else:
                lines.append({'at': None, 'author': None, 'body': chunk.strip(), 'stamped': False})
            continue
        month, day, year, hour, minute, author, body = m.groups()
        try:
            at = datetime.strptime(f'{month} {day} {year}', '%B %d %Y')
        except ValueError:
            at = datetime(int(year), 1, 1)
        at = at.replace(hour=int(hour or 0), minute=int(minute or 0), tzinfo=tz)
        lines.append({'at': at, 'author': (author or '').strip(' -') or None, 'body': body.strip(), 'stamped': bool(hour or author)})
    return lines


def format_line(at, author, body, tz):
    """One cell line in the sheet's own words; a line with no author and no time is written unstamped."""
    local = at.astimezone(tz)
    date = f'{local:%B %d, %Y}'
    timed = bool(local.hour or local.minute)
    if author and timed:
        return f'{date} [{local:%H:%M} - {first_name(author)}] - {body}'
    if author:
        return f'{date} [{first_name(author)}] - {body}'       # a name with no time, as some lines are
    if timed:
        return f'{date} [{local:%H:%M}] - {body}'
    return f'{date} - {body}'


def rebuild_comments(lines, tz):
    """lines: [{at, author, body}] in any order; the cell text, oldest first."""
    ordered = sorted(lines, key=lambda l: l['at'])
    return '\n\n'.join(format_line(l['at'], l.get('author'), l['body'], tz) for l in ordered)


def first_name(author):
    return (author or '').strip().split(' ')[0] if author else ''


def line_key(at, body):
    """What makes two lines the same line: the day and the words, not the author or the time."""
    return (at.date().isoformat() if at else '', re.sub(r'\s+', ' ', (body or '').strip().lower()))


def parse_iso(value, tz):
    """A timestamptz from PostgREST ("2026-10-14T03:05:00+00:00" or with Z) as an aware datetime."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=tz)
    return datetime.fromisoformat(value.replace('Z', '+00:00'))
