// The one search (retrieve.js), without the network: fusion and the per-file
// cap, citation labels, the switch to match_documents when the hybrid search
// is not in the database, and the fused order standing when the reranker
// fails. The database and the Voyage and model services are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retrieve, retrieveDetailed, fuseLists, capPerFile, dedupeByText, buildLabel, shortHeading, sectionFromHeading, clauseOf,
  keywordText, isMissingFunction, namedAct, rrfOf, toCandidate, rerankPassages, passageText, clearRetrieveCaches, MAX_TEXT,
  rerankText, stopwatch, RERANK_POOL, RERANK_CHARS,
} from '../retrieve.js';
import { clearCaches } from '../libraryTools.js';

// ------------------------------------------------------------------ stubs

// A Supabase client: rpc answers by function name; every table query
// resolves to answers.tables[table] (an array) whatever its filters.
function fakeSupabase({ rpc = {}, tables = {} } = {}) {
  const calls = [];
  const chain = (table) => {
    const q = {};
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'limit', 'ilike']) q[m] = () => q;
    q.then = (ok, bad) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok, bad);
    return q;
  };
  return {
    calls,
    rpc: (name, args) => {
      calls.push({ name, args });
      const answer = rpc[name];
      if (!answer) return Promise.resolve({ data: [], error: null });
      return Promise.resolve(typeof answer === 'function' ? answer(args) : answer);
    },
    from: (table) => { calls.push({ table }); return chain(table); },
  };
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// Voyage: embeddings answer one vector per input; rerank answers with
// `rerank(body)` (default: the documents in reverse order).
function fakeVoyage({ rerank = null, embedFails = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url.endsWith('/embeddings')) {
      if (embedFails) return json({ error: 'down' }, 503);
      return json({ data: body.input.map((_, i) => ({ index: i, embedding: [i + 1, 0, 0] })) });
    }
    if (url.endsWith('/rerank')) {
      if (rerank) return rerank(body);
      const n = body.documents.length;
      return json({ data: body.documents.map((_, i) => ({ index: n - 1 - i, relevance_score: 0.9 - i * 0.1 })).slice(0, body.top_k) });
    }
    throw new Error(`unexpected request to ${url}`);
  };
  return { requests, fetchImpl };
}

const row = (id, over = {}) => ({
  id, content: `Passage ${id} on the concession period.`, metadata: { storage_path: `m/d/${id}.docx`, filename: `${id}.docx`, document_title: 'Term Sheet' },
  heading_path: null, page: null, document_version_id: `v-${id}`, matter_document_id: 'd1', version_number: 3,
  vector_rank: 1, keyword_rank: null, rrf_score: 1 / 61, name_rank: null, ...over,
});

test.beforeEach(() => { clearRetrieveCaches(); clearCaches(); });

// ------------------------------------------------------------- pure parts

test('fusion keeps each passage\'s best fused score, its best leg ranks, and breaks ties by how many phrasings found it', () => {
  const a = (key, rrf, extra = {}) => ({ key, rrf, fileKey: key, ...extra });
  const fused = fuseLists([
    [a('x', rrfOf(1), { vectorRank: 1 }), a('y', rrfOf(2), { keywordRank: 2 })],
    [a('y', rrfOf(1), { vectorRank: 1 }), a('z', rrfOf(1))],
    [a('z', rrfOf(5))],
  ]);
  // All three reach 1/61; y and z were found twice (y's other rank is the
  // better), x once.
  assert.deepEqual(fused.map((c) => c.key), ['y', 'z', 'x']);
  const y = fused.find((c) => c.key === 'y');
  assert.equal(y.rrf, rrfOf(1), 'best, not summed');
  assert.equal(y.phrasings, 2);
  assert.equal(y.vectorRank, 1);
  assert.equal(y.keywordRank, 2, 'leg ranks are kept from every list');
  assert.equal(rrfOf(1), 1 / 61);
  assert.equal(rrfOf(null), 0);
});

test('at most three passages come from one file; an uncapped search keeps them all; repeated text is dropped', () => {
  const items = ['a', 'a', 'b', 'a', 'a', 'c', 'b'].map((f, i) => ({ key: `${f}${i}`, fileKey: f }));
  assert.deepEqual(capPerFile(items).map((c) => c.key), ['a0', 'a1', 'b2', 'a3', 'c5', 'b6']);
  assert.deepEqual(capPerFile(items, 1).map((c) => c.key), ['a0', 'b2', 'c5']);
  assert.equal(capPerFile(items, Infinity).length, items.length);
  const copies = dedupeByText([{ key: 1, content: 'Section 73.  Compensation' }, { key: 2, content: 'section 73. compensation' }, { key: 3, content: 'Other' }]);
  assert.deepEqual(copies.map((c) => c.key), [1, 3]);
});

test('labels name the document, its version and where in it; the precedent file and clause; the Act and section', () => {
  assert.equal(buildLabel({ scope: 'project', title: 'Term Sheet', version_number: 3, heading_path: 'Part A › 4. Commercial terms › 4.2 Concession Period' }), 'Term Sheet v3, 4. Commercial terms › 4.2 Concession Period');
  assert.equal(buildLabel({ scope: 'project', title: 'Transaction Structure Report', version_number: 1, page: 12 }), 'Transaction Structure Report v1, p. 12');
  assert.equal(buildLabel({ scope: 'project', filename: 'notes.docx' }), 'notes.docx');
  assert.equal(buildLabel({ scope: 'precedent', filename: '12. JVA.pdf', heading_path: 'Clause 9 Transfers › 9.3 Drag along' }), '12. JVA.pdf, Clause 9 Transfers › 9.3 Drag along');
  assert.equal(buildLabel({ scope: 'precedent', filename: 'EPC.docx', text: '14.2 The Employer may terminate for convenience.' }), 'EPC.docx, cl. 14.2');
  assert.equal(buildLabel({ scope: 'precedent', filename: 'EPC.docx', text: 'whereas the parties agree' }), 'EPC.docx');
  assert.equal(buildLabel({ scope: 'statute', act_name: 'Contract Act, 1872', section: '74' }), 'Contract Act, 1872, s.74');
  assert.equal(buildLabel({ scope: 'statute', act_name: 'Contract Act, 1872' }), 'Contract Act, 1872');
  assert.equal(sectionFromHeading('Chapter VI › 73. Compensation for loss or damage caused by breach'), '73');
  assert.equal(sectionFromHeading('Part II › Section 83A Further issue of capital'), '83A');
  assert.equal(sectionFromHeading('Part IV › Chapter 2'), null);
  assert.equal(shortHeading('A › B › C'), 'B › C');
  assert.equal(clauseOf('Article 14 Termination'), 'Article 14');
});

test('a long text is searched by its telling words; a question is searched as asked', () => {
  assert.equal(keywordText('what is the concession period'), 'what is the concession period');
  const long = `${'The Concessionaire shall pay the Concession Fee to the Authority. '.repeat(8)}Liquidated damages for delay apply. The parties agree that the agreement is binding.`;
  const words = keywordText(long).split(' ');
  assert.ok(words.length <= 12);
  assert.ok(words.includes('concessionaire') && words.includes('concession') && words.includes('liquidated'));
  assert.ok(!words.some((w) => ['the', 'shall', 'parties', 'agreement'].includes(w)));
});

test('a missing hybrid search is told apart from a failing one', () => {
  assert.ok(isMissingFunction({ code: 'PGRST202', message: 'Could not find the function public.search_passages(...) in the schema cache' }));
  assert.ok(isMissingFunction({ code: '42883', message: 'function public.search_passages(...) does not exist' }));
  assert.ok(isMissingFunction({ code: '42703', message: 'column d.tsv does not exist' }));
  assert.ok(!isMissingFunction({ code: '57014', message: 'canceling statement due to statement timeout' }));
  assert.ok(!isMissingFunction(null));
});

test('the Act a question names is found among the laws held', () => {
  const held = ['Companies Act, 2017', 'Contract Act, 1872', 'PPRA Rules 2004', 'Arbitration Act, 1940'];
  assert.equal(namedAct('what does section 208 of the companies act 2017 say', held), 'Companies Act, 2017');
  assert.equal(namedAct('contract act sectoin 73 compensation', held), 'Contract Act, 1872');
  assert.equal(namedAct('PPRA rules 2004 rule 36', held), 'PPRA Rules 2004');
  assert.equal(namedAct('companies act 1984 section 5', held), null, 'a different year is a different law');
  assert.equal(namedAct('what is a penalty', held), null);
});

// -------------------------------------------------------------- the flow

test('a project search: one embedding call, the hybrid search scoped to the project and current versions, reranked, labelled', async () => {
  const supabase = fakeSupabase({
    rpc: {
      search_passages: (args) => ({
        data: [
          row('a', { heading_path: '4. Term › 4.2 Concession Period', vector_rank: 1, keyword_rank: 1, rrf_score: 2 / 61 }),
          row('b', { page: 7, vector_rank: 2, rrf_score: 1 / 62, document_version_id: 'v-b', version_number: 1, metadata: { storage_path: 'm/e/b.pdf', filename: 'b.pdf', document_title: 'Transaction Structure Report' } }),
        ].slice(0, args.k),
        error: null,
      }),
    },
  });
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'what is the concession period', scope: 'project', matterId: 'm1', k: 5, fetchImpl: voyage.fetchImpl });
  assert.equal(out.engine, 'hybrid');
  assert.equal(out.reranked, true);
  const embeds = voyage.requests.filter((r) => r.url.endsWith('/embeddings'));
  assert.equal(embeds.length, 1);
  assert.deepEqual(embeds[0].body.input, ['what is the concession period']);
  assert.equal(embeds[0].body.input_type, 'query');
  const call = supabase.calls.find((c) => c.name === 'search_passages');
  assert.deepEqual(Object.keys(call.args).sort(), ['act_names', 'all_versions', 'document_type_id', 'exclude_document_id', 'k', 'matter_id', 'query_embedding', 'query_text', 'scope'].sort());
  assert.equal(call.args.scope, 'project');
  assert.equal(call.args.matter_id, 'm1');
  assert.equal(call.args.all_versions, false);
  assert.deepEqual(call.args.query_embedding, [1, 0, 0]);
  const rerank = voyage.requests.find((r) => r.url.endsWith('/rerank'));
  assert.equal(rerank.body.model, 'rerank-2');
  assert.equal(rerank.body.query, 'what is the concession period');
  assert.equal(rerank.body.top_k, 2);
  assert.match(rerank.body.documents[0], /^Term Sheet v3, 4. Term › 4.2 Concession Period\n\nPassage a/);
  // The stub reranker reverses the order.
  assert.deepEqual(out.passages.map((p) => p.id), ['b', 'a']);
  assert.equal(out.passages[0].label, 'Transaction Structure Report v1, p. 7');
  assert.equal(out.passages[0].similarity, 0.9);
  assert.equal(out.passages[1].label, 'Term Sheet v3, 4. Term › 4.2 Concession Period');
  assert.equal(out.passages[1].storage_path, 'm/d/a.docx');
  // A project search outside a project finds nothing and asks nothing.
  assert.deepEqual(await retrieve({ supabase, voyageKey: 'v', query: 'x y', scope: 'project', fetchImpl: voyage.fetchImpl }), []);
});

test('when the reranker fails, the fused order stands and the fused score is the similarity', async () => {
  const supabase = fakeSupabase({ rpc: { search_passages: { data: [row('a', { rrf_score: 0.03 }), row('b', { rrf_score: 0.02 }), row('c', { rrf_score: 0.01 })], error: null } } });
  for (const failing of [() => json({ detail: 'overloaded' }, 529), () => json({ data: [] }), () => { throw new Error('socket hang up'); }]) {
    clearRetrieveCaches();
    const voyage = fakeVoyage({ rerank: failing });
    const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'concession period', scope: 'project', matterId: 'm1', k: 2, fetchImpl: voyage.fetchImpl });
    assert.equal(out.reranked, false);
    assert.deepEqual(out.passages.map((p) => p.id), ['a', 'b']);
    assert.equal(out.passages[0].similarity, 0.03);
    assert.equal(out.passages[0].rerankScore, null);
  }
  // A reranker answer naming passages that do not exist is not trusted either.
  const bad = await rerankPassages({ voyageKey: 'v', query: 'q', passages: [{ key: 'a' }, { key: 'b' }], k: 2, fetchImpl: async () => json({ data: [{ index: 7, relevance_score: 1 }] }) });
  assert.equal(bad.reranked, false);
  assert.deepEqual(bad.passages.map((p) => p.key), ['a', 'b']);
});

test('before the hybrid migration, the search falls back to match_documents and filters project versions itself', async () => {
  const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.search_passages(act_names, ...) in the schema cache' } };
  const mdRow = (id, path, similarity) => ({ id, content: `Passage ${id} on the term.`, metadata: { storage_path: path, filename: path.split('/').pop() }, similarity });
  const supabase = fakeSupabase({
    rpc: {
      search_passages: missing,
      match_documents: { data: [mdRow('old', 'm/d/v1.pdf', 0.9), mdRow('cur', 'm/d/v2.pdf', 0.8), mdRow('ai', 'm/d/v3.docx', 0.7), mdRow('gone', 'm/x/deleted.pdf', 0.6)], error: null },
    },
    tables: {
      matter_documents: [{ id: 'd', title: 'FSA', versions: [
        { id: 'v1', version_number: 1, storage_path: 'm/d/v1.pdf', is_ai_generated: false },
        { id: 'v2', version_number: 2, storage_path: 'm/d/v2.pdf', is_ai_generated: false },
        { id: 'v3', version_number: 3, storage_path: 'm/d/v3.docx', is_ai_generated: true },
      ] }],
    },
  });
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'term of the FSA', scope: 'project', matterId: 'm1', k: 5, fetchImpl: voyage.fetchImpl, rerank: false });
  assert.equal(out.engine, 'vector');
  assert.deepEqual(out.passages.map((p) => p.id), ['cur'], 'superseded, AI-generated and deleted versions are left out');
  assert.equal(out.passages[0].label, 'FSA v2');
  const md = supabase.calls.find((c) => c.name === 'match_documents');
  assert.equal(md.args.filter_matter_id, 'm1');
  assert.deepEqual(md.args.query_embedding, [1, 0, 0]);
  // All versions asked for: everything that still has a version.
  const all = await retrieve({ supabase, voyageKey: 'v', query: 'term of the FSA', scope: 'project', matterId: 'm1', allVersions: true, rerank: false, fetchImpl: voyage.fetchImpl });
  assert.deepEqual(all.map((p) => p.id).sort(), ['ai', 'cur', 'old']);
  // For the next minute the missing function is not asked for again.
  assert.equal(supabase.calls.filter((c) => c.name === 'search_passages').length, 1);
  // A real failure is not mistaken for a missing function.
  clearRetrieveCaches();
  const broken = fakeSupabase({ rpc: { search_passages: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } } });
  await assert.rejects(retrieve({ supabase: broken, voyageKey: 'v', query: 'term', scope: 'project', matterId: 'm1', fetchImpl: voyage.fetchImpl }), /statement timeout/);
  assert.equal(broken.calls.filter((c) => c.name === 'search_passages').length, 2, 'a timeout is tried once more');
});

test('a precedent question is rewritten once into legal phrasings, each searched, merged', async () => {
  let asked = 0;
  const anthropicJson = async (body) => {
    asked++;
    assert.match(body.system, /precedent agreements/);
    return { content: [{ type: 'text', text: '["tag-along right", "shall be entitled to sell its shares on the same terms"]' }] };
  };
  const supabase = fakeSupabase({
    rpc: {
      search_passages: (args) => ({
        data: args.query_text === 'tag-along right'
          ? [{ ...row('p1'), metadata: { storage_path: 'precedent/x/SSA.docx', filename: 'SSA.docx', passage_ordinal: 12 }, content: '7.2 Tag-Along. If the Majority sells...', rrf_score: 2 / 61 }]
          : [{ ...row('p1'), metadata: { storage_path: 'precedent/x/SSA.docx', filename: 'SSA.docx', passage_ordinal: 3 }, content: '1. Definitions', rrf_score: 1 / 70 }],
        error: null,
      }),
    },
  });
  const voyage = fakeVoyage();
  const q = 'tag along where a shareholder sells to a third party';
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', k: 5, fetchImpl: voyage.fetchImpl, rerank: false });
  assert.deepEqual(out.phrasings, [q, 'tag-along right', 'shall be entitled to sell its shares on the same terms']);
  assert.equal(supabase.calls.filter((c) => c.name === 'search_passages').length, 3);
  const embeds = voyage.requests.filter((r) => r.url.endsWith('/embeddings'));
  assert.equal(embeds.length, 2, 'the question is embedded at once, the phrasings together when they come');
  assert.deepEqual(embeds[0].body.input, [q]);
  assert.deepEqual(embeds[1].body.input, ['tag-along right', 'shall be entitled to sell its shares on the same terms']);
  assert.deepEqual(out.passages.map((p) => p.id), ['precedent:precedent/x/SSA.docx:p1:12', 'precedent:precedent/x/SSA.docx:p1:3'], 'a paragraph is its own passage, best fused score first');
  assert.equal(/^precedent:(.*):[^:]*:[^:]*$/.exec(out.passages[0].id)[1], 'precedent/x/SSA.docx', 'the file is read from the id as before');
  assert.equal(out.passages[0].label, 'SSA.docx, cl. 7.2');
  await retrieve({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false });
  assert.equal(asked, 1, 'the rewrite is cached per question');
  assert.equal(voyage.requests.filter((r) => r.url.endsWith('/embeddings')).length, 2, 'so are the embeddings');
  // A project question and a pasted document are not rewritten.
  await retrieve({ supabase, voyageKey: 'v', anthropicJson, query: 'concession period', scope: 'project', matterId: 'm1', fetchImpl: voyage.fetchImpl, rerank: false });
  await retrieve({ supabase, voyageKey: 'v', anthropicJson, query: 'x '.repeat(700), scope: 'statute', fetchImpl: voyage.fetchImpl, rerank: false });
  assert.equal(asked, 1);
});

test('with the embedding service down the search still runs on words; statute passages are labelled with their section', async () => {
  const supabase = fakeSupabase({
    rpc: {
      search_passages: (args) => {
        assert.equal(args.query_embedding, null);
        assert.equal(args.scope, 'statute');
        return { data: [{ ...row('s1'), heading_path: 'Chapter VI › 74. Compensation for breach of contract where penalty stipulated for', metadata: { act_name: 'Contract Act, 1872', source_url: 'https://pakistancode.gov.pk/x' }, content: '74. When a contract has been broken...' }], error: null };
      },
    },
  });
  const voyage = fakeVoyage({ embedFails: true });
  const out = await retrieve({ supabase, voyageKey: 'v', query: 'is a penalty clause enforceable', scope: 'statute', k: 4, fetchImpl: voyage.fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'Contract Act, 1872, s.74');
  assert.equal(out[0].section, '74');
  assert.equal(out[0].url, 'https://pakistancode.gov.pk/x');
});

test('a long passage is shown as its best window, and a search candidate keeps its file for the cap', () => {
  const filler = 'Lorem ipsum dolor sit amet. '.repeat(300);
  const content = `${filler} The concession period is twenty-five (25) years. ${filler}`;
  const shown = passageText(content, 'concession period');
  assert.ok(content.length > MAX_TEXT && shown.text.length <= 3000);
  assert.match(shown.text, /concession period is twenty-five/);
  assert.equal(passageText('Short passage.', 'x').text, 'Short passage.');
  const c = toCandidate({ id: 'x', content, metadata: { storage_path: 'p/x.pdf' }, document_version_id: 'v9', rrf_score: 0.01 }, 'project');
  assert.equal(c.fileKey, 'v9');
  assert.equal(toCandidate({ id: 'y', metadata: { act_name: 'Stamp Act, 1899' } }, 'statute').fileKey, 'Stamp Act, 1899');
});

// ------------------------------------------------------------ speed: what runs at once

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A promise resolved from outside.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// search_passages answering after `delay` ms, counting how many are in flight at once.
function slowSearch(delay, rowsFor = () => []) {
  const state = { inFlight: 0, maxInFlight: 0, texts: [] };
  const supabase = fakeSupabase({
    rpc: {
      search_passages: async (args) => {
        state.texts.push(args.query_text);
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        await sleep(delay);
        state.inFlight--;
        return { data: rowsFor(args), error: null };
      },
    },
  });
  return { supabase, state };
}

const precedentRow = (id, text, rrf) => ({ ...row(id), metadata: { storage_path: `precedent/${id}.docx`, filename: `${id}.docx`, passage_ordinal: 1 }, content: text, rrf_score: rrf });

test('the question as asked is embedded and searched while the rewrite is still being written', async () => {
  const reply = deferred();
  const anthropicJson = () => reply.promise;
  const { supabase, state } = slowSearch(5, (args) => [precedentRow(args.query_text.replace(/\W+/g, '-'), `${args.query_text} clause`, 0.01)]);
  const voyage = fakeVoyage();
  const q = 'tag along where a shareholder sells to a third party';
  const running = retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', k: 5, fetchImpl: voyage.fetchImpl, rerank: false });
  await sleep(30);
  // The rewrite has not answered, yet the question has been embedded and searched.
  assert.deepEqual(voyage.requests.filter((r) => r.url.endsWith('/embeddings')).map((r) => r.body.input), [[q]]);
  assert.deepEqual(state.texts, [q]);
  reply.resolve({ content: [{ type: 'text', text: '["tag-along right", "entitled to sell on the same terms"]' }] });
  const out = await running;
  assert.deepEqual(out.phrasings, [q, 'tag-along right', 'entitled to sell on the same terms']);
  assert.equal(out.rewriteLate, false);
  assert.deepEqual(state.texts, [q, 'tag-along right', 'entitled to sell on the same terms']);
  assert.equal(out.passages.length, 3);
});

test('the phrasings are searched all at once, with the question\'s own search still running', async () => {
  const anthropicJson = async () => ({ content: [{ type: 'text', text: '["drag-along right", "compel the minority to sell", "drag along notice"]' }] });
  const { supabase, state } = slowSearch(60);
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: 'example of a drag along clause', scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false });
  assert.equal(out.phrasings.length, 4);
  assert.equal(state.texts.length, 4);
  assert.equal(state.maxInFlight, 4, 'no phrasing waits for another');
});

test('a rewrite that has not come within the wait is not waited for, and is used the next time once it comes', async () => {
  let asked = 0;
  const anthropicJson = async () => {
    asked++;
    await sleep(150);
    return { content: [{ type: 'text', text: '["liquidated damages", "pre-estimate of loss"]' }] };
  };
  const { supabase, state } = slowSearch(1);
  const voyage = fakeVoyage();
  const q = 'is an LD clause a penalty';
  const t0 = Date.now();
  const first = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false, rewriteWaitMs: 40, timings: true });
  const took = Date.now() - t0;
  assert.ok(took < 140, `the search did not wait for the rewrite (${took} ms)`);
  assert.equal(first.rewriteLate, true);
  assert.deepEqual(first.phrasings, [q]);
  assert.deepEqual(state.texts, [q]);
  assert.ok(first.timings.events.some((e) => e.stage === 'rewrite not waited for'));
  // The late rewrite finishes in the background and is kept for this question.
  await sleep(200);
  const second = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false, rewriteWaitMs: 40 });
  assert.equal(asked, 1, 'asked once');
  assert.deepEqual(second.phrasings, [q, 'liquidated damages', 'pre-estimate of loss']);
  assert.equal(second.rewriteLate, false);
});

test('a failed rewrite or a failed phrasing embedding leaves the question\'s own search standing', async () => {
  const anthropicJson = async () => { throw new Error('overloaded'); };
  const { supabase, state } = slowSearch(1, () => [precedentRow('a', 'Clause 9 Transfers', 0.02)]);
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: 'lock-in period', scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false });
  assert.deepEqual(out.phrasings, ['lock-in period']);
  assert.equal(state.texts.length, 1);
  assert.equal(out.passages.length, 1);
  // The phrasings came but their embedding failed: they are searched by their words.
  clearRetrieveCaches();
  const rewrite = async () => ({ content: [{ type: 'text', text: '["restriction on transfer"]' }] });
  let embeds = 0;
  const flaky = async (url, init) => (url.endsWith('/embeddings') && ++embeds === 2 ? json({ error: 'down' }, 503) : voyage.fetchImpl(url, init));
  const { supabase: sb2, state: s2 } = slowSearch(1);
  const embeddings = [];
  sb2.rpc = ((orig) => (name, args) => { embeddings.push(args.query_embedding); return orig(name, args); })(sb2.rpc);
  const out2 = await retrieveDetailed({ supabase: sb2, voyageKey: 'v', anthropicJson: rewrite, query: 'lock-in period', scope: 'precedent', fetchImpl: flaky, rerank: false });
  assert.deepEqual(out2.phrasings, ['lock-in period', 'restriction on transfer']);
  assert.deepEqual(s2.texts, ['lock-in period', 'restriction on transfer']);
  assert.deepEqual(embeddings, [[1, 0, 0], null]);
});

test('the reranker reads at most 20 passages, each by its ~1,500 characters around the question\'s words', async () => {
  const filler = 'The parties record their understanding of the general matters set out here. ';
  const rows = Array.from({ length: 30 }, (_, i) => ({
    ...row(`s${i}`),
    metadata: { act_name: `Act ${i}, 2000` },
    content: `Entry ${i}. ${filler.repeat(40)}The penalty stipulated for breach is reasonable compensation. ${filler.repeat(40)}`,
    rrf_score: 1 / (61 + i),
  }));
  const supabase = fakeSupabase({ rpc: { search_passages: { data: rows, error: null } } });
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'penalty stipulated for breach', scope: 'statute', k: 8, fetchImpl: voyage.fetchImpl, rewrite: false });
  const rr = voyage.requests.find((r) => r.url.endsWith('/rerank'));
  assert.equal(RERANK_POOL, 20);
  assert.equal(rr.body.documents.length, 20);
  for (const d of rr.body.documents) {
    const body = d.split('\n\n').slice(1).join('\n\n');
    assert.ok(body.length <= RERANK_CHARS, `${body.length} characters sent`);
    assert.match(body, /penalty stipulated for breach/, 'the part of the passage that answers is what is sent');
  }
  assert.equal(out.passages.length, 8);
  assert.ok(out.passages[0].text.length > RERANK_CHARS, 'the passage itself is not cut');
  // Both can be set per call.
  clearRetrieveCaches();
  const v2 = fakeVoyage();
  await retrieveDetailed({ supabase, voyageKey: 'v', query: 'penalty stipulated for breach', scope: 'statute', k: 8, fetchImpl: v2.fetchImpl, rewrite: false, rerankPool: 30, rerankChars: 8000 });
  const rr2 = v2.requests.find((r) => r.url.endsWith('/rerank'));
  assert.equal(rr2.body.documents.length, 30);
  assert.ok(rr2.body.documents[0].length > RERANK_CHARS);
});

test('rerankText keeps a short passage whole and cuts a long one around its anchor', () => {
  assert.equal(rerankText({ text: 'short' }, 1500), 'short');
  const text = `${'a '.repeat(2000)}ANCHOR here ${'b '.repeat(2000)}`;
  const cut = rerankText({ text, anchorText: 'ANCHOR here' }, 300);
  assert.ok(cut.length <= 300 && cut.includes('ANCHOR here'));
  assert.ok(!cut.startsWith(' ') && !cut.endsWith(' '));
  assert.equal(rerankText({ text }, 100), text.slice(0, 100).trimEnd(), 'no anchor: the start');
  // With the question's words: where they cluster, wherever the anchor is.
  const para = `14.1 General. ${'The Contractor shall perform the Works with due care. '.repeat(40)}14.2 The Employer may terminate this Contract for convenience at any time by notice.`;
  const best = rerankText({ text: para, anchorText: para.slice(0, 200) }, 600, ['terminate for convenience']);
  assert.ok(best.length <= 600);
  assert.match(best, /terminate this Contract for convenience/);
});

// A Supabase stub for statute placement: documents rows by Act name, each
// read taking `delay` ms; counts reads per Act and reads in flight at once.
function actLibrary(acts, delay) {
  const reads = { byAct: {}, inFlight: 0, maxInFlight: 0 };
  const supabase = fakeSupabase();
  supabase.from = (table) => {
    const filters = {};
    const q = {};
    for (const m of ['select', 'order', 'range', 'limit', 'in', 'ilike']) q[m] = () => q;
    q.eq = (col, val) => { filters[col] = val; return q; };
    q.then = (ok, bad) => (async () => {
      const name = filters['metadata->>act_name'];
      if (table !== 'documents' || !name) return { data: [], error: null };
      reads.byAct[name] = (reads.byAct[name] ?? 0) + 1;
      reads.inFlight++;
      reads.maxInFlight = Math.max(reads.maxInFlight, reads.inFlight);
      await sleep(delay);
      reads.inFlight--;
      return { data: acts[name] ? [{ id: `${name}-0`, content: acts[name], metadata: { act_name: name, chunk_index: 0 } }] : [], error: null };
    })().then(ok, bad);
    return q;
  };
  return { supabase, reads };
}

test('statute passages are placed in their sections with their Acts read at once, and an Act is not read twice', async () => {
  const contract = '1. Short title.—This Act may be called the Contract Act. 2. Interpretation.—In this Act words have their meaning. 73. Compensation for loss or damage caused by breach of contract.—When a contract has been broken, the party who suffers is entitled to compensation. 74. Compensation for breach of contract where penalty stipulated for.—When a sum is named in the contract as the amount to be paid in case of breach, the party complaining is entitled to reasonable compensation not exceeding the amount so named.';
  const sale = '1. Short title.—This Act may be called the Sale of Goods Act. 2. Definitions.—In this Act goods means movable property. 55. Suit for price.—Where under a contract of sale the property in the goods has passed to the buyer and he wrongfully neglects to pay, the seller may sue him for the price.';
  const { supabase, reads } = actLibrary({ 'Contract Act, 1872': contract, 'Sale of Goods Act, 1930': sale }, 40);
  supabase.rpc = async (name) => (name === 'search_passages' ? {
    data: [
      { ...row('c74'), metadata: { act_name: 'Contract Act, 1872' }, content: contract.slice(contract.indexOf('74. Compensation')), rrf_score: 0.03 },
      { ...row('s55'), metadata: { act_name: 'Sale of Goods Act, 1930' }, content: sale.slice(sale.indexOf('55. Suit')), rrf_score: 0.02 },
    ],
    error: null,
  } : { data: [], error: null });
  const voyage = fakeVoyage();
  const got = await retrieve({ supabase, voyageKey: 'v', query: 'penalty stipulated for breach', scope: 'statute', fetchImpl: voyage.fetchImpl, rewrite: false, timings: true });
  const bySection = Object.fromEntries(got.passages.map((p) => [p.act_name, p.label]));
  assert.equal(bySection['Contract Act, 1872'], 'Contract Act, 1872, s.74');
  assert.equal(bySection['Sale of Goods Act, 1930'], 'Sale of Goods Act, 1930, s.55');
  assert.equal(reads.maxInFlight, 2, 'the two Acts are read at once');
  assert.deepEqual(reads.byAct, { 'Contract Act, 1872': 1, 'Sale of Goods Act, 1930': 1 }, 'read early and placed from the same read');
  const stages = new Set(got.timings.events.map((e) => e.stage));
  for (const s of ['embed', 'search', 'windows and labels', 'prefetch: act text', 'rerank', 'place']) assert.ok(stages.has(s), `timed: ${s}`);
  assert.ok(got.timings.total >= 40);
  // The next search finds both Acts already rebuilt.
  clearRetrieveCaches();
  await retrieve({ supabase, voyageKey: 'v', query: 'penalty stipulated for breach', scope: 'statute', fetchImpl: voyage.fetchImpl, rewrite: false });
  assert.deepEqual(reads.byAct, { 'Contract Act, 1872': 1, 'Sale of Goods Act, 1930': 1 });
});

test('a section the question names is read alongside the search, not after it', async () => {
  const contract = '1. Short title.—This Act may be called the Contract Act. 73. Compensation for loss or damage caused by breach of contract.—When a contract has been broken, the party who suffers is entitled to compensation. 74. Compensation for breach of contract where penalty stipulated for.—When a sum is named in the contract as the amount to be paid in case of breach, the party complaining is entitled to reasonable compensation.';
  const { supabase } = actLibrary({ 'Contract Act, 1872': contract }, 60);
  const fromTable = supabase.from;
  supabase.from = (table) => {
    const q = fromTable(table);
    // listActs reads every statute row's Act name.
    const plainThen = q.then;
    let selected = '';
    const sel = q.select;
    q.select = (cols) => { selected = String(cols); sel(cols); return q; };
    q.then = (ok, bad) => (selected.startsWith('act_name') ? Promise.resolve({ data: [{ act_name: 'Contract Act, 1872' }], error: null }).then(ok, bad) : plainThen(ok, bad));
    return q;
  };
  let searchStartedAt = null;
  const t0 = Date.now();
  supabase.rpc = async (name) => {
    if (name === 'search_passages') {
      searchStartedAt = Date.now() - t0;
      await sleep(60);
      return { data: [{ ...row('c73'), metadata: { act_name: 'Contract Act, 1872' }, content: contract.slice(contract.indexOf('73. Compensation')), rrf_score: 0.03 }], error: null };
    }
    return { data: [], error: null };
  };
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'contract act 1872 section 74 penalty', scope: 'statute', actNames: ['Contract Act, 1872'], fetchImpl: voyage.fetchImpl, timings: true });
  assert.equal(out.passages[0].lead, true);
  assert.equal(out.passages[0].section, '74');
  assert.equal(out.passages[1].label, 'Contract Act, 1872, s.73');
  const lead = out.timings.events.find((e) => e.stage === 'section lead');
  const search = out.timings.events.find((e) => e.stage === 'search');
  assert.ok(lead.start <= search.start + search.ms, 'the section was being read before the search had finished');
  assert.ok(out.timings.total < 60 * 3 + 60, `${out.timings.total} ms: the section read overlapped the search`);
  assert.ok(searchStartedAt !== null);
});

test('the stopwatch records each stage\'s start and length, failures included', async () => {
  let t = 0;
  const clock = stopwatch(() => t);
  t = 5;
  await clock.time('a', async () => { t = 12; return [1, 2]; }, { phrasing: 0 }, (r) => ({ rows: r.length }));
  await assert.rejects(clock.time('b', async () => { t = 20; throw new Error('down'); }, { phrasing: 1 }));
  clock.timeSync('c', () => { t = 21; });
  clock.note('d');
  assert.deepEqual(clock.events, [
    { stage: 'a', start: 5, ms: 7, phrasing: 0, rows: 2 },
    { stage: 'b', start: 12, ms: 8, phrasing: 1, error: 'down' },
    { stage: 'c', start: 20, ms: 1 },
    { stage: 'd', start: 21, ms: 0 },
  ]);
  assert.equal(clock.elapsed(), 21);
});

test('without timings retrieve returns the passages alone, as every caller expects', async () => {
  const supabase = fakeSupabase({ rpc: { search_passages: { data: [row('a')], error: null } } });
  const voyage = fakeVoyage();
  const plain = await retrieve({ supabase, voyageKey: 'v', query: 'concession period', scope: 'project', matterId: 'm1', fetchImpl: voyage.fetchImpl });
  assert.ok(Array.isArray(plain));
  const timed = await retrieve({ supabase, voyageKey: 'v', query: 'concession period', scope: 'project', matterId: 'm1', fetchImpl: voyage.fetchImpl, timings: true });
  assert.ok(Array.isArray(timed.passages) && timed.passages.length === 1);
  assert.equal(timed.timings.scope, 'project');
  assert.ok(timed.timings.events.find((e) => e.stage === 'search' && e.phrasing === 0 && e.rows === 1));
});
