// Drafting through the firm's packs (docs/drafting-fidelity-plan-2026-10-19.md,
// slice 2, the wiring half): draftingPacks.js, the Hub's fill and edit paths
// in server.js (read as source, as the other server.js tests do), the
// connector's open_standard_for_filling, fill_standard_to_project,
// list_document_types, read_standard and save_draft_to_project, and
// scripts/drafting-packs/upload_packs.mjs. The packs are small synthetic
// ones built here: a letter-like SHELL pack (Ref, Dated, To, the addressee,
// Subject, salutation, one example body paragraph and one example (a) limb,
// closing, signatory, a letterhead line in the header) and an agreement-like
// FORM pack (numbered headings and clauses, limbs, blanks). Each kinds list
// is read off the pack's own paragraphs, as build_pack.py reads it. No
// network, no Python.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { inspectDocx, applyDocxOps, acceptChangesBy, validateKinds, kindsListing, OPS_PROTOCOL } from '../docxAgent.js';
import { checkFormat, fingerprint } from '../formatFingerprint.js';
import { inferDraftSkill } from '../chatState.js';
import {
  packOf, packPromptBlock, packMap, packForBase, packTypesOf, packTypeFor, packPointer, packRedirectSentence, packFormatRules, withPackColumns,
  SHELL_PACK_INSTRUCTIONS, FORM_PACK_INSTRUCTIONS, NEW_CLAUSE_COMMENT, PACK_COLUMNS,
} from '../draftingPacks.js';
import { createHubTools } from '../connector/tools.js';
import { DEFAULT_SCOPE } from '../connector/oauth.js';
import { createProjectWrites } from '../connector/projectWrites.js';
import fillStandard, { clearStandardCache, CONNECTOR_FILL_NOTE, CONNECTOR_PACK_NOTE } from '../connector/tools/fillStandard.js';
import { createFillStandardTools, readOps, sha256, FILL_TOOL } from '../connector/tools/fillStandardWrite.js';
import standards from '../connector/tools/standards.js';
import { createSaveTools, DRAFT_TOOL } from '../connector/tools/saves.js';
import { uploadPacks, parseArgs, table, standardFileName, sanitizeStorageFilename, canonical, PROTECTED } from '../../scripts/drafting-packs/upload_packs.mjs';

const USER = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NEW_V = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const T_LETTER = '12121212-1212-4121-8121-121212121212';
const T_ESCROW = '34343434-3434-4343-8343-343434343434';
const T_CA = '56565656-5656-4565-8565-565656565656';
const T_MEMO = '78787878-7878-4787-8787-787878787878';
const CLOCK = Date.parse('2026-10-20T09:00:00Z');
const HUB = 'https://hub.test';
const LETTER_PATH = `standards/${T_LETTER}/1-Letter-notice-AKLA-standard.docx`;
const ESCROW_PATH = `standards/${T_ESCROW}/1-Escrow-agreement-AKLA-standard.docx`;
const CA_PATH = `standards/${T_CA}/1-CA.docx`;

// ---------------------------------------------------------------------------
// The packs

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const ARIAL = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>';
const RUN = `<w:rPr>${ARIAL}<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`;
const BOLD = `<w:rPr>${ARIAL}<w:b/><w:bCs/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`;
const BOLD_U = `<w:rPr>${ARIAL}<w:b/><w:bCs/><w:u w:val="single"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`;
const STYLES = `<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>`
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>'
  + '</w:styles>';
const NUMBERING = `<w:numbering ${NS}>`
  + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum>'
  + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
const SECT = '<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1701" w:left="1440" w:header="708" w:footer="368" w:gutter="0"/></w:sectPr>';
const HEADER = `<w:hdr ${NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>${RUN}<w:t>[To be printed on [●]'s letterhead]</w:t></w:r></w:p></w:hdr>`;
const TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const DOC_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>';

let nextId = 0x200;
const pid = () => `w14:paraId="${(nextId++).toString(16).toUpperCase().padStart(8, '0')}" w14:textId="77777777"`;
const para = (pPr, text, rPr = RUN) => `<w:p ${pid()}>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const empty = (pPr) => `<w:p ${pid()}>${pPr}</w:p>`;
const docx = (body) => zipSync({
  '[Content_Types].xml': strToU8(TYPES), '_rels/.rels': strToU8(ROOT_RELS), 'word/_rels/document.xml.rels': strToU8(DOC_RELS),
  'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}${SECT}</w:body></w:document>`),
  'word/styles.xml': strToU8(STYLES), 'word/numbering.xml': strToU8(NUMBERING), 'word/header1.xml': strToU8(HEADER),
}, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) });

// The letter shell.
const RIGHT = '<w:pPr><w:jc w:val="right"/></w:pPr>';
const PLAIN = '<w:pPr><w:spacing w:after="0"/><w:jc w:val="both"/></w:pPr>';
const ADDRESSEE = '<w:pPr><w:spacing w:after="0"/></w:pPr>';
const SUBJECT = '<w:pPr><w:ind w:left="1440" w:hanging="1440"/><w:jc w:val="both"/></w:pPr>';
const SALUTATION = '<w:pPr><w:spacing w:before="240" w:after="240"/></w:pPr>';
const BODY = '<w:pPr><w:spacing w:after="240"/><w:ind w:firstLine="720"/><w:jc w:val="both"/></w:pPr>';
const LIMB = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr><w:spacing w:after="240"/><w:ind w:left="720" w:hanging="720"/><w:jc w:val="both"/></w:pPr>';
const CLOSING = '<w:pPr><w:spacing w:before="240"/></w:pPr>';
const SIGNATORY = '<w:pPr><w:spacing w:before="720"/></w:pPr>';
const SPACER = '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>';
const LETTER_BODY = [
  para(RIGHT, 'Ref: [●]', BOLD),
  para(RIGHT, 'Dated: [●]', BOLD),
  para(PLAIN, 'To,'),
  para(ADDRESSEE, '[●]'),
  empty(SPACER),
  para(SUBJECT, 'Subject: [●]', BOLD_U),
  para(SALUTATION, 'Dear Sir,'),
  para(BODY, '[●]'),
  para(LIMB, '[●]'),
  para(CLOSING, 'Yours faithfully,'),
  para(SIGNATORY, '[●]', BOLD),
].join('');
const LETTER = docx(LETTER_BODY);
const LETTER_KINDS = {
  kinds: {
    ref_line: { pPr: RIGHT, rPr: BOLD, styleId: null, numId: null, ilvl: null, label: 'Ref: and Dated: lines, bold, right-aligned' },
    to_line: { pPr: PLAIN, rPr: RUN, styleId: null, numId: null, ilvl: null, label: "'To,' line" },
    addressee: { pPr: ADDRESSEE, rPr: RUN, styleId: null, numId: null, ilvl: null, label: 'addressee and address lines' },
    subject_line: { pPr: SUBJECT, rPr: BOLD_U, styleId: null, numId: null, ilvl: null, label: 'Subject: line, bold underlined' },
    salutation: { pPr: SALUTATION, rPr: RUN, styleId: null, numId: null, ilvl: null, label: 'salutation' },
    body: { pPr: BODY, rPr: RUN, styleId: null, numId: null, ilvl: null, label: 'body paragraph, first line indented' },
    limb_a: { pPr: LIMB, rPr: RUN, styleId: 'ListParagraph', numId: 5, ilvl: 0, label: '(a)/(b)/(c) list item' },
    closing: { pPr: CLOSING, rPr: RUN, styleId: null, numId: null, ilvl: null, label: 'closing line' },
    signatory_name: { pPr: SIGNATORY, rPr: BOLD, styleId: null, numId: null, ilvl: null, label: "signatory's name, bold" },
  },
  tables: {},
  footnote: null,
};
const LETTER_PACK = { kinds: { ...LETTER_KINDS, examples: ['body', 'limb_a'] }, mode: 'shell' };

// The agreement form.
const H1 = '<w:pPr><w:pStyle w:val="Heading1"/><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr>';
const H1_RUN = `<w:rPr>${ARIAL}<w:b/><w:bCs/><w:caps/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`;
const CLAUSE = '<w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="120"/><w:ind w:left="720" w:hanging="720"/><w:jc w:val="both"/></w:pPr>';
const ESCROW_BODY = [
  para('<w:pPr><w:jc w:val="center"/></w:pPr>', 'ESCROW AGREEMENT', BOLD),
  para(PLAIN, 'This Escrow Agreement is made on [●] between [●] (the Company) and [●] (the Escrow Agent).'),
  para(H1, 'Appointment', H1_RUN),
  para(CLAUSE, 'The Company appoints the Escrow Agent to hold the Escrow Account on the terms of this Agreement.'),
  para(H1, 'Fees', H1_RUN),
  para(CLAUSE, 'The Company shall pay the Escrow Agent a fee of PKR [●] each year.'),
  para(H1, 'Governing Law', H1_RUN),
  para(CLAUSE, 'This Agreement is governed by the laws of Pakistan.'),
].join('');
const ESCROW = docx(ESCROW_BODY);
const ESCROW_KINDS = {
  kinds: {
    h1: { pPr: H1, rPr: H1_RUN, styleId: 'Heading1', numId: null, ilvl: null, label: 'article heading, numbered 1., 2.' },
    clause: { pPr: CLAUSE, rPr: RUN, styleId: null, numId: 1, ilvl: 1, label: 'numbered clause 1.1', restart: false },
    plain: { pPr: PLAIN, rPr: RUN, styleId: null, numId: null, ilvl: null, label: 'unnumbered paragraph' },
  },
  tables: {},
  footnote: null,
};
const ESCROW_PACK = { kinds: ESCROW_KINDS, mode: 'form' };

const at = (bytes, text) => [...inspectDocx(bytes, { budget: Infinity }).byRef].find(([, r]) => r.exactText === text)?.[0];
const documentXml = (bytes) => strFromU8(unzipSync(bytes)['word/document.xml']);
const paragraphWith = (xml, text) => (xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? []).find((p) => p.includes(`>${text}</w:t>`));
const pPrOf = (p) => /^<w:p(?:\s[^>]*)?>(<w:pPr>[\s\S]*?<\/w:pPr>)/.exec(p)?.[1].replace(/<w:ins [^>]*\/>/g, '').replace(/<w:rPr><\/w:rPr>/g, '');
const textsOf = (bytes) => [...inspectDocx(bytes, { budget: Infinity }).byRef.values()].filter((r) => r.part === 'word/document.xml').map((r) => r.exactText);

// The ops a shell fill sends: the fixed parts filled, the body written after
// the salutation in the pack's kinds, the two examples (the paragraphs just
// after the salutation) removed.
function shellOps(bytes = LETTER) {
  const n = (t) => at(bytes, t);
  const example = n('Dear Sir,') + 1;
  return [
    { op: 'replace', p: n('Ref: [●]'), expected: 'Ref: [●]', text: 'Ref: AKLA/EW/2026/14' },
    { op: 'replace', p: n('Dated: [●]'), expected: 'Dated: [●]', text: 'Dated: October 20, 2026' },
    { op: 'replace', p: n('Subject: [●]'), expected: 'Subject: [●]', text: 'Subject: Change of the Water Delivery Point' },
    { op: 'write', after: n('Dear Sir,'), expected: 'Dear Sir,', blocks: [
      { kind: 'body', text: 'The Firm writes on behalf of the Company about the notice of October 1, 2026.' },
      { kind: 'limb_a', text: 'the delivery point is fixed by the Agreement; and' },
      { kind: 'limb_a', text: 'no change may be made without the Company\'s consent.' },
      { kind: 'body', text: 'The Company reserves its rights.' },
    ] },
    { op: 'remove_block', from: example, to: example + 1, expected: '[●]' },
  ];
}

// ---------------------------------------------------------------------------
// A stub database: tables with the filters every module here uses, buckets
// of bytes, an rpc that plays save_document_version_as.

function fakeSupabase({ tables = {}, files = {}, errors = {} } = {}) {
  const calls = { upload: [], remove: [], download: [], upsert: [], update: [], insert: [], selected: [], rpc: [] };
  const objects = new Set(Object.keys(files));
  const chain = (table) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    let write = null;
    let cols = '';
    const result = () => {
      const err = typeof errors[table] === 'function' ? errors[table](cols) : errors[table];
      if (err) return { data: null, error: err };
      if (write?.kind === 'update') { for (const r of rows) Object.assign(r, write.patch); return { data: null, error: null }; }
      if (write) return { data: null, error: null };
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const q = {
      select(c) { cols = c ?? ''; calls.selected.push({ table, cols }); return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      in(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      gte(col, val) { rows = rows.filter((r) => r[col] >= val); return q; },
      not(col, op, val) { if (op === 'is' && val === null) rows = rows.filter((r) => r[col] != null); return q; },
      order(col, { ascending } = {}) { rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending === false ? -1 : 1)); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      range() { return q; },
      maybeSingle() { single = true; return q; },
      single() { single = true; return q; },
      insert(row) { write = { kind: 'insert' }; calls.insert.push({ table, row }); (tables[table] ??= []).push(row); return q; },
      update(patch) { write = { kind: 'update', patch }; calls.update.push({ table, patch }); return q; },
      upsert(row, { onConflict } = {}) {
        write = { kind: 'upsert' };
        calls.upsert.push({ table, row, onConflict });
        const list = (tables[table] ??= []);
        const hit = list.find((r) => r[onConflict] === row[onConflict]);
        if (hit) Object.assign(hit, row); else list.push({ ...row });
        return q;
      },
      then(ok, bad) { return Promise.resolve(result()).then(ok, bad); },
    };
    return q;
  };
  return {
    calls, objects, tables, files,
    from: chain,
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      assert.equal(name, 'save_document_version_as');
      if (!objects.has(`matter-documents/${args.p_storage_path}`)) return { data: null, error: { message: 'The uploaded file is unavailable' } };
      const number = 1;
      (tables.document_versions ??= []).push({ id: NEW_V, matter_document_id: args.p_document_id, version_number: number, storage_path: args.p_storage_path, file_name: `${args.p_file_stem}-v${number}.${args.p_extension}`, label: args.p_label });
      return { data: { matterDocumentId: args.p_document_id, versionId: NEW_V, versionNumber: number, fileName: `${args.p_file_stem}-v${number}.${args.p_extension}` }, error: null };
    },
    storage: {
      from: (bucket) => ({
        upload: async (path, body, opts) => { calls.upload.push({ bucket, path, body, opts }); objects.add(`${bucket}/${path}`); files[`${bucket}/${path}`] = body; return { data: { path }, error: null }; },
        remove: async (paths) => { calls.remove.push({ bucket, paths }); for (const p of paths) { objects.delete(`${bucket}/${p}`); delete files[`${bucket}/${p}`]; } return { data: paths, error: null }; },
        download: async (path) => { calls.download.push({ bucket, path }); const f = files[`${bucket}/${path}`]; return f ? { data: new Blob([f]), error: null } : { data: null, error: { message: 'Object not found' } }; },
      }),
    },
  };
}

const letterType = { id: T_LETTER, name: 'Letter / Notice', category: 'Meetings & Correspondence', questionnaire: null };
const escrowType = { id: T_ESCROW, name: 'Escrow Agreement', category: 'Financing & Security', questionnaire: null };
const caType = { id: T_CA, name: 'Concession Agreement', category: 'Project & Concession', questionnaire: null };
const memoType = { id: T_MEMO, name: 'Research Memo', category: 'Reports', questionnaire: null };
const letterRow = { document_type_id: T_LETTER, storage_path: LETTER_PATH, filename: 'Letter - notice [AKLA standard].docx', updated_at: '2026-10-20T08:00:00Z', content_html: 'Ref: [●]', format_rules: 'The firm\'s shell pack, A4 portrait.', kinds: LETTER_PACK.kinds, pack_mode: 'shell', document_type: letterType };
const escrowRow = { document_type_id: T_ESCROW, storage_path: ESCROW_PATH, filename: 'Escrow agreement [AKLA standard].docx', updated_at: '2026-10-20T08:00:00Z', content_html: 'ESCROW AGREEMENT', format_rules: null, kinds: ESCROW_KINDS, pack_mode: 'form', document_type: escrowType };
const caRow = { document_type_id: T_CA, storage_path: CA_PATH, filename: 'Standard Concession Agreement [AKLA].docx', updated_at: '2026-10-01T08:00:00Z', content_html: 'CA', format_rules: null, kinds: null, pack_mode: null, document_type: caType };
const fixtures = () => ({
  matters: [{ id: P1, name: 'EnerTech Water', status: 'active' }],
  matter_documents: [{ id: D1, title: 'Letter to the PD', matter_id: P1, document_type_id: T_LETTER }],
  document_versions: [{ id: V1, matter_document_id: D1, version_number: 1, storage_path: `${P1}/${D1}/x.docx`, file_name: 'x-v1.docx' }],
  document_types: [letterType, escrowType, caType, memoType].map((t) => ({ ...t, standard: { letters: letterRow, escrow: escrowRow, ca: caRow }[t.id === T_LETTER ? 'letters' : t.id === T_ESCROW ? 'escrow' : t.id === T_CA ? 'ca' : 'none'] ?? null })),
  document_type_templates: [letterRow, escrowRow, caRow],
  document_template_versions: [
    { id: 'v-letter', document_type_id: T_LETTER, storage_path: LETTER_PATH, filename: letterRow.filename, created_at: '2026-10-20T08:00:00Z', kinds: LETTER_PACK.kinds, pack_mode: 'shell' },
    { id: 'v-old', document_type_id: T_LETTER, storage_path: `standards/${T_LETTER}/0-old.docx`, filename: 'old.docx', created_at: '2026-09-01T08:00:00Z', kinds: null, pack_mode: null },
  ],
  connector_actions: [],
});
const FILES = () => ({ [`precedent-library/${LETTER_PATH}`]: LETTER, [`precedent-library/${ESCROW_PATH}`]: ESCROW });

const ctxOf = () => ({ userId: USER, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', canWrite: true, recheck: async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' }) });
function connector({ modules, tables = fixtures(), files = FILES() } = {}) {
  clearStandardCache();
  const supabase = fakeSupabase({ tables, files });
  const log = () => {};
  const writes = createProjectWrites({ supabase, hubUrl: HUB, now: () => new Date(CLOCK), log });
  const list = createHubTools({ supabase, voyageKey: 'v', library: { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] }, readFile: async () => ({ blocks: [] }), log, hubUrl: `${HUB}/`, modules, writes, now: () => CLOCK });
  const byName = Object.fromEntries(list.map((x) => [x.name, x]));
  return { supabase, tables, run: (name, input) => byName[name].run(input, ctxOf()), byName };
}

// ---------------------------------------------------------------------------
// draftingPacks.js

test('the synthetic packs\' kinds lists are valid, and packOf reads a pack off a template row', () => {
  assert.deepEqual(validateKinds(LETTER_KINDS), []);
  assert.deepEqual(validateKinds(LETTER_PACK.kinds), [], 'the examples list beside the kinds is allowed');
  assert.deepEqual(validateKinds(ESCROW_KINDS), []);
  assert.deepEqual(packOf(letterRow), { kinds: LETTER_PACK.kinds, mode: 'shell' });
  assert.deepEqual(packOf(escrowRow), { kinds: ESCROW_KINDS, mode: 'form' });
  assert.deepEqual(packOf({ kinds: ESCROW_KINDS }), { kinds: ESCROW_KINDS, mode: 'form' }, 'no mode is a form pack');
  for (const row of [caRow, null, {}, { kinds: [] }, { kinds: { kinds: {} } }, { kinds: 'x' }]) assert.equal(packOf(row), null);
  assert.equal(PACK_COLUMNS, 'kinds, pack_mode');
});

test('withPackColumns reads again without the pack columns when the database does not have them yet', async () => {
  const seen = [];
  const missing = await withPackColumns(async (withPack) => { seen.push(withPack); return withPack ? { data: null, error: { message: 'column document_type_templates.kinds does not exist' } } : { data: { storage_path: 'x' }, error: null }; });
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(missing, { data: { storage_path: 'x' }, error: null });
  seen.length = 0;
  const other = await withPackColumns(async (withPack) => { seen.push(withPack); return { data: null, error: { message: 'permission denied' } }; });
  assert.deepEqual(seen, [true], 'another error is not retried');
  assert.equal(other.error.message, 'permission denied');
});

test('packPromptBlock: the shell\'s three steps, the form\'s new-clause rule, the edit note, each with the kinds listing', () => {
  const shell = packPromptBlock(LETTER_PACK);
  assert.ok(shell.startsWith(SHELL_PACK_INSTRUCTIONS));
  assert.ok(shell.endsWith(kindsListing(LETTER_PACK.kinds)));
  assert.match(shell, /1\. Fill the fixed parts: replace each \[●\]/);
  assert.match(shell, /2\. Write the body with "write" operations/);
  assert.match(shell, /never use insert_after for the body/);
  assert.match(shell, /3\. Remove each \[●\] example paragraph with "remove_block"/);
  assert.match(shell, /"the Firm", never "we"/);
  assert.match(shell, /British spelling \(-ise\)/);
  assert.match(shell, /KINDS YOU CAN WRITE: ref_line \(Ref: and Dated: lines, bold, right-aligned\), to_line/);
  const form = packPromptBlock(ESCROW_PACK);
  assert.ok(form.startsWith(FORM_PACK_INSTRUCTIONS));
  assert.ok(form.includes(`"${NEW_CLAUSE_COMMENT}"`));
  assert.equal(NEW_CLAUSE_COMMENT, "New clause — not in the firm's precedents: <why>");
  assert.match(form, /placed where its subject belongs/);
  assert.match(form, /"repeat_block" the firm's own/);
  assert.match(form, /"add_row"/);
  assert.match(form, /"remove_block" it together with its heading/);
  const editing = packPromptBlock(LETTER_PACK, { editing: true });
  assert.match(editing, /^THIS DOCUMENT WAS DRAFTED FROM THE FIRM'S SHELL PACK\./);
  assert.ok(editing.endsWith(kindsListing(LETTER_PACK.kinds)));
  assert.equal(packPromptBlock(null), '');
  // OPS_PROTOCOL names the line the listing starts with.
  assert.ok(OPS_PROTOCOL.includes('"KINDS YOU CAN WRITE"'));
});

test('packMap says which blank paragraph of a shell is a fixed part and which an example to remove', () => {
  const map = packMap(LETTER, LETTER_PACK);
  assert.ok(map.startsWith('WHICH KIND EACH BLANK PARAGRAPH IS:\n'));
  assert.ok(map.includes(`¶${at(LETTER, 'Dear Sir,') + 1} body: an example`), 'by the ¶ number the listing shows');
  const lines = map.split('\n').slice(1);
  assert.deepEqual(lines.map((l) => l.replace(/^¶\d+ /, '')), [
    'addressee: a fixed part, to fill',
    'body: an example, to remove once the body is written',
    'limb_a: an example, to remove once the body is written',
    'signatory_name: a fixed part, to fill',
  ]);
  assert.equal(packMap(ESCROW, ESCROW_PACK), '', 'a form pack has no map');
  assert.equal(packMap(LETTER, { kinds: LETTER_KINDS, mode: 'shell' }).split('\n')[2].replace(/^¶\d+ /, ''), 'body', 'without the examples list only the kind is named');
});

test('a shell fill as the Hub runs it: the kinds go to the engine, the body takes the pack\'s look, the examples go, and the format matches the pack', async () => {
  const view = inspectDocx(LETTER, { placeholders: true });
  const ops = shellOps();
  const out = await applyDocxOps(LETTER, ops, view.byRef, { kinds: LETTER_PACK.kinds });
  assert.deepEqual(out.results.map((r) => [r.kind, r.status, r.reason ?? null]), [['replace', 'applied', null], ['replace', 'applied', null], ['replace', 'applied', null], ['write', 'applied', null], ['remove_block', 'applied', null]]);
  const filled = acceptChangesBy(out.bytes);
  assert.deepEqual(textsOf(filled), [
    'Ref: AKLA/EW/2026/14', 'Dated: October 20, 2026', 'To,', '[●]', 'Subject: Change of the Water Delivery Point', 'Dear Sir,',
    'The Firm writes on behalf of the Company about the notice of October 1, 2026.', 'the delivery point is fixed by the Agreement; and', 'no change may be made without the Company\'s consent.', 'The Company reserves its rights.',
    'Yours faithfully,', '[●]',
  ]);
  const xml = documentXml(filled);
  assert.equal(pPrOf(paragraphWith(xml, 'The Company reserves its rights.')), BODY, 'a body paragraph has the example body paragraph\'s own format');
  assert.equal(pPrOf(paragraphWith(xml, 'the delivery point is fixed by the Agreement; and')).replace(/<w:numId w:val="\d+"\/>/, '<w:numId w:val="5"/>'), LIMB, 'a limb is on the pack\'s (a) list');
  const check = checkFormat(filled, LETTER, { base: 'Letter - notice [AKLA standard].docx' });
  assert.equal(check.result.status, 'matches', JSON.stringify(check.result.findings));
  assert.equal(check.text, "Format matches the firm's standard (Letter - notice [AKLA standard]).");
  // Without the pack's kinds the body cannot be written: the kinds are what make it work.
  const bare = await applyDocxOps(LETTER, ops, view.byRef);
  const write = bare.results.find((r) => r.kind === 'write');
  assert.equal(write.status, 'skipped');
  assert.match(write.reason, /no kinds of paragraph are listed/);
});

test('a form fill: a new clause in the pack\'s clause kinds, the new-clause comment on its anchor, the format matches', async () => {
  const view = inspectDocx(ESCROW, { placeholders: true, budget: Infinity });
  const fees = 'The Company shall pay the Escrow Agent a fee of PKR [●] each year.';
  const p = at(ESCROW, fees);
  const ops = [
    { op: 'replace', p, expected: fees, text: 'The Company shall pay the Escrow Agent a fee of PKR 500,000/- (Pakistani Rupees Five Hundred Thousand Only) each year.' },
    { op: 'write', after: p, expected: fees, blocks: [{ kind: 'h1', text: 'Sanctions' }, { kind: 'clause', text: 'Each Party shall comply with the sanctions laws that apply to it.' }] },
    { op: 'comment', p, expected: fees, text: `${NEW_CLAUSE_COMMENT.replace('<why>', 'the lenders asked for a sanctions clause')} (Sanctions, after this clause).` },
  ];
  const out = await applyDocxOps(ESCROW, ops, view.byRef, { kinds: ESCROW_KINDS });
  assert.deepEqual(out.results.map((r) => r.status), ['applied', 'applied', 'applied']);
  const filled = acceptChangesBy(out.bytes);
  const texts = textsOf(filled);
  assert.deepEqual(texts.slice(texts.indexOf('Fees'), texts.indexOf('Governing Law') + 1), ['Fees', 'The Company shall pay the Escrow Agent a fee of PKR 500,000/- (Pakistani Rupees Five Hundred Thousand Only) each year.', 'Sanctions', 'Each Party shall comply with the sanctions laws that apply to it.', 'Governing Law']);
  const xml = documentXml(filled);
  assert.equal(pPrOf(paragraphWith(xml, 'Sanctions')), H1, 'the heading takes the pack\'s heading format');
  assert.equal(pPrOf(paragraphWith(xml, 'Each Party shall comply with the sanctions laws that apply to it.')), CLAUSE, 'the clause runs on the clause list (restart: false)');
  const comments = strFromU8(unzipSync(filled)['word/comments.xml']);
  assert.match(comments, /New clause — not in the firm(?:'|&apos;)s precedents: the lenders asked for a sanctions clause/);
  assert.equal(checkFormat(filled, ESCROW, { base: 'Escrow agreement [AKLA standard].docx' }).result.status, 'matches');
});

test('packForBase: the standard\'s own row, the filing by path for an older draft, nothing for a file not from a standard, nothing before the migration', async () => {
  const supabase = fakeSupabase({ tables: fixtures() });
  assert.deepEqual(await packForBase(supabase, { templatePath: LETTER_PATH }, letterRow), { kinds: LETTER_PACK.kinds, mode: 'shell' });
  assert.equal(supabase.calls.selected.length, 0, 'the template row read already carries the pack');
  assert.deepEqual(await packForBase(supabase, { templatePath: LETTER_PATH }, escrowRow), { kinds: LETTER_PACK.kinds, mode: 'shell' }, 'another path: its filing');
  assert.equal(await packForBase(supabase, { templatePath: `standards/${T_LETTER}/0-old.docx` }, null), null, 'a filing that was not a pack');
  assert.equal(await packForBase(supabase, { templatePath: null }, letterRow), null);
  assert.equal(await packForBase(supabase, {}, null), null);
  // Before the migration: no pack columns anywhere, and a select naming them fails.
  const old = fixtures();
  old.document_template_versions = old.document_template_versions.map(({ kinds, pack_mode, ...rest }) => rest);
  const before = fakeSupabase({ tables: old, errors: { document_template_versions: (cols) => (/kinds/.test(cols) ? { message: 'column document_template_versions.kinds does not exist' } : null) } });
  assert.equal(await packForBase(before, { templatePath: LETTER_PATH }, { storage_path: LETTER_PATH }), null, 'the template row without the columns, then the filing without them');
  assert.deepEqual(before.calls.selected.map((s) => s.cols), [`storage_path, ${PACK_COLUMNS}`, 'storage_path']);
});

test('packTypesOf and packTypeFor: which types have a pack, and whether a document written as text is one of them', async () => {
  const supabase = fakeSupabase({ tables: fixtures() });
  const types = await packTypesOf(supabase);
  assert.deepEqual(types, [{ id: T_LETTER, name: 'Letter / Notice', mode: 'shell' }, { id: T_ESCROW, name: 'Escrow Agreement', mode: 'form' }]);
  assert.deepEqual(await packTypesOf({ from() { throw new Error('no such method'); } }), [], 'a failed read is no pack types, not a failed turn');
  assert.deepEqual(await packTypesOf(fakeSupabase({ errors: { document_type_templates: { message: 'column document_type_templates.pack_mode does not exist' } } })), []);
  const letter = types[0];
  assert.equal(packTypeFor({ documentTypeId: T_LETTER, title: 'Anything' }, types), letter, 'by the type it was drafted under');
  assert.equal(packTypeFor({ title: 'Letter to the Project Director — water delivery point' }, types), letter, 'by the head of its title');
  assert.equal(packTypeFor({ title: 'Draft', markdown: '# Letter to the PD\n\nText' }, types), letter, 'by its first heading');
  assert.equal(packTypeFor({ title: 'Escrow Agreement — KPQC' }, types), types[1]);
  assert.equal(packTypeFor({ title: 'Note', markdown: '**Ref:** AKLA/1\n\n**Subject:** Delivery point\n\nDear Sir,\n\nWe write…' }, types), letter, 'by a letter\'s own lines');
  assert.equal(packTypeFor({ title: 'Notes on the Escrow Agreement', markdown: '# Notes on the Escrow Agreement\n\n## What it does' }, types), null, 'notes on a document are not that document');
  assert.equal(packTypeFor({ title: 'Notes on the letter' }, types), null);
  assert.equal(packTypeFor({ title: 'Letter to the PD' }, []), null, 'no pack types, no pack');
  assert.equal(packTypeFor({ documentTypeId: T_CA, title: 'Concession Agreement' }, types), null, 'a type with no pack');
  // The pointer the Hub adds names a request that reaches the pack.
  const pointer = packPointer('Letter / Notice');
  assert.match(pointer, /^The firm drafts a Letter \/ Notice in its own Word file, so this is kept as text and not set in the general house layout\./);
  const ask = /ask: "([^"]+)"/.exec(pointer)[1];
  assert.deepEqual(inferDraftSkill(ask, [letterType, escrowType, caType]), { key: 'draft', documentTypeId: T_LETTER });
  assert.equal(packRedirectSentence({ id: T_LETTER, name: 'Letter / Notice' }), `Letter / Notice is drafted in the firm's own Word file, so nothing was saved: open it with open_standard_for_filling (documentTypeId ${T_LETTER}) and file the draft with fill_standard_to_project.`);
});

test('packFormatRules: the page, margins, body font and size, heading styles and kinds, from the pack\'s fingerprint', () => {
  const rules = packFormatRules(fingerprint(LETTER), LETTER_PACK.kinds, 'shell');
  assert.match(rules, /^The firm's shell pack, A4 portrait, margins 2\.54 cm top, 3 cm bottom, 2\.54 cm left, 2\.54 cm right\./);
  assert.match(rules, /Body text Arial 11 pt\./);
  assert.match(rules, /Heading styles: level 1 "Heading1"\./);
  assert.match(rules, /Paragraph kinds: ref_line \(Ref: and Dated: lines, bold, right-aligned\), to_line/);
  assert.match(rules, /Word numbers every clause and limb; never type a number\. Blanks are \[●\]\.$/);
});

// ---------------------------------------------------------------------------
// The Hub (server.js, read as source)

test('a letter, memo or opinion request lands on its pack type, and a type with a Word standard drafts through the fill path', () => {
  const types = [letterType, escrowType, caType, memoType, { id: 'op', name: 'Legal Opinion' }, { id: 'mm', name: 'Meeting Minutes' }, { id: 'br', name: 'Board Resolution' }, { id: 'noc', name: 'Certificate / Consent / NOC' }, { id: 'cpl', name: 'Client Proposal Letter' }];
  const id = (m) => inferDraftSkill(m, types)?.documentTypeId ?? null;
  assert.equal(id('Draft a letter to the Project Director on the water delivery point'), T_LETTER);
  assert.equal(id('write me a short letter to the client'), T_LETTER);
  assert.equal(id('Write a termination notice to the contractor'), T_LETTER);
  assert.equal(id('Draft a memo on section 7 of the PPP Act'), T_MEMO);
  assert.equal(id('Prepare a research memo on sales tax'), T_MEMO);
  assert.equal(id('Draft an opinion on enforceability'), 'op');
  assert.equal(id('prepare the minutes of the board meeting'), 'mm');
  assert.equal(id('draft a board resolution authorising the lead member'), 'br');
  assert.equal(id('Draft an NOC for the lenders'), 'noc');
  assert.equal(id('draft a proposal letter for the client'), 'cpl', 'the longer everyday name wins');
  assert.equal(id('draft an escrow agreement for the KPQC project'), T_ESCROW);
  // Not a new document of a pack type.
  for (const m of ['draft a letter of credit', 'create a summary of the letter', 'write your opinion on this clause', 'draft a notice clause for the agreement', 'draft a side letter', 'draft me a project proposal using the report', 'Explain this letter']) assert.equal(id(m), null, m);
  assert.equal(id('draft a concession agreement'), T_CA, 'a full name still wins');

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // A draft of a type whose standard is a Word file (every pack is) opens that file: the fill path.
  assert.match(server, /\} else if \(documentType && \/\\\.docx\$\/i\.test\(templateRow\?\.storage_path \?\? ""\)\) \{\n\s+\/\/ Drafting a type the firm has a standard for is a fill-in job/);
  // The free (Markdown) draft is only for a type with no Word standard.
  assert.match(server, /\} else if \(skill\?\.key === "draft" && documentType\) \{[\s\S]{0,400}This type has no Word standard on the Hub/);
});

test('server.js reads the pack with the standard, passes its kinds on every fill and edit, and shows them beside the protocol', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /import \{ packForBase, packPromptBlock, packMap, packTypesOf, packTypeFor, packPointer, withPackColumns, PACK_COLUMNS \} from "\.\/draftingPacks\.js";/);
  assert.ok(server.includes('await withPackColumns((withPack) => supabase.from("document_type_templates").select(`content_html, format_rules, storage_path, filename${withPack ? `, ${PACK_COLUMNS}` : ""}`)'), 'the type\'s standard is read with its pack');
  assert.ok(server.includes('await withPackColumns((withPack) => supabase.from("document_template_versions").select(`content_html, format_rules, storage_path, filename${withPack ? `, ${PACK_COLUMNS}` : ""}`)'), 'and so is a pinned filing');
  const bytes = server.indexOf('docxBase.bytes = new Uint8Array(await blob.arrayBuffer());');
  const pack = server.indexOf('docxBase.pack = await packForBase(supabase, docxBase, templateRow);');
  const inspect = server.indexOf('docxBase.inspection = inspectDocx(docxBase.bytes, shellFill ? { query: inspectQuery } : docxBase.standard && !docxBase.revising ? { placeholders: true }');
  assert.ok(bytes > 0 && pack > bytes && inspect > pack && server.indexOf('docxBase.packMap = docxBase.pack ? packMap(docxBase.bytes, docxBase.pack) : "";') > inspect, 'the pack of every Word file worked on, once its bytes are read; a shell is listed whole');
  assert.ok(server.includes('const shellFill = docxBase.standard && !docxBase.revising && docxBase.pack?.mode === "shell";'));
  // The engine gets the kinds on every turn that changes the file.
  assert.ok(server.includes('const out = await applyDocxOps(docxBase.bytes, aligned, docxBase.inspection.byRef, { idFloor: await highestRecordedId(supabase, root.id), ...(docxBase.pack ? { kinds: docxBase.pack.kinds } : {}) });'));
  assert.equal((server.match(/applyDocxOps\(docxBase\.bytes/g) ?? []).length, 1, 'there is one such call');
  // The fill prompt: instructions, format, the pack's block, then the protocol.
  assert.ok(server.includes('${FILL_INSTRUCTIONS}${templateRules?.trim() ? `\\n\\nHow the standard is formatted: ${templateRules.trim()}` : ""}${packBlock}${earlierText}\\n\\n${OPS_PROTOCOL}\\n\\n${FILL_DIRECT_NOTE}`'));
  assert.ok(server.includes('const packBlock = docxBase.pack ? `\\n\\n${packPromptBlock(docxBase.pack, { editing: docxBase.bucket !== "precedent-library" })}${docxBase.packMap ? `\\n${docxBase.packMap}` : ""}` : "";'));
  // The edit prompt: the edit note and kinds before the protocol.
  assert.ok(server.includes('${docxBase.pack ? `\\n\\n${packPromptBlock(docxBase.pack, { editing: true })}${docxBase.packMap ? `\\n${docxBase.packMap}` : ""}` : ""}\\n\\n${OPS_PROTOCOL}`;'));
  // The format gate still runs after the accept and before the upload.
  const accept = server.indexOf('if (fillIn && out.applied > 0) out.bytes = acceptChangesBy(out.bytes);');
  assert.ok(accept > server.indexOf('const out = await applyDocxOps(docxBase.bytes') && server.indexOf('checkFormat(out.bytes, docxBase.bytes', accept) > accept);
});

test('persistReply never sets a document of a pack type in the general house layout, and such a text is not converted on the next turn', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('async function persistReply(supabase, p) {');
  const end = server.indexOf('\nfunction readJsonBody', start);
  const body = server.slice(start, end);
  assert.ok(body.includes('const packTypes = opened ? p.packTypes ?? await packTypesOf(supabase) : [];'));
  assert.ok(body.includes('const packType = packTypeFor({ documentTypeId: p.artifactData?.documentTypeId, title, markdown }, packTypes);'));
  assert.ok(body.includes('for (let attempt = 0; attempt < 2 && !word && !packType; attempt++) {'), 'the house render is skipped for a pack type');
  assert.ok(body.indexOf('!packType; attempt++') < body.indexOf('storeAklaWord('));
  assert.ok(body.includes('...(packType ? { packTypeId: packType.id, packTypeName: packType.name } : {})'));
  assert.ok(body.includes('const line = packPointer(name);'));
  // The next turn: no house render, and the text is the body's starting point in the fill.
  assert.ok(server.includes('if (latest && latest.kind !== "docx" && !d.editSource && !d.packTypeId && latest.content?.trim() && !isContinuation && !reviewOfOtherFile) {'));
  assert.ok(server.includes('if ((latest?.kind === "draft" || d.packTypeId) && skill) currentDraft = latest.content;'));
  assert.ok(server.includes('const earlierText = docxBase.pack && currentDraft?.trim()'));
});

// ---------------------------------------------------------------------------
// The connector

test('open_standard_for_filling: a shell pack is listed whole, with the shell\'s steps, its kinds, the map of its blanks and the connector\'s pack note', async () => {
  const c = connector({ modules: [fillStandard] });
  const out = await c.run('open_standard_for_filling', { documentTypeId: T_LETTER });
  assert.match(out, /This standard is the firm's shell pack for Letter \/ Notice: its fixed parts are filled and its body is written in the pack's paragraph kinds, as the instructions below say\./);
  assert.ok(out.includes(packPromptBlock(LETTER_PACK)), 'the shell\'s steps and kinds, as the Hub shows them');
  assert.ok(out.includes(packMap(LETTER, LETTER_PACK)), 'which blank is which');
  assert.ok(out.includes(CONNECTOR_PACK_NOTE));
  assert.ok(out.indexOf(packPromptBlock(LETTER_PACK)) < out.indexOf(OPS_PROTOCOL) && out.indexOf(CONNECTOR_FILL_NOTE) < out.indexOf(CONNECTOR_PACK_NOTE), 'beside the protocol, the pack note after the connector note');
  assert.match(CONNECTOR_PACK_NOTE, /fill_standard_to_project also takes "write", "repeat_block", "add_row" and "remove_block"/);
  // Every paragraph, the fixed ones without a blank too.
  assert.match(out, /All 11 paragraphs are listed\./);
  assert.match(out, /\n¶\d+ Dear Sir,\n/);
  assert.match(out, /\n¶\d+ Yours faithfully,\n/);
  // A form pack: the form's instructions, the placeholder listing as before.
  const form = await c.run('open_standard_for_filling', { documentTypeId: T_ESCROW });
  assert.ok(form.includes(packPromptBlock(ESCROW_PACK)));
  assert.ok(!form.includes('WHICH KIND EACH BLANK PARAGRAPH IS'));
  assert.match(form, /This standard is the firm's form pack for Escrow Agreement: its blanks are filled and a new clause is written in the pack's clause kinds/);
});

test('fill_standard_to_project passes the pack\'s kinds, takes the block operations, and files a shell fill that matches the pack', async () => {
  // The kinds reach the engine.
  const seen = [];
  const stub = async (bytes, ops, byRef, opts) => { seen.push(opts); return applyDocxOps(bytes, ops, byRef, opts); };
  const c = connector({ modules: [{ file: 'fillStandardWrite.js', tools: (deps) => createFillStandardTools(deps, { apply: stub }) }] });
  const out = await c.run(FILL_TOOL, { documentTypeId: T_LETTER, projectId: P1, title: 'Letter to the PD on the delivery point', templateHash: sha256(LETTER), ops: shellOps() });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kinds, LETTER_PACK.kinds, 'the pack\'s own kinds list');
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.match(out, /^Drafted "Letter to the PD on the delivery point" from the firm's Letter \/ Notice standard/);
  assert.match(out, /Changes: 5 of 5 made/);
  assert.match(out, /Format matches the firm's standard \(Letter - notice \[AKLA standard\]\)\./);
  const filed = c.supabase.calls.upload.find((u) => u.bucket === 'matter-documents');
  const texts = textsOf(filed.body);
  assert.ok(texts.includes('The Company reserves its rights.'));
  assert.equal(texts.filter((t) => t === '[●]').length, 2, 'the addressee and the signatory stay blank; the body example went');
  // A standard that is not a pack: no kinds, so a write is refused by the engine.
  const plain = fixtures();
  plain.document_type_templates[0] = { ...letterRow, kinds: null, pack_mode: null };
  const seenPlain = [];
  const d = connector({ tables: plain, modules: [{ file: 'fillStandardWrite.js', tools: (deps) => createFillStandardTools(deps, { apply: async (b, o, r, opts) => { seenPlain.push(opts); return applyDocxOps(b, o, r, opts); } }) }] });
  const refused = await d.run(FILL_TOOL, { documentTypeId: T_LETTER, projectId: P1, title: 'Letter', templateHash: sha256(LETTER), ops: shellOps() });
  assert.equal(seenPlain[0].kinds, undefined);
  assert.match(refused, /Could not be made[\s\S]*no kinds of paragraph are listed/);
});

test('readOps takes the block operations by their own paragraph fields and refuses a malformed one in one sentence', () => {
  assert.deepEqual(readOps([
    { op: 'write', after: '9', expected: 'Dear Sir,', blocks: [{ kind: 'body', text: 'Text.' }, { kind: 'fees', rows: [['A', 'B'], ['1', '2']] }], why: ' the  body ' },
    { op: 'repeat_block', from: 3, to: 5, after: 5, expected: 'To,' },
    { op: 'add_row', like_row: 12, cells: ['x', 'y'], expected: 'a' },
    { op: 'add_row', table: 11, like_row: 12, cells: ['x'], expected: 'a' },
    { op: 'remove_block', from: 7, to: 8, expected: '[●]', p: 99, text: 'ignored' },
  ]), [
    { op: 'write', after: 9, blocks: [{ kind: 'body', text: 'Text.' }, { kind: 'fees', rows: [['A', 'B'], ['1', '2']] }], expected: 'Dear Sir,', why: 'the body' },
    { op: 'repeat_block', from: 3, to: 5, after: 5, expected: 'To,' },
    { op: 'add_row', like_row: 12, cells: ['x', 'y'], expected: 'a' },
    { op: 'add_row', like_row: 12, table: 11, cells: ['x'], expected: 'a' },
    { op: 'remove_block', from: 7, to: 8, expected: '[●]' },
  ]);
  assert.throws(() => readOps([{ op: 'write', expected: 'x', blocks: [{ kind: 'body', text: 'y' }] }]), /^Error: Change 1: write needs after, a paragraph's number \(¶n\) from the listing\.$/);
  assert.throws(() => readOps([{ op: 'write', after: 2, expected: 'x', blocks: [] }]), /Change 1: write needs blocks/);
  assert.throws(() => readOps([{ op: 'write', after: 2, expected: 'x', blocks: [{ kind: 'body', text: '  ' }] }]), /Change 1, block 1: a "body" block needs text\./);
  assert.throws(() => readOps([{ op: 'write', after: 2, expected: 'x', blocks: [{ text: 'y' }] }]), /Change 1, block 1: kind must be one of the pack's kinds/);
  assert.throws(() => readOps([{ op: 'remove_block', from: 2, expected: 'x' }]), /Change 1: remove_block needs to/);
  assert.throws(() => readOps([{ op: 'remove_block', from: 2, to: 3 }]), /Change 1: expected must be the exact current text of ¶2\./);
  assert.throws(() => readOps([{ op: 'add_row', like_row: 2, expected: 'x', cells: [] }]), /Change 1: add_row needs cells/);
});

test('list_document_types and read_standard say which types have a pack and which tools draft from it', async () => {
  const c = connector({ modules: [standards] });
  const list = await c.run('list_document_types', {});
  assert.match(list, /4 document types on the Hub: 3 with a standard \(2 of them a firm pack: a draft of that type is written into the firm's own Word file with open_standard_for_filling and fill_standard_to_project\)/);
  const block = (name) => list.slice(list.indexOf(`- ${name}`), list.indexOf('\n- ', list.indexOf(`- ${name}`) + 2) >>> 0);
  assert.match(block('Letter / Notice'), /a firm pack \(shell: the firm's fixed parts and paragraph kinds; the body is written into it\): draft with open_standard_for_filling, then fill_standard_to_project, never save_draft_to_project/);
  assert.match(block('Escrow Agreement'), /a firm pack \(form: the firm's settled text with blanks, and its clause kinds for a new clause\)/);
  assert.doesNotMatch(block('Concession Agreement'), /firm pack/);
  const read = await c.run('read_standard', { documentTypeId: T_LETTER });
  assert.match(read, /This standard is a firm pack \(shell:[^)]*\): draft with open_standard_for_filling, then fill_standard_to_project, never save_draft_to_project\./);
  const ca = await c.run('read_standard', { documentTypeId: T_CA });
  assert.doesNotMatch(ca, /firm pack/);
});

test('save_draft_to_project answers with one sentence and saves nothing for a document of a pack type; other drafts are rendered as before', async () => {
  const renders = [];
  const render = async (args) => { renders.push(args); return { bytes: new Uint8Array([0x50, 0x4b, 3, 4]), warnings: [], check: { status: 'checked', findings: [], sections: 1, comments: 0 } }; };
  const c = connector({ modules: [{ file: 'saves.js', tools: (deps) => createSaveTools(deps, { render }) }] });
  const sentence = packRedirectSentence({ id: T_LETTER, name: 'Letter / Notice' });
  // By the type named, by the title, by a letter's own lines, by the document's own type.
  assert.equal(await c.run(DRAFT_TOOL, { projectId: P1, title: 'Draft', documentTypeId: T_LETTER, markdown: '# Draft\n\nText.' }), sentence);
  assert.equal(await c.run(DRAFT_TOOL, { projectId: P1, title: 'Letter to the Project Director', markdown: 'Text.' }), sentence);
  assert.equal(await c.run(DRAFT_TOOL, { projectId: P1, title: 'Delivery point', markdown: 'Ref: AKLA/1\n\nSubject: Delivery point\n\nDear Sir,\n\nText.' }), sentence);
  assert.equal(await c.run(DRAFT_TOOL, { projectId: P1, matterDocumentId: D1, expectedVersionId: V1, title: 'Next', markdown: 'Text.' }), sentence, 'the next version of a letter');
  assert.equal(await c.run(DRAFT_TOOL, { projectId: P1, title: 'Escrow Agreement — KPQC', markdown: '# ESCROW AGREEMENT' }), packRedirectSentence({ id: T_ESCROW, name: 'Escrow Agreement' }));
  assert.equal(renders.length, 0, 'nothing was rendered');
  assert.equal(c.supabase.calls.upload.length, 0, 'nothing was uploaded');
  assert.equal(c.tables.connector_actions.length, 0, 'nothing to record: nothing was attempted');
  assert.equal(sentence.split('. ').length, 1, 'one sentence');
  // Notes, and a type with no pack, are saved as before.
  const notes = await c.run(DRAFT_TOOL, { projectId: P1, title: 'Notes on the Escrow Agreement', markdown: '# Notes on the Escrow Agreement\n\n## What it does\n\nText.' });
  assert.match(notes, /^Saved "Notes on the Escrow Agreement" as v1/);
  assert.equal(renders.length, 1);
});

// ---------------------------------------------------------------------------
// upload_packs.mjs

function packsFolder({ kinds = LETTER_KINDS, extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'packs-'));
  mkdirSync(join(dir, '01 letters'));
  writeFileSync(join(dir, '01 letters', 'letter-pack.docx'), LETTER);
  writeFileSync(join(dir, '01 letters', 'kinds.json'), JSON.stringify(kinds));
  mkdirSync(join(dir, '08 escrow agreement'));
  writeFileSync(join(dir, '08 escrow agreement', 'escrow-agreement-pack.docx'), ESCROW);
  writeFileSync(join(dir, '08 escrow agreement', 'kinds.json'), JSON.stringify(ESCROW_KINDS));
  writeFileSync(join(dir, 'packs-config.json'), JSON.stringify({ packs: {
    letters: { folder: '01 letters', kind: 'letter', mode: 'shell', title: 'Letter / notice', shell: { examples: { 12: 'body', 14: 'limb_a', 20: 'not_a_kind' } } },
    escrow: { folder: '08 escrow agreement', kind: 'escrow-agreement', mode: 'form', title: 'Escrow agreement' },
    ...extra,
  } }));
  return dir;
}
const uploadTables = () => ({ document_types: [letterType, escrowType, caType], document_type_templates: [], document_template_versions: [] });
const PACK_TYPES = { letters: 'Letter / Notice', escrow: 'Escrow Agreement', ca: 'Concession Agreement' };

test('upload_packs.mjs: the arguments, the file name, and a dry run against the database that writes nothing', async () => {
  assert.deepEqual(parseArgs(['/x/packs', '--dry-run', '--only', 'letters, memo']), { packsDir: '/x/packs', dryRun: true, only: ['letters', 'memo'], by: null, help: false });
  assert.deepEqual(parseArgs(['--only=escrow', '/p', `--by=${USER}`]), { packsDir: '/p', dryRun: false, only: ['escrow'], by: USER, help: false });
  assert.throws(() => parseArgs(['/a', '/b']), /One packs folder only/);
  assert.throws(() => parseArgs(['--force']), /Unknown option --force/);
  assert.equal(standardFileName('Letter / notice'), 'Letter - notice [AKLA standard].docx');
  assert.equal(standardFileName('Board resolution (certified copy)'), 'Board resolution (certified copy) [AKLA standard].docx');
  assert.equal(sanitizeStorageFilename('Letter - notice [AKLA standard].docx'), 'Letter-notice-AKLA-standard.docx');
  assert.ok(PROTECTED.test('Concession Agreement') && PROTECTED.test('RFP Volume I') && !PROTECTED.test('Escrow Agreement'));
  assert.equal(canonical({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');

  const dir = packsFolder();
  try {
    const supabase = fakeSupabase({ tables: uploadTables() });
    const rows = await uploadPacks({ supabase, packsDir: dir, dryRun: true, packTypes: PACK_TYPES, now: () => CLOCK });
    assert.deepEqual(rows.map((r) => [r.pack, r.type, r.mode, r.kinds, r.action]), [['letters', 'Letter / Notice', 'shell', '9', 'would upload'], ['escrow', 'Escrow Agreement', 'form', '3', 'would upload']]);
    assert.equal(rows[0].detail, "Letter - notice [AKLA standard].docx; the type's first standard");
    assert.deepEqual([supabase.calls.upload, supabase.calls.upsert, supabase.calls.update, supabase.calls.insert], [[], [], [], []], 'a dry run writes nothing');
    const printed = table(rows);
    assert.match(printed, /^PACK\s+TYPE\s+MODE\s+KINDS\s+ACTION\s+DETAIL\n/);
    assert.match(printed, /letters\s+Letter \/ Notice\s+shell\s+9\s+would upload/);
    // Offline: the packs alone.
    const offline = await uploadPacks({ supabase: null, packsDir: dir, dryRun: true, packTypes: PACK_TYPES });
    assert.deepEqual(offline.map((r) => r.action), ['would upload', 'would upload']);
    assert.match(offline[0].detail, /^offline: packs checked, database not read/);
    await assert.rejects(uploadPacks({ supabase: null, packsDir: dir, packTypes: PACK_TYPES }), /Uploading needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upload_packs.mjs: the upload writes the standard and its filing with the pack columns, a second run changes nothing, and a broken or protected pack is refused', async () => {
  const dir = packsFolder({ extra: {
    ca: { folder: '01 letters', kind: 'letter', mode: 'form', title: 'CA' },
    broken: { folder: '01 letters', kind: 'letter', mode: 'sideways', title: 'Broken' },
    unknown: { folder: '01 letters', kind: 'letter', mode: 'shell', title: 'No type' },
  } });
  try {
    const tables = uploadTables();
    const supabase = fakeSupabase({ tables });
    const rows = await uploadPacks({ supabase, packsDir: dir, packTypes: { ...PACK_TYPES, broken: 'Escrow Agreement' }, now: () => CLOCK, by: USER });
    assert.deepEqual(rows.map((r) => [r.pack, r.action]), [['letters', 'uploaded'], ['escrow', 'uploaded'], ['ca', 'refused'], ['broken', 'refused'], ['unknown', 'skipped']]);
    assert.equal(rows[2].detail, 'the Concession Agreement and RFP standards are never touched');
    assert.match(rows[3].detail, /mode "sideways" is neither form nor shell/);
    assert.equal(rows[4].detail, 'no type for it in pack-types.json');
    // The file, where the admin upload puts it.
    const letterUpload = supabase.calls.upload.find((u) => u.path.startsWith(`standards/${T_LETTER}/`));
    assert.equal(letterUpload.bucket, 'precedent-library');
    assert.equal(letterUpload.path, `standards/${T_LETTER}/${CLOCK}-Letter-notice-AKLA-standard.docx`);
    assert.deepEqual(letterUpload.opts, { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', upsert: false });
    assert.equal(sha256(letterUpload.body), sha256(LETTER), 'byte for byte');
    // The standard's row.
    const row = tables.document_type_templates.find((r) => r.document_type_id === T_LETTER);
    assert.equal(row.storage_path, letterUpload.path);
    assert.equal(row.filename, 'Letter - notice [AKLA standard].docx');
    assert.equal(row.pack_mode, 'shell');
    assert.deepEqual(row.kinds, { ...LETTER_KINDS, examples: ['body', 'limb_a'] }, 'the shell\'s example kinds travel with the kinds (unknown names dropped)');
    assert.equal(row.fingerprint.sha256, sha256(LETTER));
    assert.equal(row.fingerprint.sections[0].pgSz.name, 'A4 portrait');
    assert.match(row.content_html, /Ref: \[●\]/, 'the text extracted as every upload extracts it');
    assert.match(row.format_rules, /^The firm's shell pack, A4 portrait/);
    assert.equal(row.updated_by, USER);
    assert.equal(row.updated_at, new Date(CLOCK).toISOString());
    assert.deepEqual(supabase.calls.upsert.filter((u) => u.table === 'document_type_templates').map((u) => u.onConflict), ['document_type_id', 'document_type_id']);
    // Its filing.
    const filing = tables.document_template_versions.find((r) => r.storage_path === letterUpload.path);
    assert.deepEqual({ kinds: filing.kinds, pack_mode: filing.pack_mode, filename: filing.filename, created_by: filing.created_by }, { kinds: row.kinds, pack_mode: 'shell', filename: row.filename, created_by: USER });
    assert.equal(tables.document_type_templates.find((r) => r.document_type_id === T_ESCROW).pack_mode, 'form');
    assert.equal(tables.document_type_templates.some((r) => r.document_type_id === T_CA), false, 'the Concession Agreement is untouched');

    // Again: the same bytes and kinds are already the standard.
    const uploads = supabase.calls.upload.length;
    const again = await uploadPacks({ supabase, packsDir: dir, packTypes: PACK_TYPES, only: ['letters', 'escrow'], now: () => CLOCK + 1 });
    assert.deepEqual(again.map((r) => r.action), ['unchanged', 'unchanged']);
    assert.equal(supabase.calls.upload.length, uploads, 'nothing uploaded');
    // The same file with a changed kinds list: the kinds are brought up to date, no new file.
    const changed = { ...ESCROW_KINDS, kinds: { ...ESCROW_KINDS.kinds, plain: { ...ESCROW_KINDS.kinds.plain, label: 'a plain paragraph' } } };
    writeFileSync(join(dir, '08 escrow agreement', 'kinds.json'), JSON.stringify(changed));
    const dry = await uploadPacks({ supabase, packsDir: dir, packTypes: PACK_TYPES, only: ['escrow'], dryRun: true });
    assert.equal(dry[0].action, 'would update kinds');
    const updated = await uploadPacks({ supabase, packsDir: dir, packTypes: PACK_TYPES, only: ['escrow'] });
    assert.equal(updated[0].action, 'kinds updated');
    assert.equal(supabase.calls.upload.length, uploads);
    assert.equal(tables.document_type_templates.find((r) => r.document_type_id === T_ESCROW).kinds.kinds.plain.label, 'a plain paragraph');
    assert.equal(tables.document_template_versions.find((r) => r.document_type_id === T_ESCROW).kinds.kinds.plain.label, 'a plain paragraph');
    // A kinds list with a problem is refused before anything is read or written.
    writeFileSync(join(dir, '08 escrow agreement', 'kinds.json'), JSON.stringify({ kinds: { clause: { pPr: '<w:rPr/>', rPr: '', label: 'x' } } }));
    const bad = await uploadPacks({ supabase, packsDir: dir, packTypes: PACK_TYPES, only: ['escrow', 'nowhere'] });
    assert.equal(bad[0].action, 'refused');
    assert.match(bad[0].detail, /^kinds: Kind "clause"'s paragraph format \(pPr\) is not a single <w:pPr> element\./);
    assert.deepEqual([bad[1].action, bad[1].detail], ['skipped', 'not in packs-config.json']);
    // A type the database does not have yet.
    const noType = await uploadPacks({ supabase: fakeSupabase({ tables: { document_types: [], document_type_templates: [] } }), packsDir: dir, packTypes: PACK_TYPES, only: ['letters'] });
    assert.match(noType[0].detail, /^there is no document type named "Letter \/ Notice" \(apply 20261020140000_drafting_packs\.sql first\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pack-types.json maps the twelve approved packs to their types and never to the Concession Agreement or RFP', () => {
  const { packs } = JSON.parse(readFileSync(new URL('../../scripts/drafting-packs/pack-types.json', import.meta.url), 'utf8'));
  assert.deepEqual(packs, {
    letters: 'Letter / Notice', memo: 'Research Memo', framework: 'Framework Agreement', 'ie-agreement': "Independent Engineer's Agreement",
    'ia-agreement': "Independent Auditors' Agreement", opinion: 'Legal Opinion', proposal: 'Client Proposal Letter', amendment: 'Amendment Agreement',
    escrow: 'Escrow Agreement', 'board-resolution': 'Board Resolution', consent: 'Certificate / Consent / NOC', minutes: 'Meeting Minutes',
  });
  assert.ok(Object.values(packs).every((t) => !PROTECTED.test(t)));
  const migration = readFileSync(new URL('../../supabase/migrations/20261020140000_drafting_packs.sql', import.meta.url), 'utf8');
  for (const name of ['Letter / Notice', 'Amendment Agreement', 'Board Resolution', 'Certificate / Consent / NOC']) assert.ok(migration.includes(`('${name}', '`), `${name} is inserted`);
  assert.match(migration, /where not exists \(select 1 from public\.document_types d where lower\(d\.name\) = lower\(v\.name\)\)/);
  assert.match(migration, /add column if not exists kinds jsonb/);
  assert.match(migration, /check \(pack_mode in \('form', 'shell'\)\)/);
  const deploy = readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');
  assert.equal((deploy.match(/draftingPacks\.js/g) ?? []).length, 3, 'deploy.sh ships the module in all three lists (scp, mv, chown)');
});
