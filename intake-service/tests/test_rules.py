"""The rules a message passes before any model sees it: what is dropped for free, what must
reach Claude, and above all what is withheld. Invented people, firms and subjects throughout."""
import unittest
from datetime import datetime, timezone

import helpers  # noqa: F401  (puts the package on the path)
from intake import config
from intake.rules import DROPPED, READ, WITHHELD, RuleEngine, default_engine

import yaml


def message(sender='gc@northwind-holdings.example', subject='Filing', body='Please file the petition.', *, thread='',
            headers=None, folder='inbox', to=None, cc=None, attachments=None):
    return {'source': 'email', 'key': '<m1@mail.example>', 'conversation': 'c1', 'mailbox': 'associate@akla.com.pk',
            'folder': folder, 'sender_name': '', 'sender_address': sender, 'to': to or ['associate@akla.com.pk'],
            'cc': cc or [], 'sent_at': datetime(2026, 9, 7, 9, 0, tzinfo=timezone.utc), 'subject': subject,
            'newest_text': body, 'thread_text': thread, 'headers': headers or {}, 'attachments': attachments or []}


def rules_file():
    with open(config.CONFIG_DIR + '/mail_rules.yaml', encoding='utf8') as fh:
        return yaml.safe_load(fh)


class PortedOutcomesTest(unittest.TestCase):
    """The Email Bot's expected outcomes (its tests/test_rules.py), in the intake's words."""

    @classmethod
    def setUpClass(cls):
        cls.engine = default_engine()

    def test_newsletter_is_dropped_without_claude(self):
        v = self.engine.evaluate(message('news@retailer.example', '50% off everything this weekend',
                                         'Shop the sale now. Unsubscribe any time.',
                                         headers={'list-unsubscribe': '<https://retailer.example/u>'}))
        self.assertEqual((v.outcome, v.rule), (DROPPED, 'automated_bulk'))

    def test_no_reply_sender_precedence_and_auto_submitted_are_automated(self):
        for kw in ({'sender': 'no-reply@shop.example'}, {'headers': {'precedence': 'Bulk'}},
                   {'headers': {'auto-submitted': 'auto-generated'}}, {'headers': {'list-id': '<x.list.example>'}}):
            v = self.engine.evaluate(message(**dict({'sender': 'someone@shop.example', 'subject': 'Your order',
                                                     'body': 'It has shipped.'}, **kw)))
            self.assertEqual(v.outcome, DROPPED, kw)
        v = self.engine.evaluate(message('someone@shop.example', 'Hello', 'Just saying hello.', headers={'auto-submitted': 'no'}))
        self.assertEqual(v.outcome, READ)

    def test_consumer_domain_mail_with_no_work_signal_is_dropped(self):
        v = self.engine.evaluate(message('mum@gmail.com', 'dinner sunday', 'Are you coming over on Sunday? Bring the kids.'))
        self.assertEqual((v.outcome, v.rule, v.sender_class), (DROPPED, 'personal_domain_no_work_signal', 'personal'))

    def test_court_notice_is_read_even_through_a_mailing_list(self):
        v = self.engine.evaluate(message('noreply@supremecourt.gov.pk', 'Cause list for 9 September',
                                         'The hearing in Writ Petition 4412 is listed before the bench.',
                                         headers={'list-unsubscribe': '<https://court.example/u>'}))
        self.assertEqual((v.outcome, v.rule, v.sender_class), (READ, 'work_signal', 'institutional'))
        self.assertTrue(v.hints.looks_automated)

    def test_regulator_subdomain_counts_as_institutional(self):
        v = self.engine.evaluate(message('alerts@mail.secp.gov.pk', 'Update', 'See the portal.'))
        self.assertEqual((v.outcome, v.sender_class), (READ, 'institutional'))

    def test_consumer_domain_with_legal_content_is_read(self):
        v = self.engine.evaluate(message('client@gmail.com', 'Urgent - settlement agreement',
                                         'We must file the settlement agreement before the deadline tomorrow.'))
        self.assertEqual(v.outcome, READ)
        self.assertIn('settlement', v.hints.legal)
        self.assertIn('deadline', v.hints.deadline)
        self.assertIn('Legal terms found', v.hints.as_prompt_block())

    def test_internal_sender_is_read_like_anyone_else(self):
        v = self.engine.evaluate(message('associate.one@akla.com.pk', 'Draft for review', 'Attached the draft.'))
        self.assertEqual((v.outcome, v.sender_class), (READ, 'internal'))

    def test_unknown_external_sender_is_read(self):
        v = self.engine.evaluate(message('someone@unfamiliar.example', 'Following up', 'Just checking in.'))
        self.assertEqual((v.outcome, v.rule, v.sender_class), (READ, 'escalate', 'external'))

    def test_no_sender_is_unknown_and_read(self):
        v = self.engine.evaluate(message('', 'Following up', 'Just checking in.'))
        self.assertEqual((v.outcome, v.sender_class), (READ, 'unknown'))

    def test_meeting_words_become_hints(self):
        v = self.engine.evaluate(message('pm@builder.example', 'Call', 'Can we reschedule the Zoom to Thursday?'))
        self.assertEqual(sorted(v.hints.meeting), ['reschedule', 'zoom'])

    def test_salary_mail_is_withheld(self):
        v = self.engine.evaluate(message('hr@akla.com.pk', 'Salary revisions for October',
                                         'Please approve the attached salary sheet for the associates.'))
        self.assertEqual((v.outcome, v.rule), (WITHHELD, 'never_share:pay'))

    def test_never_share_beats_a_work_signal(self):
        """'Agreement' is a work signal, but a staff salary agreement is still withheld."""
        v = self.engine.evaluate(message('hr@akla.com.pk', 'Revised salary agreement',
                                         'Revised salary agreement for the associate, for your signature.'))
        self.assertEqual(v.outcome, WITHHELD)

    def test_never_share_addresses_cover_sender_and_recipients(self):
        engine = RuleEngine({'firm_domains': ['akla.com.pk'],
                             'never_share_addresses': ['accountant@books.example', 'family.example']})
        for sender in ('accountant@books.example', 'Sister@Family.example'):
            v = engine.evaluate(message(sender, 'hi', 'x'))
            self.assertEqual((v.outcome, v.rule), (WITHHELD, 'never_share:address'), sender)
        sent = message('partner@akla.com.pk', 'hi', 'x', folder='sentitems', to=['accountant@books.example'])
        self.assertEqual(engine.evaluate(sent).outcome, WITHHELD)
        self.assertEqual(engine.evaluate(message('gc@client.example', 'hi', 'x')).outcome, READ)


class NeverShareTest(unittest.TestCase):
    """The privacy line: pay, HR, health and the partners' own business never go further."""

    @classmethod
    def setUpClass(cls):
        cls.engine = default_engine()
        cls.rules = rules_file()

    def test_every_listed_term_withholds_in_inbox_and_in_sent_items(self):
        count = 0
        for group, terms in self.rules['never_share'].items():
            for term in terms:
                for folder, sender in (('inbox', 'gc@northwind-holdings.example'), ('sentitems', 'partner@akla.com.pk')):
                    # in the body, with a work signal beside it and a client as the other party
                    m = message(sender, 'Draft agreement', f'Following our call, a word on the {term} before the hearing.',
                                folder=folder, to=['gc@northwind-holdings.example'])
                    v = self.engine.evaluate(m)
                    self.assertEqual((v.outcome, v.rule), (WITHHELD, f'never_share:{group}'), (term, folder))
                    count += 1
        self.assertGreaterEqual(count, 50)

    def test_the_contracts_widened_terms_are_all_covered(self):
        """Partners' matters, HR and health, as the contract lists them, each withhold."""
        for text in ("Notes for the partners' meeting on Friday", 'Partners meeting agenda', 'the profit share for the year',
                     'profit-sharing ratios', 'Partner drawings for March', "the partners’ drawings schedule",
                     'our new equity partner', 'year-end bonus', 'bonuses for the team', 'annual increment',
                     'termination of employment of the clerk', 'her resignation letter', 'Leave application for December',
                     'medical report attached', 'on sick leave this week', 'payroll run', 'performance review notes',
                     'disciplinary hearing', 'For your eyes only', 'appraisals are due'):
            for folder in ('inbox', 'sentitems'):
                v = self.engine.evaluate(message('partner@akla.com.pk', 'A note', text, folder=folder,
                                                 to=['colleague@akla.com.pk']))
                self.assertEqual(v.outcome, WITHHELD, (text, folder))

    def test_a_term_anywhere_a_model_would_see_it_withholds(self):
        cases = {
            'subject': message(subject='Bonus letters', body='Please see attached.'),
            'quoted thread': message(subject='Re: follow up', body='Agreed, thank you.',
                                     thread='From: A\nSent: Monday\nThe salary figures are below.'),
            'attachment name': message(subject='For signature', body='Please sign.', attachments=['Salary_Sheet_Oct.xlsx']),
            'across a line break': message(subject='Note', body='Before the partners\'\nmeeting, one point.'),
        }
        for where, m in cases.items():
            self.assertEqual(self.engine.evaluate(m).outcome, WITHHELD, where)

    def test_personal_or_private_and_confidential_in_the_subject_withholds(self):
        for subject in ('Personal', 'PERSONAL: flat purchase', 'Re: personal matter', 'Private and Confidential',
                        'Strictly Private & Confidential - by hand', 'FW: private  and confidential'):
            for folder in ('inbox', 'sentitems'):
                v = self.engine.evaluate(message('gc@northwind-holdings.example', subject, 'Please see the draft agreement.',
                                                 folder=folder))
                self.assertEqual((v.outcome, v.rule), (WITHHELD, 'never_share:marked_private'), (subject, folder))

    def test_those_markings_in_the_body_only_do_not_withhold(self):
        """They are subject markings. In a body they are ordinary English or a footer."""
        for body in ('In my personal view the clause should stay.', 'This email is private and confidential.',
                     'Personally, I would accept the cap.'):
            v = self.engine.evaluate(message(subject='Draft SPA', body=body))
            self.assertEqual(v.outcome, READ, body)

    def test_a_disclaimer_footer_does_not_withhold(self):
        footer = ('Comments attached.\n\nThis email and any attachments are strictly confidential and may be legally '
                  'privileged. If you are not the intended recipient, do not forward, copy or disclose it.')
        for subject in ('Draft SPA', 'Privileged & Confidential - Draft SPA', 'Confidential: term sheet'):
            v = self.engine.evaluate(message(subject=subject, body=footer))
            self.assertEqual(v.outcome, READ, subject)

    def test_disclaimer_phrases_are_not_on_any_never_share_list(self):
        """The Email Bot's warning, enforced: these would withhold the firm's ordinary work."""
        listed = [str(t).lower() for group in ('never_share', 'never_share_subject')
                  for terms in self.rules[group].values() for t in terms]
        for phrase in ('strictly confidential', 'confidential', 'do not forward', 'privileged', 'intended recipient',
                       'privileged and confidential', 'privileged & confidential'):
            self.assertNotIn(phrase, listed)

    def test_a_clients_partnership_deed_is_work_not_withheld(self):
        """Decided: the bare word "partnership" is not on the list. The firm's work is public-private
        partnerships and it drafts partnership deeds for clients; the partners' own business is caught
        by the tighter phrases instead (the next test)."""
        for subject, body in (('Partnership deed - Northwind & Co', 'Please find the draft partnership deed for your review.'),
                              ('PPP framework', 'The public-private partnership agreement is with the authority.'),
                              ('Limited liability partnership', 'Registration of the partnership is pending.'),
                              ('Engineering drawings', 'The drawings for Section 2 are attached to the concession agreement.')):
            v = self.engine.evaluate(message(subject=subject, body=body))
            self.assertEqual(v.outcome, READ, subject)
        listed = [str(t).lower() for terms in self.rules['never_share'].values() for t in terms]
        self.assertNotIn('partnership', listed)
        self.assertNotIn('drawings', listed)

    def test_the_firms_own_partners_business_is_withheld(self):
        """The Email Bot let this one through; the intake's wider list does not."""
        v = self.engine.evaluate(message('partner@akla.com.pk', 'Partners meeting agenda',
                                         'Profit share and partnership deed items for Friday.'))
        self.assertEqual((v.outcome, v.rule), (WITHHELD, 'never_share:partners'))

    def test_near_misses_are_not_withheld(self):
        """Whole words only: a longer or different word is not the listed one."""
        for body in ('The incremental cost is in the agreement.', 'Staff and personnel are listed in the annexure.',
                     'The medically-neutral wording stays out of the contract.', 'Billing: please chase the pending invoices.',
                     'The partner countries meet on the contract next week.'):
            v = self.engine.evaluate(message(subject='Draft agreement', body=body))
            self.assertEqual(v.outcome, READ, body)

    def test_withholding_has_no_exceptions(self):
        """Not for a court, not for a work signal, not for the firm's own sent mail."""
        court = message('registrar@lhc.gov.pk', 'Hearing notice', 'The hearing concerns the salary dispute petition.')
        sent = message('partner@akla.com.pk', 'Concession Agreement', 'Draft attached. Separately, your bonus is approved.',
                       folder='sentitems', to=['associate@akla.com.pk'])
        for m in (court, sent):
            self.assertEqual(self.engine.evaluate(m).outcome, WITHHELD)

    def test_a_withheld_verdict_carries_no_text_of_the_message(self):
        m = message('hr@akla.com.pk', 'Zebra crossing salary memo', 'The quokka allowance and salary are attached.')
        v = self.engine.evaluate(m)
        self.assertEqual(v.rule, 'never_share:pay')
        text = repr(v).lower()
        for secret in ('zebra', 'quokka', 'salary', 'hr@akla.com.pk'):
            self.assertNotIn(secret, text)
        self.assertEqual((v.hints.legal, v.hints.deadline, v.hints.meeting), ([], [], []))


class SentMailTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = default_engine()

    def test_private_mail_sent_to_consumer_addresses_is_dropped(self):
        m = message('partner@akla.com.pk', 'Sunday', 'See you at seven.', folder='sentitems', to=['brother@gmail.com'])
        v = self.engine.evaluate(m)
        self.assertEqual((v.outcome, v.rule), (DROPPED, 'personal_recipients_no_work_signal'))

    def test_work_sent_to_a_client_on_gmail_is_read(self):
        m = message('partner@akla.com.pk', 'Term sheet', 'The revised term sheet is attached.', folder='sentitems',
                    to=['founder.of.client@gmail.com'])
        self.assertEqual(self.engine.evaluate(m).outcome, READ)

    def test_sent_mail_with_a_firm_or_company_recipient_is_read(self):
        m = message('partner@akla.com.pk', 'Sunday', 'See you at seven.', folder='sentitems',
                    to=['brother@gmail.com'], cc=['gc@northwind-holdings.example'])
        self.assertEqual(self.engine.evaluate(m).outcome, READ)


if __name__ == '__main__':
    unittest.main()
