"""The reader of the WhatsApp Filer's filed.sqlite. Every database here is a temporary one built
in the Filer's schema; titles, people, numbers and addresses are invented."""
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import helpers  # noqa: F401  (puts the package on the path)
from intake import filer
from intake.filer import Filer, FilerError, clean_sender, parse_fields, parse_sent, parse_source

SCHEMA = """
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  created TEXT, action TEXT,
  sha256 TEXT, office_hash TEXT, quickxor TEXT,
  original_name TEXT, chat TEXT, sender TEXT, sent TEXT, caption TEXT,
  code TEXT, number INTEGER, transaction_name TEXT, document TEXT, title_key TEXT,
  filed_name TEXT, folder TEXT, web_url TEXT,
  duplicate_of TEXT, version_of INTEGER, reason TEXT,
  fields TEXT, usage TEXT
);
"""


def make_filer_db(path, rows, own_number=True):
    """A filed.sqlite in the Filer's schema. `own_number` False leaves out the column added on 26 Oct 2026."""
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    if own_number:
        conn.execute('ALTER TABLE files ADD COLUMN own_number INTEGER')
    for row in rows:
        row = dict(row)
        if isinstance(row.get('fields'), dict):
            row['fields'] = json.dumps(row['fields'])
        if not own_number:
            row.pop('own_number', None)
        cols = ', '.join(row)
        conn.execute(f'INSERT INTO files ({cols}) VALUES ({", ".join("?" * len(row))})', list(row.values()))
    conn.commit()
    conn.close()
    return path


def read_bytes(path):
    with open(path, 'rb') as fh:
        return fh.read()


def filed(id, code='MEW', title='Escrow Agreement', status='Draft', **kw):
    """One row as the Filer writes it for a filed transaction document."""
    number = kw.pop('number', id)
    name = f'{code}-A{number} - {title} [AKLA][{status}][October 17, 2026].docx'
    row = {
        'id': id, 'created': '2026-10-17T12:01:00', 'action': 'filed', 'sha256': f'{id:064x}', 'quickxor': f'qx{id}',
        'original_name': f'{title} draft.docx', 'chat': 'TEAM GROUP', 'sender': 'Sana Mirza', 'sent': '2026-10-17T12:00:15',
        'caption': f'{title} draft.docx', 'code': code, 'number': number, 'own_number': number,
        'transaction_name': 'Northern Bypass', 'document': title, 'title_key': title.lower(), 'filed_name': name,
        'folder': f'Automated Inbox/Northern Bypass/{title}', 'web_url': f'https://sharepoint.example/{id}',
        'version_of': None, 'reason': 'read by Claude',
        'fields': {'transaction': code, 'title': title, 'document_type': 'Agreement', 'party': 'AKLA', 'status': status,
                   'document_date': '2026-10-17', 'confidence': 'high', 'note': ''},
    }
    row.update(kw)
    return row


class FilerDbCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='filer-test-')
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def db(self, rows, name='filed.sqlite', **kw):
        return make_filer_db(os.path.join(self.dir, name), rows, **kw)


class RowsTest(FilerDbCase):
    def test_only_filed_rows_with_a_url_and_a_code_oldest_first(self):
        path = self.db([
            filed(5, title='Concession Agreement'),
            filed(2),
            filed(3, action='duplicate', web_url=None),                    # a duplicate the Filer did not file
            filed(4, web_url=None),                                        # filed, never confirmed uploaded
            filed(6, code=None, filed_name='Daily Agenda.docx'),            # an agenda or a CV: no code
            filed(7, action='skipped', web_url=None, code=None),
            filed(8, web_url=''),
        ])
        reader = Filer(path)
        self.assertEqual([r['id'] for r in reader.rows()], [2, 5])
        self.assertEqual([r['id'] for r in reader.rows(after_id=2)], [5])
        self.assertEqual([r['id'] for r in reader.rows(limit=1)], [2])
        self.assertEqual(reader.counts(), {'rows': 7, 'eligible': 2})

    def test_rows_to_handle_leaves_out_what_the_hub_has(self):
        reader = Filer(self.db([filed(i) for i in range(1, 8)]))
        self.assertEqual([r['id'] for r in reader.rows_to_handle(known_ids={1, 2, 5})], [3, 4, 6, 7])
        self.assertEqual([r['id'] for r in reader.rows_to_handle(known_ids=[1, 2, 5], limit=2)], [3, 4])

    def test_a_row_by_id_whatever_its_action(self):
        reader = Filer(self.db([filed(1), filed(2, action='duplicate', web_url=None, version_of=1)]))
        self.assertEqual(reader.row(2)['action'], 'duplicate')
        self.assertEqual(reader.row(2)['version_of'], 1)
        self.assertFalse(filer.is_eligible(reader.row(2)))
        self.assertTrue(filer.is_eligible(reader.row(1)))
        self.assertIsNone(reader.row(99))
        self.assertIsNone(reader.row('not a number'))
        self.assertFalse(filer.is_eligible(None))

    def test_a_copy_without_own_number_reads_the_same(self):
        old = Filer(self.db([filed(1)], name='old.sqlite', own_number=False))
        new = Filer(self.db([filed(1)], name='new.sqlite'))
        self.assertIsNone(old.rows()[0]['own_number'])
        self.assertEqual(new.rows()[0]['own_number'], 1)
        self.assertEqual(old.rows()[0]['title'], new.rows()[0]['title'])
        self.assertEqual(old.row(1)['filed_name'], new.row(1)['filed_name'])

    def test_the_parsed_row(self):
        row = Filer(self.db([filed(3, status='Mark-up', version_of=2,
                                   sender='Sana Mirza - AKLA Trainee', sent='2026-10-17T12:00:15')])).rows()[0]
        self.assertEqual(row['title'], 'Escrow Agreement')
        self.assertEqual((row['document_type'], row['party'], row['doc_status'], row['document_date']),
                         ('Agreement', 'AKLA', 'Mark-up', '2026-10-17'))
        self.assertEqual((row['source'], row['mailbox'], row['direction']), ('whatsapp', None, None))
        self.assertEqual(row['sent_at'], datetime(2026, 10, 17, 12, 0, 15, tzinfo=timezone.utc))
        self.assertEqual((row['sender_name'], row['sender_email'], row['sender_saved']), ('Sana Mirza', None, True))
        self.assertEqual(row['sender'], 'Sana Mirza - AKLA Trainee')          # the Filer's own value is kept as it is
        self.assertEqual(row['version_of'], 2)
        self.assertEqual(row['fields']['confidence'], 'high')

    def test_a_row_with_no_fields_falls_back_to_its_columns_and_its_name(self):
        rows = Filer(self.db([
            filed(1, fields=None, document='Side Letter'),
            filed(2, fields='{not json', document=None,
                  filed_name='MEW-A2 - Term Sheet [Lender][Received][October 08, 2026].pdf'),
        ])).rows()
        self.assertEqual((rows[0]['title'], rows[0]['doc_status'], rows[0]['party']), ('Side Letter', 'Draft', 'AKLA'))
        self.assertEqual((rows[1]['title'], rows[1]['doc_status'], rows[1]['party'], rows[1]['document_date']),
                         ('Term Sheet', 'Received', 'Lender', '2026-10-08'))
        self.assertIsNone(rows[1]['document_type'])


class ReadOnlyTest(FilerDbCase):
    def test_reading_never_changes_the_file_and_works_on_a_read_only_one(self):
        path = self.db([filed(1), filed(2)])
        before = read_bytes(path)
        os.chmod(path, 0o444)
        self.addCleanup(os.chmod, path, 0o644)
        reader = Filer(path)
        reader.rows()
        reader.row(1)
        reader.counts()
        self.assertEqual(read_bytes(path), before)
        self.assertEqual(sorted(os.listdir(self.dir)), ['filed.sqlite'])       # no journal, no lock file left behind

    def test_the_filer_can_write_while_the_reader_exists(self):
        path = self.db([filed(1)])
        reader = Filer(path)
        self.assertEqual(len(reader.rows()), 1)
        writer = sqlite3.connect(path, timeout=0)              # would fail at once if the reader held a lock
        writer.execute("UPDATE files SET filed_name = 'MEW-A1 - Renamed [AKLA][Draft][October 17, 2026].docx' WHERE id = 1")
        writer.execute("INSERT INTO files (id, action, code, web_url, filed_name) VALUES (2, 'filed', 'MEW', 'u', 'MEW-A2 - X.docx')")
        writer.commit()
        writer.close()
        fresh = reader.rows()                                   # the row is read fresh each time
        self.assertEqual([r['id'] for r in fresh], [1, 2])
        self.assertTrue(fresh[0]['filed_name'].startswith('MEW-A1 - Renamed'))

    def test_a_path_with_spaces_and_marks(self):
        folder = os.path.join(self.dir, 'A folder - with #1 & 100% ? marks')
        os.makedirs(folder)
        path = make_filer_db(os.path.join(folder, 'filed.sqlite'), [filed(1)])
        self.assertEqual(len(Filer(path).rows()), 1)

    def test_a_missing_file_says_so(self):
        missing = os.path.join(self.dir, 'nowhere', 'filed.sqlite')
        with self.assertRaises(FilerError) as caught:
            Filer(missing).rows()
        self.assertIn('was not found', str(caught.exception))
        self.assertIn(missing, str(caught.exception))
        self.assertFalse(os.path.exists(missing))               # and it was not created by looking

    def test_a_file_that_is_not_the_filers_says_so(self):
        text = os.path.join(self.dir, 'notes.sqlite')
        with open(text, 'w') as fh:
            fh.write('this is not a database' * 50)
        with self.assertRaises(FilerError):
            Filer(text).rows()
        empty = os.path.join(self.dir, 'empty.sqlite')
        sqlite3.connect(empty).close()
        with self.assertRaises(FilerError) as caught:
            Filer(empty).rows()
        self.assertIn("no 'files' table", str(caught.exception))

    def test_where_the_record_is(self):
        old = os.environ.pop('FILER_DB', None)
        self.addCleanup(lambda: os.environ.__setitem__('FILER_DB', old) if old is not None else os.environ.pop('FILER_DB', None))
        self.assertEqual(filer.db_path(), '/opt/whatsapp-filer/state/filed.sqlite')
        os.environ['FILER_DB'] = '/somewhere/else.sqlite'
        self.assertEqual(filer.db_path(), '/somewhere/else.sqlite')
        self.assertEqual(filer.db_path('/given.sqlite'), '/given.sqlite')
        self.assertEqual(Filer().path, '/somewhere/else.sqlite')


class ParsingTest(unittest.TestCase):
    def test_fields(self):
        self.assertEqual(parse_fields('{"title": "Escrow Agreement", "status": "Final", "party": null}')['title'], 'Escrow Agreement')
        self.assertEqual(parse_fields('{"title": "Escrow Agreement", "party": null}')['party'], '')
        for bad in (None, '', '{oops', '[1, 2]', '"text"'):
            self.assertEqual(parse_fields(bad), {k: '' for k in filer.FIELD_KEYS}, bad)

    def test_source(self):
        self.assertEqual(parse_source('TEAM GROUP - OFFICE'), ('whatsapp', None, None))
        self.assertEqual(parse_source(None), ('whatsapp', None, None))
        self.assertEqual(parse_source('Outlook - team@example.com (Inbox)'), ('email', 'team@example.com', 'inbox'))
        self.assertEqual(parse_source('Outlook - team@example.com (Sent)'), ('email', 'team@example.com', 'sent'))
        self.assertEqual(parse_source('Outlook - team@example.com'), ('email', 'team@example.com', None))

    def test_sent(self):
        utc = datetime(2026, 10, 17, 12, 0, 15, tzinfo=timezone.utc)
        self.assertEqual(parse_sent('2026-10-17T12:00:15'), utc)                # the Filer's shape: UTC, no Z
        self.assertEqual(parse_sent('2026-10-17T12:00:15Z'), utc)
        self.assertEqual(parse_sent('2026-10-17 12:00:15'), utc)
        self.assertEqual(parse_sent('2026-10-17T17:00:15+05:00'), utc)
        self.assertEqual(parse_sent('2026-10-17T12:00:15.123456'), utc.replace(microsecond=123456))
        self.assertEqual(parse_sent('2026-10-17T12:00'), utc.replace(second=0))
        self.assertEqual(parse_sent('2026-10-17'), datetime(2026, 10, 17, tzinfo=timezone.utc))
        self.assertEqual(parse_sent(1792238415), datetime.fromtimestamp(1792238415, timezone.utc))
        self.assertEqual(parse_sent('1792238415000'), datetime.fromtimestamp(1792238415, timezone.utc))
        # a seed row written in Pakistan time, read as such when the caller says so
        pkt = timezone(timedelta(hours=5))
        self.assertEqual(parse_sent('2026-10-17T17:00:15', naive=pkt), utc)
        for bad in (None, '', 'yesterday', '17 Oct'):
            self.assertIsNone(parse_sent(bad), bad)
        self.assertIsNotNone(parse_sent('2026-10-17T12:00:15').tzinfo)

    def test_sender(self):
        name = lambda text: clean_sender(text)['name']
        # WhatsApp: a saved contact, with whatever the phone's contact book adds after the name
        self.assertEqual(name('Sana Mirza'), 'Sana Mirza')
        self.assertEqual(name('Sana Mirza AKLA'), 'Sana Mirza')
        self.assertEqual(name('Sana Mirza - AKLA Trainee'), 'Sana Mirza')
        self.assertEqual(name('Bilal Senior Counsel AKLA'), 'Bilal Senior Counsel')
        self.assertEqual(name('Sana Mirza C/o Tariq Mirza'), 'Sana Mirza')
        self.assertEqual(name('Omar Baba USA - AKLA Intern'), 'Omar Baba')
        self.assertEqual(name('SANA MIRZA'), 'SANA MIRZA')
        self.assertTrue(clean_sender('Sana Mirza')['saved'])
        # WhatsApp: a number the Filer's phone has not saved
        unsaved = clean_sender('Tariq (000000000000)')
        self.assertEqual((unsaved['name'], unsaved['saved'], unsaved['email']), ('Tariq', False, None))
        self.assertEqual(clean_sender('000000000000'), {'name': '', 'email': None, 'saved': False})
        self.assertEqual(name('~Tariq (000000000000)'), 'Tariq')
        # email
        self.assertEqual(clean_sender('Tariq Aziz <Tariq.Aziz@example.com>'),
                         {'name': 'Tariq Aziz', 'email': 'tariq.aziz@example.com', 'saved': True})
        self.assertEqual(clean_sender('"Aziz, Tariq" <t@example.com>')['name'], 'Aziz, Tariq')
        self.assertEqual(clean_sender('t@example.com'), {'name': 't@example.com', 'email': 't@example.com', 'saved': True})
        self.assertEqual(clean_sender('Tariq Aziz')['email'], None)
        self.assertEqual(clean_sender(None), {'name': '', 'email': None, 'saved': True})


if __name__ == '__main__':
    unittest.main()


class HiddenNumberTest(unittest.TestCase):
    def test_no_number_of_any_shape_survives_in_a_sender_name(self):
        from intake.filer import clean_sender
        for raw in ('Sana (196907154595950:32)', 'Sana (196907154595950@lid)', 'Sana (+92 300 1234567)',
                    'Sana 923001234567', 'Sana (92300-1234567)'):
            name = clean_sender(raw)['name']
            self.assertEqual(name, 'Sana', raw)
        self.assertEqual(clean_sender('(196907154595950:32)')['name'], '')
