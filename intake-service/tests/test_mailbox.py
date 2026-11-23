"""The Graph side of mail, against a scripted client: no network. Invented mailboxes and mail."""
import json
import unittest
from datetime import datetime, timezone

import helpers  # noqa: F401  (puts the package on the path)
from intake import mailbox as mb


class GraphErr(Exception):
    def __init__(self, status):
        super().__init__(str(status))
        self.status = status


class Scripted:
    """Answers each call from a function of (method, path, body); records every call."""

    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    def call(self, method, path, body=None, content_type=None, retries=4, raw=False):
        self.calls.append((method, path, body, content_type))
        result = self.answer(method, path, body)
        if isinstance(result, Exception):
            raise result
        return result


def graph_message(mid='AAA=', **kw):
    node = {
        'id': mid, 'internetMessageId': f'<{mid}@mail.example>', 'conversationId': 'conv-1',
        'subject': '  RE: Harbour Bridge -  Concession Agreement ',
        'from': {'emailAddress': {'name': 'Dana Whitlock', 'address': 'Dana.Whitlock@Northwind-Holdings.example'}},
        'toRecipients': [{'emailAddress': {'name': 'A One', 'address': 'Associate.One@akla.com.pk'}}],
        'ccRecipients': [{'emailAddress': {'name': 'P Two', 'address': 'partner.two@akla.com.pk'}}, {'emailAddress': {}}],
        'receivedDateTime': '2026-11-20T09:15:00Z', 'sentDateTime': '2026-11-20T09:14:30Z',
        'body': {'contentType': 'text', 'content': 'Please send the mark-up by Monday.\r\n\r\n'
                                                   '________________________________\r\nFrom: A One\r\nSent: 19 November 2026\r\n'
                                                   'Subject: Concession Agreement\r\n\r\nDraft attached.'},
        'uniqueBody': {'contentType': 'text', 'content': 'Please send the mark-up by Monday.'},
        'internetMessageHeaders': [{'name': 'List-Unsubscribe', 'value': '<u>'}, {'name': 'Precedence', 'value': 'bulk'}],
        'attachments': [{'name': 'CA mark-up v3.docx', 'isInline': False}, {'name': 'image001.png', 'isInline': True}],
    }
    node.update(kw)
    return node


class DeltaTest(unittest.TestCase):
    def test_first_read_asks_only_for_mail_from_the_baseline_on(self):
        since = datetime(2026, 11, 23, 10, 0, tzinfo=timezone.utc)
        client = Scripted(lambda m, p, b: {'value': [], '@odata.deltaLink': 'https://graph.test/delta/1'})
        items, link = mb.read_first(client, 'associate.one@akla.com.pk', 'inbox', since)
        self.assertEqual((items, link), ([], 'https://graph.test/delta/1'))
        path = client.calls[0][1]
        self.assertTrue(path.startswith('/users/associate.one@akla.com.pk/mailFolders/inbox/messages/delta?'))
        self.assertIn('$filter=receivedDateTime%20ge%202026-11-23T10:00:00Z', path)
        self.assertIn('$select=id,internetMessageId,receivedDateTime,isDraft', path)
        self.assertNotIn(' ', path)

    def test_a_refused_filter_falls_back_to_walking_the_folder_for_ids(self):
        def answer(method, path, body):
            if '$filter' in path:
                return GraphErr(400)
            return {'value': [{'id': 'old', 'receivedDateTime': '2020-01-01T00:00:00Z'}], '@odata.deltaLink': 'https://graph.test/d'}
        client = Scripted(answer)
        items, link = mb.read_first(client, 'a@akla.com.pk', 'sentitems', datetime(2026, 11, 23, tzinfo=timezone.utc))
        self.assertEqual(link, 'https://graph.test/d')
        self.assertEqual(items[0]['received'].year, 2020)      # the caller drops what is older than the baseline
        self.assertEqual(len(client.calls), 2)

    def test_delta_follows_pages_and_skips_removed_drafts_and_repeats(self):
        pages = {
            'https://graph.test/delta/1': {'value': [
                {'id': 'm1', 'internetMessageId': '<m1@x.example>', 'receivedDateTime': '2026-11-20T09:00:00Z'},
                {'id': 'gone', '@removed': {'reason': 'deleted'}},
                {'id': 'draft', 'isDraft': True}], '@odata.nextLink': 'https://graph.test/next/2'},
            'https://graph.test/next/2': {'value': [
                {'id': 'm1', 'receivedDateTime': '2026-11-20T09:00:00Z'},
                {'id': 'm2', 'receivedDateTime': '2026-11-20T10:00:00Z'}], '@odata.deltaLink': 'https://graph.test/delta/2'},
        }
        client = Scripted(lambda m, p, b: pages[p])
        items, link = mb.read_delta(client, 'https://graph.test/delta/1')
        self.assertEqual([i['id'] for i in items], ['m1', 'm2'])
        self.assertEqual(items[0]['key'], '<m1@x.example>')
        self.assertEqual(items[1]['key'], '')
        self.assertEqual(items[0]['received'], datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc))
        self.assertEqual(link, 'https://graph.test/delta/2')

    def test_a_cursor_graph_no_longer_accepts_is_reported_as_expired(self):
        for status in (400, 410):
            with self.assertRaises(mb.CursorExpired):
                mb.read_delta(Scripted(lambda m, p, b: GraphErr(status)), 'https://graph.test/delta/old')
        with self.assertRaises(GraphErr):                      # anything else is a real failure
            mb.read_delta(Scripted(lambda m, p, b: GraphErr(403)), 'https://graph.test/delta/old')


class FetchTest(unittest.TestCase):
    def test_messages_come_in_small_batches_with_text_bodies_and_attachment_names_only(self):
        def answer(method, path, body):
            requests = json.loads(body)['requests']
            return {'responses': [{'id': r['id'], 'status': 200, 'body': graph_message(r['url'].split('/messages/')[1].split('?')[0])}
                                  for r in reversed(requests)]}
        client = Scripted(answer)
        ids = [f'id{i}' for i in range(6)]
        nodes, failed = mb.fetch_messages(client, 'a@akla.com.pk', ids)
        self.assertEqual([n['id'] for n in nodes], ids)        # in the order asked, whatever order Graph answers in
        self.assertEqual(failed, [])
        self.assertEqual(len(client.calls), 2)                 # 4 + 2
        method, path, body, content_type = client.calls[0]
        self.assertEqual((method, path, content_type), ('POST', '/$batch', 'application/json'))
        request = json.loads(body)['requests'][0]
        self.assertEqual(request['headers'], {'Prefer': 'outlook.body-content-type="text"'})
        self.assertIn('$expand=attachments($select=name,isInline)', request['url'])
        for never in ('contentBytes', '$value', '/attachments/'):
            self.assertNotIn(never, request['url'])
        self.assertNotIn('contentBytes', mb.MESSAGE_SELECT + mb.ATTACHMENT_EXPAND)

    def test_a_deleted_message_is_skipped_and_a_throttled_one_is_asked_for_again(self):
        def answer(method, path, body):
            if method == 'POST':
                return {'responses': [{'id': '0', 'status': 404}, {'id': '1', 'status': 429}, {'id': '2', 'status': 500}]}
            if '/messages/busy' in path:
                return graph_message('busy')
            return GraphErr(500)
        client = Scripted(answer)
        nodes, failed = mb.fetch_messages(client, 'a@akla.com.pk', ['gone', 'busy', 'broken'])
        self.assertEqual([n['id'] for n in nodes], ['busy'])
        self.assertEqual(failed, ['broken'])

    def test_no_permission_inside_a_fetch_is_raised_not_swallowed(self):
        def answer(method, path, body):
            return {'responses': [{'id': '0', 'status': 403}]} if method == 'POST' else GraphErr(403)
        with self.assertRaises(GraphErr):
            mb.fetch_messages(Scripted(answer), 'a@akla.com.pk', ['m1'])


class NeutralTest(unittest.TestCase):
    def test_the_neutral_message(self):
        m = mb.to_neutral(graph_message(), 'Associate.One@akla.com.pk', 'inbox')
        self.assertEqual(set(m), {'source', 'key', 'conversation', 'mailbox', 'folder', 'sender_name', 'sender_address',
                                  'to', 'cc', 'sent_at', 'subject', 'newest_text', 'thread_text', 'headers', 'attachments'})
        self.assertEqual((m['source'], m['key'], m['conversation']), ('email', '<AAA=@mail.example>', 'conv-1'))
        self.assertEqual((m['mailbox'], m['folder']), ('associate.one@akla.com.pk', 'inbox'))
        self.assertEqual((m['sender_name'], m['sender_address']), ('Dana Whitlock', 'dana.whitlock@northwind-holdings.example'))
        self.assertEqual((m['to'], m['cc']), (['associate.one@akla.com.pk'], ['partner.two@akla.com.pk']))
        self.assertEqual(m['sent_at'], datetime(2026, 11, 20, 9, 14, 30, tzinfo=timezone.utc))
        self.assertEqual(m['subject'], 'RE: Harbour Bridge - Concession Agreement')
        self.assertEqual(m['newest_text'], 'Please send the mark-up by Monday.')
        self.assertTrue(m['thread_text'].startswith('________________________________\nFrom: A One'))
        self.assertIn('Draft attached.', m['thread_text'])
        self.assertEqual(m['headers'], {'list-unsubscribe': '<u>', 'precedence': 'bulk'})
        self.assertEqual(m['attachments'], ['CA mark-up v3.docx'])        # the inline image is not an attachment

    def test_the_key_falls_back_to_the_graph_id_and_the_time_to_received(self):
        m = mb.to_neutral(graph_message('ZZZ', internetMessageId=None, sentDateTime=None), 'a@akla.com.pk', 'sentitems')
        self.assertEqual((m['key'], m['folder']), ('ZZZ', 'sentitems'))
        self.assertEqual(m['sent_at'], datetime(2026, 11, 20, 9, 15, tzinfo=timezone.utc))
        self.assertIsNotNone(m['sent_at'].tzinfo)

    def test_a_bare_message_does_not_break(self):
        m = mb.to_neutral({'id': 'x'}, 'a@akla.com.pk', 'inbox')
        self.assertEqual((m['sender_address'], m['to'], m['newest_text'], m['thread_text'], m['attachments']), ('', [], '', '', []))


class SplitThreadTest(unittest.TestCase):
    def test_a_fresh_email_is_all_newest(self):
        newest, thread = mb.split_thread({'contentType': 'text', 'content': 'Hello,\nThe term sheet is attached.'}, None)
        self.assertEqual((newest, thread), ('Hello,\nThe term sheet is attached.', ''))

    def test_text_reply_without_unique_body_is_cut_at_the_marker(self):
        for marker in ('-----Original Message-----\nFrom: B', 'On Thu, 19 Nov 2026 at 10:02, B Person <b@x.example> wrote:',
                       'From: B Person\nSent: Thursday', '> earlier line'):
            body = {'contentType': 'text', 'content': f'Noted, will revert tomorrow.\n\n{marker}\nOld text about the escrow.'}
            newest, thread = mb.split_thread(body, {'contentType': 'text', 'content': ''})
            self.assertEqual(newest, 'Noted, will revert tomorrow.', marker)
            self.assertIn('Old text about the escrow.', thread, marker)

    def test_a_forward_with_nothing_written_above_is_all_newest(self):
        body = {'contentType': 'text', 'content': 'From: B Person\nSent: Thursday\nSubject: Draft\n\nThe draft is attached.'}
        newest, thread = mb.split_thread(body, None)
        self.assertIn('The draft is attached.', newest)
        self.assertEqual(thread, '')

    def test_html_reply_is_cut_at_outlooks_and_gmails_markers(self):
        outlook = ('<html><head><style>p{color:red}</style></head><body><p>Agreed &amp; thanks.</p>'
                   '<div id="divRplyFwdMsg"><b>From:</b> B<br><b>Sent:</b> Thursday</div><p>Old text.</p></body></html>')
        gmail = '<div>Agreed &amp; thanks.</div><div class="gmail_quote">On Thu B wrote:<blockquote>Old text.</blockquote></div>'
        for content in (outlook, gmail):
            newest, thread = mb.split_thread({'contentType': 'html', 'content': content}, None)
            self.assertEqual(newest, 'Agreed & thanks.')
            self.assertIn('Old text.', thread)
            self.assertNotIn('color:red', newest + thread)

    def test_html_unique_body_is_used_as_the_newest(self):
        body = {'contentType': 'html', 'content': '<p>Agreed.</p><blockquote>Old text.</blockquote>'}
        newest, thread = mb.split_thread(body, {'contentType': 'html', 'content': '<p>Agreed.</p>'})
        self.assertEqual((newest, thread), ('Agreed.', 'Old text.'))

    def test_when_the_two_cannot_be_told_apart_the_rest_is_kept_as_thread(self):
        body = {'contentType': 'text', 'content': 'Agreed.\n\nSome earlier words with no marker at all.'}
        newest, thread = mb.split_thread(body, {'contentType': 'text', 'content': 'Agreed.'})
        self.assertEqual((newest, thread), ('Agreed.', 'Some earlier words with no marker at all.'))


class StateTest(unittest.TestCase):
    def test_state_is_read_and_saved_by_mailbox_and_folder(self):
        class Db:
            def __init__(self):
                self.saved = []

            def one(self, table, filters, columns='*'):
                self.asked = (table, filters)
                return {'mailbox': 'a@akla.com.pk', 'folder': 'inbox', 'delta_link': 'L', 'baseline_at': 'T'}

            def upsert(self, table, rows, on_conflict):
                self.saved.append((table, rows, on_conflict))
        db = Db()
        self.assertEqual(mb.load_state(db, 'a@akla.com.pk', 'inbox')['delta_link'], 'L')
        self.assertEqual(db.asked, ('intake_mail_state', {'mailbox': 'eq.a@akla.com.pk', 'folder': 'eq.inbox'}))
        mb.save_state(db, 'a@akla.com.pk', 'inbox', 'L2', '2026-11-23T10:00:00+00:00')
        table, row, conflict = db.saved[0]
        self.assertEqual((table, conflict), ('intake_mail_state', 'mailbox,folder'))
        self.assertEqual((row['delta_link'], row['baseline_at']), ('L2', '2026-11-23T10:00:00+00:00'))


if __name__ == '__main__':
    unittest.main()
