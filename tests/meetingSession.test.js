import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendeeNames, meetingHeader, meetingDocumentTitle, elapsed,
  keepTranscript, keptTranscript, forgetTranscript, KEPT_TRANSCRIPT_KEY,
} from '../src/lib/meetingSession.ts';

const DAY = new Date(2026, 9, 23, 14, 10);

test('attendees are split on commas, semicolons and lines, once each', () => {
  assert.deepEqual(attendeeNames('Ali Khan, Sara Ahmed; ali khan\nPPP Unit , '), ['Ali Khan', 'Sara Ahmed', 'PPP Unit']);
  assert.deepEqual(attendeeNames('   '), []);
});

test('the transcript is headed with the meeting, the date and who attended', () => {
  assert.equal(
    meetingHeader({ title: 'KPT kick-off', attendees: 'Ali Khan, Sara Ahmed' }, DAY),
    'Meeting: KPT kick-off\nDate: 23 October 2026\nAttendees: Ali Khan, Sara Ahmed\n\nTranscript:\n',
  );
  assert.equal(meetingHeader({ title: '', attendees: '' }, DAY), 'Date: 23 October 2026\n\nTranscript:\n');
});

test('documents are named by kind, title and date; no title leaves it out', () => {
  assert.equal(meetingDocumentTitle('Meeting Minutes', ' KPT kick-off ', DAY), 'Meeting Minutes — KPT kick-off — 23 October 2026');
  assert.equal(meetingDocumentTitle('Meeting Transcript', '', DAY), 'Meeting Transcript — 23 October 2026');
});

test('the clock reads minutes and seconds, and hours once there are any', () => {
  assert.equal(elapsed(7_000), '0:07');
  assert.equal(elapsed(754_000), '12:34');
  assert.equal(elapsed(3_729_000), '1:02:09');
  assert.equal(elapsed(-5), '0:00');
});

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('a kept transcript comes back whole, and an empty or broken one is not offered', () => {
  const store = memoryStore();
  const kept = {
    savedAt: DAY.toISOString(),
    segments: [{ id: 1, speakerId: 0, text: 'Shall we begin?' }],
    speakerNames: [[0, 'Ali Khan']],
    details: { title: 'KPT kick-off', attendees: 'Ali Khan' },
    matterId: 'm1',
  };
  keepTranscript(store, kept);
  assert.deepEqual(keptTranscript(store), kept);
  forgetTranscript(store);
  assert.equal(keptTranscript(store), null);
  store.setItem(KEPT_TRANSCRIPT_KEY, '{"segments":[]}');
  assert.equal(keptTranscript(store), null);
  store.setItem(KEPT_TRANSCRIPT_KEY, 'not json');
  assert.equal(keptTranscript(store), null);
  assert.equal(keptTranscript(null), null);
});

test('a store that refuses does not stop the page', () => {
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } };
  assert.doesNotThrow(() => keepTranscript(refusing, { savedAt: '', segments: [], speakerNames: [], details: { title: '', attendees: '' }, matterId: '' }));
  assert.equal(keptTranscript(refusing), null);
  assert.doesNotThrow(() => forgetTranscript(refusing));
});
