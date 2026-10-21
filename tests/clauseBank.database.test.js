// The clause bank migration (20261021090000_clause_bank.sql) on an
// in-memory Postgres: every precedent paragraph gets the heading it sits
// under, its number, the heading normalised exactly as clauseBank.js
// headingNorm does it, and its type's family; the passages themselves are
// cut as before; existing passages are filled in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { headingNorm } from '../chat-service/clauseBank.js';
import { TYPE_STYLE_SHEETS } from '../chat-service/styleSheets/index.js';

const ESCROW = '00000000-0000-0000-0000-0000000000e1';
const MEMO = '00000000-0000-0000-0000-0000000000e2';
const OTHER = '00000000-0000-0000-0000-0000000000e3';
const clauseBankSql = () => readFileSync('supabase/migrations/20261021090000_clause_bank.sql', 'utf8') + '\n' + readFileSync('supabase/migrations/20261021090001_clause_bank_backfill.sql', 'utf8');

async function database() {
  const db = new PGlite();
  await db.exec(`
  create schema auth;
  create role authenticated; create role service_role;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
  create function public.is_firm_member(uuid) returns boolean language sql stable as $$ select true $$;
  create table public.document_types(id uuid primary key, name text);
  insert into public.document_types values ('${ESCROW}', 'Escrow Agreement'), ('${MEMO}', 'Research Memo'), ('${OTHER}', 'EPC Contract');
  create table public.documents(id uuid primary key default gen_random_uuid(), content text, metadata jsonb, document_type_id uuid,
    is_precedent boolean not null default false, heading_path text);
  `);
  await db.exec(readFileSync('supabase/migrations/20260921090000_precedent_passages.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261021085900_precedent_paragraphs_as_live.sql', 'utf8'));
  return db;
}

const precedent = async (db, { type = ESCROW, content, path = 'precedent/x/escrow.docx', chunk = 0, headingPath = null }) =>
  (await db.query('insert into documents(content, metadata, document_type_id, is_precedent, heading_path) values ($1, $2, $3, true, $4) returning id',
    [content, JSON.stringify({ storage_path: path, filename: path.split('/').pop(), chunk_index: chunk }), type, headingPath])).rows[0].id;

const passages = async (db, id) => (await db.query('select ordinal, body, heading, heading_norm, clause_no, family from precedent_passages where document_id = $1 order by ordinal', [id])).rows;

const ESCROW_TEXT = [
  'ESCROW AGREEMENT',
  'This Escrow Agreement is made and entered into at [●] on this [●] day of [●], [●].',
  '1. DEFINITIONS AND INTERPRETATION',
  '1.1 Definitions',
  'In this Agreement, unless the context otherwise requires, the following words shall have the meanings set out below:',
  '2. APPOINTMENT OF ESCROW AGENT',
  '2.1 The Parties hereby appoint the Escrow Agent to act as escrow agent in accordance with the terms of this Agreement.',
  '(a) the Escrow Agent shall hold the Escrow Amount in the Escrow Account until released in accordance with this Agreement;',
  'ARTICLE 14',
  'GOVERNING LAWS',
  '14.1 This Agreement shall be governed by and construed in accordance with the laws of Pakistan.',
  '14.2 Dispute Resolution. Any dispute arising out of or in connection with this Agreement shall be referred to arbitration.',
  'Schedule B – Specific Definitions',
  'Escrow Amount means the amount deposited in the Escrow Account from time to time in accordance with this Agreement.',
].join('\n\n');

test('clause bank: each passage gets the heading above it, its number, the normalised heading and the family', async () => {
  const db = await database();
  try {
    const before = await precedent(db, { content: ESCROW_TEXT });
    // A paragraph over 2,400 characters (a precedent stored without paragraph
    // breaks) is cut by the live cutter (20261021085900) into sentence groups.
    const long = 'This is one sentence of a precedent stored without paragraph breaks. '.repeat(60);
    const longId = await precedent(db, { content: long, path: 'precedent/x/long.docx' });
    const longRows = (await db.query('select count(*)::int as n from precedent_passages where document_id = $1', [longId])).rows[0].n;
    assert.ok(longRows >= 2, 'a long paragraph is cut into several passages');
    const old = (await db.query('select ordinal, body from precedent_passages where document_id = $1 order by ordinal', [before])).rows;
    await db.exec(clauseBankSql());
    await db.exec(clauseBankSql()); // a second run changes nothing
    // Existing passages are filled in place: same ordinals and bodies.
    const filled = await passages(db, before);
    assert.deepEqual(filled.map((p) => [p.ordinal, p.body]), old.map((p) => [p.ordinal, p.body]));
    const by = (start) => filled.find((p) => p.body.startsWith(start));
    assert.equal(by('This Escrow Agreement').heading, 'ESCROW AGREEMENT');
    assert.equal(by('In this Agreement').heading, 'Definitions');
    assert.equal(by('In this Agreement').clause_no, '1.1');
    assert.equal(by('2.1 The Parties').heading, 'APPOINTMENT OF ESCROW AGENT');
    assert.equal(by('2.1 The Parties').clause_no, '2');
    assert.equal(by('(a) the Escrow Agent').heading, 'APPOINTMENT OF ESCROW AGENT');
    assert.equal(by('14.1 This').heading, 'GOVERNING LAWS');
    assert.equal(by('14.1 This').clause_no, 'Article 14');
    assert.equal(by('14.1 This').heading_norm, 'governing law');
    assert.equal(by('14.2 Dispute').heading, 'Dispute Resolution');
    assert.equal(by('14.2 Dispute').clause_no, '14.2');
    assert.equal(by('Escrow Amount means').heading, 'Specific Definitions');
    assert.equal(by('Escrow Amount means').clause_no, 'Schedule B');
    assert.ok(filled.every((p) => p.family === 'escrow'));

    // A new precedent gets them as it is stored; its type decides the family.
    const memo = await precedent(db, { type: MEMO, path: 'precedent/m/memo.docx', content: 'Brief Answer\n\nThe Firm is of the view that the consent of the lenders is required before the transfer takes effect.' });
    const m = await passages(db, memo);
    assert.equal(m[0].heading, 'Brief Answer');
    assert.equal(m[0].family, 'memo');
    const epc = await precedent(db, { type: OTHER, path: 'precedent/e/epc.docx', content: '1. Governing Law\n\nThis Contract shall be governed by the laws of Pakistan and the courts at [●] shall have jurisdiction.' });
    assert.equal((await passages(db, epc))[0].family, null, 'a type with no pack has no family');
    assert.equal((await passages(db, epc))[0].heading_norm, 'governing law');

    // The first paragraphs of a stored piece take their heading from its heading path.
    const piece = await precedent(db, { chunk: 3, headingPath: '14. Termination › 14.2 Termination for Convenience › 14.2.1', content: 'The Escrow Agent may terminate this Agreement by giving not less than thirty (30) days notice in writing to the Parties.\n\n15. NOTICES\n\nEvery notice under this Agreement shall be in writing and delivered by hand or by courier.' });
    const pp = await passages(db, piece);
    assert.equal(pp[0].heading, 'Termination for Convenience');
    assert.equal(pp[0].clause_no, '14.2');
    assert.equal(pp[1].heading, 'NOTICES');
    assert.equal(pp[1].heading_norm, 'notice');

    // Text with no paragraph breaks (the old edge-function upload) still makes its passages.
    const flat = await precedent(db, { content: 'This is one sentence of a precedent stored without paragraph breaks. '.repeat(120) });
    const fp = await passages(db, flat);
    assert.ok(fp.length >= 2);
    assert.ok(fp.every((p) => p.heading === null));

    // The index the lookup uses.
    const idx = (await db.query("select indexdef from pg_indexes where indexname = 'precedent_passages_type_heading_idx'")).rows[0].indexdef;
    assert.match(idx, /\(document_type_id, heading_norm\)/);
  } finally {
    await db.close();
  }
});

test('clause bank: the SQL normaliser and clauseBank.js headingNorm agree', async () => {
  const db = await database();
  try {
    await db.exec(clauseBankSql());
    const cases = [
      'ARTICLE 14 – GOVERNING LAWS', '14.1 Governing Law', 'Governing Law', 'Article IV Notices', 'Section 2.1 (The Appointment)',
      'Schedule B – Specific Definitions', 'SCHEDULE OF PAYMENTS', 'Representations & Warranties', 'Parties', 'Process and Status',
      '(a) Costs and Expenses', 'The Appointment', 'Definitions and Interpretation', '  ', null, 'Escrow Agent’s Duties', 'Annexure A',
      'Conditions Precedent', 'Taxes', 'Analysis', 'Fees and Expenses', 'Brief Answer', 'Clause 3', 'Part II – Commercial Terms',
    ];
    for (const c of cases) {
      const sql = (await db.query('select public.clause_heading_norm($1) as n', [c])).rows[0].n;
      assert.equal(sql, headingNorm(c), `“${c}”`);
    }
  } finally {
    await db.close();
  }
});

test('clause bank: the SQL family list and the style sheets\' type list agree', async () => {
  const db = await database();
  try {
    await db.exec(clauseBankSql());
    for (const [name, key] of Object.entries(TYPE_STYLE_SHEETS)) {
      const fam = (await db.query('select public.clause_bank_family($1) as f', [name])).rows[0].f;
      assert.equal(fam, key, name);
    }
    assert.equal((await db.query("select public.clause_bank_family('RFP Volume I') as f")).rows[0].f, 'rfp');
    assert.equal((await db.query("select public.clause_bank_family('Independent Engineer’s Agreement') as f")).rows[0].f, 'ie-agreement');
    assert.equal((await db.query("select public.clause_bank_family('Concession Direct Agreement') as f")).rows[0].f, null);
  } finally {
    await db.close();
  }
});
