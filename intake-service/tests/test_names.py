"""project_names: the key rule, the one-time seed from the YAML, adding a name, adopting a code.

Also home to the FakeDb and the made-up transactions the other phase 3 tests share.
Nothing here is a real client, project or person.
"""
import copy
import re
import unittest
from unittest import mock

import helpers  # noqa: F401  (puts the package on the path)
from intake import config, names
from intake.match import Matcher

# A made-up transactions.yaml: two sheet transactions (one with a Hub project and a sister
# project, one with none) and two the Filer codes but the sheet has no rows for.
CONFIG = {
    'matters': [
        {'code': 'ALP', 'keys': ['Alpha'], 'name': 'Alpha Bridge', 'aliases': ['Alpha Bridge', 'ALP', 'Alpha crossing']},
        {'code': 'BET', 'name': 'Beta Port', 'aliases': ['Beta Port', 'Beta']},
        {'code': 'GAM', 'keys': ['Gamma'], 'name': 'Gamma Mining',
         'aliases': ['Gamma Mining', 'Gamma pit', 'the joint Gamma and Delta licence deal from early 2026 (report, addendum, term sheet)']},
        {'code': 'DE', 'name': 'Delta Energy', 'aliases': ['Delta Energy']},
    ],
    'hub_clients': [
        {'code': 'ALP', 'pairs': [['Northern Roads Authority', 'Alpha Bridge'], ['NRA', 'Alpha Bridge']],
         'new_row': ['Northern Roads Authority', 'Alpha Bridge'], 'matter_id': 'm-alpha',
         'aliases': ['Alpha', 'Alpha - Bridge', 'Northern Roads Authority'],
         'matter_rules': [{'contains': 'Escrow', 'matter_id': 'm-alpha-escrow'}]},
        {'code': 'BET', 'pairs': [['Harbour Co', 'Beta Port']], 'aliases': ['Beta', 'Beta Port', 'Beta Harbour']},
    ],
    'internal_transactions': ['Internal', 'Admin'],
}


def sql_name_key(name):
    """btrim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')), written out step by step as the migration has it."""
    lowered = name.lower()
    replaced = re.sub('[^a-z0-9]+', ' ', lowered)
    return replaced.strip(' ')


class FakeDb:
    """Tables in memory. Answers select from them (the few PostgREST filters the intake uses) and
    applies inserts and patches, so a second run sees what the first one wrote. project_names
    gets its generated name_key and its two unique indexes, as the real table has."""
    offline = False
    dry_run = False

    def __init__(self, **tables):
        self.tables = {}
        self.inserts, self.patches, self.selects = [], [], []
        self._n = 0
        for table, rows in tables.items():
            self.tables[table] = []
            for row in rows:
                self._store(table, dict(row))

    # ---- helpers for the tests
    def rows(self, table, **where):
        return [r for r in self.tables.get(table, []) if all(r.get(k) == v for k, v in where.items())]

    def inserted(self, table):
        return [r for t, r in self.inserts if t == table]

    def _store(self, table, row):
        self._n += 1
        row.setdefault('id', f'{table}-{self._n}')
        if table == 'project_names':
            for column, default in (('matter_id', None), ('code', None), ('kind', 'alias'), ('source', 'hub')):
                row.setdefault(column, default)
            assert row['matter_id'] is not None or row['code'] is not None, 'a name needs a project or a code'
            row['name_key'] = sql_name_key(row['name'])
            self._unique(row)
        elif table == 'intake_tray':
            row.setdefault('status', 'open')
            row.setdefault('resolution', None)
        elif table == 'matters':
            row.setdefault('code', None)
            row.setdefault('client_id', None)
        self.tables.setdefault(table, []).append(row)
        return row

    def _unique(self, row, skip=None):
        for other in self.tables.get('project_names', []):
            if other is skip or (other['kind'], other['name_key']) != (row['kind'], row['name_key']):
                continue
            if row['matter_id'] is not None and other['matter_id'] == row['matter_id']:
                raise AssertionError(f'duplicate name on a project: {row["name"]!r}')
            if row['matter_id'] is None and other['matter_id'] is None and other['code'] == row['code']:
                raise AssertionError(f'duplicate name under a code: {row["name"]!r}')

    @staticmethod
    def _fits(row, filters):
        for column, cond in (filters or {}).items():
            value = row.get(column)
            if cond == 'is.null':
                ok = value is None
            elif cond == 'not.is.null':
                ok = value is not None
            elif cond.startswith('eq.'):
                ok = value is not None and str(value) == cond[3:]
            elif cond.startswith('in.(') and cond.endswith(')'):
                ok = str(value) in [item.strip('"') for item in cond[4:-1].split(',')]
            else:
                raise AssertionError(f'FakeDb does not know the filter {cond!r}')
            if not ok:
                return False
        return True

    # ---- the Db API
    def select(self, table, filters=None, columns='*', order=None, limit=None):
        self.selects.append((table, dict(filters or {}), columns))
        out = [copy.deepcopy(r) for r in self.tables.get(table, []) if self._fits(r, filters)]
        if table == 'matters' and 'client:clients(name)' in columns:
            clients = {c['id']: c for c in self.tables.get('clients', [])}
            for row in out:
                client = clients.get(row.get('client_id'))
                row['client'] = {'name': client['name']} if client else None
        return out[:limit] if limit else out

    def one(self, table, filters, columns='*'):
        rows = self.select(table, filters, columns, limit=1)
        return rows[0] if rows else None

    def insert(self, table, rows):
        rows = rows if isinstance(rows, list) else [rows]
        out = []
        for row in rows:
            self.inserts.append((table, copy.deepcopy(row)))
            out.append(copy.deepcopy(self._store(table, copy.deepcopy(row))))
        return out

    def upsert(self, table, rows, on_conflict):
        rows = rows if isinstance(rows, list) else [rows]
        out = []
        for row in rows:
            old = next((r for r in self.tables.get(table, []) if r.get(on_conflict) == row.get(on_conflict)), None)
            if old is None:
                out.extend(self.insert(table, row))
            else:
                old.update(copy.deepcopy(row))
                out.append(copy.deepcopy(old))
        return out

    def patch(self, table, filters, data):
        self.patches.append((table, dict(filters), copy.deepcopy(data)))
        out = []
        for row in self.tables.get(table, []):
            if self._fits(row, filters):
                row.update(copy.deepcopy(data))
                if table == 'project_names':
                    self._unique(row, skip=row)
                out.append(copy.deepcopy(row))
        return out

    def setting(self, key, default=None):
        row = self.one('intake_settings', {'key': f'eq.{key}'}, 'value')
        return default if row is None else row['value']


class OfflineDb(FakeDb):
    """No keys: reads answer with nothing, writes are only noted."""
    offline = True
    dry_run = True

    def select(self, table, filters=None, columns='*', order=None, limit=None):
        return []


def hub_tables(**more):
    """The Hub as the made-up YAML expects it: the Alpha project, its escrow sister, their client."""
    tables = {
        'clients': [{'id': 'c-nra', 'name': 'Northern Roads Authority'}],
        'matters': [{'id': 'm-alpha', 'name': 'Alpha Bridge Concession', 'client_id': 'c-nra'},
                    {'id': 'm-alpha-escrow', 'name': 'Alpha Bridge Escrow', 'client_id': 'c-nra'}],
        'project_names': [],
        'profiles': [{'id': 'u-intake', 'full_name': 'Hub Intake', 'status': 'approved'}],
    }
    tables.update(more)
    return tables


class MadeUpConfig(unittest.TestCase):
    """Runs a test against the made-up transactions above instead of the firm's own file."""
    def setUp(self):
        patcher = mock.patch.object(config, 'transactions', return_value=copy.deepcopy(CONFIG))
        patcher.start()
        self.addCleanup(patcher.stop)


class NameKeyTest(unittest.TestCase):
    def test_agrees_with_the_sql_rule_on_awkward_names(self):
        for name, key in (('M-6 Motorway', 'm 6 motorway'), ('Port Qasim (PQEPC)', 'port qasim pqepc'),
                          ('  ADB – M6 ', 'adb m6'), ('JN & Co', 'jn co'), ('O&M / RFID\tAgreement', 'o m rfid agreement'),
                          ('Lincoln’s Law', 'lincoln s law'), ('ML-29, ML-30', 'ml 29 ml 30'), ('---', ''), ('', '')):
            self.assertEqual(names.name_key(name), key, name)
            self.assertEqual(names.name_key(name), sql_name_key(name), name)
        self.assertEqual(names.name_key(None), '')


class SeedNamesTest(MadeUpConfig):
    def test_seed_copies_the_yaml_and_a_second_run_adds_nothing(self):
        db = FakeDb(**hub_tables())
        first = names.seed_names(db)

        # the codes: the transaction's project and the sister its rule points at
        self.assertEqual(first['codes_set'], 2)
        self.assertEqual({m['id']: m['code'] for m in db.rows('matters')}, {'m-alpha': 'ALP', 'm-alpha-escrow': 'ALP'})

        rows = db.rows('project_names')
        self.assertEqual(first['names_added'], len(rows))
        self.assertTrue(all(r['source'] == 'config' for r in rows))
        alpha = {(r['kind'], r['name']) for r in rows if r['matter_id'] == 'm-alpha'}
        for expected in (('alias', 'ALP'), ('alias', 'Alpha'), ('alias', 'Alpha crossing'), ('alias', 'Northern Roads Authority'),
                         ('sheet', 'Northern Roads Authority / Alpha Bridge'), ('sheet', 'NRA / Alpha Bridge')):
            self.assertIn(expected, alpha)
        # a name the YAML lists twice ("Alpha Bridge" is the name and an alias, "Alpha - Bridge" has the same key) is written once
        self.assertEqual([name for kind, name in alpha if names.name_key(name) == 'alpha bridge'], ['Alpha Bridge'])
        # the rule became a 'contains' name on the sister project
        self.assertEqual([(r['kind'], r['name'], r['code']) for r in rows if r['matter_id'] == 'm-alpha-escrow'],
                         [('contains', 'Escrow', 'ALP')])
        # a code with no Hub project keeps its names under the code alone
        self.assertEqual(sorted(first['code_only']), ['BET', 'DE', 'GAM'])
        gamma = {(r['kind'], r['name']) for r in rows if r['code'] == 'GAM'}
        self.assertTrue(all(r['matter_id'] is None for r in rows if r['code'] in ('GAM', 'BET', 'DE')))
        self.assertEqual(gamma, {('alias', 'GAM'), ('alias', 'Gamma Mining'), ('alias', 'Gamma'), ('alias', 'Gamma pit')})  # the long note is not a name
        self.assertIn(('sheet', 'Harbour Co / Beta Port'), {(r['kind'], r['name']) for r in rows if r['code'] == 'BET'})

        before = (len(db.inserts), len(db.patches))
        second = names.seed_names(db)
        self.assertEqual((len(db.inserts), len(db.patches)), before)
        self.assertEqual((second['names_added'], second['codes_set']), (0, 0))
        self.assertEqual(second['names_existing'], first['names_added'])

    def test_seed_compares_on_the_key_and_leaves_another_code_alone(self):
        db = FakeDb(**hub_tables(
            matters=[{'id': 'm-alpha', 'name': 'Alpha Bridge Concession', 'client_id': 'c-nra', 'code': 'OLD'},
                     {'id': 'm-alpha-escrow', 'name': 'Alpha Bridge Escrow', 'client_id': 'c-nra'}],
            project_names=[{'matter_id': 'm-alpha', 'name': 'alpha  CROSSING!', 'kind': 'learned', 'source': 'tray'}]))
        summary = names.seed_names(db)
        self.assertEqual(db.rows('matters', id='m-alpha')[0]['code'], 'OLD')           # a person's code is not overwritten
        self.assertEqual(summary['code_conflicts'], [{'matter_id': 'm-alpha', 'has': 'OLD', 'yaml': 'ALP'}])
        self.assertEqual([r['kind'] for r in db.rows('project_names', matter_id='m-alpha') if r['name_key'] == 'alpha crossing'],
                         ['learned'])                                                   # already known, in other punctuation

    def test_a_yaml_project_that_is_gone_from_the_hub_is_seeded_under_its_code(self):
        db = FakeDb(**hub_tables(matters=[{'id': 'm-other', 'name': 'Something Else'}]))
        summary = names.seed_names(db)
        self.assertEqual({m['matter_id'] for m in summary['missing_projects']}, {'m-alpha', 'm-alpha-escrow'})
        self.assertIn('ALP', summary['code_only'])
        self.assertTrue(all(r['matter_id'] is None for r in db.rows('project_names')))
        self.assertFalse([r for r in db.rows('project_names') if r['kind'] == 'contains'])

    def test_offline_seed_reads_nothing_and_fails_nothing(self):
        summary = names.seed_names(OfflineDb())
        self.assertGreater(summary['names_added'], 0)
        self.assertEqual(summary['codes_set'], 0)


class AddAndAdoptTest(MadeUpConfig):
    def test_add_name_adds_once(self):
        db = FakeDb(**hub_tables())
        first = names.add_name(db, 'River Crossing', 'learned', matter_id='m-alpha', source='tray')
        again = names.add_name(db, 'river-crossing', 'alias', matter_id='m-alpha')
        self.assertEqual(first['id'], again['id'])
        self.assertEqual(len(db.rows('project_names')), 1)
        self.assertIsNone(names.add_name(db, '  ', 'alias', matter_id='m-alpha'))
        self.assertIsNone(names.add_name(db, 'No home'))
        under_code = names.add_name(db, 'Gamma works', code='GAM')
        self.assertEqual((under_code['matter_id'], under_code['code'], under_code['source']), (None, 'GAM', 'intake'))
        self.assertEqual(names.add_name(db, 'GAMMA WORKS', code='GAM')['id'], under_code['id'])
        with self.assertRaises(ValueError):
            names.add_name(db, 'x', 'nickname', matter_id='m-alpha')

    def test_adopt_code_moves_the_names_and_links_the_rows(self):
        db = FakeDb(**hub_tables(
            matters=[{'id': 'm-beta', 'name': 'Beta Port'}, {'id': 'm-beta-2', 'name': 'Beta Port Dredging'}],
            project_names=[{'code': 'BET', 'name': 'Beta'}, {'code': 'BET', 'name': 'Harbour Co / Beta Port', 'kind': 'sheet'},
                           {'code': 'BET', 'name': 'Quay Co / Beta Quay', 'kind': 'sheet'},
                           {'code': 'BET', 'name': 'Dredging', 'kind': 'contains', 'matter_id': 'm-beta-2'},
                           {'matter_id': 'm-beta', 'name': 'BETA', 'kind': 'learned'}, {'code': 'GAM', 'name': 'Gamma'}],
            transaction_rows=[
                {'id': 'r1', 'client': 'Harbour Co', 'project': 'Beta Port', 'deliverable': 'Lease', 'matter_id': None},
                {'id': 'r2', 'client': 'harbour co', 'project': 'beta port', 'deliverable': 'Dredging contract', 'matter_id': None},
                {'id': 'r3', 'client': 'Quay Co', 'project': 'Beta Quay', 'deliverable': 'Licence', 'matter_id': None},
                {'id': 'r4', 'client': 'Harbour Co', 'project': 'Beta Port', 'deliverable': 'Old one', 'matter_id': 'm-else'},
                {'id': 'r5', 'client': 'Someone', 'project': 'Else', 'deliverable': 'Lease', 'matter_id': None}]))
        out = names.adopt_code(db, 'BET', 'm-beta')
        self.assertEqual(out, {'names_moved': 2, 'rows_linked': 2})
        on_project = {(r['kind'], r['name']) for r in db.rows('project_names', matter_id='m-beta')}
        self.assertEqual(on_project, {('learned', 'BETA'), ('sheet', 'Harbour Co / Beta Port'), ('sheet', 'Quay Co / Beta Quay')})
        # "Beta" was already the project's (as BETA): the spare stays under the code
        self.assertEqual([r['name'] for r in db.rows('project_names', matter_id=None, code='BET')], ['Beta'])
        self.assertEqual({r['id']: r['matter_id'] for r in db.rows('transaction_rows')},
                         {'r1': 'm-beta', 'r2': None, 'r3': 'm-beta', 'r4': 'm-else', 'r5': None})   # r2 is the sister's
        self.assertEqual(db.rows('project_names', code='GAM')[0]['matter_id'], None)
        self.assertEqual(names.adopt_code(db, 'BET', 'm-beta'), {'names_moved': 0, 'rows_linked': 0})

    def test_seeded_names_follow_a_project_made_later(self):
        db = FakeDb(**hub_tables())
        names.seed_names(db)
        db.insert('matters', {'id': 'm-gamma', 'name': 'Gamma Mining', 'code': 'GAM'})
        self.assertIsNone(Matcher(FakeDb(**hub_tables())).matter_for_code('GAM'))
        moved = names.adopt_code(db, 'GAM', 'm-gamma')
        self.assertEqual(moved['names_moved'], 4)
        again = names.seed_names(db)
        self.assertEqual(again['names_added'], 0)
        self.assertNotIn('GAM', again['code_only'])
        self.assertEqual(Matcher(db).matter_for_code('GAM'), 'm-gamma')


if __name__ == '__main__':
    unittest.main()
