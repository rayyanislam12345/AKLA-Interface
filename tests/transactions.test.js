import test from 'node:test';
import assert from 'node:assert/strict';
// Node strips the types from this file itself, so the tests run against the
// very code the browser uses rather than a copy.
import {
  changeLine,
  changeLines,
  daysSince,
  formatUpdateStamp,
  formatUpdateStampLong,
  formatLongDate,
  groupByPerson,
  groupByProject,
  isMovedToday,
  isStale,
  karachiDateKey,
  readTrayItem,
  rowMatches,
} from '../src/lib/transactions.ts';

const row = (over) => ({
  id: 'r', sort_order: 1, client: 'KPT', project: 'Corridor', deliverable: 'Concession Agreement',
  team: ['Usama'], currently_with: 'Boss', status: 'In Progress', latest_update: null, latest_update_at: null,
  created_at: '2026-10-01T05:00:00Z', ...over,
});

test('dates are stamped on Karachi time in the sheet\'s own format', () => {
  // 04:14 UTC is 09:14 in Karachi; 20:30 UTC on the 27th is already the 28th there.
  assert.equal(formatUpdateStamp('2026-10-28T04:14:00Z', 'Usama'), 'Oct 28 [09:14 · Usama]');
  assert.equal(formatUpdateStamp('2026-10-27T20:30:00Z', null), 'Oct 28 [01:30]');
  assert.equal(formatUpdateStampLong('2026-10-28T04:14:00Z', 'Usama'), 'October 28, 2026 [09:14 · Usama]');
  assert.equal(formatLongDate('2026-11-11T12:00:00Z'), 'November 11, 2026');
  assert.equal(karachiDateKey('2026-10-27T20:30:00Z'), '2026-10-28');
  assert.equal(formatUpdateStamp('not a date', 'x'), '');
});

test('moved today and stale follow the Karachi calendar and the firm\'s setting', () => {
  const now = new Date('2026-11-11T06:00:00Z');
  assert.equal(isMovedToday(row({ latest_update_at: '2026-11-10T20:00:00Z' }), now), true);
  assert.equal(isMovedToday(row({ latest_update_at: '2026-11-10T10:00:00Z' }), now), false);
  assert.equal(isMovedToday(row({ latest_update_at: null }), now), false);
  assert.equal(daysSince('2026-11-01T06:00:00Z', now), 10);
  // Exactly the limit is not yet stale; one day more is.
  assert.equal(isStale(row({ latest_update_at: '2026-11-01T06:00:00Z' }), 10, now), false);
  assert.equal(isStale(row({ latest_update_at: '2026-10-31T06:00:00Z' }), 10, now), true);
  assert.equal(isStale(row({ latest_update_at: '2026-10-31T06:00:00Z' }), 15, now), false);
  // Never updated: counted from creation. Closed and On Hold never go stale.
  assert.equal(isStale(row({ created_at: '2026-09-01T06:00:00Z' }), 10, now), true);
  assert.equal(isStale(row({ status: 'Closed', latest_update_at: '2026-01-01T06:00:00Z' }), 10, now), false);
  assert.equal(isStale(row({ status: 'On Hold', latest_update_at: '2026-01-01T06:00:00Z' }), 10, now), false);
});

test('a Hub edit leaves the line a person would have typed in the sheet', () => {
  assert.equal(changeLine('status', 'With Boss', 'With Client'), 'Status: With Boss → With Client');
  assert.equal(changeLine('currently_with', null, 'Boss'), 'Currently with: Boss');
  assert.equal(changeLine('currently_with', 'Boss', ''), 'Currently with: cleared');
  assert.equal(changeLine('team', ['Usama'], ['Usama', 'Ali']), 'Team: Usama → Usama, Ali');
  const before = row({ status: 'With Boss', currently_with: 'Boss' });
  assert.equal(changeLines(before, { status: 'With Client', currently_with: 'Client', deliverable: 'Concession Agreement' }),
    'Status: With Boss → With Client; Currently with: Boss → Client');
  assert.equal(changeLines(before, { status: 'With Boss' }), '');
});

test('rows group by client and project in sheet order, and by every team member with Unassigned last', () => {
  const rows = [
    row({ id: 'a', sort_order: 3, client: 'KPT', project: 'Corridor', team: ['Usama', 'Ali'] }),
    row({ id: 'b', sort_order: 1, client: 'SIDB', project: 'Bridge', team: [] }),
    row({ id: 'c', sort_order: 2, client: 'KPT', project: 'Corridor', team: ['Ali'] }),
    row({ id: 'd', sort_order: 4, client: 'kpt', project: 'corridor ', team: null }),
  ];
  const byProject = groupByProject(rows);
  assert.deepEqual(byProject.map((g) => g.heading), ['SIDB · Bridge', 'KPT · Corridor']);
  assert.deepEqual(byProject[1].rows.map((r) => r.id), ['c', 'a', 'd']);
  const byPerson = groupByPerson(rows);
  assert.deepEqual(byPerson.map((g) => g.heading), ['Ali', 'Usama', 'Unassigned']);
  assert.deepEqual(byPerson[0].rows.map((r) => r.id), ['c', 'a']);
  assert.deepEqual(byPerson[2].rows.map((r) => r.id), ['b', 'd']);
});

test('search covers what a person remembers of a row', () => {
  const r = row({ latest_update: 'Sent the mark-up to EY' });
  assert.equal(rowMatches(r, 'ey'), true);
  assert.equal(rowMatches(r, 'usama'), true);
  assert.equal(rowMatches(r, 'boss'), true);
  assert.equal(rowMatches(r, 'ferry'), false);
  assert.equal(rowMatches(r, '  '), true);
});

test('a tray item is read without crashing on missing keys', () => {
  const v = readTrayItem({ payload: { person: 'Usama', transaction: 'Corridor', deliverable: 'CA', scope: 'Reviewed clause 5', file: 'Agenda 11 Nov.docx' },
    guess: { new_row: { client: 'KPT', project: 'Corridor', deliverable: 'CA', team: 'Usama, Ali' } } });
  assert.equal(v.person, 'Usama');
  assert.deepEqual(v.guessNewRow, { client: 'KPT', project: 'Corridor', deliverable: 'CA', team: ['Usama', 'Ali'] });
  const empty = readTrayItem({ payload: null, guess: undefined });
  assert.equal(empty.person, '');
  assert.equal(empty.guessNewRow, null);
  assert.equal(empty.rowId, '');
  const conflict = readTrayItem({ payload: { field: 'status', sheet: 'Closed', hub: 'With Boss', before: 'In Progress' }, guess: { row_id: 'r1' } });
  assert.equal(conflict.rowId, 'r1');
  assert.equal(conflict.sheetValue, 'Closed');
});

// ---- the timeline and the compact table
import { groupByDay, parseChangeLine, zonedTime } from '../src/lib/transactions.ts';

test('a line the Hub wrote for a move is read back into its parts; a typed note is left alone', () => {
  assert.deepEqual(parseChangeLine(changeLine('status', 'With Boss', 'With Client')), [
    { field: 'status', label: 'Status', was: 'With Boss', now: 'With Client' },
  ]);
  const both = changeLines({ status: 'In Progress', currently_with: null }, { status: 'With Boss', currently_with: 'Boss' });
  assert.deepEqual(parseChangeLine(both).map((p) => [p.field, p.was, p.now]), [
    ['status', 'In Progress', 'With Boss'],
    ['currently_with', '', 'Boss'],
  ]);
  assert.deepEqual(parseChangeLine('Team: cleared'), [{ field: 'team', label: 'Team', was: '', now: '' }]);
  assert.equal(parseChangeLine('Sent to the client. Status: awaiting their comments'), null);
  assert.equal(parseChangeLine('Note: call moved to Friday'), null);
  assert.equal(parseChangeLine(''), null);
  assert.equal(parseChangeLine(null), null);
});

test('updates fall under their Karachi day, in the order given', () => {
  const days = groupByDay([
    { at: '2026-10-28T19:30:00Z', id: 'c' }, // 00:30 on the 29th in Karachi
    { at: '2026-10-28T04:14:00Z', id: 'b' },
    { at: '2026-10-28T03:00:00Z', id: 'a' },
  ]);
  assert.deepEqual(days.map((d) => [d.key, d.label, d.items.map((i) => i.id)]), [
    ['2026-10-29', 'October 29, 2026', ['c']],
    ['2026-10-28', 'October 28, 2026', ['b', 'a']],
  ]);
  assert.equal(zonedTime('2026-10-28T04:14:00Z'), '09:14');
});

import { mergeSameLines } from '../src/lib/transactions.ts';

test('a line written on several rows in the same minute is read once, with its rows', () => {
  const line = (id, at, body, row, author = 'Usama') => ({ id, at, body, author, source: 'load', row });
  const merged = mergeSameLines(
    [
      line('a', '2026-10-19T03:44:00Z', 'Team to sit with Boss.', 'Volume I'),
      line('b', '2026-10-19T03:44:30Z', 'Team to sit with Boss.', 'Volume V'),
      line('c', '2026-10-19T03:44:00Z', 'Sent to the client.', 'Volume I'),
      line('d', '2026-10-19T03:50:00Z', 'Team to sit with Boss.', 'Volume III'),
      line('e', '2026-10-19T03:44:00Z', 'Team to sit with Boss.', 'Memo', 'Umer'),
    ],
    (u) => u.row,
  );
  assert.deepEqual(merged.map((m) => [m.item.id, m.rows]), [
    ['a', ['Volume I', 'Volume V']],
    ['c', ['Volume I']],
    ['d', ['Volume III']],
    ['e', ['Memo']],
  ]);
});

// ---- Needs a look: documents, proposed projects and emails

test('a document with no project is read with its file, sender, chat, link and the guessed project', () => {
  const payload = {
    intake_document_id: 'i1', file: 'ADB-CTA-Mark-up-v4.docx', title: 'Common Terms Agreement', transaction: 'ADB M6',
    code: 'ADB', person: 'Usama', chat: 'AKLA TEAM - OFFICE', date: '2026-10-17T09:00:00+00:00',
    web_url: 'https://example.sharepoint.com/x', via: 'WhatsApp',
  };
  const guessed = readTrayItem({ kind: 'document_no_project', payload, guess: { matter_id: 'm1', confidence: 0.82 } });
  assert.equal(guessed.file, 'ADB-CTA-Mark-up-v4.docx');
  assert.equal(guessed.title, 'Common Terms Agreement');
  assert.equal(guessed.transaction, 'ADB M6');
  assert.equal(guessed.code, 'ADB');
  assert.equal(guessed.person, 'Usama');
  assert.equal(guessed.chat, 'AKLA TEAM - OFFICE');
  assert.equal(guessed.via, 'WhatsApp');
  assert.equal(guessed.webUrl, 'https://example.sharepoint.com/x');
  assert.equal(guessed.guessMatterId, 'm1');
  assert.equal(guessed.confidence, '0.82');
  assert.equal(guessed.guessNewProject, null);

  const drafted = readTrayItem({ kind: 'document_no_project', payload, guess: { new_project: { name: 'M6 Motorway', client: 'ADB', code: 'ADB' } } });
  assert.equal(drafted.guessMatterId, '');
  assert.deepEqual(drafted.guessNewProject, { name: 'M6 Motorway', client: 'ADB', code: 'ADB' });

  const bare = readTrayItem({ kind: 'document_no_project', payload: { file: 'x.pdf' }, guess: null });
  assert.equal(bare.guessMatterId, '');
  assert.equal(bare.guessNewProject, null);
  assert.equal(bare.webUrl, '');
  assert.deepEqual(bare.near, []);
});

test('a document the Hub is unsure of names its project and the document it may be the next version of', () => {
  const v = readTrayItem({
    kind: 'document_unsure',
    payload: { intake_document_id: 'i2', file: 'CTA v5 (clean).docx', title: 'Common Terms Agreement', person: 'Usama', chat: 'AKLA TEAM - OFFICE', matter_id: 'm1' },
    guess: { document_id: 'd1', document_title: 'Common Terms Agreement', confidence: 0.78 },
  });
  assert.equal(v.matterId, 'm1');
  assert.equal(v.guessDocumentId, 'd1');
  assert.equal(v.guessDocumentTitle, 'Common Terms Agreement');
  assert.equal(v.file, 'CTA v5 (clean).docx');
});

test('an undone filing remembers the project it was taken off, and has no guess', () => {
  const v = readTrayItem({
    kind: 'document_undone',
    payload: { intake_document_id: 'i3', file: 'CTA v4.docx', title: 'CTA', transaction: 'ADB M6', person: 'Usama', chat: 'Outlook - someone@example.com (Inbox)', date: '2026-10-17T09:00:00+00:00', web_url: null, was_matter_id: 'm1' },
    guess: null,
  });
  assert.equal(v.wasMatterId, 'm1');
  assert.equal(v.matterId, '');
  assert.equal(v.guessMatterId, '');
  assert.equal(v.webUrl, '');
  assert.equal(v.chat, 'Outlook - someone@example.com (Inbox)');
});

test('a proposed project is read with its name, how often and where it was seen (newest first), and the projects it may be', () => {
  const v = readTrayItem({
    kind: 'new_project',
    payload: {
      name: 'Port Qasim (PQEPC)', code: 'PQ', count: 4,
      seen: [
        { where: 'Agenda 14 Oct.docx', person: 'Haya', date: '2026-10-14T03:00:00Z' },
        { where: 'RE: PQEPC term sheet', person: 'Owais Sb', date: '2026-10-19T06:00:00Z' },
        { junk: true },
      ],
    },
    guess: { new_project: { name: 'Port Qasim', client: 'PQEPC', code: 'PQ' }, near: [{ matter_id: 'm7', name: 'Port Qasim Terminal', confidence: 0.6 }, { name: 'no id' }] },
  });
  assert.equal(v.name, 'Port Qasim (PQEPC)');
  assert.equal(v.code, 'PQ');
  assert.equal(v.count, 4);
  assert.deepEqual(v.seen.map((s) => s.where), ['RE: PQEPC term sheet', 'Agenda 14 Oct.docx']);
  // The name is the project's, not a person's: whoever mentioned it last is the person.
  assert.equal(v.person, 'Owais Sb');
  assert.deepEqual(v.guessNewProject, { name: 'Port Qasim', client: 'PQEPC', code: 'PQ' });
  assert.deepEqual(v.near, [{ matterId: 'm7', name: 'Port Qasim Terminal' }]);

  const sparse = readTrayItem({ kind: 'new_project', payload: { name: 'K-IV' }, guess: null });
  assert.equal(sparse.count, 0);
  assert.deepEqual(sparse.seen, []);
  assert.equal(sparse.person, '');
  assert.equal(sparse.guessNewProject, null);
  // No count written: as many as were seen.
  assert.equal(readTrayItem({ kind: 'new_project', payload: { name: 'K-IV', seen: [{ where: 'a' }, { where: 'b' }] } }).count, 2);
});

test('an email the Hub could not place on a row is read with its ask, its gist, its project and the row it probably means', () => {
  const v = readTrayItem({
    kind: 'message_unsure',
    payload: {
      message_id: 'msg-1', person: 'Owais Sb', date: '2026-10-19T06:00:00Z', transaction: 'ADB', deliverable: 'Common Terms Agreement',
      scope: 'Owais Sb wants the CTA mark-up back before the lenders call.', ask: 'Owais Sb asks for the mark-up by 19 Oct', status: '', via: 'email', matter_id: 'm1',
    },
    guess: { row_id: 'r1', confidence: 'unsure', row_deliverable: 'CTA', others: [{ row_id: 'r2', deliverable: 'Facility Agreement', confidence: 0.4 }] },
  });
  assert.equal(v.person, 'Owais Sb');
  assert.equal(v.ask, 'Owais Sb asks for the mark-up by 19 Oct');
  assert.equal(v.scope, 'Owais Sb wants the CTA mark-up back before the lenders call.');
  assert.equal(v.deliverable, 'Common Terms Agreement');
  assert.equal(v.proposedStatus, '');
  assert.equal(v.matterId, 'm1');
  assert.equal(v.guessRowId, 'r1');
  assert.equal(v.rowId, 'r1');
  assert.equal(v.guessRowDeliverable, 'CTA');
  assert.equal(v.messageRef, 'msg-1');
  // The message's own key marks the line when the payload carries it.
  assert.equal(readTrayItem({ kind: 'message_unsure', payload: { message_id: 'msg-1', message_key: '<abc@mail>' } }).messageRef, '<abc@mail>');
  assert.equal(readTrayItem({ kind: 'message_unsure', payload: { person: 'x' }, guess: null }).guessRowId, '');
});

test('an agenda line says whether its transaction was known, so an accepted one can be learned', () => {
  assert.equal(readTrayItem({ kind: 'agenda_line_unsure', payload: { transaction: 'M6', transaction_known: false, code: null } }).transactionKnown, false);
  assert.equal(readTrayItem({ kind: 'agenda_line_unsure', payload: { transaction: 'M6', transaction_known: true, code: 'ADB' } }).transactionKnown, true);
  // An older item says nothing either way.
  assert.equal(readTrayItem({ kind: 'agenda_line_unsure', payload: { transaction: 'M6' } }).transactionKnown, null);
  assert.equal(readTrayItem({ payload: null }).transactionKnown, null);
  // Without a kind, a payload's `name` is still read as the person, as before.
  assert.equal(readTrayItem({ payload: { name: 'Usama' } }).person, 'Usama');
});
