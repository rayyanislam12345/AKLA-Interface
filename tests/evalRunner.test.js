// The retrieval evaluation's runner (scripts/eval/run.mjs), without the
// network: the retrieve adapter carries what each scope's search reported
// — whether and why it fell back, which path answered, its Voyage calls and
// stage timings — and the result row written to the result file keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveAdapter, resultRow } from '../scripts/eval/run.mjs';

const question = {
  id: 'S04', kind: 'statute_concept', scope: 'general',
  question: 'is a liquidated damages clause enforceable in pakistan or will the court treat it as a penalty',
  expected: [{ match: 'act_section', act: 'Contract Act, 1872', section: '74' }],
};

// retrieve.js, stubbed: the statute search fell back to words alone, the
// precedent search finished in full.
const reported = {
  statute: {
    passages: [{ id: 's74', scope: 'statute', act_name: 'Contract Act, 1872', section: '74', label: 'Contract Act, 1872, s.74', text: '74. Compensation for breach of contract where penalty stipulated for.', lead: false }],
    timings: {
      total: 12010, scope: 'statute', engine: 'hybrid', phrasings: 1, rewriteLate: false, reranked: false, rerankSkipped: null,
      voyageCalls: 1, fellBack: true, path: 'words', deadlineMs: 12000,
      reason: "the search took longer than 12000 ms: returned the search by words alone (the question's embedding was not back), not reranked",
      events: [{ stage: 'words only', start: 1, ms: 900, phrasing: 0, byWordsOnly: true, rows: 15, engine: 'hybrid' }, { stage: 'embed', start: 2, ms: 12005, texts: 1, error: 'This operation was aborted' }],
    },
  },
  precedent: {
    passages: [{ id: 'precedent:precedent/x/EPC.docx:p1:4', scope: 'precedent', storage_path: 'precedent/x/EPC.docx', filename: 'EPC.docx', label: 'EPC.docx, cl. 14.2', text: 'Liquidated damages are a genuine pre-estimate.', lead: false }],
    timings: { total: 4200, scope: 'precedent', engine: 'hybrid', phrasings: 3, rewriteLate: false, reranked: true, rerankSkipped: null, voyageCalls: 2, fellBack: false, path: 'full', deadlineMs: 12000, reason: null, events: [{ stage: 'rerank', start: 3000, ms: 1100, docs: 30 }] },
  },
};

test('the retrieve adapter records each scope\'s fellBack, reason, path, Voyage calls and stage timings, and the result row carries them into the result file', async () => {
  const asked = [];
  const retrieveMod = { retrieve: async (opts) => { asked.push(opts); return reported[opts.scope]; } };
  const adapter = retrieveAdapter({
    supabase: {}, voyageKey: 'v', anthropicJson: null, route: 'auto', retrieveMod,
    lib: { listActs: async () => [] }, place: async () => [],
  });
  const results = await adapter.retrieve(question.question, question.scope, question);
  assert.deepEqual(asked.map((o) => o.scope).sort(), ['precedent', 'statute'], 'a law-sounding question outside a project: statutes and precedents');
  assert.ok(asked.every((o) => o.timings === true), 'timings asked for');

  const timing = results.timing;
  assert.deepEqual(timing.fellBack, ['statute']);
  assert.equal(timing.voyageCalls, 3);
  assert.equal(timing.searchMs >= 0, true);
  const byScope = Object.fromEntries(timing.scopes.map((s) => [s.scope, s]));
  assert.equal(byScope.statute.fellBack, true);
  assert.equal(byScope.statute.path, 'words');
  assert.equal(byScope.statute.reason, reported.statute.timings.reason);
  assert.equal(byScope.statute.voyageCalls, 1);
  assert.equal(byScope.statute.deadlineMs, 12000);
  assert.equal(byScope.statute.passages, 1);
  assert.deepEqual(byScope.statute.events.map((e) => e.stage), ['words only', 'embed']);
  assert.equal(byScope.precedent.fellBack, false);
  assert.equal(byScope.precedent.path, 'full');
  assert.equal(byScope.precedent.reason, null);
  assert.equal(byScope.precedent.reranked, true);

  // The row the runner writes (JSON.stringify, as to the result file).
  const row = JSON.parse(JSON.stringify(resultRow(question, results, { ms: 12300, error: null })));
  assert.equal(row.id, 'S04');
  assert.equal(row.ms, 12300);
  assert.deepEqual(row.fellBack, ['statute']);
  assert.equal(row.voyageCalls, 3);
  assert.equal(row.retrieve.length, 2);
  const statute = row.retrieve.find((s) => s.scope === 'statute');
  assert.equal(statute.fellBack, true);
  assert.equal(statute.path, 'words');
  assert.match(statute.reason, /by words alone/);
  assert.equal(statute.voyageCalls, 1);
  assert.equal(statute.events[0].stage, 'words only');
  assert.equal(statute.events[0].ms, 900);
  assert.equal(row.firstRank, 1, 'the words-only passage, s.74, is scored like any other');
  assert.equal(row.resultCount, 2);
  assert.equal(row.top[0].sections[0], '74');

  // Results without timing (an older retrieve.js, another adapter): the fields are null, not missing.
  const bare = resultRow(question, [], { ms: 5, error: 'down' });
  assert.equal(bare.retrieve, null);
  assert.equal(bare.fellBack, null);
  assert.equal(bare.voyageCalls, null);
  assert.equal(bare.error, 'down');
  assert.ok('retrieve' in bare && 'searchMs' in bare);
});
