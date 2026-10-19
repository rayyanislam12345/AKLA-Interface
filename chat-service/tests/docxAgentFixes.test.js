// The three engine faults the drafting plan fixes first (Appendix D): an
// added heading takes the look of the document's own headings, a copied
// paragraph never carries a section break or a recorded formatting change,
// and the contents page is marked out of date when a heading comes or goes.
// The fixture follows the firm's pattern: Normal is Times New Roman, Arial is
// set on every run, Heading1/Heading2 are numbered through the styles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { inspectDocx, applyDocxOps, acceptAllChanges, acceptChangesBy, OPS_PROTOCOL } from '../docxAgent.js';
import { checkFormat } from '../formatFingerprint.js';

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const ARIAL = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>';
const STYLES = `<w:styles ${ns}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;
const NUMBERING = `<w:numbering ${ns}><w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="%1."/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading2"/><w:lvlText w:val="%1.%2"/></w:lvl>
<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading3"/><w:lvlText w:val="%1.%2.%3"/></w:lvl>
</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const H1_PPR = `<w:pPr><w:pStyle w:val="Heading1"/><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:jc w:val="both"/><w:rPr>${ARIAL}<w:sz w:val="22"/></w:rPr></w:pPr>`;
const H1_RPR = `<w:rPr>${ARIAL}<w:b/><w:bCs/><w:caps/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`;
const H2_PPR = `<w:pPr><w:pStyle w:val="Heading2"/><w:spacing w:after="120"/><w:jc w:val="both"/></w:pPr>`;
const H2_RPR = `<w:rPr>${ARIAL}<w:b/><w:sz w:val="22"/></w:rPr>`;
const BODY_PPR = '<w:pPr><w:spacing w:after="120"/><w:ind w:left="720"/><w:jc w:val="both"/></w:pPr>';
const BODY_RPR = `<w:rPr>${ARIAL}<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`;
const SECTION_1 = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2160" w:right="1728" w:bottom="2160" w:left="1728" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';
const SECTION_2 = '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';

const para = (pPr, rPr, text) => `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const h1 = (text) => para(H1_PPR, H1_RPR, text);
const h2 = (text) => para(H2_PPR, H2_RPR, text);
const body = (text) => para(BODY_PPR, BODY_RPR, text);
// The last paragraph of section one carries that section's break.
const sectionEnd = (text) => para(`<w:pPr><w:spacing w:after="120"/><w:jc w:val="both"/>${SECTION_1}</w:pPr>`, BODY_RPR, text);
const TOC = '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>'
  + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TO</w:instrText></w:r><w:r><w:instrText xml:space="preserve">C \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
  + '<w:r><w:t>Definitions</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
  + '</w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';

function docx(bodyXml, { styles = STYLES } = {}) {
  return zipSync({
    'word/document.xml': strToU8(`<w:document ${ns}><w:body>${bodyXml}${SECTION_2}</w:body></w:document>`),
    'word/styles.xml': strToU8(styles),
    'word/numbering.xml': strToU8(NUMBERING),
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
  });
}
const FIRM = docx(TOC
  + h1('Definitions') + body('In this Agreement the following words have the meanings given.')
  + h2('Interpretation') + body('Headings are for convenience only.')
  + sectionEnd('The parties have signed this Agreement on the date first written above.')
  + h1('Schedule 1') + body('The Site is described in this Schedule.'));

const docXml = (bytes) => strFromU8(unzipSync(bytes)['word/document.xml']);
const sections = (xml) => (xml.match(/<w:sectPr[\s>]/g) ?? []).length;
const at = (view, text) => [...view.byRef].find(([, r]) => r.exactText === text)[0];
// The new paragraph, found by its words.
const paragraphWith = (xml, text) => xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g).find((p) => p.includes(`>${text}</w:t>`));
// Its properties and its first run's, without the revision marks ours carry.
const pPrOf = (p) => /^<w:p(?:\s[^>]*)?>(<w:pPr>[\s\S]*?<\/w:pPr>)/.exec(p)[1].replace(/<w:ins [^>]*\/>/g, '').replace(/<w:rPr><\/w:rPr>/g, '');
const rPrOf = (p) => /<w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(p)[1];
async function apply(bytes, ops) {
  const view = inspectDocx(bytes);
  return applyDocxOps(bytes, ops.map((o) => ({ ...o, p: at(view, o.expected) })), view.byRef);
}

test('an added heading takes the paragraph and run formatting of the nearest heading of its level', async () => {
  const anchor = 'Headings are for convenience only.';
  const out = await apply(FIRM, [
    { op: 'insert_after', expected: anchor, text: '## Notices' },
    { op: 'insert_after', expected: anchor, text: '# Term' },
  ]);
  assert.equal(out.applied, 2);
  const xml = docXml(out.bytes);
  const notices = paragraphWith(xml, 'Notices');
  const term = paragraphWith(xml, 'Term');
  assert.equal(pPrOf(notices), H2_PPR);
  assert.equal(rPrOf(notices), H2_RPR);
  assert.equal(pPrOf(term), H1_PPR);
  assert.equal(rPrOf(term), H1_RPR);
  assert.ok(rPrOf(term).includes('w:ascii="Arial"'), 'Arial like its neighbours, not the Times New Roman of Normal');
  assert.ok(!/<w:pPr><w:pStyle w:val="Heading\d"\/><\/w:pPr>/.test(xml), 'never a bare style');
  // Still one tracked insertion that accepts cleanly.
  const clean = docXml(acceptAllChanges(out.bytes));
  assert.ok(paragraphWith(clean, 'Term').startsWith(`<w:p>${H1_PPR}`));
});

test('with no heading of its level before the anchor, the next one below is the model', async () => {
  const out = await apply(FIRM, [{ op: 'insert_after', expected: 'Definitions', text: '## Parties' }]);
  const p = paragraphWith(docXml(out.bytes), 'Parties');
  assert.equal(pPrOf(p), H2_PPR);
  assert.equal(rPrOf(p), H2_RPR);
});

test('a heading of a level the file has a style for but no heading of is refused on its own; the rest of the turn is made and passes the format check', async () => {
  // As in the firm's CA: Heading3 is defined (Cambria, on a list the
  // document never uses) but no paragraph uses it.
  const anchor = 'Headings are for convenience only.';
  const out = await apply(FIRM, [
    { op: 'insert_after', expected: anchor, text: '### Compensation' },
    { op: 'replace', expected: anchor, text: 'Headings are for ease of reference only.' },
    { op: 'insert_after', expected: anchor, text: 'References to a party include its successors.' },
  ]);
  assert.equal(out.applied, 2);
  const refused = out.results.find((r) => r.text === '### Compensation');
  assert.equal(refused.status, 'skipped');
  assert.equal(refused.reason, 'this document has no level-3 heading to take the look from (it uses heading levels 1 and 2), so it was not added; add it as a heading of a level the document uses, or as a clause after a paragraph of the kind wanted');
  const xml = docXml(out.bytes);
  assert.ok(!xml.includes('Compensation'));
  assert.ok(!/<w:pStyle w:val="Heading3"\/>/.test(xml), 'never a bare style');
  assert.ok(xml.includes('References to a party include its successors.'));
  const format = checkFormat(acceptChangesBy(out.bytes), FIRM, { mode: 'enforce' });
  assert.equal(format.result.status, 'matches', JSON.stringify(format.result.findings));
  // A file with no heading styles at all still gets a paragraph like the anchor, without its bold.
  const plain = docx(para(BODY_PPR, `<w:rPr>${ARIAL}<w:b/><w:sz w:val="22"/></w:rPr>`, 'Agreement means this agreement.'), { styles: STYLES.replace(/<w:style w:type="paragraph" w:styleId="Heading\d">[\s\S]*?<\/w:style>/g, '') });
  const made = await apply(plain, [{ op: 'insert_after', expected: 'Agreement means this agreement.', text: '# Further definitions' }]);
  assert.equal(made.applied, 1);
  const p = paragraphWith(docXml(made.bytes), 'Further definitions');
  assert.equal(pPrOf(p), BODY_PPR);
  assert.equal(rPrOf(p), `<w:rPr>${ARIAL}<w:sz w:val="22"/></w:rPr>`);
});

test('a heading whose model opens with a page break, bookmarks or a field copies none of them, only the formatting of its words', async () => {
  // As 22 of the CA's 32 Heading 1 paragraphs: a page-break run, then the
  // contents page's bookmarks, then the words.
  const breakFirst = `<w:p>${H1_PPR}<w:r><w:rPr>${ARIAL}</w:rPr><w:br w:type="page"/></w:r><w:bookmarkStart w:id="70" w:name="_Toc333899868"/><w:bookmarkStart w:id="71" w:name="_Toc229101100"/><w:bookmarkEnd w:id="64"/><w:r w:rsidRPr="002D1A91">${H1_RPR}<w:t>Definitions</w:t></w:r><w:bookmarkEnd w:id="70"/><w:bookmarkEnd w:id="71"/></w:p>`;
  // And one that opens with a SEQ field whose begin run carries formatting.
  const fieldFirst = `<w:p>${H1_PPR}<w:r>${H1_RPR}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${H1_RPR}<w:instrText xml:space="preserve"> SEQ Article \\* ARABIC </w:instrText></w:r><w:r>${H1_RPR}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${H1_RPR}<w:t>2</w:t></w:r><w:r>${H1_RPR}<w:fldChar w:fldCharType="end"/></w:r><w:r>${H1_RPR}<w:t xml:space="preserve"> Grant</w:t></w:r></w:p>`;
  for (const model of [breakFirst, fieldFirst]) {
    const bytes = docx(model + body('In this Agreement the following words have the meanings given.'));
    const out = await apply(bytes, [{ op: 'insert_after', expected: 'In this Agreement the following words have the meanings given.', text: '# **Change** in Law' }]);
    assert.equal(out.applied, 1);
    const xml = docXml(out.bytes);
    const p = paragraphWith(xml, ' in Law');
    assert.ok(p, 'the new heading is there');
    assert.ok(!/<w:bookmark(?:Start|End)|<w:br\b|<w:fldChar|<w:instrText/.test(p), p);
    assert.equal(pPrOf(p), H1_PPR);
    assert.equal(rPrOf(p), H1_RPR);
    const ids = [...xml.matchAll(/<w:bookmarkStart w:id="(\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'bookmark ids stay unique');
    for (const accepted of [acceptChangesBy(out.bytes), acceptAllChanges(out.bytes)]) {
      const clean = docXml(accepted);
      const count = (type) => (clean.match(new RegExp(`w:fldCharType="${type}"`, 'g')) ?? []).length;
      assert.equal(count('begin'), count('end'), 'every field still ends');
      assert.equal((clean.match(/<w:br w:type="page"\/>/g) ?? []).length, model === breakFirst ? 1 : 0, 'no extra page break');
      assert.equal(checkFormat(accepted, bytes, { mode: 'enforce' }).result.status, 'matches');
    }
  }
});

test('a body paragraph still copies its anchor', async () => {
  const anchor = 'Headings are for convenience only.';
  const out = await apply(FIRM, [{ op: 'insert_after', expected: anchor, text: 'References to a party include its successors.' }]);
  const p = paragraphWith(docXml(out.bytes), 'References to a party include its successors.');
  assert.equal(pPrOf(p), BODY_PPR);
  assert.equal(rPrOf(p), BODY_RPR);
});

test('a paragraph added after the last paragraph of a section does not copy its section break', async () => {
  assert.equal(sections(docXml(FIRM)), 2);
  const anchor = 'The parties have signed this Agreement on the date first written above.';
  const out = await apply(FIRM, [
    { op: 'insert_after', expected: anchor, text: 'Each party shall bear its own costs.' },
    { op: 'insert_after', expected: anchor, text: '# Costs' },
  ]);
  assert.equal(out.applied, 2);
  const xml = docXml(out.bytes);
  assert.equal(sections(xml), 2);
  assert.ok(!paragraphWith(xml, 'Each party shall bear its own costs.').includes('sectPr'));
  assert.ok(!paragraphWith(xml, 'Costs').includes('sectPr'));
  assert.equal(sections(docXml(acceptChangesBy(out.bytes))), 2);
  assert.equal(sections(docXml(acceptAllChanges(out.bytes))), 2);
});

test('deleting the paragraph that ends a section keeps the section after acceptance', async () => {
  const text = 'The parties have signed this Agreement on the date first written above.';
  const out = await apply(FIRM, [{ op: 'delete', expected: text }]);
  assert.equal(out.applied, 1);
  const [r] = out.results;
  assert.equal(r.status, 'applied');
  assert.equal(r.keptSectionBreak, true);
  assert.equal(r.markId, undefined);
  assert.ok(r.revisionIds.length >= 1, 'the words are struck through');
  const xml = docXml(out.bytes);
  assert.equal(sections(xml), 2);
  assert.ok(xml.includes(`<w:delText xml:space="preserve">${text}</w:delText>`));
  for (const accepted of [acceptChangesBy(out.bytes), acceptAllChanges(out.bytes)]) {
    const clean = docXml(accepted);
    assert.equal(sections(clean), 2);
    assert.ok(!clean.includes(text));
    // The break stays where it was: after the clause before it, before the Schedule.
    assert.ok(clean.indexOf(SECTION_1) > clean.indexOf('Headings are for convenience only.'));
    assert.ok(clean.indexOf(SECTION_1) < clean.indexOf('Schedule 1'));
  }
  // An ordinary paragraph still loses its mark, so accepting removes the line.
  const plain = await apply(FIRM, [{ op: 'delete', expected: 'Headings are for convenience only.' }]);
  assert.ok(plain.results[0].markId > 0);
  assert.ok(!docXml(acceptAllChanges(plain.bytes)).includes('Headings are for convenience only.'));
});

test('a copied paragraph never carries a recorded formatting change or the source\'s own revision mark', async () => {
  const pPr = `<w:pPr><w:jc w:val="both"/><w:rPr><w:ins w:id="5" w:author="Counsel" w:date="2026-09-01T00:00:00Z"/>${ARIAL}</w:rPr><w:pPrChange w:id="6" w:author="Counsel" w:date="2026-09-01T00:00:00Z"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>`;
  const rPr = `<w:rPr>${ARIAL}<w:rPrChange w:id="7" w:author="Counsel" w:date="2026-09-01T00:00:00Z"><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrChange></w:rPr>`;
  const bytes = docx(h1('Definitions') + para(pPr, rPr, 'Counsel added this clause.'));
  const out = await apply(bytes, [{ op: 'insert_after', expected: 'Counsel added this clause.', text: 'A clause of our own.' }]);
  assert.equal(out.applied, 1);
  const p = paragraphWith(docXml(out.bytes), 'A clause of our own.');
  assert.ok(!/pPrChange|rPrChange|Counsel/.test(p), p);
  assert.equal((p.match(/<w:ins /g) ?? []).length, 2, 'one mark on the paragraph, one on its words');
  assert.ok(p.startsWith(`<w:p><w:pPr><w:jc w:val="both"/><w:rPr><w:ins `) && p.includes(`/>${ARIAL}</w:rPr></w:pPr>`));
  assert.equal(rPrOf(p), `<w:rPr>${ARIAL}</w:rPr>`);
});

test('adding or removing a heading marks the contents field to be rebuilt; a body change does not', async () => {
  const dirtyBegins = (xml) => (xml.match(/<w:fldChar w:dirty="true" w:fldCharType="begin"\/>/g) ?? []).length;
  const added = await apply(FIRM, [{ op: 'insert_after', expected: 'Headings are for convenience only.', text: '# Term' }]);
  const xml = docXml(added.bytes);
  assert.equal(dirtyBegins(xml), 1, 'the contents field, not the page reference inside it');
  assert.ok(xml.indexOf('w:dirty="true"') < xml.indexOf(' TO</w:instrText>'));
  const removed = await apply(FIRM, [{ op: 'delete', expected: 'Interpretation' }]);
  assert.equal(dirtyBegins(docXml(removed.bytes)), 1);
  const plain = await apply(FIRM, [
    { op: 'insert_after', expected: 'Headings are for convenience only.', text: 'A body clause.' },
    { op: 'replace', expected: 'Definitions', text: 'Definitions and Interpretation' },
  ]);
  assert.ok(!docXml(plain.bytes).includes('w:dirty'));
  // A simple field is marked the same way; a file with no contents is left alone.
  const simple = docx(`<w:p><w:fldSimple w:instr=" TOC \\o &quot;1-3&quot; "><w:r><w:t>Contents</w:t></w:r></w:fldSimple></w:p>${h1('Definitions')}${body('Text.')}`);
  const s = await apply(simple, [{ op: 'insert_after', expected: 'Text.', text: '# Term' }]);
  assert.ok(docXml(s.bytes).includes('<w:fldSimple w:dirty="true" w:instr='));
  const none = await apply(docx(h1('Definitions') + body('Text.')), [{ op: 'insert_after', expected: 'Text.', text: '# Term' }]);
  assert.ok(!docXml(none.bytes).includes('w:dirty'));
});

test('a comment on a paragraph with a recorded formatting change opens after its properties', async () => {
  const pPr = '<w:pPr><w:jc w:val="both"/><w:pPrChange w:id="6" w:author="Counsel" w:date="2026-09-01T00:00:00Z"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>';
  const bytes = docx(para(pPr, BODY_RPR, 'Reformatted clause.'));
  const out = await apply(bytes, [{ op: 'comment', expected: 'Reformatted clause.', text: 'Confirm.' }]);
  assert.equal(out.applied, 1);
  assert.ok(docXml(out.bytes).includes('</w:pPrChange></w:pPr><w:commentRangeStart'));
});

test('the protocol still describes the same four operations', () => {
  for (const op of ['"replace"', '"insert_after"', '"delete"', '"comment"']) assert.ok(OPS_PROTOCOL.includes(op));
  assert.ok(OPS_PROTOCOL.includes("takes the look of the document's own headings"));
  assert.ok(OPS_PROTOCOL.includes('a heading of a level it has none of is not added'));
});
