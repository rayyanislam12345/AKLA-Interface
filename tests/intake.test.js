import test from 'node:test';
import assert from 'node:assert/strict';
// Node strips the types from this file itself, so the tests run against the
// very code the browser uses rather than a copy.
import {
  actionSourceLine,
  actionVerb,
  arrivedFromLine,
  canUndo,
  countArrivals,
  exactInstant,
  formatDayMonth,
  formatDayTime,
  groupArrivals,
  groupArrivalsByDay,
  karachiDayStartIso,
  matchesArrivedFilter,
  nameKey,
  personName,
  readAction,
} from '../src/lib/intake.ts';

const NOW = new Date('2026-11-23T06:00:00Z');

const filing = (over = {}) => ({
  id: 'a1', group_id: 'g1', kind: 'version_filed', source: 'whatsapp', source_ref: 'filer:812',
  summary: 'Common Terms Agreement · v4 filed',
  detail: {
    title: 'Common Terms Agreement', version_number: 4, file: 'ADB-CTA-Mark-up-v4.docx', from: 'Usama',
    chat: 'AKLA TEAM - OFFICE', sent: '2026-10-28T09:30:00+00:00', via: 'WhatsApp', created_document: false,
    web_url: 'https://example.sharepoint.com/x', doc_status: 'Mark-up',
  },
  matter_id: 'm1', row_id: null, document_id: 'd1', version_id: 'v4', update_id: null, note_id: null,
  created_at: '2026-10-28T09:35:00+00:00', undone_at: null,
  matter: { name: 'M6 Motorway' }, row: null,
  ...over,
});

test('an action is read in full, with the names the query brought along', () => {
  const a = readAction(filing());
  assert.equal(a.id, 'a1');
  assert.equal(a.groupId, 'g1');
  assert.equal(a.kind, 'version_filed');
  assert.equal(a.summary, 'Common Terms Agreement · v4 filed');
  assert.equal(a.from, 'Usama');
  assert.equal(a.chat, 'AKLA TEAM - OFFICE');
  assert.equal(a.via, 'WhatsApp');
  assert.equal(a.file, 'ADB-CTA-Mark-up-v4.docx');
  assert.equal(a.versionNumber, 4);
  assert.equal(a.createdDocument, false);
  assert.equal(a.webUrl, 'https://example.sharepoint.com/x');
  assert.equal(a.matterId, 'm1');
  assert.equal(a.documentId, 'd1');
  assert.equal(a.versionId, 'v4');
  assert.equal(a.rowId, null);
  assert.equal(a.undoneAt, null);
  assert.equal(a.projectName, 'M6 Motorway');
  assert.equal(a.rowDeliverable, '');
});

test('a sparse action, and junk, are read without crashing', () => {
  const sparse = readAction({ id: 'a2', kind: 'row_update', source: 'EMAIL', created_at: '2026-10-28T06:02:00Z', detail: {} });
  assert.equal(sparse.groupId, 'a2'); // no group: it stands alone
  assert.equal(sparse.source, 'email');
  assert.equal(sparse.summary, 'Row updated'); // no summary: at least the kind's words
  assert.equal(sparse.from, '');
  assert.equal(sparse.versionNumber, null);
  assert.equal(sparse.createdDocument, false);
  assert.equal(sparse.projectName, '');

  const noDetail = readAction({ id: 'a3', kind: 'note_added', detail: null, created_document: true });
  assert.equal(noDetail.from, '');
  assert.equal(noDetail.createdDocument, false);
  const listDetail = readAction({ id: 'a4', kind: 'note_added', detail: ['from', 'Usama'] });
  assert.equal(listDetail.from, '');

  for (const junk of [null, undefined, 'text', 42, [], { detail: 'not an object', summary: 7, undone_at: '' }]) {
    const a = readAction(junk);
    assert.equal(a.id, '');
    assert.equal(a.kind, '');
    assert.equal(a.undoneAt, null);
    assert.equal(a.matterId, null);
    assert.equal(typeof a.summary, 'string');
    assert.equal(actionSourceLine(a, NOW), 'Filed automatically');
  }
  assert.equal(readAction({ detail: { created_document: 'true', version_number: '2' } }).createdDocument, true);
  assert.equal(readAction({ detail: { created_document: 'true', version_number: '2' } }).versionNumber, 2);
});

test('each kind has its plain words', () => {
  assert.deepEqual(
    ['version_filed', 'row_moved', 'row_update', 'note_added', 'row_created', 'project_created'].map(actionVerb),
    ['Filed', 'Row moved', 'Row updated', 'Noted', 'New row', 'New project'],
  );
  assert.equal(actionVerb('something_new'), 'Arrived');
  assert.equal(actionVerb(null), 'Arrived');
});

test('the source line says who, how and when, on Karachi time', () => {
  // WhatsApp names the group; 09:30 UTC is 14:30 in Karachi.
  assert.equal(actionSourceLine(readAction(filing()), NOW), 'From Usama by WhatsApp, AKLA TEAM - OFFICE · 28 Oct, 14:30');
  // Email never names the mailbox, and an address after the name is dropped.
  const email = readAction({
    id: 'e', kind: 'row_update', source: 'email', created_at: '2026-10-28T06:05:00Z',
    detail: { from: 'Owais Sb <someone@example.com>', chat: 'Outlook - someone@example.com (Inbox)', sent: '2026-10-28T06:02:00Z', via: 'email' },
  });
  assert.equal(actionSourceLine(email, NOW), 'From Owais Sb by email · 28 Oct, 11:02');
  // An agenda has no sent time: the moment the Hub read it stands in.
  const agenda = readAction({ id: 'g', kind: 'row_update', source: 'agenda', source_ref: 'Agenda 28 Oct.docx', created_at: '2026-10-28T03:00:00Z', detail: { from: 'Haya' } });
  assert.equal(actionSourceLine(agenda, NOW), "From Haya's agenda · 28 Oct, 08:00");
  // Nobody named.
  assert.equal(actionSourceLine(readAction({ source: 'agenda', created_at: '2026-10-28T03:00:00Z' }), NOW), 'From a daily agenda · 28 Oct, 08:00');
  assert.equal(actionSourceLine(readAction({ source: 'email', created_at: '2026-10-28T03:00:00Z' }), NOW), 'By email · 28 Oct, 08:00');
  assert.equal(actionSourceLine(readAction({ source: 'whatsapp', created_at: '2026-10-28T03:00:00Z', detail: { chat: 'PTQ Team' } }), NOW), 'By WhatsApp, PTQ Team · 28 Oct, 08:00');
  assert.equal(actionSourceLine(readAction({ source: 'excel', created_at: '2026-10-28T03:00:00Z' }), NOW), 'From the sheet · 28 Oct, 08:00');
  // The detail's "via" decides when the source alone does not (a document that came by email, filed by the Filer).
  assert.equal(
    actionSourceLine(readAction({ source: 'whatsapp', created_at: '2026-10-28T03:00:00Z', detail: { from: 'Client Counsel', via: 'email', chat: 'Outlook - x (Inbox)' } }), NOW),
    'From Client Counsel by email · 28 Oct, 08:00',
  );
  // A pushname with its number shows the name alone.
  assert.equal(personName('Usama (+92 300 0000000)'), 'Usama');
  assert.equal(personName('"Owais Sb" <someone@example.com>'), 'Owais Sb');
  assert.equal(personName('<someone@example.com>'), 'someone@example.com');
  assert.equal(personName(null), '');
});

test('stamps: day first, the year only when it is not this one, a stamp with no zone read as UTC', () => {
  assert.equal(formatDayTime('2026-10-27T20:30:00Z', NOW), '28 Oct, 01:30'); // already the 28th in Karachi
  assert.equal(formatDayMonth('2025-12-31T20:00:00Z', NOW), '1 Jan'); // new year's day there, and this year's
  assert.equal(formatDayMonth('2025-10-17T09:00:00Z', NOW), '17 Oct 2025');
  assert.equal(formatDayTime('2026-10-28 06:02:00', NOW), '28 Oct, 11:02');
  assert.equal(formatDayTime('2026-10-28', NOW), '28 Oct'); // a bare date has no time to show
  assert.equal(formatDayTime('not a date', NOW), '');
  assert.equal(formatDayTime('', NOW), '');
  assert.equal(exactInstant('2026-10-28 06:02:00', NOW), '2026-10-28T06:02:00.000Z');
  assert.equal(exactInstant('2026-10-28T11:02:00+05:00', NOW), '2026-10-28T06:02:00.000Z');
  assert.equal(exactInstant('2026-10-28', NOW), '');
  assert.equal(exactInstant('2027-01-01T00:00:00Z', NOW), ''); // not in the future
  assert.equal(exactInstant('soon', NOW), '');
  assert.equal(exactInstant(undefined, NOW), '');
  assert.equal(karachiDayStartIso(new Date('2026-11-22T20:30:00Z')), '2026-11-23T00:00:00+05:00');
});

test('the line under a Needs-a-look document says who, where and the day', () => {
  assert.equal(arrivedFromLine({ person: 'Usama', chat: 'AKLA TEAM - OFFICE', via: 'WhatsApp', date: '2026-10-17T09:00:00Z' }, NOW), 'from Usama · AKLA TEAM - OFFICE · 17 Oct');
  assert.equal(arrivedFromLine({ person: 'Owais Sb <someone@example.com>', chat: 'Outlook - someone@example.com (Sent)', via: 'email', date: '2026-10-17' }, NOW), 'from Owais Sb · email · 17 Oct');
  assert.equal(arrivedFromLine({ person: '', chat: 'Outlook - x (Inbox)', via: '', date: '' }, NOW), 'email');
  assert.equal(arrivedFromLine({}, NOW), '');
});

test('what can be undone: the five kinds, once', () => {
  for (const kind of ['version_filed', 'row_update', 'row_moved', 'row_created', 'note_added']) {
    assert.equal(canUndo({ kind, undoneAt: null }), true, kind);
    assert.equal(canUndo({ kind, undoneAt: '2026-10-28T10:00:00Z' }), false, `${kind}, already undone`);
  }
  assert.equal(canUndo({ kind: 'project_created', undoneAt: null }), false);
  assert.equal(canUndo({ kind: '', undoneAt: null }), false);
  assert.equal(canUndo(readAction(filing({ undone_at: '2026-10-28T10:00:00Z' }))), false);
});

test('the filters keep documents, row moves and notes apart', () => {
  const kinds = ['version_filed', 'row_update', 'row_moved', 'row_created', 'note_added', 'project_created'];
  const kept = (filter) => kinds.filter((kind) => matchesArrivedFilter({ kind }, filter));
  assert.deepEqual(kept('all'), kinds);
  assert.deepEqual(kept('documents'), ['version_filed']);
  assert.deepEqual(kept('rows'), ['row_update', 'row_moved', 'row_created']);
  assert.deepEqual(kept('notes'), ['note_added']);
});

test('a filing and the row line it wrote sit together, the filing first; arrivals fall under their Karachi day', () => {
  const act = (id, groupId, kind, createdAt) => ({ id, groupId, kind, createdAt });
  // Newest first, as the query gives them.
  const actions = [
    act('n1', 'g3', 'note_added', '2026-10-28T19:31:00Z'), // 00:31 on the 29th in Karachi
    act('u3', 'g3', 'row_update', '2026-10-28T19:30:00Z'),
    act('u1', 'g1', 'row_moved', '2026-10-28T09:35:02Z'), // the line the filing below wrote
    act('f1', 'g1', 'version_filed', '2026-10-28T09:35:00Z'),
    act('u2', 'g2', 'row_update', '2026-10-28T04:00:00Z'),
    act('x', '', 'row_created', '2026-10-27T04:00:00Z'), // no group: on its own
  ];
  const arrivals = groupArrivals(actions);
  assert.deepEqual(arrivals.map((g) => [g.key, g.lead.id, g.rest.map((a) => a.id)]), [
    ['g3', 'u3', ['n1']],
    ['g1', 'f1', ['u1']],
    ['g2', 'u2', []],
    ['x', 'x', []],
  ]);
  assert.equal(countArrivals(actions), 4);
  assert.equal(countArrivals([]), 0);

  const days = groupArrivalsByDay(actions);
  assert.deepEqual(days.map((d) => [d.key, d.label, d.items.map((g) => g.key)]), [
    ['2026-10-29', 'October 29, 2026', ['g3']],
    ['2026-10-28', 'October 28, 2026', ['g1', 'g2']],
    ['2026-10-27', 'October 27, 2026', ['x']],
  ]);
  assert.deepEqual(groupArrivalsByDay([]), []);
});

test('the name key is the database\'s: lower case, anything else one space, trimmed', () => {
  assert.equal(nameKey('M-6 Motorway'), 'm 6 motorway');
  assert.equal(nameKey('  ADB – M6 '), 'adb m6');
  assert.equal(nameKey('Port Qasim (PQEPC)'), 'port qasim pqepc');
  assert.equal(nameKey('ADB / M6 Motorway'), 'adb m6 motorway');
  assert.equal(nameKey('Hyderabad–Sukkur\tMotorway\n'), 'hyderabad sukkur motorway');
  assert.equal(nameKey("K-IV (Phase 2) — Lender's Counsel"), 'k iv phase 2 lender s counsel');
  assert.equal(nameKey('!!!'), '');
  assert.equal(nameKey(''), '');
  assert.equal(nameKey(null), '');
  // The same name typed two ways is one key; a different spacing of the digits is not.
  assert.equal(nameKey('adb  M6'), nameKey('ADB – M6'));
  assert.notEqual(nameKey('M-6'), nameKey('M6'));
});
