import test from 'node:test';
import assert from 'node:assert/strict';
// Node strips the types from this file itself, so the tests run against the
// very code the browser uses rather than a copy.
import { makeAiLinks, aiAppEnabled, parseOpenParam, openParam } from '../src/lib/aiLinks.ts';

test('with the flag off every link goes to the site pages the app has today', () => {
  const site = makeAiLinks(false);
  assert.equal(site.home(), '/assistant');
  assert.equal(site.home({ mode: 'draft' }), '/assistant?mode=draft');
  assert.equal(site.chat('t1'), '/assistant?chat=t1');
  assert.equal(site.chat('t1', { matterId: 'm1' }), '/matters/m1/ai?chat=t1');
  assert.equal(site.project('m1'), '/matters/m1/ai');
  assert.equal(site.project('m1', { mode: 'review', doc: 'd1', version: 'v2' }), '/matters/m1/ai?mode=review&doc=d1&version=v2');
  assert.equal(site.project('m1', { update: 'u1' }), '/matters/m1/ai?update=u1');
  assert.equal(site.document('v1', { matterId: 'm1' }), '/matters/m1');
  assert.equal(site.document('v1'), '/matters');
});

test('with the flag on every link goes to the new workspace', () => {
  const ai = makeAiLinks(true);
  assert.equal(ai.home(), '/ai');
  assert.equal(ai.home({ mode: 'draft' }), '/ai?mode=draft');
  assert.equal(ai.home({ skill: 's1' }), '/ai?skill=s1');
  assert.equal(ai.chat('t1'), '/ai/c/t1');
  assert.equal(ai.chat('t1', { matterId: 'm1' }), '/ai/c/t1');
  assert.equal(ai.project('m1'), '/ai/p/m1');
  assert.equal(ai.project('m1', { mode: 'edit' }), '/ai/p/m1?mode=edit');
  assert.equal(ai.document('v1'), '/ai/d/v1');
});

test('the flag reads VITE_AI_APP as a boolean or a string', () => {
  assert.equal(aiAppEnabled({ VITE_AI_APP: 'true' }), true);
  assert.equal(aiAppEnabled({ VITE_AI_APP: '1' }), true);
  assert.equal(aiAppEnabled({ VITE_AI_APP: true }), true);
  assert.equal(aiAppEnabled({ VITE_AI_APP: 'false' }), false);
  assert.equal(aiAppEnabled({}), false);
  assert.equal(aiAppEnabled(undefined), false);
});

test('?open= names a chat document or a stored version, and nothing else', () => {
  const id = '3f2c1e4a-1b2c-4d5e-8f90-123456789abc';
  assert.deepEqual(parseOpenParam(`a:${id}`), { kind: 'artifact', id });
  assert.deepEqual(parseOpenParam(`v:${id}`), { kind: 'version', id });
  assert.equal(parseOpenParam(`A:${id}`).kind, 'artifact');
  assert.equal(parseOpenParam('a:not-an-id'), null);
  assert.equal(parseOpenParam(`x:${id}`), null);
  assert.equal(parseOpenParam(''), null);
  assert.equal(parseOpenParam(null), null);
  assert.equal(openParam({ kind: 'artifact', id }), `a:${id}`);
  assert.equal(openParam({ kind: 'version', id }), `v:${id}`);
  assert.equal(openParam(null), undefined);
});
