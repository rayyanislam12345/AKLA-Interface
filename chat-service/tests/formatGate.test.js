import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { formatGate, formatProfile } from '../docxChecks.js';
import { fingerprint, gateFormat, formatProfileOf, formatLine, clearFingerprintCache, checkFormat, formatGateMode, formatRecord, baseName, FORMAT_REFUSED_SENTENCE, STANDARD_REFUSED_SENTENCE, variableLinesFor, storeUnlessRefused, openWorkingCopy } from '../formatFingerprint.js';
import { inspectDocx, applyDocxOps, acceptChangesBy, acceptAllChanges } from '../docxAgent.js';

// A small firm-like file: Arial set on every run over a Times New Roman
// "Normal" (as in the Concession Agreement), one multilevel list, a header
// with a title line, A4 with 3.05 cm side margins.
const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const ARIAL = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr>';
const STYLES = `<w:styles ${ns}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>`
  + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:style>`
  + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`
  + `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`;
const NUMBERING = `<w:numbering ${ns}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum>`
  + `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/></w:lvl></w:abstractNum>`
  + `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
const THEME = `<a:theme ${ns} name="Office"><a:themeElements><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
const FONTS = `<w:fonts ${ns}><w:font w:name="Arial"/><w:font w:name="Times New Roman"/></w:fonts>`;
const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`;
const SECT = '<w:sectPr w:rsidR="00AA1111"><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838" w:code="9"/><w:pgMar w:top="2160" w:right="1728" w:bottom="2160" w:left="1728" w:header="1008" w:footer="1342" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>';
const run = (text, rPr = ARIAL) => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (text, pPr = '', rPr = ARIAL) => `<w:p w14:paraId="1A2B3C4D" w14:textId="77777777">${pPr}${run(text, rPr)}</w:p>`;
const H1 = '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>';
const H2 = '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>';
const LIMB = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:ind w:left="1440" w:hanging="720"/></w:pPr>';
const BODY = [
  para('DEFINITIONS AND INTERPRETATION', H1),
  para('Definitions', H2),
  para('In this Agreement the following words shall have the meanings given to them below, unless the context requires otherwise.'),
  para('the Concessionaire shall design, build and operate the Project in accordance with the Specifications;', LIMB),
  para('the Authority shall grant the Concessionaire the right to collect the Tolls for the Concession Period;', LIMB),
  para('Each Party shall perform its obligations under this Agreement in good faith and with due diligence and expedition.'),
  para('The Concession Period shall be [●] years from the Commercial Operations Date.'),
];
const HEADER = `<w:hdr ${ns}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run('Standard Concession Agreement')}</w:p><w:p>${run('Execution Version')}</w:p></w:hdr>`;
const FOOTER = `<w:ftr ${ns}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('Page 1 of 9')}</w:p></w:ftr>`;

function parts({ body = BODY, sect = SECT, styles = STYLES, numbering = NUMBERING, header = HEADER } = {}) {
  return {
    'word/document.xml': `<w:document ${ns}><w:body>${body.join('')}${sect}</w:body></w:document>`,
    'word/styles.xml': styles, 'word/numbering.xml': numbering, 'word/theme/theme1.xml': THEME, 'word/fontTable.xml': FONTS,
    'word/_rels/document.xml.rels': RELS, 'word/header1.xml': header, 'word/footer1.xml': FOOTER,
  };
}
const docx = p => zipSync(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, strToU8(v)])));
const gate = (changes, opts) => formatGate(parts(changes), parts(), { base: 'ADB68', ...opts });
const only = (result, start) => {
  assert.equal(result.status, 'drift', JSON.stringify(result.findings));
  assert.equal(result.findings.length, 1, JSON.stringify(result.findings));
  assert.ok(result.findings[0].startsWith(start), result.findings[0]);
};

test('an identical file matches, and the reply line names the base', () => {
  const result = gate();
  assert.deepEqual(result, { ...result, status: 'matches', base: 'ADB68', findings: [] });
  assert.equal(formatLine(result), "Format matches the firm's standard (ADB68).");
});

test('a changed margin is drift, said in centimetres', () => {
  only(gate({ sect: SECT.replace('w:left="1728"', 'w:left="1440"') }), 'page margin changed (section 1: left 3.05 cm → 2.54 cm)');
  only(gate({ sect: SECT.replace('w:w="11906" w:h="16838" w:code="9"', 'w:w="12240" w:h="20160" w:code="5"') }), 'page size changed (section 1: A4 portrait → US Legal portrait)');
});

test('a changed style definition is drift', () => {
  only(gate({ styles: STYLES.replace('<w:rPr><w:b/></w:rPr>', '<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>') }), 'the style definitions changed');
});

test('numbering may gain a restart of an existing list, nothing else', () => {
  const restart = NUMBERING.replace('</w:numbering>', '<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>');
  assert.equal(gate({ numbering: restart }).status, 'matches');
  const newAbstract = NUMBERING.replace('<w:num w:numId="1">', '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1">')
    .replace('</w:numbering>', '<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num></w:numbering>');
  const result = gate({ numbering: newAbstract });
  assert.equal(result.status, 'drift');
  assert.ok(result.findings.some(f => f.startsWith('1 new list format was added')), JSON.stringify(result.findings));
  assert.ok(result.findings.some(f => f.includes("does not follow one of the firm's list formats")));
  only(gate({ numbering: NUMBERING.replace('w:val="%1.%2"', 'w:val="%1-%2"') }), 'the numbering definitions changed');
});

test('an extra section (a copied section break) is drift', () => {
  const body = [...BODY];
  body.splice(3, 0, `<w:p><w:pPr>${SECT}</w:pPr>${run('A clause added before the Schedules.')}</w:p>`);
  only(gate({ body }), 'the number of sections changed (the firm\'s file has 1, this draft has 2)');
});

test('text in Times New Roman is caught, through the Normal style as well as on the run', () => {
  const bare = [...BODY, para('A heading the engine added with no run formatting, so it falls back to the Normal style.', '', '')];
  only(gate({ body: bare }), "1 paragraph is in Times New Roman, which the firm's file never uses for text of that kind (for example \"A heading the engine added");
  const direct = [...BODY, para('A run set in Times New Roman directly, which is a font the firm does not use in its body text.', '', '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="22"/></w:rPr>')];
  const result = gate({ body: direct });
  assert.equal(result.status, 'drift');
  assert.ok(result.findings.some(f => f.startsWith('1 paragraph is in Times New Roman')), JSON.stringify(result.findings));
  assert.ok(result.findings.some(f => f.includes("formatting the firm's file does not have (for example Times New Roman, 11 pt)")));
});

test('a typed clause number is drift; a typed number the firm file already has is not', () => {
  only(gate({ body: [...BODY, para('1.1 The Concessionaire shall procure the Insurances.')] }), '1 paragraph starts with a typed clause number instead of Word\'s numbering (for example "1.1 The Concessionaire');
  const withTyped = [...BODY, para('2. The Fee is payable monthly.')];
  assert.equal(formatGate(parts({ body: withTyped.map(p => p.replace('monthly', 'quarterly')) }), parts({ body: withTyped })).status, 'matches');
});

test('a bold defined term and tracked changes are not drift', () => {
  const bold = ARIAL.replace('<w:sz', '<w:b/><w:bCs/><w:sz');
  const defined = `<w:p><w:pPr><w:rPr><w:ins w:id="9" w:author="AKLA AI" w:date="2026-10-19T00:00:00Z"/></w:rPr></w:pPr><w:ins w:id="10" w:author="AKLA AI" w:date="2026-10-19T00:00:00Z">${run('“')}${run('Lenders', bold)}${run('” means the banks providing the senior debt for the Project.')}</w:ins></w:p>`;
  const tracked = `<w:p>${run('Each Party shall ')}<w:del w:id="11" w:author="AKLA AI" w:date="2026-10-19T00:00:00Z"><w:r>${ARIAL}<w:delText>promptly </w:delText></w:r></w:del><w:ins w:id="12" w:author="AKLA AI" w:date="2026-10-19T00:00:00Z">${run('without delay ')}</w:ins>${run('notify the other.')}</w:p>`;
  const formatChange = `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:rPrChange w:id="13" w:author="Counsel" w:date="2026-10-19T00:00:00Z"><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrChange></w:rPr><w:t>Reformatted earlier by counsel.</w:t></w:r></w:p>`;
  const result = gate({ body: [...BODY, defined, tracked, formatChange] });
  assert.deepEqual(result.findings, []);
  assert.equal(result.status, 'matches');
});

test('a run or paragraph format the firm file lacks is drift', () => {
  only(gate({ body: [...BODY, para('Coloured text.', '', ARIAL.replace('<w:sz', '<w:color w:val="FF0000"/><w:sz'))] }), "1 piece of text uses formatting the firm's file does not have (for example Arial, 11 pt, coloured)");
  only(gate({ body: [...BODY, para('A bare heading.', '<w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:before="480"/></w:pPr>')] }), "1 paragraph uses a paragraph format the firm's file does not have (for example style Heading1, spacing)");
});

test('a header line holding a blank or a date may be filled without being declared; its look may not change', () => {
  const header = `<w:hdr ${ns}><w:p>${run('VOLUME I: INSTRUCTION TO BIDDERS')}</w:p><w:p>${run('[●]')}</w:p><w:p>${run('May 08, 2026')}</w:p></w:hdr>`;
  const filled = header.replace('[●]', 'Hyderabad Bypass Project').replace('May 08, 2026', 'October 19, 2026');
  assert.equal(gate({ header: filled }, {}).status, 'drift', 'against the fixture without blanks, any change is drift');
  const base = parts({ header });
  assert.equal(formatGate(parts({ header: filled }), base).status, 'matches');
  const recoloured = header.replace(`${run('[●]')}`, run('Hyderabad Bypass Project', ARIAL.replace('<w:sz', '<w:color w:val="FF0000"/><w:sz')));
  assert.deepEqual(formatGate(parts({ header: recoloured }), base).findings.filter(f => f.startsWith('the header')), ['the header of section 1 changed']);
  const retitled = header.replace('INSTRUCTION TO BIDDERS', 'INSTRUCTIONS TO BIDDERS');
  assert.equal(formatGate(parts({ header: retitled }), base).status, 'drift', 'the title line is fixed unless a change was asked of it');
  assert.equal(formatGate(parts({ header: retitled }), base, { variableParagraphs: [{ part: 'word/header1.xml', text: 'VOLUME I: INSTRUCTION TO BIDDERS' }] }).status, 'matches');
  assert.deepEqual(fingerprint(docx(base)).variableHeaderParagraphs, [{ part: 'header1.xml', index: 1 }, { part: 'header1.xml', index: 2 }]);
});

test('a filled header blank passes checkFormat through the engine; the lines a change list targets are variable', async () => {
  const header = `<w:hdr ${ns}><w:p>${run('VOLUME I: INSTRUCTION TO BIDDERS')}</w:p><w:p>${run('[●]')}</w:p></w:hdr>`;
  const standard = docx(parts({ header }));
  const view = inspectDocx(standard, { placeholders: true });
  const ref = (text) => [...view.byRef.values()].find(r => r.exactText === text);
  assert.equal(ref('[●]').part, 'word/header1.xml');
  const ops = [
    { op: 'replace', p: ref('[●]').index, expected: '[●]', text: 'Hyderabad Bypass' },
    { op: 'replace', p: ref('VOLUME I: INSTRUCTION TO BIDDERS').index, expected: 'VOLUME I: INSTRUCTION TO BIDDERS', text: 'VOLUME I: INSTRUCTIONS TO BIDDERS' },
  ];
  assert.deepEqual(variableLinesFor(ops, view.byRef), [{ part: 'word/header1.xml', text: '[●]' }, { part: 'word/header1.xml', text: 'VOLUME I: INSTRUCTION TO BIDDERS' }]);
  const blankOnly = await applyDocxOps(standard, ops.slice(0, 1), view.byRef);
  assert.equal(blankOnly.applied, 1);
  const filled = checkFormat(acceptChangesBy(blankOnly.bytes), standard, { base: 'Standard Instructions to Bidders [AKLA].docx', mode: 'enforce' });
  assert.equal(filled.result.status, 'matches', JSON.stringify(filled.result.findings));
  const both = await applyDocxOps(standard, ops, view.byRef);
  const bytes = acceptChangesBy(both.bytes);
  assert.equal(checkFormat(bytes, standard, { mode: 'enforce' }).refused, true, 'the title is not a blank');
  assert.equal(checkFormat(bytes, standard, { mode: 'enforce', variableParagraphs: variableLinesFor(ops, view.byRef) }).result.status, 'matches');
});

test('a header changes only in a declared variable line', () => {
  const retitled = HEADER.replace('Standard Concession Agreement', 'Concession Agreement for the M-6 Motorway');
  only(gate({ header: retitled }), 'the header of section 1 changed');
  assert.equal(gate({ header: retitled }, { variableParagraphs: [{ part: 'header', index: 0 }] }).status, 'matches');
  assert.equal(gate({ header: retitled }, { variableParagraphs: ['Standard Concession'] }).status, 'matches');
  // The variable line may change its words, not its look.
  const restyled = HEADER.replace('Standard Concession Agreement</w:t></w:r>', 'M-6</w:t></w:r>').replace('<w:jc w:val="right"/>', '<w:jc w:val="left"/>');
  assert.equal(gate({ header: restyled }, { variableParagraphs: [{ part: 'header', index: 0 }] }).status, 'drift');
});

test('the fingerprint resolves fonts through styles and is cached by content', () => {
  clearFingerprintCache();
  const bytes = docx(parts());
  const fp = fingerprint(bytes);
  assert.equal(fp.sections.length, 1);
  assert.deepEqual(fp.sections[0].pgMar, { top: 2160, bottom: 2160, left: 1728, right: 1728, header: 1008, footer: 1342, gutter: 0 });
  assert.equal(fp.sections[0].pgSz.name, 'A4 portrait');
  assert.deepEqual(fp.sections[0].headerRefs, [{ type: 'default', part: 'header1.xml' }]);
  assert.deepEqual(fp.headingStyles, { 1: 'Heading1', 2: 'Heading2' });
  assert.equal(fp.body.font, 'Arial');
  assert.equal(fp.body.fontShare, 1);
  assert.equal(fp.body.sizeHalfPts, 22);
  assert.equal(fp.placeholder, '[●]');
  assert.deepEqual(fp.numIds, ['2']);
  assert.match(fp.parts.styles, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint(bytes), fp, 'the second call is served from the cache');
  assert.equal(formatProfileOf(bytes), formatProfileOf(bytes));
  // Runs with no font of their own: Normal's Times New Roman, and the theme's
  // Calibri where no style names a font.
  const plain = formatProfile(parts({ body: [para('Plain text in the Normal style.', '', '')], styles: STYLES.replace('<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:style>', '</w:style>') }));
  assert.equal(plain.body.font, 'Calibri');
  assert.equal(formatProfile(parts({ body: [para('Plain text.', '', '')] })).body.font, 'Times New Roman');
});

test('the gate on bytes: matches itself, refuses a changed margin', () => {
  const bytes = docx(parts());
  assert.equal(gateFormat(bytes, bytes, { base: 'ADB68' }).status, 'matches');
  const drift = gateFormat(docx(parts({ sect: SECT.replace('w:left="1728"', 'w:left="1440"') })), bytes, { base: 'ADB68' });
  assert.deepEqual(drift.findings, ['page margin changed (section 1: left 3.05 cm → 2.54 cm)']);
  assert.equal(typeof drift.ms, 'number');
  assert.equal(formatLine(drift), "Format differs from the firm's standard (ADB68): page margin changed (section 1: left 3.05 cm → 2.54 cm).");
});

test('a font or size is judged paragraph by paragraph: a stray paragraph in a font the file never uses for that kind of text is refused even in a long file', () => {
  const long = [...BODY, ...Array.from({ length: 40 }, (_, i) => para(`Clause text number ${i} that runs on long enough to make the document a realistic length for the share rule.`))];
  const result = formatGate(parts({ body: [...long, para('Stray heading', '', '')] }), parts({ body: long }));
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.findings, ["1 paragraph is in Times New Roman, which the firm's file never uses for text of that kind (for example \"Stray heading\")"]);
  // A font the file does use for that kind of text (Times New Roman on its cover) is not refused.
  const cover = para('THE COVER IN TIMES', '', '');
  assert.equal(formatGate(parts({ body: [cover, ...long, para('Another line in Times', '', '')] }), parts({ body: [cover, ...long] })).status, 'matches');
});

// An RFP-like file: 11 pt body text, 10 pt tables (as the ITB standard: 89.6% / 9.3%).
const TEN = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/></w:rPr>';
const cell = (text) => `<w:tc>${para(text, '', TEN)}</w:tc>`;
const table = (rows) => `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>${rows.map(([a, b]) => `<w:tr>${cell(a)}${cell(b)}</w:tr>`).join('')}</w:tbl>`;
const DATA_SHEET = [['Project', '[●]'], ['Address for submission', '[●]'], ['Pre-Bid Meeting(s)', '[●]'], ['Bid Submission Deadline', '[●]']];

test('a fill that only moves the proportions between formats the file already has is not refused: the share is a note', () => {
  const base = [...BODY, table(DATA_SHEET)];
  const address = 'Project Director, Sindh Public Private Partnership Unit, Finance Department, Government of Sindh, 3rd Floor, New Sindh Secretariat Building, Karachi';
  const filled = [...BODY, table(DATA_SHEET.map(([a]) => [a, address]))];
  const long = formatGate(parts({ body: filled }), parts({ body: base }));
  assert.equal(long.status, 'matches', JSON.stringify(long.findings));
  assert.ok(long.notes.some(n => /of the text is in 11 pt \(the firm's file has/.test(n)), JSON.stringify(long.notes));
  // Deleting an 11 pt paragraph, or lengthening the 10 pt line, is not drift either.
  assert.equal(formatGate(parts({ body: base.filter((_, i) => i !== 5) }), parts({ body: base })).status, 'matches');
  // A size the file never uses for body text still is, and the edit is named by what it was compared with.
  const twelve = [...base, para('A clause in 12 pt.', '', ARIAL.replace('w:val="22"', 'w:val="24"'))];
  const edit = formatGate(parts({ body: twelve }), parts({ body: base }), { reference: 'the version it was made from' });
  assert.equal(edit.status, 'drift');
  assert.ok(edit.findings.some(f => f === '1 paragraph is in 12 pt, which the version it was made from never uses for text of that kind (for example "A clause in 12 pt.")'), JSON.stringify(edit.findings));
  assert.ok(edit.findings.every(f => !f.includes("the firm's file")));
});

test('times, decimals and amounts filled into cells and clauses are not typed clause numbers; a typed clause number still is', () => {
  const base = [...BODY, table(DATA_SHEET), para('[●] of the Bid Security is forfeited.')];
  const filled = [...BODY, table([['Project', '2.5 km of dual carriageway'], ['Address for submission', '10.30 a.m. Pakistan Standard Time'], ['Pre-Bid Meeting(s)', '10.30 A.M. PST'], ['Bid Submission Deadline', '1.']]), para('1.5 million of the Bid Security is forfeited.')];
  const result = formatGate(parts({ body: filled }), parts({ body: base }));
  assert.equal(result.status, 'matches', JSON.stringify(result.findings));
  for (const text of ['10.30 a.m. on the Bid Submission Deadline.', '2.5 km of the Site is handed over.', '12.5 MW of capacity is contracted.', '15.5% of the Tariff is indexed.']) {
    assert.equal(gate({ body: [...BODY, para(text)] }).status, 'matches', text);
  }
  only(gate({ body: [...BODY, para('4.2 The Grantor shall act reasonably.')] }), '1 paragraph starts with a typed clause number');
  only(gate({ body: [...BODY, para('(a) the Concessionaire shall procure the Insurances.')] }), '1 paragraph starts with a typed clause number');
});

test('Word renumbering paragraph ids in a header is not a change', () => {
  const header = HEADER.replace('<w:p>', '<w:p w14:paraId="0F0F0F0F" w14:textId="12121212">');
  const base = formatGate(parts({ header }), parts({ header: HEADER.replace('<w:p>', '<w:p w14:paraId="0A0A0A0A" w14:textId="34343434">') }));
  assert.equal(base.status, 'matches', JSON.stringify(base.findings));
});

// ---------------------------------------------------------------- fill paths

test('checkFormat as the fill paths run it: the line on a match, a refusal with the list and one sentence on drift, a warning in report mode', () => {
  const bytes = docx(parts());
  const ok = checkFormat(bytes, bytes, { base: 'standards/x/Standard Concession Agreement [AKLA].docx', mode: 'enforce' });
  assert.equal(ok.refused, false);
  assert.equal(ok.result.status, 'matches');
  assert.equal(ok.text, "Format matches the firm's standard (Standard Concession Agreement [AKLA]).");
  const margin = docx(parts({ sect: SECT.replace('w:left="1728"', 'w:left="1440"'), body: [...BODY, para('1.1 The Grantor shall act reasonably.')] }));
  const refused = checkFormat(margin, bytes, { base: 'ADB68.docx', mode: 'enforce' });
  assert.equal(refused.refused, true);
  assert.equal(refused.text, `The format check found that this file differs from the firm's standard (ADB68):\n- Page margin changed (section 1: left 3.05 cm → 2.54 cm)\n- 1 paragraph starts with a typed clause number instead of Word's numbering (for example "1.1 The Grantor shall act reasonably.")\n${FORMAT_REFUSED_SENTENCE}`);
  assert.deepEqual(formatRecord(refused), { status: 'drift', base: 'ADB68', findings: refused.result.findings, mode: 'enforce', ms: refused.result.ms });
  const reported = checkFormat(margin, bytes, { base: 'ADB68', mode: 'report' });
  assert.equal(reported.refused, false, 'report mode stores anyway');
  assert.match(reported.text, /^Warning: the format differs from the firm's standard \(ADB68\), and the file was saved anyway because the format check is set to report only:\n- Page margin changed/);
  // An edit is compared with the version it was made from, and says so.
  const edit = checkFormat(bytes, bytes, { base: 'CA-v3.docx', subject: 'the version it was made from', mode: 'enforce' });
  assert.equal(edit.text, 'Format matches the version it was made from (CA-v3).');
  // A file the gate cannot read refuses nothing and says the check did not run.
  const broken = checkFormat(new Uint8Array([1, 2, 3]), bytes, { base: 'ADB68', mode: 'enforce' });
  assert.equal(broken.refused, false);
  assert.equal(broken.result.status, 'error');
  assert.match(broken.text, /^The format check could not run \(.+\), so this file has not been compared with the firm's standard; check its layout in Word before it goes out\.$/);
  assert.equal(baseName('a/b/ADB58.7.docx'), 'ADB58.7');
  assert.equal(baseName(null), null);
});

test('FORMAT_GATE: enforce unless it says report', () => {
  assert.equal(formatGateMode({}), 'enforce');
  assert.equal(formatGateMode({ FORMAT_GATE: 'report' }), 'report');
  assert.equal(formatGateMode({ FORMAT_GATE: ' REPORT ' }), 'report');
  assert.equal(formatGateMode({ FORMAT_GATE: 'off' }), 'enforce', 'an unknown value is the safe one');
  assert.equal(formatGateMode({ FORMAT_GATE: 'enforce' }), 'enforce');
  const before = process.env.FORMAT_GATE;
  try {
    process.env.FORMAT_GATE = 'report';
    const bytes = docx(parts());
    const drift = docx(parts({ sect: SECT.replace('w:left="1728"', 'w:left="1440"') }));
    assert.equal(checkFormat(drift, bytes, { base: 'ADB68' }).refused, false, 'read from the environment on each call');
    delete process.env.FORMAT_GATE;
    assert.equal(checkFormat(drift, bytes, { base: 'ADB68' }).refused, true);
  } finally {
    if (before === undefined) delete process.env.FORMAT_GATE; else process.env.FORMAT_GATE = before;
  }
});

test('every Word fill path runs the gate before it stores, and the untrue "exported inside that file" sentence is gone', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /import \{ checkFormat, formatRecord, variableLinesFor, storeUnlessRefused, openWorkingCopy \} from "\.\/formatFingerprint\.js";/);
  assert.ok(!/exported inside that file/.test(server), 'the free-draft prompt no longer claims the draft is exported inside the standard');
  // The Hub turn on a Word file (fill, edit, guided answer, revision): the gate after the accept, before the copy is uploaded.
  const accept = server.indexOf('if (fillIn && out.applied > 0) out.bytes = acceptChangesBy(out.bytes);');
  const gate = server.indexOf('checkFormat(out.bytes, docxBase.bytes', accept);
  const upload = server.indexOf('.upload(storagePath, out.bytes', accept);
  assert.ok(accept > 0 && gate > accept && upload > gate, 'docx turn: accept, gate, upload');
  // Rows and the copy are written only inside the store storeUnlessRefused runs.
  // The store runs behind the format gate and the clause-list check together (draftChecks.js draftGate).
  assert.ok(server.indexOf('const gate = draftGate(format, clauses, auto?.wording.line ?? "");', gate) > gate);
  const gated = server.indexOf('const gated = await storeUnlessRefused(gate, async () => {', gate);
  assert.ok(gated > gate && gated < server.indexOf('editRecords(', gate) && server.indexOf('formatRefused = gated.refused;', gated) > upload, 'docx turn: rows and upload inside the gated store');
  assert.match(server.slice(gate, gated), /subject: docxBase\.bucket === "precedent-library" \? "the firm's standard" : "the version it was made from"/, 'only a file read from the library is the firm\'s standard');
  assert.match(server.slice(gate, gated), /variableParagraphs: variableLinesFor\(aligned, docxBase\.inspection\.byRef\)/);
  // The guided drafting's working copy: openWorkingCopy, whose store uploads.
  const working = server.indexOf('await openWorkingCopy(standardBytes, {');
  assert.ok(working > 0 && working < server.indexOf('.upload(storagePath, bytes,', working) && server.indexOf('accept: acceptAllChanges,', working) > working, 'guide: gate inside openWorkingCopy, then upload');
  // A review's suggestions written into the file: the gate before the upload.
  const review = server.indexOf('async function writeReviewChanges(');
  const reviewGate = server.indexOf('checkFormat(out.bytes, bytes, { base: head.data?.fileName, subject: "the version it was made from" })', review);
  assert.ok(review > 0 && reviewGate > review && server.indexOf('if (format?.refused) return { headMoved: false, formatRefused: true', reviewGate) < server.indexOf('.upload(storagePath, out.bytes', reviewGate), 'review: gate, refusal, then upload');
  // The connector: the gate before saveVersion, with the lines its ops target.
  const connector = readFileSync(new URL('../connector/tools/fillStandardWrite.js', import.meta.url), 'utf8');
  assert.ok(connector.indexOf('checkFormat(fileBytes, standard.bytes') > 0 && connector.indexOf('checkFormat(fileBytes, standard.bytes') < connector.indexOf('writes.saveVersion('));
  assert.ok(connector.includes('variableParagraphs: variableLinesFor(aligned, inspection.byRef)'));
  // deploy.sh ships the module in all three lists (scp, mv, chown).
  const deploy = readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');
  assert.equal(deploy.match(/formatFingerprint\.js/g)?.length, 3);
});

// ---------------------------------------------------------------- gate, then store

// A stub of what the Hub's store does: an upload and an ai_artifacts row,
// recorded so a test can say nothing was written.
function recorder() {
  const calls = { upload: [], insert: [] };
  return {
    calls,
    store: async (bytes) => {
      calls.upload.push(bytes);
      calls.insert.push({ table: 'ai_artifacts' });
      return { id: 'artifact-1' };
    },
  };
}

test('the docx turn: a refusal in enforce mode stores nothing and sends the list; report mode stores and appends the warning; a match appends the format line', async () => {
  const bytes = docx(parts());
  const drift = docx(parts({ sect: SECT.replace('w:left="1728"', 'w:left="1440"') }));
  const sent = [];
  const send = (event, payload) => sent.push([event, payload.text]);

  const refused = checkFormat(drift, bytes, { base: 'CA-v3.docx', subject: 'the version it was made from', mode: 'enforce' });
  const r1 = recorder();
  const metadata = { formatCheck: formatRecord(refused) };
  const a = await storeUnlessRefused(refused, r1.store, send);
  assert.equal(a.refused, true);
  assert.equal(r1.calls.upload.length, 0, 'no upload');
  assert.equal(r1.calls.insert.length, 0, 'no ai_artifacts or redline_suggestions row');
  assert.equal(metadata.formatCheck.status, 'drift');
  assert.match(a.appended, /^\n\nThe format check found that this file differs from the version it was made from \(CA-v3\):\n- Page margin changed/);
  assert.deepEqual(sent, [['delta', a.appended]]);

  sent.length = 0;
  const reported = checkFormat(drift, bytes, { base: 'CA-v3.docx', mode: 'report' });
  const r2 = recorder();
  const b = await storeUnlessRefused(reported, r2.store, send);
  assert.equal(b.refused, false);
  assert.equal(r2.calls.upload.length, 1, 'report mode stores the copy');
  assert.deepEqual(b.stored, { id: 'artifact-1' });
  assert.match(b.appended, /^\n\nWarning: the format differs from the firm's standard \(CA-v3\)/);
  assert.deepEqual(sent, [['delta', b.appended]]);

  // A store that wrote no copy (the head moved) adds no format line; no gate at all (nothing applied) still stores.
  const matched = checkFormat(bytes, bytes, { mode: 'enforce' });
  assert.equal((await storeUnlessRefused(matched, async () => null)).appended, '');
  const r3 = recorder();
  assert.equal((await storeUnlessRefused(null, r3.store)).refused, false);
  assert.equal(r3.calls.upload.length, 1);
  assert.equal((await storeUnlessRefused(matched, recorder().store)).appended, "\n\nFormat matches the firm's standard.");
});

test('the guided drafting\'s first save: a standard whose own revisions move its look once accepted stores nothing and says so without asking the lawyer to try again', async () => {
  const bytes = docx(parts());
  // The standard carries a tracked margin change: accepted, the margin moves.
  const tracked = docx(parts({ sect: SECT.replace('<w:cols w:space="720"/>', '<w:cols w:space="720"/><w:sectPrChange w:id="5" w:author="Counsel" w:date="2026-09-01T00:00:00Z"><w:sectPr><w:pgMar w:top="2160" w:right="1728" w:bottom="2160" w:left="1440" w:header="1008" w:footer="1342" w:gutter="0"/></w:sectPr></w:sectPrChange>') }));
  const r1 = recorder();
  const refused = await openWorkingCopy(tracked, { base: 'standards/x/Standard Concession Agreement [AKLA].docx', accept: () => docx(parts({ sect: SECT.replace('w:left="1728"', 'w:left="1440"') })), store: r1.store, mode: 'enforce' });
  assert.equal(refused.stored, null, 'no working copy, so the questionnaire does not start');
  assert.equal(r1.calls.upload.length, 0);
  assert.equal(refused.format.refused, true);
  assert.ok(refused.format.text.endsWith(STANDARD_REFUSED_SENTENCE));
  assert.ok(!refused.format.text.includes(FORMAT_REFUSED_SENTENCE));
  assert.match(refused.format.text, /^The format check found that this file differs from the firm's standard \(Standard Concession Agreement \[AKLA\]\):\n- Page margin changed/);

  const r2 = recorder();
  const opened = await openWorkingCopy(bytes, { base: 'ADB68.docx', accept: acceptAllChanges, store: r2.store, mode: 'enforce' });
  assert.deepEqual(opened.stored, { id: 'artifact-1' });
  assert.equal(r2.calls.upload.length, 1);
  assert.equal(opened.format.text, "Format matches the firm's standard (ADB68).");
  const r3 = recorder();
  const reported = await openWorkingCopy(tracked, { base: 'ADB68.docx', accept: () => docx(parts({ sect: SECT.replace('w:left="1728"', 'w:left="1440"') })), store: r3.store, mode: 'report' });
  assert.equal(r3.calls.upload.length, 1, 'report mode opens it anyway');
  assert.match(reported.format.text, /^Warning: /);
});
