import os
import tempfile
import unittest
from datetime import date

from helpers import NEW_STYLE, NEW_TABLE, OLD_STYLE, OLD_TABLE, write_docx
from intake.agenda import parse_agenda, parse_date, parse_file_name


class AgendaParserTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_new_style_blocks_and_timesheet(self):
        path = write_docx(os.path.join(self.tmp, 'Daily Agenda - Test Person [October 30, 2026].docx'), NEW_STYLE, NEW_TABLE)
        a = parse_agenda(path)
        self.assertEqual(a['person'], 'Test Person')
        self.assertEqual(a['role'], 'associate')
        self.assertEqual(a['agenda_date'], date(2026, 10, 30))
        self.assertEqual(a['timesheet_date'], date(2026, 10, 29))
        self.assertEqual(len(a['blocks']), 2)          # the Internal block is kept; the caller counts and skips it
        first = a['blocks'][0]
        self.assertEqual(first['transaction'], 'ADB – M6')
        self.assertEqual(first['complete'], 'The Finalised M6 Concession Agreement.')
        self.assertIn('Pending with me', first['status'])
        self.assertEqual(a['notes'], ['Note: To be discussed with Boss', 'The Rest Of This Page Has Been Intentionally Left Blank'])
        self.assertEqual([t['transaction'] for t in a['time_rows']], ['Internal', 'ADB – M6'])
        self.assertEqual(a['time_rows'][1]['hours'], 7.0)
        self.assertEqual(a['time_rows'][1]['billable'], 6.0)
        self.assertEqual(a['time_rows'][1]['index'], 2)
        self.assertEqual(len(a['sha256']), 64)

    def test_old_style_labels_and_five_column_table(self):
        path = write_docx(os.path.join(self.tmp, 'Daily Agenda- Test Intern [October 12, 2026].docx'), OLD_STYLE, OLD_TABLE)
        a = parse_agenda(path)
        self.assertEqual(a['role'], 'intern')
        self.assertEqual(len(a['blocks']), 1)
        b = a['blocks'][0]
        self.assertEqual(b['transaction'], 'Zorlu')
        self.assertEqual(b['scope'], 'Revising the carbon credits response.')
        self.assertEqual(b['complete'], 'Revised Carbon Credits response.')
        self.assertEqual(b['day'], 'Revised response.')
        self.assertEqual(b['status'], 'Pending with me.')
        self.assertEqual(a['timesheet_date'], date(2026, 10, 8))
        self.assertEqual(len(a['time_rows']), 2)       # Total and Percentage rows are not data
        self.assertEqual(a['time_rows'][1]['hours'], 8.0)
        self.assertIsNone(a['time_rows'][1]['billable'])

    def test_founders_desk_has_no_deliverables(self):
        paras = ['Founder’s Desk Daily Agenda', 'Date: October 22, 2026', 'Prepared By: Test Person', 'Discussions',
                 'Transaction: PTQ', 'Matter: Discussion with Boss.', 'Team Members: A, B.', 'Directon: To be discussed.']
        path = write_docx(os.path.join(self.tmp, "Founder's Desk Daily Agenda - Test Person [October 22, 2026].docx"), paras)
        a = parse_agenda(path)
        self.assertEqual(a['variant'], 'founders_desk')
        self.assertEqual(a['blocks'], [])
        self.assertEqual(a['discussion_blocks'], 1)
        self.assertEqual(a['time_rows'], [])

    def test_timesheet_with_date_column_and_title_row(self):
        paras = ['Daily Agenda', 'Date: October 15, 2026', 'Analyst: Test Person', 'Deliverables',
                 'Transaction: MEW', 'Scope of Task: Finalise the amendment.', 'Complete Deliverable: Finalised amendment.',
                 'Day Deliverable: Finalised amendment.', 'Daily Timesheet']
        rows = [['Test Person Timesheet – October 14, 2026'],
                ['Sr. No.', 'Date', 'Transaction', 'Matter & Description', 'No. Of Hours', 'Billable Hours', 'AK Billable Hours'],
                ['1.', 'October 14, 2026', 'MEW', 'Worked on the amendment.', '7.0', '-', '-'],
                ['Total Hours – October 14, 2026', '7.0', '-', '-']]
        path = write_docx(os.path.join(self.tmp, 'Daily Agenda - Test Person [October 15, 2026].docx'), paras, rows)
        a = parse_agenda(path)
        self.assertEqual(len(a['time_rows']), 1)
        self.assertEqual(a['time_rows'][0]['date'], date(2026, 10, 14))
        self.assertEqual(a['timesheet_date'], date(2026, 10, 14))

    def test_file_names(self):
        self.assertEqual(parse_file_name('Daily Agenda - Moiz Ali Khan [October 30, 2026].docx'), ('Moiz Ali Khan', date(2026, 10, 30), 'agenda'))
        self.assertEqual(parse_file_name('Daily Agenda - Haya Ansari[October 15, 2026].docx')[0], 'Haya Ansari')
        self.assertEqual(parse_file_name('Revised Daily Agenda - Usama Siddiqui [October 14, 2026].docx')[2], 'revised')
        self.assertEqual(parse_file_name('Daily Agenda - Rayyan Islam [October 21 2026].docx')[1], date(2026, 10, 21))
        self.assertEqual(parse_date('November 07- 08, 2025'), date(2025, 11, 7))
        self.assertIsNone(parse_date('no date here'))


if __name__ == '__main__':
    unittest.main()
