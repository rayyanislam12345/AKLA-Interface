import unittest

import helpers  # noqa: F401  (puts the package on the path)
from intake.match import Matcher

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


if __name__ == '__main__':
    unittest.main()
