import unittest

import helpers  # noqa: F401  (puts the package on the path)
from intake import names
from intake.match import Matcher
from test_names import FakeDb, MadeUpConfig, OfflineDb, hub_tables

ROWS = [
    {'id': 'r1', 'client': 'Asian Development Bank', 'project': 'M6 Motorway', 'deliverable': 'Term Sheet', 'archived_at': None},
    {'id': 'r2', 'client': 'Asian Development Bank', 'project': 'M6 Motorway', 'deliverable': 'Complete RFP for Section 1', 'archived_at': None},
    {'id': 'r3', 'client': 'Asian Development Bank', 'project': 'M6 Motorway', 'deliverable': 'Complete RFP for Section 2', 'archived_at': None},
    {'id': 'r4', 'client': 'Asian Development Bank', 'project': 'M6 Motorway', 'deliverable': 'Concession Agreement for Section 1 and Section 2', 'archived_at': None},
    {'id': 'r5', 'client': 'Asian Development Bank', 'project': 'M6 Motorway', 'deliverable': 'O&M RFID Agreement', 'archived_at': None},
    {'id': 'r6', 'client': 'Asian Development Bank', 'project': 'M6 Motorway', 'deliverable': 'Continuation of comments for Sr. No. 46 above', 'archived_at': None},
    {'id': 'r7', 'client': 'Zorlu Enerji', 'project': 'Zorlu Group Matters', 'deliverable': 'Response to the CPPA-G Letter on Carbon Credits', 'archived_at': None},
    {'id': 'r8', 'client': 'JN & Co', 'project': 'PTQ Expressway', 'deliverable': 'Escrow Agreement', 'archived_at': None},
]


class MatcherTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = Matcher()

    def test_transaction_aliases(self):
        for text, code in (('ADB – M6', 'ADB'), ('M6.', 'ADB'), ('M6 - ADB', 'ADB'), ('PTQ – Financing Workstream', 'PTQ'),
                           ('MEW – RFID Amendments', 'MEW'), ('Maxam – Explsoives Workstream', 'MXM'), ('Sapphire DD', 'SP'),
                           ('Osler – OCG', 'OCG'), ('OGC Project', 'OCG'), ('KPK Project Carbon', 'KPK'), ('SADB - SITE', 'SADB')):
            entry, score = self.m.resolve_transaction(text)
            self.assertIsNotNone(entry, text)
            self.assertEqual(entry['code'], code, text)
            self.assertGreaterEqual(score, 0.8, text)

    def test_unknown_transaction(self):
        entry, score = self.m.resolve_transaction('Dada Partners')
        self.assertLess(score, 0.6)
        self.assertTrue(self.m.is_internal('Internal'))
        self.assertTrue(self.m.is_internal('AKLA Project Hub AI'))
        self.assertTrue(self.m.is_internal('N/A.'))

    def test_candidates_cover_both_spellings_and_skip_continuations(self):
        entry, _ = self.m.resolve_transaction('M6')
        ids = {r['id'] for r in self.m.candidate_rows(ROWS, entry)}
        self.assertEqual(ids, {'r1', 'r2', 'r3', 'r4', 'r5'})

    def test_deliverable_match_prefers_the_named_document(self):
        entry, _ = self.m.resolve_transaction('ADB – M6')
        rows = self.m.candidate_rows(ROWS, entry)
        row, score, _ = self.m.match_row(['The Finalized M6 Concession Agreement.', 'The Finalized M6 Concession Agreement.', ''], rows, 'ADB – M6')
        self.assertEqual(row['id'], 'r4')
        self.assertGreaterEqual(score, 0.75)
        row, score, _ = self.m.match_row(['The Amended Term Sheet and CA.', '', ''], rows, 'M6')
        self.assertEqual(row['id'], 'r1')
        self.assertGreaterEqual(score, 0.75)

    def test_tie_between_two_rows_is_unsure(self):
        entry, _ = self.m.resolve_transaction('M6')
        rows = self.m.candidate_rows(ROWS, entry)
        row, score, ranked = self.m.match_row(['Finalised RFP.', 'Finalised RFP.', ''], rows, 'M6')
        self.assertIn(row['id'], ('r2', 'r3'))
        self.assertEqual(self.m.grade(1.0, score), 'unsure')
        self.assertEqual({r['id'] for _, r in ranked[:2]}, {'r2', 'r3'})

    def test_no_match_when_nothing_shared(self):
        entry, _ = self.m.resolve_transaction('M6')
        rows = self.m.candidate_rows(ROWS, entry)
        row, score, _ = self.m.match_row(['The Bridgefactor Meeting.', '', ''], rows, 'M6')
        self.assertEqual(self.m.grade(1.0, score), 'none')

    def test_matter_rules(self):
        self.assertEqual(self.m.matter_for('JN & Co', 'PTQ Expressway', 'Escrow Agreement'), 'eb364b66-f9c6-4770-bc0e-d502225d512b')
        self.assertEqual(self.m.matter_for('JN & Co', 'PTQ Expressway', 'Price Escalation Agreement'), 'ec4863c7-c818-45f1-b9cc-ef69523537ca')
        self.assertEqual(self.m.matter_for('Asian Development Bank', 'M6 Motorway', 'PC Ordinance Second Amendment Bill'), 'a2e5c618-c049-457c-b46e-a27798566566')
        self.assertIsNone(self.m.matter_for('Zia Sb', 'CDA Waste Project', 'Risk Allocation Matrix'))

    def test_people(self):
        self.assertEqual(self.m.split_team('AQ, AS, HK'), ['Ayaan Qureshi', 'Areen Shah', 'Huroom Khan'])
        self.assertEqual(self.m.split_team('Usama Siddiqui\n\nRumaissa'), ['Usama Siddiqui', 'Rumaisa Hussain'])
        self.assertEqual(self.m.split_team('Ayaan Qureshi Rayyan Haya Huroom'), ['Ayaan Qureshi', 'Rayyan Islam', 'Haya Ansari', 'Huroom Khan'])
        self.assertEqual(self.m.split_team('Rayaan Islam\n\nHamza Yousuf'), ['Rayyan Islam', 'Hamza Yousuf'])
        self.assertEqual(self.m.person('Rumaisah Hussain'), 'Rumaisa Hussain')

    def test_entries_keep_their_phase_one_keys_and_gain_name_and_matters(self):
        for entry in self.m.entries:
            for key in ('code', 'pairs', 'aliases', 'name', 'matters'):
                self.assertIn(key, entry)
            self.assertTrue(entry['name'])
            if entry.get('matter_id'):
                self.assertEqual(entry['matters'][0], entry['matter_id'])
            for rule in entry.get('matter_rules', []):
                self.assertIn(rule['matter_id'], entry['matters'])
        entry = self.m.entry_for_code('ptq')
        self.assertEqual(entry['code'], 'PTQ')
        self.assertEqual(self.m.matter_for_code('PTQ'), 'ec4863c7-c818-45f1-b9cc-ef69523537ca')
        self.assertEqual(self.m.matter_for_code('PTQ', 'Escrow Agreement (clean)'), 'eb364b66-f9c6-4770-bc0e-d502225d512b')
        self.assertIsNone(self.m.matter_for_code('MEW'))               # a sheet transaction with no Hub project
        self.assertIsNone(self.m.entry_for_code('NOPE'))
        self.assertIsNone(self.m.matter_for_code('NOPE', 'anything'))

    def test_a_coded_transaction_with_no_sheet_rows_is_known_by_code_only(self):
        # the Filer's codes the sheet has no rows for: found by code, never by resolve_transaction
        self.assertTrue(self.m.dormant)
        for code, entry in self.m.dormant.items():
            self.assertIs(self.m.entry_for_code(code), entry)
            self.assertIsNone(self.m.matter_for_code(code))
            self.assertEqual((entry['pairs'], entry['matters']), ([], []))
            self.assertIn(entry, self.m.entries)                       # listed with the rest, for a reader
            for name in (entry['name'], code):
                found, _ = self.m.resolve_transaction(name)
                self.assertIsNot(found, entry)
        self.assertEqual(self.m.transactions(), self.m.entries)


class OverlayTest(MadeUpConfig):
    """Matcher(db): the Hub's projects and project_names laid over the YAML (a made-up one here)."""

    def test_no_db_and_an_offline_db_are_the_yaml_alone(self):
        plain, offline = Matcher(), Matcher(OfflineDb())
        self.assertFalse(offline.overlaid)
        self.assertEqual([e['aliases'] for e in plain.entries], [e['aliases'] for e in offline.entries])
        self.assertEqual([e['code'] for e in plain.entries], ['ALP', 'BET', 'GAM', 'DE'])
        self.assertEqual(sorted(plain.dormant), ['DE', 'GAM'])
        self.assertEqual([e['code'] for e in plain.entries if e.get('dormant')], ['GAM', 'DE'])
        self.assertEqual(plain.entries[0]['matters'], ['m-alpha', 'm-alpha-escrow'])
        self.assertEqual(plain.entries[0]['name'], 'Alpha Bridge')
        self.assertEqual(plain.resolve_transaction('Gamma Mining'), (None, 0.0))

    def test_the_overlay_is_two_reads(self):
        db = FakeDb(**hub_tables())
        Matcher(db)
        self.assertEqual([table for table, _, _ in db.selects], ['matters', 'project_names'])

    def test_a_name_on_the_hub_makes_an_unknown_string_resolve(self):
        self.assertLess(Matcher().resolve_transaction('Riverside Link')[1], 0.8)
        db = FakeDb(**hub_tables(project_names=[{'matter_id': 'm-alpha', 'name': 'Riverside Link', 'kind': 'learned'}]))
        m = Matcher(db)
        entry, score = m.resolve_transaction('Riverside Link – Financing')
        self.assertEqual((entry['code'], entry['matter_id']), ('ALP', 'm-alpha'))
        self.assertGreaterEqual(score, 0.8)
        # the Hub project's own name counts as one of its names too
        self.assertEqual(m.resolve_transaction('Alpha Bridge Concession')[1], 1.0)
        self.assertTrue(m.overlaid)

    def test_a_contains_name_sends_a_deliverable_to_the_sister_project(self):
        db = FakeDb(**hub_tables(
            matters=[{'id': 'm-alpha', 'name': 'Alpha Bridge Concession', 'code': 'ALP'},
                     {'id': 'm-alpha-escrow', 'name': 'Alpha Bridge Escrow', 'code': 'ALP'},
                     {'id': 'm-alpha-toll', 'name': 'Alpha Tolling', 'code': 'ALP'}],
            project_names=[{'matter_id': 'm-alpha-toll', 'code': 'ALP', 'name': 'Toll Collection', 'kind': 'contains'}]))
        m = Matcher(db)
        self.assertEqual(m.matter_for_code('ALP', 'Draft toll collection agreement v3'), 'm-alpha-toll')
        self.assertEqual(m.matter_for_code('ALP', 'Concession Agreement'), 'm-alpha')
        self.assertEqual(m.matter_for_code('ALP', 'Escrow Agreement'), 'm-alpha-escrow')      # the YAML's own rule still holds
        self.assertEqual(m.matter_for_code('ALP'), 'm-alpha')
        self.assertEqual(m.matter_for('NRA', 'Alpha Bridge', 'Toll Collection Agreement'), 'm-alpha-toll')
        self.assertEqual(m.entry_for_code('ALP')['matters'], ['m-alpha', 'm-alpha-escrow', 'm-alpha-toll'])

    def test_a_name_under_a_bare_code_is_usable_once_the_code_is_adopted(self):
        db = FakeDb(**hub_tables(project_names=[{'code': 'GAM', 'name': 'Quarry Deal'}]))
        m = Matcher(db)
        self.assertIn('quarry deal', m.entry_for_code('GAM')['aliases'])       # known as the code's name
        self.assertIsNone(m.matter_for_code('GAM'))                           # but there is no project to file under
        self.assertEqual(m.resolve_transaction('Quarry Deal'), (None, 0.0))
        self.assertEqual(m.dormant_for('Quarry Deal – licence')['code'], 'GAM')

        db.insert('matters', {'id': 'm-gamma', 'name': 'Gamma Mining', 'code': 'GAM'})
        names.adopt_code(db, 'GAM', 'm-gamma')
        m = Matcher(db)
        entry, score = m.resolve_transaction('Quarry Deal')
        self.assertEqual((entry['code'], entry['matter_id'], score), ('GAM', 'm-gamma', 1.0))
        self.assertEqual(m.matter_for_code('gam', 'anything'), 'm-gamma')
        self.assertNotIn('GAM', m.dormant)

    def test_a_yaml_project_the_hub_no_longer_has_is_forgotten(self):
        db = FakeDb(**hub_tables(matters=[{'id': 'm-alpha-escrow', 'name': 'Alpha Bridge Escrow'}]))
        m = Matcher(db)
        entry = m.entry_for_code('ALP')
        self.assertEqual(entry['matters'], ['m-alpha-escrow'])
        self.assertIsNone(m.matter_for_code('ALP', 'Concession Agreement'))      # m-alpha is gone: nothing to file under
        self.assertEqual(m.matter_for_code('ALP', 'Escrow Agreement'), 'm-alpha-escrow')
        self.assertIsNone(m.matter_for('NRA', 'Alpha Bridge', 'Concession Agreement'))
        self.assertEqual(Matcher().matter_for_code('ALP'), 'm-alpha')            # the YAML alone cannot know

    def test_a_coded_project_gives_a_yaml_entry_its_project(self):
        self.assertIsNone(Matcher().matter_for('Harbour Co', 'Beta Port', 'Lease'))
        db = FakeDb(**hub_tables(matters=[{'id': 'm-beta', 'name': 'Beta Port Expansion', 'code': 'BET'}]))
        m = Matcher(db)
        self.assertEqual(m.matter_for('Harbour Co', 'Beta Port', 'Lease'), 'm-beta')
        self.assertEqual(m.entry_for_code('BET')['matters'], ['m-beta'])
        self.assertEqual(m.matter_for_code('BET'), 'm-beta')

    def test_a_hub_project_the_yaml_does_not_know_is_found_by_its_name(self):
        db = FakeDb(**hub_tables(
            clients=[{'id': 'c-z', 'name': 'Zenith Holdings'}],
            matters=[{'id': 'm-zen', 'name': 'Zenith Solar Park', 'client_id': 'c-z'},
                     {'id': 'm-lone', 'name': 'Lone Pine Advisory'}],
            project_names=[{'matter_id': 'm-zen', 'name': 'ZSP'}, {'matter_id': 'm-lone', 'name': 'LP Trust / Pine Advisory', 'kind': 'sheet'}]))
        m = Matcher(db)
        entry, score = m.resolve_transaction('Zenith Solar Park')
        self.assertEqual((entry['code'], entry['matter_id'], entry['matters'], score), (None, 'm-zen', ['m-zen'], 1.0))
        self.assertEqual(entry['pairs'], [('Zenith Holdings', 'Zenith Solar Park')])     # its client and its own name
        self.assertEqual(m.resolve_transaction('ZSP – EPC')[0]['matter_id'], 'm-zen')
        self.assertEqual(m.matter_for('Zenith Holdings', 'Zenith Solar Park', 'EPC Contract'), 'm-zen')
        lone = m.entry_for_pair('LP Trust', 'Pine Advisory')                                # a 'sheet' name is a pair
        self.assertEqual((lone['matter_id'], lone['pairs']), ('m-lone', [('LP Trust', 'Pine Advisory')]))
        rows = [{'id': 'r1', 'client': 'LP Trust', 'project': 'Pine Advisory', 'deliverable': 'Opinion', 'archived_at': None}]
        self.assertEqual(m.candidate_rows(rows, lone), rows)

    def test_a_two_letter_name_counts_whole_or_not_at_all(self):
        db = FakeDb(**hub_tables(matters=[{'id': 'm-delta', 'name': 'Delta Energy', 'code': 'DE'}]))
        m = Matcher(db)
        self.assertEqual(m.resolve_transaction('DE')[0]['matter_id'], 'm-delta')
        self.assertEqual(m.resolve_transaction('DE – Tariff Petition')[0]['matter_id'], 'm-delta')
        entry, score = m.resolve_transaction('Sale de novo')
        self.assertLess(score, 0.8)

    def test_a_second_code_reaches_a_project_through_its_names(self):
        # "It's this project": the Gamma code's names were moved onto the Alpha project, which keeps its own code
        db = FakeDb(**hub_tables(
            matters=[{'id': 'm-alpha', 'name': 'Alpha Bridge Concession', 'code': 'ALP'}],
            project_names=[{'matter_id': 'm-alpha', 'code': 'GAM', 'name': 'GAM'}]))
        m = Matcher(db)
        self.assertEqual(m.matter_for_code('GAM'), 'm-alpha')
        self.assertEqual(m.matter_for_code('ALP'), 'm-alpha')

    def test_near_offers_a_project_with_a_close_name(self):
        db = FakeDb(**hub_tables(matters=[{'id': 'm-osl', 'name': 'Osler Cardiovascular Group'},
                                          {'id': 'm-rail', 'name': 'Pakistan Railways PPP'}]))
        m = Matcher(db)
        self.assertLess(m.resolve_transaction('OSLER')[1], 0.8)
        self.assertEqual([(mid, name) for mid, name, _ in m.near('OSLER')], [('m-osl', 'Osler Cardiovascular Group')])
        self.assertEqual(m.near('Pakistan Cricket Board'), [])
        self.assertEqual(m.near('Quartz Harbour Holdings'), [])

    def test_learn_project_updates_the_matcher_mid_run(self):
        m = Matcher(FakeDb(**hub_tables()))
        m.learn_project('m-gamma', 'Gamma Mining', 'GAM', 'Gamma Minerals Ltd', ['Quarry Deal'])
        self.assertEqual(m.matter_for_code('GAM'), 'm-gamma')
        self.assertEqual(m.resolve_transaction('Quarry Deal')[0]['matter_id'], 'm-gamma')
        m.learn_project('m-new', 'Brand New Thing', None, 'Someone')
        self.assertEqual(m.resolve_transaction('Brand New Thing')[0]['matter_id'], 'm-new')


if __name__ == '__main__':
    unittest.main()
