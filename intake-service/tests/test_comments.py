import unittest
from datetime import date
from zoneinfo import ZoneInfo

import helpers  # noqa: F401  (puts the package on the path)
from intake.comments import format_line, line_key, rebuild_comments, split_comments

TZ = ZoneInfo('Asia/Karachi')
CELL = ('September 24, 2026 - Memorandum prepared. Scope to be added.\n\n'
        'September 26, 2026 [10:06 - Usama] - Team, please mention the latest status.\n\n'
        'October 09, 2026 [09:05 - Usama] - No change since the last update.')


class CommentsTest(unittest.TestCase):
    def test_split(self):
        lines = split_comments(CELL, TZ)
        self.assertEqual(len(lines), 3)
        self.assertIsNone(lines[0]['author'])
        self.assertEqual(lines[0]['at'].isoformat(), '2026-09-24T00:00:00+05:00')
        self.assertEqual(lines[1]['author'], 'Usama')
        self.assertEqual(lines[1]['at'].isoformat(), '2026-09-26T10:06:00+05:00')
        self.assertEqual(lines[2]['body'], 'No change since the last update.')

    def test_round_trip(self):
        self.assertEqual(rebuild_comments(split_comments(CELL, TZ), TZ), CELL)

    def test_other_stamp_forms_round_trip(self):
        for text in ('October 12, 2026 [Umer] - Draft memo in progress.',
                     'September 25, 2026 [09:31] - Messaged the client.',
                     'October 14, 2026 [12:05 - Usama] - Boss to review.'):
            self.assertEqual(rebuild_comments(split_comments(text, TZ), TZ), text)

    def test_lines_without_blank_line_between_and_typos(self):
        text = 'Ocotber 12, 2026 [Umer]- First line.\nOctober 13, 2026 [Umer]- Second line.'
        lines = split_comments(text, TZ)
        self.assertEqual([l['body'] for l in lines], ['First line.', 'Second line.'])
        self.assertEqual(lines[0]['at'].month, 10)

    def test_undated_text_uses_fallback_date(self):
        lines = split_comments('Sign off by Boss', TZ, fallback_date=date(2026, 9, 24))
        self.assertEqual(lines[0]['at'].date(), date(2026, 9, 24))
        self.assertEqual(format_line(lines[0]['at'], None, lines[0]['body'], TZ), 'September 24, 2026 - Sign off by Boss')

    def test_continuation_joins_previous_line(self):
        lines = split_comments('October 09, 2026 [09:05 - Usama] - First.\n\nmore words for the first', TZ)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]['body'], 'First.\nmore words for the first')

    def test_first_name_in_stamp(self):
        lines = split_comments('October 09, 2026 [09:05 - Usama] - x', TZ)
        self.assertEqual(format_line(lines[0]['at'], 'Moiz Ali Khan', 'Done.', TZ), 'October 09, 2026 [09:05 - Moiz] - Done.')

    def test_line_key_ignores_case_and_spacing(self):
        a = split_comments('October 09, 2026 [09:05 - Usama] - No  change.', TZ)[0]
        b = split_comments('October 09, 2026 - no change.', TZ)[0]
        self.assertEqual(line_key(a['at'], a['body']), line_key(b['at'], b['body']))


if __name__ == '__main__':
    unittest.main()
