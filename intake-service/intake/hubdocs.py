"""Everything the intake does with a Hub project's documents.

Reading: a project's documents with their versions and content hashes; which of them
an arriving file is the next version of; the firm's document types.

Writing: file_version puts a file into a project as a new document or as the next
version of one, in the order the claude.ai connector does it
(chat-service/connector/projectWrites.js, saveVersion): upload under a new path that
can never overwrite, call save_document_version_as, and if that call fails look for a
version holding the path before deciding the save failed. Only then is the upload taken
back, so no file is left in storage without a version, and no version loses its file.
Nothing here deletes a document or a version.
"""
import hashlib
import re
import uuid

from . import filenames
from .db import in_list
from .log import warn

BUCKET = 'matter-documents'
# What the index worker reads (public.index_supported_extension). Anything else is marked
# 'unsupported' so the project page does not show it as waiting to be read.
INDEXED_EXTENSIONS = frozenset(('pdf', 'docx', 'xlsx', 'xls', 'pptx', 'txt', 'md', 'csv'))
MIME_BY_EXTENSION = {
    'md': 'text/markdown', 'txt': 'text/plain', 'csv': 'text/csv', 'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'doc': 'application/msword', 'xls': 'application/vnd.ms-excel', 'ppt': 'application/vnd.ms-powerpoint',
}
MAX_TITLE_CHARS = 200
MAX_LABEL_CHARS = 200
MAX_STEM_CHARS = 180
MAX_BYTES = 50 * 1024 * 1024          # what the Hub's storage takes for one file
MAX_ATTEMPTS = 5
_MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')


class FilingError(RuntimeError):
    """A file could not be filed. `kept_path` is set when the upload was left in storage on
    purpose: the save may have gone through, and the next run finds out by that path."""
    def __init__(self, message, kept_path=None):
        super().__init__(message)
        self.kept_path = kept_path


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def select_all(db, table, filters, columns, key='id', page=1000):
    """Every row the filters name, however many: read in pages ordered by `key` (which must be
    among the columns), each page starting after the last key of the one before. A plain select
    stops at the API's row limit without saying so."""
    out, last = [], None
    while True:
        f = dict(filters or {})
        if last is not None:
            f[key] = f'gt.{last}'
        rows = db.select(table, f, columns, order=f'{key}.asc', limit=page)
        if not rows or rows[-1][key] == last:        # the second test: never loop on an API that ignores the filter
            return out
        out.extend(rows)
        last = rows[-1][key]


def project_documents(db, matter_id):
    """The project's documents, each with its versions (oldest first) and its latest version:
    [{id, title, matter_id, document_type_id, status, versions: [{id, version_number, content_hash,
    storage_path}], latest: {...} or None}]."""
    docs = {d['id']: dict(d, versions=[], latest=None)
            for d in select_all(db, 'matter_documents', {'matter_id': f'eq.{matter_id}'},
                                'id,title,matter_id,document_type_id,status')}
    ids = list(docs)
    for start in range(0, len(ids), 50):
        for v in select_all(db, 'document_versions', {'matter_document_id': in_list(ids[start:start + 50])},
                            'id,matter_document_id,version_number,content_hash,storage_path'):
            if v['matter_document_id'] in docs:
                docs[v['matter_document_id']]['versions'].append(v)
    for d in docs.values():
        d['versions'].sort(key=lambda v: v.get('version_number') or 0)
        d['latest'] = d['versions'][-1] if d['versions'] else None
    return list(docs.values())


def find_by_hash(documents, *hashes):
    """(document, version) holding a file with one of these SHA-256 hashes, or None."""
    wanted = {h.lower() for h in hashes if h}
    if not wanted:
        return None
    for d in documents:
        for v in d['versions']:
            if (v.get('content_hash') or '').lower() in wanted:
                return d, v
    return None


def note_version(documents, matter_id, document_id, title, version_id, version_number, content_hash,
                 document_type_id=None, status=None, storage_path=None):
    """Keeps a project's in-memory list in step with a filing just made (or, on a dry run, one that
    would be made), so the next file in the same run sees it. Returns the document."""
    doc = next((d for d in documents if d['id'] == document_id), None)
    if doc is None:
        doc = {'id': document_id, 'title': title, 'matter_id': matter_id, 'document_type_id': document_type_id,
               'status': status or 'drafting', 'versions': [], 'latest': None}
        documents.append(doc)
    if any(v['id'] == version_id for v in doc['versions']):
        return doc                                   # read from the Hub after the save: already there
    version = {'id': version_id, 'matter_document_id': document_id, 'version_number': version_number,
               'content_hash': content_hash, 'storage_path': storage_path}
    doc['versions'].append(version)
    doc['latest'] = version
    return doc


def next_version_number(document):
    """What the save will number the next version of a document (1 for a new one)."""
    return ((document or {}).get('latest') or {}).get('version_number', 0) + 1 if document else 1


def version_at_path(db, storage_path):
    """The version stored under a path, or None: how a save is recognised after the fact."""
    if not storage_path:
        return None
    return db.one('document_versions', {'storage_path': f'eq.{storage_path}'},
                  'id,matter_document_id,version_number,file_name,content_hash')


def chain_document(db, documents, ancestors, matter_id, landed=None, unsettled=None):
    """Where the earlier versions of the same Filer document went.

    ancestors   the Filer ids this file is a version of, nearest first (its version_of, that row's
                version_of, ...)
    landed      {filer_id: {'matter_id', 'document_id'}} for files placed earlier in this run
    unsettled   filer ids tried in this run and not placed

    Returns ('document', doc) when the nearest placed ancestor is on this project; ('wait', filer_id)
    when a nearer ancestor is still to be filed (filing this one first would put the versions out of
    order); (None, None) when the chain says nothing."""
    ancestors = [int(a) for a in ancestors or ()]
    if not ancestors:
        return None, None
    recorded = {}
    for r in db.select('intake_documents', {'filer_id': 'in.(' + ','.join(str(a) for a in ancestors) + ')'},
                       'filer_id,matter_id,matter_document_id,outcome,attempts'):
        recorded[int(r['filer_id'])] = r
    by_id = {d['id']: d for d in documents}
    for a in ancestors:
        if unsettled and a in unsettled:
            return 'wait', a
        mem = (landed or {}).get(a)
        if mem and mem.get('matter_id') == matter_id and mem.get('document_id') in by_id:
            return 'document', by_id[mem['document_id']]
        r = recorded.get(a)
        if not r or mem:
            continue
        if r.get('outcome') in ('pending', 'error') and (r.get('attempts') or 0) < MAX_ATTEMPTS:
            return 'wait', a
        if r.get('matter_document_id') in by_id and r.get('matter_id') == matter_id:
            return 'document', by_id[r['matter_document_id']]
    return None, None


def choose_document(db, documents, title, *, matter_id, ancestors=(), landed=None, unsettled=None):
    """Which document on the project an arriving file belongs to.

    {'kind': 'chain'}   the document its earlier versions (the Filer's version_of) already went to
    {'kind': 'exact'}   one document whose title has the same family key: the next version of it
    {'kind': 'unsure'}  a close title (0.75 or more, numbers agreeing), or two documents with the very
                        same title: a person decides (Needs a look)
    {'kind': 'new'}     nothing like it: a new document
    {'kind': 'wait'}    an earlier version is still to be filed; try again next run
    Each carries 'document' (or None), 'score' (0 to 1) and, for 'wait', 'ancestor'."""
    kind, found = chain_document(db, documents, ancestors, matter_id, landed, unsettled)
    if kind == 'wait':
        return {'kind': 'wait', 'document': None, 'score': 0.0, 'ancestor': found}
    if kind == 'document':
        return {'kind': 'chain', 'document': found, 'score': 1.0}
    keys = [filenames.family_key_of(title)]
    parsed = filenames.parse_file_name(title or '')['family_key']
    if parsed and parsed not in keys:
        keys.append(parsed)
    close = None
    for key in keys:
        match = filenames.find_matching_document(key, documents)
        if not match:
            continue
        if match['exact']:
            same = [d for d in documents
                    if key in (filenames.family_key_of(d.get('title') or ''),
                               filenames.parse_file_name(d.get('title') or '')['family_key'])]
            if len(same) > 1:
                return {'kind': 'unsure', 'document': match['document'], 'score': 1.0, 'same_title': len(same)}
            return {'kind': 'exact', 'document': match['document'], 'score': 1.0}
        if close is None or match['score'] > close['score']:
            close = match
    if close:
        return {'kind': 'unsure', 'document': close['document'], 'score': close['score']}
    return {'kind': 'new', 'document': None, 'score': 0.0}


# ---- document types
def _type_key(name):
    s = re.sub(r"[’']", '', (name or '').lower())
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    return re.sub(r'\b(\w+?)s\b', r'\1', s)          # "Shareholders'" / "Shareholder's" read the same


def load_document_types(db):
    """The firm's document types by normalised name: {key: id}."""
    return {_type_key(t['name']): t['id'] for t in db.select('document_types', {}, 'id,name') if t.get('name')}


def document_type_id(types, name):
    """The type whose name equals the Filer's document_type once both are normalised, else None."""
    key = _type_key(name)
    return types.get(key) if key else None


# ---------------------------------------------------------------------------
# Names, paths, labels
# ---------------------------------------------------------------------------

def storage_stem(text):
    """The stem a version is stored under (the connector's storageStem): characters outside
    letters, digits, underscore, space and hyphen go, spaces become hyphens, 180 characters at most."""
    s = re.sub(r'[^A-Za-z0-9_\s-]+', ' ', str(text or '')).strip()
    s = re.sub(r'[\s-]+', '-', s)
    s = re.sub(r'[^A-Za-z0-9_.-]+', '-', s)
    s = re.sub(r'-+', '-', s)
    s = re.sub(r'^[-.]+|[-.]+$', '', s) or 'file'
    return s[:MAX_STEM_CHARS].rstrip('-') or 'Document'


def split_name(file_name):
    """"PTQ-A28 - Escrow Agreement [AKLA].docx" -> ("PTQ-A28-Escrow-Agreement-AKLA", "docx")."""
    m = re.match(r'^(.*)\.([A-Za-z0-9]{1,10})$', (file_name or '').strip(), re.S)
    if not m or not m.group(1).strip():
        raise FilingError(f'the file name has no extension ({file_name!r})')
    return storage_stem(m.group(1)), m.group(2).lower()


def storage_path(matter_id, document_id, file_name, key=None):
    """<matterId>/<docId>/<uuid4>-<stem>.<ext> in the matter-documents bucket."""
    stem, ext = split_name(file_name)
    return f'{matter_id}/{document_id}/{key or uuid.uuid4()}-{stem}.{ext}'


def source_label(source, chat, sender, sent_at, tz=None):
    """The label a filed version carries, saying where it came from:
    "From WhatsApp (AKLA TEAM - OFFICE) · Usama · 17 Oct 2026" or "From email · <sender> · 17 Oct 2026"."""
    if source == 'whatsapp':
        parts = [f'From WhatsApp ({chat})' if chat else 'From WhatsApp']
    else:
        parts = ['From email']
    if sender:
        parts.append(sender)
    if sent_at is not None:
        day = sent_at.astimezone(tz) if tz and sent_at.tzinfo else sent_at
        parts.append(f'{day.day} {_MONTHS[day.month - 1]} {day.year}')
    return ' · '.join(parts)[:MAX_LABEL_CHARS]


# ---------------------------------------------------------------------------
# Filing
# ---------------------------------------------------------------------------

def file_version(db, *, user_id, matter_id, title, file_name, data, label='', document=None, document_id=None,
                 document_type_id=None, doc_status=None, content_hash=None, backfill=False, path=None):
    """Files `data` into a project as a new document, or as the next version of `document`.

    user_id           the Hub Intake account (hub.intake_user_id); the version is stamped with it
    title             the document's title (used when a new document is created)
    file_name         the name the Filer gave the file on SharePoint, with its extension
    document          the existing document ({'id': ...}) for a next version; None for a new document
    document_id       for a new document, the id to create it under (a fresh one when not given)
    document_type_id  for a new document, its type (a next version keeps the document's own type)
    doc_status        the Filer's status word; sets a NEW document's status (Notes and unknown words do not)
    content_hash      the file's SHA-256 (worked out here when not given)
    backfill          lowers the indexing job's priority so a bulk run never holds up today's files
    path              the storage path to use, when the caller has already written it down

    Returns {matter_document_id, version_id, version_number, file_name, storage_path, created,
    recovered, content_hash, notes}. Raises FilingError when nothing was filed."""
    if not user_id:
        raise FilingError("the Hub has no 'Hub Intake' account to file under")
    if not data:
        raise FilingError('the file is empty')
    if len(data) > MAX_BYTES:
        raise FilingError(f'the file is larger than the {MAX_BYTES // (1024 * 1024)} MB the Hub stores')
    stem, extension = split_name(file_name)
    doc_title = re.sub(r'\s+', ' ', title or '').strip()[:MAX_TITLE_CHARS]
    if not doc_title:
        raise FilingError('the document has no title')
    create_new = document is None
    content_hash = (content_hash or hashlib.sha256(data).hexdigest()).lower()

    # 1. A next version: the document as it is now, and its latest version. The save refuses if
    #    someone files in between.
    if create_new:
        doc_id, type_id, expected = document_id or str(uuid.uuid4()), document_type_id, None
    else:
        doc = db.one('matter_documents', {'id': f"eq.{document['id']}"}, 'id,title,matter_id,document_type_id')
        if not doc:
            raise FilingError('the document is no longer on the project')
        if doc['matter_id'] != matter_id:
            raise FilingError('that document is on another project')
        latest = db.select('document_versions', {'matter_document_id': f"eq.{doc['id']}"}, 'id,version_number',
                           order='version_number.desc', limit=1)
        doc_id, type_id, expected = doc['id'], doc.get('document_type_id'), (latest[0]['id'] if latest else None)

    # 2. The upload. A new path every time; the bucket never overwrites.
    path = path or f'{matter_id}/{doc_id}/{uuid.uuid4()}-{stem}.{extension}'
    try:
        db.storage_upload(BUCKET, path, data, MIME_BY_EXTENSION.get(extension, 'application/octet-stream'))
    except Exception as e:
        raise FilingError(f'the file could not be stored ({_brief(e)})') from None

    # 3. The save.
    args = {'p_user_id': user_id, 'p_matter_id': matter_id, 'p_document_type_id': type_id, 'p_document_id': doc_id,
            'p_create_new': create_new, 'p_expected_version_id': expected, 'p_title': doc_title,
            'p_storage_path': path, 'p_file_stem': stem, 'p_is_ai_generated': False, 'p_extension': extension,
            'p_label': re.sub(r'\s+', ' ', label or '').strip()[:MAX_LABEL_CHARS] or None}
    saved, failure, recovered = None, None, False
    try:
        saved = db.rpc('save_document_version_as', args)
    except Exception as e:
        failure = e
    if not (isinstance(saved, dict) and saved.get('versionId')):
        # 4. A lost answer after a committed save leaves a version holding this path. If there is
        #    none the upload is taken back; if even the lookup fails the file stays where it is,
        #    because a version may already point at it.
        try:
            mine = version_at_path(db, path)
        except Exception as e:
            raise FilingError('the Hub could not confirm whether the version was saved '
                              f'({_brief(failure) if failure else "no answer"}; then {_brief(e)})', kept_path=path) from None
        if not mine:
            try:
                db.storage_remove(BUCKET, [path])
            except Exception as e:
                warn('could not take back the upload %s: %s', path, _brief(e))
            raise FilingError(_save_failure(failure)) from None
        saved = {'matterDocumentId': mine['matter_document_id'], 'versionId': mine['id'],
                 'versionNumber': mine['version_number'], 'fileName': mine.get('file_name')}
        recovered = True

    result = {'matter_document_id': saved.get('matterDocumentId') or doc_id, 'version_id': saved['versionId'],
              'version_number': saved.get('versionNumber'), 'file_name': saved.get('fileName'),
              'storage_path': path, 'created': create_new, 'recovered': recovered, 'content_hash': content_hash}
    # 5 and 6. The hash, what cannot be indexed, the backfill priority, a new document's status.
    result['notes'] = finish_version(db, result, extension=extension, content_hash=content_hash,
                                     backfill=backfill, doc_status=doc_status if create_new else None)
    return result


def finish_version(db, saved, *, extension, content_hash, backfill=False, doc_status=None):
    """What follows a save, safe to do twice: the file's hash on the version, 'unsupported' for a
    file the index worker cannot read, a backfill's lower indexing priority, and (doc_status given,
    for a document this filing created) the document's status from the Filer's word.

    The version is on file by now, so a failure here is not a failed filing: it is returned as a
    note (and logged), never raised."""
    notes = []
    extension = (extension or '').lower()
    patch = {'content_hash': content_hash}
    if extension not in INDEXED_EXTENSIONS:
        patch['indexing_status'] = 'unsupported'
    try:
        db.patch('document_versions', {'id': f"eq.{saved['version_id']}"}, patch)
    except Exception as e:
        notes.append(f'the content hash was not written ({_brief(e)})')
    if backfill and extension in INDEXED_EXTENSIONS:
        try:
            db.patch('document_index_jobs', {'document_version_id': f"eq.{saved['version_id']}"}, {'priority': -1})
        except Exception as e:
            notes.append(f'the indexing priority was not lowered ({_brief(e)})')
    status = filenames.status_from_filer_word(doc_status) if doc_status else None
    if status and status != 'drafting':                  # the save creates a document as 'drafting'
        try:
            db.patch('matter_documents', {'id': f"eq.{saved['matter_document_id']}"}, {'status': status})
        except Exception as e:
            notes.append(f'the document status was not set ({_brief(e)})')
    for note in notes:
        warn('version %s: %s', saved.get('version_id'), note)
    return notes


def _brief(error):
    text = re.sub(r'\s+', ' ', str(error) or error.__class__.__name__).strip()
    return text if len(text) <= 160 else text[:157] + '...'


def _save_failure(error):
    """The database's reasons as one short clause for the record."""
    msg = str(error or '')
    if re.search(r'newer document version exists', msg, re.I):
        return 'someone filed a newer version at the same moment; it will be tried again'
    if re.search(r'Forbidden', msg):
        return "the 'Hub Intake' account is not an approved member of the firm"
    if re.search(r'Project is unavailable', msg):
        return 'that project is no longer available'
    if re.search(r'does not belong to this project', msg):
        return 'that document is not on that project (or its type changed)'
    if re.search(r'uploaded file is unavailable', msg):
        return "the file did not reach the Hub's storage"
    return f'the Hub could not save the version ({_brief(error)})' if error else 'the Hub could not save the version (no answer)'
