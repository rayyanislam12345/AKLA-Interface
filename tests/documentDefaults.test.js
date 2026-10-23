import test from 'node:test';
import assert from 'node:assert/strict';
import { guessDocumentType, statusFromStage } from '../src/lib/documentDefaults.ts';
import { parseFileName } from '../src/lib/fileNames.ts';

const TYPES = [
  { id: 'ca', name: 'Concession Agreement' },
  { id: 'cda', name: 'Concession Direct Agreement' },
  { id: 'cta', name: 'Common Terms Agreement (CTA)' },
  { id: 'epc', name: 'EPC Contract' },
  { id: 'sha', name: 'Shareholders Agreement' },
  { id: 'letter', name: 'Letter / Notice' },
  { id: 'fee', name: 'Fee Letter' },
  { id: 'assign', name: 'Assignment Agreement / Deed' },
  { id: 'opinion', name: 'Legal Opinion' },
];

const guess = (title) => guessDocumentType(title, TYPES)?.id ?? null;

test('a title naming a type gets that type; the longest name wins', () => {
  assert.equal(guess('M6 Concession Agreement'), 'ca');
  assert.equal(guess('Concession Direct Agreement - Lenders'), 'cda');
  assert.equal(guess('EPC Contract (clean)'), 'epc');
  assert.equal(guess("Shareholders' Agreement"), 'sha');
  assert.equal(guess('Draft Legal Opinion on land title'), 'opinion');
  assert.equal(guess('Assignment Agreement'), 'assign');
});

test('short forms match only as capitalised words, and only for a type the firm has', () => {
  assert.equal(guess('CTA v3 lender comments'), 'cta');
  assert.equal(guess('SHA - KPT'), 'sha');
  assert.equal(guess('Factual summary'), null);
  assert.equal(guess('Spa booking'), null);
});

test('a one-word type name claims nothing; nothing named gives null', () => {
  assert.equal(guess('Letter to the Authority'), null);
  assert.equal(guess('Notice of termination'), null);
  assert.equal(guess('Fee Letter - arrangers'), 'fee');
  assert.equal(guess('Board pack'), null);
});

test('the stage tag in a file name gives the status; no tag gives none', () => {
  assert.equal(statusFromStage(parseFileName('SHA [Executed].pdf').stage), 'executed');
  assert.equal(statusFromStage(parseFileName('CA [Circulated] 12 Oct 2026.docx').stage), 'with_counterparty');
  assert.equal(statusFromStage(parseFileName('CA [For Partner Review].docx').stage), 'internal_review');
  assert.equal(statusFromStage(parseFileName('KPT 5.7 CA [Final].docx').stage), 'finalized');
  assert.equal(statusFromStage(parseFileName('CA.docx').stage), null);
  assert.equal(statusFromStage(null), null);
});
