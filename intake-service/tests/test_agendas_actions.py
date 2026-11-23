"""agendas: every automatic line is logged in intake_actions (so it can be undone), tray
payloads say which transaction was meant, and an unknown Transaction is proposed as a project.

Synthetic agendas only (helpers.write_docx), against the transaction names tests/test_match.py already uses.
"""
import os
import tempfile
import unittest

from helpers import NEW_STYLE, NEW_TABLE, write_docx
from intake.agendas import run_agendas
from test_names import FakeDb

FILE = 'Daily Agenda - Test Person [October 30, 2026].docx'
HEAD = ['Daily Agenda', 'Date: October 30, 2026', 'Associate: Test Person', 'Deliverables']
TAIL = ['Daily Timesheet', 'Date: October 29, 2026', 'Associate: Test Person']


def block(transaction, deliverable, status='In progress.', scope='Working on it.'):
    return [f'Transaction: {transaction}', f'Scope of Task: {scope}', f'Complete Deliverable: {deliverable}',
            f'Day Deliverable: {deliverable}', 'Deliverable Assigned By: Self assigned.', f'Current Deliverable Status: {status}']


def row(rid, deliverable, **kw):
    base = {'id': rid, 'sort_order': int(rid[1:]), 'client': 'Asian Development Bank', 'project': 'M6 Motorway',
            'deliverable': deliverable, 'team': [], 'currently_with': 'Someone Else', 'status': 'In Progress',
            'matter_id': 'm-1', 'archived_at': None, 'updated_at': None, 'latest_update_at': None}
    base.update(kw)
    return base


def hub(auto_create_rows=False):
    return FakeDb(
        transaction_rows=[row('r1', 'Term Sheet'), row('r2', 'Complete RFP for Section 1'), row('r3', 'Complete RFP for Section 2'),
                          row('r4', 'Concession Agreement for Section 1 and Section 2'), row('r5', 'O&M RFID Agreement')],
        profiles=[{'id': 'u-test', 'full_name': 'Test Person', 'status': 'approved'}],
        intake_settings=[{'key': 'auto_create_rows', 'value': auto_create_rows}],
        intake_agendas=[], intake_tray=[], intake_actions=[], intake_runs=[], transaction_updates=[],
        transaction_time_suggestions=[], matters=[], project_names=[])


class AgendaActionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def agenda(self, paragraphs, table=None, name=FILE):
        return write_docx(os.path.join(self.tmp, name), paragraphs, table)

    def test_a_sure_line_is_logged_with_its_update_and_the_move_it_made(self):
        db = hub()
        self.agenda(NEW_STYLE, NEW_TABLE)
        summary = run_agendas(db, folder=self.tmp)
        self.assertEqual((summary['matched'], summary['unsure'], summary['no_row'], summary['projects_proposed']), (1, 0, 0, 0))

        update = db.rows('transaction_updates')[0]
        self.assertEqual((update['row_id'], update['source'], update['source_ref'], update['author'], update['author_id'], update['at']),
                         ('r4', 'agenda', FILE, 'Test Person', 'u-test', '2026-10-30T08:00:00+05:00'))
        self.assertEqual(update['body'], 'Finalise the concession agreement and circulate it.')
        moved = db.rows('transaction_rows', id='r4')[0]
        self.assertEqual((moved['currently_with'], moved['updated_source'], moved['status']), ('Test Person', 'agenda', 'In Progress'))

        self.assertEqual(len(db.rows('intake_actions')), 1)
        action = db.rows('intake_actions')[0]
        self.assertEqual((action['kind'], action['source'], action['source_ref'], action['row_id'], action['update_id'], action['matter_id']),
                         ('row_moved', 'agenda', FILE, 'r4', update['id'], 'm-1'))
        self.assertEqual((action['before'], action['after']), ({'currently_with': 'Someone Else'}, {'currently_with': 'Test Person'}))
        self.assertEqual(action['detail'], {'from': 'Test Person', 'via': 'agenda', 'file': FILE})
        self.assertEqual(action['summary'], 'Concession Agreement for Section 1 and Section 2: Finalise the concession agreement and circulate it.')
        # nothing writes a row line any other way
        self.assertEqual(len(db.inserted('transaction_updates')), 1)
        self.assertEqual(db.rows('intake_tray'), [])
        self.assertEqual([t['transaction'] for t in db.rows('transaction_time_suggestions')], ['ADB – M6'])

    def test_a_line_that_moves_nothing_is_a_plain_row_update(self):
        db = hub()
        db.tables['transaction_rows'][3]['currently_with'] = 'Test Person'            # already with the writer
        self.agenda(HEAD + block('ADB – M6', 'The Finalised M6 Concession Agreement.', 'Pending with me.')
                    + block('M6', 'The Amended Term Sheet.', 'Sent to the client.') + TAIL)
        run_agendas(db, folder=self.tmp)
        actions = db.rows('intake_actions')
        self.assertEqual([(a['kind'], a['row_id'], a['before'], a['after']) for a in actions],
                         [('row_update', 'r4', None, None), ('row_update', 'r1', None, None)])
        self.assertEqual([a['update_id'] for a in actions], [u['id'] for u in db.rows('transaction_updates')])
        self.assertNotEqual(actions[0]['group_id'], actions[1]['group_id'])             # two arrivals
        self.assertEqual(db.rows('transaction_rows', id='r1')[0]['currently_with'], 'Someone Else')
        self.assertFalse([p for p in db.patches if p[0] == 'transaction_rows'])

    def test_tray_payloads_say_which_transaction_and_an_unknown_one_is_proposed_once(self):
        db = hub()
        self.agenda(HEAD + block('ADB – M6', 'Quartz Offtake Memorandum.')           # known transaction, no such row
                    + block('M6', 'Finalised RFP.')                                    # two rows fit equally
                    + block('Quartz Harbour Holdings', 'Share Purchase Agreement.')    # nothing answers to this
                    + block('Quartz Harbour Holdings.', 'Disclosure Letter.') + TAIL,
                    [['Sr. No.', 'Transaction', 'Matter & Description', 'Hours', 'Billable Hours', 'AK Billable Hours'],
                     ['', 'quartz harbour holdings', 'Drafted the SPA.', '3.0', '3.0', '-'], ['Total Hours', '3.0', '3.0', '-']])
        self.agenda(HEAD[:2] + ['Associate: Other Person', 'Deliverables'] + block('Quartz Harbour Holdings', 'Board Resolution.') + TAIL,
                    name='Daily Agenda - Other Person [October 30, 2026].docx')
        summary = run_agendas(db, folder=self.tmp)
        self.assertEqual((summary['matched'], summary['unsure'], summary['no_row'], summary['time_trayed']), (0, 1, 4, 1))
        self.assertEqual(db.rows('intake_actions'), [])

        by_kind = {}
        for item in db.rows('intake_tray'):
            by_kind.setdefault(item['kind'], []).append(item)
        self.assertEqual([(i['payload']['transaction'], i['payload']['code'], i['payload']['transaction_known']) for i in by_kind['agenda_line_no_row']],
                         [('Quartz Harbour Holdings', None, False),                 # Other Person's file is read first
                          ('ADB – M6', 'ADB', True), ('Quartz Harbour Holdings', None, False),
                          ('Quartz Harbour Holdings.', None, False)])
        unsure = by_kind['agenda_line_unsure'][0]
        self.assertEqual((unsure['payload']['code'], unsure['payload']['transaction_known']), ('ADB', True))
        self.assertIn(unsure['guess']['row_id'], ('r2', 'r3'))
        timed = by_kind['time_no_row'][0]['payload']
        self.assertEqual((timed['code'], timed['transaction_known'], timed['hours']), (None, False, '3.0'))
        # five mentions in two files, one question
        self.assertEqual(len(by_kind['new_project']), 1)
        proposal = by_kind['new_project'][0]
        self.assertEqual(proposal['payload'], {'name': 'Quartz Harbour Holdings', 'code': None, 'count': 1, 'seen': [
            {'where': 'Daily Agenda - Other Person [October 30, 2026].docx', 'person': 'Other Person', 'date': '2026-10-30'}]})
        self.assertEqual(proposal['guess'], {'new_project': {'name': 'Quartz Harbour Holdings', 'client': '', 'code': None}, 'near': []})
        self.assertEqual(summary['projects_proposed'], 1)

        # the next day's agenda adds to the same question
        self.agenda(['Daily Agenda', 'Date: November 2, 2026', 'Associate: Test Person', 'Deliverables']
                    + block('Quartz Harbour Holdings', 'Share Purchase Agreement.') + TAIL,
                    name='Daily Agenda - Test Person [November 2, 2026].docx')
        run_agendas(db, folder=self.tmp)
        proposals = db.rows('intake_tray', kind='new_project')
        self.assertEqual((len(proposals), proposals[0]['payload']['count']), (1, 2))
        self.assertEqual([s['date'] for s in proposals[0]['payload']['seen']], ['2026-11-02', '2026-10-30'])

    def test_a_row_the_intake_creates_is_logged_with_its_first_line(self):
        db = hub(auto_create_rows=True)
        self.agenda(HEAD + block('ADB – M6', 'Quartz Offtake Memorandum.', scope='First draft of the memorandum.') + TAIL)
        summary = run_agendas(db, folder=self.tmp)
        self.assertEqual((summary['created'], summary['no_row']), (1, 0))
        created = [r for r in db.rows('transaction_rows') if r['deliverable'] == 'Quartz Offtake Memorandum'][0]
        update = db.rows('transaction_updates')[0]
        self.assertEqual((update['row_id'], update['body']), (created['id'], "Row created from Test Person's agenda: First draft of the memorandum."))
        actions = {a['kind']: a for a in db.rows('intake_actions')}
        self.assertEqual(set(actions), {'row_created', 'row_update'})
        made, line = actions['row_created'], actions['row_update']
        self.assertEqual((made['row_id'], made['summary'], made['source'], made['source_ref'], made['matter_id']),
                         (created['id'], 'Quartz Offtake Memorandum · new row', 'agenda', FILE, created['matter_id']))
        self.assertEqual(made['detail'], {'from': 'Test Person', 'via': 'agenda', 'file': FILE,
                                          'client': 'Asian Development Bank', 'project': 'M6 Motorway'})
        self.assertEqual((line['row_id'], line['update_id'], line['group_id']), (created['id'], update['id'], made['group_id']))
        self.assertEqual(db.rows('intake_tray'), [])


if __name__ == '__main__':
    unittest.main()
