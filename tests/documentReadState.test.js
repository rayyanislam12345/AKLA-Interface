import test from 'node:test';
import assert from 'node:assert/strict';
import { versionReadState, readStateHint, hasIndexQueue, READ_STATE_LABEL, READING_TIMEOUT_MS } from '../src/lib/documentReadState.ts';

const now = Date.parse('2026-10-19T12:00:00Z');
const minutesAgo = (m) => new Date(now - m * 60_000).toISOString();

test('before the index worker: indexed, unsupported, a fresh pending, and a stale pending', () => {
  assert.equal(versionReadState({ indexing_status: 'indexed', created_at: minutesAgo(1) }, now), 'searchable');
  assert.equal(versionReadState({ indexing_status: 'unsupported', created_at: minutesAgo(1) }, now), 'unsupported');
  assert.equal(versionReadState({ indexing_status: 'pending', created_at: minutesAgo(2) }, now), 'reading');
  // Ten minutes is the cut-off: after it a pending version reads as failed.
  assert.equal(versionReadState({ indexing_status: 'pending', created_at: new Date(now - READING_TIMEOUT_MS - 1).toISOString() }, now), 'failed');
  assert.equal(versionReadState({ indexing_status: 'failed', created_at: minutesAgo(1) }, now), 'failed');
  assert.equal(versionReadState({ indexing_status: 'unknown', created_at: minutesAgo(1) }, now), 'failed');
});

test('with the index worker the server owns the state: waiting, reading, failed, no timeout', () => {
  const queued = { indexing_status: 'pending', created_at: minutesAgo(60), indexing_attempts: 0, indexing_started_at: null };
  assert.equal(hasIndexQueue(queued), true);
  assert.equal(versionReadState(queued, now), 'waiting');
  assert.equal(versionReadState({ ...queued, indexing_started_at: minutesAgo(30) }, now), 'reading');
  assert.equal(versionReadState({ ...queued, indexing_status: 'failed', indexing_attempts: 3 }, now), 'failed');
  assert.equal(versionReadState({ ...queued, indexing_status: 'unknown' }, now), 'failed');
  assert.equal(versionReadState({ ...queued, indexing_status: 'indexed' }, now), 'searchable');
});

test('the hint names the server reason, the pre-queue case, and a retry in progress', () => {
  const failed = { indexing_status: 'failed', created_at: minutesAgo(1), indexing_attempts: 3, indexing_error: 'The PDF has no text layer.' };
  assert.equal(readStateHint(failed, 'failed'), 'The PDF has no text layer. The file is saved and can be downloaded.');
  const unknown = { indexing_status: 'unknown', created_at: minutesAgo(1), indexing_attempts: 0 };
  assert.match(readStateHint(unknown, 'failed'), /Saved before files were read automatically/);
  const retry = { indexing_status: 'pending', created_at: minutesAgo(1), indexing_attempts: 2, indexing_started_at: minutesAgo(1) };
  assert.equal(readStateHint(retry, 'reading'), 'Reading it again (attempt 2 of 3) after a problem last time.');
  assert.match(readStateHint({ indexing_status: 'indexed', created_at: minutesAgo(1) }, 'searchable'), /Search and Ask AI can read/);
});

test('every state has a label', () => {
  for (const state of ['searchable', 'waiting', 'reading', 'failed', 'unsupported']) assert.ok(READ_STATE_LABEL[state]);
});
