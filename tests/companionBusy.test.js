import test from 'node:test';
import assert from 'node:assert/strict';
// Node strips the types from these files itself, so the tests run against the
// very counter and poster the companion hears from.
import { BUSY_IDLE_DELAY_MS, createBusyTracker } from '../src/lib/companionBusy.ts';
import { pushAsReplace } from '../src/lib/companionHistory.ts';

// A clock the test moves by hand.
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

function tracked() {
  const clock = fakeClock();
  const tracker = createBusyTracker({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const posts = [];
  const stop = tracker.connect((busy) => posts.push(busy));
  return { clock, tracker, posts, stop };
}

test('busy is said at once, not busy about 1.5 s after the last piece of work ends', () => {
  assert.equal(BUSY_IDLE_DELAY_MS, 1500);
  const { clock, tracker, posts } = tracked();
  const end = tracker.begin();
  assert.deepEqual(posts, [true]);
  end();
  clock.advance(1499);
  assert.deepEqual(posts, [true]);
  clock.advance(1);
  assert.deepEqual(posts, [true, false]);
});

test('several reasons count: not busy only once every one has ended', () => {
  const { clock, tracker, posts } = tracked();
  const upload = tracker.begin();
  const decision = tracker.begin();
  tracker.setFlag('typing', true);
  assert.deepEqual(posts, [true]);
  upload();
  tracker.setFlag('typing', false);
  clock.advance(5000);
  assert.deepEqual(posts, [true], 'a decision is still in flight');
  assert.equal(tracker.isBusy(), true);
  decision();
  clock.advance(1500);
  assert.deepEqual(posts, [true, false]);
});

test('busy again within the delay posts nothing: the companion hears only changes', () => {
  const { clock, tracker, posts } = tracked();
  tracker.setFlag('typing', true);
  tracker.setFlag('typing', true);
  tracker.setFlag('typing', false);
  clock.advance(1000);
  tracker.setFlag('overlay', true);
  clock.advance(1000);
  tracker.setFlag('overlay', false);
  clock.advance(1499);
  assert.deepEqual(posts, [true]);
  clock.advance(1);
  assert.deepEqual(posts, [true, false]);
  // Idle and quiet: nothing more is said.
  clock.advance(10_000);
  assert.deepEqual(posts, [true, false]);
});

test('an end called twice counts once', () => {
  const { clock, tracker, posts } = tracked();
  const a = tracker.begin();
  const b = tracker.begin();
  a();
  a();
  clock.advance(2000);
  assert.equal(tracker.isBusy(), true);
  assert.deepEqual(posts, [true]);
  b();
  clock.advance(2000);
  assert.deepEqual(posts, [true, false]);
});

test('nothing is posted before connect; work already under way is said on connect', () => {
  const clock = fakeClock();
  const tracker = createBusyTracker({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const end = tracker.begin(); // a child's effect runs before the layout's
  const posts = [];
  const stop = tracker.connect((busy) => posts.push(busy));
  assert.deepEqual(posts, [true]);
  end();
  stop(); // leaving the companion straight away still says "not busy"
  assert.deepEqual(posts, [true, false]);
  clock.advance(5000);
  assert.deepEqual(posts, [true, false]);
});

test('idle on connect says nothing; after stop nothing more is posted', () => {
  const { clock, tracker, posts, stop } = tracked();
  assert.deepEqual(posts, []);
  stop();
  tracker.begin();
  clock.advance(5000);
  assert.deepEqual(posts, []);
});

test('in the companion a navigation replaces the entry and holds the router index at 0', () => {
  const calls = [];
  const history = {
    pushState: () => calls.push('push'),
    replaceState: (state, unused, url) => calls.push(['replace', state, url]),
  };
  pushAsReplace(history);
  history.pushState({ usr: null, key: 'k1', idx: 3 }, '', '/ai/p/1');
  history.pushState(null, '', '/ai');
  assert.deepEqual(calls, [
    ['replace', { usr: null, key: 'k1', idx: 0 }, '/ai/p/1'],
    ['replace', null, '/ai'],
  ]);
});
