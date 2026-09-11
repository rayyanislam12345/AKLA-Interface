import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSuggestions, reviewSegments } from '../supabase/functions/_shared/reviewValidation.js';

test('invalid or unfinished responses never become a clean review', () => {
  for (const [text, stop] of [['[', 'end_turn'], ['{}','end_turn'], ['[]','max_tokens'], ['[]',null], ['[{"rationale":"x"}]','end_turn']]) {
    assert.throws(() => parseSuggestions(text, stop, 'Original clause.'));
  }
  assert.deepEqual(parseSuggestions('[]', 'end_turn', 'Original clause.'), []);
});
test('review suggestions must be anchored to exact source text', () => {
  const row = { clause_reference: 'Clause 1', original_text: 'Invented clause', suggested_text: 'Changed', rationale: 'Reason' };
  assert.throws(() => parseSuggestions(JSON.stringify([row]), 'end_turn', 'Original clause.'));
  row.original_text = 'Original clause.';
  assert.equal(parseSuggestions(JSON.stringify([row]), 'end_turn', 'Original clause.').length, 1);
});
test('segmentation covers the entire source without omissions', () => {
  const text = ('Clause text.\n').repeat(10000);
  const parts = reviewSegments(text);
  assert.equal(parts.map(s => s.text).join(''), text);
  assert.ok(parts.every(s => s.text.length <= 18000));
});
