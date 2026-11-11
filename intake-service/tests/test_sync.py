import unittest
from zoneinfo import ZoneInfo

import helpers  # noqa: F401  (puts the package on the path)
from intake import hub, sync
from intake.match import Matcher

TZ = ZoneInfo('Asia/Karachi')


class FakeDb:
    """Records writes; answers reads with nothing."""
    offline = False
    dry_run = False

    def __init__(self):
        self.inserts, self.patches = [], []

    def select(self, *a, **k):
        return []

    def insert(self, table, rows):
        rows = rows if isinstance(rows, list) else [rows]
        self.inserts.extend((table, r) for r in rows)
        return [dict(r, id=r.get('id') or f'new-{len(self.inserts)}') for r in rows]

    def patch(self, table, filters, data):
        self.patches.append((table, filters, data))
        return [data]


def sheet_row(**kw):
    base = {'excel_row': 6, 'sort_order': 1, 'client': 'Zorlu Enerji', 'project': 'Zorlu Group Matters',
            'deliverable': 'Response to the CPPA-G Letter', 'team_text': 'Moiz Ali Khan', 'currently_with': 'Moiz Ali Khan',
            'comments': 'October 09, 2026 [09:05 - Usama] - First.', 'status': 'In Progress', 'hub_id': 'row-1'}
    base.update(kw)
    return base


def hub_row(**kw):
    base = {'id': 'row-1', 'sort_order': 1, 'client': 'Zorlu Enerji', 'project': 'Zorlu Group Matters',
            'deliverable': 'Response to the CPPA-G Letter', 'team': ['Moiz Ali Khan'], 'currently_with': 'Moiz Ali Khan',
            'status': 'In Progress', 'archived_at': None, 'updated_at': '2026-11-01T00:00:00+00:00'}
    base.update(kw)
    return base


def snapshot(**kw):
    rows = {'row-1': {'client': 'Zorlu Enerji', 'project': 'Zorlu Group Matters', 'deliverable': 'Response to the CPPA-G Letter',
                      'team': ['Moiz Ali Khan'], 'currently_with': 'Moiz Ali Khan',
                      'comments': 'October 09, 2026 [09:05 - Usama] - First.', 'status': 'In Progress'}}
    rows['row-1'].update(kw)
    return {'written_at': '2026-11-05T00:00:00+00:00', 'rows': rows}


class ReadBackTest(unittest.TestCase):
    def run_read_back(self, sheet_rows, hub_rows, snap, updates=None):
        db = FakeDb()
        summary = {'edits_applied': 0, 'conflicts': 0, 'lines_added': 0, 'rows_created': 0}
        sync._read_back(db, sheet_rows, hub_rows, updates or {}, snap, Matcher(), hub.People(db), TZ, summary, 'sheet.xlsx')
        return db, summary

    def test_sheet_edit_applies_when_hub_unchanged(self):
        db, s = self.run_read_back([sheet_row(status='With Boss')], [hub_row()], snapshot())
        self.assertEqual(s['edits_applied'], 1)
        self.assertEqual(db.patches[0][2]['status'], 'With Boss')
        self.assertEqual(db.patches[0][2]['updated_source'], 'excel')

    def test_both_sides_changed_is_a_conflict(self):
        db, s = self.run_read_back([sheet_row(status='With Boss')],
                                   [hub_row(status='With Client', updated_at='2026-11-06T00:00:00+00:00')], snapshot())
        self.assertEqual(s['conflicts'], 1)
        self.assertEqual(db.patches, [])
        table, item = db.inserts[0]
        self.assertEqual(table, 'intake_tray')
        self.assertEqual(item['kind'], 'excel_conflict')
        self.assertEqual(item['payload'], {'row_id': 'row-1', 'deliverable': 'Response to the CPPA-G Letter', 'field': 'status',
                                           'sheet': 'With Boss', 'hub': 'With Client', 'before': 'In Progress'})

    def test_hub_moved_but_same_field_untouched_still_applies(self):
        db, s = self.run_read_back([sheet_row(currently_with='Boss')],
                                   [hub_row(status='With Client', updated_at='2026-11-06T00:00:00+00:00')], snapshot())
        self.assertEqual(s['edits_applied'], 1)
        self.assertEqual(db.patches[0][2]['currently_with'], 'Boss')

    def test_new_comment_line_becomes_an_update(self):
        text = 'October 09, 2026 [09:05 - Usama] - First.\n\nNovember 10, 2026 [11:00 - Moiz] - Sent to the client.'
        db, s = self.run_read_back([sheet_row(comments=text)], [hub_row()], snapshot())
        self.assertEqual(s['lines_added'], 1)
        table, item = db.inserts[0]
        self.assertEqual((table, item['source'], item['author'], item['body']), ('transaction_updates', 'excel', 'Moiz', 'Sent to the client.'))
        self.assertEqual(item['at'], '2026-11-10T11:00:00+05:00')

    def test_team_and_dash_are_normalised_before_comparing(self):
        db, s = self.run_read_back([sheet_row(team_text='Moiz Ali Khan\n\n', currently_with='-')],
                                   [hub_row(currently_with=None)], snapshot(currently_with=None))
        self.assertEqual(s['edits_applied'], 0)
        self.assertEqual(db.patches, [])

    def test_first_sync_matches_by_sort_order_and_deliverable(self):
        db, s = self.run_read_back([sheet_row(hub_id=None, status='Closed')], [hub_row()], {'written_at': None, 'rows': {}})
        self.assertEqual(s['rows_created'], 0)
        self.assertEqual(db.patches[0][2]['status'], 'Closed')

    def test_unknown_row_in_sheet_is_created(self):
        new = sheet_row(hub_id=None, sort_order=9, deliverable='Brand new deliverable', comments='November 10, 2026 - Started.')
        db, s = self.run_read_back([new], [hub_row()], snapshot())
        self.assertEqual(s['rows_created'], 1)
        tables = [t for t, _ in db.inserts]
        self.assertEqual(tables, ['transaction_rows', 'transaction_updates'])
        self.assertEqual(db.inserts[0][1]['updated_source'], 'excel')
        self.assertEqual(db.inserts[0][1]['matter_id'], 'c5bc1387-df6f-4b04-b342-389d164d7d15')


if __name__ == '__main__':
    unittest.main()
