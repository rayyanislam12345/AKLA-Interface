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
