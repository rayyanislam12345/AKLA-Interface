"""The firm's file names, read the way the Hub's site reads them.

A Python port of src/lib/fileNames.ts (parseFileName, familyKeyOf, findDate,
titleSimilarity, findMatchingDocument, versionLabel) and of the status helper in
src/lib/documentDefaults.ts, kept line for line so a document the intake files
lands on the same Hub document an associate's own upload would. The cases in
tests/fileNames.test.js are ported to tests/test_filenames.py.

Two things are added for the intake:

- the WhatsApp Filer numbers its files in its own sequence with an "-A" marker
  ("PTQ-A28 - Escrow Agreement [AKLA][Mark-up][October 17, 2026][Version 2].docx").
  The site's code pattern only knows "PTQ28 - ..."; this parser accepts both.
- parse_filer_name pulls a Filer name apart by its own grammar
  (<CODE>[-A]<n> - <Title> [<Party>][<Status>][<Month DD, YYYY>][Version n].<ext>),
  and status_from_filer_word turns the Filer's status word into a Hub document status.

JavaScript's \\w, \\d and \\b are ASCII and its \\s is wider than ASCII; _rx compiles
a pattern with exactly those meanings, so the two parsers agree on odd names too.
"""
import re
import unicodedata
from datetime import date

# ---------------------------------------------------------------------------
# JavaScript regular expressions in Python
# ---------------------------------------------------------------------------

# What \s matches in JavaScript.
_JS_SPACE = ' \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
_JS_SPACE_CHARS = ' \t\n\v\f\r                 　﻿'


def _rx(pattern, flags=0):
    """Compiles a pattern written as the TypeScript has it: \\w, \\d, \\b ASCII; \\s as JavaScript's.
    ("$" is written "\\Z" by hand below: Python's "$" also matches before a final newline.)"""
    out, i, in_class = [], 0, False
    while i < len(pattern):
        c = pattern[i]
        if c == '\\' and i + 1 < len(pattern):
            nxt = pattern[i + 1]
            out.append((_JS_SPACE if in_class else '[' + _JS_SPACE + ']') if nxt == 's' else c + nxt)
            i += 2
            continue
        if c == '[' and not in_class:
            in_class = True
        elif c == ']' and in_class:
            in_class = False
        out.append(c)
        i += 1
    return re.compile(''.join(out), flags | re.ASCII)


def _trim(text):
    return text.strip(_JS_SPACE_CHARS)


I = re.IGNORECASE

# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------

# Later in a document's life wins when a name carries more than one stage tag.
STAGE_ORDER = ['Working draft', 'AI markup', 'For partner review', 'Circulated', 'Received', 'Compared',
               'Client comments', 'Final', 'Execution']

# One tag, first rule that matches. Order matters: "Final Circ Version" is a
# circulation, "Pre-Execution Version" is execution, "Claude Markup" is AI,
# "Compared against AKLA First Circulated Draft" is a comparison.
STAGE_RULES = [
    (_rx(r'\b(claude|chat\s?gpt|gpt|ai\s+(?:\d+(?:st|nd|rd|th)\s+)?mark-?up|ai\s+review|ai\s+draft)\b', I), 'AI markup'),
    (_rx(r'\b(pre-?\s?execution|execution|executed|signing|signed)\b', I), 'Execution'),
    (_rx(r'\bcompar(e|ed|ison)\b', I), 'Compared'),
    (_rx(r'\b(cir|circ|circul\w*|curcul\w*|circl\w*|cirulat\w*)\b', I), 'Circulated'),
    (_rx(r'\b(rec|recd|rcvd|received|receipt|recieved)\b', I), 'Received'),
    (_rx(r'\b(client|consolidated|counterparty)\s+comments?\b|^comments\Z', I), 'Client comments'),
    (_rx(r'\bfor\s+[\w.]+(\s+[\w.]+)?\s+review\b|\b(boss|partner|senior)\s+review\b|\bto\s+print\s+and\s+read\b', I),
     'For partner review'),
    (_rx(r'\b(final|print\s+version)\b', I), 'Final'),
    (_rx(r'\b(wd|wip|working\s+draft|draft|revised|revision|fur(ther)?\s+edits|mark-?up)\b', I), 'Working draft'),
]


def stage_from_tag(tag):
    for rx, stage in STAGE_RULES:
        if rx.search(tag):
            return stage
    return None


# src/lib/documentDefaults.ts: where a stage puts a document in its life.
STATUS_BY_STAGE = {
    'Working draft': 'drafting', 'AI markup': 'drafting', 'For partner review': 'internal_review',
    'Circulated': 'with_counterparty', 'Received': 'with_counterparty', 'Client comments': 'negotiation',
    'Compared': 'negotiation', 'Final': 'finalized', 'Execution': 'executed',
}


def status_from_stage(stage):
    """The document status a file name's stage implies, or None when the name carries no stage."""
    return STATUS_BY_STAGE.get(stage) if stage else None


# The WhatsApp Filer's own status words, and the Hub document status each one means
# (docs/phase-2-3-contracts.md). "Notes" says nothing about the document's life: leave it as it is.
FILER_STATUS_WORDS = ('Draft', 'First Draft', 'Revised Draft', 'Mark-up', 'Comments', 'Clean', 'Final',
                      'Execution Version', 'Executed', 'Signed', 'Received', 'Notes')
_STATUS_BY_FILER_WORD = {
    'draft': 'drafting', 'first draft': 'drafting', 'revised draft': 'drafting', 'clean': 'drafting',
    'mark up': 'negotiation', 'markup': 'negotiation', 'comments': 'negotiation',
    'received': 'with_counterparty',
    'final': 'finalized', 'execution version': 'finalized',
    'executed': 'executed', 'signed': 'executed',
}


def _word_key(word):
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', (word or '').lower()).split())


def status_from_filer_word(word):
    """Draft / Clean -> drafting, Mark-up / Comments -> negotiation, Received -> with_counterparty,
    Final / Execution Version -> finalized, Executed / Signed -> executed; Notes or anything else -> None."""
    return _STATUS_BY_FILER_WORD.get(_word_key(word))


def is_filer_status_word(word):
    return _word_key(word) in {_word_key(w) for w in FILER_STATUS_WORDS}


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------

MONTHS = {'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10,
          'nov': 11, 'dec': 12}
_MONTH = (r'(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?'
          r'|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?![a-z])')
_DAY = r'(\d{1,2})(?:st|nd|rd|th)?'
DATE_PATTERNS = [
    (_rx(r'(?<![a-z])' + _MONTH + r'\s*' + _DAY + r'\s*,?\s*(\d{4})(?!\d)', I), 'mdy'),
    (_rx(r'(?<!\d)' + _DAY + r'\s*-?\s*' + _MONTH + r'\s*,?\s*(\d{4})(?!\d)', I), 'dmy'),
    (_rx(r'(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)'), 'ymd'),
    (_rx(r'(?<![\d.])(\d{1,2})[-.](\d{1,2})[-.](\d{4}|\d{2})(?![\d.])'), 'dmyNum'),
]


def _iso_date(y, m, d):
    if y < 100:
        y += 2000
    if y < 1990 or y > 2100 or m < 1 or m > 12 or d < 1 or d > 31:
        return None
    try:
        date(y, m, d)
    except ValueError:
        return None
    return f'{y}-{m:02d}-{d:02d}'


def find_date(text):
    """The first date written in the text, in any of the firm's styles: {iso, index, length} or None."""
    best = None
    for rx, order in DATE_PATTERNS:
        m = rx.search(text)
        if not m:
            continue
        if order == 'mdy':
            iso = _iso_date(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
        elif order == 'dmy':
            iso = _iso_date(int(m.group(3)), MONTHS[m.group(2)[:3].lower()], int(m.group(1)))
        elif order == 'ymd':
            iso = _iso_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        else:
            iso = _iso_date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        if iso and (best is None or m.start() < best['index']):
            best = {'iso': iso, 'index': m.start(), 'length': m.end() - m.start()}
    return best


# ---------------------------------------------------------------------------
# Renditions, tidying, trailing markers
# ---------------------------------------------------------------------------

_RENDITION_WORD = r'clean(?:ed)?|track(?:ed)?(?:\s+changes)?|redline(?:d)?|compared|comparison'
RENDITION_SUFFIX = _rx(r'\s*(?:[-–—]\s*(' + _RENDITION_WORD + r')|\(\s*(' + _RENDITION_WORD + r')\s*\))\Z', I)
RENDITION_PREFIX = _rx(r'^(' + _RENDITION_WORD + r')\s*[-–—:]\s*', I)
RENDITION_ONLY = _rx(r'^(?:' + _RENDITION_WORD + r')\Z', I)


def _rendition_of(word):
    w = word.lower()
    if w.startswith('clean'):
        return 'clean'
    if w.startswith('compar'):
        return 'compared'
    return 'tracked'


_SPACES = _rx(r'\s+')
_SPACE_BEFORE_PUNCT = _rx(r'\s+([,.;:)])')
_SPACE_AFTER_PAREN = _rx(r'\(\s+')
_EDGES = _rx(r'^[\s\-–—_,.;:]+|[\s\-–—_,;:]+\Z')


def _tidy(s):
    s = _SPACES.sub(' ', s)
    s = _SPACE_BEFORE_PUNCT.sub(r'\1', s)
    s = _SPACE_AFTER_PAREN.sub('(', s)
    s = _EDGES.sub('', s)
    return _trim(s)


_TRAIL_SPACE = _rx(r'[\s_]+\Z')
_TRAIL_NUMBERED = _rx(r'\s*\(\s*\d{1,3}\s*\)\Z')
_TRAIL_COPY = _rx(r'\s*[-–—]\s*copy(?:\s*\(?\d{1,3}\)?)?\Z', I)
_TRAIL_VERSION = _rx(r'\s*[-–—]?\s*\bv(?:er(?:sion)?)?\.?\s?(\d{1,3})\Z', I)
_TRAIL_JOINERS = _rx(r'[\s,\-–—]+\Z')


def _strip_trailing(s, out):
    """Peels markers off the end of the text until none is left: "(1)", "- Copy", "- Clean",
    "(tracked changes)", "v2", a date without brackets."""
    for _ in range(20):
        s = _TRAIL_SPACE.sub('', s)
        m = _TRAIL_NUMBERED.search(s)
        if m:
            out['duplicate'] = True
            s = s[:m.start()]
            continue
        m = _TRAIL_COPY.search(s)
        if m:
            out['duplicate'] = True
            s = s[:m.start()]
            continue
        m = RENDITION_SUFFIX.search(s)
        if m:
            out['renditions'].append(_rendition_of(m.group(1) if m.group(1) is not None else m.group(2)))
            s = s[:m.start()]
            continue
        m = _TRAIL_VERSION.search(s)
        if m:
            out['versions'].append(int(m.group(1)))
            s = s[:m.start()]
            continue
        d = find_date(s)
        if d and _trim(s[d['index'] + d['length']:]) == '' and d['index'] > 0:
            out['dates'].append(d['iso'])
            s = _TRAIL_JOINERS.sub('', s[:d['index']])
            continue
        break
    return s


# ---------------------------------------------------------------------------
# The family key
# ---------------------------------------------------------------------------

_COMBINING = re.compile('[̀-ͯ]')
_NOT_LETTER_OR_NUMBER = re.compile(r'[\W_]+')          # Unicode on purpose: [^\p{L}\p{N}]+


def family_key_of(title):
    """A lower-case, punctuation-free key for matching versions of one document."""
    s = unicodedata.normalize('NFKD', (title or '').lower())
    s = _COMBINING.sub('', s).replace('&', ' and ')
    return _NOT_LETTER_OR_NUMBER.sub(' ', s).strip()


# ---------------------------------------------------------------------------
# parseFileName
# ---------------------------------------------------------------------------

_PATH_SEP = re.compile(r'[\\/]')
_EXTENSION = _rx(r'\.([a-z][a-z0-9]{0,5})\Z', I)
_UUID_PREFIX = _rx(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\s\-_]*', I)
_COPY_OF = _rx(r'^copy of\s+', I)
_ORDINAL = _rx(r'^\d{1,3}\.\s+')
_ANY_BRACKET = re.compile(r'[\[\]]')
_BRACKET_RUN = re.compile(r'[\[\]]+')
# The site's pattern is ^([A-Z]{1,8})\s?(\d{1,4}(?:\.\d{1,3})?[A-Z]?)...; the optional "-A" between the
# code and the number is the Filer's own sequence marker ("PTQ-A28 - ...").
_CODE = _rx(r'^([A-Z]{1,8})(?:-([A-Z]{1,2}))?\s?(\d{1,4}(?:\.\d{1,3})?[A-Z]?)(?:\s*[-–—]+\s*|\s*\Z)')
_REVISED = _rx(r'^(?:(revised|draft)\s+)?v\.?\s?(\d{1,3})\s*[-–—]\s+', I)
_VERSION_TAG = _rx(r'^v\.?\s?(\d{1,3})\Z', I)
_LAST_DOT_PART = re.compile(r'\.[^.]+\Z')


def parse_file_name(name):
    """Pulls a file name apart: {original, extension, title, code, seq, marker, tags, stage, date,
    rendition, version, duplicate, family_key}. `marker` is "A" when the number is the Filer's own
    sequence ("PTQ-A28"), else None; everything else is as the site's parseFileName gives it."""
    original = name
    # Only the last path part, if a folder path came with it.
    s = _PATH_SEP.split(name)[-1]
    extension = None
    ext = _EXTENSION.search(s)
    if ext:
        extension = ext.group(1).lower()
        s = s[:ext.start()]

    s = s.replace('_', ' ').replace('{', '[').replace('}', ']')
    s = _trim(_SPACES.sub(' ', s))

    # Emailed copies sometimes carry a UUID; numbered folders a "5. " ordinal.
    s = _UUID_PREFIX.sub('', s, count=1)
    collected = {'duplicate': False, 'stages': [], 'renditions': [], 'versions': [], 'dates': []}
    if _COPY_OF.search(s):
        collected['duplicate'] = True
        s = _COPY_OF.sub('', s, count=1)
    s = _ORDINAL.sub('', s, count=1)

    s = _strip_trailing(s, collected)

    # The title is what comes before the first bracket; every bracketed (or stray) piece after it is a tag.
    first = _ANY_BRACKET.search(s)
    head = s if first is None else s[:first.start()]
    rest = '' if first is None else s[first.start():]

    code = seq = marker = None
    code_match = _CODE.match(head)
    if code_match:
        code, marker, seq = code_match.group(1), code_match.group(2), code_match.group(3)
        head = head[code_match.end():]
    # "Revised v7 - JVA": a family whose convention broke mid-way.
    revised = _REVISED.match(head)
    if revised:
        collected['versions'].append(int(revised.group(2)))
        if revised.group(1):
            collected['stages'].append('Working draft')
        head = head[revised.end():]
    prefix = RENDITION_PREFIX.match(head)
    if prefix:
        collected['renditions'].append(_rendition_of(prefix.group(1)))
        head = head[prefix.end():]
    head = _strip_trailing(head, collected)

    tags = []
    stages = collected['stages']
    for raw in _BRACKET_RUN.split(rest):
        t = _tidy(raw)
        if not t:
            continue
        d = find_date(t)
        if d:
            collected['dates'].append(d['iso'])
            t = _tidy(t[:d['index']] + ' ' + t[d['index'] + d['length']:])
            if not t:
                continue
        t = _tidy(_strip_trailing(t, collected))
        if not t:
            continue
        if RENDITION_ONLY.match(t):
            r = _rendition_of(t)
            collected['renditions'].append(r)
            if r == 'compared':
                stages.append('Compared')
            continue
        v = _VERSION_TAG.match(t)
        if v:
            collected['versions'].append(int(v.group(1)))
            continue
        tags.append(t)
        stage = stage_from_tag(t)
        if stage:
            stages.append(stage)
        if stage == 'Compared':
            collected['renditions'].append('compared')

    title = _tidy(head)
    if not title:
        plain = next((t for t in tags if not stage_from_tag(t)), None)
        title = plain if plain is not None else _tidy(_ANY_BRACKET.sub(' ', s))
    if not title:
        title = _tidy(_LAST_DOT_PART.sub('', original)) or 'Untitled document'

    stage = None
    for st in stages:
        if stage is None or STAGE_ORDER.index(st) > STAGE_ORDER.index(stage):
            stage = st

    return {
        'original': original, 'extension': extension, 'title': title, 'code': code, 'seq': seq, 'marker': marker,
        'tags': tags, 'stage': stage,
        'date': collected['dates'][-1] if collected['dates'] else None,
        'rendition': collected['renditions'][0] if collected['renditions'] else None,
        'version': collected['versions'][0] if collected['versions'] else None,
        'duplicate': collected['duplicate'], 'family_key': family_key_of(title),
    }


_MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
_RENDITION_LABEL = {'clean': 'Clean', 'tracked': 'Tracked', 'compared': 'Compared'}


def format_short_date(iso):
    """'2026-09-26' -> '26 Sep 2026'."""
    y, m, d = (int(x) for x in iso.split('-'))
    return f'{d} {_MONTH_SHORT[m - 1]} {y}'


def version_label(parsed):
    """A short version label, e.g. "For partner review · 26 Sep 2026". Empty when the name says nothing."""
    parts = []
    if parsed.get('stage'):
        parts.append(parsed['stage'])
    if parsed.get('date'):
        parts.append(format_short_date(parsed['date']))
    rendition = parsed.get('rendition')
    if rendition and not (rendition == 'compared' and parsed.get('stage') == 'Compared'):
        parts.append(_RENDITION_LABEL[rendition])
    if parsed.get('version') is not None:
        parts.append(f"v{parsed['version']}")
    return ' · '.join(parts)


# ---------------------------------------------------------------------------
# Matching an incoming file to a document already in the project
# ---------------------------------------------------------------------------

STOPWORDS = {'the', 'of', 'and', 'a', 'an', 'to', 'for', 'in', 'on', 'with', 'by', 're'}
_ROMAN = re.compile(r'^(?=[ivx])(x{0,3})(ix|iv|v?i{0,3})\Z')
_NUMBER = re.compile(r'^[0-9]+[a-z]?\Z')
CLOSE_MATCH_THRESHOLD = 0.75


def _tokens(key):
    seen, out = set(), []
    for t in key.split(' '):
        if t and t not in STOPWORDS and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _is_number(token):
    return bool(_NUMBER.match(token) or _ROMAN.match(token))


def title_similarity(a, b):
    """How alike two family keys are, 0..1 (Dice coefficient on words). Numbers must agree:
    "Schedule 4" is not a version of "Schedule 5"; "Volume III" not of "Volume II"."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    na = ' '.join(sorted(t for t in ta if _is_number(t)))
    nb = ' '.join(sorted(t for t in tb if _is_number(t)))
    if na != nb:
        return 0.0
    set_b = set(tb)
    shared = sum(1 for t in ta if t in set_b)
    return (2 * shared) / (len(ta) + len(tb))


def find_matching_document(family_key, documents):
    """The project document an incoming file most likely belongs to: an exact match on the family
    key first, then the closest title on shared words (0.75 or more, numbers agreeing).

    documents: dicts with a 'title'. Returns {'document', 'exact', 'score'} or None; score is 1.0
    for an exact match (the site's function returns no score; the tray shows it as the confidence)."""
    if not family_key:
        return None
    keyed = [(d, parse_file_name(d.get('title') or '')['family_key'], family_key_of(d.get('title') or ''))
             for d in documents]
    for d, key, raw in keyed:
        if key == family_key or raw == family_key:
            return {'document': d, 'exact': True, 'score': 1.0}
    best = None
    for d, key, _ in keyed:
        if len(_tokens(key)) < 2 and len(_tokens(family_key)) < 2:
            continue
        score = title_similarity(family_key, key)
        if score >= CLOSE_MATCH_THRESHOLD and (best is None or score > best[1]):
            best = (d, score)
    return {'document': best[0], 'exact': False, 'score': best[1]} if best else None


# ---------------------------------------------------------------------------
# The Filer's own names
# ---------------------------------------------------------------------------

_FILER_NAME = _rx(r'^(?P<code>[A-Z]{1,8})(?:-(?P<marker>[A-Z]{1,2}))?\s?(?P<number>\d+(?:\.\d+)*)\s*[-–]\s+'
                  r'(?P<title>[^\[]+?)\s*(?P<brackets>(?:\[[^\]]*\]\s*)*)\Z')
_BRACKET = re.compile(r'\[([^\]]*)\]')
_FILER_VERSION = _rx(r'^version\s+(\d{1,3})\Z', I)
_WHATSAPP_PREFIX = re.compile(r'^[0-9]{8}-')


def parse_filer_name(name):
    """A name the Filer built, by the Filer's own grammar, or None when it is not one:

        <CODE>[-A]<n> - <Title> [<Party>][<Status>][<Month DD, YYYY>][Version n].<ext>

    Returns {code, number, marker, own, title, party, status, date, version, extension, family_key}.
    `own` says the number is in the Filer's own sequence ("-A"). Empty parts are left out of a
    Filer name, so of the brackets a date and "Version n" are told by their shape, a status by the
    Filer's status words, and what is left is the party."""
    s = _PATH_SEP.split(name or '')[-1]
    extension = None
    ext = _EXTENSION.search(s)
    if ext:
        extension = ext.group(1).lower()
        s = s[:ext.start()]
    m = _FILER_NAME.match(_trim(s))
    if not m:
        return None
    party = status = day = version = None
    loose = []
    for raw in _BRACKET.findall(m.group('brackets') or ''):
        b = _trim(raw)
        if not b:
            continue
        v = _FILER_VERSION.match(b)
        if v:
            version = int(v.group(1))
            continue
        d = find_date(b)
        if d and d['index'] == 0 and d['length'] == len(b):
            day = d['iso']
            continue
        if status is None and is_filer_status_word(b):
            status = b
            continue
        loose.append(b)
    if loose:
        party = loose[0]
        if status is None and len(loose) > 1:
            status = loose[1]
    title = _trim(m.group('title'))
    return {'code': m.group('code'), 'number': m.group('number'), 'marker': m.group('marker'),
            'own': m.group('marker') is not None, 'title': title, 'party': party, 'status': status,
            'date': day, 'version': version, 'extension': extension, 'family_key': family_key_of(title)}


def clean_original_name(name):
    """A file's name as it arrived, without the 8-digit prefix a WhatsApp export adds and without
    its extension: what is left is what the sender called the document."""
    s = _WHATSAPP_PREFIX.sub('', _PATH_SEP.split(name or '')[-1])
    ext = _EXTENSION.search(s)
    return _trim(s[:ext.start()] if ext else s)
