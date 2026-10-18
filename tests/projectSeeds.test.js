import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectSeeds, attachParam } from '../src/lib/projectSeeds.ts';

const params = (s) => new URLSearchParams(s);

test('a plain project address seeds nothing', () => {
  const seeds = readProjectSeeds(params(''));
  assert.equal(seeds.seeded, false);
  assert.equal(seeds.chat, null);
  assert.equal(seeds.edit, false);
  assert.equal(seeds.attach, null);
});

test("the site's links to /matters/:id/ai are honoured as they are", () => {
  assert.equal(readProjectSeeds(params('chat=t1')).chat, 't1');
  const review = readProjectSeeds(params('mode=review&doc=d1&version=v2'));
  assert.equal(review.mode, 'review');
  assert.equal(review.doc, 'd1');
  assert.equal(review.version, 'v2');
  assert.equal(review.seeded, true);
  const revise = readProjectSeeds(params('mode=review&update=u1'));
  assert.equal(revise.update, 'u1');
  assert.equal(readProjectSeeds(params('mode=edit')).edit, true);
  assert.equal(readProjectSeeds(params('mode=draft')).edit, false);
});

test('?attach=v:<id> names a stored version; anything else is ignored', () => {
  const id = '0f4b3c1e-2d5a-4b6c-8d7e-9f0a1b2c3d4e';
  assert.equal(readProjectSeeds(params(`attach=${attachParam(id)}`)).attach, id);
  assert.equal(readProjectSeeds(params('attach=a:' + id)).attach, null);
  assert.equal(readProjectSeeds(params('attach=v:not-an-id')).attach, null);
  assert.equal(readProjectSeeds(params(`attach=${attachParam(id)}`)).seeded, true);
});
