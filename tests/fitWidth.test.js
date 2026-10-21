import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_FIT_SCALE, fitScale } from '../src/components/documents/fitWidth.ts';

test('a page wider than the pane is scaled down to fit it, never up', () => {
  assert.equal(fitScale(397, 794), 0.5);
  assert.equal(fitScale(1200, 794), 1, 'a wide pane shows the page at its own size');
  assert.equal(fitScale(794, 794), 1);
});

test('a very narrow pane stops at the smallest readable scale; unknown sizes leave the page alone', () => {
  assert.equal(fitScale(100, 794), MIN_FIT_SCALE);
  assert.equal(fitScale(0, 794), 1, 'a hidden box (another tab showing) has no width');
  assert.equal(fitScale(500, 0), 1, 'nothing drawn yet');
  assert.equal(fitScale(Number.NaN, 794), 1);
});
