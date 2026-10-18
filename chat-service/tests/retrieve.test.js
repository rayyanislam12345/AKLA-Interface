// The one search (retrieve.js), without the network: fusion and the per-file
// cap, citation labels, the switch to match_documents when the hybrid search
// is not in the database, and the fused order standing when the reranker
// fails. The database and the Voyage and model services are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retrieve, retrieveDetailed, fuseLists, capPerFile, dedupeByText, buildLabel, shortHeading, sectionFromHeading, clauseOf,
  keywordText, isMissingFunction, namedAct, rrfOf, toCandidate, rerankPassages, passageText, clearRetrieveCaches, MAX_TEXT,
  rerankText, stopwatch, RERANK_POOL, RERANK_CHARS, rewriteWorthwhile, FALLBACK_GRACE_MS, MAX_SEARCH_CALLS, searchCallLoad, CALL_MIN_MS, TIMEOUT_HEADER,
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

test('a project search: one embedding call, the hybrid search scoped to the project and current versions, labelled; two passages for five places are not reranked', async () => {
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
  assert.equal(out.reranked, false);
  assert.match(out.rerankSkipped, /2 passages for 5 places/);
  assert.equal(out.voyageCalls, 1, 'the embedding, and no rerank');
  const embeds = voyage.requests.filter((r) => r.url.endsWith('/embeddings'));
  assert.equal(embeds.length, 1);
  assert.deepEqual(embeds[0].body.input, ['what is the concession period']);
  assert.equal(embeds[0].body.input_type, 'query');
  const searches = supabase.calls.filter((c) => c.name === 'search_passages');
  const call = searches.find((c) => c.args.query_embedding);
  assert.deepEqual(Object.keys(call.args).sort(), ['act_names', 'all_versions', 'document_type_id', 'exclude_document_id', 'k', 'matter_id', 'max_ms', 'phrasings', 'query_embedding', 'query_text', 'scope'].sort());
  assert.equal(call.args.scope, 'project');
  assert.equal(call.args.matter_id, 'm1');
  assert.equal(call.args.all_versions, false);
  assert.deepEqual(call.args.query_embedding, [1, 0, 0]);
  assert.equal(call.args.phrasings, null, 'a project question has no phrasings');
  assert.ok(call.args.max_ms >= CALL_MIN_MS && call.args.max_ms <= 12_000, `the call's budget is what is left of the default deadline (${call.args.max_ms})`);
  // Under the default deadline the question is also searched by its words
  // alone from the start, with no embedding, in case the embedding is slow.
  const words = searches.find((c) => c.args.query_embedding === null);
  assert.ok(words, 'the words-only search was started');
  assert.equal(words.args.query_text, 'what is the concession period');
  assert.equal(words.args.matter_id, 'm1');
  assert.ok(words.args.max_ms >= CALL_MIN_MS && words.args.max_ms <= 12_000);
  assert.equal(searches.length, 2, 'two calls, nothing else');
  assert.equal(voyage.requests.filter((r) => r.url.endsWith('/rerank')).length, 0);
  // The fused order, the fused score as the similarity.
  assert.deepEqual(out.passages.map((p) => p.id), ['a', 'b']);
  assert.equal(out.path, 'full');
  assert.equal(out.passages[0].label, 'Term Sheet v3, 4. Term › 4.2 Concession Period');
  assert.equal(out.passages[0].similarity, Math.round((2 / 61) * 1e6) / 1e6);
  assert.equal(out.passages[0].storage_path, 'm/d/a.docx');
  assert.equal(out.passages[1].label, 'Transaction Structure Report v1, p. 7');
  // A project search outside a project finds nothing and asks nothing.
  assert.deepEqual(await retrieve({ supabase, voyageKey: 'v', query: 'x y', scope: 'project', fetchImpl: voyage.fetchImpl }), []);
});

const precRow = (id, rrf, over = {}) => ({ ...row(id), metadata: { storage_path: `precedent/${id}.docx`, filename: `${id}.docx` }, content: `${id}: the concession period is thirty years.`, rrf_score: rrf, ...over });

test('a search with more passages than places is reranked against the question: each passage by its label and text, the best k kept', async () => {
  const supabase = fakeSupabase({ rpc: { search_passages: { data: [precRow('a', 0.03, { heading_path: '4. Term › 4.2 Concession Period' }), precRow('b', 0.02), precRow('c', 0.01)], error: null } } });
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'concession period', scope: 'precedent', k: 2, fetchImpl: voyage.fetchImpl, rewrite: false });
  assert.equal(out.reranked, true);
  assert.equal(out.rerankSkipped, null);
  assert.equal(out.voyageCalls, 2, 'one embedding call, one rerank');
  const rerank = voyage.requests.find((r) => r.url.endsWith('/rerank'));
  assert.equal(rerank.body.model, 'rerank-2');
  assert.equal(rerank.body.query, 'concession period');
  assert.equal(rerank.body.top_k, 2);
  assert.equal(rerank.body.documents.length, 3);
  assert.match(rerank.body.documents[0], /^a\.docx, 4. Term › 4.2 Concession Period\n\na: the concession period/);
  // The stub reranker reverses the order.
  assert.deepEqual(out.passages.map((p) => p.id), ['c', 'b']);
  assert.equal(out.passages[0].similarity, 0.9);
});

test('when the reranker fails, the fused order stands and the fused score is the similarity', async () => {
  const supabase = fakeSupabase({ rpc: { search_passages: { data: [precRow('a', 0.03), precRow('b', 0.02), precRow('c', 0.01)], error: null } } });
  for (const failing of [() => json({ detail: 'overloaded' }, 529), () => json({ data: [] }), () => { throw new Error('socket hang up'); }]) {
    clearRetrieveCaches();
    const voyage = fakeVoyage({ rerank: failing });
    const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'concession period', scope: 'precedent', k: 2, fetchImpl: voyage.fetchImpl, rewrite: false });
    assert.equal(voyage.requests.filter((r) => r.url.endsWith('/rerank')).length, 1, 'the reranker was asked');
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
  // For the next minute the missing function is not asked for again: the
  // first search asked at most four times (the words-only call and the
  // full one start before either has seen the error, and each is tried
  // once more without the phrasings in case the database holds the 18 Oct
  // function), the second not at all.
  const asked = supabase.calls.filter((c) => c.name === 'search_passages').length;
  assert.ok(asked >= 1 && asked <= 4, `${asked} calls`);
  assert.equal(supabase.calls.filter((c) => c.name === 'search_passages').length, asked);
  // A real failure is not mistaken for a missing function. A call given a
  // time budget (under a deadline) is not tried again after a statement
  // timeout: its budget is spent; one without is tried once more.
  clearRetrieveCaches();
  const broken = fakeSupabase({ rpc: { search_passages: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } } });
  await assert.rejects(retrieve({ supabase: broken, voyageKey: 'v', query: 'term', scope: 'project', matterId: 'm1', fetchImpl: voyage.fetchImpl }), /statement timeout/);
  assert.equal(broken.calls.filter((c) => c.name === 'search_passages' && c.args.query_embedding).length, 1, 'under a deadline, once');
  assert.equal(broken.calls.filter((c) => c.name === 'search_passages' && c.args.query_embedding === null).length, 1, 'the words-only call likewise');
  clearRetrieveCaches();
  broken.calls.length = 0;
  await assert.rejects(retrieve({ supabase: broken, voyageKey: 'v', query: 'term', scope: 'project', matterId: 'm1', fetchImpl: voyage.fetchImpl, deadlineMs: 0 }), /statement timeout/);
  assert.equal(broken.calls.filter((c) => c.name === 'search_passages' && c.args.query_embedding).length, 2, 'with no deadline (no budget), a timeout is tried once more');
  assert.equal(broken.calls.filter((c) => c.name === 'search_passages' && c.args.query_embedding === null).length, 0, 'and no words-only call is made');
});

test('with the 18 Oct function still in the database (no phrasings, no max_ms), the same calls go without them, the question alone, for an hour', async () => {
  const seen = [];
  const supabase = fakeSupabase({
    rpc: {
      search_passages: (args) => {
        seen.push(args);
        if ('phrasings' in args || 'max_ms' in args) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.search_passages(act_names, all_versions, document_type_id, exclude_document_id, k, matter_id, max_ms, phrasings, query_embedding, query_text, scope) in the schema cache' } };
        return { data: [precRow('a', 0.03)], error: null };
      },
    },
  });
  const voyage = fakeVoyage();
  const anthropicJson = async () => ({ content: [{ type: 'text', text: '["drag-along right"]' }] });
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: 'example of a drag along clause', scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false, deadlineMs: 0 });
  assert.equal(out.engine, 'hybrid');
  assert.equal(out.path, 'full');
  assert.deepEqual(out.passages.map((p) => p.id), ['a']);
  assert.deepEqual(seen.map((a) => 'phrasings' in a), [true, false], 'tried with the phrasings, then without');
  assert.equal(supabase.calls.filter((c) => c.name === 'match_documents').length, 0, 'match_documents was not needed');
  // The next search knows, and sends the old shape at once.
  seen.length = 0;
  await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: 'lock-in period for the sponsors', scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false, deadlineMs: 0 });
  assert.deepEqual(seen.map((a) => 'phrasings' in a), [false]);
});

test('a precedent question is rewritten once into legal phrasings, which travel inside the one full call, fused in the database', async () => {
  let asked = 0;
  const anthropicJson = async (body) => {
    asked++;
    assert.match(body.system, /precedent agreements/);
    return { content: [{ type: 'text', text: '["tag-along right", "shall be entitled to sell its shares on the same terms"]' }] };
  };
  const supabase = fakeSupabase({
    rpc: {
      // The database fuses the phrasings' legs: the call carrying them
      // answers with the tag-along paragraph first.
      search_passages: (args) => ({
        data: [
          ...(args.phrasings?.some((p) => p.text === 'tag-along right')
            ? [{ ...row('p1'), metadata: { storage_path: 'precedent/x/SSA.docx', filename: 'SSA.docx', passage_ordinal: 12 }, content: '7.2 Tag-Along. If the Majority sells...', rrf_score: 2 / 61 }]
            : []),
          { ...row('p1'), metadata: { storage_path: 'precedent/x/SSA.docx', filename: 'SSA.docx', passage_ordinal: 3 }, content: '1. Definitions', rrf_score: 1 / 70 },
        ],
        error: null,
      }),
    },
  });
  const voyage = fakeVoyage();
  const q = 'tag along where a shareholder sells to a third party';
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', k: 5, fetchImpl: voyage.fetchImpl, rerank: false });
  assert.deepEqual(out.phrasings, [q, 'tag-along right', 'shall be entitled to sell its shares on the same terms']);
  const full = supabase.calls.filter((c) => c.name === 'search_passages' && c.args.query_embedding);
  assert.equal(full.length, 1, 'one call with an embedding: the question and its phrasings together');
  assert.equal(full[0].args.query_text, q);
  assert.deepEqual(full[0].args.query_embedding, [1, 0, 0]);
  assert.deepEqual(full[0].args.phrasings, [
    { text: 'tag-along right', embedding: [2, 0, 0] },
    { text: 'shall be entitled to sell its shares on the same terms', embedding: [3, 0, 0] },
  ], 'each phrasing with its own embedding, inside the call');
  const words = supabase.calls.filter((c) => c.name === 'search_passages' && c.args.query_embedding === null);
  assert.equal(words.length, 1, 'and the question by words alone');
  assert.equal(words[0].args.phrasings, null, 'the words-only call carries no phrasings: it goes before the rewrite');
  const embeds = voyage.requests.filter((r) => r.url.endsWith('/embeddings'));
  assert.equal(embeds.length, 1, 'one embedding call: the question and its phrasings together');
  assert.deepEqual(embeds[0].body.input, [q, 'tag-along right', 'shall be entitled to sell its shares on the same terms']);
  assert.equal(out.voyageCalls, 1);
  assert.deepEqual(out.passages.map((p) => p.id), ['precedent:precedent/x/SSA.docx:p1:12', 'precedent:precedent/x/SSA.docx:p1:3'], 'a paragraph is its own passage, best fused score first');
  assert.equal(/^precedent:(.*):[^:]*:[^:]*$/.exec(out.passages[0].id)[1], 'precedent/x/SSA.docx', 'the file is read from the id as before');
  assert.equal(out.passages[0].label, 'SSA.docx, cl. 7.2');
  const again = await retrieve({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false, timings: true });
  assert.equal(asked, 1, 'the rewrite is cached per question');
  assert.equal(voyage.requests.filter((r) => r.url.endsWith('/embeddings')).length, 1, 'so are the embeddings');
  assert.equal(again.timings.voyageCalls, 0);
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

// search_passages answering after `delay` ms, counting how many are in flight
// at once. `texts`: the queries searched with an embedding (the question;
// its phrasings travel inside that call, `calls` keeps every call's
// arguments); `wordsOnly`: those searched by words alone (the words-only
// search every deadline-bound search starts at once, and any search whose
// embedding failed).
function slowSearch(delay, rowsFor = () => []) {
  const state = { inFlight: 0, maxInFlight: 0, texts: [], wordsOnly: [], calls: [] };
  const supabase = fakeSupabase({
    rpc: {
      search_passages: async (args) => {
        state.calls.push(args);
        (args.query_embedding ? state.texts : state.wordsOnly).push(args.query_text);
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

test('the question waits for the rewrite and is embedded with its phrasings in one call; a question already embedded costs no new embedding call, and its phrasings still go inside the one full call', async () => {
  const reply = deferred();
  const anthropicJson = () => reply.promise;
  const { supabase, state } = slowSearch(5, (args) => [precedentRow(args.query_text.replace(/\W+/g, '-'), `${args.query_text} clause`, 0.01), ...(args.phrasings ?? []).map((p) => precedentRow(p.text.replace(/\W+/g, '-'), `${p.text} clause`, 0.009))]);
  const voyage = fakeVoyage();
  const q = 'tag along where a shareholder sells to a third party';
  const running = retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', k: 5, fetchImpl: voyage.fetchImpl, rerank: false });
  await sleep(30);
  // The rewrite has not answered: nothing embedded, nothing searched with an
  // embedding yet; only the words-only search, which needs none, has started.
  assert.equal(voyage.requests.length, 0);
  assert.deepEqual(state.texts, []);
  assert.deepEqual(state.wordsOnly, [q]);
  reply.resolve({ content: [{ type: 'text', text: '["tag-along right", "entitled to sell on the same terms"]' }] });
  const out = await running;
  assert.deepEqual(voyage.requests.map((r) => r.body.input), [[q, 'tag-along right', 'entitled to sell on the same terms']]);
  assert.deepEqual(out.phrasings, [q, 'tag-along right', 'entitled to sell on the same terms']);
  assert.equal(out.rewriteLate, false);
  assert.deepEqual(state.texts, [q], 'one call with an embedding');
  assert.deepEqual(state.calls.find((c) => c.query_embedding).phrasings.map((p) => p.text), ['tag-along right', 'entitled to sell on the same terms'], 'the phrasings inside it');
  assert.equal(state.calls.length, 2, 'two calls, nothing else');
  assert.equal(out.passages.length, 3, 'the full call\'s rows; the words-only search is not merged into it');

  // The same question in another scope (the chat searches all three at
  // once): its embedding is kept, so the one embedding call carries the
  // phrasings alone, and the full call still waits for them.
  const statuteReply = deferred();
  const { supabase: sb2, state: s2 } = slowSearch(5);
  const second = retrieveDetailed({ supabase: sb2, voyageKey: 'v', anthropicJson: () => statuteReply.promise, query: q, scope: 'statute', fetchImpl: voyage.fetchImpl, rerank: false });
  await sleep(30);
  assert.deepEqual(s2.texts, [], 'the full call waits for the rewrite');
  assert.deepEqual(s2.wordsOnly, [q], 'the words-only call does not');
  assert.equal(voyage.requests.length, 1, 'no new embedding call yet');
  statuteReply.resolve({ content: [{ type: 'text', text: '["right of co-sale"]' }] });
  const out2 = await second;
  assert.deepEqual(voyage.requests.map((r) => r.body.input)[1], ['right of co-sale'], 'the phrasing alone is embedded: the question was kept');
  assert.equal(out2.voyageCalls, 1);
  assert.deepEqual(s2.texts, [q]);
  assert.deepEqual(s2.calls.find((c) => c.query_embedding).phrasings, [{ text: 'right of co-sale', embedding: [1, 0, 0] }], 'the phrasing, with the embedding its own call gave it');
  assert.equal(s2.calls.length, 2);
});

test('a scope is searched in at most two database calls — one by words before the embedding, one after it carrying the embedding and every phrasing — each with its budget and the statement timeout header; none by words when there is no deadline', async () => {
  const anthropicJson = async () => ({ content: [{ type: 'text', text: '["drag-along right", "compel the minority to sell", "drag along notice"]' }] });
  const { supabase, state } = slowSearch(60);
  // The calls as supabase-js builds them: abortSignal() and setHeader()
  // chain, then the call answers.
  const headers = [];
  const plainRpc = supabase.rpc;
  supabase.rpc = (name, args) => {
    const sent = {};
    const b = {
      abortSignal: () => b,
      setHeader: (h, v) => { sent[h] = v; return b; },
      then: (ok, bad) => plainRpc(name, args).then((r) => { headers.push({ args, sent }); return r; }).then(ok, bad),
    };
    return b;
  };
  const voyage = fakeVoyage();
  const embedding = deferred();
  const fetchImpl = async (url, init) => (url.endsWith('/embeddings') ? embedding.promise.then(() => voyage.fetchImpl(url, init)) : voyage.fetchImpl(url, init));
  const q = 'example of a drag along clause';
  const running = retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', fetchImpl, rerank: false, deadlineMs: 3000, timings: true });
  await sleep(40);
  assert.deepEqual(state.calls.map((c) => c.query_text), [q], 'before the embedding: one call, by words');
  assert.equal(state.calls[0].query_embedding, null);
  assert.equal(state.calls[0].phrasings, null);
  assert.ok(state.calls[0].max_ms > 2900 && state.calls[0].max_ms <= 3000, `its budget is the whole deadline (${state.calls[0].max_ms})`);
  embedding.resolve();
  const out = await running;
  assert.equal(out.path, 'full');
  assert.equal(out.phrasings.length, 4);
  assert.equal(state.calls.length, 2, 'after the embedding: one more call, nothing else');
  const full = state.calls[1];
  assert.equal(full.query_text, q);
  assert.deepEqual(full.query_embedding, [1, 0, 0]);
  assert.deepEqual(full.phrasings, [
    { text: 'drag-along right', embedding: [2, 0, 0] },
    { text: 'compel the minority to sell', embedding: [3, 0, 0] },
    { text: 'drag along notice', embedding: [4, 0, 0] },
  ], 'every phrasing, with its embedding, inside the call');
  assert.ok(full.max_ms >= CALL_MIN_MS && full.max_ms < state.calls[0].max_ms, `what is left of the deadline (${full.max_ms})`);
  assert.equal(state.maxInFlight, 2);
  // The budget travels as the statement timeout header too, so PostgREST's
  // pre-request function can cancel the call in the database.
  assert.deepEqual(headers.map((h) => h.sent[TIMEOUT_HEADER]), [String(state.calls[0].max_ms), String(full.max_ms)]);
  const events = out.timings.events.filter((e) => e.stage === 'search' || e.stage === 'words only');
  assert.deepEqual(events.map((e) => [e.stage, e.phrasings, e.byWordsOnly]), [['words only', 0, true], ['search', 3, false]]);
  assert.ok(events.every((e) => e.maxMs >= CALL_MIN_MS), 'each event records its budget');

  // No deadline: no words-only call, no budget, no header; one call in all.
  clearRetrieveCaches();
  state.calls.length = 0;
  headers.length = 0;
  await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: q, scope: 'precedent', fetchImpl, rerank: false, deadlineMs: 0 });
  assert.equal(state.calls.length, 1);
  assert.ok(state.calls[0].query_embedding);
  assert.equal(state.calls[0].max_ms, null);
  assert.deepEqual(headers.map((h) => h.sent), [{}]);
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
  const lock = 'lock-in period for the sponsors';
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query: lock, scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false });
  assert.deepEqual(out.phrasings, [lock]);
  assert.equal(state.texts.length, 1);
  assert.equal(out.passages.length, 1);
  // The phrasings came but the one embedding call failed: everything is searched by its words.
  clearRetrieveCaches();
  const rewrite = async () => ({ content: [{ type: 'text', text: '["restriction on transfer"]' }] });
  const flaky = async (url, init) => (url.endsWith('/embeddings') ? json({ error: 'down' }, 503) : voyage.fetchImpl(url, init));
  const { supabase: sb2, state: s2 } = slowSearch(1);
  const embeddings = [];
  sb2.rpc = ((orig) => (name, args) => { embeddings.push(args.query_embedding); return orig(name, args); })(sb2.rpc);
  const out2 = await retrieveDetailed({ supabase: sb2, voyageKey: 'v', anthropicJson: rewrite, query: lock, scope: 'precedent', fetchImpl: flaky, rerank: false });
  assert.deepEqual(out2.phrasings, [lock, 'restriction on transfer']);
  assert.deepEqual(s2.texts, [], 'nothing was searched with an embedding');
  assert.deepEqual(s2.wordsOnly, [lock, lock], 'the words-only call, then the full call by words');
  assert.deepEqual(s2.calls.map((c) => c.phrasings), [null, [{ text: 'restriction on transfer', embedding: null }]], 'the phrasing travels in the full call, by its words');
  assert.deepEqual(embeddings, [null, null]);
  assert.equal(out2.fellBack, false, 'the full search finished on its own');
  assert.equal(out2.path, 'full');
  // With no phrasings and the embedding failed, the words-only call's rows
  // serve: no second call at all.
  clearRetrieveCaches();
  const { supabase: sb3, state: s3 } = slowSearch(1, () => [precedentRow('a', 'Clause 9 Transfers', 0.02)]);
  const out3 = await retrieveDetailed({ supabase: sb3, voyageKey: 'v', query: lock, scope: 'precedent', fetchImpl: flaky, rewrite: false, rerank: false, timings: true });
  assert.equal(s3.calls.length, 1, 'the words-only call alone');
  assert.equal(out3.path, 'full');
  assert.equal(out3.passages.length, 1);
  assert.ok(out3.timings.events.some((e) => e.stage === 'words only') && !out3.timings.events.some((e) => e.stage === 'search'));
});

test('the reranker reads 30 passages, each whole; both can be set per call', async () => {
  const filler = 'The parties record their understanding of the general matters set out here. ';
  const rows = Array.from({ length: 40 }, (_, i) => ({
    ...row(`s${i}`),
    metadata: { act_name: `Act ${i}, 2000` },
    content: `Entry ${i}. ${filler.repeat(20)}The penalty stipulated for breach is reasonable compensation. ${filler.repeat(20)}`,
    rrf_score: 1 / (61 + i),
  }));
  const supabase = fakeSupabase({ rpc: { search_passages: { data: rows, error: null } } });
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'penalty stipulated for breach', scope: 'statute', k: 8, fetchImpl: voyage.fetchImpl, rewrite: false });
  const rr = voyage.requests.find((r) => r.url.endsWith('/rerank'));
  assert.equal(RERANK_POOL, 30);
  assert.equal(RERANK_CHARS, 8000);
  assert.equal(rr.body.documents.length, 30);
  for (const [i, d] of rr.body.documents.entries()) {
    const body = d.split('\n\n').slice(1).join('\n\n');
    assert.ok(body.length > 3000 && body.startsWith('Entry ') && body.endsWith('here.'), `passage ${i} is sent whole (${body.length} characters)`);
  }
  assert.equal(out.passages.length, 8);
  // Both can be set per call: 20 passages, each by its ~1,500 characters around the question's words.
  clearRetrieveCaches();
  const v2 = fakeVoyage();
  await retrieveDetailed({ supabase, voyageKey: 'v', query: 'penalty stipulated for breach', scope: 'statute', k: 8, fetchImpl: v2.fetchImpl, rewrite: false, rerankPool: 20, rerankChars: 1500 });
  const rr2 = v2.requests.find((r) => r.url.endsWith('/rerank'));
  assert.equal(rr2.body.documents.length, 20);
  for (const d of rr2.body.documents) {
    const body = d.split('\n\n').slice(1).join('\n\n');
    assert.ok(body.length <= 1500, `${body.length} characters sent`);
    assert.match(body, /penalty stipulated for breach/, 'the part of the passage that answers is what is sent');
  }
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
  for (const s of ['embed', 'search', 'windows and labels', 'prefetch: act text', 'rerank skipped', 'place']) assert.ok(stages.has(s), `timed: ${s}`);
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
  assert.ok(timed.timings.events.find((e) => e.stage === 'search' && e.phrasings === 0 && e.rows === 1));
});

// ------------------------------------------- Voyage calls: fewer, and counted

test('a question that names a section, quotes exact words or is under four words is not rewritten', async () => {
  assert.equal(rewriteWorthwhile('is an LD clause a penalty'), true);
  assert.equal(rewriteWorthwhile('contract act s.74 penalty clause'), false);
  assert.equal(rewriteWorthwhile('what does rule 36 of the PPRA rules say'), false);
  assert.equal(rewriteWorthwhile('find "shall not be entitled to" in the EPC'), false);
  assert.equal(rewriteWorthwhile('clauses saying “fit for purpose” in EPC contracts'), false);
  assert.equal(rewriteWorthwhile('liquidated damages cap'), false);
  let asked = 0;
  const anthropicJson = async () => { asked++; return { content: [{ type: 'text', text: '["x y"]' }] }; };
  const supabase = fakeSupabase();
  const voyage = fakeVoyage();
  for (const query of ['liquidated damages cap', 'find "shall not be entitled to" in the EPC']) {
    const out = await retrieveDetailed({ supabase, voyageKey: 'v', anthropicJson, query, scope: 'precedent', fetchImpl: voyage.fetchImpl });
    assert.deepEqual(out.phrasings, [query]);
  }
  assert.equal(asked, 0);
});

test('a question asked again within the hour makes no Voyage call at all', async () => {
  const anthropicJson = async () => ({ content: [{ type: 'text', text: '["drag-along right"]' }] });
  const supabase = fakeSupabase({ rpc: { search_passages: { data: [precRow('a', 0.03), precRow('b', 0.02)], error: null } } });
  const voyage = fakeVoyage();
  const ask = () => retrieve({ supabase, voyageKey: 'v', anthropicJson, query: 'example of a drag along clause', scope: 'precedent', k: 5, fetchImpl: voyage.fetchImpl, timings: true });
  const first = await ask();
  assert.equal(first.timings.voyageCalls, 1, 'one embedding call; two passages for five places, no rerank');
  const second = await ask();
  assert.equal(second.timings.voyageCalls, 0);
  assert.equal(voyage.requests.length, 1);
  assert.deepEqual(second.passages.map((p) => p.id), first.passages.map((p) => p.id));
  assert.ok(second.timings.events.some((e) => e.stage === 'embed' && e.sent === 0));
  assert.ok(first.timings.events.some((e) => e.stage === 'embed' && e.sent === 2));
});

test('the embedding cache keeps the 500 used most recently', async () => {
  const supabase = fakeSupabase();
  const voyage = fakeVoyage();
  const ask = (query) => retrieveDetailed({ supabase, voyageKey: 'v', query, scope: 'precedent', fetchImpl: voyage.fetchImpl, rewrite: false });
  await ask('question number 0');
  for (let i = 1; i < 500; i++) await ask(`question number ${i}`);
  assert.equal((await ask('question number 0')).voyageCalls, 0, 'still kept, and now the most recently used');
  await ask('question number 500'); // the 501st: the least recently used (number 1) goes
  assert.equal((await ask('question number 0')).voyageCalls, 0);
  assert.equal((await ask('question number 1')).voyageCalls, 1);
});

test('the reranker is not called when it cannot change the result: no more passages than places, or a small project search', async () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => row(`r${i}`, { document_version_id: `v${i}`, rrf_score: 1 / (61 + i) }));
  const cases = [
    { scope: 'precedent', n: 8, k: 8, reranked: false },
    { scope: 'precedent', n: 9, k: 8, reranked: true },
    { scope: 'project', n: 16, k: 8, reranked: false },
    { scope: 'project', n: 17, k: 8, reranked: true },
  ];
  for (const c of cases) {
    clearRetrieveCaches();
    const data = c.scope === 'precedent' ? rows(c.n).map((r, i) => precRow(`r${i}`, r.rrf_score)) : rows(c.n);
    const supabase = fakeSupabase({ rpc: { search_passages: { data, error: null } } });
    const voyage = fakeVoyage();
    const out = await retrieve({ supabase, voyageKey: 'v', query: 'concession period', scope: c.scope, matterId: 'm1', k: c.k, fetchImpl: voyage.fetchImpl, rewrite: false, timings: true });
    const reranks = voyage.requests.filter((r) => r.url.endsWith('/rerank')).length;
    assert.equal(reranks, c.reranked ? 1 : 0, `${c.scope}, ${c.n} passages for ${c.k}`);
    assert.equal(out.timings.reranked, c.reranked);
    assert.equal(out.timings.voyageCalls, c.reranked ? 2 : 1);
    if (!c.reranked) assert.ok(out.timings.events.some((e) => e.stage === 'rerank skipped'));
    assert.equal(out.passages.length, Math.min(c.n, c.k));
  }
});

// ------------------------------------------------------------ the deadline

// A fetch that never answers until its signal aborts.
const hanging = (init) => new Promise((_, reject) => {
  const s = init?.signal;
  if (!s) return;
  if (s.aborted) reject(s.reason);
  s.addEventListener('abort', () => reject(s.reason ?? new Error('aborted')), { once: true });
});

// Collects unhandled rejections while fn runs (and for `settle` ms after).
async function noUnhandled(fn, settle = 120) {
  const seen = [];
  const onRejection = (err) => seen.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    const result = await fn();
    await sleep(settle);
    return { result, seen };
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

// fn's result and how long it took, on its own (noUnhandled's settle aside).
async function timed(fn) {
  const t0 = Date.now();
  const result = await fn();
  return { result, took: Date.now() - t0 };
}

const searchCalls = (supabase) => supabase.calls.filter((c) => c.name === 'search_passages');
const hybridCalls = (supabase) => searchCalls(supabase).filter((c) => c.args.query_embedding);
const wordsCalls = (supabase) => searchCalls(supabase).filter((c) => c.args.query_embedding === null);

// A statute library of `acts` (name → text) whose list and rows the stubbed
// client answers, each row read taking `delay` ms; `rpc` answers
// search_passages.
function statuteLibrary(acts, rpc, delay = 1) {
  const { supabase, reads } = actLibrary(acts, delay);
  const fromTable = supabase.from;
  supabase.from = (table) => {
    const q = fromTable(table);
    const plainThen = q.then;
    let selected = '';
    const sel = q.select;
    q.select = (cols) => { selected = String(cols); sel(cols); return q; };
    q.then = (ok, bad) => (selected.startsWith('act_name')
      ? Promise.resolve({ data: Object.keys(acts).map((act_name) => ({ act_name })), error: null }).then(ok, bad)
      : plainThen(ok, bad));
    return q;
  };
  supabase.rpc = async (name, args) => {
    supabase.calls.push({ name, args });
    return name === 'search_passages' ? rpc(args) : { data: [], error: null };
  };
  return { supabase, reads };
}

test('a search still reranking at the deadline returns the question\'s own search (fused, not reranked), marked fellBack, and the reranker is stopped', async () => {
  const data = Array.from({ length: 12 }, (_, i) => precRow(`p${i}`, 1 / (61 + i)));
  const supabase = fakeSupabase({ rpc: { search_passages: { data, error: null } } });
  let rerankSignal = null;
  const voyage = fakeVoyage({ rerank: () => { throw new Error('unused'); } });
  const fetchImpl = (url, init) => {
    if (url.endsWith('/rerank')) { rerankSignal = init.signal; voyage.requests.push({ url }); return hanging(init); }
    return voyage.fetchImpl(url, init);
  };
  const { result: { result: out, took }, seen } = await noUnhandled(() => timed(() => retrieveDetailed({ supabase, voyageKey: 'v', query: 'concession period', scope: 'precedent', k: 5, fetchImpl, rewrite: false, deadlineMs: 150, timings: true })));
  assert.ok(took >= 140 && took < 150 + 500, `returned at the deadline (${took} ms)`);
  assert.equal(out.fellBack, true);
  assert.equal(out.path, 'fused');
  assert.match(out.reason, /longer than 150 ms: returned the search by words and meaning \(the phrasings included\), fused but not reranked/);
  assert.equal(out.timings.fellBack, true);
  assert.equal(out.timings.path, 'fused');
  assert.equal(out.timings.reason, out.reason);
  assert.equal(out.timings.deadlineMs, 150);
  assert.equal(out.reranked, false);
  assert.deepEqual(out.passages.map((p) => p.id), ['p0', 'p1', 'p2', 'p3', 'p4'], 'the fused order, best k');
  assert.ok(out.passages.every((p) => p.label), 'labelled for citation');
  assert.equal(out.voyageCalls, 2, 'the embedding and the abandoned rerank');
  assert.equal(out.timings.voyageCalls, 2);
  assert.equal(rerankSignal?.aborted, true, 'the rerank call was aborted');
  assert.deepEqual(seen, [], 'no unhandled rejection');
  assert.equal(hybridCalls(supabase).length, 1);
  assert.equal(wordsCalls(supabase).length, 1, 'the words-only search started beside it');
});

test('with the embedding hanging, the search by words alone — started at once, no Voyage call — is returned by the deadline, for every scope', async () => {
  const deadlineMs = 150;
  const contract = '1. Short title.—This Act may be called the Contract Act. 73. Compensation for loss or damage caused by breach of contract.—When a contract has been broken, the party who suffers is entitled to compensation. 74. Compensation for breach of contract where penalty stipulated for.—When a sum is named in the contract as the amount to be paid in case of breach, the party complaining is entitled to reasonable compensation.';
  const fetchImpl = (url, init) => hanging(init); // Voyage never answers
  const cases = [
    {
      scope: 'project', query: 'what is the concession period', options: { matterId: 'm1' },
      rows: [row('w1', { heading_path: '4. Term › 4.2 Concession Period' }), row('w2', { page: 7, document_version_id: 'v-w2' })],
      ids: ['w1', 'w2'], labels: ['Term Sheet v3, 4. Term › 4.2 Concession Period', 'Term Sheet v3, p. 7'],
    },
    {
      scope: 'precedent', query: 'example of a drag along clause', options: {},
      rows: [precRow('w1', 0.02, { heading_path: 'Clause 9 Transfers › 9.3 Drag along' }), precRow('w2', 0.01)],
      ids: ['w1', 'w2'], labels: ['w1.docx, Clause 9 Transfers › 9.3 Drag along', 'w2.docx'],
    },
    {
      // A question naming a section: that section, read whole, leads.
      scope: 'statute', query: 'contract act 1872 section 74 penalty', options: { actNames: ['Contract Act, 1872'] },
      rows: [{ ...row('w1'), metadata: { act_name: 'Contract Act, 1872' }, heading_path: 'Chapter VI › 73. Compensation for loss or damage caused by breach of contract', content: contract.slice(contract.indexOf('73. Compensation')) }],
      ids: null, labels: ['Contract Act, 1872, s.74', 'Contract Act, 1872, s.73'],
    },
  ];
  for (const c of cases) {
    clearRetrieveCaches();
    clearCaches();
    const rpc = (args) => {
      assert.equal(args.query_embedding, null, `${c.scope}: only the words-only search can run`);
      assert.equal(args.scope, c.scope);
      return { data: c.rows, error: null };
    };
    const supabase = c.scope === 'statute' ? statuteLibrary({ 'Contract Act, 1872': contract }, rpc).supabase : fakeSupabase({ rpc: { search_passages: rpc } });
    const { result: { result: out, took }, seen } = await noUnhandled(() => timed(() => retrieveDetailed({ supabase, voyageKey: 'v', query: c.query, scope: c.scope, ...c.options, k: 5, fetchImpl, rewrite: false, deadlineMs, timings: true })));
    assert.ok(took >= deadlineMs - 10 && took <= deadlineMs + 500, `${c.scope}: returned at the deadline (${took} ms)`);
    assert.equal(out.fellBack, true, c.scope);
    assert.equal(out.path, 'words', c.scope);
    assert.match(out.reason, /longer than 150 ms: returned the search by words alone \(the question's embedding was not back\), not reranked/);
    assert.equal(out.timings.fellBack, true);
    assert.equal(out.timings.path, 'words');
    assert.equal(out.timings.reason, out.reason);
    assert.equal(out.timings.voyageCalls, 1, `${c.scope}: the embedding call that never answered`);
    assert.ok(out.timings.events.some((e) => e.stage === 'words only' && e.start < 50 && e.rows === c.rows.length), `${c.scope}: the words-only search started at once: ${JSON.stringify(out.timings.events)}`);
    assert.equal(out.reranked, false);
    if (c.ids) assert.deepEqual(out.passages.map((p) => p.id), c.ids, c.scope);
    assert.deepEqual(out.passages.map((p) => p.label), c.labels, c.scope);
    if (c.scope === 'statute') {
      assert.equal(out.passages[0].lead, true, 'the named section, read whole, leads');
      assert.equal(out.passages[0].section, '74');
      assert.equal(out.passages[1].section, '73', 'the section from the heading path: no Act is read to place it');
    }
    assert.equal(wordsCalls(supabase).length, 1, c.scope);
    assert.equal(hybridCalls(supabase).length, 0, `${c.scope}: no embedding, no hybrid search`);
    assert.deepEqual(seen, [], c.scope);
  }
});

test('with every search hanging too, nothing is returned by the deadline, marked, and what answers later changes nothing; match_documents is not tried', async () => {
  const late = deferred();
  const supabase = fakeSupabase({ rpc: { search_passages: () => late.promise, match_documents: () => { throw new Error('match_documents must not be called'); } } });
  const voyage = fakeVoyage();
  const deadlineMs = 100;
  const { result: { result: out, took }, seen } = await noUnhandled(() => timed(() => retrieveDetailed({ supabase, voyageKey: 'v', query: 'concession period', scope: 'precedent', k: 5, fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs, timings: true })));
  assert.ok(took >= deadlineMs && took <= deadlineMs + 500, `the deadline and its grace at most (${took} ms)`);
  assert.equal(out.fellBack, true);
  assert.equal(out.path, 'none');
  assert.deepEqual(out.passages, []);
  assert.match(out.reason, /longer than 100 ms and neither the full search nor the search by words was back in time; nothing returned/);
  assert.equal(out.timings.path, 'none');
  assert.equal(out.timings.reason, out.reason);
  assert.equal(supabase.calls.filter((c) => c.name === 'match_documents').length, 0);
  const before = JSON.stringify(out);
  late.resolve({ data: [precRow('late', 0.05)], error: null });
  await sleep(50);
  assert.equal(JSON.stringify(out), before, 'nothing written to the result after it was returned');
  assert.deepEqual(seen, []);
});

test('with the embedding back but the full call late, the deadline returns call 1\'s rows (by words), and the full call is abandoned', async () => {
  const late = deferred();
  const supabase = fakeSupabase({
    rpc: {
      search_passages: (args) => (args.query_embedding ? late.promise : { data: [precRow('w1', 0.02, { heading_path: 'Clause 9 Transfers › 9.3 Drag along' }), precRow('w2', 0.01)], error: null }),
    },
  });
  const voyage = fakeVoyage();
  const deadlineMs = 150;
  const { result: { result: out, took }, seen } = await noUnhandled(() => timed(() => retrieveDetailed({ supabase, voyageKey: 'v', query: 'example of a drag along clause', scope: 'precedent', k: 5, fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs, timings: true })));
  assert.ok(took >= deadlineMs - 10 && took <= deadlineMs + 500, `returned at the deadline (${took} ms)`);
  assert.equal(out.fellBack, true);
  assert.equal(out.path, 'words');
  assert.match(out.reason, /longer than 150 ms: returned the search by words alone \(the question's embedding was not back\), not reranked/);
  assert.deepEqual(out.passages.map((p) => p.id), ['w1', 'w2'], 'call 1\'s rows');
  assert.equal(out.passages[0].label, 'w1.docx, Clause 9 Transfers › 9.3 Drag along');
  assert.equal(out.voyageCalls, 1, 'the embedding; no rerank on a quick return');
  assert.equal(hybridCalls(supabase).length, 1, 'the full call was sent');
  assert.equal(wordsCalls(supabase).length, 1);
  const before = JSON.stringify(out);
  late.resolve({ data: [precRow('late', 0.05)], error: null });
  await sleep(50);
  assert.equal(JSON.stringify(out), before, 'its late answer changes nothing');
  assert.deepEqual(seen, []);
});

test('the deadline is a hard total: a words-only answer just after it is still used, a later one is not, and the search returns within the deadline and 500 ms either way', async () => {
  const fetchImpl = (url, init) => hanging(init);
  const deadlineMs = 200;
  for (const [answerAt, expectPath] of [[deadlineMs + 100, 'words'], [deadlineMs + FALLBACK_GRACE_MS + 400, 'none']]) {
    clearRetrieveCaches();
    const supabase = fakeSupabase({ rpc: { search_passages: async () => { await sleep(answerAt); return { data: [precRow('w1', 0.02)], error: null }; } } });
    const { result: out, took } = await timed(() => retrieveDetailed({ supabase, voyageKey: 'v', query: 'concession period', scope: 'precedent', fetchImpl, rewrite: false, deadlineMs }));
    assert.ok(took <= deadlineMs + 500, `answer at ${answerAt} ms: returned in ${took} ms`);
    assert.equal(out.path, expectPath, `answer at ${answerAt} ms`);
    assert.equal(out.passages.length, expectPath === 'words' ? 1 : 0);
  }
});

test('a full search that fails before the deadline returns the words-only result when there is one; with nothing in hand, its error', async () => {
  const supabase = fakeSupabase({
    rpc: {
      search_passages: (args) => (args.query_embedding ? { data: null, error: { code: 'XX000', message: 'boom' } } : { data: [precRow('w1', 0.02)], error: null }),
    },
  });
  const voyage = fakeVoyage();
  const { result: { result: out, took }, seen } = await noUnhandled(() => timed(() => retrieveDetailed({ supabase, voyageKey: 'v', query: 'concession period', scope: 'precedent', fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs: 5000, timings: true })));
  assert.ok(took < 1000, `returned as soon as the failure was known (${took} ms)`);
  assert.equal(out.fellBack, true);
  assert.equal(out.path, 'words');
  assert.match(out.reason, /^the search failed \(The search failed: boom\): returned the search by words alone/);
  assert.deepEqual(out.passages.map((p) => p.id), ['w1']);
  assert.deepEqual(seen, []);
  // Everything failing: the error.
  clearRetrieveCaches();
  const broken = fakeSupabase({ rpc: { search_passages: { data: null, error: { code: 'XX000', message: 'boom' } } } });
  await assert.rejects(retrieve({ supabase: broken, voyageKey: 'v', query: 'concession period', scope: 'precedent', fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs: 5000 }), /boom/);
});

test('a search that finishes in time is not touched by the deadline, and with the deadline off no words-only search is started', async () => {
  const supabase = fakeSupabase({ rpc: { search_passages: { data: [precRow('a', 0.03)], error: null } } });
  const voyage = fakeVoyage();
  const out = await retrieveDetailed({ supabase, voyageKey: 'v', query: 'concession period', scope: 'precedent', fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs: 5000, timings: true });
  assert.equal(out.fellBack, false);
  assert.equal(out.reason, null);
  assert.equal(out.path, 'full');
  assert.equal(out.timings.path, 'full');
  assert.equal(out.timings.fellBack, false);
  assert.equal(out.timings.deadlineMs, 5000);
  assert.equal(wordsCalls(supabase).length, 1);
  // deadlineMs: 0 — waits for the whole search however long it takes, and
  // starts no search by words alone.
  clearRetrieveCaches();
  const slow = fakeSupabase({ rpc: { search_passages: async () => { await sleep(120); return { data: [precRow('a', 0.03)], error: null }; } } });
  const off = await retrieveDetailed({ supabase: slow, voyageKey: 'v', query: 'concession period', scope: 'precedent', fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs: 0, timings: true });
  assert.equal(off.fellBack, false);
  assert.equal(off.path, 'full');
  assert.equal(off.timings.deadlineMs, null);
  assert.equal(off.passages.length, 1);
  assert.equal(wordsCalls(slow).length, 0);
  assert.equal(searchCalls(slow).length, 1);
});

// -------------------------------------- the process's database searches

// On 18 Oct 2026 the evaluation's tools run returned nothing for twenty
// searches in a row: every search's five database calls went out at once,
// the ones the deadline abandoned ran on in the database (holding PostgREST's
// ten or so connections for up to 30 s), and the next search's words-only
// call — its safety net — waited behind them past the deadline. The calls now
// take turns, a few at a time per process.
test('one process keeps at most MAX_SEARCH_CALLS database searches in flight: ten searches at once take turns, and all answer', async () => {
  assert.equal(MAX_SEARCH_CALLS, 6, 'one chat turn: two calls for each of three scopes');
  let inFlight = 0;
  let peak = 0;
  let sent = 0;
  const supabase = fakeSupabase({
    rpc: {
      search_passages: async (args) => {
        sent++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(40);
        inFlight--;
        return { data: [row(`r-${args.query_text}`)], error: null };
      },
    },
  });
  const voyage = fakeVoyage();
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => retrieve({ supabase, voyageKey: 'v', query: `concession period ${i}`, scope: 'project', matterId: 'm1', fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs: 0, timings: true })));
  assert.equal(sent, 10, 'every search was sent');
  assert.equal(peak, MAX_SEARCH_CALLS, `at most six in flight (peak ${peak})`);
  assert.ok(outs.every((o) => o.passages.length === 1), 'every search answered');
  assert.ok(outs.some((o) => o.timings.events.find((e) => e.stage === 'search').waitedMs >= 30), 'the event says how long a call waited for its turn');
  assert.deepEqual(searchCallLoad(), { inFlight: 0, waiting: 0, limit: MAX_SEARCH_CALLS }, 'every turn given back');
});

test('a waiting call goes in order of worth — the words-only calls before the full ones — and one whose search has returned by the deadline is never sent', async () => {
  const held = [];
  const supabase = fakeSupabase({
    rpc: { search_passages: (args) => new Promise((resolve) => held.push({ args, release: () => resolve({ data: [precRow(`p${held.length}`, 0.02)], error: null }) })) },
  });
  const voyage = fakeVoyage();
  // Six searches with no deadline (one call each) take every turn.
  const busy = Array.from({ length: MAX_SEARCH_CALLS }, (_, i) => retrieve({ supabase, voyageKey: 'v', query: `concession period ${i}`, scope: 'precedent', fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs: 0 }));
  await sleep(30);
  assert.equal(held.length, MAX_SEARCH_CALLS);
  assert.deepEqual(searchCallLoad(), { inFlight: MAX_SEARCH_CALLS, waiting: 0, limit: MAX_SEARCH_CALLS });

  // A capped search: its words-only and own calls wait their turn; at the
  // deadline it returns nothing, says why, and they are never sent.
  const { result: { result: capped, took }, seen } = await noUnhandled(() => timed(() => retrieveDetailed({ supabase, voyageKey: 'v', query: 'drag along', scope: 'precedent', fetchImpl: voyage.fetchImpl, rewrite: false, deadlineMs: 100, timings: true })));
  assert.ok(took <= 100 + 500, `returned at the deadline (${took} ms)`);
  assert.equal(capped.path, 'none');
  assert.match(capped.reason, /neither the full search nor the search by words was back in time; nothing returned \(2 of its calls never left the queue: 6 searches in flight, 2 waiting\)/);
  assert.equal(held.length, MAX_SEARCH_CALLS, 'nothing of it was sent');
  assert.equal(searchCallLoad().waiting, 0, 'its calls left the line when it returned');
  assert.deepEqual(seen, []);

  // Two more searches line up, two calls each: one with phrasings (the
  // words-only call, then the full call carrying the phrasings), then a
  // plain one (words only, then the full call).
  const anthropicJson = async () => ({ content: [{ type: 'text', text: '["drag-along right", "compel the minority to sell"]' }] });
  const withPhrasings = retrieve({ supabase, voyageKey: 'v', anthropicJson, query: 'example of a drag along clause', scope: 'precedent', fetchImpl: voyage.fetchImpl, rerank: false, deadlineMs: 5000 });
  await sleep(30);
  const plain = retrieve({ supabase, voyageKey: 'v', query: 'lock-in period', scope: 'precedent', fetchImpl: voyage.fetchImpl, rewrite: false, rerank: false, deadlineMs: 5000 });
  await sleep(30);
  assert.equal(searchCallLoad().waiting, 4);
  assert.equal(held.length, MAX_SEARCH_CALLS, 'still nothing sent');
  // As turns free up, the waiting calls go by worth, then by who asked first.
  const order = [];
  for (let i = 0; i < 4; i++) {
    held[i].release();
    await sleep(20);
    const sent = held[MAX_SEARCH_CALLS + i];
    assert.ok(sent, `a waiting call was sent when turn ${i} freed`);
    order.push(`${sent.args.query_text}${sent.args.query_embedding ? '' : ' (words)'}${sent.args.phrasings ? ` +${sent.args.phrasings.length}` : ''}`);
  }
  assert.deepEqual(order, [
    'example of a drag along clause (words)', 'lock-in period (words)',
    'example of a drag along clause +2', 'lock-in period',
  ]);
  for (const h of held.slice(4)) h.release();
  const [withOut, plainOut] = await Promise.all([withPhrasings, plain, ...busy]);
  assert.ok(withOut.length >= 1 && plainOut.length >= 1);
  assert.deepEqual(searchCallLoad(), { inFlight: 0, waiting: 0, limit: MAX_SEARCH_CALLS });
});
