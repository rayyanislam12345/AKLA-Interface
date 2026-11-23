"""projects: one tray item per missing project, creating one as the website does, the owner's backfill.

Run against the made-up transactions in test_names.py; no real client or project here.
"""
import os
import sqlite3
import tempfile
import unittest

import helpers  # noqa: F401  (puts the package on the path)
from intake import names, projects
from intake.match import Matcher
from test_names import FakeDb, MadeUpConfig, hub_tables


def seen(where, date, person='Test Person'):
    return {'where': where, 'person': person, 'date': date}


def tray(db, **where):
    return db.rows('intake_tray', kind='new_project', **where)


class ProposeTest(MadeUpConfig):
    def setUp(self):
        super().setUp()
        self.db = FakeDb(**hub_tables(intake_tray=[], intake_settings=[{'key': 'auto_create_projects', 'value': False}]))
        self.m = Matcher(self.db)

    def test_one_item_per_name_with_a_count_and_the_latest_five(self):
        first = projects.propose_project(self.db, self.m, 'Quartz Harbour', seen=seen('a1.docx', '2026-11-01'))
        self.assertEqual(first['action'], 'proposed')
        for day in range(2, 8):
            out = projects.propose_project(self.db, self.m, ' quartz  harbour. ', seen=seen(f'a{day}.docx', f'2026-11-0{day}'))
            self.assertEqual(out['action'], 'updated')
        items = tray(self.db)
        self.assertEqual(len(items), 1)
        payload = items[0]['payload']
        self.assertEqual((payload['name'], payload['code'], payload['count']), ('Quartz Harbour', None, 7))
        self.assertEqual([s['date'] for s in payload['seen']],
                         ['2026-11-07', '2026-11-06', '2026-11-05', '2026-11-04', '2026-11-03'])
        self.assertEqual(payload['seen'][0], {'where': 'a7.docx', 'person': 'Test Person', 'date': '2026-11-07'})
        self.assertEqual(items[0]['guess'], {'new_project': {'name': 'Quartz Harbour', 'client': '', 'code': None}, 'near': []})
        # the same sighting reported again is not counted twice
        again = projects.propose_project(self.db, self.m, 'Quartz Harbour', seen=seen('a7.docx', '2026-11-07'))
        self.assertEqual(again['why'], 'same sighting')
        self.assertEqual(tray(self.db)[0]['payload']['count'], 7)
        # a matcher built on a later run finds the same open item
        later = projects.propose_project(self.db, Matcher(self.db), 'QUARTZ HARBOUR', seen=seen('a9.docx', '2026-11-09'))
        self.assertEqual((later['action'], later['count'], len(tray(self.db))), ('updated', 8, 1))

    def test_a_code_gathers_documents_and_agenda_names_in_one_item(self):
        projects.propose_project(self.db, self.m, 'Gamma Mining', code='GAM', seen=seen('GAM12 - Lease.pdf', '2026-11-02', 'Someone'))
        projects.propose_project(self.db, self.m, '', code='GAM', seen=seen('GAM13 - Deed.pdf', '2026-11-03', 'Someone'))
        # an agenda only has the name; the Filer's code for it is found, so it joins the same item
        out = projects.propose_project(self.db, self.m, 'Gamma pit – licence', seen=seen('agenda.docx', '2026-11-04'))
        self.assertEqual(out['action'], 'updated')
        items = tray(self.db)
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]['payload']['name'], items[0]['payload']['code'], items[0]['payload']['count']),
                         ('Gamma Mining', 'GAM', 3))
        self.assertEqual(items[0]['guess']['new_project'], {'name': 'Gamma Mining', 'client': '', 'code': 'GAM'})
        # a sheet transaction with no project is proposed under its code, with the sheet's client
        projects.propose_project(self.db, self.m, 'Beta Port', seen=seen('agenda.docx', '2026-11-04'))
        beta = [i for i in tray(self.db) if i['payload']['code'] == 'BET'][0]
        self.assertEqual(beta['guess']['new_project'], {'name': 'Beta Port', 'client': 'Harbour Co', 'code': 'BET'})

    def test_nothing_for_a_known_or_an_internal_name(self):
        for name, code, why in (('Alpha Bridge', None, 'known'), ('ALP – Financing', None, 'known'), ('whatever', 'ALP', 'known'),
                                ('Internal', None, 'internal'), ('AKLA Project Hub AI', None, 'internal'), ('N/A', None, 'internal'),
                                ('', None, 'no name')):
            out = projects.propose_project(self.db, self.m, name, code=code, seen=seen('x.docx', '2026-11-01'))
            self.assertEqual((out['action'], out['why']), ('nothing', why), name)
        self.assertEqual(tray(self.db), [])
        self.assertEqual(self.db.inserts, [])

    def test_a_close_name_is_offered_as_the_same_project(self):
        db = FakeDb(**hub_tables(matters=[{'id': 'm-osl', 'name': 'Osler Cardiovascular Group'}], intake_tray=[],
                                 intake_settings=[{'key': 'auto_create_projects', 'value': True}]))
        out = projects.propose_project(db, Matcher(db), 'OSLER', seen=seen('x.docx', '2026-11-01'))
        self.assertEqual(out['action'], 'proposed')
        guess = tray(db)[0]['guess']
        self.assertEqual(guess['near'], [{'matter_id': 'm-osl', 'name': 'Osler Cardiovascular Group', 'confidence': '0.90'}])
        self.assertEqual(db.rows('matters'), [{'id': 'm-osl', 'name': 'Osler Cardiovascular Group', 'code': None, 'client_id': None}])

    def test_a_dropped_or_answered_proposal_is_not_raised_again(self):
        projects.propose_project(self.db, self.m, 'Quartz Harbour', seen=seen('a1.docx', '2026-11-01'))
        self.db.patch('intake_tray', {'kind': 'eq.new_project'}, {'status': 'dropped'})
        out = projects.propose_project(self.db, Matcher(self.db), 'Quartz Harbour', seen=seen('a2.docx', '2026-11-02'))
        self.assertEqual((out['action'], out['why']), ('nothing', 'dropped'))
        self.db.patch('intake_tray', {'kind': 'eq.new_project'}, {'status': 'accepted', 'resolution': {'matter_id': 'm-alpha'}})
        out = projects.propose_project(self.db, Matcher(self.db), 'Quartz Harbour', seen=seen('a3.docx', '2026-11-03'))
        self.assertEqual((out['action'], out['why']), ('nothing', 'answered'))
        self.assertEqual(len(tray(self.db)), 1)


class AutoCreateTest(MadeUpConfig):
    def db_with(self, switch, **more):
        tables = hub_tables(intake_tray=[], intake_settings=[{'key': 'auto_create_projects', 'value': switch}],
                            project_names=[{'code': 'BET', 'name': 'Beta'}, {'code': 'BET', 'name': 'Harbour Co / Beta Port', 'kind': 'sheet'}],
                            transaction_rows=[{'id': 'r1', 'sort_order': 1, 'client': 'Harbour Co', 'project': 'Beta Port',
                                               'deliverable': 'Lease', 'matter_id': None, 'archived_at': None}],
                            intake_actions=[])
        tables.update(more)
        return FakeDb(**tables)

    def test_switch_off_proposes(self):
        db = self.db_with(False)
        out = projects.propose_project(db, Matcher(db), 'Beta Port', code='BET', seen=seen('BET3.pdf', '2026-11-01'), source='whatsapp')
        self.assertEqual(out['action'], 'proposed')
        self.assertEqual(len(db.rows('matters')), 2)

    def test_switch_on_creates_when_code_and_client_are_known_and_nothing_is_near(self):
        db = self.db_with(True, intake_tray=[{'kind': 'new_project', 'payload': {'name': 'Beta Port', 'code': 'BET', 'count': 2, 'seen': []},
                                              'guess': None}])
        m = Matcher(db)
        out = projects.propose_project(db, m, 'Beta harbour works', code='BET', seen=seen('BET3.pdf', '2026-11-01'), source='whatsapp')
        self.assertEqual(out['action'], 'created')
        matter = [r for r in db.rows('matters') if r.get('code') == 'BET'][0]
        self.assertEqual((matter['name'], matter['created_by'], out['matter_id']), ('Beta Port', 'u-intake', matter['id']))
        client = db.rows('clients', name='Harbour Co')[0]                       # the sheet's client, created
        self.assertEqual((matter['client_id'], client['created_by']), (client['id'], 'u-intake'))
        self.assertEqual([(s['name'], s['sort_order'], s['status']) for s in db.rows('matter_stages', matter_id=matter['id'])],
                         [('Origination', 0, 'in_progress'), ('Due Diligence', 1, 'not_started'), ('Drafting', 2, 'not_started'),
                          ('Negotiation', 3, 'not_started'), ('Financial Close', 4, 'not_started'), ('Post-Closing', 5, 'not_started')])
        # the code's names moved onto the project, the name as seen was added, the sheet row was linked
        self.assertEqual({(r['kind'], r['name']) for r in db.rows('project_names', matter_id=matter['id'])},
                         {('alias', 'Beta'), ('sheet', 'Harbour Co / Beta Port'), ('alias', 'Beta harbour works')})
        self.assertEqual(db.rows('transaction_rows')[0]['matter_id'], matter['id'])
        action = db.rows('intake_actions')[0]
        self.assertEqual((action['kind'], action['source'], action['summary'], action['detail'], action['matter_id'], action['source_ref']),
                         ('project_created', 'whatsapp', 'Beta Port · new project', {'client': 'Harbour Co', 'code': 'BET'},
                          matter['id'], 'BET3.pdf'))
        # the open question about it is answered, and the same matcher now knows the project
        item = tray(db)[0]
        self.assertEqual((item['status'], item['resolution']['matter_id'], item['resolution']['adopted']), ('accepted', matter['id'], True))
        self.assertEqual(m.matter_for_code('BET'), matter['id'])
        again = projects.propose_project(db, m, 'Beta Port', code='BET', seen=seen('BET4.pdf', '2026-11-02'))
        self.assertEqual((again['action'], again['why']), ('nothing', 'known'))
        self.assertEqual(len(db.rows('matters')), 3)

    def test_switch_on_still_asks_without_a_code_or_a_client_or_when_something_is_near(self):
        db = self.db_with(True, matters=[{'id': 'm-near', 'name': 'Beta Port Authority Advisory'}])
        m = Matcher(db)
        self.assertEqual(projects.propose_project(db, m, 'Quartz Harbour', client='Quartz Co')['action'], 'proposed')    # no code
        self.assertEqual(projects.propose_project(db, m, 'Gamma Mining', code='GAM')['action'], 'proposed')            # no client
        out = projects.propose_project(db, m, 'Beta Port', code='BET')                                                  # a close name exists
        self.assertEqual(out['action'], 'proposed')
        beta = [i for i in tray(db) if i['payload']['code'] == 'BET'][0]
        self.assertEqual([n['matter_id'] for n in beta['guess']['near']], ['m-near'])
        self.assertEqual(len(db.rows('matters')), 1)
        self.assertEqual(db.rows('intake_actions'), [])
        # with a client given, the coded one is created
        self.assertEqual(projects.propose_project(db, m, 'Gamma Mining', code='GAM', client='Gamma Minerals')['action'], 'created')


class CreateProjectTest(MadeUpConfig):
    def test_client_is_found_whatever_the_case_and_no_client_is_allowed(self):
        db = FakeDb(**hub_tables(intake_actions=[]))
        first = projects.create_project(db, '  New   Deal ', 'northern roads AUTHORITY', None, 'email', names=['ND', 'new deal'])
        matter = db.rows('matters', id=first)[0]
        self.assertEqual((matter['name'], matter['client_id'], matter['code']), ('New Deal', 'c-nra', None))
        self.assertEqual(len(db.rows('clients')), 1)
        self.assertEqual([(r['name'], r['kind'], r['source']) for r in db.rows('project_names', matter_id=first)], [('ND', 'alias', 'intake')])
        second = projects.create_project(db, 'Clientless', '', None, 'agenda')
        self.assertIsNone(db.rows('matters', id=second)[0]['client_id'])
        self.assertEqual(len(db.rows('matter_stages')), 12)
        self.assertEqual([a['summary'] for a in db.rows('intake_actions')], ['New Deal · new project', 'Clientless · new project'])
        with self.assertRaises(ValueError):
            projects.create_project(db, ' ', 'x', None, 'agenda')


class AdoptAcceptedTest(MadeUpConfig):
    def test_an_accepted_item_moves_the_code_onto_the_project(self):
        db = FakeDb(**hub_tables(
            matters=[{'id': 'm-alpha', 'name': 'Alpha Bridge Concession', 'code': 'ALP'}, {'id': 'm-gamma', 'name': 'Gamma Mining Co'},
                     {'id': 'm-plain', 'name': 'Quartz Harbour'}],
            project_names=[{'code': 'GAM', 'name': 'Gamma pit'}, {'code': 'GAM', 'name': 'GAM'}, {'code': 'DE', 'name': 'Delta works'},
                           {'matter_id': 'm-plain', 'name': 'QH', 'kind': 'learned', 'source': 'tray'}],
            intake_tray=[
                {'id': 't1', 'kind': 'new_project', 'status': 'accepted', 'payload': {'name': 'Gamma Mining', 'code': 'GAM', 'count': 4, 'seen': []},
                 'resolution': {'matter_id': 'm-gamma'}},
                {'id': 't2', 'kind': 'new_project', 'status': 'accepted', 'payload': {'name': 'Delta Energy', 'code': 'DE', 'count': 1, 'seen': []},
                 'resolution': {'matter_id': 'm-alpha'}},                                   # "it's this project", which has its own code
                {'id': 't3', 'kind': 'new_project', 'status': 'accepted', 'payload': {'name': 'QH', 'code': None, 'count': 1, 'seen': []},
                 'resolution': {'matter_id': 'm-plain'}},
                {'id': 't4', 'kind': 'new_project', 'status': 'accepted', 'payload': {'name': 'Done before', 'code': 'GAM'},
                 'resolution': {'matter_id': 'm-gamma', 'adopted': True}},
                {'id': 't5', 'kind': 'new_project', 'status': 'dropped', 'payload': {'name': 'Dropped', 'code': None}, 'resolution': None},
                {'id': 't6', 'kind': 'new_project', 'status': 'open', 'payload': {'name': 'Gamma pit', 'code': None, 'count': 1, 'seen': []}},
                {'id': 't7', 'kind': 'new_project', 'status': 'open', 'payload': {'name': 'Still unknown', 'code': None, 'count': 1, 'seen': []}},
                {'id': 't8', 'kind': 'agenda_line_no_row', 'status': 'accepted', 'payload': {}, 'resolution': {'matter_id': 'm-gamma'}}]))
        m = Matcher(db)
        self.assertIsNone(m.matter_for_code('GAM'))
        self.assertEqual(projects.adopt_accepted(db, m), 3)

        self.assertEqual(db.rows('matters', id='m-gamma')[0]['code'], 'GAM')            # it had none
        self.assertEqual(db.rows('matters', id='m-alpha')[0]['code'], 'ALP')            # its own code stays
        self.assertEqual({r['name'] for r in db.rows('project_names', matter_id='m-gamma')}, {'Gamma pit', 'GAM'})
        self.assertEqual({(r['name'], r['code']) for r in db.rows('project_names', matter_id='m-alpha')}, {('Delta works', 'DE'), ('DE', 'DE')})
        for tid in ('t1', 't2', 't3', 't4'):
            self.assertTrue(db.rows('intake_tray', id=tid)[0]['resolution']['adopted'])
        self.assertEqual(db.rows('intake_tray', id='t8')[0]['resolution'], {'matter_id': 'm-gamma'})
        # the same matcher files what was waiting, and so does one built afterwards
        for matcher in (m, Matcher(db)):
            self.assertEqual(matcher.matter_for_code('GAM'), 'm-gamma')
            self.assertEqual(matcher.matter_for_code('DE'), 'm-alpha')
            self.assertEqual(matcher.resolve_transaction('Gamma pit')[0]['matter_id'], 'm-gamma')
        # an open question that has found its project meanwhile is closed; one that has not stays
        closed = db.rows('intake_tray', id='t6')[0]
        self.assertEqual((closed['status'], closed['resolution']['matter_id'], closed['resolution']['closed_by']), ('accepted', 'm-gamma', 'intake'))
        self.assertEqual(db.rows('intake_tray', id='t7')[0]['status'], 'open')
        self.assertEqual(db.rows('intake_tray', id='t5')[0]['status'], 'dropped')
        self.assertEqual(projects.adopt_accepted(db, Matcher(db)), 0)                 # nothing left to do


class PlanTest(MadeUpConfig):
    def filer(self, folder):
        path = os.path.join(folder, 'filed.sqlite')
        con = sqlite3.connect(path)
        con.execute('CREATE TABLE files (id INTEGER PRIMARY KEY, action TEXT, code TEXT, web_url TEXT)')
        con.executemany('INSERT INTO files (action, code, web_url) VALUES (?, ?, ?)', [
            ('filed', 'GAM', 'https://example.invalid/1'), ('filed', 'GAM', 'https://example.invalid/2'),
            ('filed', 'GAM', None), ('duplicate', 'GAM', 'https://example.invalid/3'), ('filed', None, 'https://example.invalid/4'),
            ('filed', 'ALP', 'https://example.invalid/5')])
        con.commit()
        con.close()
        return path

    def db(self):
        return FakeDb(**hub_tables(
            intake_tray=[{'id': 't1', 'kind': 'new_project', 'payload': {'name': 'Gamma Mining', 'code': 'GAM', 'count': 2, 'seen': []}}],
            intake_actions=[], intake_runs=[],
            project_names=[{'code': 'GAM', 'name': 'Gamma pit'}],
            transaction_rows=[
                {'id': 'r1', 'sort_order': 1, 'client': 'Harbour Co', 'project': 'Beta Port', 'deliverable': 'Lease', 'matter_id': None, 'archived_at': None},
                {'id': 'r2', 'sort_order': 2, 'client': 'Harbour Co', 'project': 'Beta Port', 'deliverable': 'Licence', 'matter_id': None, 'archived_at': None},
                {'id': 'r3', 'sort_order': 3, 'client': 'NRA', 'project': 'Alpha Bridge', 'deliverable': 'Concession', 'matter_id': 'm-alpha', 'archived_at': None}]))

    def test_plan_lists_every_code_without_a_project(self):
        db = self.db()
        with tempfile.TemporaryDirectory() as folder:
            plan = projects.plan_projects(db, Matcher(db), filer_db=self.filer(folder))
            self.assertEqual(plan, [
                {'code': 'BET', 'name': 'Beta Port', 'client': 'Harbour Co', 'sheet_rows': 2, 'filer_documents': 0, 'create': True},
                {'code': 'GAM', 'name': 'Gamma Mining', 'client': '', 'sheet_rows': 0, 'filer_documents': 2, 'create': True},
                {'code': 'DE', 'name': 'Delta Energy', 'client': '', 'sheet_rows': 0, 'filer_documents': 0, 'create': True}])
            # no Filer record to hand: the count is unknown, not zero
            for missing in (None, os.path.join(folder, 'not-there.sqlite')):
                self.assertEqual({p['filer_documents'] for p in projects.plan_projects(db, Matcher(db), filer_db=missing)}, {None})
            # the file the owner edits reads back as the same list
            path = projects.write_plan(os.path.join(folder, 'plan.json'), plan)
            self.assertEqual(projects.read_plan(path), plan)
        self.assertEqual(db.inserts, [])
        self.assertEqual(db.patches, [])

    def test_apply_creates_what_is_marked_and_a_second_run_creates_nothing(self):
        db = self.db()
        plan = projects.plan_projects(db, Matcher(db))
        plan[0]['client'] = 'Harbour Company Limited'          # the owner corrects a client,
        plan[1].update(name='Gamma Mining (Quarry)', client='Gamma Minerals')
        plan[2]['create'] = False                               # and leaves one out
        first = projects.apply_plan(db, Matcher(db), plan)
        self.assertEqual((first['created'], first['left_out'], first['already_there']), (2, 1, 0))
        created = {m['code']: m for m in db.rows('matters') if m['code'] in ('BET', 'GAM')}
        self.assertEqual({c: m['name'] for c, m in created.items()}, {'BET': 'Beta Port', 'GAM': 'Gamma Mining (Quarry)'})
        self.assertEqual({c['name'] for c in db.rows('clients')}, {'Northern Roads Authority', 'Harbour Company Limited', 'Gamma Minerals'})
        self.assertEqual(len(db.rows('matter_stages')), 12)
        self.assertEqual([a['kind'] for a in db.rows('intake_actions')], ['project_created', 'project_created'])
        self.assertEqual({a['source_ref'] for a in db.rows('intake_actions')}, {'plan'})
        # the sheet rows and the code's names follow the new projects; the open question about GAM is answered
        self.assertEqual({r['id']: r['matter_id'] for r in db.rows('transaction_rows')},
                         {'r1': created['BET']['id'], 'r2': created['BET']['id'], 'r3': 'm-alpha'})
        self.assertEqual([r['matter_id'] for r in db.rows('project_names', name='Gamma pit')], [created['GAM']['id']])
        self.assertEqual((db.rows('intake_tray', id='t1')[0]['status'], first['proposals_closed']), ('accepted', 1))
        run = db.rows('intake_runs')[0]
        self.assertEqual((run['kind'], run['ok'], run['summary']['created']), ('projects', True, 2))

        matters, stages, actions = len(db.rows('matters')), len(db.rows('matter_stages')), len(db.rows('intake_actions'))
        second = projects.apply_plan(db, Matcher(db), plan)
        self.assertEqual((second['created'], second['already_there'], second['left_out']), (0, 2, 1))
        self.assertEqual((len(db.rows('matters')), len(db.rows('matter_stages')), len(db.rows('intake_actions'))), (matters, stages, actions))
        self.assertEqual(Matcher(db).matter_for_code('GAM'), created['GAM']['id'])
        self.assertEqual([p['code'] for p in projects.plan_projects(db, Matcher(db))], ['DE'])

    def test_apply_does_not_double_a_project_of_the_same_name(self):
        db = self.db()
        db.insert('matters', {'id': 'm-by-hand', 'name': 'gamma  mining'})
        out = projects.apply_plan(db, Matcher(db), [{'code': 'GAM', 'name': 'Gamma Mining', 'client': '', 'create': True},
                                                    {'code': 'DE', 'name': '', 'create': 'yes'}, {'code': 'BET', 'name': 'Beta Port'}])
        self.assertEqual((out['created'], out['same_name'], out['no_name'], out['left_out']), (0, 1, 1, 1))
        self.assertEqual(out['same_name_projects'], [{'code': 'GAM', 'name': 'Gamma Mining', 'matter_id': 'm-by-hand'}])
        self.assertEqual(len(db.rows('matters')), 3)


if __name__ == '__main__':
    unittest.main()
