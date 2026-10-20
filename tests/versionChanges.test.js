import test from 'node:test';
import assert from 'node:assert/strict';
// Node strips the types from this file itself, so the tests run against the
// very rules the viewer uses.
import {
  changesTabLabel,
  decisionErrorText,
  isMissingTable,
  opensOnChanges,
  showsChangesTab,
  viewerFileOf,
} from '../src/lib/versionChangesRules.ts';

const version = { storage_path: 'm/d/v5.docx' };

test('the viewer draws the decided copy once there is one, else the version as filed', () => {
  assert.equal(viewerFileOf(version, null), 'm/d/v5.docx');
  assert.equal(viewerFileOf(version, undefined), 'm/d/v5.docx');
  assert.equal(viewerFileOf(version, { storage_path: null }), 'm/d/v5.docx');
  assert.equal(viewerFileOf(version, { storage_path: 'm/d/v5-id/changes/1-a-v5.docx' }), 'm/d/v5-id/changes/1-a-v5.docx');
});

test('the Changes tab shows for a version with change rows; once its list loads, the list decides', () => {
  assert.equal(showsChangesTab({ rowCount: 0 }), false);
  assert.equal(showsChangesTab({ rowCount: null }), false);
  assert.equal(showsChangesTab({ rowCount: 3 }), true);
  // An empty list hides the tab, whatever the row count said.
  assert.equal(showsChangesTab({ rowCount: 3, listed: 0 }), false);
  assert.equal(showsChangesTab({ rowCount: 3, listed: 3 }), true);
  assert.equal(showsChangesTab({ rowCount: 0, listed: 2 }), true);
});

test('the tab says how many changes wait, and a version opens on it while any do', () => {
  assert.equal(changesTabLabel(3), 'Changes (3 waiting)');
  assert.equal(changesTabLabel(0), 'Changes');
  assert.equal(changesTabLabel(undefined), 'Changes');
  assert.equal(opensOnChanges({ waiting: 2 }), true);
  assert.equal(opensOnChanges({ waiting: 0 }), false);
  assert.equal(opensOnChanges(null), false);
});

test('someone deciding at the same moment is said plainly; other refusals keep the service sentence', () => {
  const race = decisionErrorText(409, 'This document changed while you were deciding. Reload and try again.');
  assert.match(race, /at the same moment/);
  assert.match(race, /reloaded/);
  assert.equal(decisionErrorText(409, 'Only a Word version has tracked changes to decide.'), 'Only a Word version has tracked changes to decide.');
  assert.equal(decisionErrorText(400, 'One of the changes is not in this document.'), 'One of the changes is not in this document.');
  assert.equal(decisionErrorText(0, 'The chat service couldn\'t be reached.'), 'The chat service couldn\'t be reached.');
});

test('a missing heads table (before its migration) is told apart from a real error', () => {
  assert.equal(isMissingTable({ code: 'PGRST205', message: "Could not find the table 'public.version_change_heads' in the schema cache" }), true);
  assert.equal(isMissingTable({ code: '42P01', message: 'relation does not exist' }), true);
  assert.equal(isMissingTable({ code: '42501', message: 'permission denied' }), false);
  assert.equal(isMissingTable(null), false);
});
