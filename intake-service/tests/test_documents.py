"""The documents run: what the Filer filed, filed into the Hub. No network: the Hub is an
in-memory FakeDb that answers PostgREST-style filters and plays save_document_version_as, the
Filer's record is a temporary sqlite, SharePoint is a dict, and the matcher is a small fake.
Every title, person, project and address here is invented."""
import contextlib
import hashlib
import io
import os
import re
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

import helpers  # noqa: F401  (puts the package on the path)
from test_filer import filed, make_filer_db
from intake import documents, hubdocs
from intake.db import DbError
from intake.graph import GraphError

USER = 'u-intake'
MATTER = 'm-bypass'
INDEXED = ('pdf', 'docx', 'xlsx', 'xls', 'pptx', 'txt', 'md', 'csv')


# ---------------------------------------------------------------------------
# The fakes
# ---------------------------------------------------------------------------

def _items(text):
    inner = text[text.index('(') + 1:text.rindex(')')]
    return [a if a else b.strip() for a, b in re.findall(r'"((?:[^"\\]|\\.)*)"|([^,]+)', inner)]


def _matches(row, key, cond):
    if '->>' in key:
        column, sub = key.split('->>')
        value = (row.get(column) or {}).get(sub)
    else:
        value = row.get(key)
    if cond == 'is.null':
        return value is None
    if cond == 'not.is.null':
        return value is not None
    op, _, arg = cond.partition('.')
    if op == 'eq':
        return value is not None and str(value) == arg
    if op == 'in':
        return value is not None and str(value) in _items(arg)
    if op in ('gt', 'lt'):
        if value is None:
            return False
        try:
            a, b = float(value), float(arg)
        except (TypeError, ValueError):
            a, b = str(value), arg
        return a > b if op == 'gt' else a < b
    if op == 'like':
        return value is not None and re.fullmatch(re.escape(arg).replace(r'\*', '.*'), str(value)) is not None
    raise AssertionError(f'FakeDb does not know the filter {key}={cond}')


DEFAULTS = {
    'intake_documents': {'outcome': 'pending', 'attempts': 0, 'matter_id': None, 'matter_document_id': None,
                         'document_version_id': None, 'version_number': None, 'storage_path': None, 'row_id': None,
                         'reason': None, 'handled_at': None},
    'intake_tray': {'status': 'open', 'resolution': None, 'resolved_at': None, 'guess': None},
    'intake_actions': {'undone_at': None},
    'transaction_rows': {'archived_at': None, 'currently_with': None, 'team': []},
}


class FakeDb:
    """The Hub's tables in memory, with the parts of PostgREST the intake uses."""
    offline = False
    dry_run = False

    def __init__(self):
        self.tables = {}
        self.storage = {}            # 'bucket/path' -> bytes
        self.removed = []
        self.writes = []             # (verb, table or function)
        self.rpc_calls = []
        self.rpc_mode = 'ok'         # ok | fail | lost (saved, but the answer never arrives)
        self.failing = []            # [(verb, table, error)]: the next such call raises, once
        self.max_rows = 1000         # the API's silent row limit
        self._n = 0

    # ---- helpers for the tests
    def rows(self, table):
        return self.tables.setdefault(table, [])

    def add(self, table, **row):
        self._n += 1
        full = dict(DEFAULTS.get(table, {}), **row)
        full.setdefault('id', f'{table}-{self._n}')
        self.rows(table).append(full)
        return full

    def fail_next(self, verb, table, error=None):
        self.failing.append((verb, table, error or DbError(f'{verb} {table} -> 503: unavailable')))

    def _maybe_fail(self, verb, table):
        for i, (v, t, error) in enumerate(self.failing):
            if (v, t) == (verb, table):
                del self.failing[i]
                raise error

    # ---- reads
    def select(self, table, filters=None, columns='*', order=None, limit=None):
        self._maybe_fail('select', table)
        found = [dict(r) for r in self.rows(table) if all(_matches(r, k, c) for k, c in (filters or {}).items())]
        if order:
            column, _, direction = order.partition('.')
            found.sort(key=lambda r: (r.get(column) is None, r.get(column) if r.get(column) is not None else 0),
                       reverse=direction == 'desc')
        return found[:min(limit or self.max_rows, self.max_rows)]

    def one(self, table, filters, columns='*'):
        found = self.select(table, filters, columns, limit=1)
        return found[0] if found else None

    def setting(self, key, default=None):
        row = self.one('intake_settings', {'key': f'eq.{key}'})
        return default if row is None else row['value']

    # ---- writes
    def insert(self, table, rows):
        rows = rows if isinstance(rows, list) else [rows]
        self._maybe_fail('insert', table)
        self.writes.append(('insert', table))
        return [dict(self.add(table, **r)) for r in rows]

    def upsert(self, table, rows, on_conflict):
        rows = rows if isinstance(rows, list) else [rows]
        self._maybe_fail('upsert', table)
        self.writes.append(('upsert', table))
        out = []
        for r in rows:
            existing = next((x for x in self.rows(table) if x.get(on_conflict) == r.get(on_conflict)), None)
            if existing:
                existing.update(r)
                out.append(dict(existing))
            else:
                out.append(dict(self.add(table, **r)))
        return out

    def patch(self, table, filters, data):
        self._maybe_fail('patch', table)
        self.writes.append(('patch', table))
        hit = [r for r in self.rows(table) if all(_matches(r, k, c) for k, c in filters.items())]
        for r in hit:
            r.update(data)
        return [dict(r) for r in hit]

    def delete(self, table, filters):
        raise AssertionError('the intake never deletes from the Hub')

    def storage_upload(self, bucket, path, data, content_type='application/octet-stream'):
        self._maybe_fail('upload', bucket)
        self.writes.append(('upload', bucket))
        key = f'{bucket}/{path}'
        if key in self.storage:
            raise DbError(f'upload {key} -> 409: The resource already exists')
        self.storage[key] = bytes(data)
        return path

    def storage_remove(self, bucket, paths):
        self.writes.append(('remove', bucket))
        for p in paths:
            self.removed.append(p)
            self.storage.pop(f'{bucket}/{p}', None)

    def rpc(self, function, args, write=True):
        self.writes.append(('rpc', function))
        self.rpc_calls.append((function, dict(args)))
        assert function == 'save_document_version_as', function
        if self.rpc_mode == 'fail':
            raise DbError('POST rpc/save_document_version_as -> 500: something broke')
        saved = self._save(args)
        if self.rpc_mode == 'lost':
            raise DbError('POST rpc/save_document_version_as -> 504: upstream timed out')
        return saved

    def _save(self, a):
        """public.save_document_version_as, as the migration writes it."""
        path, doc_id, matter_id = a['p_storage_path'], a['p_document_id'], a['p_matter_id']
        if not self.one('profiles', {'id': f"eq.{a['p_user_id']}", 'status': 'eq.approved'}):
            raise DbError('rpc -> 400: Forbidden')
        if not path.startswith(f'{matter_id}/{doc_id}/'):
            raise DbError('rpc -> 400: Invalid document storage path')
        if f'matter-documents/{path}' not in self.storage:
            raise DbError('rpc -> 400: The uploaded file is unavailable')
        versions = [v for v in self.rows('document_versions') if v['matter_document_id'] == doc_id]
        again = next((v for v in versions if v['storage_path'] == path), None)
        if again:
            return {'matterDocumentId': doc_id, 'versionId': again['id'], 'versionNumber': again['version_number'],
                    'fileName': again['file_name']}
        doc = next((d for d in self.rows('matter_documents') if d['id'] == doc_id), None)
        if a['p_create_new']:
            assert doc is None, 'a new document needs a fresh id'
            doc = self.add('matter_documents', id=doc_id, matter_id=matter_id, document_type_id=a['p_document_type_id'],
                           title=a['p_title'], status='drafting', created_by=a['p_user_id'])
        elif not doc or doc['matter_id'] != matter_id or doc.get('document_type_id') != a['p_document_type_id']:
            raise DbError('rpc -> 400: Document does not belong to this project and type')
        latest = max(versions, key=lambda v: v['version_number'], default=None)
        if not a['p_create_new'] and (latest['id'] if latest else None) != a['p_expected_version_id']:
            raise DbError('rpc -> 400: A newer document version exists. Reopen the latest version before saving these edits.')
        number = (latest['version_number'] if latest else 0) + 1
        name = f"{a['p_file_stem']}-v{number}.{a['p_extension'].lower()}"
        version = self.add('document_versions', matter_document_id=doc_id, version_number=number, storage_path=path,
                           file_name=name, is_ai_generated=a['p_is_ai_generated'], uploaded_by=a['p_user_id'],
                           indexing_status='pending', label=a['p_label'], content_hash=None)
        if path.rsplit('.', 1)[-1].lower() in INDEXED:            # the trigger that queues the index worker
            self.add('document_index_jobs', document_version_id=version['id'], priority=0)
        return {'matterDocumentId': doc_id, 'versionId': version['id'], 'versionNumber': number, 'fileName': name}


class FakeGraph:
    """SharePoint as a dict of path -> bytes. A missing path is a 404, as Graph.download gives it."""
    def __init__(self, files=None):
        self.files = dict(files or {})
        self.calls = []
        self.down = None             # a status every call gets: SharePoint itself is not answering
        self.broken = {}             # path -> what downloading that one file raises

    def download(self, rel):
        self.calls.append(rel)
        if self.down:
            raise GraphError(self.down, f'GET {rel} -> the service is unavailable')
        if rel in self.broken:
            raise self.broken[rel]
        if rel not in self.files:
            raise GraphError(404, f'GET {rel} -> not found')
        return self.files[rel], 'etag'

    def data_room(self):
        return 'drive-1', {'id': 'room'}

    def call(self, method, path, **kw):
        if self.down:
            raise GraphError(self.down, f'{method} {path} -> the service is unavailable')
        return {'id': 'drive-1'}


def _words(text):
    return {w for w in re.sub(r'[^a-z0-9]+', ' ', (text or '').lower()).split() if w not in ('the', 'of', 'and')}


class FakeMatcher:
    """The contract's matcher API, small: codes to entries and projects, word overlap for rows."""
    th = {'transaction_high': 0.8, 'deliverable_high': 0.75, 'deliverable_low': 0.45}
    names = ['Sana Mirza', 'Bilal Chaudhry']
    aliases = {'sana': 'Sana Mirza', 'bilal': 'Bilal Chaudhry'}

    def __init__(self):
        self.entries = {
            'NB': {'code': 'NB', 'name': 'Northern Bypass', 'pairs': [('Roads Co', 'Northern Bypass')], 'matters': [MATTER]},
            'HP': {'code': 'HP', 'name': 'Harbour Project', 'pairs': [], 'matters': []},
        }
        self.matters = {'NB': MATTER}
        self.projects = {MATTER: {'id': MATTER, 'name': 'Northern Bypass'}, 'm-harbour': {'id': 'm-harbour', 'name': 'Harbour Project'}}

    def entry_for_code(self, code):
        return self.entries.get(code)

    def matter_for_code(self, code, text=''):
        return self.matters.get(code)

    def resolve_transaction(self, text):
        for entry in self.entries.values():
            if entry['name'].lower() == (text or '').lower():
                return entry, 1.0
        return None, 0.0

    def candidate_rows(self, rows, entry):
        return [r for r in rows if (r['client'], r['project']) in entry['pairs']]

    def match_row(self, texts, rows, transaction=''):
        best, top = None, 0.0
        for row in rows:
            for text in texts:
                a, b = _words(text), _words(row['deliverable'])
                score = 2 * len(a & b) / (len(a) + len(b)) if a and b else 0.0
                if score > top:
                    best, top = row, score
        return best, top, []

    def person(self, text):
        return self.aliases.get((text or '').strip().lower(), (text or '').strip())


# ---------------------------------------------------------------------------
# A world to run in
# ---------------------------------------------------------------------------

def nb(id, title='Concession Agreement', status='Draft', **kw):
    """A Filer row for the Northern Bypass (code NB), sent by a firm person to the team group."""
    return filed(id, code='NB', title=title, status=status, **kw)


def content(row):
    return f"the bytes of file {row['id']}".encode()


def rel(row):
    return f"{row['folder']}/{row['filed_name']}"


class DocumentsCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='documents-test-')
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.out = io.StringIO()
        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stdout(self.out))
        self.proposals = []
        stub = types.ModuleType('intake.projects')
        # `source` says where the arrival came from, for a project the switch lets the intake create itself.
        stub.propose_project = lambda db, matcher, name, code=None, seen=None, client=None, source=None: self.proposals.append(
            {'name': name, 'code': code, 'seen': seen})
        stack.enter_context(mock.patch.dict(sys.modules, {'intake.projects': stub}))
        self.addCleanup(stack.close)

        self.db = FakeDb()
        self.db.add('profiles', id=USER, full_name='Hub Intake', status='approved')
        self.db.add('profiles', id='u-sana', full_name='Sana Mirza', status='approved')
        self.db.add('profiles', id='u-bilal', full_name='Bilal Chaudhry', status='approved')
        self.db.add('matters', id=MATTER, name='Northern Bypass')
        self.db.add('matters', id='m-harbour', name='Harbour Project')
        self.db.add('document_types', id='t-agreement', name='Agreements')
        self.db.add('transaction_rows', id='row-ca', sort_order=1, client='Roads Co', project='Northern Bypass',
                    deliverable='Concession Agreement', status='With Client', currently_with='Roads Co', matter_id=MATTER)
        self.db.add('transaction_rows', id='row-ea', sort_order=2, client='Roads Co', project='Northern Bypass',
                    deliverable='Escrow Agreement', status='In Progress', matter_id=MATTER)
        self.matcher = FakeMatcher()
        self.graph = FakeGraph()
        self.filer_rows = []
        self.filer_db = os.path.join(self.dir, 'filed.sqlite')

    # ---- building
    def filer(self, *rows, on_sharepoint=True):
        """(Re)writes the Filer's record with these rows added, and puts their files on SharePoint."""
        self.filer_rows.extend(rows)
        if os.path.exists(self.filer_db):
            os.remove(self.filer_db)
        make_filer_db(self.filer_db, self.filer_rows)
        if on_sharepoint:
            for r in rows:
                self.graph.files[rel(r)] = content(r)

    def run_it(self, **kw):
        kw.setdefault('graph', self.graph)
        kw.setdefault('matcher', self.matcher)
        return documents.run_documents(self.db, filer_db=self.filer_db, **kw)

    def hub_document(self, title, versions=1, doc_id=None, type_id=None, hashes=(), matter=MATTER):
        doc = self.db.add('matter_documents', id=doc_id or f"doc-{title.lower().replace(' ', '-')}", matter_id=matter,
                          document_type_id=type_id, title=title, status='internal_review', created_by='u-sana')
        for n in range(1, versions + 1):
            self.db.add('document_versions', matter_document_id=doc['id'], version_number=n,
                        storage_path=f"{matter}/{doc['id']}/old-{n}.docx", file_name=f'old-v{n}.docx',
                        content_hash=hashes[n - 1] if n <= len(hashes) else None)
        return doc

    def setting(self, key, value):
        self.db.add('intake_settings', key=key, value=value)

    # ---- looking
    def intake(self, filer_id):
        return next(r for r in self.db.rows('intake_documents') if r['filer_id'] == filer_id)

    def versions(self, doc_id=None):
        return [v for v in self.db.rows('document_versions') if doc_id is None or v['matter_document_id'] == doc_id]

    def actions(self, kind=None):
        return [a for a in self.db.rows('intake_actions') if kind is None or a['kind'] == kind]

    def tray(self, kind=None):
        return [t for t in self.db.rows('intake_tray') if kind is None or t['kind'] == kind]

    def stored(self):
        return sorted(self.db.storage)


# ---------------------------------------------------------------------------
# Filing
# ---------------------------------------------------------------------------

class NewDocumentTest(DocumentsCase):
    def test_a_new_document_is_filed_with_its_row_line_and_its_log_entry(self):
        row = nb(1, status='Mark-up')
        self.filer(row)
        summary = self.run_it()

        self.assertEqual((summary['seen'], summary['filed'], summary['new_documents'], summary['row_lines'], summary['errors']),
                         (1, 1, 1, 1, 0))
        # the save, exactly as the contract lists it
        (function, args), = self.db.rpc_calls
        doc_id = args['p_document_id']
        self.assertEqual(args['p_user_id'], USER)
        self.assertEqual((args['p_matter_id'], args['p_create_new'], args['p_expected_version_id']), (MATTER, True, None))
        self.assertEqual(args['p_title'], 'Concession Agreement')
        self.assertEqual(args['p_document_type_id'], 't-agreement')          # "Agreement" is the type "Agreements"
        self.assertEqual((args['p_is_ai_generated'], args['p_extension']), (False, 'docx'))
        self.assertEqual(args['p_file_stem'], 'NB-A1-Concession-Agreement-AKLA-Mark-up-October-17-2026')
        self.assertEqual(args['p_label'], 'From WhatsApp (TEAM GROUP) · Sana Mirza · 17 Oct 2026')
        self.assertRegex(args['p_storage_path'],
                         rf'^{MATTER}/{doc_id}/[0-9a-f-]{{36}}-NB-A1-Concession-Agreement-AKLA-Mark-up-October-17-2026\.docx$')
        self.assertEqual(self.stored(), ['matter-documents/' + args['p_storage_path']])
        self.assertEqual(self.db.storage['matter-documents/' + args['p_storage_path']], content(row))

        # the version: the hash of the bytes filed; the new document's status from the Filer's word
        version, = self.versions()
        self.assertEqual(version['content_hash'], hashlib.sha256(content(row)).hexdigest())
        self.assertEqual(version['indexing_status'], 'pending')
        document = self.db.one('matter_documents', {'id': f'eq.{doc_id}'})
        self.assertEqual((document['title'], document['status']), ('Concession Agreement', 'negotiation'))
        self.assertEqual(self.db.rows('document_index_jobs')[0]['priority'], 0)

        # the document's record
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['matter_id'], rec['matter_document_id'], rec['document_version_id']),
                         ('filed', MATTER, doc_id, version['id']))
        self.assertEqual((rec['version_number'], rec['storage_path'], rec['row_id'], rec['attempts']),
                         (1, args['p_storage_path'], 'row-ca', 0))
        self.assertIsNotNone(rec['handled_at'])
        self.assertEqual((rec['source'], rec['chat'], rec['sender'], rec['sender_id'], rec['doc_status'], rec['title']),
                         ('whatsapp', 'TEAM GROUP', 'Sana Mirza', 'u-sana', 'Mark-up', 'Concession Agreement'))
        self.assertEqual((rec['sent_at'], rec['document_date'], rec['code']), ('2026-10-17T12:00:15+00:00', '2026-10-17', 'NB'))

        # the row line, and the two log entries in one group
        update, = self.db.rows('transaction_updates')
        self.assertEqual(update['body'], f"Mark-up sent by Sana Mirza (TEAM GROUP): {row['filed_name']}")
        self.assertEqual((update['row_id'], update['source'], update['source_ref'], update['at']),
                         ('row-ca', 'whatsapp', 'filer:1', '2026-10-17T12:00:15+00:00'))
        self.assertEqual((update['author'], update['author_id']), ('Sana', 'u-sana'))
        line, = self.actions('row_update')
        filing, = self.actions('version_filed')
        self.assertEqual(line['group_id'], filing['group_id'])
        self.assertEqual(line['summary'], f"Concession Agreement: {update['body']}")
        self.assertEqual(line['detail'], {'from': 'Sana Mirza', 'chat': 'TEAM GROUP', 'sent': '2026-10-17T12:00:15+00:00',
                                          'via': 'WhatsApp', 'file': row['filed_name']})
        self.assertEqual((line['intake_document_id'], line['update_id'], line['row_id']), (rec['id'], update['id'], 'row-ca'))
        self.assertEqual(filing['summary'], 'Concession Agreement · new document')
        self.assertEqual(filing['detail'], {
            'title': 'Concession Agreement', 'version_number': 1, 'file': row['filed_name'], 'from': 'Sana Mirza',
            'chat': 'TEAM GROUP', 'sent': '2026-10-17T12:00:15+00:00', 'via': 'WhatsApp', 'created_document': True,
            'web_url': row['web_url'], 'doc_status': 'Mark-up'})
        self.assertEqual((filing['source'], filing['source_ref'], filing['matter_id'], filing['document_id'],
                          filing['version_id'], filing['intake_document_id']),
                         ('whatsapp', 'filer:1', MATTER, doc_id, version['id'], rec['id']))

        # the run is on record
        run, = self.db.rows('intake_runs')
        self.assertEqual((run['kind'], run['ok'], run['summary']['filed']), ('documents', True, 1))
        self.assertEqual(run['summary']['documents'][0]['outcome'], 'filed')

    def test_a_second_run_files_nothing_again(self):
        self.filer(nb(1), nb(2, title='Escrow Agreement'))
        self.run_it()
        calls, downloads = len(self.db.rpc_calls), len(self.graph.calls)
        again = self.run_it()
        self.assertEqual((again['seen'], again['handled'], again['filed']), (0, 0, 0))
        self.assertEqual((len(self.db.rpc_calls), len(self.graph.calls)), (calls, downloads))
        self.assertEqual(len(self.versions()), 2)
        self.assertEqual(len(self.actions('version_filed')), 2)

    def test_notes_leave_the_status_alone_and_an_unreadable_type_is_marked(self):
        memo = nb(1, title='Call Notes', status='Notes')
        memo['filed_name'] = 'NB-A1 - Call Notes [AKLA][Notes][October 17, 2026].msg'
        memo['fields']['document_type'] = 'Notes'
        self.filer(memo)
        self.run_it(backfill=True)
        version, = self.versions()
        self.assertEqual(version['indexing_status'], 'unsupported')          # .msg is not read by the index worker
        self.assertEqual(self.db.rows('matter_documents')[0]['status'], 'drafting')
        self.assertIsNone(self.db.rpc_calls[0][1]['p_document_type_id'])     # no type called "Notes"
        self.assertEqual(self.db.rows('document_index_jobs'), [])

    def test_a_backfill_queues_indexing_behind_everyone_else(self):
        self.filer(nb(1))
        summary = self.run_it(backfill=True)
        self.assertTrue(summary['backfill'])
        self.assertEqual(self.db.rows('document_index_jobs')[0]['priority'], -1)


class WhichDocumentTest(DocumentsCase):
    def test_an_exact_title_is_the_next_version(self):
        doc = self.hub_document('NB12 - Concession Agreement [AKLA]', versions=2, type_id='t-other')
        self.filer(nb(1, status='Final'))
        summary = self.run_it()
        self.assertEqual((summary['filed'], summary['next_versions'], summary['new_documents']), (1, 1, 0))
        args = self.db.rpc_calls[0][1]
        latest = [v for v in self.versions(doc['id']) if v['version_number'] == 2][0]
        self.assertEqual((args['p_document_id'], args['p_create_new'], args['p_expected_version_id']),
                         (doc['id'], False, latest['id']))
        self.assertEqual(args['p_document_type_id'], 't-other')              # the document's own type, not the Filer's
        self.assertEqual(self.intake(1)['version_number'], 3)
        self.assertEqual(doc['status'], 'internal_review')                   # an existing document keeps its status
        filing, = self.actions('version_filed')
        self.assertEqual(filing['summary'], 'NB12 - Concession Agreement [AKLA] · v3 filed')
        self.assertFalse(filing['detail']['created_document'])

    def test_the_version_of_chain_wins_over_the_title(self):
        # The first version went into a document a person has since renamed; the title no longer matches.
        doc = self.hub_document('CA (as renegotiated)', versions=1)
        self.db.add('intake_documents', filer_id=1, outcome='filed', matter_id=MATTER, matter_document_id=doc['id'])
        self.filer(nb(1), nb(2, status='Mark-up', version_of=1))
        summary = self.run_it()
        self.assertEqual((summary['seen'], summary['next_versions']), (1, 1))
        self.assertEqual(self.db.rpc_calls[0][1]['p_document_id'], doc['id'])
        self.assertEqual((self.intake(2)['matter_document_id'], self.intake(2)['version_number']), (doc['id'], 2))

    def test_the_chain_is_followed_through_a_version_that_never_reached_the_hub(self):
        doc = self.hub_document('CA (as renegotiated)', versions=1)
        self.db.add('intake_documents', filer_id=1, outcome='filed', matter_id=MATTER, matter_document_id=doc['id'])
        self.db.add('intake_documents', filer_id=2, outcome='skipped')
        self.filer(nb(1), nb(2, version_of=1), nb(3, version_of=2))
        self.run_it()
        self.assertEqual(self.intake(3)['matter_document_id'], doc['id'])

    def test_two_versions_arriving_together_land_in_one_document_in_order(self):
        self.filer(nb(1, title='Escrow Agreement', status='Clean'), nb(2, title='Escrow Agreement', status='Mark-up', version_of=1))
        summary = self.run_it()
        self.assertEqual((summary['new_documents'], summary['next_versions']), (1, 1))
        self.assertEqual(len(self.db.rows('matter_documents')), 1)
        self.assertEqual([(self.intake(i)['version_number']) for i in (1, 2)], [1, 2])
        self.assertEqual(self.db.rows('matter_documents')[0]['status'], 'drafting')     # from the first file's "Clean"

    def test_a_close_title_goes_to_needs_a_look(self):
        doc = self.hub_document('Concession Agreement (Northern)', versions=1)
        row = nb(1)
        self.filer(row)
        summary = self.run_it()
        self.assertEqual((summary['trayed'], summary['filed']), (1, 0))
        self.assertEqual((self.graph.calls, self.db.rpc_calls, self.stored()), ([], [], []))
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['matter_id']), ('trayed', MATTER))
        self.assertIn('may be the next version', rec['reason'])
        item, = self.tray('document_unsure')
        self.assertEqual(item['payload'], {
            'intake_document_id': rec['id'], 'file': row['filed_name'], 'title': 'Concession Agreement',
            'transaction': 'Northern Bypass', 'code': 'NB', 'person': 'Sana Mirza', 'chat': 'TEAM GROUP',
            'date': '2026-10-17T12:00:15+00:00', 'web_url': row['web_url'], 'via': 'WhatsApp', 'matter_id': MATTER})
        self.assertEqual(item['guess'], {'document_id': doc['id'], 'document_title': doc['title'], 'confidence': '0.80'})
        # and it is not asked about again on the next run
        self.run_it()
        self.assertEqual(len(self.tray()), 1)

    def test_an_item_is_not_put_in_needs_a_look_twice_when_recording_it_failed(self):
        self.hub_document('Concession Agreement (Northern)', versions=1)
        self.filer(nb(1))
        self.db.fail_next('patch', 'intake_documents')       # the item went in; marking the document trayed failed
        self.db.fail_next('patch', 'intake_documents')       # ...and so did recording that failure
        self.assertEqual(self.run_it()['errors'], 1)
        self.assertEqual((len(self.tray('document_unsure')), self.intake(1)['outcome']), (1, 'pending'))
        self.run_it()
        self.assertEqual((len(self.tray('document_unsure')), self.intake(1)['outcome']), (1, 'trayed'))

    def test_numbers_must_agree_so_another_schedule_is_a_new_document(self):
        self.hub_document('Schedule 5', versions=1)
        self.filer(nb(1, title='Schedule 4'))
        summary = self.run_it()
        self.assertEqual((summary['new_documents'], summary['trayed']), (1, 0))

    def test_two_documents_with_the_same_title_are_not_guessed_between(self):
        self.hub_document('Concession Agreement', doc_id='doc-one')
        self.hub_document('Concession Agreement', doc_id='doc-two')
        self.filer(nb(1))
        summary = self.run_it()
        self.assertEqual((summary['trayed'], summary['filed']), (1, 0))
        self.assertIn('2 documents', self.intake(1)['reason'])

    def test_the_same_file_already_on_the_project_is_a_duplicate(self):
        row = nb(1)
        doc = self.hub_document('Something Else Entirely', versions=2, hashes=(None, row['sha256']))
        self.filer(row)
        summary = self.run_it()
        self.assertEqual((summary['duplicates'], summary['filed']), (1, 0))
        self.assertEqual((self.graph.calls, self.db.rpc_calls), ([], []))    # known from the Filer's hash: no download
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['matter_document_id'], rec['document_version_id']), ('duplicate', doc['id'], None))
        self.assertEqual(rec['reason'], 'already on the project: Something Else Entirely v2')
        self.assertEqual(self.actions(), [])

    def test_a_duplicate_is_also_caught_by_the_downloaded_bytes(self):
        row = nb(1)
        self.hub_document('Concession Agreement', versions=1, hashes=(hashlib.sha256(content(row)).hexdigest(),))
        self.filer(row)
        summary = self.run_it()
        self.assertEqual((summary['duplicates'], len(self.graph.calls), self.db.rpc_calls, self.stored()), (1, 1, [], []))

    def test_a_later_version_follows_a_duplicate_into_its_document(self):
        first = nb(1)
        doc = self.hub_document('CA (final form)', versions=1, hashes=(first['sha256'],))
        self.filer(first, nb(2, version_of=1))
        summary = self.run_it()
        self.assertEqual((summary['duplicates'], summary['next_versions']), (1, 1))
        self.assertEqual(self.intake(2)['matter_document_id'], doc['id'])


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

class ProjectTest(DocumentsCase):
    def test_a_document_waits_for_its_project_and_is_filed_once_it_exists(self):
        row = filed(1, code='HP', title='Lease Deed', transaction_name='Harbour Project')
        self.filer(row)
        first = self.run_it()
        self.assertEqual((first['waiting'], first['filed'], first['trayed']), (1, 0, 0))
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['reason']), ('trayed', 'waiting for a project (HP)'))
        self.assertEqual(self.tray(), [])                                    # not put in the tray one by one
        self.assertEqual(self.proposals, [{'name': 'Harbour Project', 'code': 'HP',
                                           'seen': {'where': row['filed_name'], 'person': 'Sana Mirza',
                                                    'date': '2026-10-17T12:00:15+00:00'}}])
        self.assertEqual(self.graph.calls, [])

        second = self.run_it()                                               # still no project: nothing changes
        self.assertEqual((second['still_waiting'], second['handled'], len(self.proposals)), (1, 0, 1))

        self.matcher.matters['HP'] = 'm-harbour'                             # the project was created
        third = self.run_it()
        self.assertEqual((third['filed'], third['new_documents']), (1, 1))
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['matter_id'], rec['version_number']), ('filed', 'm-harbour', 1))
        self.assertEqual(len(self.proposals), 1)
        self.assertEqual(self.db.rows('matter_documents')[0]['matter_id'], 'm-harbour')

    def test_a_project_that_appears_while_sharepoint_is_down_is_not_forgotten(self):
        self.filer(filed(1, code='HP', title='Lease Deed', transaction_name='Harbour Project'))
        self.run_it()
        self.matcher.matters['HP'] = 'm-harbour'
        self.graph.down = 503
        summary = self.run_it()
        self.assertEqual((summary['postponed'], summary['filed']), (1, 0))
        self.assertEqual((self.intake(1)['outcome'], self.intake(1)['attempts']), ('pending', 0))
        self.graph.down = None
        self.assertEqual(self.run_it()['filed'], 1)
        self.assertEqual(self.intake(1)['matter_id'], 'm-harbour')

    def test_trouble_proposing_the_project_is_not_the_documents_trouble(self):
        def broken(*a, **k):
            raise RuntimeError('the proposal could not be written')
        sys.modules['intake.projects'].propose_project = broken
        self.filer(filed(1, code='HP', title='Lease Deed', transaction_name='Harbour Project'), nb(2))
        summary = self.run_it()
        self.assertEqual((summary['waiting'], summary['filed'], summary['errors']), (1, 1, 0))
        self.assertEqual(self.intake(1)['reason'], 'waiting for a project (HP)')

    def test_a_code_nobody_knows_goes_to_needs_a_look(self):
        row = filed(1, code='ZZ', title='Lease Deed', transaction_name='Unheard Of Ltd')
        self.filer(row)
        summary = self.run_it()
        self.assertEqual((summary['trayed'], summary['waiting']), (1, 0))
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['reason']), ('trayed', 'no transaction is known for the code ZZ'))
        item, = self.tray('document_no_project')
        self.assertEqual(item['payload']['intake_document_id'], rec['id'])
        self.assertEqual((item['payload']['code'], item['payload']['transaction'], item['payload']['via']),
                         ('ZZ', 'Unheard Of Ltd', 'WhatsApp'))
        self.assertNotIn('matter_id', item['payload'])
        self.assertEqual(item['guess'], {'new_project': {'name': 'Unheard Of Ltd', 'client': '', 'code': 'ZZ'}})
        self.assertEqual(self.proposals, [])
        self.run_it()
        self.assertEqual(len(self.tray()), 1)

    def test_an_unknown_code_whose_name_is_a_known_project_is_guessed(self):
        self.filer(filed(1, code='ZZ', title='Lease Deed', transaction_name='Northern Bypass'))
        self.run_it()
        self.assertEqual(self.tray('document_no_project')[0]['guess'], {'matter_id': MATTER, 'confidence': '1.00'})


# ---------------------------------------------------------------------------
# Decisions made in Needs a look
# ---------------------------------------------------------------------------

class DecisionTest(DocumentsCase):
    def unsure(self):
        doc = self.hub_document('Concession Agreement (Northern)', versions=1)
        self.filer(nb(1))
        self.run_it()
        return doc, self.tray('document_unsure')[0]

    def decide(self, item, status='accepted', **resolution):
        item.update(status=status, resolution=resolution or None, resolved_at='2026-10-18T09:00:00+00:00')

    def test_yes_the_next_version(self):
        doc, item = self.unsure()
        self.decide(item, matter_id=MATTER, document_id=doc['id'])
        summary = self.run_it()
        self.assertEqual((summary['decisions'], summary['filed'], summary['next_versions']), (1, 1, 1))
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['matter_document_id'], rec['version_number']), ('filed', doc['id'], 2))
        self.assertEqual(item['resolution'], {'matter_id': MATTER, 'document_id': doc['id'], 'filed': True,
                                              'version_id': rec['document_version_id']})
        again = self.run_it()                                                # the decision is carried out once
        self.assertEqual((again['decisions'], len(self.versions(doc['id']))), (0, 2))

    def test_a_new_document(self):
        doc, item = self.unsure()
        self.decide(item, matter_id=MATTER, new_document=True)
        self.run_it()
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['version_number']), ('filed', 1))
        self.assertNotEqual(rec['matter_document_id'], doc['id'])
        self.assertTrue(item['resolution']['filed'])
        self.assertEqual(len(self.tray()), 1)                                # the close title is not asked about again

    def test_dropped(self):
        _, item = self.unsure()
        self.decide(item, status='dropped')
        summary = self.run_it()
        self.assertEqual((summary['skipped'], summary['filed']), (1, 0))
        self.assertEqual((self.intake(1)['outcome'], self.intake(1)['reason']), ('skipped', 'dropped by a person'))
        self.assertEqual(item['resolution'], {'filed': False})
        self.assertEqual((self.graph.calls, self.db.rpc_calls), ([], []))
        self.assertEqual(self.run_it()['skipped'], 0)

    def test_a_project_chosen_for_a_code_nobody_knows(self):
        self.filer(filed(1, code='ZZ', title='Lease Deed', transaction_name='Unheard Of Ltd'))
        self.run_it()
        item, = self.tray('document_no_project')
        self.decide(item, matter_id='m-harbour')
        summary = self.run_it()
        self.assertEqual((summary['decisions'], summary['filed']), (1, 1))
        self.assertEqual((self.intake(1)['outcome'], self.intake(1)['matter_id']), ('filed', 'm-harbour'))
        self.assertEqual(item['resolution']['version_id'], self.intake(1)['document_version_id'])

    def test_an_undone_filing_is_placed_again(self):
        self.filer(nb(1))
        self.run_it()
        rec = self.intake(1)
        old_path, old_doc = rec['storage_path'], rec['matter_document_id']
        # what public.undo_intake_action leaves behind
        for a in self.actions():
            a['undone_at'] = '2026-10-18T08:00:00+00:00'
        self.db.tables['document_versions'].clear()
        self.db.tables['matter_documents'].clear()
        self.db.tables['transaction_updates'].clear()
        rec.update(outcome='undone', matter_document_id=None, document_version_id=None, version_number=None, row_id=None,
                   reason='undone by a person')
        self.db.add('intake_tray', kind='document_undone', payload={'intake_document_id': rec['id'], 'was_matter_id': MATTER})
        item = self.db.tables['intake_tray'][-1]
        self.assertEqual(self.run_it()['handled'], 0)                        # nothing moves it until a person decides
        self.decide(item, matter_id='m-harbour')
        summary = self.run_it()
        self.assertEqual((summary['decisions'], summary['filed']), (1, 1))
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['matter_id'], rec['version_number']), ('filed', 'm-harbour', 1))
        self.assertNotEqual(rec['storage_path'], old_path)
        self.assertNotEqual(rec['matter_document_id'], old_doc)
        self.assertIn('matter-documents/' + old_path, self.db.storage)       # the undone file stays in storage
        self.assertEqual(self.db.removed, [])
        self.assertTrue(item['resolution']['filed'])
        self.assertEqual(len([a for a in self.actions('version_filed') if a['undone_at'] is None]), 1)

    def test_the_file_an_undo_left_in_storage_is_never_cleared_by_a_failed_replacing(self):
        row = nb(1)
        self.filer(row)
        self.run_it()
        rec = self.intake(1)
        old_path = rec['storage_path']
        for a in self.actions():
            a['undone_at'] = '2026-10-18T08:00:00+00:00'
        self.db.tables['document_versions'].clear()
        self.db.tables['matter_documents'].clear()
        self.db.tables['transaction_updates'].clear()
        rec.update(outcome='undone', matter_document_id=None, document_version_id=None, version_number=None, row_id=None)
        item = self.db.add('intake_tray', kind='document_undone', payload={'intake_document_id': rec['id']})
        item = self.db.tables['intake_tray'][-1]
        self.decide(item, matter_id=MATTER)
        del self.graph.files[rel(row)]                                       # SharePoint no longer has it at that path
        for n in (1, 2):
            self.assertEqual(self.run_it()['not_found'], 1)
            self.assertEqual((self.intake(1)['outcome'], self.intake(1)['attempts']), ('undone', n))
        self.assertEqual(self.db.removed, [])
        self.assertIn('matter-documents/' + old_path, self.db.storage)
        self.graph.files[rel(row)] = content(row)
        self.assertEqual(self.run_it()['filed'], 1)
        self.assertEqual(self.db.removed, [])
        self.assertIn('matter-documents/' + old_path, self.db.storage)
        self.assertTrue(item['resolution']['filed'])

    def test_a_decision_that_cannot_be_carried_out_is_closed_with_its_reason(self):
        _, item = self.unsure()
        self.decide(item, matter_id=MATTER, document_id='doc-that-was-removed')
        for n in range(1, 6):
            self.run_it()
            self.assertEqual(self.intake(1)['attempts'], n)
        self.assertEqual(item['resolution']['filed'], False)
        self.assertIn('no longer on that project', item['resolution']['reason'])
        self.assertEqual(self.intake(1)['outcome'], 'error')
        self.assertEqual(self.run_it()['decisions'], 0)


# ---------------------------------------------------------------------------
# Trouble
# ---------------------------------------------------------------------------

class TroubleTest(DocumentsCase):
    def test_a_missing_file_is_tried_five_times_then_given_up(self):
        self.filer(nb(1), on_sharepoint=False)
        for n in range(1, 5):
            summary = self.run_it()
            self.assertEqual((summary['not_found'], summary['filed'], summary['errors']), (1, 0, 0))
            rec = self.intake(1)
            self.assertEqual((rec['outcome'], rec['attempts']), ('pending', n))
            self.assertIn('not found on SharePoint', rec['reason'])
        self.run_it()
        self.assertEqual((self.intake(1)['outcome'], self.intake(1)['attempts']), ('error', 5))
        self.assertIsNotNone(self.intake(1)['handled_at'])
        self.assertEqual(self.run_it()['handled'], 0)                        # given up: not tried a sixth time
        self.assertEqual(len(self.graph.calls), 5)
        self.assertEqual((self.db.rpc_calls, self.stored()), ([], []))

    def test_a_file_the_filer_renamed_is_found_on_a_later_run(self):
        row = nb(1)
        self.filer(row, on_sharepoint=False)
        self.run_it()
        self.run_it()
        self.assertEqual(self.intake(1)['attempts'], 2)
        # the Filer's tool renames the file and rewrites its own row
        row['filed_name'] = 'NB-A7 - Concession Agreement [AKLA][Draft][October 17, 2026].docx'
        self.filer_rows = []
        self.filer(row)
        summary = self.run_it()
        self.assertEqual(summary['filed'], 1)
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['filed_name'], rec['attempts']), ('filed', row['filed_name'], 2))
        self.assertEqual(self.graph.calls[-1], rel(row))

    def test_one_bad_document_does_not_stop_the_rest(self):
        bad = nb(2, title='Escrow Agreement')
        bad['filed_name'] = 'NB-A2 - Escrow Agreement [AKLA][Draft][October 17, 2026]'        # no extension
        self.filer(nb(1), bad, nb(3, title='Side Letter'))
        self.graph.files.pop(rel(nb(3, title='Side Letter')))                                 # and one is missing
        summary = self.run_it()
        self.assertEqual((summary['filed'], summary['errors'], summary['not_found']), (1, 1, 1))
        self.assertEqual([self.intake(i)['outcome'] for i in (1, 2, 3)], ['filed', 'error', 'pending'])
        self.assertIn('no extension', self.intake(2)['reason'])
        self.assertTrue(self.db.rows('intake_runs')[0]['ok'])

    def test_sharepoint_being_down_costs_no_document_an_attempt(self):
        self.filer(nb(1), nb(2, title='Escrow Agreement'))
        self.graph.down = 503
        summary = self.run_it()
        self.assertEqual((summary['postponed'], summary['errors'], summary['not_found'], summary['filed']), (2, 0, 0, 0))
        self.assertEqual(len(self.graph.calls), 1)                           # it stopped asking after the first refusal
        self.assertEqual([(self.intake(i)['outcome'], self.intake(i)['attempts']) for i in (1, 2)],
                         [('pending', 0), ('pending', 0)])
        self.graph.down = None
        self.assertEqual(self.run_it()['filed'], 2)

    def test_one_file_sharepoint_will_not_give_is_that_files_trouble_alone(self):
        locked, slow = nb(1), nb(2, title='Escrow Agreement')
        self.filer(locked, slow, nb(3, title='Side Letter'))
        self.graph.broken = {rel(locked): GraphError(423, 'GET ... -> the file is locked'), rel(slow): TimeoutError('timed out')}
        summary = self.run_it()
        self.assertEqual((summary['errors'], summary['postponed'], summary['filed']), (2, 0, 1))
        self.assertEqual([(self.intake(i)['outcome'], self.intake(i)['attempts']) for i in (1, 2, 3)],
                         [('error', 1), ('error', 1), ('filed', 0)])
        self.assertIn('423', self.intake(1)['reason'])
        self.assertIn('could not be downloaded', self.intake(2)['reason'])
        self.graph.broken = {}
        self.assertEqual(self.run_it()['filed'], 2)

    def test_a_later_version_waits_while_the_earlier_one_cannot_be_fetched(self):
        first, second = nb(1), nb(2, status='Mark-up', version_of=1)
        self.filer(first, second)
        del self.graph.files[rel(first)]
        summary = self.run_it()
        self.assertEqual((summary['not_found'], summary['postponed'], summary['filed']), (1, 1, 0))
        self.assertEqual((self.intake(2)['outcome'], self.intake(2)['attempts']), ('pending', 0))
        self.assertIn('filer:1', self.intake(2)['reason'])
        self.graph.files[rel(first)] = content(first)
        summary = self.run_it()
        self.assertEqual((summary['new_documents'], summary['next_versions']), (1, 1))
        self.assertEqual([self.intake(i)['version_number'] for i in (1, 2)], [1, 2])

    def test_the_save_failing_takes_the_upload_back(self):
        self.filer(nb(1))
        self.db.rpc_mode = 'fail'
        summary = self.run_it()
        self.assertEqual((summary['errors'], summary['filed']), (1, 0))
        path = self.db.rpc_calls[0][1]['p_storage_path']
        self.assertEqual(self.stored(), [])                                  # no file left without a version
        self.assertEqual(self.db.removed, [path])
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['attempts'], rec['document_version_id']), ('error', 1, None))
        self.assertIn('could not save the version', rec['reason'])
        self.assertEqual((self.versions(), self.actions(), self.db.rows('transaction_updates')), ([], [], []))

        self.db.rpc_mode = 'ok'                                              # the next run files it, once
        self.assertEqual(self.run_it()['filed'], 1)
        self.assertEqual((len(self.versions()), len(self.stored()), self.intake(1)['attempts']), (1, 1, 1))
        self.assertNotEqual(self.intake(1)['storage_path'], path)

    def test_a_save_that_went_through_unseen_is_recognised_not_repeated(self):
        self.filer(nb(1))
        self.db.rpc_mode = 'lost'                                            # committed, but the answer never arrives
        summary = self.run_it()
        self.assertEqual((summary['filed'], summary['errors']), (1, 0))
        version, = self.versions()
        self.assertEqual(self.db.removed, [])                                # the file a version points at is never removed
        self.assertEqual(self.stored(), ['matter-documents/' + version['storage_path']])
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['document_version_id'], rec['version_number']), ('filed', version['id'], 1))
        self.assertEqual(version['content_hash'], hashlib.sha256(content(nb(1))).hexdigest())
        self.assertEqual(len(self.actions('version_filed')), 1)

    def test_when_even_the_lookup_fails_the_next_run_finishes_the_same_save(self):
        self.filer(nb(1, status='Final'))
        self.db.rpc_mode = 'lost'
        self.db.fail_next('select', 'document_versions')                     # the lookup after the lost answer fails too
        summary = self.run_it()
        self.assertEqual((summary['errors'], summary['filed']), (1, 0))
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['attempts']), ('error', 1))
        self.assertIn('could not confirm', rec['reason'])
        self.assertIsNotNone(rec['storage_path'])                            # written down before the upload
        self.assertEqual((len(self.stored()), self.db.removed), (1, []))     # left in place: a version may point at it
        self.assertEqual(self.actions(), [])

        self.db.rpc_mode = 'ok'
        summary = self.run_it()
        self.assertEqual((summary['filed'], summary['new_documents']), (1, 1))
        self.assertEqual((len(self.db.rpc_calls), len(self.graph.calls)), (1, 1))     # not saved or fetched again
        version, = self.versions()
        rec = self.intake(1)
        self.assertEqual((rec['outcome'], rec['document_version_id'], rec['row_id']), ('filed', version['id'], 'row-ca'))
        self.assertEqual(self.db.rows('matter_documents')[0]['status'], 'finalized')
        filing, = self.actions('version_filed')
        self.assertTrue(filing['detail']['created_document'])
        self.assertEqual(filing['group_id'], self.actions('row_update')[0]['group_id'])
        self.assertEqual(len(self.db.rows('transaction_updates')), 1)

    def test_an_upload_left_behind_by_a_run_that_died_is_taken_back_before_filing_again(self):
        row = nb(1)
        self.filer(row)
        # what a run killed between the upload and the save leaves: the path written down, the file
        # in storage, no version
        left = f'{MATTER}/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222-NB-A1.docx'
        self.db.storage['matter-documents/' + left] = content(row)
        self.db.add('intake_documents', filer_id=1, outcome='pending', matter_id=MATTER, storage_path=left,
                    **{k: row[k] for k in ('sha256', 'filed_name', 'folder', 'web_url', 'code')},
                    title='Concession Agreement', doc_status='Draft')
        summary = self.run_it()
        self.assertEqual(summary['filed'], 1)
        self.assertEqual(self.db.removed, [left])
        version, = self.versions()
        self.assertEqual(self.stored(), ['matter-documents/' + version['storage_path']])
        self.assertEqual(self.intake(1)['storage_path'], version['storage_path'])

    def test_when_the_hub_will_not_even_record_failures_the_run_stops(self):
        self.filer(*[nb(i, title=f'Schedule {i}') for i in range(1, 6)], on_sharepoint=False)
        for _ in range(3):
            self.db.fail_next('patch', 'intake_documents')
        with self.assertRaises(RuntimeError):
            self.run_it()
        self.assertEqual(len(self.graph.calls), 3)                           # it did not go on to the other two
        run, = self.db.rows('intake_runs')
        self.assertEqual(run['ok'], False)
        self.assertIn('not taking writes', run['error'])

    def test_a_filing_whose_record_could_not_be_closed_is_not_logged_twice(self):
        self.filer(nb(1))
        self.db.failing.append(('insert', 'intake_actions', DbError('insert intake_actions -> 503')))   # the row line's entry
        self.db.failing.append(('insert', 'intake_actions', DbError('insert intake_actions -> 503')))   # the filing's entry
        summary = self.run_it()
        self.assertEqual(summary['errors'], 1)
        self.assertEqual((len(self.versions()), self.intake(1)['outcome']), (1, 'error'))
        self.assertEqual(len(self.db.rows('transaction_updates')), 1)        # the line went in; its entry did not
        summary = self.run_it()
        self.assertEqual(summary['filed'], 1)
        self.assertEqual((len(self.versions()), len(self.db.rpc_calls)), (1, 1))
        self.assertEqual(len(self.db.rows('transaction_updates')), 1)        # no second line
        line, = self.actions('row_update')
        filing, = self.actions('version_filed')
        self.assertEqual((line['update_id'], line['group_id']), (self.db.rows('transaction_updates')[0]['id'], filing['group_id']))
        self.assertEqual(self.intake(1)['outcome'], 'filed')

    def test_someone_filing_at_the_same_moment_is_an_error_to_retry_not_an_overwrite(self):
        doc = self.hub_document('Concession Agreement', versions=1)
        self.filer(nb(1))
        real_upload = self.db.storage_upload

        def upload_then_a_person_files(bucket, path, data, content_type='x'):
            real_upload(bucket, path, data, content_type)
            self.db.add('document_versions', matter_document_id=doc['id'], version_number=2, storage_path='p/2.docx',
                        file_name='x-v2.docx', content_hash=None)
        with mock.patch.object(self.db, 'storage_upload', upload_then_a_person_files):
            summary = self.run_it()
        self.assertEqual((summary['errors'], self.stored()), (1, []))
        self.assertIn('newer version', self.intake(1)['reason'])
        self.assertEqual(self.run_it()['next_versions'], 1)
        self.assertEqual(self.intake(1)['version_number'], 3)

    def test_the_filers_record_missing_is_reported_not_raised(self):
        summary = documents.run_documents(self.db, filer_db=os.path.join(self.dir, 'nowhere.sqlite'),
                                          graph=self.graph, matcher=self.matcher)
        self.assertIn('was not found', summary['error'])
        run, = self.db.rows('intake_runs')
        self.assertEqual((run['kind'], run['ok']), ('documents', False))
        self.assertIn('was not found', run['error'])

    def test_a_row_withdrawn_by_the_filer_is_skipped(self):
        self.filer(nb(1), on_sharepoint=False)
        self.run_it()
        self.filer_rows = []
        self.filer(nb(1, action='duplicate', web_url=None))
        summary = self.run_it()
        self.assertEqual(summary['skipped'], 1)
        self.assertEqual(self.intake(1)['outcome'], 'skipped')


# ---------------------------------------------------------------------------
# Switches
# ---------------------------------------------------------------------------

class SwitchTest(DocumentsCase):
    def test_no_hub_intake_account_files_nothing_but_records_what_was_seen(self):
        self.db.tables['profiles'] = [p for p in self.db.rows('profiles') if p['full_name'] != 'Hub Intake']
        self.filer(nb(1), nb(2, title='Escrow Agreement'), nb(3, title='Side Letter'))
        summary = self.run_it(limit=2)
        self.assertEqual(summary['note'], "The Hub has no 'Hub Intake' account yet, so nothing can be filed. "
                                          'See intake-service/README.md.')
        said = [l for l in self.out.getvalue().splitlines() if l[20:].startswith("The Hub has no 'Hub Intake' account")]
        self.assertEqual(len(said), 1)                                       # one clear line
        self.assertEqual((summary['seen'], summary['pending'], summary['filed']), (3, 3, 0))
        self.assertEqual((self.graph.calls, self.db.rpc_calls, self.stored(), self.tray()), ([], [], [], []))
        self.assertEqual([(r['filer_id'], r['outcome'], r['attempts']) for r in self.db.rows('intake_documents')],
                         [(1, 'pending', 0), (2, 'pending', 0), (3, 'pending', 0)])
        self.assertEqual(self.intake(2)['title'], 'Escrow Agreement')

        # the account is made: what waited is filed, oldest first, `limit` a run
        self.db.add('profiles', id=USER, full_name='Hub Intake', status='approved')
        summary = self.run_it(limit=2)
        self.assertEqual((summary['filed'], summary['left'], summary['seen']), (2, 1, 0))
        self.assertEqual([self.intake(i)['outcome'] for i in (1, 2, 3)], ['filed', 'filed', 'pending'])
        self.assertEqual(self.run_it(limit=2)['filed'], 1)

    def test_an_account_that_is_not_approved_does_not_count(self):
        self.db.rows('profiles')[0]['status'] = 'pending'
        self.filer(nb(1))
        self.assertEqual(self.run_it()['filed'], 0)
        self.assertEqual(self.db.rpc_calls, [])

    def test_file_documents_off_does_nothing_and_says_so(self):
        self.setting('file_documents', False)
        self.filer(nb(1))
        os.remove(self.filer_db)                                             # not even the Filer's record is opened
        summary = self.run_it()
        self.assertIn('switched off', summary['note'])
        self.assertIn('switched off', self.out.getvalue())
        self.assertEqual((summary['seen'], summary['filed'], summary['error']), (0, 0, None))
        self.assertEqual((self.db.writes, self.graph.calls), ([], []))

    def test_the_limit_takes_the_oldest_and_leaves_the_rest_for_the_next_run(self):
        self.filer(*[nb(i, title=f'Schedule {i}') for i in (5, 3, 9, 7)])
        summary = self.run_it(limit=3)
        self.assertEqual((summary['seen'], summary['handled'], summary['filed'], summary['left']), (4, 3, 3, 1))
        self.assertEqual(sorted(r['filer_id'] for r in self.db.rows('intake_documents')), [3, 5, 7])
        self.assertEqual(self.run_it(limit=3)['filed'], 1)
        self.assertEqual(documents.DEFAULT_LIMIT, 25)

    def test_documents_move_rows_off_files_without_a_line(self):
        self.setting('documents_move_rows', False)
        self.filer(nb(1))
        summary = self.run_it()
        self.assertEqual((summary['filed'], summary['row_lines']), (1, 0))
        self.assertEqual((self.db.rows('transaction_updates'), self.actions('row_update')), ([], []))
        self.assertIsNone(self.intake(1)['row_id'])
        self.assertEqual(len(self.actions('version_filed')), 1)

    def test_no_sure_row_means_no_line_and_nothing_in_the_tray(self):
        self.filer(nb(1, title='Board Resolution'))
        summary = self.run_it()
        self.assertEqual((summary['filed'], summary['row_lines']), (1, 0))
        self.assertEqual((self.db.rows('transaction_updates'), self.tray()), ([], []))
        self.assertIsNone(self.intake(1)['row_id'])


class RowLineTest(DocumentsCase):
    OUTSIDER = 'Tariq Aziz (999000111000)'

    def test_wording_for_a_firm_person_and_for_an_outside_sender(self):
        inside = nb(1, status='Mark-up')
        outside = nb(2, title='Escrow Agreement', status='Comments', sender=self.OUTSIDER)
        self.filer(inside, outside)
        self.run_it()
        first, second = self.db.rows('transaction_updates')
        self.assertEqual(first['body'], f"Mark-up sent by Sana Mirza (TEAM GROUP): {inside['filed_name']}")
        self.assertEqual((first['author'], first['author_id'], first['source']), ('Sana', 'u-sana', 'whatsapp'))
        self.assertEqual(second['body'], f"Comments received from Tariq Aziz by WhatsApp: {outside['filed_name']}")
        self.assertEqual((second['author'], second['author_id'], second['row_id']), (None, None, 'row-ea'))
        self.assertEqual((self.intake(2)['sender'], self.intake(2)['sender_id']), ('Tariq Aziz', None))
        self.assertNotIn('999000111000', str(self.db.tables))                # the number goes nowhere in the Hub
        self.assertEqual(self.db.rpc_calls[1][1]['p_label'], 'From WhatsApp (TEAM GROUP) · Tariq Aziz · 17 Oct 2026')

    def test_wording_for_email(self):
        received = nb(1, status='Comments', chat='Outlook - team@example.com (Inbox)',
                      sender='Tariq Aziz <tariq@roadsco.example>', caption='RE: Concession Agreement')
        sent = nb(2, title='Escrow Agreement', status='Clean', chat='Outlook - team@example.com (Sent)',
                  sender='Bilal Chaudhry', caption='Escrow Agreement')
        colleague = nb(3, title='Side Letter', chat='Outlook - team@example.com (Inbox)', sender='Someone New <new@example.com>')
        self.filer(received, sent, colleague)
        self.run_it()
        first, second = self.db.rows('transaction_updates')
        self.assertEqual(first['body'], f"Comments received from Tariq Aziz by email: {received['filed_name']}")
        self.assertEqual((first['source'], first['author']), ('email', None))
        self.assertEqual(second['body'], f"Clean sent by Bilal Chaudhry (email): {sent['filed_name']}")
        self.assertEqual((second['author'], second['author_id']), ('Bilal', 'u-bilal'))
        labels = [args['p_label'] for _, args in self.db.rpc_calls]
        self.assertEqual(labels[:2], ['From email · Tariq Aziz · 17 Oct 2026', 'From email · Bilal Chaudhry · 17 Oct 2026'])
        rec = self.intake(1)
        self.assertEqual((rec['source'], rec['mailbox'], rec['direction'], rec['caption']),
                         ('email', 'team@example.com', 'inbox', 'RE: Concession Agreement'))
        self.assertEqual(self.intake(2)['direction'], 'sent')
        filing = self.actions('version_filed')[0]
        self.assertEqual((filing['source'], filing['detail']['via']), ('email', 'email'))
        # an address on the mailbox's own domain is the firm's, whoever it is
        self.assertTrue(documents._who(mock.Mock(firm={}, matcher=self.matcher), {
            'source': 'email', 'direction': 'inbox', 'mailbox': 'team@example.com', 'sender_email': 'new@example.com',
            'sender_name': 'Someone New', 'sender': 'Someone New <new@example.com>'})['firm'])

    def test_who_is_a_firm_person(self):
        run = mock.Mock(firm={'sana mirza': ('Sana Mirza', 'u-sana'), 'bilal chaudhry': ('Bilal Chaudhry', 'u-bilal'),
                              'ahmed ali khan': ('Ahmed Ali Khan', 'u-ahmed')}, matcher=self.matcher)
        who = lambda sender, saved=True: documents._who(run, {
            'source': 'whatsapp', 'sender': sender, 'sender_saved': saved,
            'sender_name': re.sub(r'\s*(AKLA|\(\d+\))$', '', sender)})
        self.assertEqual(who('Sana Mirza'), {'name': 'Sana Mirza', 'full': 'Sana Mirza', 'first': 'Sana', 'firm': True, 'id': 'u-sana'})
        self.assertEqual(who('Bilal')['id'], 'u-bilal')                       # a known short form
        self.assertEqual(who('Ahmed Khan')['full'], 'Ahmed Ali Khan')         # the words of one full name
        self.assertEqual(who('Bilal Senior Counsel AKLA')['id'], 'u-bilal')   # the phone labels the contact AKLA
        newcomer = who('Zoya Trainee AKLA')
        self.assertEqual((newcomer['firm'], newcomer['id'], newcomer['first']), (True, None, 'Zoya'))
        # never by a shared first name alone, and never a number the Filer's phone has not saved
        self.assertFalse(who('Sana Qadir')['firm'])
        self.assertFalse(who('Ahmed Raza')['firm'])
        # an unsaved number whose push name is a staff first name is that person
        self.assertEqual(who('Bilal (999000111000)', saved=False)['full'], 'Bilal Chaudhry')
        self.assertTrue(who('Sana Mirza (999000111000)', saved=False)['firm'])   # unless the whole name is a profile's
        self.assertEqual(who('')['first'], '')

    def test_the_sentence(self):
        line = documents.row_line
        firm = {'firm': True, 'first': 'Sana', 'name': 'Sana', 'full': 'Sana Mirza'}
        outside = {'firm': False, 'first': 'Tariq', 'name': 'Tariq Aziz'}
        self.assertEqual(line('Final', firm, 'whatsapp', 'TEAM GROUP', 'f.docx'), 'Final sent by Sana Mirza (TEAM GROUP): f.docx')
        self.assertEqual(line('Final', firm, 'email', 'Outlook - x (Sent)', 'f.docx'), 'Final sent by Sana Mirza (email): f.docx')
        self.assertEqual(line('Received', outside, 'email', None, 'f.pdf'), 'Received received from Tariq Aziz by email: f.pdf')
        self.assertEqual(line(None, outside, 'whatsapp', 'G', 'f.pdf'), 'Document received from Tariq Aziz by WhatsApp: f.pdf')
        self.assertEqual(line('Draft', {'firm': False, 'name': ''}, 'whatsapp', 'G', 'f.pdf'), 'Draft received by WhatsApp: f.pdf')

    def test_set_status_off_never_moves_a_row(self):
        self.filer(nb(1, status='Comments', sender=self.OUTSIDER))
        self.run_it()
        row = self.db.one('transaction_rows', {'id': 'eq.row-ca'})
        self.assertEqual(row['status'], 'With Client')
        self.assertEqual((len(self.actions('row_update')), self.actions('row_moved')), (1, []))

    def test_set_status_on_brings_a_row_back_when_an_outsider_sends(self):
        self.setting('documents_set_status', True)
        self.filer(nb(1, status='Comments', sender=self.OUTSIDER))
        self.run_it()
        row = self.db.one('transaction_rows', {'id': 'eq.row-ca'})
        self.assertEqual((row['status'], row['updated_source']), ('With Client And AKLA', 'whatsapp'))
        moved, = self.actions('row_moved')
        self.assertEqual((moved['before'], moved['after']), ({'status': 'With Client'}, {'status': 'With Client And AKLA'}))
        self.assertEqual(moved['group_id'], self.actions('version_filed')[0]['group_id'])
        self.assertEqual(self.actions('row_update'), [])

    def test_set_status_on_changes_nothing_else(self):
        self.setting('documents_set_status', True)
        self.db.rows('transaction_rows')[1]['status'] = 'With Counterparty'
        self.filer(nb(1, status='Mark-up'),                                              # a firm person, row With Client
                   nb(2, title='Escrow Agreement', sender=self.OUTSIDER),                # an outsider, row With Counterparty
                   nb(3, title='Escrow Agreement', status='Final', sender=self.OUTSIDER, version_of=2))   # by now With Client And AKLA
        self.run_it()
        self.assertEqual(self.db.one('transaction_rows', {'id': 'eq.row-ca'})['status'], 'With Client')
        self.assertEqual(self.db.one('transaction_rows', {'id': 'eq.row-ea'})['status'], 'With Client And AKLA')
        self.assertEqual((len(self.actions('row_moved')), len(self.actions('row_update'))), (1, 2))


# ---------------------------------------------------------------------------
# A dry run
# ---------------------------------------------------------------------------

class DryRunTest(DocumentsCase):
    def test_reads_everything_writes_nothing_and_says_what_would_happen(self):
        existing = self.hub_document('Escrow Agreement', versions=2)
        self.hub_document('Guarantee for the Northern Section', versions=1)
        known = nb(6, title='Side Letter')
        self.hub_document('Old Letter', versions=1, hashes=(known['sha256'],))
        self.filer(nb(1, status='Mark-up'),                                              # new document, a row line
                   nb(2, title='Escrow Agreement', sender='Tariq Aziz (999000111000)'),  # the next version
                   nb(3, status='Final', version_of=1),                                  # v2 of the one planned above
                   nb(4, title='Guarantee for the Northern Section Works'),              # close: Needs a look
                   filed(5, code='HP', title='Lease Deed', transaction_name='Harbour Project'),   # no project yet
                   known,                                                                # already on the project
                   nb(7, title='Board Resolution'))                                      # new document, no row
        before = {t: [dict(r) for r in rows] for t, rows in self.db.tables.items()}
        summary = self.run_it(dry_run=True)

        self.assertEqual(self.db.writes, [])
        self.assertEqual({t: rows for t, rows in self.db.tables.items() if rows}, {t: rows for t, rows in before.items() if rows})
        self.assertEqual((self.graph.calls, self.stored(), self.proposals), ([], [], []))
        self.assertTrue(summary['dry_run'])
        self.assertEqual((summary['seen'], summary['filed'], summary['new_documents'], summary['next_versions']), (7, 4, 2, 2))
        self.assertEqual((summary['trayed'], summary['waiting'], summary['duplicates'], summary['row_lines']), (1, 1, 1, 3))

        lines = [l for l in self.out.getvalue().splitlines() if ' filer:' in l]
        self.assertEqual(len(lines), 7)                                       # one line per document
        said = {int(re.search(r' filer:(\d+)  ', l).group(1)): l for l in lines}
        self.assertIn("would file in Northern Bypass: new document 'Concession Agreement', v1; row line on "
                      "'Concession Agreement': Mark-up sent by Sana Mirza (TEAM GROUP): NB-A1 - Concession Agreement", said[1])
        self.assertIn("would file in Northern Bypass: 'Escrow Agreement', v3; row line on 'Escrow Agreement': "
                      'Draft received from Tariq Aziz by WhatsApp', said[2])
        self.assertIn("would file in Northern Bypass: 'Concession Agreement', v2", said[3])
        self.assertIn("Needs a look in Northern Bypass: may be the next version of 'Guarantee for the Northern Section'", said[4])
        self.assertIn('waiting for a project (HP)', said[5])
        self.assertIn('already on the project: Old Letter v1; nothing to file', said[6])
        self.assertIn("new document 'Board Resolution', v1; no row", said[7])
        self.assertEqual(existing['id'], 'doc-escrow-agreement')

    def test_a_dry_run_without_the_account_still_shows_the_plan(self):
        self.db.tables['profiles'] = [p for p in self.db.rows('profiles') if p['full_name'] != 'Hub Intake']
        self.filer(nb(1))
        summary = self.run_it(dry_run=True)
        self.assertIn("no 'Hub Intake' account", summary['note'])
        self.assertEqual((summary['filed'], self.db.writes), (1, []))

    def test_a_db_that_is_itself_dry_is_treated_as_a_dry_run(self):
        self.db.dry_run = True
        self.filer(nb(1))
        summary = self.run_it()
        self.assertTrue(summary['dry_run'])
        self.assertEqual((self.db.writes, self.graph.calls), ([], []))

    def test_set_status_shows_in_the_plan(self):
        self.setting('documents_set_status', True)
        self.filer(nb(1, sender='Tariq Aziz (999000111000)'))
        self.run_it(dry_run=True)
        self.assertIn('(status to With Client And AKLA)', self.out.getvalue())
        self.assertEqual(self.db.one('transaction_rows', {'id': 'eq.row-ca'})['status'], 'With Client')


# ---------------------------------------------------------------------------
# hubdocs on its own
# ---------------------------------------------------------------------------

class HubDocsTest(unittest.TestCase):
    def test_storage_stem_and_path(self):
        stem = hubdocs.storage_stem
        self.assertEqual(stem('NB-A1 - Concession Agreement [AKLA][Mark-up][October 17, 2026]'),
                         'NB-A1-Concession-Agreement-AKLA-Mark-up-October-17-2026')
        self.assertEqual(stem("Licence & IE Agreements (Site's) – Annex"), 'Licence-IE-Agreements-Site-s-Annex')
        self.assertEqual(stem('  [][]  '), 'file')
        self.assertLessEqual(len(stem('Word ' * 100)), 180)
        self.assertFalse(stem('Word ' * 100).endswith('-'))
        self.assertEqual(hubdocs.split_name('A Deed.PDF'), ('A-Deed', 'pdf'))
        with self.assertRaises(hubdocs.FilingError):
            hubdocs.split_name('no extension')
        path = hubdocs.storage_path('m1', 'd1', 'A Deed.pdf')
        self.assertRegex(path, r'^m1/d1/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}-A-Deed\.pdf$')
        self.assertNotEqual(path, hubdocs.storage_path('m1', 'd1', 'A Deed.pdf'))

    def test_label(self):
        from datetime import datetime, timezone
        from zoneinfo import ZoneInfo
        late = datetime(2026, 10, 17, 20, 30, tzinfo=timezone.utc)            # already the 18th in Karachi
        self.assertEqual(hubdocs.source_label('whatsapp', 'TEAM GROUP', 'Sana', late, ZoneInfo('Asia/Karachi')),
                         'From WhatsApp (TEAM GROUP) · Sana · 18 Oct 2026')
        self.assertEqual(hubdocs.source_label('email', 'Outlook - x (Inbox)', 'Tariq Aziz', late), 'From email · Tariq Aziz · 17 Oct 2026')
        self.assertEqual(hubdocs.source_label('email', None, '', None), 'From email')
        self.assertLessEqual(len(hubdocs.source_label('whatsapp', 'G' * 300, 'Sana', late)), 200)

    def test_document_types_match_by_normalised_name(self):
        db = FakeDb()
        db.add('document_types', id='t1', name="Shareholders' Agreement")
        db.add('document_types', id='t2', name='Term Sheet')
        kinds = hubdocs.load_document_types(db)
        self.assertEqual(hubdocs.document_type_id(kinds, 'Shareholders Agreement'), 't1')
        self.assertEqual(hubdocs.document_type_id(kinds, 'term  sheet'), 't2')
        self.assertIsNone(hubdocs.document_type_id(kinds, 'Agreement'))
        self.assertIsNone(hubdocs.document_type_id(kinds, None))

    def test_select_all_reads_past_the_api_row_limit(self):
        db = FakeDb()
        db.max_rows = 4
        for n in range(11):
            db.add('intake_documents', filer_id=n + 1)
        self.assertEqual(len(db.select('intake_documents', {})), 4)           # what a plain select would see
        rows = hubdocs.select_all(db, 'intake_documents', {}, 'filer_id', key='filer_id')
        self.assertEqual([r['filer_id'] for r in rows], list(range(1, 12)))

    def test_project_documents_and_duplicates(self):
        db = FakeDb()
        db.add('matter_documents', id='d1', matter_id='m1', title='A', document_type_id=None, status='drafting')
        db.add('matter_documents', id='d2', matter_id='m2', title='B', document_type_id=None, status='drafting')
        db.add('document_versions', matter_document_id='d1', version_number=2, content_hash='BB', storage_path='p2')
        db.add('document_versions', matter_document_id='d1', version_number=1, content_hash='aa', storage_path='p1')
        db.add('document_versions', matter_document_id='d2', version_number=1, content_hash='cc', storage_path='p3')
        docs = hubdocs.project_documents(db, 'm1')
        self.assertEqual([d['id'] for d in docs], ['d1'])
        self.assertEqual([v['version_number'] for v in docs[0]['versions']], [1, 2])
        self.assertEqual((docs[0]['latest']['version_number'], hubdocs.next_version_number(docs[0])), (2, 3))
        self.assertEqual(hubdocs.next_version_number(None), 1)
        self.assertEqual(hubdocs.find_by_hash(docs, 'bb')[1]['version_number'], 2)
        self.assertIsNone(hubdocs.find_by_hash(docs, 'cc'))                   # on another project
        self.assertIsNone(hubdocs.find_by_hash(docs, None, ''))

    def test_file_version_refuses_before_it_uploads(self):
        db = FakeDb()
        base = dict(user_id=USER, matter_id='m1', title='A Deed', file_name='A Deed.pdf', data=b'x')
        for change, said in ((dict(user_id=None), 'Hub Intake'), (dict(data=b''), 'empty'), (dict(title='  '), 'no title'),
                             (dict(file_name='A Deed'), 'no extension'),
                             (dict(document={'id': 'gone'}), 'no longer on the project')):
            with self.assertRaises(hubdocs.FilingError) as caught:
                hubdocs.file_version(db, **dict(base, **change))
            self.assertIn(said, str(caught.exception))
        self.assertEqual((db.writes, db.storage), ([], {}))


if __name__ == '__main__':
    unittest.main()


class FirmMemberTest(unittest.TestCase):
    """A WhatsApp contact is shown by the staff list's name when the sender is one of the firm."""
    FIRM = {n.lower(): (n, 'id-' + n.split()[0].lower()) for n in (
        'Ahmed Yasin', 'Ali Asgher Khan', 'Ayaan Qureshi', 'Haya Ansari', 'Huroom Khan', 'Moiz Ali Khan',
        'Rumaisa Hussain', 'Umer Maroof', 'Usama Siddiqui', 'Rayyan Islam', 'Hamza Yousuf')}
    ALIASES = {'usama': 'Usama Siddiqui', 'umer': 'Umer Maroof', 'rayyan': 'Rayyan Islam', 'rayaan': 'Rayyan Islam',
               'ali khan': 'Ali Asgher Khan', 'ali': 'Ali Asgher Khan', 'hamza': 'Hamza Yousuf'}

    def who(self, contact):
        from intake.documents import firm_member
        return firm_member(self.FIRM, self.ALIASES, contact, contact)[0]

    def test_staff_saved_every_way_are_matched_to_their_real_name(self):
        cases = {
            'Usama Siddique Akla': 'Usama Siddiqui',       # a surname spelt differently, AKLA added
            'Usama Senior Counsel AKLA': 'Usama Siddiqui',
            'Rayyan (196907154595950:32)': 'Rayyan Islam',  # unsaved: push name and a hidden id
            'Rayyan Baba USA - AKLA Intern': 'Rayyan Islam',
            'Umer': 'Umer Maroof',
            'Umer Maroof OES': 'Umer Maroof',
            'Haya Ansari - AKLA Trainee': 'Haya Ansari',
            'Huroom Khan AKLA': 'Huroom Khan',
            'Ahmed Yasin AKLA': 'Ahmed Yasin',
            'Rumaisa Hussain C/o Zeeshan Hussain': 'Rumaisa Hussain',
            'Ali Khan': 'Ali Asgher Khan',
            'Moiz Ali Khan AKLA': 'Moiz Ali Khan',
        }
        for contact, full in cases.items():
            self.assertEqual(self.who(contact), full, contact)

    def test_outsiders_are_not_taken_for_the_firm(self):
        for contact in ('Noman (ADB)', 'Barister Ali', 'Ahmed Raza', 'Sajid bhai (EWPL)', '(92300123456)', ''):
            self.assertIsNone(self.who(contact), contact)

    def test_an_outsider_keeps_the_contact_name_without_a_number(self):
        from intake.filer import clean_sender
        self.assertEqual(clean_sender('Noman (ADB)')['name'], 'Noman (ADB)')
        self.assertEqual(clean_sender('Barister Ali (+92 300 1234567)')['name'], 'Barister Ali')
