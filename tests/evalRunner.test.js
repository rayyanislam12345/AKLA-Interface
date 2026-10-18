// The retrieval evaluation's runner (scripts/eval/run.mjs), without the
// network: the retrieve adapter carries what each scope's search reported
// — whether and why it fell back, which path answered, its Voyage calls and
// stage timings — and the result row written to the result file keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveAdapter, toolsAdapter, resultRow } from '../scripts/eval/run.mjs';

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

// The tools adapter measures the tools as the assistant runs them.
test('the tools adapter takes each precedent passage\'s file from the tool\'s answer and hands the model for phrasings to the law and project tools, as the chat does', async () => {
  const calls = [];
  const anthropicJson = async () => ({ content: [] });
  const lib = {
    listActs: async () => [{ act_name: 'Contract Act, 1872', chunk_count: 10 }],
    readActSection: async () => { throw new Error('no section was named'); },
    searchLaw: async (sb, key, input, opts) => {
      calls.push({ tool: 'law', input, opts });
      return [{ id: 's1', act_name: 'Contract Act, 1872', section: '74', label: 'Contract Act, 1872, s.74', text: '74. Compensation for breach of contract where penalty stipulated for.', similarity: 0.7 }];
    },
    searchPrecedentsTool: async (sb, key, aj, input, opts) => {
      calls.push({ tool: 'precedent', input, opts, anthropicJson: aj });
      return [
        { id: 'precedent:precedent/x/EPC.docx:row-1:4', storage_path: 'precedent/x/EPC.docx', filename: 'EPC.docx', label: 'EPC.docx, cl. 14.2', text: 'Liquidated damages are a genuine pre-estimate.', similarity: 0.6 },
        // An id of another shape: the path comes from what the tool states.
        { id: 'row-9', storage_path: 'precedent/y/SHA.docx', filename: 'SHA.docx', label: 'SHA.docx', text: 'Deadlock.', similarity: 0.5 },
      ];
    },
    searchProject: async (sb, key, input, opts) => {
      calls.push({ tool: 'project', input, opts });
      return [{ id: 'd1', filename: 'Term Sheet.docx', label: 'Term Sheet v3, 4.2 Concession Period', text: 'The concession period is thirty years.', storage_path: 'matter/m1/term-sheet.docx', similarity: 0.4 }];
    },
  };
  const supabase = { from: () => ({ select: () => ({ in: async () => ({ data: [{ id: 'd1', metadata: { storage_path: 'matter/m1/term-sheet.docx' } }], error: null }) }) }) };
  const adapter = toolsAdapter({ supabase, voyageKey: 'v', anthropicJson, lib, place: async () => [], route: 'auto' });

  const precedentQ = { id: 'C02', kind: 'precedent_clause', scope: 'general', question: 'example of a drag along clause in a joint venture agreement', expected: [{ match: 'storage_path', value: 'precedent/x/EPC.docx' }] };
  const results = await adapter.retrieve(precedentQ.question, precedentQ.scope, precedentQ);
  const precedents = results.filter((r) => r.kind === 'precedent');
  assert.deepEqual(precedents.map((r) => r.storage_path), ['precedent/x/EPC.docx', 'precedent/y/SHA.docx']);
  assert.deepEqual(precedents.map((r) => r.id), ['precedent:precedent/x/EPC.docx:row-1:4', 'row-9']);
  assert.equal(resultRow(precedentQ, results, { ms: 1 }).firstRank, 1, 'scored by the file');
  const law = calls.find((c) => c.tool === 'law');
  assert.equal(law.opts.anthropicJson, anthropicJson, 'the law search is given the model for phrasings, as makeToolRunner gives it');
  assert.equal(calls.find((c) => c.tool === 'precedent').anthropicJson, anthropicJson);

  const projectQ = { id: 'P01', kind: 'project_fact', scope: 'm1', question: 'what is the concession period under the term sheet', expected: [{ match: 'storage_path', value: 'matter/m1/term-sheet.docx' }] };
  const inProject = await adapter.retrieve(projectQ.question, projectQ.scope, projectQ);
  assert.deepEqual(inProject.map((r) => [r.kind, r.storage_path]), [['matter', 'matter/m1/term-sheet.docx']]);
  const project = calls.find((c) => c.tool === 'project');
  assert.equal(project.input.matterId, 'm1');
  assert.equal(project.opts.anthropicJson, anthropicJson);
});
