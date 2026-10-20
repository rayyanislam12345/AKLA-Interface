// The four block operations of the drafting plan (Appendix D): write
// paragraphs of a named kind, repeat a block, add a table row, remove a
// block. The fixture is a firm memo: Normal is Times New Roman and Arial is
// set on every run, Heading 1 is numbered through its style, body paragraphs
// are "1.1" on the heading list, limbs are "(a)" on a list of their own,
// there is a table with a navy header row, a footnote, a party block and two
// sections. The kinds list is read off the memo's own paragraphs, as the
// pack builder reads it off a pack. Every result, once the AI's changes are
// accepted, must pass the format gate against the memo itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { inspectDocx, applyDocxOps, acceptAllChanges, acceptChangesBy, OPS_PROTOCOL, validateKinds, kindsListing, describeResults } from '../docxAgent.js';
import { checkFormat } from '../formatFingerprint.js';

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const ARIAL = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>';
const STYLES = `<w:styles ${ns}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;
const NUMBERING = `<w:numbering ${ns}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="(%2)"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const RUN = `<w:rPr>${ARIAL}<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`;
const H1_PPR = '<w:pPr><w:pStyle w:val="Heading1"/><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:jc w:val="both"/></w:pPr>';
const H1_RPR = `<w:rPr>${ARIAL}<w:b/><w:bCs/><w:caps/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`;
const BODY_PPR = '<w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="120"/><w:ind w:left="720" w:hanging="720"/><w:jc w:val="both"/></w:pPr>';
const LIMB_PPR = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:spacing w:after="120"/><w:ind w:left="1440" w:hanging="720"/><w:jc w:val="both"/></w:pPr>';
const PLAIN_PPR = '<w:pPr><w:spacing w:after="120"/><w:jc w:val="both"/></w:pPr>';
const FN_PPR = '<w:pPr><w:pStyle w:val="FootnoteText"/><w:jc w:val="both"/></w:pPr>';
const FN_RPR = `<w:rPr>${ARIAL}<w:sz w:val="18"/></w:rPr>`;
const REF_RPR = `<w:rPr><w:rStyle w:val="FootnoteReference"/>${ARIAL}</w:rPr>`;
const TBL_PR = '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/><w:tblLook w:val="04A0"/></w:tblPr>';
const TBL_GRID = '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6000"/></w:tblGrid>';
const HEAD_TCPR = '<w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="1F3864"/></w:tcPr>';
const HEAD_PPR = '<w:pPr><w:spacing w:after="60"/><w:jc w:val="center"/></w:pPr>';
const HEAD_RPR = `<w:rPr>${ARIAL}<w:b/><w:color w:val="FFFFFF"/><w:sz w:val="20"/></w:rPr>`;
const CELL_TCPR = '<w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>';
const CELL_PPR = '<w:pPr><w:spacing w:after="60"/></w:pPr>';
const CELL_RPR = `<w:rPr>${ARIAL}<w:sz w:val="20"/></w:rPr>`;
const SECTION_1 = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2160" w:right="1728" w:bottom="2160" w:left="1728" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';
const SECTION_2 = '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';

let nextParaId = 0x100;
const pid = () => `w14:paraId="${(nextParaId++).toString(16).toUpperCase().padStart(8, '0')}" w14:textId="77777777"`;
const run = (text, rPr = RUN) => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (pPr, inner) => `<w:p ${pid()}>${pPr}${inner}</w:p>`;
const h1 = (text) => para(H1_PPR, `<w:bookmarkStart w:id="${nextParaId}" w:name="_Toc${nextParaId}"/>${run(text, H1_RPR)}<w:bookmarkEnd w:id="${nextParaId}"/>`);
const body = (text, extra = '') => para(BODY_PPR, run(text) + extra);
const limb = (text) => para(LIMB_PPR, run(text));
const plain = (text, extra = '') => para(PLAIN_PPR, run(text) + extra);
const footRef = (id) => `<w:r>${REF_RPR}<w:footnoteReference w:id="${id}"/></w:r>`;
const cell = (tcPr, pPr, rPr, text) => `<w:tc>${tcPr}<w:p ${pid()}>${pPr}${run(text, rPr)}</w:p></w:tc>`;
const headRow = (a, b) => `<w:tr ${pid()}><w:trPr><w:tblHeader/></w:trPr>${cell(HEAD_TCPR, HEAD_PPR, HEAD_RPR, a)}${cell(HEAD_TCPR.replace('3000', '6000'), HEAD_PPR, HEAD_RPR, b)}</w:tr>`;
const bodyRow = (a, b) => `<w:tr ${pid()}>${cell(CELL_TCPR, CELL_PPR, CELL_RPR, a)}${cell(CELL_TCPR.replace('3000', '6000'), CELL_PPR, CELL_RPR, b)}</w:tr>`;
const TABLE = `<w:tbl>${TBL_PR}${TBL_GRID}${headRow('Issue', 'Comment')}${bodyRow('Title', 'Clear')}${bodyRow('Consents', 'Pending')}</w:tbl>`;
const TOC = `<w:p ${pid()}><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('Background 1')}</w:p><w:p ${pid()}><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
const SEAL = '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="91440" cy="91440"/><wp:docPr id="1" name="Seal 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"/></a:graphic></wp:inline></w:drawing></w:r>';
const SIGNED = `<w:p ${pid()}><w:pPr><w:spacing w:after="120"/><w:jc w:val="both"/>${SECTION_1}</w:pPr>${run('Signed for and on behalf of the Company.')}</w:p>`;

const BODY = TOC
  + h1('Background')
  + body('The Client has asked us to advise on the concession.', footRef(1))
  + limb('the concession period;')
  + limb('the tariff.')
  + TABLE
  + h1('Parties')
  + para(PLAIN_PPR, `<w:commentRangeStart w:id="40"/><w:bookmarkStart w:id="41" w:name="PartyA"/>${run('ABC LIMITED, a company incorporated in Pakistan (the ')}${run('Company', RUN.replace('<w:sz', '<w:b/><w:bCs/><w:sz'))}${run(');')}${footRef(2)}<w:bookmarkEnd w:id="41"/><w:commentRangeEnd w:id="40"/><w:r><w:commentReference w:id="40"/></w:r>${SEAL}`)
  + plain('AND')
  + plain('XYZ (PRIVATE) LIMITED, a company incorporated in Pakistan (the Contractor).')
  + SIGNED
  + h1('Schedule')
  + body('The Site is described in this Schedule.');
const FOOTNOTES = `<w:footnotes ${ns}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`
  + `<w:footnote w:id="1"><w:p ${pid()}>${FN_PPR}<w:r>${REF_RPR}<w:footnoteRef/></w:r><w:r>${FN_RPR}<w:t xml:space="preserve"> </w:t></w:r><w:r>${FN_RPR}<w:t>Section 4 of the Act.</w:t></w:r></w:p></w:footnote>`
  + `<w:footnote w:id="2"><w:p ${pid()}>${FN_PPR}<w:r>${REF_RPR}<w:footnoteRef/></w:r><w:r>${FN_RPR}<w:t xml:space="preserve"> </w:t></w:r><w:r>${FN_RPR}<w:t>Registered under the Companies Act, 2017.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
const TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>';

function docx(bodyXml = BODY, { footnotes = FOOTNOTES } = {}) {
  return zipSync({
    'word/document.xml': strToU8(`<w:document ${ns}><w:body>${bodyXml}${SECTION_2}</w:body></w:document>`),
    'word/styles.xml': strToU8(STYLES),
    'word/numbering.xml': strToU8(NUMBERING),
    ...(footnotes ? { 'word/footnotes.xml': strToU8(footnotes), 'word/_rels/document.xml.rels': strToU8(RELS) } : {}),
    '[Content_Types].xml': strToU8(footnotes ? TYPES : TYPES.replace(/<Override[^>]*\/>/, '')),
  });
}
const MEMO = docx();

const part = (bytes, name = 'word/document.xml') => strFromU8(unzipSync(bytes)[name]);
const PARAGRAPH = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
// The paragraphs holding these words, and their properties without the
// revision marks ours carry.
const paragraphsWith = (xml, text) => (xml.match(PARAGRAPH) ?? []).filter((p) => p.includes(`>${text}</w:t>`));
const paragraphWith = (xml, text) => paragraphsWith(xml, text)[0];
const pPrOf = (p) => /^<w:p(?:\s[^>]*)?>(<w:pPr>[\s\S]*?<\/w:pPr>)/.exec(p)[1].replace(/<w:ins [^>]*\/>/g, '').replace(/<w:rPr><\/w:rPr>/g, '');
const rPrOf = (p) => /<w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(p)[1];
const count = (xml, re) => (xml.match(re) ?? []).length;

const FIRST_RUN = /<w:r>(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)<w:t/;
// The kinds list, read off the memo's own paragraphs: each kind's paragraph
// properties and its first run's properties, as the pack builder does.
function exampleOf(xml, text) {
  const p = paragraphWith(xml, text);
  return { pPr: /^<w:p(?:\s[^>]*)?>(<w:pPr>[\s\S]*?<\/w:pPr>)/.exec(p)?.[1] ?? '', rPr: FIRST_RUN.exec(p)?.[1] ?? '' };
}
function kindsOf(bytes) {
  const xml = part(bytes);
  const kind = (text, label, extra = {}) => {
    const { pPr, rPr } = exampleOf(xml, text);
    const numPr = /<w:numPr><w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/><\/w:numPr>/.exec(pPr);
    return { pPr, rPr, styleId: /<w:pStyle w:val="([^"]+)"/.exec(pPr)?.[1] ?? null, numId: numPr?.[2] ?? null, ilvl: numPr?.[1] ?? null, label, ...extra };
  };
  const row = (text) => {
    const tr = (xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []).find((r) => r.includes(`>${text}</w:t>`));
    const { pPr, rPr } = exampleOf(tr, text);
    return { trPr: /<w:trPr>[\s\S]*?<\/w:trPr>/.exec(tr)?.[0] ?? '', tcPr: /<w:tcPr>[\s\S]*?<\/w:tcPr>/.exec(tr)[0], pPr, rPr };
  };
  const notes = part(bytes, 'word/footnotes.xml');
  const note = /<w:footnote w:id="1">([\s\S]*?)<\/w:footnote>/.exec(notes)[1];
  return {
    kinds: {
      h1: kind('Background', 'heading'),
      body: kind('The Client has asked us to advise on the concession.', 'numbered paragraph 1.1'),
      limb: kind('the concession period;', 'limb (a)'),
      plain: kind('AND', 'unnumbered paragraph'),
    },
    tables: {
      issues: { tblPr: /<w:tblPr>[\s\S]*?<\/w:tblPr>/.exec(xml)[0], tblGrid: /<w:tblGrid>[\s\S]*?<\/w:tblGrid>/.exec(xml)[0], header: row('Issue'), body: row('Title'), label: 'issues table, navy header row' },
    },
    footnote: { pPr: /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(note)[0], rPr: FIRST_RUN.exec(note)[1], refRPr: /<w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)<w:footnoteRef/.exec(note)[1] },
  };
}
const KINDS = kindsOf(MEMO);

// Operations name paragraphs by their words here; the listing's numbers
// are put in their place.
async function apply(bytes, ops, { kinds = KINDS } = {}) {
  const view = inspectDocx(bytes);
  const no = (text) => {
    const hit = [...view.byRef].find(([, r]) => r.exactText === text);
    assert.ok(hit, `no paragraph "${text}"`);
    return hit[0];
  };
  const keys = ['p', 'after', 'from', 'to', 'table', 'like_row'];
  const mapped = ops.map((o) => {
    const out = { ...o };
    for (const k of keys) if (typeof o[k] === 'string') out[k] = no(o[k]);
    return out;
  });
  return applyDocxOps(bytes, mapped, view.byRef, { kinds });
}
// Accepted, the draft must pass the format gate against the memo.
function assertGate(out, base = MEMO) {
  for (const accepted of [acceptChangesBy(out.bytes), acceptAllChanges(out.bytes)]) {
    const format = checkFormat(accepted, base, { mode: 'enforce' });
    assert.equal(format.result.status, 'matches', JSON.stringify(format.result.findings));
  }
  return acceptChangesBy(out.bytes);
}

test('write: a heading, numbered paragraphs, limbs, a footnote and a table, each in the look of the firm\'s own example', async () => {
  const out = await apply(MEMO, [{
    op: 'write', after: 'the tariff.', expected: 'the tariff.', why: 'the analysis section',
    blocks: [
      { kind: 'h1', text: 'Analysis' },
      { kind: 'body', text: 'We have reviewed the **Concession Agreement** and the tariff schedule.' },
      { kind: 'limb', text: 'the tariff is indexed annually;' },
      { kind: 'limb', text: 'the index is published by the regulator.' },
      { kind: 'footnote', text: 'Clause 5.2 of the Concession Agreement.' },
      { kind: 'issues', rows: [['Issue', 'Comment'], ['Indexation', 'Agreed'], ['Publication']] },
      { kind: 'plain', text: 'We would be glad to discuss.' },
    ],
  }]);
  assert.equal(out.applied, 1, JSON.stringify(out.results));
  const [r] = out.results;
  assert.equal(r.status, 'applied');
  assert.equal(r.via, 'inline');
  assert.deepEqual(r.restarted, ['3'], 'the limbs start a new (a) list');
  assert.deepEqual(r.footnotes, [3]);
  assert.ok(r.revisionIds.length > 10);
  assert.ok(r.text.startsWith('Analysis\nWe have reviewed'));
  const xml = part(out.bytes);

  const heading = paragraphWith(xml, 'Analysis');
  assert.equal(pPrOf(heading), H1_PPR);
  assert.equal(rPrOf(heading), H1_RPR, 'Arial like the firm\'s heading, not the Normal style\'s Times New Roman');
  const numbered = paragraphWith(xml, 'We have reviewed the ');
  assert.equal(pPrOf(numbered), BODY_PPR, 'the 1.1 paragraph stays on the heading list: never started again');
  assert.equal(rPrOf(numbered), RUN);
  assert.ok(numbered.includes(`<w:rPr>${ARIAL}<w:b/><w:bCs/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">Concession Agreement</w:t>`), 'a defined term in bold');
  const limbs = [paragraphWith(xml, 'the tariff is indexed annually;'), paragraphWith(xml, 'the index is published by the regulator.')];
  for (const p of limbs) {
    assert.equal(pPrOf(p), LIMB_PPR.replace('<w:numId w:val="2"/>', '<w:numId w:val="3"/>'));
    assert.equal(rPrOf(p), RUN);
  }
  assert.ok(part(out.bytes, 'word/numbering.xml').includes('<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>'.replace('</w:numbering>', '')));

  // The footnote: its words in the notes, its mark at the end of the limb before it.
  assert.ok(limbs[1].includes(`${REF_RPR}<w:footnoteReference w:id="3"/></w:r></w:ins></w:p>`));
  const notes = part(out.bytes, 'word/footnotes.xml');
  const note = /<w:footnote w:id="3">([\s\S]*?)<\/w:footnote>/.exec(notes)[1];
  assert.equal(pPrOf(note), FN_PPR);
  assert.ok(note.includes(`<w:r>${REF_RPR}<w:footnoteRef/></w:r>`));
  assert.ok(note.includes(`<w:r>${FN_RPR}<w:t xml:space="preserve">Clause 5.2 of the Concession Agreement.</w:t></w:r>`));
  assert.ok(/<w:ins w:id="\d+" w:author="AKLA AI"/.test(note), 'the note is a tracked insertion too');

  // The table: the firm's table properties, a navy header row, body rows.
  const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g);
  assert.equal(tables.length, 2);
  const made = tables[0];
  assert.ok(made.startsWith(`<w:tbl>${TBL_PR}${TBL_GRID}<w:tr><w:trPr><w:tblHeader/><w:ins `));
  assert.equal(count(made, /<w:tr>/g), 3);
  assert.equal(count(made, /<w:shd w:val="clear" w:color="auto" w:fill="1F3864"\/>/g), 2, 'the header row only');
  assert.equal(pPrOf(paragraphWith(made, 'Comment')), HEAD_PPR);
  assert.equal(rPrOf(paragraphWith(made, 'Comment')), HEAD_RPR);
  assert.equal(rPrOf(paragraphWith(made, 'Indexation')), CELL_RPR);
  assert.ok(made.includes('<w:tcW w:w="6000" w:type="dxa"/>'), 'each column keeps its own width');
  assert.equal(count(made, /<w:tc>/g), 6, 'a short row is filled out with an empty cell');
  assert.equal(pPrOf(paragraphWith(xml, 'We would be glad to discuss.')), PLAIN_PPR);

  // In order, after the limb anchored on, and before the table that followed it.
  const at = (text) => xml.indexOf(`>${text}</w:t>`);
  assert.ok(at('the tariff.') < at('Analysis') && at('Analysis') < at('Indexation') && at('Indexation') < at('We would be glad to discuss.'));
  assert.ok(at('We would be glad to discuss.') < xml.lastIndexOf('>Issue</w:t>'));
  assert.ok(xml.includes('<w:fldChar w:dirty="true" w:fldCharType="begin"/>'), 'a heading was added: the contents page is rebuilt on opening');

  const clean = part(assertGate(out));
  assert.ok(!/w:author="AKLA AI"/.test(clean));
  assert.equal(count(clean, /<w:tbl>/g), 2);
  assert.ok(clean.includes('<w:footnoteReference w:id="3"/>'));
  assert.ok(describeResults(out.results)[0].summary.startsWith(`Wrote after ¶${r.p}: Analysis`));
});

test('a new (a) list starts again at (a); limbs written after a limb carry on its list', async () => {
  const out = await apply(MEMO, [
    { op: 'write', after: 'The Client has asked us to advise on the concession.', expected: 'The Client has asked us to advise on the concession.', blocks: [{ kind: 'limb', text: 'first new limb;' }, { kind: 'limb', text: 'second new limb.' }, { kind: 'body', text: 'A numbered paragraph between.' }, { kind: 'limb', text: 'a third list.' }] },
    { op: 'write', after: 'the tariff.', expected: 'the tariff.', blocks: [{ kind: 'limb', text: 'the escalation.' }] },
  ]);
  assert.equal(out.applied, 2, JSON.stringify(out.results));
  const xml = part(out.bytes);
  const numIdOf = (text) => /<w:numId w:val="(\d+)"/.exec(paragraphWith(xml, text))[1];
  assert.equal(numIdOf('first new limb;'), numIdOf('second new limb.'), 'the second limb carries on the first');
  assert.notEqual(numIdOf('first new limb;'), '2');
  assert.notEqual(numIdOf('a third list.'), numIdOf('first new limb;'), 'a limb after a numbered paragraph starts again');
  assert.equal(numIdOf('A numbered paragraph between.'), '1');
  assert.equal(numIdOf('the escalation.'), '2', 'after the memo\'s own (b), the next limb is its (c)');
  assert.deepEqual(out.results.map((r) => r.restarted ?? []), [['3', '4'], []]);
  const numbering = part(out.bytes, 'word/numbering.xml');
  assert.equal(count(numbering, /<w:num w:numId=/g), 4);
  assert.equal(count(numbering, /<w:startOverride w:val="1"\/>/g), 2);
  assertGate(out);

  // A kind marked as a list that runs on is never started again.
  const runOn = { ...KINDS, kinds: { ...KINDS.kinds, limb: { ...KINDS.kinds.limb, restart: false } } };
  const kept = await apply(MEMO, [{ op: 'write', after: 'The Client has asked us to advise on the concession.', expected: 'The Client has asked us to advise on the concession.', blocks: [{ kind: 'limb', text: 'carries on.' }] }], { kinds: runOn });
  assert.equal(/<w:numId w:val="(\d+)"/.exec(paragraphWith(part(kept.bytes), 'carries on.'))[1], '2');
  assert.equal(part(kept.bytes, 'word/numbering.xml'), NUMBERING, 'the numbering part is left byte for byte');
});

test('an unknown kind refuses that write alone; the rest of the turn is made', async () => {
  const out = await apply(MEMO, [
    { op: 'write', after: 'AND', expected: 'AND', blocks: [{ kind: 'plain', text: 'Fine.' }, { kind: 'quote', text: 'An indented quotation.' }] },
    { op: 'insert_after', p: 'AND', expected: 'AND', text: 'A clause after AND.' },
    { op: 'write', after: 'the tariff.', expected: 'the tariff.', blocks: [{ kind: 'plain', text: 'Written.' }] },
  ]);
  assert.equal(out.applied, 2);
  const [refused, inserted, written] = out.results;
  assert.equal(refused.status, 'skipped');
  assert.equal(refused.reason, 'this document\'s pack has no kind "quote", so nothing in this write was added; the kinds are h1, body, limb, plain, footnote, issues');
  assert.equal(inserted.status, 'applied');
  assert.equal(written.status, 'applied');
  const xml = part(out.bytes);
  assert.ok(!xml.includes('Fine.') && !xml.includes('indented quotation'), 'nothing of the refused write');
  assert.ok(xml.includes('A clause after AND.') && xml.includes('Written.'));
  assertGate(out);

  // No pack open: write is refused, plainly; a footnote needs a paragraph before it.
  const none = await apply(MEMO, [{ op: 'write', after: 'AND', expected: 'AND', blocks: [{ kind: 'plain', text: 'x' }] }], { kinds: null });
  assert.match(none.results[0].reason, /no firm pack is open/);
  const lone = await apply(MEMO, [{ op: 'write', after: 'AND', expected: 'AND', blocks: [{ kind: 'footnote', text: 'A note.' }] }]);
  assert.match(lone.results[0].reason, /footnote goes on the paragraph written just before it/);
  const wrong = await apply(MEMO, [{ op: 'write', after: 'AND', expected: 'The tariff.', blocks: [{ kind: 'plain', text: 'x' }] }]);
  assert.match(wrong.results[0].reason, /Expected paragraph text does not match/);
});

test('repeat_block copies a party block and a whole table, each with ids of its own', async () => {
  const partyA = 'ABC LIMITED, a company incorporated in Pakistan (the Company);';
  const partyB = 'XYZ (PRIVATE) LIMITED, a company incorporated in Pakistan (the Contractor).';
  const out = await apply(MEMO, [
    { op: 'repeat_block', from: partyA, to: partyB, after: partyB, expected: partyA },
    { op: 'repeat_block', from: 'Issue', to: 'Pending', after: 'Clear', expected: 'Issue' },
  ]);
  assert.equal(out.applied, 2, JSON.stringify(out.results));
  assert.deepEqual(out.results.map((r) => r.copied), [3, 6]);
  const xml = part(out.bytes);
  assert.equal(count(xml, /<w:tbl>/g), 2, 'the table is copied whole, after the table');
  assert.ok(xml.indexOf('</w:tbl><w:tbl>') > 0, 'the copy follows the table');
  assert.equal(paragraphsWith(xml, 'AND').length, 2);
  assert.ok(xml.indexOf(`>${partyB}</w:t>`) < xml.lastIndexOf('>ABC LIMITED, a company incorporated in Pakistan (the </w:t>'));
  assert.equal(count(xml, /<w:commentRangeStart/g), 1, 'the comment stays on the original only');
  assert.equal(count(xml, /<w:commentReference/g), 1);
  assert.equal(count(xml, /<w:sectPr[\s>]/g), 2, 'no section break is copied');
  const notes = part(out.bytes, 'word/footnotes.xml');
  assert.ok(notes.includes('<w:footnote w:id="3">'), 'the copied party\'s footnote is a footnote of its own');
  assert.ok(/<w:footnote w:id="3">[\s\S]*Registered under the Companies Act, 2017\./.test(notes));

  const clean = part(assertGate(out));
  const all = [clean, part(acceptChangesBy(out.bytes), 'word/footnotes.xml')].join('');
  const unique = (re, what) => {
    const ids = [...all.matchAll(re)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${what} repeated: ${ids}`);
    return ids;
  };
  assert.equal(unique(/w14:paraId="([0-9A-F]{8})"/g, 'paragraph ids').length, count(clean, /w14:paraId=/g) + count(all.slice(clean.length), /w14:paraId=/g));
  assert.deepEqual(unique(/<wp:docPr id="(\d+)"/g, 'drawing ids').length, 2);
  assert.equal(unique(/<w:bookmarkStart w:id="(\d+)"/g, 'bookmark ids').length, 5, 'three headings, the party, and the party copied');
  unique(/<w:bookmarkStart w:id="\d+" w:name="([^"]+)"/g, 'bookmark names');
  unique(/<w:footnoteReference w:id="(\d+)"/g, 'footnote references');
  assert.ok(clean.includes('w:name="PartyA_1"'));
  assert.equal(count(clean, /<w:tr\b/g), 6);
});

test('a copied (a)/(b) group starts again at (a); a copy from part-way through a group carries on', async () => {
  const out = await apply(MEMO, [
    { op: 'repeat_block', from: 'the concession period;', to: 'the tariff.', after: 'Pending', expected: 'the concession period;' },
    { op: 'repeat_block', from: 'the tariff.', to: 'the tariff.', after: 'the tariff.', expected: 'the tariff.' },
  ]);
  assert.equal(out.applied, 2, JSON.stringify(out.results));
  assert.deepEqual(out.results.map((r) => r.restarted), [['3'], undefined]);
  const xml = part(out.bytes);
  const numIds = (text) => paragraphsWith(xml, text).map((p) => /<w:numId w:val="(\d+)"/.exec(p)[1]);
  assert.deepEqual(numIds('the concession period;'), ['2', '3']);
  assert.deepEqual(numIds('the tariff.'), ['2', '2', '3']);
  assertGate(out);
});

test('a range that cuts through a table is refused, and so is one with paragraphs the turn was not shown', async () => {
  const out = await apply(MEMO, [
    { op: 'repeat_block', from: 'the tariff.', to: 'Title', after: 'The Site is described in this Schedule.', expected: 'the tariff.' },
    { op: 'remove_block', from: 'Clear', to: 'Parties', expected: 'Clear' },
    { op: 'remove_block', from: 'Parties', to: 'AND', expected: 'Parties' },
  ]);
  assert.equal(out.results[0].status, 'skipped');
  assert.match(out.results[0].reason, /^¶\d+ is inside a table, so the range would cut through it; end at the table's last paragraph, or before the table$/);
  assert.match(out.results[1].reason, /is inside a table, so the range would cut through it; start at the table's first paragraph, or after the table/);
  assert.equal(out.results[2].status, 'applied', 'the rest of the turn is made');

  // A paragraph inside the range that the listing left out.
  const view = inspectDocx(MEMO);
  const ref = (text) => [...view.byRef.values()].find((r) => r.exactText === text);
  ref('XYZ (PRIVATE) LIMITED, a company incorporated in Pakistan (the Contractor).').shown = false;
  const res = await applyDocxOps(MEMO, [{ op: 'remove_block', from: ref('AND').index, to: ref('Schedule').index, expected: 'AND' }], view.byRef, { kinds: KINDS });
  assert.match(res.results[0].reason, /^¶\d+, inside ¶\d+–¶\d+, was not supplied to this turn; request that section first$/);
  const to = await applyDocxOps(MEMO, [{ op: 'remove_block', from: ref('AND').index, to: ref('XYZ (PRIVATE) LIMITED, a company incorporated in Pakistan (the Contractor).').index, expected: 'AND' }], view.byRef, { kinds: KINDS });
  assert.match(to.results[0].reason, /\("to"\) was not supplied to this turn/);
});

test('add_row adds a row like the one named, straight after it', async () => {
  const out = await apply(MEMO, [{ op: 'add_row', table: 'Issue', like_row: 'Title', expected: 'Title', cells: ['Insurance', 'Outstanding'] }]);
  assert.equal(out.applied, 1, JSON.stringify(out.results));
  assert.equal(out.results[0].text, 'Insurance | Outstanding');
  const xml = part(out.bytes);
  const rows = xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g);
  assert.deepEqual(rows.map((r) => /<w:t xml:space="preserve">([^<]*)</.exec(r)[1]), ['Issue', 'Title', 'Insurance', 'Consents']);
  const row = rows[2];
  assert.match(row, /^<w:tr w14:paraId="[0-9A-F]{8}" w14:textId="[0-9A-F]{8}"><w:trPr><w:ins w:id="\d+" w:author="AKLA AI"/);
  assert.ok(row.includes(CELL_TCPR) && row.includes(CELL_TCPR.replace('3000', '6000')), 'each cell keeps its own properties');
  assert.equal(pPrOf(paragraphWith(row, 'Outstanding')), CELL_PPR);
  assert.equal(rPrOf(paragraphWith(row, 'Outstanding')), CELL_RPR);
  const clean = part(assertGate(out));
  assert.equal(count(clean, /<w:tr\b/g), 4);
  assert.ok(!clean.includes('<w:trPr></w:trPr>'));

  const many = await apply(MEMO, [{ op: 'add_row', like_row: 'Title', expected: 'Title', cells: ['a', 'b', 'c'] }]);
  assert.equal(many.results[0].reason, 'the row has 2 cells, and 3 were given');
  const elsewhere = await apply(MEMO, [{ op: 'add_row', table: 'AND', like_row: 'Title', expected: 'Title', cells: ['a'] }]);
  assert.match(elsewhere.results[0].reason, /is not in the same table/);
});

test('remove_block strikes a block through and moves its section break to the paragraph before it', async () => {
  const partyA = 'ABC LIMITED, a company incorporated in Pakistan (the Company);';
  const out = await apply(MEMO, [
    { op: 'remove_block', from: 'AND', to: 'Signed for and on behalf of the Company.', expected: 'AND' },
    { op: 'replace', p: 'AND', expected: 'AND', text: 'AND ALSO' },
  ]);
  assert.equal(out.applied, 1);
  const [removed, replaced] = out.results;
  assert.equal(removed.status, 'applied');
  assert.equal(removed.movedSectionBreak, true);
  assert.equal(removed.original, 'AND\nXYZ (PRIVATE) LIMITED, a company incorporated in Pakistan (the Contractor).\nSigned for and on behalf of the Company.');
  assert.match(replaced.reason, /^¶\d+ is inside ¶\d+–¶\d+, which another change in this turn removes$/);
  const xml = part(out.bytes);
  assert.equal(count(xml, /<w:sectPr[\s>]/g), 2);
  assert.ok(paragraphWith(xml, ');').includes(SECTION_1), 'the break now ends the party paragraph before the block');
  assert.ok(xml.includes('<w:delText xml:space="preserve">Signed for and on behalf of the Company.</w:delText>'));
  for (const accepted of [acceptChangesBy(out.bytes), acceptAllChanges(out.bytes)]) {
    const clean = part(accepted);
    assert.equal(count(clean, /<w:sectPr[\s>]/g), 2, 'the section survives acceptance');
    assert.ok(!clean.includes('Signed for and on behalf') && !clean.includes('>AND<'));
    assert.ok(paragraphWith(clean, ');').includes(SECTION_1));
  }
  assertGate(out);
  assert.ok(xml.includes(partyA.slice(0, 20)));

  // When the paragraph before is taken by another change, the last mark keeps the break, as delete does.
  const kept = await apply(MEMO, [
    { op: 'remove_block', from: 'AND', to: 'Signed for and on behalf of the Company.', expected: 'AND' },
    { op: 'comment', p: partyA, expected: partyA, text: 'Confirm the registered name.' },
  ]);
  assert.equal(kept.applied, 2);
  assert.equal(kept.results[0].keptSectionBreak, true);
  assert.equal(kept.results[0].movedSectionBreak, undefined);
  assertGate(kept);

  // A whole section with its heading and a table: the contents page is marked, the table goes on acceptance.
  const section = await apply(MEMO, [{ op: 'remove_block', from: 'Background', to: 'Pending', expected: 'Background' }]);
  assert.equal(section.applied, 1, JSON.stringify(section.results));
  const sxml = part(section.bytes);
  assert.ok(sxml.includes('<w:fldChar w:dirty="true" w:fldCharType="begin"/>'));
  assert.equal(count(sxml, /<w:trPr>(?:<w:tblHeader\/>)?<w:del /g), 3, 'every row is marked deleted');
  const clean = part(assertGate(section));
  assert.equal(count(clean, /<w:tbl>/g), 0);
  assert.ok(!clean.includes('the concession period;'));
  assert.ok(!clean.includes('<w:footnoteReference w:id="1"/>'));
});

test('validateKinds names what is wrong in plain sentences; kindsListing is the line a prompt shows', () => {
  assert.deepEqual(validateKinds(KINDS), []);
  const bad = {
    kinds: {
      '1x': { pPr: '<w:rPr/>', rPr: RUN, label: 'x' },
      limb: { ...KINDS.kinds.limb, numId: '7' },
      body: { ...KINDS.kinds.body, pPr: `<w:pPr>${SECTION_1}</w:pPr>`, label: '' },
      footnote: { pPr: '', rPr: '', label: 'n' },
      broken: { pPr: '<w:pPr><w:jc></w:pPr>', rPr: '', label: 'b' },
    },
    tables: { limb: { tblPr: '', header: KINDS.tables.issues.header, label: 't' } },
    footnote: { pPr: FN_PPR, rPr: 'not xml', refRPr: REF_RPR },
  };
  assert.deepEqual(validateKinds(bad), [
    'The kind name "1x" is not a plain name (a letter, then letters, digits, - or _).',
    'Kind "1x"\'s paragraph format (pPr) is not a single <w:pPr> element.',
    'Kind "limb" says list 7, but its paragraph format uses list 2.',
    'Kind "body"\'s paragraph format carries a section break; take it out.',
    'Kind "body" has no label.',
    'The name "footnote" is kept for the footnote; give the paragraph kind another name.',
    'Kind "broken"\'s paragraph format (pPr) is not well-formed XML.',
    '"limb" is both a paragraph kind and a table kind.',
    'Table kind "limb"\'s table format (tblPr) is missing.',
    'Table kind "limb" has no body row.',
    'The footnote\'s run format (rPr) is not a single <w:rPr> element.',
  ]);
  assert.deepEqual(validateKinds(null), ['The kinds list is not an object.']);
  assert.equal(kindsListing(KINDS), 'KINDS YOU CAN WRITE: h1 (heading), body (numbered paragraph 1.1), limb (limb (a)), plain (unnumbered paragraph), footnote (a footnote on the paragraph before it). TABLES: issues (issues table, navy header row); a table takes "rows", the first row its header.');
  assert.equal(kindsListing(null), '');
});

test('a footnote written into a file with no notes part creates the part, its relationship and its content type', async () => {
  const bare = docx(BODY.replace(footRef(1), '').replace(footRef(2), ''), { footnotes: null });
  const out = await apply(bare, [{ op: 'write', after: 'AND', expected: 'AND', blocks: [{ kind: 'plain', text: 'Cited.' }, { kind: 'footnote', text: 'A source.' }] }]);
  assert.equal(out.applied, 1, JSON.stringify(out.results));
  const files = unzipSync(out.bytes);
  const notes = strFromU8(files['word/footnotes.xml']);
  assert.ok(notes.includes('<w:footnote w:type="separator" w:id="-1">') && notes.includes('<w:footnote w:id="1">'));
  assert.ok(strFromU8(files['[Content_Types].xml']).includes('<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'));
  assert.ok(strFromU8(files['word/_rels/document.xml.rels']).includes('relationships/footnotes" Target="footnotes.xml"/>'));
  assert.ok(paragraphWith(part(out.bytes), 'Cited.').includes('<w:footnoteReference w:id="1"/>'));
});

test('the protocol describes the four new operations and keeps footnotes for citations only', () => {
  for (const op of ['"write"', '"repeat_block"', '"add_row"', '"remove_block"', '"replace"', '"insert_after"', '"delete"', '"comment"']) assert.ok(OPS_PROTOCOL.includes(op), op);
  assert.ok(OPS_PROTOCOL.includes('KINDS YOU CAN WRITE'));
  assert.ok(OPS_PROTOCOL.includes('A footnote is only for what the document itself cites'));
  assert.ok(!OPS_PROTOCOL.includes('never as footnotes'));
  assert.ok(OPS_PROTOCOL.includes('remarks for the reader go in comments'));
});

test('a signature block drawn with a shape is repeated whole, its shape given ids of its own', async () => {
  const mc = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"';
  const box = (text) => `<w:r><mc:AlternateContent ${mc}><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="914400" cy="91440"/><wp:wrapNone/><wp:docPr id="7" name="Signature line 7"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent><w:p w14:paraId="0BADBEEF" w14:textId="77777777"><w:r>${RUN}<w:t>${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="width:72pt;height:7pt"><v:textbox><w:txbxContent><w:p w14:paraId="0BADBEEE" w14:textId="77777777"><w:r>${RUN}<w:t>${text}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
  const signature = plain('For and on behalf of ABC LIMITED') + para(PLAIN_PPR, run('Signature: ') + box('Authorised signatory')) + plain('Name: [●]');
  const bytes = docx(BODY.replace(SIGNED, signature + SIGNED));
  // The shape's namespaces declared on the document, as Word writes them.
  const fixed = zipSync(Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, k === 'word/document.xml' ? strToU8(strFromU8(v).replace('<w:document ', `<w:document ${mc} `)) : v])));
  const out = await apply(fixed, [{ op: 'repeat_block', from: 'For and on behalf of ABC LIMITED', to: 'Name: [●]', after: 'Name: [●]', expected: 'For and on behalf of ABC LIMITED' }]);
  assert.equal(out.applied, 1, JSON.stringify(out.results));
  const xml = part(out.bytes);
  assert.equal(count(xml, /<w:txbxContent>/g), 4, 'the shape and its fallback, twice');
  assert.equal(count(xml, />Signature: <\/w:t>/g), 2);
  const clean = part(assertGate(out, fixed));
  const ids = [...clean.matchAll(/w14:paraId="([0-9A-F]{8})"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'every paragraph id once, inside the shapes as well');
  assert.deepEqual([...clean.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]), ['1', '7', '8']);
});
