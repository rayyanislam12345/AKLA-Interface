"""The Graph side of reading firm mailboxes (application permission Mail.Read).

Written against an injected client with the two methods intake/graph.py's Graph
has, `call(method, path, body, content_type, retries, raw)` and errors that
carry `.status`, so the tests need no network.

Per mailbox and folder (inbox, sentitems):
  - a delta read from the cursor kept in intake_mail_state. The first read of a
    folder is a baseline: it asks only for mail received from that moment on,
    so nothing older is ever read. A cursor Graph no longer accepts (400 / 410)
    starts a fresh baseline.
  - the full message for each new id, fetched in small $batch calls with the
    body as text and the attachment NAMES only. No attachment is ever downloaded.
  - `to_neutral`: the plain dict the rules, the classifier and the acting step
    use, so a second source (group chat text) can be added without touching them.

The cursor is saved by the caller (intake/mail.py) and only after every message
of the batch has been handled.
"""
import html
import json
import re
import urllib.parse
from datetime import datetime, timezone

FOLDERS = ('inbox', 'sentitems')

# The delta read only finds WHICH messages are new; the key and the received time
# let the caller skip what it has already handled without fetching a body.
DELTA_SELECT = 'id,internetMessageId,receivedDateTime,isDraft'
MESSAGE_SELECT = ('id,internetMessageId,conversationId,subject,from,sender,toRecipients,ccRecipients,'
                  'receivedDateTime,sentDateTime,isDraft,hasAttachments,body,uniqueBody,internetMessageHeaders')
# Names only. contentBytes is never asked for.
ATTACHMENT_EXPAND = 'attachments($select=name,isInline)'
TEXT_BODY = {'Prefer': 'outlook.body-content-type="text"'}
BATCH = 4            # Exchange lets one app run four requests at a time against a mailbox
PAGE = 50


class CursorExpired(Exception):
    """Graph no longer accepts the stored delta link."""


def _status(error):
    return getattr(error, 'status', None)


def _user(mailbox):
    return '/users/' + urllib.parse.quote(mailbox, safe='@.')


def stamp(moment):
    """A UTC time as Graph writes it: 2026-11-23T10:00:00Z."""
    return moment.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_time(text):
    """An aware datetime from Graph's ISO text, or None."""
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(str(text).replace('Z', '+00:00'))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------- the cursor

def load_state(db, mailbox, folder):
    return db.one('intake_mail_state', {'mailbox': f'eq.{mailbox}', 'folder': f'eq.{folder}'})


def save_state(db, mailbox, folder, delta_link, baseline_at):
    db.upsert('intake_mail_state', {
        'mailbox': mailbox, 'folder': folder, 'delta_link': delta_link, 'baseline_at': baseline_at,
        'updated_at': datetime.now(timezone.utc).isoformat()}, on_conflict='mailbox,folder')


# ------------------------------------------------------------ the delta read

def first_path(mailbox, folder, since):
    """The first delta request for a folder: only mail received from `since` on."""
    received = urllib.parse.quote(f'receivedDateTime ge {stamp(since)}', safe=':')
    return (f'{_user(mailbox)}/mailFolders/{folder}/messages/delta'
            f'?$select={DELTA_SELECT}&$top={PAGE}&$filter={received}')


def _unfiltered_path(mailbox, folder):
    return f'{_user(mailbox)}/mailFolders/{folder}/messages/delta?$select={DELTA_SELECT}&$top={PAGE}'


def _walk(client, path):
    """Follows one delta round to its end: ([{id, key, received}], the delta link for next time)."""
    items, seen = [], set()
    while True:
        page = client.call('GET', path)
        for node in page.get('value', []):
            if '@removed' in node or node.get('isDraft') or not node.get('id') or node['id'] in seen:
                continue
            seen.add(node['id'])
            items.append({'id': node['id'], 'key': (node.get('internetMessageId') or '').strip(),
                          'received': parse_time(node.get('receivedDateTime'))})
        if page.get('@odata.nextLink'):
            path = page['@odata.nextLink']
            continue
        return items, page.get('@odata.deltaLink')


def read_first(client, mailbox, folder, since):
    """The first round for a folder. Should Graph refuse the date filter, the whole
    folder is walked for ids instead; the caller drops everything older than `since`."""
    try:
        return _walk(client, first_path(mailbox, folder, since))
    except Exception as e:
        if _status(e) != 400:
            raise
    return _walk(client, _unfiltered_path(mailbox, folder))


def read_delta(client, delta_link):
    """What changed since the stored cursor. Raises CursorExpired on 400 / 410."""
    try:
        return _walk(client, delta_link)
    except Exception as e:
        if _status(e) in (400, 410):
            raise CursorExpired() from None
        raise


# ---------------------------------------------------------- the full message

def _message_url(mailbox, message_id):
    return (f'{_user(mailbox)}/messages/{urllib.parse.quote(message_id, safe="=-_")}'
            f'?$select={MESSAGE_SELECT}&$expand={ATTACHMENT_EXPAND}')


def fetch_messages(client, mailbox, ids):
    """The Graph message for each id: (nodes in the order asked, ids that could not be fetched).
    A message moved or deleted since the delta read (404) is neither: it is simply gone."""
    nodes, failed = {}, []
    for start in range(0, len(ids), BATCH):
        chunk = ids[start:start + BATCH]
        payload = {'requests': [{'id': str(i), 'method': 'GET', 'url': _message_url(mailbox, mid), 'headers': TEXT_BODY}
                                for i, mid in enumerate(chunk)]}
        answer = client.call('POST', '/$batch', body=json.dumps(payload).encode(), content_type='application/json')
        by_id = {str(r.get('id')): r for r in answer.get('responses', [])}
        for i, mid in enumerate(chunk):
            response = by_id.get(str(i)) or {}
            status = response.get('status')
            if status == 200 and isinstance(response.get('body'), dict):
                nodes[mid] = response['body']
            elif status == 404:
                continue
            else:
                # throttled inside the batch, or no answer: ask for this one on its own (the client retries)
                try:
                    nodes[mid] = client.call('GET', _message_url(mailbox, mid))
                except Exception as e:
                    if _status(e) == 404:
                        continue
                    if _status(e) in (401, 403):
                        raise
                    failed.append(mid)
    return [nodes[mid] for mid in ids if mid in nodes], failed


# ------------------------------------------------- newest message vs. thread

_STRIP_BLOCKS = re.compile(r'<(script|style|iframe|object|embed|noscript|form|video|audio|head)\b.*?</\1\s*>', re.I | re.S)
_BLOCK_END = re.compile(r'<\s*(br|/p|/div|/tr|/li|/h[1-6]|/blockquote|/table)\b[^>]*>', re.I)

# Where a reply's quoted history starts, in the HTML the main mail clients write.
_HTML_QUOTE = [
    re.compile(r'<div[^>]+id=["\']?(divRplyFwdMsg|appendonsend)', re.I),          # Outlook
    re.compile(r'<div[^>]+class=["\']?gmail_(quote|attr)', re.I),                # Gmail
    re.compile(r'<blockquote\b', re.I),
    re.compile(r'-{3,}\s*Original Message\s*-{3,}', re.I),
    re.compile(r'(?:<[^>]+>\s*)*(?:From|De|Von)\s*:\s*(?:<[^>]+>\s*)*[^<]{1,200}?'
               r'(?:<[^>]+>\s*)*(?:Sent|Date)\s*:', re.I | re.S),
    re.compile(r'On [^<]{5,160}? wrote:', re.I),
]
# The same in plain text (Graph's text bodies, or a mail written as text).
_TEXT_QUOTE = re.compile(
    r'(^[ \t]*-{3,}\s*(?:Original|Forwarded) Message\s*-{3,}'
    r'|^[ \t]*_{10,}[ \t]*\n[ \t]*From:'
    r'|^[ \t]*From:[^\n]{1,200}\n[ \t]*(?:Sent|Date):'
    r'|^[ \t]*On [^\n]{5,160} wrote:'
    r'|^[ \t]*>)', re.I | re.M)


def html_to_text(fragment):
    """Readable plain text from an email's HTML, keeping line breaks."""
    text = _STRIP_BLOCKS.sub('', fragment or '')
    text = _BLOCK_END.sub('\n', text)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html.unescape(text).replace('\xa0', ' ')
    text = re.sub(r'[ \t]+', ' ', text)
    return re.sub(r' *\n[ \n]*', '\n', text).strip()


def _tidy(text):
    text = (text or '').replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
    text = re.sub(r'[ \t]+', ' ', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def _part(node):
    """(text, html or '') of a Graph body or uniqueBody."""
    node = node or {}
    content = node.get('content') or ''
    if (node.get('contentType') or '').lower() == 'html':
        return html_to_text(content), content
    return _tidy(content), ''


def _squash(text):
    return re.sub(r'\s+', ' ', text or '').strip()


def split_thread(body, unique_body):
    """(the newest message only, the older thread quoted under it), both as text.

    Exchange's own uniqueBody is used when it has any text. Otherwise the body is cut
    at the first reply or forward marker that has something written above it; a mail
    with no marker is all newest."""
    full, full_html = _part(body)
    newest, _ = _part(unique_body)
    if not newest.strip():
        if full_html:
            cut = _html_history_start(full_html)
            if cut is not None:
                return html_to_text(full_html[:cut]), html_to_text(full_html[cut:])
            return full, ''
        cut = _text_history_start(full)
        return (full[:cut].strip(), full[cut:].strip()) if cut is not None else (full, '')

    # the newest part is known; the thread is whatever the body holds besides it
    if full_html:
        cut = _html_history_start(full_html)
        if cut is not None:
            return newest, html_to_text(full_html[cut:])
    else:
        cut = _text_history_start(full)
        if cut is not None:
            return newest, full[cut:].strip()
    flat_full, flat_newest = _squash(full), _squash(newest)
    if flat_full.startswith(flat_newest):
        return newest, flat_full[len(flat_newest):].strip()
    # the two could not be told apart: keep the whole body as context rather than lose it
    return newest, (full if len(flat_full) > len(flat_newest) + 80 else '')


def _html_history_start(full_html):
    positions = sorted(m.start() for m in (rx.search(full_html) for rx in _HTML_QUOTE) if m)
    for pos in positions:
        if html_to_text(full_html[:pos]):
            return pos
    return None


def _text_history_start(text):
    for m in _TEXT_QUOTE.finditer(text):
        if text[:m.start()].strip():
            return m.start()
    return None


# ------------------------------------------------------- the neutral message

def _address(node):
    address = ((node or {}).get('emailAddress') or {})
    return (address.get('name') or '').strip(), (address.get('address') or '').strip().lower()


def to_neutral(node, mailbox, folder):
    """A Graph message as the plain dict everything after this module works on."""
    sender_name, sender_address = _address(node.get('from') or node.get('sender'))
    newest, thread = split_thread(node.get('body'), node.get('uniqueBody'))
    headers = {h['name'].lower(): h.get('value', '') for h in node.get('internetMessageHeaders') or [] if h.get('name')}
    sent = parse_time(node.get('sentDateTime')) or parse_time(node.get('receivedDateTime')) or datetime.now(timezone.utc)
    return {
        'source': 'email',
        'key': (node.get('internetMessageId') or '').strip() or node.get('id'),
        'conversation': node.get('conversationId') or '',
        'mailbox': (mailbox or '').lower(),
        'folder': 'sentitems' if folder == 'sentitems' else 'inbox',
        'sender_name': sender_name,
        'sender_address': sender_address,
        'to': [a for _, a in map(_address, node.get('toRecipients') or []) if a],
        'cc': [a for _, a in map(_address, node.get('ccRecipients') or []) if a],
        'sent_at': sent,
        'subject': _squash(node.get('subject')),
        'newest_text': newest,
        'thread_text': thread,
        'headers': headers,
        'attachments': [a['name'] for a in node.get('attachments') or [] if a.get('name') and not a.get('isInline')],
    }
