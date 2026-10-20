import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyPassage, PASSAGE_LIMIT } from '../src/lib/selectionPassage.ts';

test('a highlighted passage is kept as shown, tidied at the edges', () => {
  assert.deepEqual(tidyPassage('  14.2 The Seller  \r\n\r\n\r\nshall indemnify\u00a0the Buyer.\n'), {
    text: '14.2 The Seller\n\nshall indemnify the Buyer.',
    truncated: false,
  });
  assert.deepEqual(tidyPassage(' \n '), { text: '', truncated: false });
});

test('a long passage is cut with … at the limit', () => {
  const t = tidyPassage('a'.repeat(PASSAGE_LIMIT + 50));
  assert.equal(t.truncated, true);
  assert.equal(t.text, `${'a'.repeat(PASSAGE_LIMIT)}…`);
});
