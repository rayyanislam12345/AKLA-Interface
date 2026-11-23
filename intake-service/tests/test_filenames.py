"""The Python port of src/lib/fileNames.ts reads names as the site does (cases from
tests/fileNames.test.js), and reads the Filer's own "-A" names too. Titles are invented."""
import unittest

import helpers  # noqa: F401  (puts the package on the path)
from intake import filenames as fn
from intake.filenames import find_date, find_matching_document, parse_file_name, parse_filer_name, title_similarity

KEYS = ('title', 'code', 'seq', 'tags', 'stage', 'date', 'rendition', 'duplicate', 'family_key')


def pick(parsed):
    return {k: parsed[k] for k in KEYS}


class FirmGrammarTest(unittest.TestCase):
    def test_code_title_holder_stage_and_date(self):
        self.assertEqual(pick(parse_file_name('KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026].docx')), {
            'title': 'USP Memorandum', 'code': 'KPT', 'seq': '5.7', 'tags': ['For Boss Review'],
            'stage': 'For partner review', 'date': '2026-09-26', 'rendition': None, 'duplicate': False,
            'family_key': 'usp memorandum'})
        self.assertEqual(pick(parse_file_name('PI3.1 - Schedule 4 [Claude Markup][September 17, 2026].docx')), {
            'title': 'Schedule 4', 'code': 'PI', 'seq': '3.1', 'tags': ['Claude Markup'], 'stage': 'AI markup',
            'date': '2026-09-17', 'rendition': None, 'duplicate': False, 'family_key': 'schedule 4'})
        self.assertEqual(pick(parse_file_name('SP3A - DD Volume III [AKLA][Second Circ Version][September 03, 2026].docx')), {
            'title': 'DD Volume III', 'code': 'SP', 'seq': '3A', 'tags': ['AKLA', 'Second Circ Version'],
            'stage': 'Circulated', 'date': '2026-09-03', 'rendition': None, 'duplicate': False,
            'family_key': 'dd volume iii'})

    def test_version_labels_are_short_and_plain(self):
        label = lambda name: fn.version_label(parse_file_name(name))
        self.assertEqual(label('KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026].docx'),
                         'For partner review · 26 Sep 2026')
        self.assertEqual(label('PI3.1 - Schedule 4 [Claude Markup][September 17, 2026].docx'), 'AI markup · 17 Sep 2026')
        self.assertEqual(label('SPA [Execution Version][June 4, 2026] - Clean.docx'), 'Execution · 4 Jun 2026 · Clean')
        self.assertEqual(label('Plain file.pdf'), '')

    def test_drift_bracket_typos_missing_brackets_squashed_dates_double_spaces(self):
        typo = parse_file_name('SP3A - DD Volume III [AKLA}[Second Circ Version][September 03, 2026].docx')
        self.assertEqual(typo['tags'], ['AKLA', 'Second Circ Version'])
        self.assertEqual(typo['title'], 'DD Volume III')

        missing = parse_file_name('Share Purchase Agreement [AKLA Draft]]June 04, 2026].docx')
        self.assertEqual(missing['title'], 'Share Purchase Agreement')
        self.assertEqual(missing['date'], '2026-06-04')

        squashed = parse_file_name('MM5 - Minutes of Meeting [AKLA] 30May, 2025.docx')
        self.assertEqual(squashed['title'], 'Minutes of Meeting')
        self.assertEqual(squashed['date'], '2025-05-30')

        spaces = parse_file_name('KPT5.7  -  USP   Memorandum  [For Boss Review] [September 26, 2026].docx')
        self.assertEqual(spaces['title'], 'USP Memorandum')
        self.assertEqual(spaces['family_key'], 'usp memorandum')

        unbracketed = parse_file_name('Revised v7 - JVA June 2, 2025.docx')
        self.assertEqual(unbracketed['title'], 'JVA')
        self.assertEqual(unbracketed['date'], '2025-06-02')
        self.assertEqual(unbracketed['version'], 7)

    def test_four_spellings_of_circulation(self):
        for tag in ('Circulation Version', '1st Cir', '2nd Cir Ver', 'Final Circ Version', 'Curculated', 'Circulated'):
            self.assertEqual(parse_file_name(f'NSCL8 - Term Sheet [{tag}][May 5, 2026].docx')['stage'], 'Circulated', tag)

    def test_stage_vocabulary(self):
        stage_of = lambda tag: parse_file_name(f'X1 - Lease [{tag}].docx')['stage']
        self.assertEqual(stage_of('WD'), 'Working draft')
        self.assertEqual(stage_of('First Draft'), 'Working draft')
        self.assertEqual(stage_of('AKLA Draft'), 'Working draft')
        self.assertEqual(stage_of('For Boss Review'), 'For partner review')
        self.assertEqual(stage_of('2nd Rec'), 'Received')
        self.assertEqual(stage_of('Second Received'), 'Received')
        self.assertEqual(stage_of('Client Comments'), 'Client comments')
        self.assertEqual(stage_of('Compared against AKLA First Circulated Draft'), 'Compared')
        self.assertEqual(stage_of('Pre-Execution Version'), 'Execution')
        self.assertEqual(stage_of('Execution Version'), 'Execution')
        self.assertEqual(stage_of('Final'), 'Final')
        self.assertEqual(stage_of('US Claude 1st Markup'), 'AI markup')
        self.assertIsNone(stage_of('AKLA'))
        # A later stage wins when a name carries two.
        self.assertEqual(parse_file_name('X1 - Lease [AKLA Draft][Execution Version].docx')['stage'], 'Execution')

    def test_renditions_and_browser_duplicates_leave_the_title(self):
        a = parse_file_name('AM44.1 - Concession Agreement [2nd Cir Ver][March 2, 2026] - Track (2).docx')
        self.assertEqual((a['title'], a['rendition'], a['duplicate']), ('Concession Agreement', 'tracked', True))
        b = parse_file_name('NED Term Sheet [Execution Version] (tracked changes) (tracked changes).docx')
        self.assertEqual((b['title'], b['rendition']), ('NED Term Sheet', 'tracked'))
        self.assertEqual(parse_file_name('SPA - Clean.docx')['rendition'], 'clean')
        self.assertEqual(parse_file_name('SPA - Compared.pdf')['rendition'], 'compared')
        self.assertEqual(parse_file_name('Clean - SPA [Final].docx')['title'], 'SPA')
        self.assertEqual(parse_file_name('Clean - SPA [Final].docx')['rendition'], 'clean')
        dup = parse_file_name('KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026] (1).docx')
        self.assertEqual((dup['duplicate'], dup['title']), (True, 'USP Memorandum'))
        self.assertTrue(parse_file_name('Term Sheet - Copy.docx')['duplicate'])
        self.assertEqual(parse_file_name('Term Sheet - Copy.docx')['title'], 'Term Sheet')

    def test_ordinals_uuids_and_plain_names(self):
        self.assertEqual(parse_file_name('5. NED Term Sheet [AKLA].docx')['title'], 'NED Term Sheet')
        self.assertEqual(parse_file_name('11. SPA.docx')['title'], 'SPA')
        self.assertEqual(parse_file_name('3f2c1e4a-1b2c-4d5e-8f90-123456789abc-Lease Deed.pdf')['title'], 'Lease Deed')
        plain = parse_file_name('Board Resolution.pdf')
        self.assertEqual((plain['title'], plain['code'], plain['extension']), ('Board Resolution', None, 'pdf'))
        self.assertEqual(parse_file_name('folder/sub/PI1 - Construction Contract.docx')['title'], 'Construction Contract')
        # A decimal in a title is not an extension.
        self.assertEqual(parse_file_name('Clause 4.2 Notes')['title'], 'Clause 4.2 Notes')

    def test_dates_in_the_firms_styles(self):
        self.assertEqual(find_date('Jan 1, 2025')['iso'], '2025-01-01')
        self.assertEqual(find_date('Sept 9 2026')['iso'], '2026-09-09')
        self.assertEqual(find_date('30May, 2025')['iso'], '2025-05-30')
        self.assertEqual(find_date('14-03-2024')['iso'], '2024-03-14')
        self.assertEqual(find_date('14.03.24')['iso'], '2024-03-14')
        self.assertEqual(find_date('2026-01-14')['iso'], '2026-01-14')
        self.assertIsNone(find_date('February 30, 2026'))
        self.assertIsNone(find_date('Summary 2026'))
        self.assertIsNone(parse_file_name('PI3.1 - Schedule 4.docx')['date'])

    def test_family_key(self):
        self.assertEqual(fn.family_key_of('Escrow Agreement – Amendment I'), 'escrow agreement amendment i')
        self.assertEqual(fn.family_key_of('Licence & IE Agreements'), 'licence and ie agreements')
        self.assertEqual(fn.family_key_of('Café  Lease_Deed'), 'cafe lease deed')
        self.assertEqual(fn.family_key_of(''), '')


class MatchingTest(unittest.TestCase):
    DOCS = [{'id': 'a', 'title': 'USP Memorandum'},
            {'id': 'b', 'title': 'KPT5.7 - Share Purchase Agreement [AKLA]'},
            {'id': 'c', 'title': 'Schedule 5'},
            {'id': 'd', 'title': 'DD Volume II'}]

    def test_exact_close_and_none(self):
        exact = find_matching_document('usp memorandum', self.DOCS)
        self.assertEqual((exact['document']['id'], exact['exact'], exact['score']), ('a', True, 1.0))
        # A title typed in as a raw file name still matches.
        self.assertEqual(find_matching_document('share purchase agreement', self.DOCS)['document']['id'], 'b')
        # Close: one extra word.
        close = find_matching_document('share purchase agreement execution', self.DOCS)
        self.assertEqual((close['document']['id'], close['exact']), ('b', False))
        self.assertAlmostEqual(close['score'], 6 / 7)
        # Different numbers are different documents.
        self.assertIsNone(find_matching_document('schedule 4', self.DOCS))
        self.assertIsNone(find_matching_document('dd volume iii', self.DOCS))
        self.assertIsNone(find_matching_document('', self.DOCS))
        self.assertGreater(title_similarity('civil appeal memo', 'civil appeal memo note'), 0.75)

    def test_dice_threshold_and_numbers(self):
        self.assertEqual(title_similarity('escrow agreement', 'escrow agreement'), 1.0)
        self.assertEqual(title_similarity('escrow agreement amendment i', 'escrow agreement amendment ii'), 0.0)
        self.assertEqual(title_similarity('schedule 4a', 'schedule 4b'), 0.0)
        self.assertEqual(title_similarity('the escrow agreement', 'escrow agreement of the'), 1.0)   # little words do not count
        self.assertLess(title_similarity('escrow agreement', 'escrow account opening form'), 0.75)

    def test_a_hub_title_that_is_a_filer_name_still_matches(self):
        docs = [{'id': 'x', 'title': 'PTQ-A28 - Escrow Agreement [AKLA][Mark-up][October 17, 2026]'}]
        found = find_matching_document('escrow agreement', docs)
        self.assertEqual((found['document']['id'], found['exact']), ('x', True))


class FilerNamesTest(unittest.TestCase):
    def test_parse_file_name_accepts_the_filers_own_sequence(self):
        own = parse_file_name('PTQ-A28 - Escrow Agreement [AKLA][Mark-up][October 17, 2026][Version 2].docx')
        self.assertEqual((own['code'], own['seq'], own['marker'], own['title']), ('PTQ', '28', 'A', 'Escrow Agreement'))
        self.assertEqual((own['date'], own['version'], own['extension']), ('2026-10-17', 2, 'docx'))
        self.assertEqual(own['tags'], ['AKLA', 'Mark-up'])
        self.assertEqual(own['family_key'], 'escrow agreement')
        firm = parse_file_name('PTQ28 - Escrow Agreement [AKLA][Mark-up][October 17, 2026].docx')
        self.assertEqual((firm['code'], firm['seq'], firm['marker'], firm['title']), ('PTQ', '28', None, 'Escrow Agreement'))
        self.assertEqual(firm['family_key'], own['family_key'])

    def test_parse_filer_name(self):
        p = parse_filer_name('PTQ-A28 - Escrow Agreement [AKLA][Mark-up][October 17, 2026][Version 2].docx')
        self.assertEqual(p, {'code': 'PTQ', 'number': '28', 'marker': 'A', 'own': True, 'title': 'Escrow Agreement',
                             'party': 'AKLA', 'status': 'Mark-up', 'date': '2026-10-17', 'version': 2,
                             'extension': 'docx', 'family_key': 'escrow agreement'})
        q = parse_filer_name('MEW10 - Concession Agreement [Lender][Execution Version][October 13, 2026].pdf')
        self.assertEqual((q['code'], q['number'], q['own'], q['party'], q['status'], q['date'], q['version']),
                         ('MEW', '10', False, 'Lender', 'Execution Version', '2026-10-13', None))
        # Empty parts are left out of a Filer name.
        r = parse_filer_name('ADB-A3 - Side Letter [Received][October 08, 2026].pdf')
        self.assertEqual((r['party'], r['status'], r['date']), (None, 'Received', '2026-10-08'))
        s = parse_filer_name('ADB-A4 - Side Letter – Annex.pdf')
        self.assertEqual((s['title'], s['party'], s['status'], s['date']), ('Side Letter – Annex', None, None, None))
        self.assertIsNone(parse_filer_name('Board Resolution.pdf'))
        self.assertIsNone(parse_filer_name('MEW - Escrow Agreement [AKLA 13 Oct 2026].docx'))   # no number: not a Filer name

    def test_status_words(self):
        status = fn.status_from_filer_word
        for word in ('Draft', 'First Draft', 'Revised Draft', 'Clean'):
            self.assertEqual(status(word), 'drafting', word)
        for word in ('Mark-up', 'Markup', 'Comments'):
            self.assertEqual(status(word), 'negotiation', word)
        self.assertEqual(status('Received'), 'with_counterparty')
        self.assertEqual(status('Final'), 'finalized')
        self.assertEqual(status('Execution Version'), 'finalized')
        self.assertEqual(status('Executed'), 'executed')
        self.assertEqual(status('signed'), 'executed')
        self.assertIsNone(status('Notes'))
        self.assertIsNone(status(''))
        self.assertIsNone(status(None))
        for word in fn.FILER_STATUS_WORDS:
            self.assertTrue(fn.is_filer_status_word(word))
        self.assertFalse(fn.is_filer_status_word('AKLA'))
        # The site's own mapping, from a stage.
        self.assertEqual(fn.status_from_stage('For partner review'), 'internal_review')
        self.assertEqual(fn.status_from_stage('Execution'), 'executed')
        self.assertIsNone(fn.status_from_stage(None))

    def test_clean_original_name(self):
        self.assertEqual(fn.clean_original_name('00024129-Concession Agreement - Execution Version.docx'),
                         'Concession Agreement - Execution Version')
        self.assertEqual(fn.clean_original_name('Escrow Agreement.pdf'), 'Escrow Agreement')


if __name__ == '__main__':
    unittest.main()
