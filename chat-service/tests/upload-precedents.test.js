// scripts/drafting-packs/upload_precedents.mjs: a folder of the firm's
// precedents added to the precedent library under a type, read with the
// index worker's reader so every passage keeps its heading path; skipped
// when the library has the file already (by hash, or by the site's name and
// size rule); taken back when a write fails; a dry run writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, listDocx, uploadPrecedents, precedentRows, readPrecedent, sha256 } from '../../scripts/drafting-packs/upload_precedents.mjs';

const MASTER = fileURLToPath(new URL('../../firm-skills/concession-agreement/assets/Standard Concession Agreement [AKLA].docx', import.meta.url));
const TYPE = { id: '00000000-0000-4000-8000-0000000000c1', name: 'Concession Agreement' };

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'precedents-'));
  copyFileSync(MASTER, join(dir, 'CA master.docx'));
  writeFileSync(join(dir, '~$CA master.docx'), 'lock');
  writeFileSync(join(dir, 'notes.txt'), 'not a precedent');
  mkdirSync(join(dir, 'also read'));
  copyFileSync(MASTER, join(dir, 'also read', 'CA copy.docx'));
  return dir;
}

// The database and storage calls the script makes, recorded; `existing` are documents rows already there.
function fakeSupabase({ existing = [], failInsert = false } = {}) {
  const log = { uploads: [], removed: [], inserted: [], deleted: [] };
  const from = (table) => {
    const filters = [];
    const q = {
      select() { return q; },
      eq(col, v) { filters.push([col, v]); return q; },
      ilike(col, v) { filters.push([col, v, 'ilike']); return q; },
      limit() { return q; },
      maybeSingle() { return Promise.resolve({ data: table === 'document_types' ? (filters.some(([, v]) => v === TYPE.id) ? TYPE : null) : null, error: null }); },
      insert(rows) { if (failInsert) return Promise.resolve({ error: { message: 'insert refused' } }); log.inserted.push(...rows); return Promise.resolve({ error: null }); },
      delete() { const d = { eq(col, v) { filters.push([col, v]); return d; }, then(res) { log.deleted.push(Object.fromEntries(filters)); return Promise.resolve({ error: null }).then(res); } }; return d; },
      then(resolve) {
        if (table === 'document_types') return Promise.resolve({ data: [TYPE, { id: 'x', name: 'Escrow Agreement' }], error: null }).then(resolve);
        const meta = (r, k) => String(r.metadata?.[k] ?? '');
        const rows = existing.filter((r) => filters.every(([col, v, how]) => {
          if (col === 'is_precedent') return true;
          const k = col.replace('metadata->>', '');
          return how === 'ilike' ? meta(r, k).toLowerCase() === String(v).toLowerCase() : meta(r, k) === String(v);
        }));
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return q;
  };
  return {
    log,
    from,
    storage: { from: () => ({
      upload: (path) => { log.uploads.push(path); return Promise.resolve({ error: null }); },
      remove: (paths) => { log.removed.push(...paths); return Promise.resolve({ error: null }); },
    }) },
  };
}

test('the command line and the files it names: Word files only, lock files out, sub-folders (after the folder’s own files) with --recursive', () => {
  assert.deepEqual(parseArgs(['--type', 'Escrow Agreement', 'a', 'b', '--dry-run', '-r', '--no-embeddings', '--by=u']), { paths: ['a', 'b'], type: 'Escrow Agreement', dryRun: true, recursive: true, by: 'u', embed: false, help: false });
  assert.throws(() => parseArgs(['--nope']), /Unknown option --nope/);
  const dir = folder();
  try {
    assert.deepEqual(listDocx([dir]).map((f) => f.split('/').pop()), ['CA master.docx']);
    assert.deepEqual(listDocx([dir], { recursive: true }).map((f) => f.split('/').pop()), ['CA master.docx', 'CA copy.docx']);
    assert.throws(() => listDocx([join(dir, 'notes.txt')]), /is not a Word file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a precedent is read the index worker\'s way: passages under their clauses, each with its heading path', async () => {
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(MASTER));
  const doc = await readPrecedent(bytes, 'CA master.docx');
  assert.ok(doc.chunks.length > 100);
  assert.ok(doc.headings / doc.chunks.length > 0.9, 'nearly every passage has a heading path');
  const rows = precedentRows({ chunks: doc.chunks, read: doc.read, vectors: null, fileName: 'CA master.docx', storagePath: 'precedent/t/1-CA-master.docx', fileSize: bytes.byteLength, hash: sha256(bytes), typeId: TYPE.id, uploadedAt: '2026-10-21T00:00:00.000Z' });
  const r = rows[10];
  assert.equal(r.is_precedent, true);
  assert.equal(r.matter_id, null);
  assert.equal(r.document_type_id, TYPE.id);
  assert.equal(r.metadata.storage_bucket, 'precedent-library');
  assert.equal(r.metadata.chunk_index, 10);
  assert.equal(r.metadata.file_sha256, sha256(bytes));
  assert.equal(r.heading_path, r.metadata.heading_path);
  assert.match(r.content, /\n\n/, 'paragraph breaks kept, so the passage trigger finds the headings');
  assert.ok(!('embedding' in r));
});

test('a dry run reads every file and checks the library, and writes nothing', async () => {
  const dir = folder();
  try {
    const supabase = fakeSupabase();
    const rows = await uploadPrecedents({ supabase, files: listDocx([dir], { recursive: true }), type: 'concession agreement', dryRun: true });
    assert.deepEqual(rows.map((r) => r.action), ['would add', 'would add']);
    assert.match(rows[0].detail, /as Concession Agreement/);
    assert.deepEqual(supabase.log, { uploads: [], removed: [], inserted: [], deleted: [] });
    const offline = await uploadPrecedents({ supabase: null, files: listDocx([dir]), type: 'Concession Agreement', dryRun: true });
    assert.match(offline[0].detail, /offline/);
    await assert.rejects(uploadPrecedents({ supabase: null, files: [], type: 'x' }), /needs SUPABASE_URL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an upload stores the file where the admin page does and the passages with vectors; a second run changes nothing', async () => {
  const dir = folder();
  try {
    const supabase = fakeSupabase();
    let embedded = 0;
    const embedder = async (inputs) => { embedded += inputs.length; assert.match(inputs[0], /^Document: CA master \(Concession Agreement\)/); return inputs.map(() => new Array(1024).fill(0)); };
    const rows = await uploadPrecedents({ supabase, files: listDocx([dir]), type: TYPE.id, voyageKey: 'v', embedder, now: () => 1700000000000 });
    assert.equal(rows[0].action, 'added');
    assert.deepEqual(supabase.log.uploads, [`precedent/${TYPE.id}/1700000000000-CA-master.docx`]);
    assert.equal(supabase.log.inserted.length, Number(rows[0].passages));
    assert.equal(embedded, supabase.log.inserted.length);
    assert.ok(supabase.log.inserted.every((r) => r.embedding.length === 1024));
    // Run again against what is now there: the same file by its hash.
    const again = fakeSupabase({ existing: supabase.log.inserted });
    const second = await uploadPrecedents({ supabase: again, files: listDocx([dir]), type: TYPE.id, voyageKey: 'v', embedder });
    assert.equal(second[0].action, 'already in library');
    assert.match(second[0].detail, /the same file \(by its hash\)/);
    assert.deepEqual(again.log.uploads, []);
    // A file the site uploaded (no hash) of the same name and size.
    const site = fakeSupabase({ existing: [{ document_type_id: TYPE.id, metadata: { filename: 'ca MASTER.docx', file_size: supabase.log.inserted[0].metadata.file_size, storage_path: 'precedent/t/1-x.docx' } }] });
    assert.match((await uploadPrecedents({ supabase: site, files: listDocx([dir]), type: TYPE.id, embed: false }))[0].detail, /same name and size/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed write is taken back: the rows and the stored copy go, and the run says why', async () => {
  const dir = folder();
  try {
    const supabase = fakeSupabase({ failInsert: true });
    const rows = await uploadPrecedents({ supabase, files: listDocx([dir]), type: TYPE.id, embed: false, now: () => 5 });
    assert.equal(rows[0].action, 'refused');
    assert.match(rows[0].detail, /could not save its passages: insert refused/);
    assert.deepEqual(supabase.log.removed, [`precedent/${TYPE.id}/5-CA-master.docx`]);
    assert.equal(supabase.log.deleted[0]['metadata->>storage_path'], `precedent/${TYPE.id}/5-CA-master.docx`);
    await assert.rejects(uploadPrecedents({ supabase, files: [], type: TYPE.id }), /VOYAGE_API_KEY is needed/);
    await assert.rejects(uploadPrecedents({ supabase, files: [], type: 'No Such Type', embed: false }), /There is no document type named "No Such Type"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
