import test from 'node:test';
import assert from 'node:assert/strict';
import { chatStatus, chatStatusLabel, relativeDay, greeting } from '../src/lib/chatStatus.ts';

test('a chat row says whether it is writing, waiting on you, or failed', () => {
  assert.equal(chatStatus({ busy: false, failed: false }), null);
  assert.equal(chatStatus({ busy: true, failed: false }), 'running');
  assert.equal(chatStatus({ busy: false, failed: true }), 'failed');
  assert.equal(chatStatus({ busy: false, failed: false, questionnaire: { pending: { id: 'q1' } } }), 'needs_you');
  assert.equal(chatStatus({ busy: false, failed: false, questionnaire: { pending: null, done: true } }), null);
  assert.equal(chatStatus({ busy: false, failed: false, questionnaire: 'garbage' }), null);
  // Writing wins over everything; a failure wins over a question.
  assert.equal(chatStatus({ busy: true, failed: true, questionnaire: { pending: {} } }), 'running');
  assert.equal(chatStatus({ busy: false, failed: true, questionnaire: { pending: {} } }), 'failed');
});

test('each status has a plain label', () => {
  assert.equal(chatStatusLabel('running'), 'Writing a reply');
  assert.equal(chatStatusLabel('needs_you'), 'Waiting for your answer');
  assert.equal(chatStatusLabel('failed'), 'The last reply failed');
  assert.equal(chatStatusLabel(null), null);
});

test('dates in a chat list are short', () => {
  const now = Date.parse('2026-10-18T12:00:00');
  assert.equal(relativeDay(null, now), '');
  assert.match(relativeDay('2026-10-18T09:05:00', now), /^\d\d:\d\d$/);
  assert.equal(relativeDay('2026-10-17T09:05:00', now), 'Yesterday');
  assert.equal(relativeDay('2026-10-14T09:05:00', now), 'Wed');
  assert.equal(relativeDay('2026-10-01T09:05:00', now), '1 Oct');
});

test('the greeting uses the first name and the time of day', () => {
  assert.equal(greeting('Rayyan Islam', 9), 'Good morning, Rayyan');
  assert.equal(greeting('Rayyan Islam', 14), 'Good afternoon, Rayyan');
  assert.equal(greeting('Rayyan Islam', 20), 'Good evening, Rayyan');
  assert.equal(greeting(null, 9), 'Good morning');
  assert.equal(greeting('  ', 9), 'Good morning');
});
