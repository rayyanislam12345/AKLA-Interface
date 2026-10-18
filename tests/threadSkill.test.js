import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveThreadSkill, seedSkillFor, shouldClearSkill } from '../src/lib/threadSkill.ts';

const types = [{ id: 'dt1', name: 'Share Purchase Agreement' }];
const custom = [{ id: 'cs1', name: 'Board minutes' }];

test('the chip shows the skill the chat is in', () => {
  assert.equal(resolveThreadSkill(null, {}), null);
  assert.equal(resolveThreadSkill(undefined, {}), null);
  assert.deepEqual(resolveThreadSkill({ key: 'review' }, {}), { key: 'review', label: 'Review', documentTypeId: undefined, customSkillId: undefined, documentVersionId: undefined, matterDocumentId: undefined });
  // Verify was merged into Review; chats saved before still read as Review.
  assert.equal(resolveThreadSkill({ key: 'verify' }, {}).key, 'review');
  assert.equal(resolveThreadSkill({ key: 'summarise' }, {}).label, 'Summarise');
  assert.equal(resolveThreadSkill({ key: 'agreement' }, {}).label, 'Agreement');
});

test('a draft names its document type once the types have loaded', () => {
  assert.equal(resolveThreadSkill({ key: 'draft', documentTypeId: 'dt1' }, {}).label, 'Draft');
  assert.equal(resolveThreadSkill({ key: 'draft', documentTypeId: 'dt1' }, { documentTypes: types }).label, 'Draft · Share Purchase Agreement');
  assert.equal(resolveThreadSkill({ key: 'draft' }, { documentTypes: types }).label, 'Draft');
});

test('an edit is named after the chat; one without a version is nothing', () => {
  const edit = resolveThreadSkill({ key: 'edit', documentVersionId: 'v1', matterDocumentId: 'd1' }, { threadTitle: 'Edit: Lease (v2)' });
  assert.equal(edit.label, 'Edit · Lease (v2)');
  assert.equal(edit.documentVersionId, 'v1');
  assert.equal(resolveThreadSkill({ key: 'edit', documentVersionId: 'v1' }, {}).label, 'Edit');
  assert.equal(resolveThreadSkill({ key: 'edit' }, { threadTitle: 'Edit: Lease (v2)' }), null);
});

test('a firm skill shows its name, and nothing once it has been deleted', () => {
  assert.equal(resolveThreadSkill({ key: 'custom', customSkillId: 'cs1' }, { customSkills: custom }).label, 'Board minutes');
  assert.equal(resolveThreadSkill({ key: 'custom', customSkillId: 'gone' }, { customSkills: custom }), null);
  assert.equal(resolveThreadSkill({ key: 'custom', customSkillId: 'cs1' }, {}), null);
  // Standardisation sessions have no chip in a project chat.
  assert.equal(resolveThreadSkill({ key: 'standardise' }, {}), null);
});

test('?mode= seeds the composer', () => {
  assert.deepEqual(seedSkillFor('draft'), { key: 'draft', label: 'Draft' });
  assert.deepEqual(seedSkillFor('review'), { key: 'review', label: 'Review' });
  assert.deepEqual(seedSkillFor('verify'), { key: 'review', label: 'Review' });
  assert.deepEqual(seedSkillFor('summarise'), { key: 'summarise', label: 'Summarise' });
  assert.deepEqual(seedSkillFor('agreement'), { key: 'agreement', label: 'Agreement' });
  // A Revise link is a Review even without a mode.
  assert.deepEqual(seedSkillFor(null, 'update1'), { key: 'review', label: 'Review' });
  assert.equal(seedSkillFor(null), undefined);
  assert.equal(seedSkillFor('edit'), undefined);
});

test('taking the chip off tells the server, except while firm skills are still loading', () => {
  const base = { chipSkill: null, threadId: 't1', storedSkill: { key: 'review' }, threadHasSkill: false, customSkillsLoaded: true };
  assert.equal(shouldClearSkill(base), true);
  assert.equal(shouldClearSkill({ ...base, chipSkill: { key: 'review', label: 'Review' } }), false);
  assert.equal(shouldClearSkill({ ...base, threadId: null }), false);
  assert.equal(shouldClearSkill({ ...base, storedSkill: null }), false);
  assert.equal(shouldClearSkill({ ...base, storedSkill: null, threadHasSkill: true }), true);
  assert.equal(shouldClearSkill({ ...base, storedSkill: { key: 'custom', customSkillId: 'cs1' }, customSkillsLoaded: false }), false);
  assert.equal(shouldClearSkill({ ...base, storedSkill: { key: 'custom', customSkillId: 'cs1' }, customSkillsLoaded: true }), true);
});
