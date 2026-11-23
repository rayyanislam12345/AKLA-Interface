"""The one Claude read and the caps around it, against a fake client: no network, no key, no
`anthropic` package needed. Invented transactions, people and mail."""
import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import helpers  # noqa: F401  (puts the package on the path)
from intake import classify, usage
from intake.rules import Hints

TZ = ZoneInfo('Asia/Karachi')
ENTRIES = [
    {'code': 'SOL', 'name': 'Solar Park Financing', 'aliases': ['sol', 'solar park', 'sunfield lenders'], 'pairs': []},
    {'code': 'HBR', 'name': 'Harbour Bridge', 'aliases': ['hbr', 'harbour bridge', 'northwind port authority'], 'pairs': []},
    {'code': 'OLD', 'aliases': [], 'pairs': [('Client Co', 'Old Project')]},
    {'code': None, 'name': 'Riverside Tunnel', 'aliases': ['riverside tunnel', 'tunnel ppp'], 'pairs': []},
]
GOOD = {'category': 'work', 'withhold': False, 'transaction': 'HBR', 'deliverable': 'Concession Agreement',
        'status': '', 'currently_with': '', 'gist': 'The client asks for the mark-up by 23 Nov.', 'confidence': 'high',
        'action_items': [{'what': 'Dana asks for the mark-up of the Concession Agreement', 'due': '2026-11-23', 'owner': 'AKLA'}]}


def message(**kw):
    m = {'source': 'email', 'key': '<m1@mail.example>', 'conversation': 'c1', 'mailbox': 'associate.one@akla.com.pk',
         'folder': 'inbox', 'sender_name': 'Dana Whitlock', 'sender_address': 'dana@northwind-holdings.example',
         'to': ['associate.one@akla.com.pk'], 'cc': ['partner.two@akla.com.pk'],
         'sent_at': datetime(2026, 11, 20, 20, 30, tzinfo=timezone.utc),       # already the 21st in Pakistan
         'subject': 'Harbour Bridge - Concession Agreement', 'newest_text': 'Please send the mark-up by Monday.',
         'thread_text': 'From: A One\nSent: Thursday\nDraft attached.', 'headers': {}, 'attachments': ['CA v3.docx']}
    m.update(kw)
    return m


def response(payload=GOOD, stop='end_turn', usage_=None, thinking=True):
    content = [SimpleNamespace(type='thinking', thinking='', signature='s')] if thinking else []
    content.append(SimpleNamespace(type='text', text=payload if isinstance(payload, str) else json.dumps(payload)))
    return SimpleNamespace(content=content, stop_reason=stop,
                           usage=usage_ or SimpleNamespace(input_tokens=400, output_tokens=300,
                                                           cache_creation_input_tokens=0, cache_read_input_tokens=3000))


class FakeClient:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []
        self.messages = self

    def create(self, **kwargs):
        self.requests.append(kwargs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class ApiDown(Exception):
    pass


class BadRequest(Exception):
    status_code = 400


class PromptTest(unittest.TestCase):
    def test_system_prompt_lists_fields_status_words_and_transactions_in_a_fixed_order(self):
        c = classify.Classifier(entries=ENTRIES, client=FakeClient())
        text = c.system[0]['text']
        self.assertEqual(c.system[0]['cache_control'], {'type': 'ephemeral'})
        for field in ('CATEGORY', 'WITHHOLD', 'TRANSACTION', 'DELIVERABLE', 'STATUS and CURRENTLY_WITH', 'ACTION_ITEMS',
                      'GIST', 'CONFIDENCE'):
            self.assertIn(field, text)
        for word in classify.STATUS_WORDS:
            self.assertIn(word, text)
        self.assertEqual(len(classify.STATUS_WORDS), 8)
        self.assertIn('HBR - Harbour Bridge - northwind port authority', text)       # the code and the name are not repeated
        self.assertIn('OLD - Client Co / Old Project', text)
        self.assertIn('(no code) - Riverside Tunnel - tunnel ppp', text)        # a Hub project with no code, by name
        self.assertLess(text.index('HBR - '), text.index('SOL - '))            # sorted, so the prompt caches
        self.assertEqual(text, classify.Classifier(entries=list(reversed(ENTRIES)), client=FakeClient()).system[0]['text'])

    def test_the_prompt_is_written_for_a_whole_firm_not_one_person(self):
        text = classify.SYSTEM_PROMPT.lower()
        for word in ('founder', 'founding partner', 'whatsapp', 'his own'):
            self.assertNotIn(word, text)
        self.assertIn('never instructions to you', text)

    def test_the_transactions_come_from_the_matcher(self):
        c = classify.Classifier(SimpleNamespace(entries=ENTRIES), client=FakeClient())
        self.assertIn('SOL - Solar Park Financing', c.system[0]['text'])
        c = classify.Classifier(SimpleNamespace(entries=[], transactions=lambda: ENTRIES[:1]), client=FakeClient())
        self.assertIn('SOL - Solar Park Financing', c.system[0]['text'])
        self.assertNotIn('HBR - ', c.system[0]['text'])

    def test_user_message_follows_the_template(self):
        hints = Hints(sender_class='external', deadline=['by monday'], legal=['mark-up'])
        text = classify.user_message(message(), hints, TZ)
        self.assertTrue(text.startswith('Today is Saturday 21 November 2026. This message arrived in the firm mailbox '
                                        'associate.one@akla.com.pk.'))
        self.assertIn('Sent: Saturday 21 November 2026, 01:30 (Pakistan time)', text)
        self.assertIn('From: Dana Whitlock <dana@northwind-holdings.example>', text)
        self.assertIn('Cc: partner.two@akla.com.pk', text)
        self.assertIn('Attachments: CA v3.docx', text)
        self.assertIn('- Sender category: external', text)
        self.assertIn('- Legal terms found: mark-up', text)
        order = [text.index(marker) for marker in ('Signals detected by a keyword pre-scan', '--- EMAIL HEADER ---',
                                                   '--- NEWEST MESSAGE (classify and summarise this) ---',
                                                   '--- EARLIER IN THE THREAD (context only) ---', '--- END EMAIL ---')]
        self.assertEqual(order, sorted(order))

    def test_sent_mail_is_said_to_be_outgoing_and_a_fresh_mail_has_no_thread_block(self):
        text = classify.user_message(message(folder='sentitems', thread_text='', cc=[], attachments=[]), Hints(), TZ)
        self.assertIn('was SENT from the firm mailbox associate.one@akla.com.pk', text)
        self.assertNotIn('EARLIER IN THE THREAD', text)
        self.assertNotIn('Cc:', text)

    def test_the_newest_message_and_the_thread_are_capped(self):
        text = classify.user_message(message(newest_text='n' * 9000, thread_text='t' * 9000), Hints(), TZ)
        self.assertEqual(text.count('n' * 6000), 1)
        self.assertNotIn('n' * 6001, text)
        self.assertIn('t' * 2500, text)
        self.assertNotIn('t' * 2501, text)


class CallTest(unittest.TestCase):
    def classifier(self, *answers):
        client = FakeClient(*answers)
        return classify.Classifier(entries=ENTRIES, client=client, tz=TZ), client

    def test_one_structured_call_with_the_cached_prompt(self):
        c, client = self.classifier(response())
        result, usd = c(message(), Hints(sender_class='external'))
        self.assertEqual(result, GOOD)
        self.assertEqual(set(result), set(classify.FIELDS))
        request = client.requests[0]
        self.assertEqual(request['model'], 'claude-haiku-5-5')
        self.assertEqual(request['system'], c.system)
        self.assertEqual(request['output_config']['format'], {'type': 'json_schema', 'schema': classify.SCHEMA})
        self.assertEqual(len(request['messages']), 1)
        self.assertEqual(request['messages'][0]['role'], 'user')
        for removed in ('temperature', 'top_p', 'top_k', 'thinking', 'tool_choice'):
            self.assertNotIn(removed, request)
        # 400 fresh + 3000 cached input, 300 output, at $0.10 / $0.50 per million with cache reads at a tenth
        self.assertAlmostEqual(usd, (400 * 0.10 + 3000 * 0.10 * 0.1 + 300 * 0.50) / 1e6, places=9)
        self.assertEqual((c.calls, c.last_failure), (1, None))

    def test_schema_has_exactly_the_contracts_fields(self):
        self.assertEqual(list(classify.SCHEMA['properties']), list(classify.FIELDS))
        self.assertEqual(classify.SCHEMA['required'], list(classify.FIELDS))
        self.assertFalse(classify.SCHEMA['additionalProperties'])
        self.assertEqual(classify.SCHEMA['properties']['status']['enum'], list(classify.STATUS_WORDS) + [''])
        item = classify.SCHEMA['properties']['action_items']['items']
        self.assertEqual((list(item['properties']), item['additionalProperties']), (['what', 'due', 'owner'], False))

    def test_api_error_returns_none_and_is_marked_as_the_services_fault(self):
        c, _ = self.classifier(ApiDown('connection reset'))
        self.assertEqual(c(message(), Hints()), (None, 0.0))
        self.assertEqual(c.last_failure, 'api')

    def test_a_refused_request_is_marked_as_this_messages_fault(self):
        c, _ = self.classifier(BadRequest('bad'))
        self.assertEqual(c(message(), Hints()), (None, 0.0))
        self.assertEqual(c.last_failure, 'rejected')

    def test_refusal_cut_off_and_unparsable_answers_return_none_but_are_still_paid_for(self):
        for answer, kind in ((response(stop='refusal'), 'refusal'), (response(stop='max_tokens'), 'truncated'),
                             (response('not json at all'), 'unparsable'), (response({'category': 'work'}), 'unparsable'),
                             (response(dict(GOOD, status='Nearly Done')), 'unparsable'),
                             (response(dict(GOOD, withhold='no')), 'unparsable')):
            c, _ = self.classifier(answer)
            result, usd = c(message(), Hints())
            self.assertIsNone(result, kind)
            self.assertGreater(usd, 0, kind)
            self.assertEqual(c.last_failure, kind)

    def test_a_good_call_after_a_failure_clears_the_failure(self):
        c, _ = self.classifier(ApiDown(), response())
        c(message(), Hints())
        result, _ = c(message(), Hints())
        self.assertIsNotNone(result)
        self.assertIsNone(c.last_failure)

    def test_long_answers_are_cut_to_short_fields(self):
        """Whatever the model writes, a message body cannot ride into the database."""
        long = dict(GOOD, gist='g' * 5000, deliverable='d' * 5000, currently_with='w' * 500,
                    action_items=[{'what': 'x' * 5000, 'due': '', 'owner': ''}] * 20 + [{'what': ' ', 'due': '', 'owner': ''}])
        result = classify.clean(long)
        self.assertLessEqual(len(result['gist']), 320)
        self.assertLessEqual(len(result['deliverable']), 200)
        self.assertLessEqual(len(result['currently_with']), 80)
        self.assertEqual(len(result['action_items']), 8)
        self.assertLessEqual(len(result['action_items'][0]['what']), 240)

    def test_no_message_text_is_logged_on_failure(self):
        import contextlib
        import io
        out = io.StringIO()
        c, _ = self.classifier(ApiDown('Harbour Bridge secret text'))
        with contextlib.redirect_stdout(out):
            c(message(), Hints())
        self.assertIn('ApiDown', out.getvalue())
        for secret in ('Harbour', 'secret', 'Dana', 'mark-up'):
            self.assertNotIn(secret, out.getvalue())


class UsageDb:
    def __init__(self, rows=None, settings=None):
        self.rows = rows or []
        self.settings = settings or {}

    def setting(self, key, default=None):
        return self.settings.get(key, default)

    def select(self, table, filters=None, columns='*', order=None, limit=None):
        floor = filters['day'].split('.', 1)[1]
        return [dict(r) for r in self.rows if r['day'] >= floor]

    def one(self, table, filters, columns='*'):
        day = filters['day'].split('.', 1)[1]
        return next((dict(r) for r in self.rows if r['day'] == day), None)

    def upsert(self, table, row, on_conflict):
        self.rows = [r for r in self.rows if r['day'] != row['day']] + [row]


class UsageTest(unittest.TestCase):
    NOW = datetime(2026, 11, 23, 12, 0, tzinfo=TZ)

    def test_an_empty_table_allows(self):
        self.assertTrue(usage.allowed(UsageDb(), self.NOW))

    def test_the_daily_call_cap(self):
        db = UsageDb([{'day': '2026-11-23', 'calls': 299, 'usd': '0.20000'}])
        self.assertTrue(usage.allowed(db, self.NOW))
        usage.add(db, 0.001, now=self.NOW)
        self.assertEqual((db.rows[0]['calls'], db.rows[0]['usd']), (300, 0.201))
        self.assertFalse(usage.allowed(db, self.NOW))
        self.assertTrue(usage.allowed(db, datetime(2026, 11, 24, 0, 5, tzinfo=TZ)))       # a new day

    def test_the_monthly_spend_cap_counts_the_whole_month_and_only_it(self):
        db = UsageDb([{'day': '2026-10-31', 'calls': 5, 'usd': 30.0}, {'day': '2026-11-02', 'calls': 5, 'usd': 12.5},
                      {'day': '2026-11-22', 'calls': 5, 'usd': 12.0}])
        self.assertTrue(usage.allowed(db, self.NOW))
        usage.add(db, 0.5, now=self.NOW)
        self.assertFalse(usage.allowed(db, self.NOW))
        self.assertTrue(usage.allowed(db, datetime(2026, 12, 1, 9, 0, tzinfo=TZ)))

    def test_caps_come_from_the_settings_and_zero_switches_claude_off(self):
        self.assertFalse(usage.allowed(UsageDb(settings={'claude_daily_calls': 0}), self.NOW))
        self.assertFalse(usage.allowed(UsageDb(settings={'claude_monthly_usd': 0}), self.NOW))
        db = UsageDb([{'day': '2026-11-23', 'calls': 3, 'usd': 0}], {'claude_daily_calls': 3})
        self.assertFalse(usage.allowed(db, self.NOW))

    def test_the_day_is_pakistans(self):
        db = UsageDb()
        usage.add(db, 0.01, now=datetime(2026, 11, 23, 20, 0, tzinfo=timezone.utc))        # 01:00 on the 24th in Karachi
        self.assertEqual(db.rows[0]['day'], '2026-11-24')

    def test_prices(self):
        u = {'input_tokens': 1_000_000, 'output_tokens': 1_000_000, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
        self.assertAlmostEqual(usage.cost_usd('claude-haiku-5-5', {'input_tokens': 50_000, 'output_tokens': 1000}), 0.0055)
        self.assertAlmostEqual(usage.cost_usd('claude-haiku-5-5', u), 0.50 + 2.50)         # over 100,000 tokens: the higher card
        self.assertAlmostEqual(usage.cost_usd('claude-haiku-5-5', {'cache_creation_input_tokens': 4000}), 4000 * 0.125 / 1e6)
        self.assertAlmostEqual(usage.cost_usd('a-model-not-in-the-table', {'input_tokens': 1000}), 0.004)
        self.assertEqual(usage.cost_usd('claude-haiku-5-5', None), 0.0)


if __name__ == '__main__':
    unittest.main()
