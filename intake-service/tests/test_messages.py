"""Acting on one message: withheld, dropped, read, the row line, the note, the tray. The withhold
path is tested hardest. Fake database, matcher and classifier; invented people, firms and mail."""
import contextlib
import io
import json
import re
import sys
import types
import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import helpers  # noqa: F401  (puts the package on the path)
from intake import messages
from intake.rules import default_engine

TZ = ZoneInfo('Asia/Karachi')
SENT = datetime(2026, 11, 20, 9, 14, tzinfo=timezone.utc)
KEY = '<m1@mail.northwind-holdings.example>'


# ---------------------------------------------------------------- the fakes

class FakeDb:
    """Tables in memory, with enough of PostgREST's filters for the intake's reads."""
    offline = False
    dry_run = False

    def __init__(self, settings=None, **tables):
        self.settings = settings or {}
        self.tables = {name: [dict(r) for r in rows] for name, rows in tables.items()}
        self.writes = []
        self._n = 0

    def rows(self, table):
        return self.tables.setdefault(table, [])

    @staticmethod
    def _value(row, key):
        if '->>' in key:
            column, _, field = key.partition('->>')
            return (row.get(column) or {}).get(field)
        return row.get(key)

    def _match(self, row, key, expr):
        value = self._value(row, key)
        op, _, arg = expr.partition('.')
        if op == 'eq':
            return str(value) == arg
        if op == 'is':
            return value is None
        if op == 'gte':
            return str(value) >= arg
        if op == 'in':
            return str(value) in [a.replace('\\"', '"') for a in re.findall(r'"((?:[^"\\]|\\.)*)"', arg)]
        raise AssertionError(f'filter not understood: {key}={expr}')

    def select(self, table, filters=None, columns='*', order=None, limit=None):
        found = [r for r in self.rows(table) if all(self._match(r, k, v) for k, v in (filters or {}).items())]
        if order:
            field, _, direction = order.partition('.')
            found.sort(key=lambda r: str(r.get(field) or ''), reverse=direction == 'desc')
        return [dict(r) for r in found[:limit]]

    def one(self, table, filters, columns='*'):
        found = self.select(table, filters, columns, limit=1)
        return found[0] if found else None

    def insert(self, table, rows):
        rows = rows if isinstance(rows, list) else [rows]
        out = []
        for row in rows:
            self._n += 1
            saved = dict(row)
            if table not in ('intake_usage', 'intake_mail_state'):
                saved['id'] = row.get('id') or f'{table}-{self._n}'
            saved.setdefault('created_at', f'{self._n:06d}')
            self.rows(table).append(saved)
            self.writes.append(('insert', table, saved))
            out.append(dict(saved))
        return out

    def upsert(self, table, rows, on_conflict):
        rows = rows if isinstance(rows, list) else [rows]
        keys = on_conflict.split(',')
        for row in rows:
            old = next((r for r in self.rows(table) if all(r.get(k) == row.get(k) for k in keys)), None)
            if old is not None:
                old.update(row)
            else:
                self.rows(table).append(dict(row))
            self.writes.append(('upsert', table, dict(row)))
        return [dict(r) for r in rows]

    def patch(self, table, filters, data):
        hit = [r for r in self.rows(table) if all(self._match(r, k, v) for k, v in filters.items())]
        for row in hit:
            row.update(data)
        self.writes.append(('patch', table, dict(data)))
        return [dict(r) for r in hit]

    def setting(self, key, default=None):
        return self.settings.get(key, default)

    def dump(self):
        return json.dumps(self.tables, default=str, ensure_ascii=False)


ROWS = [
    {'id': 'row-ca', 'client': 'Northwind Port Authority', 'project': 'Harbour Bridge', 'deliverable': 'Concession Agreement',
     'status': 'In Progress', 'currently_with': 'Team', 'matter_id': 'matter-hbr', 'archived_at': None},
    {'id': 'row-ts', 'client': 'Northwind Port Authority', 'project': 'Harbour Bridge', 'deliverable': 'Term Sheet',
     'status': 'In Progress', 'currently_with': 'Team', 'matter_id': 'matter-hbr', 'archived_at': None},
    {'id': 'row-contd', 'client': 'Northwind Port Authority', 'project': 'Harbour Bridge',
     'deliverable': 'Continuation of comments for Sr. No. 1 above', 'status': 'In Progress', 'currently_with': None,
     'matter_id': 'matter-hbr', 'archived_at': None},
    {'id': 'row-sol', 'client': 'Sunfield Energy', 'project': 'Solar Park', 'deliverable': 'Facility Agreement',
     'status': 'Not Started', 'currently_with': None, 'matter_id': None, 'archived_at': None},
]


class FakeMatcher:
    """The contract's matcher API, small: two transactions, one with a Hub project and one without."""

    def __init__(self):
        self.entries = [
            {'code': 'HBR', 'name': 'Harbour Bridge', 'aliases': ['hbr', 'harbour bridge'], 'matters': ['matter-hbr'],
             'pairs': [('Northwind Port Authority', 'Harbour Bridge')]},
            {'code': 'SOL', 'name': 'Solar Park', 'aliases': ['sol', 'solar park'], 'matters': [],
             'pairs': [('Sunfield Energy', 'Solar Park')]},
            {'code': None, 'name': 'Riverside Tunnel', 'aliases': ['riverside tunnel'], 'matters': ['matter-tunnel'], 'pairs': []},
        ]

    def entry_for_code(self, code):
        return next((e for e in self.entries if e['code'] == code), None)

    def matter_for_code(self, code, text=''):
        entry = self.entry_for_code(code)
        return entry['matters'][0] if entry and entry['matters'] else None

    def resolve_transaction(self, text):
        t = (text or '').lower()
        for entry in self.entries:
            if any(alias in t for alias in entry['aliases']):
                return entry, 0.9
        return None, 0.0

    def candidate_rows(self, rows, entry):
        pairs = set(entry['pairs'])
        return [r for r in rows if (r['client'], r['project']) in pairs]

    def match_row(self, texts, rows, transaction=''):
        def score(text, row):
            a = set(re.findall(r'[a-z]+', (text or '').lower()))
            b = set(re.findall(r'[a-z]+', row['deliverable'].lower()))
            return round(len(a & b) / len(b), 2) if a and b else 0.0
        scored = sorted(((max(score(t, r) * f for t, f in zip(texts, (1.0, 0.95))), r) for r in rows), key=lambda x: -x[0])
        return (scored[0][1], scored[0][0], scored[:3]) if scored else (None, 0.0, [])

    def person(self, text):
        return {'a one': 'Asha One', 'asha': 'Asha One'}.get((text or '').strip().lower(), (text or '').strip())


class FakePeople:
    def id_for(self, name):
        return {'asha one': 'profile-asha'}.get((name or '').strip().lower())


class FakeClassifier:
    """Hands back the queued answers; None is a failed read."""

    def __init__(self, *answers, usd=0.0004, failure=None):
        self.answers = list(answers)
        self.usd = usd
        self.failure = failure
        self.last_failure = None
        self.seen = []

    def __call__(self, message, hints):
        self.seen.append(message['key'])
        answer = self.answers.pop(0) if self.answers else None
        self.last_failure = None if answer is not None else self.failure
        return answer, (self.usd if answer is not None or self.failure not in (None, 'api') else 0.0)


def read(**kw):
    """What the classifier says of a work message about the Concession Agreement."""
    result = {'category': 'work', 'withhold': False, 'transaction': 'HBR', 'deliverable': 'Concession Agreement',
              'status': '', 'currently_with': '', 'gist': 'The client asks for the mark-up by 23 Nov.', 'confidence': 'high',
              'action_items': [{'what': 'Dana asks for the mark-up of the Concession Agreement.', 'due': '2026-11-23', 'owner': 'AKLA'}]}
    result.update(kw)
    return result


def message(**kw):
    m = {'source': 'email', 'key': KEY, 'conversation': 'conv-1', 'mailbox': 'asha.one@akla.com.pk', 'folder': 'inbox',
         'sender_name': 'Dana Whitlock', 'sender_address': 'dana@northwind-holdings.example',
         'to': ['asha.one@akla.com.pk'], 'cc': [], 'sent_at': SENT, 'subject': 'Harbour Bridge - Concession Agreement',
         'newest_text': 'Please send the mark-up of the agreement by Monday.', 'thread_text': '', 'headers': {}, 'attachments': []}
    m.update(kw)
    return m


def settings(**kw):
    s = {'mail_move_rows': True, 'mail_set_status': False, 'mail_notes': True, 'tz': TZ, 'rules': default_engine(),
         'thresholds': {'transaction_high': 0.8, 'deliverable_high': 0.75, 'deliverable_low': 0.45},
         'intake_user_id': 'profile-intake'}
    s.update(kw)
    return s


def handle(db, m, classifier, rows=None, dry_run=False, **setting):
    return messages.handle_message(db, m, FakeMatcher(), rows if rows is not None else [dict(r) for r in ROWS],
                                   FakePeople(), settings(**setting), classifier, dry_run=dry_run)


# ---------------------------------------------------------------- withheld

SECRETS = ('Okapi', 'narwhal', 'Dana', 'Whitlock', 'northwind', 'conv-1', 'm1@mail')


class WithheldTest(unittest.TestCase):
    def withheld_message(self, **kw):
        return message(subject='Okapi salary review', newest_text='The narwhal figures: salary rises for the associates.', **kw)

    def assert_minimal(self, db, rule, mailboxes):
        rows = db.rows('intake_messages')
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row['outcome'], row['rule'], row['mailboxes']), ('withheld', rule, mailboxes))
        self.assertEqual(row['sent_at'], SENT.isoformat())
        for column in ('subject', 'sender', 'sender_class', 'conversation_key', 'classification', 'matter_id', 'row_id'):
            self.assertIsNone(row[column], column)
        self.assertEqual(row['message_key'], messages.hidden_key(KEY))
        self.assertRegex(row['message_key'], r'^h:[0-9a-f]{64}$')
        dumped = db.dump()
        for secret in SECRETS:
            self.assertNotIn(secret, dumped, secret)
        self.assertEqual(set(db.tables) - {'intake_messages'}, set(), 'nothing but the one row is written')

    def test_rules_withhold_before_any_model_and_the_row_says_only_that_it_happened(self):
        for folder, sender in (('inbox', 'dana@northwind-holdings.example'), ('sentitems', 'asha.one@akla.com.pk')):
            db, classifier, log = FakeDb(), FakeClassifier(read()), io.StringIO()
            with contextlib.redirect_stdout(log):
                out = handle(db, self.withheld_message(folder=folder, sender_address=sender), classifier)
            self.assertEqual((out['outcome'], out['rule']), ('withheld', 'never_share:pay'), folder)
            self.assertEqual(classifier.seen, [], 'no model saw it')
            self.assert_minimal(db, 'never_share:pay', ['asha.one@akla.com.pk'])
            self.assertEqual(db.rows('intake_messages')[0]['folder'], folder)
            self.assertEqual(log.getvalue(), '', 'nothing is logged about a withheld message')
            self.assertEqual(out['plan'], {})
            self.assertNotIn('Okapi', json.dumps(out, default=str))

    def test_subject_marked_personal_is_withheld_whatever_the_body_says(self):
        db, classifier = FakeDb(), FakeClassifier(read())
        out = handle(db, message(subject='Personal - Okapi', newest_text='The concession agreement narwhal is attached.'), classifier)
        self.assertEqual((out['outcome'], out['rule']), ('withheld', 'never_share:marked_private'))
        self.assertEqual(classifier.seen, [])
        self.assert_minimal(db, 'never_share:marked_private', ['asha.one@akla.com.pk'])

    def test_the_models_own_withhold_keeps_nothing_it_read(self):
        db = FakeDb()
        classifier = FakeClassifier(read(withhold=True, gist='Okapi narwhal appraisal outcome for Dana.',
                                         deliverable='Okapi letter', action_items=[{'what': 'narwhal', 'due': '', 'owner': ''}]))
        out = handle(db, message(subject='Okapi follow up', newest_text='About the narwhal conversation last week.'), classifier)
        self.assertEqual((out['outcome'], out['rule']), ('withheld', 'model_withhold'))
        rows = db.rows('intake_messages')
        self.assertEqual(rows[0]['usd'], 0.0004)
        db.tables.pop('intake_usage')                       # the spend is counted; nothing else is written
        self.assert_minimal(db, 'model_withhold', ['asha.one@akla.com.pk'])

    def test_model_withhold_wins_over_every_other_field(self):
        """A message the model marks withhold is never acted on, even if it also names a row."""
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read(withhold=True)))
        self.assertEqual(out['outcome'], 'withheld')
        for table in ('transaction_updates', 'matter_notes', 'intake_actions', 'intake_tray'):
            self.assertEqual(db.rows(table), [], table)

    def test_a_withheld_email_seen_in_a_second_mailbox_only_adds_the_mailbox(self):
        db, classifier = FakeDb(), FakeClassifier()
        handle(db, self.withheld_message(), classifier)
        out = handle(db, self.withheld_message(mailbox='partner.two@akla.com.pk', folder='sentitems'), classifier)
        self.assertEqual(out['outcome'], 'seen')
        self.assert_minimal(db, 'never_share:pay', ['asha.one@akla.com.pk', 'partner.two@akla.com.pk'])

    def test_a_failed_read_that_is_later_withheld_leaves_no_trace_of_the_first_try(self):
        db = FakeDb()
        m = message(subject='Okapi follow up', newest_text='About the narwhal conversation.')
        handle(db, m, FakeClassifier(failure='unparsable'))
        self.assertEqual(db.rows('intake_messages')[0]['message_key'], KEY)      # an error row: nothing of the message, the plain key
        self.assertIsNone(db.rows('intake_messages')[0]['subject'])
        out = handle(db, m, FakeClassifier(read(withhold=True)))
        self.assertEqual(out['outcome'], 'withheld')
        db.tables.pop('intake_usage')
        self.assertEqual(db.rows('intake_messages')[0]['usd'], 0.0008)
        self.assert_minimal(db, 'model_withhold', ['asha.one@akla.com.pk'])

    def test_a_dry_run_of_a_withheld_message_writes_and_says_nothing(self):
        db, log = FakeDb(), io.StringIO()
        with contextlib.redirect_stdout(log):
            out = handle(db, self.withheld_message(), FakeClassifier(), dry_run=True)
        self.assertEqual(out['outcome'], 'withheld')
        self.assertEqual((db.writes, log.getvalue(), out['plan']), ([], '', {}))


# ------------------------------------------------- dropped, not work, nothing

class QuietOutcomesTest(unittest.TestCase):
    def test_dropped_keeps_the_sender_class_and_the_rule_and_no_subject(self):
        db, classifier = FakeDb(), FakeClassifier()
        m = message(sender_name='Okapi Offers', sender_address='news@shop.example', subject='Okapi weekend sale',
                    newest_text='Narwhal prices slashed.', headers={'list-unsubscribe': '<u>'})
        out = handle(db, m, classifier)
        self.assertEqual((out['outcome'], out['rule']), ('dropped', 'automated_bulk'))
        row = db.rows('intake_messages')[0]
        self.assertEqual((row['outcome'], row['rule'], row['sender_class'], row['message_key']), ('dropped', 'automated_bulk', 'external', KEY))
        for column in ('subject', 'sender', 'conversation_key', 'classification'):
            self.assertIsNone(row[column], column)
        self.assertEqual(classifier.seen, [])
        for secret in ('Okapi', 'Narwhal', 'shop.example'):
            self.assertNotIn(secret, db.dump())

    def test_mail_the_model_calls_personal_keeps_only_the_category(self):
        db = FakeDb()
        m = message(subject='Okapi school fees', newest_text='The narwhal term fee is due.', sender_address='office@school.example')
        out = handle(db, m, FakeClassifier(read(category='personal', transaction='NONE', gist='Okapi fee is due.')))
        self.assertEqual((out['outcome'], out['rule']), ('nothing', 'category:personal'))
        row = db.rows('intake_messages')[0]
        self.assertEqual(row['classification'], {'category': 'personal', 'confidence': 'high'})
        self.assertIsNone(row['subject'])
        self.assertIsNone(row['sender'])
        for secret in ('Okapi', 'narwhal', 'school.example'):
            self.assertNotIn(secret, db.dump())

    def test_work_mail_about_no_transaction_is_recorded_as_nothing(self):
        db = FakeDb()
        out = handle(db, message(subject='Lunch seminar on arbitration'), FakeClassifier(read(transaction='NONE', deliverable='')))
        self.assertEqual(out['outcome'], 'nothing')
        row = db.rows('intake_messages')[0]
        self.assertEqual((row['outcome'], row['subject'], row['sender']),
                         ('nothing', 'Lunch seminar on arbitration', 'Dana Whitlock <dana@northwind-holdings.example>'))
        self.assertEqual(row['classification']['transaction'], 'NONE')
        self.assertEqual(db.rows('transaction_updates') + db.rows('matter_notes') + db.rows('intake_tray'), [])

    def test_no_body_is_ever_written(self):
        db = FakeDb()
        body = 'ZYXWV unique body sentence that must never be stored anywhere.'
        handle(db, message(newest_text=body + ' Please send the agreement.', thread_text='QPONM older thread text.'),
               FakeClassifier(read()))
        self.assertEqual(db.rows('intake_messages')[0]['outcome'], 'acted')
        for text in ('ZYXWV', 'QPONM'):
            self.assertNotIn(text, db.dump())


# ------------------------------------------------------ once, caps, failures

class OnceCapsAndFailuresTest(unittest.TestCase):
    def test_one_email_in_two_mailboxes_is_handled_once(self):
        db, classifier = FakeDb(), FakeClassifier(read(), read())
        first = handle(db, message(), classifier)
        second = handle(db, message(mailbox='partner.two@akla.com.pk'), classifier)
        self.assertEqual((first['outcome'], second['outcome']), ('acted', 'seen'))
        self.assertEqual(len(classifier.seen), 1)
        self.assertEqual(len(db.rows('intake_messages')), 1)
        self.assertEqual(db.rows('intake_messages')[0]['mailboxes'], ['asha.one@akla.com.pk', 'partner.two@akla.com.pk'])
        self.assertEqual(len(db.rows('transaction_updates')), 1)
        self.assertEqual(len(db.rows('matter_notes')), 1)

    def test_at_a_cap_the_message_waits_and_nothing_is_recorded(self):
        today = datetime.now(TZ).date().isoformat()
        for usage_row, caps in (({'day': today, 'calls': 300, 'usd': 1.0}, {}),
                                ({'day': today, 'calls': 2, 'usd': 25.0}, {}),
                                ({'day': today, 'calls': 2, 'usd': 0.1}, {'claude_daily_calls': 2})):
            db, classifier = FakeDb(caps, intake_usage=[usage_row]), FakeClassifier(read())
            out = handle(db, message(), classifier)
            self.assertEqual(out['outcome'], 'wait')
            self.assertEqual(classifier.seen, [])
            self.assertEqual(db.writes, [], 'nothing recorded, so the caller cannot move past it')

    def test_rules_still_work_at_a_cap(self):
        today = datetime.now(TZ).date().isoformat()
        db = FakeDb(intake_usage=[{'day': today, 'calls': 300, 'usd': 1.0}])
        out = handle(db, message(subject='Bonus letters'), FakeClassifier())
        self.assertEqual(out['outcome'], 'withheld')

    def test_each_claude_read_is_counted_against_the_caps(self):
        db = FakeDb()
        handle(db, message(), FakeClassifier(read()))
        self.assertEqual([(r['calls'], r['usd']) for r in db.rows('intake_usage')], [(1, 0.0004)])
        handle(db, message(key='<m2@mail.example>'), FakeClassifier(read()))
        self.assertEqual([(r['calls'], r['usd']) for r in db.rows('intake_usage')], [(2, 0.0008)])

    def test_a_failed_read_is_an_error_acted_on_by_nothing_and_retried(self):
        db, classifier = FakeDb(), FakeClassifier(None, read(), failure='unparsable')
        out = handle(db, message(), classifier)
        self.assertEqual((out['outcome'], out['retry'], out['rule']), ('error', True, 'claude_failed'))
        row = db.rows('intake_messages')[0]
        self.assertEqual((row['outcome'], row['classification']), ('error', {'error': 'unparsable', 'attempts': 1}))
        self.assertIsNone(row['subject'])
        self.assertIsNone(row['sender'])
        self.assertEqual(db.rows('transaction_updates') + db.rows('matter_notes') + db.rows('intake_tray'), [])

        out = handle(db, message(), classifier)             # the next run
        self.assertEqual(out['outcome'], 'acted')
        self.assertEqual(len(db.rows('intake_messages')), 1)
        row = db.rows('intake_messages')[0]
        self.assertEqual((row['outcome'], row['row_id'], row['matter_id']), ('acted', 'row-ca', 'matter-hbr'))
        self.assertEqual(row['usd'], 0.0008)                # both reads were paid for
        self.assertEqual(db.rows('intake_actions')[0]['message_id'], row['id'])

    def test_an_answer_that_keeps_failing_is_given_up_after_three_tries(self):
        db, classifier = FakeDb(), FakeClassifier(failure='refusal')
        retries = [handle(db, message(), classifier)['retry'] for _ in range(3)]
        self.assertEqual(retries, [True, True, False])
        self.assertEqual(db.rows('intake_messages')[0]['classification'], {'error': 'refusal', 'attempts': 3})
        self.assertEqual(handle(db, message(), classifier)['outcome'], 'seen')
        self.assertEqual(len(classifier.seen), 3)

    def test_an_outage_never_uses_up_a_messages_tries(self):
        db, classifier = FakeDb(), FakeClassifier(failure='api')
        for _ in range(6):
            out = handle(db, message(), classifier)
            self.assertEqual((out['outcome'], out['retry'], out['calls']), ('error', True, 0))
        self.assertEqual(db.rows('intake_usage'), [])       # nothing reached Claude, nothing is counted
        self.assertEqual(db.rows('intake_messages')[0]['classification'], {'error': 'api', 'attempts': 0})


# ----------------------------------------------------- the line and the note

class SureMatchTest(unittest.TestCase):
    def test_a_sure_match_adds_a_line_and_a_note_logged_as_two_actions_in_one_group(self):
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read()))
        self.assertEqual((out['outcome'], out['row_id'], out['matter_id'], out['line'], out['note'], out['tray']),
                         ('acted', 'row-ca', 'matter-hbr', True, 'added', False))

        update = db.rows('transaction_updates')[0]
        self.assertEqual(update['body'], 'Dana asks for the mark-up of the Concession Agreement by 23 Nov')
        self.assertEqual((update['row_id'], update['source'], update['source_ref'], update['at']),
                         ('row-ca', 'email', KEY, SENT.isoformat()))
        self.assertEqual((update['author'], update['author_id']), (None, None))          # an outside sender

        note = db.rows('matter_notes')[0]
        self.assertEqual((note['matter_id'], note['author_id']), ('matter-hbr', 'profile-intake'))
        self.assertEqual(note['content'], 'From email · Harbour Bridge - Concession Agreement\nThe client asks for the mark-up by 23 Nov.')

        line, kept = db.rows('intake_actions')
        self.assertEqual((line['kind'], kept['kind']), ('row_update', 'note_added'))
        self.assertEqual(line['group_id'], kept['group_id'])
        self.assertEqual((line['source'], kept['source'], line['source_ref'], kept['source_ref']), ('email', 'email', KEY, KEY))
        self.assertEqual((line['row_id'], line['update_id'], line['matter_id']), ('row-ca', update['id'], 'matter-hbr'))
        self.assertEqual(line['summary'], 'Concession Agreement: Dana asks for the mark-up of the Concession Agreement by 23 Nov')
        self.assertEqual((line['detail']['from'], line['detail']['via'], line['detail']['sent']), ('Dana Whitlock', 'email', SENT.isoformat()))
        self.assertEqual(line['detail']['chat'], 'Outlook - asha.one@akla.com.pk (Inbox)')
        self.assertEqual((kept['note_id'], kept['matter_id']), (note['id'], 'matter-hbr'))
        self.assertEqual(kept['summary'], 'From email · Harbour Bridge - Concession Agreement The client asks for the mark-up by 23 Nov.')
        self.assertEqual({k: kept['detail'][k] for k in ('from', 'via', 'subject', 'messages')},
                         {'from': 'Dana Whitlock', 'via': 'email', 'subject': 'Harbour Bridge - Concession Agreement', 'messages': 1})

        # the message row is written last, and the two log entries then point at it
        self.assertEqual([t for op, t, _ in db.writes if op == 'insert'][-1], 'intake_messages')
        row = db.rows('intake_messages')[0]
        self.assertEqual((row['outcome'], row['matter_id'], row['row_id'], row['usd']), ('acted', 'matter-hbr', 'row-ca', 0.0004))
        self.assertEqual((row['message_key'], row['conversation_key'], row['subject']), (KEY, 'conv-1', 'Harbour Bridge - Concession Agreement'))
        self.assertEqual(row['classification']['gist'], 'The client asks for the mark-up by 23 Nov.')
        self.assertEqual((line['message_id'], kept['message_id']), (row['id'], row['id']))
        self.assertEqual(db.rows('intake_tray'), [])

    def test_a_firm_sender_is_the_lines_author(self):
        db = FakeDb()
        m = message(folder='sentitems', sender_name='A One', sender_address='asha.one@akla.com.pk', to=['dana@northwind-holdings.example'])
        handle(db, m, FakeClassifier(read(action_items=[], gist='Revised Concession Agreement sent to the client for comments.')))
        update = db.rows('transaction_updates')[0]
        self.assertEqual((update['author'], update['author_id']), ('Asha', 'profile-asha'))
        self.assertEqual(update['body'], 'Revised Concession Agreement sent to the client for comments.')    # no ask: the gist
        detail = db.rows('intake_actions')[0]['detail']
        self.assertEqual((detail['from'], detail['via'], detail['chat']), ('Asha One', 'email', 'Outlook - asha.one@akla.com.pk (Sent)'))

    def test_someone_outside_with_a_firm_persons_name_is_not_the_author(self):
        db = FakeDb()
        handle(db, message(sender_name='Asha One', sender_address='asha@elsewhere.example'), FakeClassifier(read()))
        self.assertEqual(db.rows('transaction_updates')[0]['author_id'], None)

    def test_status_changes_only_with_the_switch_on_and_high_confidence(self):
        moved = read(status='With Client', currently_with='Northwind GC')
        cases = (({'mail_set_status': False}, moved, False),
                 ({'mail_set_status': True}, dict(moved, confidence='medium'), False),
                 ({'mail_set_status': True}, dict(moved, status=''), False),
                 ({'mail_set_status': True}, moved, True))
        for switch, answer, expect_move in cases:
            db, rows = FakeDb(transaction_rows=[dict(r) for r in ROWS]), [dict(r) for r in ROWS]
            handle(db, message(), FakeClassifier(answer), rows=rows, **switch)
            action = db.rows('intake_actions')[0]
            row = db.one('transaction_rows', {'id': 'eq.row-ca'})
            self.assertEqual(len(db.rows('transaction_updates')), 1, 'the line is added either way')
            if expect_move:
                self.assertEqual((action['kind'], action['before'], action['after']),
                                 ('row_moved', {'status': 'In Progress', 'currently_with': 'Team'},
                                  {'status': 'With Client', 'currently_with': 'Northwind GC'}))
                self.assertEqual((row['status'], row['currently_with'], row['updated_source']), ('With Client', 'Northwind GC', 'email'))
                self.assertEqual(rows[0]['status'], 'With Client')
            else:
                self.assertEqual((action['kind'], action['before'], action['after']), ('row_update', None, None))
                self.assertEqual((row['status'], row['currently_with']), ('In Progress', 'Team'))

    def test_the_switches_turn_the_line_and_the_note_off(self):
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read()), mail_move_rows=False)
        self.assertEqual((out['outcome'], db.rows('transaction_updates'), len(db.rows('matter_notes'))), ('acted', [], 1))
        self.assertEqual(db.rows('intake_tray'), [], 'a sure row with the switch off is not a question for the tray')
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read()), mail_notes=False)
        self.assertEqual((out['outcome'], len(db.rows('transaction_updates')), db.rows('matter_notes')), ('acted', 1, []))
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read()), mail_notes=False, mail_move_rows=False)
        self.assertEqual((out['outcome'], db.rows('intake_actions')), ('nothing', []))

    def test_one_note_per_conversation_per_day_added_to_on_a_repeat(self):
        db = FakeDb()
        handle(db, message(), FakeClassifier(read()))
        later = message(key='<m2@mail.example>', sent_at=datetime(2026, 11, 20, 11, 0, tzinfo=timezone.utc), subject='RE: Harbour Bridge - Concession Agreement')
        out = handle(db, later, FakeClassifier(read(gist='Dana confirms the cap is agreed.', action_items=[])))
        self.assertEqual(out['note'], 'appended')
        notes = db.rows('matter_notes')
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]['content'], 'From email · Harbour Bridge - Concession Agreement\n'
                                              'The client asks for the mark-up by 23 Nov.\nDana confirms the cap is agreed.')
        logged = [a for a in db.rows('intake_actions') if a['kind'] == 'note_added']
        self.assertEqual(len(logged), 1, 'logged once per note')
        self.assertEqual(logged[0]['detail']['messages'], 2)

        tomorrow = message(key='<m3@mail.example>', sent_at=datetime(2026, 11, 21, 9, 0, tzinfo=timezone.utc))
        self.assertEqual(handle(db, tomorrow, FakeClassifier(read()))['note'], 'added')
        other = message(key='<m4@mail.example>', conversation='conv-2', sent_at=datetime(2026, 11, 21, 9, 30, tzinfo=timezone.utc))
        self.assertEqual(handle(db, other, FakeClassifier(read()))['note'], 'added')
        self.assertEqual(len(db.rows('matter_notes')), 3)

    def test_a_note_a_person_took_back_is_not_written_again_that_day(self):
        db = FakeDb()
        handle(db, message(), FakeClassifier(read()))
        action = next(a for a in db.rows('intake_actions') if a['kind'] == 'note_added')
        action['undone_at'] = '2026-11-20T10:00:00+00:00'
        db.tables['matter_notes'] = []
        out = handle(db, message(key='<m2@mail.example>'), FakeClassifier(read(gist='A second point.')))
        self.assertIsNone(out['note'])
        self.assertEqual(db.rows('matter_notes'), [])

    def test_a_run_that_died_before_recording_does_not_write_the_line_twice(self):
        db = FakeDb()
        handle(db, message(), FakeClassifier(read()))
        db.tables['intake_messages'] = []                   # as if the run stopped just before the last write
        out = handle(db, message(), FakeClassifier(read()))
        self.assertEqual(out['outcome'], 'acted')
        self.assertEqual(len(db.rows('transaction_updates')), 1)
        self.assertEqual(len(db.rows('matter_notes')), 1)
        self.assertEqual(db.rows('matter_notes')[0]['content'].count('The client asks'), 1)

    def test_continuation_rows_are_never_matched(self):
        db = FakeDb()
        out = handle(db, message(subject='Comments'), FakeClassifier(read(deliverable='Continuation of comments for Sr. No. 1 above')))
        self.assertNotEqual(out['row_id'], 'row-contd')


# --------------------------------------------------------------- the tray

class UnsureTest(unittest.TestCase):
    def test_a_project_but_no_sure_row_goes_to_the_tray_and_the_note_is_still_kept(self):
        db = FakeDb()
        answer = read(deliverable='Direct Agreement', status='With Client',
                      action_items=[{'what': 'Dana asks for the Direct Agreement', 'due': 'end of the month', 'owner': 'AKLA'}])
        out = handle(db, message(subject='Harbour Bridge - direct agreement'), FakeClassifier(answer))
        self.assertEqual((out['outcome'], out['tray'], out['note'], out['line'], out['row_id']), ('trayed', True, 'added', False, None))
        self.assertEqual(db.rows('transaction_updates'), [])
        self.assertEqual(len(db.rows('matter_notes')), 1)

        item = db.rows('intake_tray')[0]
        row = db.rows('intake_messages')[0]
        self.assertEqual(item['kind'], 'message_unsure')
        self.assertEqual(item['payload'], {
            'message_id': row['id'], 'message_key': KEY, 'person': 'Dana Whitlock', 'date': SENT.isoformat(),
            'transaction': 'Harbour Bridge', 'deliverable': 'Direct Agreement',
            'scope': 'The client asks for the mark-up by 23 Nov.', 'ask': 'Dana asks for the Direct Agreement by end of the month',
            'status': 'With Client', 'via': 'email', 'matter_id': 'matter-hbr', 'subject': 'Harbour Bridge - direct agreement'})
        self.assertEqual(set(item['guess']), {'row_id', 'confidence', 'row_deliverable', 'others'})
        self.assertEqual((item['guess']['row_id'], item['guess']['row_deliverable']), ('row-ca', 'Concession Agreement'))
        self.assertEqual([set(o) for o in item['guess']['others']], [{'row_id', 'deliverable', 'confidence'}])
        self.assertEqual((row['outcome'], row['matter_id'], row['row_id']), ('trayed', 'matter-hbr', None))
        self.assertEqual([a['kind'] for a in db.rows('intake_actions')], ['note_added'])
        self.assertEqual(db.rows('intake_actions')[0]['matter_id'], 'matter-hbr')
        self.assertEqual(db.rows('intake_actions')[0]['message_id'], row['id'])

    def test_no_row_near_enough_gives_a_tray_item_with_no_guess(self):
        db = FakeDb()
        handle(db, message(subject='Harbour Bridge'), FakeClassifier(read(deliverable='Legal Opinion')))
        self.assertIsNone(db.rows('intake_tray')[0]['guess'])

    def test_a_right_looking_row_on_low_confidence_is_asked_about_not_written(self):
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read(confidence='low')))
        self.assertEqual((out['outcome'], db.rows('transaction_updates')), ('trayed', []))
        self.assertEqual(db.rows('intake_tray')[0]['guess']['row_id'], 'row-ca')

    def test_project_chatter_with_nothing_to_place_keeps_the_note_and_asks_nobody(self):
        db = FakeDb()
        out = handle(db, message(subject='Harbour Bridge'), FakeClassifier(read(deliverable='', action_items=[], gist='Dana thanks the team.')))
        self.assertEqual((out['outcome'], out['note']), ('acted', 'added'))
        self.assertEqual(db.rows('intake_tray'), [])

    def test_the_tray_item_is_not_written_twice(self):
        db = FakeDb()
        answer = read(deliverable='Direct Agreement')
        handle(db, message(subject='Harbour Bridge'), FakeClassifier(answer))
        db.tables['intake_messages'] = []
        handle(db, message(subject='Harbour Bridge'), FakeClassifier(answer))
        self.assertEqual(len(db.rows('intake_tray')), 1)


# ------------------------------------------------------ projects the Hub lacks

class ProjectsTest(unittest.TestCase):
    def setUp(self):
        self.proposed = []
        fake = types.ModuleType('intake.projects')
        fake.propose_project = lambda db, matcher, name, code=None, seen=None, client=None: self.proposed.append((name, code, seen))
        self._old = sys.modules.get('intake.projects')
        sys.modules['intake.projects'] = fake
        import intake
        self._attr = getattr(intake, 'projects', None)
        intake.projects = fake

    def tearDown(self):
        import intake
        if self._old is None:
            sys.modules.pop('intake.projects', None)
        else:
            sys.modules['intake.projects'] = self._old
        if self._attr is None:
            if hasattr(intake, 'projects'):
                del intake.projects
        else:
            intake.projects = self._attr

    def test_a_plainly_named_unknown_project_is_proposed(self):
        db = FakeDb()
        out = handle(db, message(subject='Canal Lining - kick-off'), FakeClassifier(read(transaction='NEW: Canal Lining', deliverable='Engagement Letter')))
        self.assertEqual((out['outcome'], out['proposed']), ('nothing', True))
        self.assertEqual(self.proposed, [('Canal Lining', None, {'where': 'Canal Lining - kick-off', 'person': 'Dana Whitlock',
                                                                 'date': SENT.isoformat()})])
        self.assertEqual(db.rows('intake_messages')[0]['outcome'], 'nothing')
        self.assertEqual(db.rows('transaction_updates') + db.rows('matter_notes') + db.rows('intake_tray'), [])

    def test_a_guess_at_a_new_project_is_not_proposed(self):
        handle(FakeDb(), message(), FakeClassifier(read(transaction='NEW: Canal Lining', confidence='low')))
        self.assertEqual(self.proposed, [])

    def test_a_name_the_matcher_knows_is_not_new(self):
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read(transaction='NEW: the Harbour Bridge project')))
        self.assertEqual((out['outcome'], out['row_id'], self.proposed), ('acted', 'row-ca', []))

    def test_a_known_transaction_with_no_hub_project_gets_its_line_and_a_proposal_but_no_note(self):
        db = FakeDb()
        out = handle(db, message(subject='Solar Park - facility agreement'),
                     FakeClassifier(read(transaction='SOL', deliverable='Facility Agreement')))
        self.assertEqual((out['outcome'], out['row_id'], out['matter_id'], out['note'], out['tray']), ('acted', 'row-sol', None, None, False))
        self.assertEqual(len(db.rows('transaction_updates')), 1)
        self.assertEqual(db.rows('matter_notes'), [])
        self.assertEqual([(name, code) for name, code, _ in self.proposed], [('Solar Park', 'SOL')])

    def test_a_hub_project_with_no_code_is_answered_by_name(self):
        db = FakeDb()
        rows = [{'id': 'row-tunnel', 'client': 'City Works', 'project': 'Riverside Tunnel', 'deliverable': 'Engagement Letter',
                 'status': 'In Progress', 'currently_with': None, 'matter_id': 'matter-tunnel', 'archived_at': None}]
        out = handle(db, message(subject='Riverside Tunnel - engagement letter'),
                     FakeClassifier(read(transaction='Riverside Tunnel', deliverable='Engagement Letter')), rows=rows)
        self.assertEqual((out['outcome'], out['row_id'], out['matter_id'], self.proposed), ('acted', 'row-tunnel', 'matter-tunnel', []))

    def test_a_proposal_that_did_nothing_is_not_counted(self):
        sys.modules['intake.projects'].propose_project = lambda db, matcher, name, code=None, seen=None, client=None, source=None: (
            self.proposed.append((name, code, source)) or {'action': 'nothing', 'why': 'already answered'})
        out = handle(FakeDb(), message(subject='Canal Lining'), FakeClassifier(read(transaction='NEW: Canal Lining')))
        self.assertEqual((out['proposed'], self.proposed), (False, [('Canal Lining', None, 'email')]))

    def test_an_invented_code_is_nothing(self):
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read(transaction='XYZ')))
        self.assertEqual((out['outcome'], self.proposed), ('nothing', []))


# ---------------------------------------------------------------- dry run

class DryRunTest(unittest.TestCase):
    def test_a_dry_run_writes_nothing_and_says_what_it_would_do(self):
        db = FakeDb()
        out = handle(db, message(), FakeClassifier(read()), dry_run=True)
        self.assertEqual(db.writes, [])
        self.assertEqual((out['outcome'], out['line'], out['note']), ('acted', True, 'added'))
        self.assertEqual(out['plan']['line'], {'row': 'Concession Agreement', 'changes': None,
                                               'body': 'Dana asks for the mark-up of the Concession Agreement by 23 Nov'})
        out = handle(db, message(subject='Harbour Bridge'), FakeClassifier(read(deliverable='Direct Agreement')), dry_run=True)
        self.assertEqual((out['outcome'], db.writes), ('trayed', []))


class AskLineTest(unittest.TestCase):
    def test_the_ask_with_its_date(self):
        day = SENT.date()
        line = lambda items: messages.ask_line({'action_items': items}, day)
        self.assertEqual(line([{'what': 'Owais Sb asks for the mark-up.', 'due': '2026-10-19', 'owner': ''}]), 'Owais Sb asks for the mark-up by 19 Oct')
        self.assertEqual(line([{'what': 'File the reply', 'due': '2027-01-05T10:00:00', 'owner': ''}]), 'File the reply by 5 Jan 2027')
        self.assertEqual(line([{'what': 'Send comments', 'due': 'By end of week', 'owner': ''}]), 'Send comments by end of week')
        self.assertEqual(line([{'what': 'Send comments', 'due': '', 'owner': ''}]), 'Send comments')
        self.assertEqual(line([{'what': 'A', 'due': '', 'owner': ''}, {'what': 'B', 'due': '', 'owner': ''}, {'what': 'C', 'due': '', 'owner': ''}]), 'A; B')
        self.assertEqual(line([]), '')


if __name__ == '__main__':
    unittest.main()
