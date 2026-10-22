// The review's online law lookup, wherever the review starts (research.js
// reviewLawLookup). From the Hub a law it downloads goes into the law
// library through the ingest-documents edge function under the lawyer's
// token; from claude.ai, where the connector keeps no token, through
// indexing/statute.js ingestStatute: the edge function's own splitter and
// row, the index worker's embedder, the lawyer's name on every row, and only
// for an approved member. The lookup itself is the same: the library first,
// then an official PDF whose text names the law. Against stubs, a tiny real
// PDF and a stand-in fetch. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitIntoChunks, statuteRows, ingestStatute, STATUTE_CHUNK_WORDS, STATUTE_CHUNK_OVERLAP } from '../indexing/statute.js';
import { researchLaw, reviewLawLookup, anthropicCaller } from '../research.js';

const USER = '11111111-1111-4111-8111-111111111111';
const MATTER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EDGE = readFileSync(new URL('../../supabase/functions/ingest-documents/index.ts', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// The ingest, line for line the edge function's

test('the splitter is the edge function\'s: 1,000-word passages overlapping by 200, and the text itself when there are no words', () => {
  assert.equal(STATUTE_CHUNK_WORDS, 1000);
  assert.equal(STATUTE_CHUNK_OVERLAP, 200);
  // The edge function's defaults and loop, so a change there is a change here.
  assert.match(EDGE, /chunkSize = 1000,\s*\n\s*chunkOverlap = 200,/);
  assert.match(EDGE, /for \(let i = 0; i < words\.length; i \+= chunkSize - overlap\)/);
  assert.match(EDGE, /const chunk = words\.slice\(i, i \+ chunkSize\)\.join\(' '\);/);
  assert.match(EDGE, /return chunks\.length > 0 \? chunks : \[text\];/);
  const words = Array.from({ length: 2500 }, (_, i) => `w${i}`);
  const chunks = splitIntoChunks(words.join(' '));
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map((c) => c.split(' ')[0]), ['w0', 'w800', 'w1600', 'w2400']);
  assert.equal(chunks[0].split(' ').length, 1000);
  assert.equal(chunks[3].split(' ').length, 100);
  assert.deepEqual(splitIntoChunks('   '), ['   ']);
});

test('the rows are the edge function\'s: the same columns, the metadata with chunk_index and chunk_total, a statute, the lawyer as creator', () => {
  // The columns the edge function inserts, read from its source.
  const insert = /supabase\.from\('documents'\)\.insert\(\{([\s\S]*?)\}\)/.exec(EDGE)[1];
  const edgeColumns = [...insert.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
  const rows = statuteRows(Array.from({ length: 1500 }, () => 'law').join(' '), { act_name: 'The Competition Act, 2010', source: 'official-web-research' }, USER);
  assert.deepEqual([...Object.keys(rows[0]), 'embedding'].sort(), edgeColumns);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.metadata.chunk_index, r.metadata.chunk_total]), [[0, 2], [1, 2]]);
  assert.equal(rows[0].metadata.act_name, 'The Competition Act, 2010');
  assert.ok(rows.every((r) => r.is_statute === true && r.is_precedent === false && r.matter_id === null && r.document_type_id === null && r.created_by === USER));
  // The edge function embeds with voyage-law-2 as documents; so does the index worker's embedder.
  assert.match(EDGE, /model: 'voyage-law-2',\s*\n\s*input: batch,\s*\n\s*input_type: 'document',/);
  const embed = readFileSync(new URL('../indexing/embed.js', import.meta.url), 'utf8');
  assert.match(embed, /model: VOYAGE_MODEL, input: batch\.map\(\(i\) => inputs\[i\]\), input_type: "document"/);
  assert.match(embed, /export const VOYAGE_MODEL = "voyage-law-2";/);
});

function fakeLibraryDb({ member = true } = {}) {
  const inserted = [];
  return {
    inserted,
    rpc: async (name, args) => {
      assert.equal(name, 'is_firm_member');
      assert.equal(args._user_id, USER);
      return { data: member, error: null };
    },
    from: (table) => ({
      insert: async (rows) => { assert.equal(table, 'documents'); inserted.push(...rows); return { error: null }; },
    }),
  };
}

test('ingestStatute adds the passages with their embeddings for an approved member only, and nothing when the embedding fails', async () => {
  const embedded = [];
  const embed = async (inputs, { apiKey }) => { embedded.push({ n: inputs.length, apiKey }); return inputs.map(() => new Array(1024).fill(0.5)); };
  const db = fakeLibraryDb();
  const text = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ');
  const out = await ingestStatute({ supabase: db, voyageKey: 'pa-test', userId: USER, content: text, metadata: { act_name: 'An Act, 2001' }, embed });
  assert.equal(out.chunks, 2);
  assert.deepEqual(embedded, [{ n: 2, apiKey: 'pa-test' }]);
  assert.equal(db.inserted.length, 2);
  assert.ok(db.inserted.every((r) => r.embedding.length === 1024 && r.created_by === USER && r.is_statute));

  const outsider = fakeLibraryDb({ member: false });
  await assert.rejects(ingestStatute({ supabase: outsider, voyageKey: 'k', userId: USER, content: text, metadata: {}, embed }), /only an approved member of the firm can add a law/);
  assert.equal(outsider.inserted.length, 0);
  const failing = fakeLibraryDb();
  await assert.rejects(ingestStatute({ supabase: failing, voyageKey: 'k', userId: USER, content: text, metadata: {}, embed: async () => { throw new Error('Voyage 429'); } }), /Voyage 429/);
  assert.equal(failing.inserted.length, 0, 'nothing half-added');
  await assert.rejects(ingestStatute({ supabase: fakeLibraryDb(), voyageKey: 'k', userId: USER, content: '  ', metadata: {}, embed }), /empty/);
});

// ---------------------------------------------------------------------------
// The lookup, with the server's ingest in place of the edge function

/** A one-page PDF whose text is `lines` (what an official site serves). */
function makePdf(lines) {
  const esc = (t) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 11 Tf 50 780 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const ACT = 'The Competition Act, 2010';
const PDF = makePdf([ACT.toUpperCase(), ...Array.from({ length: 12 }, (_, i) => `Section ${i + 1}. The Commission may make rules for the purposes of this Act and the competition of markets.`)]);
const PLAN = { content: [{ type: 'text', text: JSON.stringify({ jurisdiction: 'Federal', uncertainties: [], sources: [{ title: ACT, url: 'https://www.cc.gov.pk/act-2010.pdf', reason: 'Merger control', kind: 'act' }] }) }], stop_reason: 'end_turn' };

function fakeResearchDb() {
  const writes = [];
  let invoked = 0;
  const from = (table) => {
    const q = {
      _op: 'select', _payload: null,
      select() { return q; }, eq() { return q; }, limit() { return q; }, order() { return q; },
      insert(p) { q._op = 'insert'; q._payload = p; return q; },
      update(p) { q._op = 'update'; q._payload = p; return q; },
      single() { return q; }, maybeSingle() { return q; },
      then(ok, bad) {
        let result = { data: [], error: null };
        if (q._op !== 'select') writes.push({ table, op: q._op, payload: q._payload });
        if (table === 'ai_research_runs' && q._op === 'insert') result = { data: { id: 'run-1' }, error: null };
        else if (table === 'matters') result = { data: { id: MATTER, name: 'Port', sector: 'Ports', description: 'A port concession.' }, error: null };
        return Promise.resolve(result).then(ok, bad);
      },
    };
    return q;
  };
  return {
    writes, from,
    get invoked() { return invoked; },
    rpc: async () => ({ data: [], error: null }),
    functions: { invoke: async () => { invoked += 1; return { error: null }; } },
  };
}

async function withOfficialFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://www.cc.gov.pk/act-2010.pdf');
    return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('researchLaw with the server\'s ingest: the downloaded law goes to `ingest` with its metadata, never to the edge function', async () => {
  const db = fakeResearchDb();
  const added = [];
  const research = await withOfficialFetch(() => researchLaw({
    supabase: db, userId: USER, anthropicJson: async () => PLAN, matter: { id: MATTER, sector: 'Ports', description: '' },
    message: 'Review', documentExcerpt: 'The parties merge.', notice: () => {},
    ingest: async ({ content, metadata }) => { added.push({ content, metadata }); },
  }));
  assert.equal(db.invoked, 0, 'the edge function is not called');
  assert.equal(added.length, 1);
  assert.match(added[0].content, /THE COMPETITION ACT, 2010/);
  assert.equal(added[0].metadata.act_name, ACT);
  assert.equal(added[0].metadata.source, 'official-web-research');
  assert.equal(added[0].metadata.research_run_id, 'run-1');
  assert.equal(added[0].metadata.applicability, 'candidate');
  assert.match(added[0].metadata.source_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(research.downloaded, [ACT]);
  assert.equal(research.status, 'complete');

  // From the Hub, with the lawyer's token and no ingest: the edge function, as before.
  const hub = fakeResearchDb();
  await withOfficialFetch(() => researchLaw({ supabase: hub, authHeader: 'Bearer t', userId: USER, anthropicJson: async () => PLAN, matter: { id: MATTER }, message: 'Review', notice: () => {} }));
  assert.equal(hub.invoked, 1);
});

test('reviewLawLookup is one lookup for both: it reads the project, says what it found, and a lookup that fails is a recorded limitation, not a failed review', async () => {
  const db = fakeResearchDb();
  const notices = [];
  const added = [];
  const lookUp = reviewLawLookup({ supabase: db, anthropicJson: async () => PLAN, ingest: async (x) => { added.push(x); }, userId: USER, notice: (t) => notices.push(t) });
  const research = await withOfficialFetch(() => lookUp({ fullText: '<p>The parties merge.</p>', matterId: MATTER }));
  assert.equal(research.runId, 'run-1');
  assert.equal(added.length, 1);
  assert.ok(notices.some((t) => /^Law lookup: downloaded 1 from official sources \(The Competition Act, 2010\)/.test(t)));

  const failing = reviewLawLookup({ supabase: db, anthropicJson: async () => { throw new Error('The AI service didn\'t respond properly (529).'); }, ingest: async () => {}, userId: USER, notice: () => {} });
  const out = await failing({ fullText: 'x', matterId: MATTER });
  assert.equal(out.status, 'failed');
  assert.match(out.unresolved[0], /529/);
  // A stop is a stop.
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  const stopped = reviewLawLookup({ supabase: db, anthropicJson: async () => { throw new Error('stopped'); }, userId: USER, signal: controller.signal });
  await assert.rejects(stopped({ fullText: 'x', matterId: MATTER }), /stopped/);
  assert.equal(anthropicCaller(null), null, 'no key, no caller');
});

test('the Hub and the connector both use the shared lookup: server.js under the lawyer\'s token, reviews.js with the server-side ingest', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /return sharedReviewLawLookup\(\{ supabase: db, anthropicJson, authHeader, userId, message, signal, notice \}\);/);
  const reviews = readFileSync(new URL('../connector/tools/reviews.js', import.meta.url), 'utf8');
  assert.match(reviews, /ingest: \(\{ content, metadata \}\) => ingestStatute\(\{ supabase, voyageKey: deps\.voyageKey, userId: ctx\.userId, content, metadata, log \}\)/);
  assert.doesNotMatch(reviews, /lookUpLaw: null/);
  const runs = readFileSync(new URL('../connector/reviewRuns.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runs, /lookUpLaw: null,/);
  // The edge function still demands a signed-in person: who can add a law from the Hub is unchanged.
  assert.match(EDGE, /const authHeader = req\.headers\.get\('Authorization'\);\s*\n\s*if \(!authHeader\)/);
  assert.match(EDGE, /supabase\.auth\.getUser\(/);
});
