"""The mail run end to end against a fake Graph, a fake database and a fake classifier: baselines,
the cursor, one mailbox failing, the caps, and what the log may say. Invented mailboxes and mail."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import helpers  # noqa: F401  (puts the package on the path)
from intake import mail, mailbox as mb
from test_messages import ROWS, FakeClassifier, FakeDb, FakeMatcher, read

A, B = 'asha.one@akla.com.pk', 'partner.two@akla.com.pk'
LONG_AGO = '2026-11-01T00:00:00+00:00'
SETTINGS = {'mail_enabled': True, 'mail_mailboxes': [A]}


class GraphErr(Exception):
    def __init__(self, status):
        super().__init__(str(status))
        self.status = status


def node(mid, subject='Harbour Bridge - Concession Agreement', body='Please send the mark-up of the agreement by Monday.',
         minutes=0, sender='dana@northwind-holdings.example', key=None, **kw):
    when = (datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)).strftime('%Y-%m-%dT%H:%M:%SZ')
    out = {'id': mid, 'internetMessageId': key or f'<{mid}@mail.example>', 'conversationId': f'conv-{mid}', 'subject': subject,
           'from': {'emailAddress': {'name': 'Dana Whitlock', 'address': sender}},
           'toRecipients': [{'emailAddress': {'address': A}}], 'receivedDateTime': when, 'sentDateTime': when,
           'body': {'contentType': 'text', 'content': body}, 'uniqueBody': {'contentType': 'text', 'content': body}}
    out.update(kw)
    return out


BULK = [{'name': 'List-Unsubscribe', 'value': '<https://shop.example/u>'}]


class FakeGraph:
    """Folders of messages. A delta link is 'https://graph.test/<mailbox>/<folder>/<n>': everything in the
    folder from position n on is what changed since."""

    def __init__(self):
        self.folders = {}            # (mailbox, folder) -> [node]
        self.fail = {}               # mailbox -> status
        self.expired = set()         # delta links Graph no longer accepts
        self.unfetchable = set()     # message ids whose fetch fails
        self.calls = []
        self.fetched = []

    def put(self, mailbox, folder, *nodes):
        self.folders.setdefault((mailbox, folder), []).extend(nodes)

    def _page(self, mailbox, folder, start):
        nodes = self.folders.get((mailbox, folder), [])
        value = [{'id': n['id'], 'internetMessageId': n.get('internetMessageId'), 'receivedDateTime': n['receivedDateTime']}
                 for n in nodes[start:]]
        return {'value': value, '@odata.deltaLink': f'https://graph.test/{mailbox}/{folder}/{len(nodes)}'}

    def call(self, method, path, body=None, content_type=None, retries=4, raw=False):
        self.calls.append((method, path))
        if path.startswith('https://graph.test/'):
            if path in self.expired:
                raise GraphErr(410)
            mailbox, folder, start = path[len('https://graph.test/'):].split('/')
            self._check(mailbox)
            return self._page(mailbox, folder, int(start))
        if '/messages/delta' in path:
            mailbox = path.split('/users/')[1].split('/')[0]
            folder = path.split('/mailFolders/')[1].split('/')[0]
            self._check(mailbox)
            return self._page(mailbox, folder, 0)       # the fake ignores the date filter: the run must still drop old mail
        if path == '/$batch':
            responses = []
            for request in json.loads(body)['requests']:
                mailbox = request['url'].split('/users/')[1].split('/')[0]
                mid = request['url'].split('/messages/')[1].split('?')[0]
                self._check(mailbox)
                found = next((n for (m, _), nodes in self.folders.items() if m == mailbox for n in nodes if n['id'] == mid), None)
                if mid in self.unfetchable:
                    responses.append({'id': request['id'], 'status': 500})
                elif found is None:
                    responses.append({'id': request['id'], 'status': 404})
                else:
                    self.fetched.append(mid)
                    responses.append({'id': request['id'], 'status': 200, 'body': found})
            return {'responses': responses}
        raise GraphErr(500)

    def _check(self, mailbox):
        if mailbox in self.fail:
            raise GraphErr(self.fail[mailbox])


def new_db(settings=None, baselined=(A,), **tables):
    """A database whose listed mailboxes were baselined long ago, so everything in the fake folders is new."""
    state = [{'mailbox': box, 'folder': folder, 'delta_link': f'https://graph.test/{box}/{folder}/0', 'baseline_at': LONG_AGO}
             for box in baselined for folder in mb.FOLDERS]
    tables.setdefault('transaction_rows', [dict(r) for r in ROWS])
    tables.setdefault('profiles', [{'id': 'profile-intake', 'full_name': 'Hub Intake', 'status': 'approved'},
                                   {'id': 'profile-asha', 'full_name': 'Asha One', 'status': 'approved'}])
    return FakeDb(dict(SETTINGS, **(settings or {})), intake_mail_state=state, **tables)


def run(db, graph, classifier, **kw):
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        summary = mail.run_mail(db, graph=graph, classifier=classifier, matcher=FakeMatcher(), **kw)
    return summary, log.getvalue()


def link(db, mailbox, folder):
    return db.one('intake_mail_state', {'mailbox': f'eq.{mailbox}', 'folder': f'eq.{folder}'})['delta_link']


class SwitchedOffTest(unittest.TestCase):
    def test_mail_enabled_false_says_so_and_does_nothing(self):
        db, graph = FakeDb({'mail_enabled': False, 'mail_mailboxes': [A]}), FakeGraph()
        summary, log = run(db, graph, FakeClassifier())
        self.assertFalse(summary['enabled'])
        self.assertEqual((graph.calls, db.writes), ([], []))
        self.assertEqual(len(log.strip().splitlines()), 1)
        self.assertIn('switched off', log)
        self.assertIn('Mail.Read consent', log)

    def test_the_default_is_off(self):
        summary, _ = run(FakeDb(), FakeGraph(), FakeClassifier())
        self.assertFalse(summary['enabled'])

    def test_no_mailboxes_says_so_and_does_nothing(self):
        db, graph = FakeDb({'mail_enabled': True, 'mail_mailboxes': []}), FakeGraph()
        summary, log = run(db, graph, FakeClassifier())
        self.assertEqual((graph.calls, db.writes, summary['mailboxes']), ([], [], 0))
        self.assertEqual(len(log.strip().splitlines()), 1)
        self.assertIn('no mailboxes', log)


class BaselineTest(unittest.TestCase):
    def test_the_first_run_only_takes_a_baseline_and_reads_nothing_older(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('old1'), node('old2', minutes=5))
        graph.put(A, 'sentitems', node('old3', minutes=9))
        db, classifier = new_db(baselined=()), FakeClassifier(read())
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['baselined'], summary['seen'], summary['handled'], summary['cursors_saved']), (2, 0, 0, 2))
        self.assertEqual((graph.fetched, classifier.seen, db.rows('intake_messages')), ([], [], []))
        first = [path for _, path in graph.calls if '/messages/delta' in path]
        self.assertEqual(len(first), 2)
        self.assertTrue(all('$filter=receivedDateTime%20ge%20' in path for path in first))
        state = db.one('intake_mail_state', {'mailbox': f'eq.{A}', 'folder': 'eq.inbox'})
        self.assertEqual(state['delta_link'], f'https://graph.test/{A}/inbox/2')
        self.assertGreater(mb.parse_time(state['baseline_at']), datetime(2026, 11, 22, tzinfo=timezone.utc))

        # mail that arrives afterwards is read by the next run; the old mail still is not
        late = (datetime.now(timezone.utc) + timedelta(minutes=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
        graph.put(A, 'inbox', node('new1', receivedDateTime=late, sentDateTime=late))
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['seen'], summary['acted'], graph.fetched), (1, 1, ['new1']))

    def test_old_mail_that_was_only_touched_is_never_read(self):
        """Delta also reports a message that was merely marked read or moved in."""
        graph = FakeGraph()
        graph.put(A, 'inbox', node('ancient', receivedDateTime='2026-10-01T08:00:00Z'), node('new1'))
        db, classifier = new_db(), FakeClassifier(read())
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['seen'], graph.fetched), (1, ['new1']))

    def test_a_cursor_graph_no_longer_accepts_starts_a_fresh_baseline(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1'))
        graph.expired.add(f'https://graph.test/{A}/inbox/0')
        db, classifier = new_db(), FakeClassifier(read())
        summary, log = run(db, graph, classifier)
        self.assertEqual((summary['rebaselined'], summary['baselined'], summary['handled'], graph.fetched), (1, 0, 0, []))
        self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/1')
        self.assertIn('starting afresh', log)
        self.assertEqual(db.rows('intake_runs')[0]['ok'], True)


class CursorTest(unittest.TestCase):
    def test_the_cursor_moves_after_a_fully_handled_batch(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m2', minutes=10), node('m1'), node('m3', subject='Weekend offers', body='Sale now on.', sender='news@shop.example',
                                                                       minutes=20, internetMessageHeaders=BULK))
        db, classifier = new_db(), FakeClassifier(read(), read(gist='A second note.', action_items=[]))
        summary, _ = run(db, graph, classifier)
        self.assertEqual(classifier.seen, ['<m1@mail.example>', '<m2@mail.example>'], 'oldest first; the newsletter never reaches Claude')
        self.assertEqual((summary['seen'], summary['handled'], summary['acted'], summary['dropped']), (3, 3, 2, 1))
        self.assertEqual((summary['lines_added'], summary['notes_added'], summary['claude_calls'], summary['usd']), (2, 2, 2, 0.0008))
        self.assertEqual(summary['by_rule'], {'automated_bulk': 1})
        self.assertEqual((summary['cursors_saved'], summary['unfinished']), (2, []))
        self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/3')
        runs = db.rows('intake_runs')
        self.assertEqual((len(runs), runs[0]['kind'], runs[0]['ok'], runs[0]['summary']['acted']), (1, 'mail', True, 2))
        json.dumps(runs[0]['summary'])                      # the run record must be plain JSON

        summary, log = run(db, graph, classifier)           # nothing new: a quiet run leaves no record
        self.assertEqual((summary['seen'], len(db.rows('intake_runs'))), (0, 1))
        self.assertIn('nothing new', log)

    def test_at_a_cap_the_cursor_stays_and_the_next_run_finishes_the_batch(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1'), node('m2', minutes=10), node('m3', minutes=20))
        db = new_db({'claude_daily_calls': 1})
        classifier = FakeClassifier(read(), read(gist='Second.', action_items=[]), read(gist='Third.', action_items=[]))
        summary, log = run(db, graph, classifier)
        self.assertEqual((summary['acted'], summary['waiting'], summary['unfinished']), (1, 1, [f'{A}/inbox']))
        self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/0', 'not saved: the batch is unfinished')
        self.assertEqual(link(db, A, 'sentitems'), f'https://graph.test/{A}/sentitems/0')
        self.assertEqual(len(db.rows('intake_messages')), 1, 'the waiting messages are not recorded')
        self.assertIn('1 of 1 reads today', log)

        db.settings['claude_daily_calls'] = 300             # the next day
        graph.fetched.clear()
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['seen'], summary['already_recorded'], summary['acted']), (3, 1, 2))
        self.assertEqual(graph.fetched, ['m2', 'm3'], 'the recorded one is skipped without fetching it again')
        self.assertEqual(classifier.seen, ['<m1@mail.example>', '<m2@mail.example>', '<m3@mail.example>'])
        self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/3')
        self.assertEqual(len(db.rows('transaction_updates')), 3)

    def test_a_failed_claude_read_stops_the_folder_and_is_tried_again(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1'), node('m2', minutes=10))
        db, classifier = new_db(), FakeClassifier(None, read(), read(gist='Second.', action_items=[]), failure='unparsable')
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['error'], summary['acted'], summary['unfinished']), (1, 0, [f'{A}/inbox']))
        self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/0')
        self.assertEqual(db.rows('transaction_updates'), [])
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['error'], summary['acted'], summary['unfinished']), (0, 2, []))
        self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/2')
        self.assertEqual([m['outcome'] for m in db.rows('intake_messages')], ['acted', 'acted'])

    def test_a_message_that_cannot_be_fetched_holds_the_cursor_but_not_the_others(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1'), node('m2', minutes=10))
        graph.unfetchable.add('m1')
        db, classifier = new_db(), FakeClassifier(read())
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['fetch_failed'], summary['acted'], summary['unfinished']), (1, 1, [f'{A}/inbox']))
        self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/0')

    def test_the_limit_stops_early_without_moving_the_cursor(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1'), node('m2', minutes=10))
        db, classifier = new_db(), FakeClassifier(read(), read())
        summary, _ = run(db, graph, classifier, limit=1)
        self.assertEqual((summary['handled'], len(classifier.seen)), (1, 1))
        self.assertIn(f'{A}/inbox', summary['unfinished'])
        self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/0')

    def test_a_dry_run_writes_nothing_and_saves_no_cursor(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1'))
        db, classifier = new_db(), FakeClassifier(read())
        summary, log = run(db, graph, classifier, dry_run=True)
        self.assertEqual((summary['acted'], summary['lines_added'], summary['cursors_saved'], db.writes), (1, 1, 0, []))
        self.assertIn('would:', log)
        self.assertIn('(dry run)', log)

    def test_since_reads_recent_mail_on_a_dry_run_whatever_the_cursor_says(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m0', receivedDateTime='2026-11-10T08:00:00Z'), node('m1'))
        db = new_db()
        db.rows('intake_mail_state')[0]['delta_link'] = f'https://graph.test/{A}/inbox/2'      # the cursor is already past both
        summary, _ = run(db, graph, FakeClassifier(read()), dry_run=True, since=datetime(2026, 11, 15, tzinfo=timezone.utc))
        self.assertEqual((summary['seen'], summary['acted'], db.writes), (1, 1, []))


class MailboxesTest(unittest.TestCase):
    def test_one_mailbox_without_permission_does_not_stop_the_next(self):
        for status, words in ((403, 'no permission'), (404, 'no such mailbox')):
            graph = FakeGraph()
            graph.fail[A] = status
            graph.put(B, 'inbox', node('m1'))
            db, classifier = new_db({'mail_mailboxes': [A, B]}, baselined=(A, B)), FakeClassifier(read())
            summary, log = run(db, graph, classifier)
            self.assertEqual(list(summary['mailbox_errors']), [A])
            self.assertIn(words, summary['mailbox_errors'][A])
            self.assertIn(words, log)
            self.assertEqual((summary['acted'], summary['cursors_saved']), (1, 2), 'the second mailbox was read in full')
            self.assertEqual(link(db, A, 'inbox'), f'https://graph.test/{A}/inbox/0')
            self.assertEqual(len([c for c in graph.calls if A in c[1]]), 1, 'the refused mailbox is not asked again for its other folder')
            self.assertEqual(db.rows('intake_runs')[0]['ok'], False)

    def test_one_email_in_two_mailboxes_is_handled_once(self):
        graph = FakeGraph()
        shared = '<shared@mail.example>'
        graph.put(A, 'inbox', node('a1', key=shared))
        graph.put(B, 'inbox', node('b1', key=shared))
        db, classifier = new_db({'mail_mailboxes': [A, B]}, baselined=(A, B)), FakeClassifier(read(), read())
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['acted'], summary['already_recorded'], len(classifier.seen)), (1, 1, 1))
        self.assertEqual(graph.fetched, ['a1'], 'the second copy is recognised by its key, not fetched')
        rows = db.rows('intake_messages')
        self.assertEqual((len(rows), rows[0]['mailboxes']), (1, [A, B]))
        self.assertEqual(len(db.rows('transaction_updates')), 1)
        self.assertEqual(summary['cursors_saved'], 4)

    def test_the_mailboxes_argument_replaces_the_setting(self):
        graph = FakeGraph()
        graph.put(B, 'inbox', node('m1'))
        db = new_db(baselined=(A, B))
        summary, _ = run(db, graph, FakeClassifier(read()), mailboxes=[f' {B.upper()} '])
        self.assertEqual((summary['mailboxes'], summary['acted']), (1, 1))
        self.assertFalse(any(A in path for _, path in graph.calls))


class PrivacyTest(unittest.TestCase):
    def test_withheld_mail_is_counted_by_rule_and_never_named(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1', subject='Okapi salary review', body='The narwhal figures are attached.'),
                  node('m2', subject='Personal - Okapi', body='narwhal weekend plans', minutes=5),
                  node('m3', subject='Okapi appraisal follow up', body='narwhal notes', minutes=10))
        graph.put(A, 'sentitems', node('m4', subject='RE: Okapi', body='Your bonus narwhal is approved.', sender=A, minutes=15))
        db, classifier = new_db(), FakeClassifier()
        summary, log = run(db, graph, classifier)
        self.assertEqual((summary['withheld'], classifier.seen), (4, []))
        self.assertEqual(summary['by_rule'], {'never_share:pay': 2, 'never_share:marked_private': 1, 'never_share:appraisal': 1})
        self.assertIn('never_share:pay 2', log)
        everything = log + db.dump() + json.dumps(summary, default=str)
        for secret in ('Okapi', 'narwhal', 'Dana', 'northwind', '@mail.example', 'conv-m'):
            self.assertNotIn(secret, everything, secret)
        self.assertEqual(summary['cursors_saved'], 2)
        self.assertEqual({r['outcome'] for r in db.rows('intake_messages')}, {'withheld'})
        self.assertEqual(sorted(r['folder'] for r in db.rows('intake_messages')), ['inbox', 'inbox', 'inbox', 'sentitems'])

    def test_a_withheld_message_read_again_is_recognised_without_being_fetched(self):
        """It is filed under a hash of its key; a batch that is re-read must still know it."""
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1', subject='Okapi salary review', body='narwhal'), node('m2', minutes=5))
        db, classifier = new_db({'claude_daily_calls': 0}), FakeClassifier(read())
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['withheld'], summary['waiting'], summary['unfinished']), (1, 1, [f'{A}/inbox']))
        db.settings['claude_daily_calls'] = 300
        graph.fetched.clear()
        summary, _ = run(db, graph, classifier)
        self.assertEqual((summary['already_recorded'], summary['withheld'], summary['acted'], graph.fetched), (1, 0, 1, ['m2']))
        self.assertEqual(sorted(r['outcome'] for r in db.rows('intake_messages')), ['acted', 'withheld'])

    def test_a_dry_run_prints_nothing_about_withheld_or_dropped_mail(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1', subject='Okapi salary review', body='narwhal'),
                  node('m2', subject='Okapi offers', body='narwhal sale', sender='news@shop.example', minutes=5,
                       internetMessageHeaders=BULK))
        summary, log = run(new_db(), graph, FakeClassifier(), dry_run=True)
        self.assertEqual((summary['withheld'], summary['dropped']), (1, 1))
        self.assertNotIn('would:', log)
        for secret in ('Okapi', 'narwhal', 'shop.example'):
            self.assertNotIn(secret, log)

    def test_the_log_never_carries_a_subject_or_a_sender_on_a_real_run(self):
        graph = FakeGraph()
        graph.put(A, 'inbox', node('m1'))
        _, log = run(new_db(), graph, FakeClassifier(read()))
        for text in ('Harbour', 'Concession', 'Dana', 'northwind'):
            self.assertNotIn(text, log)


class FromFolderTest(unittest.TestCase):
    def folder(self):
        tmp = tempfile.mkdtemp(prefix='intake-mail-test-')
        samples = {'1-work.json': node('m1'),
                   '2-pay.json': node('m2', subject='Okapi salary review', body='narwhal figures', minutes=5),
                   '3-news.json': dict(node('m3', subject='Offers', body='Sale.', sender='news@shop.example', minutes=10,
                                         internetMessageHeaders=BULK), folder='inbox'),
                   '4-sent.json': dict(node('m4', subject='Sunday', body='See you at seven.', sender=A, minutes=15,
                                            toRecipients=[{'emailAddress': {'address': 'brother@gmail.com'}}]), folder='sentitems'),
                   'notes.txt': 'not a message', '5-broken.json': '{not json'}
        for name, content in samples.items():
            with open(os.path.join(tmp, name), 'w', encoding='utf8') as fh:
                fh.write(content if isinstance(content, str) else json.dumps(content))
        return tmp

    def test_rules_only_needs_no_claude_and_no_database(self):
        log = io.StringIO()
        with contextlib.redirect_stdout(log):
            summary = mail.run_mail_from_folder(None, self.folder(), rules_only=True)
        self.assertEqual((summary['seen'], summary['to_read'], summary['withheld'], summary['dropped'], summary['fetch_failed']), (4, 1, 1, 2, 1))
        self.assertEqual(summary['by_rule'], {'work_signal': 1, 'never_share:pay': 1, 'automated_bulk': 1,
                                              'personal_recipients_no_work_signal': 1})
        self.assertNotIn('Okapi', log.getvalue())

    def test_a_folder_run_is_a_dry_run_unless_told_otherwise(self):
        db, classifier, log = new_db(), FakeClassifier(read()), io.StringIO()
        with contextlib.redirect_stdout(log):
            summary = mail.run_mail_from_folder(db, self.folder(), mailbox=A, classifier=classifier, matcher=FakeMatcher())
        self.assertEqual((summary['acted'], summary['withheld'], summary['dropped'], summary['dry_run'], db.writes), (1, 1, 2, True, []))
        self.assertIn('would:', log.getvalue())

    def test_a_folder_run_can_write_and_touches_no_cursor(self):
        db, classifier = new_db({'mail_enabled': False}), FakeClassifier(read())
        before = json.dumps(db.rows('intake_mail_state'))
        with contextlib.redirect_stdout(io.StringIO()):
            summary = mail.run_mail_from_folder(db, self.folder(), mailbox=A, dry_run=False, classifier=classifier, matcher=FakeMatcher())
        self.assertEqual((summary['acted'], len(db.rows('intake_messages')), len(db.rows('transaction_updates'))), (1, 4, 1))
        self.assertEqual(json.dumps(db.rows('intake_mail_state')), before)
        self.assertEqual(db.rows('intake_runs')[0]['kind'], 'mail')
        sent = next(r for r in db.rows('intake_messages') if r['folder'] == 'sentitems')
        self.assertEqual((sent['outcome'], sent['rule']), ('dropped', 'personal_recipients_no_work_signal'))


if __name__ == '__main__':
    unittest.main()
