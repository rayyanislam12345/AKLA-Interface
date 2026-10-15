import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { inspectDocx, applyDocxOps, acceptAllChanges, applyReviewSuggestions } from '../docxAgent.js';
import { fetchOfficial, sourceIdentityMatches, officialUrl } from '../sourcePolicy.js';
import { compareFormat, inspectPackage } from '../docxChecks.js';
const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
function file() {
  return zipSync({
    'word/document.xml': strToU8(`<w:document ${ns}><w:body><w:p w14:paraId="12345678"><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Party Alpha pays 10.</w:t></w:r></w:p><w:p><w:r><w:t>Unchanged clause.</w:t></w:r></w:p><w:sectPr><w:pgMar w:top="1440"/></w:sectPr></w:body></w:document>`),
    'word/header1.xml': strToU8(`<w:hdr ${ns}><w:p><w:r><w:t>Party [NAME]</w:t></w:r></w:p></w:hdr>`),
  });
}
test('edits preserve paragraph attributes and untouched content, including across clean export', async () => {
  const bytes = file(); const view = inspectDocx(bytes);
  const output = await applyDocxOps(bytes, [{ op: 'replace', p: 1, expected: 'Party Alpha pays 10.', text: 'Party Beta pays 20.' }], view.byRef);
  const xml = strFromU8(unzipSync(output.bytes)['word/document.xml']);
  assert.equal(output.applied, 1);
  assert.ok(xml.includes('w14:paraId="12345678"'));
  assert.ok(xml.includes('<w:p><w:r><w:t>Unchanged clause.</w:t></w:r></w:p>'));
  assert.ok(strFromU8(unzipSync(acceptAllChanges(output.bytes))['word/document.xml']).includes('Beta pays 20.'));
});
test('header placeholders can be read, edited, and accepted', async () => {
  const bytes = file(); const view = inspectDocx(bytes);
  const [p, ref] = [...view.byRef].find(([,r]) => r.part === 'word/header1.xml');
  assert.ok(view.listing.includes('Party [NAME]'));
  const output = await applyDocxOps(bytes, [{ op: 'replace', p, expected: ref.exactText, text: 'Party Beta' }], view.byRef);
  assert.equal(output.applied, 1);
  assert.equal(output.validation.placeholders.length, 0);
  assert.ok(strFromU8(unzipSync(acceptAllChanges(output.bytes))['word/header1.xml']).includes('Beta'));
  assert.deepEqual(unzipSync(output.bytes)['word/document.xml'], unzipSync(bytes)['word/document.xml']);
});
test('stale and hidden paragraph edits are refused', async () => {
  const bytes = file(); const view = inspectDocx(bytes, { budget: 0 });
  const hidden = await applyDocxOps(bytes, [{op:'delete',p:1,expected:'Party Alpha pays 10.'}], view.byRef);
  assert.equal(hidden.applied, 0);
  const stale = await applyDocxOps(bytes, [{op:'replace',p:1,expected:'Wrong text',text:'Changed'}], inspectDocx(bytes).byRef);
  assert.equal(stale.applied, 0);
});
test('review suggestions redline a file that already has tracked changes', () => {
  const body = `<w:p><w:r><w:t xml:space="preserve">The fee is thirty (30) days payable by Party Alpha.</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Existing </w:t></w:r><w:ins w:id="1" w:author="Counsel" w:date="2026-09-01T00:00:00Z"><w:r><w:t>redline</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> stays.</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Accepted wording here.</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>`;
  const bytes = zipSync({ 'word/document.xml': strToU8(`<w:document ${ns}><w:body>${body}<w:sectPr/></w:body></w:document>`) });
  const { bytes: out, results } = applyReviewSuggestions(bytes, [
    { id: 'a', original: 'thirty (30) days payable by Party Alpha', suggested: 'forty (40) days payable by Party Beta', accepted: false },
    { id: 'b', original: 'Accepted wording<sup><a href="#f">[2]</a></sup> here.', suggested: 'Final wording here.', accepted: true },
    { id: 'c', original: 'Not in this file at all', suggested: 'Anything', accepted: false },
  ], { legacy: true });
  const xml = strFromU8(unzipSync(out)['word/document.xml']);
  assert.deepEqual(results.map(r => r.status), ['applied', 'applied', 'skipped']);
  assert.equal(results[2].reason, 'not_found');
  // Two separate word changes, not one struck-out stretch between them.
  assert.equal((xml.match(/<w:del [^>]*w:author="AKLA AI"/g) ?? []).length, 2);
  assert.ok(xml.includes('<w:delText xml:space="preserve">thirty (30)</w:delText>'));
  assert.ok(xml.includes('<w:r><w:t xml:space="preserve"> days payable by Party </w:t></w:r>'));
  // The lawyer's own revision is untouched; the accepted one leaves no markup.
  assert.ok(xml.includes('w:author="Counsel"'));
  assert.ok(!xml.includes('(accepted)'));
  assert.ok(xml.includes('<w:t xml:space="preserve">Final</w:t>'));
  assert.ok(xml.includes('<w:footnoteReference w:id="2"/>'));
  assert.ok(strFromU8(unzipSync(acceptAllChanges(out))['word/document.xml']).includes('forty (40)'));
});
test('format comparison detects changed margins and placeholders', () => {
  const parts = Object.fromEntries(Object.entries(unzipSync(file())).map(([p,b]) => [p,strFromU8(b)]));
  assert.equal(compareFormat(parts, parts).status, 'checked');
  const altered = { ...parts, 'word/document.xml': parts['word/document.xml'].replace('1440', '720') };
  assert.ok(compareFormat(altered, parts).findings.some(f => f.check === 'page_setup'));
  assert.equal(inspectPackage(parts).placeholders[0].part, 'word/header1.xml');
});
test('research rejects nonofficial URLs, credentials and wrong years', () => {
  for (const url of ['http://pakistancode.gov.pk/a', 'https://127.0.0.1/a', 'https://pakistancode.gov.pk.evil.test/a', 'https://user@na.gov.pk/a', 'https://na.gov.pk:444/a']) assert.throws(() => officialUrl(url));
  assert.equal(sourceIdentityMatches('Contract Act 1872', ('Contract Act 2020 text. ').repeat(30)), false);
  assert.equal(sourceIdentityMatches('Contract Act 1872', ('Contract Act 1872 text. ').repeat(30)), true);
});
test('a narrated research answer still yields its plan, and prose yields an honest failure', async () => {
  const { readPlan } = await import('../research.js');
  const narrated = [
    "I'll search for the applicable law now.",
    'Here is what I found:',
    '```json',
    '{"jurisdiction":"Pakistan","uncertainties":["Effective date unconfirmed"],"sources":[{"title":"Contract Act, 1872","url":"https://na.gov.pk/a.pdf","reason":"Governs the term sheet","kind":"act","amendsAct":null}]}',
    '```',
  ].join('\n');
  const plan = readPlan(narrated);
  assert.equal(plan.sources[0].title, 'Contract Act, 1872');
  assert.equal(plan.jurisdiction, 'Pakistan');
  // A brace inside a string, and an earlier non-plan object, must not confuse it.
  assert.deepEqual(readPlan('{"note":"ignore {this}"}\n{"jurisdiction":"unknown","uncertainties":[],"sources":[]}').sources, []);
  assert.throws(() => readPlan("I appreciate the request, but I need the document first."), /prose/);
});

test('official downloads validate redirects before following and enforce streamed size limits', async () => {
  let calls = 0;
  await assert.rejects(fetchOfficial('https://na.gov.pk/a', { fetcher: async () => { calls++; return new Response(null, { status:302, headers:{location:'https://127.0.0.1/private'} }); } }));
  assert.equal(calls, 1);
  await assert.rejects(fetchOfficial('https://na.gov.pk/a', { maxBytes:3, fetcher: async () => new Response('1234') }), /too large/);
});

test('draft intent resolves an unambiguous firm document type and rejects invented citation IDs', async () => {
  const { inferDraftSkill, citationIssues } = await import('../chatState.js');
  const types = [{id:'a',name:'Concession Agreement'},{id:'b',name:'Lease Agreement'}];
  assert.deepEqual(inferDraftSkill('Please draft a concession agreement.', types), {key:'draft',documentTypeId:'a'});
  assert.equal(inferDraftSkill('Draft a concession agreement and lease agreement', types), null);
  // The type is what is to be drafted, not the documents named as its sources.
  const firm = [{ id: 'dd', name: 'Due Diligence Report' }, { id: 'tsr', name: 'Transaction Structure Report' }];
  assert.equal(inferDraftSkill('can you draft me a project proposal using the transaction structure report and the term sheet and the due diligence report', firm), null);
  assert.deepEqual(inferDraftSkill('Prepare a due diligence report based on the term sheet', firm), { key: 'draft', documentTypeId: 'dd' });
  assert.equal(inferDraftSkill('Explain this concession agreement', types), null);
  assert.deepEqual(citationIssues('Text [Source 1] and [Source 9]', 2), [9]);
});

test('long review sections reach the execution block and preserve neighboring context', async () => {
  const { splitReviewSegments, parseSuggestions } = await import('../review.js');
  const text = 'Recitals\n' + 'Long clause.\n'.repeat(10000) + 'EXECUTION BLOCK';
  const segments = splitReviewSegments(text);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, text.length);
  assert.ok(segments.at(-1).text.includes('EXECUTION BLOCK'));
  assert.ok(segments.every((s,i) => !i || s.start === segments[i-1].end));
  assert.throws(() => parseSuggestions('[]', 'max_tokens', text));
});

test('suggestions that change the same words are merged into one', async () => {
  const { mergeOverlapping } = await import('../suggestionMerge.js');
  const text = '<p>The Concessionaire shall pay thirty (30) days after invoice to NHA.</p><p>Separate clause stays.</p>';
  const rows = [
    { review_type: 'formatting', clause_reference: 'Item 4', original_text: 'shall pay thirty (30) days after invoice', suggested_text: 'shall pay forty (40) days after invoice', rationale: 'Period too short.' },
    { review_type: 'legal_clauses', clause_reference: 'Item 4 payee', original_text: 'days after invoice to NHA.', suggested_text: 'days after a valid invoice to NHA.', rationale: 'Invoice must be valid.' },
    { review_type: 'content_conflicts', clause_reference: 'Other', original_text: 'Separate clause stays.', suggested_text: 'Separate clause changes.', rationale: 'Unrelated.' },
  ];
  // Different words: combined without asking the model.
  let asked = 0;
  const { suggestions, groupsMerged } = await mergeOverlapping(rows, text, { combine: async () => { asked++; return null; } });
  assert.equal(groupsMerged, 1);
  assert.equal(asked, 0);
  assert.equal(suggestions.length, 2);
  const merged = suggestions.find((s) => s.clause_reference.includes('Item 4'));
  assert.equal(merged.original_text, 'shall pay thirty (30) days after invoice to NHA.');
  assert.equal(merged.suggested_text, 'shall pay forty (40) days after a valid invoice to NHA.');
  assert.equal(merged.review_type, 'legal_clauses');
  assert.ok(merged.rationale.includes('Period too short.') && merged.rationale.includes('Invoice must be valid.'));
  assert.ok(text.includes(merged.original_text));

  // The same words rewritten two ways: the model is asked for one wording.
  const clash = [
    { review_type: 'legal_clauses', clause_reference: 'A', original_text: 'thirty (30) days', suggested_text: 'forty (40) days', rationale: 'r1' },
    { review_type: 'formatting', clause_reference: 'B', original_text: 'thirty (30) days after', suggested_text: 'sixty (60) days following', rationale: 'r2' },
  ];
  const combined = await mergeOverlapping(clash, text, { combine: async (span) => { asked++; return span.replace('thirty (30) days after', 'forty (40) days following'); } });
  assert.equal(asked, 1);
  assert.equal(combined.suggestions[0].suggested_text, 'forty (40) days following');

  // No wording from the model: the lead change stands and the other is shown, not lost.
  const fallback = await mergeOverlapping(clash, text, { combine: async () => null });
  assert.equal(fallback.suggestions[0].suggested_text, 'forty (40) days after');
  assert.ok(fallback.suggestions[0].rationale.includes('"sixty (60) days following"'));
});

test('a Claude skill zip is read from its folder, with its front matter checked', async () => {
  const { parseSkillZip, readFrontMatter, outputFileIds } = await import('../claudeSkills.js');
  const skillMd = `---\nname: rfp-volume-i\ndescription: >\n  Draft Volume I of an RFP\n  from the firm's master.\n---\n\n# Drafting\nRun the scripts.`;
  const zip = zipSync({
    'rfp-volume-i/SKILL.md': strToU8(skillMd),
    'rfp-volume-i/scripts/build.py': strToU8('print(1)'),
    'rfp-volume-i/assets/Master [AKLA].docx': new Uint8Array([80, 75, 3, 4]),
    '__MACOSX/rfp-volume-i/._SKILL.md': strToU8('junk'),
    'rfp-volume-i/.DS_Store': strToU8('junk'),
  });
  const parsed = parseSkillZip(zip);
  assert.equal(parsed.name, 'rfp-volume-i');
  assert.equal(parsed.description, "Draft Volume I of an RFP from the firm's master.");
  assert.equal(parsed.instructions, '# Drafting\nRun the scripts.');
  assert.deepEqual(parsed.files.map((f) => f.path).sort(), ['rfp-volume-i/SKILL.md', 'rfp-volume-i/assets/Master-AKLA.docx', 'rfp-volume-i/scripts/build.py']);

  // Files at the top of the zip are placed under a folder named for the skill.
  const flat = parseSkillZip(zipSync({ 'SKILL.md': strToU8('---\nname: "legal-summary"\ndescription: Plain English memo.\n---\nBody'), 'scripts/x.py': strToU8('') }));
  assert.deepEqual(flat.files.map((f) => f.path).sort(), ['legal-summary/SKILL.md', 'legal-summary/scripts/x.py']);

  // A template named with spaces and brackets is renamed, and the skill's text follows it.
  assert.deepEqual(parsed.renamed, [{ from: 'assets/Master [AKLA].docx', to: 'assets/Master-AKLA.docx' }]);
  const withRefs = parseSkillZip(zipSync({
    'ca/SKILL.md': strToU8('---\nname: ca\ndescription: Fill the master.\n---\npython3 scripts/fill.py "assets/Standard Concession Agreement [AKLA].docx"\nThe master, Standard Concession Agreement [AKLA], is blank.'),
    'ca/scripts/fill.py': strToU8('TEMPLATE = "Standard Concession Agreement [AKLA].docx"'),
    'ca/assets/Standard Concession Agreement [AKLA].docx': new Uint8Array([80, 75, 3, 4]),
  }));
  const fileText = (path) => new TextDecoder().decode(withRefs.files.find((f) => f.path === path).bytes);
  assert.ok(withRefs.files.some((f) => f.path === 'ca/assets/Standard-Concession-Agreement-AKLA.docx'));
  assert.ok(fileText('ca/SKILL.md').includes('"assets/Standard-Concession-Agreement-AKLA.docx"'));
  assert.ok(fileText('ca/SKILL.md').includes('The master, Standard Concession Agreement [AKLA], is blank.'));
  assert.equal(fileText('ca/scripts/fill.py'), 'TEMPLATE = "Standard-Concession-Agreement-AKLA.docx"');
  assert.throws(() => parseSkillZip(zipSync({ 'a/readme.md': strToU8('x') })), /No SKILL\.md/);
  assert.throws(() => parseSkillZip(zipSync({ 'SKILL.md': strToU8('---\nname: Bad Name\ndescription: d\n---') })), /lowercase/);
  assert.throws(() => parseSkillZip(zipSync({ 'a/SKILL.md': strToU8('---\nname: a\ndescription: d\n---'), 'b/other.md': strToU8('x') })), /skill's folder/);
  assert.throws(() => parseSkillZip(strToU8('not a zip')), /not a readable/);
  assert.equal(readFrontMatter('no front matter').body, 'no front matter');

  const content = [{ type: 'bash_code_execution_tool_result', content: { type: 'bash_code_execution_result', content: [{ type: 'bash_code_execution_output', file_id: 'file_1' }] } }, { type: 'text', text: 'done' }];
  assert.deepEqual(outputFileIds(content), ['file_1']);
});

test('comments land in the margin as AKLA Comments, alongside a tracked change', async () => {
  const bytes = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'word/document.xml': strToU8(`<w:document ${ns}><w:body><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>The concession period is [●] years.</w:t></w:r></w:p><w:p/><w:sectPr/></w:body></w:document>`),
  });
  const view = inspectDocx(bytes);
  const [p, ref] = [...view.byRef].find(([, r]) => r.exactText.startsWith('The concession'));
  const out = await applyDocxOps(bytes, [
    { op: 'replace', p, expected: ref.exactText, text: 'The concession period is thirty (30) years.' },
    { op: 'comment', p, expected: ref.exactText, text: 'The Firm notes that the period is taken from the Term Sheet & is to be confirmed.' },
    { op: 'comment', p, expected: ref.exactText, text: 'Second remark.' },
  ], view.byRef);
  const files = unzipSync(out.bytes);
  const doc = strFromU8(files['word/document.xml']);
  const comments = strFromU8(files['word/comments.xml']);
  assert.equal(out.applied, 3);
  assert.equal((comments.match(/<w:comment /g) ?? []).length, 2);
  assert.ok(comments.includes('w:author="AKLA Comments"') && comments.includes('Term Sheet &amp; is'));
  assert.ok(!doc.includes('@@AKLA_COMMENT'));
  assert.equal((doc.match(/<w:commentRangeStart w:id="\d+"\/>/g) ?? []).length, 2);
  assert.ok(doc.includes('<w:ins ') && doc.includes('<w:pStyle w:val="Normal"/></w:pPr><w:commentRangeStart'));
  assert.ok(strFromU8(files['[Content_Types].xml']).includes('/word/comments.xml'));
  assert.ok(strFromU8(files['word/_rels/document.xml.rels']).includes('relationships/comments'));
  // A comment is not a change to the words: accepting everything keeps it.
  assert.ok(strFromU8(unzipSync(acceptAllChanges(out.bytes))['word/document.xml']).includes('commentReference'));
});

test('a generated document is rendered in AKLA house format, remarks as Word comments', async () => {
  const { renderAklaDocx, aklaFileName } = await import('../aklaRender.js');
  const markdown = [
    '# Project Proposal',
    '**Client:** National Highway Authority',
    '## Transaction Structure',
    'The concession is granted for [●] years.[^1] [[AKLA Comment: The Firm notes the toll rate is PKR [●]]]',
    '### Tolling',
    '- Electronic collection.',
    '| Item | Figure |',
    '|---|---|',
    '| Concession period | [●] |',
    '## AKLA Comments',
    '[^1]: **AKLA Comment 1.** The period is not fixed in the Term Sheet.',
  ].join('\n');
  const { bytes, check } = await renderAklaDocx({ markdown, title: 'Project Proposal', date: 'September 14, 2026' });
  assert.deepEqual(check.findings, []);
  assert.equal(check.status, 'checked');
  assert.equal(check.comments, 2);
  const files = unzipSync(bytes);
  const doc = strFromU8(files['word/document.xml']);
  const comments = strFromU8(files['word/comments.xml']);
  assert.ok(comments.includes('The period is not fixed in the Term Sheet.') && !comments.includes('**'));
  assert.ok(comments.includes('toll rate is PKR [●]'), 'a comment ending on a placeholder keeps its bracket');
  assert.ok(!doc.includes('AKLA Comments</w:t>'), 'the emptied end section is dropped');
  assert.equal(aklaFileName('Notes: On/The "Deal"', 'September 14, 2026'), 'Notes On The Deal [AKLA][September 14, 2026].docx');
});

test('a review chat runs a new review only when asked, and "review it" is not an instruction', async () => {
  const { isBareReviewRequest, asksForReviewRerun } = await import('../chatState.js');
  for (const m of ['review it', 'Review this.', 'please review the attached document', 'can you check this for me?', 'verify', '']) assert.equal(isBareReviewRequest(m), true, m);
  for (const m of ['review it against the concession agreement', 'check the indemnity clause', 'What does suggestion 3 mean?']) assert.equal(isBareReviewRequest(m), false, m);
  for (const m of ['re-run the review', 'Rerun', 'please review it again', 'run a fresh review', 'start over']) assert.equal(asksForReviewRerun(m), true, m);
  for (const m of ['why is clause 23 flagged?', 'check the tolling clause', 'review it']) assert.equal(asksForReviewRerun(m), false, m);
});

test('every document fits in the prompt, long ones as marked excerpts, and "the project docs" means all of them', async () => {
  const { mentionsProjectDocuments, fitDocuments, excerptDocument } = await import('../contextBudget.js');
  for (const m of ['Draft a concession based on the project docs', 'use all the documents', 'pick up everything from the documents on this project', 'from the available documents']) assert.equal(mentionsProjectDocuments(m), true, m);
  for (const m of ['review the term sheet', 'what does clause 4 say?', 'draft a concession agreement']) assert.equal(mentionsProjectDocuments(m), false, m);

  const para = (label, n) => Array.from({ length: n }, (_, i) => `${label} paragraph ${i} about general matters of the project.`).join('\n\n');
  const longReport = `CONTENTS\nExecutive summary of the report.\n\n${para('Background', 400)}\n\nThe concession period shall be thirty (30) years from financial close.\n\n${para('Annex', 400)}`;
  const docs = [
    { name: 'Term Sheet', text: para('Term', 20) },
    { name: 'Concept Note', text: para('Concept', 15) },
    { name: 'Report', text: longReport },
  ];
  const total = docs[0].text.length + docs[1].text.length + 6000;
  const fitted = fitDocuments(docs, total, 'Draft: Concession Agreement concession period');
  assert.equal(fitted.length, 3, 'nothing is dropped');
  assert.equal(fitted[0].text, docs[0].text);
  assert.equal(fitted[1].text, docs[1].text);
  assert.equal(fitted[2].excerpted, true);
  assert.ok(fitted.reduce((n, d) => n + d.text.length, 0) <= total);
  assert.ok(fitted[2].text.startsWith('CONTENTS'), 'the opening is kept');
  assert.ok(fitted[2].text.includes('thirty (30) years'), 'the relevant passage is kept');
  assert.ok(fitted[2].text.includes('[… passage omitted …]'));
  // The same purpose gives the same excerpt, so the prompt can be cached.
  assert.equal(excerptDocument(longReport, 6000, 'concession period').text, excerptDocument(longReport, 6000, 'concession period').text);
});

test('a draft from the standard takes its fills directly, keeping comments and the standard\'s own revisions', async () => {
  const { acceptChangesBy } = await import('../docxAgent.js');
  const bytes = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'word/document.xml': strToU8(`<w:document ${ns}><w:body>`
      + `<w:p><w:r><w:t xml:space="preserve">The Concession Period is [●] years.</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t xml:space="preserve">Optional clause to remove.</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="5" w:author="Counsel" w:date="2026-05-08T00:00:00Z"><w:r><w:t>standard redline</w:t></w:r></w:ins></w:p>`
      + `<w:sectPr/></w:body></w:document>`),
  });
  const view = inspectDocx(bytes);
  const ref = (start) => [...view.byRef].find(([, r]) => r.exactText.startsWith(start));
  const [p1, r1] = ref('The Concession Period');
  const [p2, r2] = ref('Optional clause');
  const out = await applyDocxOps(bytes, [
    { op: 'replace', p: p1, expected: r1.exactText, text: 'The Concession Period is thirty (30) years.' },
    { op: 'comment', p: p1, expected: r1.exactText, text: 'Taken from the Term Sheet, Sr. No. 2; to be confirmed.' },
    { op: 'delete', p: p2, expected: r2.exactText },
    { op: 'insert_after', p: p1, expected: r1.exactText, text: 'A new clause from the Term Sheet.' },
  ], view.byRef);
  const clean = strFromU8(unzipSync(acceptChangesBy(out.bytes))['word/document.xml']);
  assert.ok(!/w:author="AKLA AI"/.test(clean), 'no AI revision is left to approve');
  const words = clean.replace(/<w:delText[^>]*>[^<]*<\/w:delText>/g, '').replace(/<[^>]+>/g, '');
  assert.ok(words.includes('The Concession Period is thirty (30) years.') && !words.includes('[●]'));
  assert.ok(!clean.includes('Optional clause to remove.'));
  assert.ok(clean.includes('A new clause from the Term Sheet.'));
  assert.ok(clean.includes('w:author="Counsel"'), "the standard's own revision stays");
  assert.ok(clean.includes('commentReference'), 'comments stay');
});

test('a follow-up works on the document the lawyer means, not just the last one made', async () => {
  const { chooseWorkingDocument } = await import('../chatState.js');
  const proposal = { id: 'p', kind: 'docx', title: 'M-6 Sukkur–Hyderabad Motorway — Project Proposal (Legal Limb — Draft)', data: { storagePath: 'x/proposal.docx', sourceKind: 'draft' } };
  const note = { id: 'n', kind: 'docx', title: 'Drafting Control Note — M-6 Project Proposal (Legal Limb)', data: { storagePath: 'x/note.docx', sourceKind: 'memo' } };
  const noteEdited = { id: 'n2', kind: 'docx', title: 'Drafting Control Note — M-6 Project Proposal (Legal Limb) [AKLA][September 15, 2026].docx', data: { storagePath: 'x/note-2.docx', sourceStoragePath: 'x/note.docx' } };
  const all = [proposal, note, noteEdited];
  // Both titles say "project proposal": the draft wins over its note.
  assert.equal(chooseWorkingDocument(all, { message: 'reverify this project proposal and fix the mistakes' }).chosen.id, 'p');
  // Naming the note picks its newest copy.
  assert.equal(chooseWorkingDocument(all, { message: 'update the control note' }).chosen.id, 'n2');
  // The document open in the panel wins over the words.
  assert.equal(chooseWorkingDocument(all, { message: 'update the control note', workingArtifactId: 'p' }).chosen.id, 'p');
  assert.equal(chooseWorkingDocument(all, { message: 'fix it', workingArtifactId: 'n' }).chosen.id, 'n2');
  const picked = chooseWorkingDocument(all, { message: 'fix it' });
  assert.deepEqual(picked.others.map((d) => d.id), ['n']);
  assert.equal(chooseWorkingDocument([note, noteEdited], { message: 'anything' }).chosen.id, 'n2');
  assert.equal(chooseWorkingDocument([], {}).chosen, null);
});

test('the law lookup finds a law the library already holds under any of its titles', async () => {
  const { findInLibrary, describeLookup } = await import('../research.js');
  const library = [
    { act_name: 'Public Private Partnership Authority Act, 2017', chunk_count: 30 },
    { act_name: 'Public Private Partnership Authority Act, 2017 (Act No. VIII of 2017)', chunk_count: 9 },
    { act_name: 'National Highway Authority Act, 1991', chunk_count: 6 },
    { act_name: 'Public Procurement Regulatory Authority Ordinance (PPRA), 2002', chunk_count: 5 },
    { act_name: 'THE STATE-OWNED ENTERPRISES (GOVERNANCE AND OPERATIONS) ACT, 2023', chunk_count: 12 },
  ];
  assert.equal(findInLibrary('The Public Private Partnership Authority Act, 2017.', library).act_name, 'Public Private Partnership Authority Act, 2017');
  assert.equal(findInLibrary('National Highway Authority Act 1991', library).chunk_count, 6);
  assert.equal(findInLibrary('State-Owned Enterprises (Governance and Operations) Act, 2023', library).chunk_count, 12);
  assert.equal(findInLibrary('Public Procurement Rules, 2004', library), null, 'a different instrument is not a match');
  assert.equal(findInLibrary('National Highway Authority Act, 1990', library), null, 'a different year is not a match');
  const line = describeLookup({ status: 'partial', sources: [{}, {}], fromLibrary: ['National Highway Authority Act, 1991', 'Public Private Partnership Authority Act, 2017'], downloaded: [], failures: ["Public Procurement Rules, 2004 — the official website did not respond to the AI server (add it to the project's Relevant Laws to use it)"], unresolved: ['M-6 corridor jurisdiction not evidenced'] });
  assert.ok(line.startsWith('Law lookup: used 2 from the law library'));
  assert.ok(line.includes('Could not obtain: Public Procurement Rules, 2004'));
  assert.ok(!line.includes('M-6 corridor'), 'open points about the project are not mixed into the lookup');
});

test('an official source the server cannot reach comes through the download relay, still gated', async () => {
  const { fetchViaRelay } = await import('../research.js');
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  const fakeSsh = ({ stdout = Buffer.alloc(0), stderr = '', code = 0 }) => () => {
    const child = new EventEmitter();
    child.stdout = Readable.from([stdout]);
    child.stderr = Readable.from([Buffer.from(stderr)]);
    child.kill = () => {};
    let pending = 2;
    const done = () => { if (--pending === 0) setImmediate(() => child.emit('close', code)); };
    child.stdout.on('end', done);
    child.stderr.on('end', done);
    return child;
  };
  const pdf = Buffer.from('%PDF-1.4 test');
  const ok = await fetchViaRelay('https://pakistancode.gov.pk/pdffiles/a.pdf', { spawner: fakeSsh({ stdout: pdf, stderr: 'FINAL https://pakistancode.gov.pk/pdffiles/a.pdf\nTYPE application/pdf\n' }) });
  assert.equal(ok.url, 'https://pakistancode.gov.pk/pdffiles/a.pdf');
  assert.equal(Buffer.from(await ok.blob.arrayBuffer()).toString(), '%PDF-1.4 test');
  // The relay's own refusal reaches the lawyer as its message.
  await assert.rejects(fetchViaRelay('https://na.gov.pk/x.pdf', { spawner: fakeSsh({ stderr: 'ERROR Source download failed (404)\n', code: 2 }) }), /Source download failed \(404\)/);
  // A final address off the approved domains is refused here too.
  await assert.rejects(fetchViaRelay('https://na.gov.pk/x.pdf', { spawner: fakeSsh({ stdout: pdf, stderr: 'FINAL https://evil.example.com/x.pdf\n' }) }), /approved Pakistani authority domain/);
  // A URL off the approved domains never reaches the relay.
  await assert.rejects(fetchViaRelay('https://example.com/x.pdf', { spawner: () => { throw new Error('should not run'); } }), /approved Pakistani authority domain/);
});

test('one bad suggestion or a chatty reply no longer sinks a review pass', async () => {
  const { readPassReply, anchorQuote } = await import('../review.js');
  const src = '<p>The Authority&#39;s  “Concession Period” shall be 25 years &amp; not more.</p><p>Next <strong>bold</strong> text.</p>';
  // Decoded entities, straight quotes and single spaces map back to the source's own text.
  assert.equal(anchorQuote(`The Authority's "Concession Period" shall be 25 years & not more.`, src), 'The Authority&#39;s  “Concession Period” shall be 25 years &amp; not more.');
  assert.equal(anchorQuote('Next bold text.', src), null);
  assert.equal(anchorQuote('not in the document', src), null);
  const reply = 'Here are my findings:\n```json\n[{"clause_reference":"a","original_text":"shall be 25 years","suggested_text":"shall be 30 years","rationale":"Term sheet"},{"clause_reference":"b","original_text":"invented words","suggested_text":"x","rationale":"y"}]\n```';
  const { rows, dropped } = readPassReply(reply, 'end_turn', src);
  assert.equal(rows.length, 1);
  assert.equal(dropped, 1);
  // Unreadable or unfinished replies are still never a clean result.
  assert.throws(() => readPassReply('I could not complete this.', 'end_turn', src));
  assert.throws(() => readPassReply('[]', 'max_tokens', src));
});

test('an instruction answered at length is kept, with its locatable suggestions', async () => {
  const { readInstructionReply } = await import('../review.js');
  const src = '<p>The concession period is 25 years.</p>';
  const raw = '<answer>\n## Corrections\n1. Concession period: the proposal says 25 years; the Term Sheet (Sr. No. 4) says 30 years.\n</answer>\n<suggestions>\n[{"clause_reference":"Para 2","original_text":"25 years","suggested_text":"30 years","rationale":"Term Sheet Sr. No. 4"},{"clause_reference":"x","original_text":"not there","suggested_text":"y","rationale":"z"}]\n</suggestions>';
  const read = readInstructionReply(raw, 'end_turn', src);
  assert.match(read.answer, /^## Corrections/);
  assert.equal(read.rows.length, 1);
  assert.equal(read.dropped, 1);
  // The old layout, or no layout at all, still yields the answer rather than an error.
  assert.equal(readInstructionReply('REPLY: Nothing to add.\nSUGGESTIONS: []', 'end_turn', src).answer, 'Nothing to add.');
  const cut = readInstructionReply('<answer>A long list that stops mid', 'max_tokens', src);
  assert.equal(cut.answer, 'A long list that stops mid');
  assert.equal(cut.unfinished, true);
});

test('an Act is found on pakistancode by its search page, and the wrong Act is not', async () => {
  const { parseSearchResults, parseActPage, titleMatches, searchPakistanCode } = await import('../lawLibrary.js');
  const search = '<a href="https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-con-2-sg-jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj.php">A</a> <a href="https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-con-1-sg-abc.php">B</a>';
  assert.equal(parseSearchResults(search).length, 2);
  const page = (title, pdf) => `<h2>${title}</h2><a href="${pdf}">PDF</a>`;
  assert.deepEqual(parseActPage(page('THE CONTRACT ACT, 1872', 'https://pakistancode.gov.pk/pdffiles/x.pdf')), { title: 'THE CONTRACT ACT, 1872', pdfUrl: 'https://pakistancode.gov.pk/pdffiles/x.pdf' });
  assert.ok(titleMatches('Contract Act, 1872', 'THE CONTRACT ACT, 1872'));
  assert.ok(!titleMatches('Contract Act, 1872', 'THE CONTRACT (AMENDMENT) ACT, 1996'));
  const pages = {
    'https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-con-1-sg-abc.php': page('THE PARTNERSHIP ACT, 1932', 'https://pakistancode.gov.pk/pdffiles/p.pdf'),
    'https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-con-2-sg-jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj.php': page('THE CONTRACT ACT, 1872', 'https://pakistancode.gov.pk/pdffiles/c.pdf'),
  };
  const fetchText = async (url) => (url.includes('sHyuRsF') ? search : pages[url] ?? '');
  const hit = await searchPakistanCode('Contract Act, 1872', { fetchText });
  assert.equal(hit.pdfUrl, 'https://pakistancode.gov.pk/pdffiles/c.pdf');
  assert.equal(await searchPakistanCode('Sale of Goods Act, 1930', { fetchText }), null);
});

test('precedent search reads paragraphs out of HTML and matches the words asked for', async () => {
  const { paragraphsOf, queryTerms, termHits } = await import('../precedentSearch.js');
  const html = '<h1>12. LIQUIDATED DAMAGES</h1><p>If the Contractor fails to achieve the Commercial Operations Date, it shall pay Liquidated Damages at the rate of [●] per day &amp; no more.</p><p>Short.</p>';
  const paras = paragraphsOf(html);
  assert.equal(paras.length, 1);
  assert.match(paras[0].text, /Liquidated Damages at the rate of \[●\] per day & no more\.$/);
  const terms = queryTerms('find all LD clauses', ['liquidated damages', 'delay damages']);
  assert.ok(terms.includes('ld') && terms.includes('liquidated damages') && !terms.includes('clauses'));
  assert.deepEqual(termHits(paras[0].text, terms).found, ['liquidated damages']);
});

test('a short term only counts as a whole word', async () => {
  const { termHits } = await import('../precedentSearch.js');
  assert.equal(termHits('The Contractor should be held liable.', ['ld']).count, 0);
  assert.equal(termHits('LDs and the LD cap apply.', ['ld']).count, 1);
  assert.equal(termHits('Liquidated Damages (the "LDs")', ['liquidated damages']).count, 1);
});

test('the RFP questionnaire asks dependent questions after what they depend on, and settles what earlier answers decide', async () => {
  const { QUESTIONNAIRES, startQuestionnaire, readAnswer, advance, answerInstruction } = await import('../questionnaire.js');
  const rfp = QUESTIONNAIRES.rfp_federal_ppp;
  const ids = rfp.questions.map((q) => q.id);
  const before = (a, b) => assert.ok(ids.indexOf(a) < ids.indexOf(b), `${a} should come before ${b}`);
  before('qualified', 'approval_chain'); before('approval_chain', 'pcp_step'); before('qualified', 'support');
  before('revenue_model', 'revenue_sharing'); before('support', 'financing_source'); before('financing_source', 'financing_mix');
  before('financing_source', 'benchmark'); before('bidder_structure', 'epc'); before('capability_label', 'revenue_basis');
  before('scoring', 'award'); before('support', 'award'); before('financing_source', 'f4');

  let state = startQuestionnaire(rfp);
  assert.equal(state.pending.id, 'modality');
  const answer = (id, optionIds) => {
    const read = readAnswer(rfp, state, { questionId: id, optionIds });
    assert.ok(!read.error, read.error);
    const next = advance(rfp, { ...state.answers, [id]: { optionIds: read.optionIds, labels: read.labels } });
    state = { answers: next.answers, pending: next.pending };
    return next;
  };
  answer('modality', ['dbfot']);
  answer('term', ['fixed']);
  // A Qualified Project keeps the approval chain without being asked.
  const q = answer('qualified', ['qualified']);
  assert.deepEqual(q.autos.map((d) => d.question.id), ['approval_chain']);
  assert.equal(state.pending.id, 'pcp_step');
  // A wrong question id is refused.
  assert.ok(readAnswer(rfp, state, { questionId: 'modality', optionIds: ['bot'] }).error);
  answer('pcp_step', ['include']);
  answer('method', ['open']); answer('competition', ['icb']); answer('procedure', ['ss2e']); answer('submission', ['physical']);
  // An availability model has no revenue to share.
  const r = answer('revenue_model', ['availability']);
  assert.deepEqual(r.autos.map((d) => [d.question.id, d.optionIds[0]]), [['revenue_sharing', 'none']]);
  assert.equal(state.pending.id, 'escalation');
  answer('escalation', ['cpi']);
  // Support: a minimum revenue guarantee is not offered on an availability model; "none" stands alone.
  assert.ok(!state.pending.options.some((o) => o.id === 'mrg'));
  assert.ok(readAnswer(rfp, state, { questionId: 'support', optionIds: ['vgf', 'none'] }).error);
  answer('support', ['vgf', 'assets']);
  // Equity-only financing: no mix, no benchmark, and Form F4 is settled later.
  answer('financing_source', ['equity_only']);
  assert.equal(state.pending.id, 'currency');
  answer('currency', ['pkr']);
  assert.equal(state.pending.id, 'bidder_structure');
  const b = answer('bidder_structure', ['consortium_epc']);
  assert.deepEqual(b.autos.map((d) => d.question.id), ['epc']);
  const c = answer('capability_label', ['construction']);
  assert.deepEqual(c.autos.map((d) => [d.question.id, d.optionIds[0]]), [['revenue_basis', 'construction']]);
  answer('scoring', ['per_category']);
  // Award: no user tariff or revenue share on an availability model; VGF was offered, so lowest VGF is.
  const awardOptions = state.pending.options.map((o) => o.id);
  assert.ok(!awardOptions.includes('lowest_tariff') && !awardOptions.includes('highest_share') && awardOptions.includes('lowest_vgf'));
  answer('award', ['lowest_vgf']);
  const s = answer('bid_security', ['bank_guarantee']);
  assert.deepEqual(s.autos.map((d) => [d.question.id, d.optionIds[0]]), [['f4', 'not_used']]);
  answer('environment', ['both']); answer('land_handover', ['phased']); answer('resettlement', ['no_rap']); answer('utilities', ['agency']);
  const last = answer('kpis', ['sla']);
  assert.equal(last.pending, null);
  const instruction = answerInstruction([{ question: rfp.questions[0], optionIds: ['bot'] }], state.answers);
  assert.match(instruction, /CHOSEN: Build-Operate-Transfer \(BOT\)/);
  assert.match(instruction, /NOT CHOSEN: .*DBFOT/);
});

// ---- Writer changes: one id counter, ids captured per change, splits, take-over.

const idsOf = (xml, author = 'AKLA AI') => [...xml.matchAll(/<w:(ins|del)\s[^>]*?\bw:id="(\d+)"[^>]*?\bw:author="([^"]*)"/g)].filter((m) => m[3] === author).map((m) => Number(m[2]));
const docXml = (bytes, part = 'word/document.xml') => strFromU8(unzipSync(bytes)[part]);
const docFrom = (body, extra = {}) => zipSync({ 'word/document.xml': strToU8(`<w:document ${ns}><w:body>${body}<w:sectPr/></w:body></w:document>`), ...extra });

test('a replace reports its ids, wording and clause', async () => {
  const bytes = file(); const view = inspectDocx(bytes);
  const output = await applyDocxOps(bytes, [{ op: 'replace', p: 1, expected: 'Party Alpha pays 10.', text: 'Party Beta pays 20.', why: 'The term sheet names Party Beta.' }], view.byRef);
  const r = output.results[0];
  const xml = docXml(output.bytes);
  assert.equal(r.status, 'applied');
  assert.equal(r.revisionIds.length, 2);
  for (const id of r.revisionIds) assert.ok(idsOf(xml).includes(id), `id ${id} is an AKLA AI revision in the body`);
  assert.equal(r.original, 'Party Alpha pays 10.');
  assert.equal(r.modified, 'Party Beta pays 20.');
  assert.equal(r.via, 'inline');
  assert.equal(r.why, 'The term sheet names Party Beta.');
  assert.equal(r.part, 'word/document.xml');
  assert.equal(r.clause, null);
  assert.equal(output.maxId, Math.max(...r.revisionIds));
});

test('a body edit and a header edit in one call never share an id', async () => {
  const bytes = file(); const view = inspectDocx(bytes);
  const [hp, href] = [...view.byRef].find(([, r]) => r.part === 'word/header1.xml');
  const output = await applyDocxOps(bytes, [
    { op: 'replace', p: 1, expected: 'Party Alpha pays 10.', text: 'Party Beta pays 20.' },
    { op: 'replace', p: hp, expected: href.exactText, text: 'Party Beta' },
  ], view.byRef);
  const [body, header] = output.results;
  assert.equal(body.part, 'word/document.xml');
  assert.equal(header.part, 'word/header1.xml');
  assert.ok(body.revisionIds.length && header.revisionIds.length);
  assert.ok(!body.revisionIds.some((id) => header.revisionIds.includes(id)), 'ids are disjoint across parts');
  for (const id of header.revisionIds) assert.ok(idsOf(docXml(output.bytes, 'word/header1.xml')).includes(id));
  assert.equal(output.maxId, 9000 + body.revisionIds.length + header.revisionIds.length);
});

test('the floor honours ids recorded earlier', async () => {
  const bytes = file(); const view = inspectDocx(bytes);
  const output = await applyDocxOps(bytes, [{ op: 'replace', p: 1, expected: 'Party Alpha pays 10.', text: 'Party Beta pays 20.' }], view.byRef, { idFloor: 9100 });
  assert.ok(output.results[0].revisionIds.every((id) => id > 9100));
  assert.ok(output.maxId > 9100);
});

test('an insert_after reports a mark id and a body id; a delete reports mark plus one per run', async () => {
  const bytes = docFrom('<w:p><w:r><w:t>First clause.</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Two </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>runs.</w:t></w:r></w:p>');
  const view = inspectDocx(bytes);
  const added = await applyDocxOps(bytes, [{ op: 'insert_after', p: 1, expected: 'First clause.', text: 'A new clause.' }], view.byRef);
  const a = added.results[0];
  assert.equal(a.revisionIds.length, 2);
  assert.equal(a.markId, a.revisionIds[0]);
  assert.equal(a.original, '');
  assert.equal(a.anchor, 'First clause.');
  assert.ok(docXml(added.bytes).includes(`<w:pPr><w:rPr><w:ins w:id="${a.markId}" w:author="AKLA AI"`), 'the paragraph mark is inserted');
  const removed = await applyDocxOps(bytes, [{ op: 'delete', p: 2, expected: 'Two runs.' }], view.byRef);
  const d = removed.results[0];
  assert.equal(d.revisionIds.length, 3);
  assert.equal(d.markId, d.revisionIds[0]);
  assert.equal(d.modified, '');
  assert.ok(docXml(removed.bytes).includes(`<w:del w:id="${d.markId}" w:author="AKLA AI" w:date="`) && docXml(removed.bytes).includes('"/></w:rPr></w:pPr>'), 'the paragraph mark is deleted');
});

test('a refused op still quotes what was expected', async () => {
  const bytes = file();
  const stale = await applyDocxOps(bytes, [{ op: 'replace', p: 1, expected: 'Wrong text', text: 'Changed' }], inspectDocx(bytes).byRef);
  assert.equal(stale.results[0].status, 'skipped');
  assert.equal(stale.results[0].original, 'Party Alpha pays 10.');
  assert.ok(!stale.results[0].revisionIds?.length);
  assert.equal(stale.results[0].reason, 'Expected paragraph text does not match the source; no change was made.');
  const hidden = await applyDocxOps(bytes, [{ op: 'delete', p: 1, expected: 'Party Alpha pays 10.' }], inspectDocx(bytes, { budget: 0 }).byRef);
  assert.equal(hidden.results[0].reason, 'Paragraph was not supplied to this turn; request that section first.');
  assert.equal(hidden.results[0].original, 'Party Alpha pays 10.');
});

test("an insertion inside another author's insertion gets its own id", async () => {
  const bytes = docFrom('<w:p><w:ins w:id="1" w:author="Counsel" w:date="D"><w:r><w:t xml:space="preserve">one two three</w:t></w:r></w:ins></w:p>');
  const view = inspectDocx(bytes);
  const output = await applyDocxOps(bytes, [{ op: 'replace', p: 1, expected: 'one two three', text: 'one 2 three' }], view.byRef);
  const r = output.results[0];
  const xml = docXml(output.bytes);
  assert.equal(r.status, 'applied');
  assert.match(xml, /<w:ins w:id="1" w:author="Counsel" w:date="D"><w:r><w:t xml:space="preserve">one <\/w:t><\/w:r><w:del w:id="\d+" w:author="AKLA AI"[^>]*><w:r><w:delText xml:space="preserve">two<\/w:delText><\/w:r><\/w:del><\/w:ins><w:ins w:id="\d+" w:author="AKLA AI"[^>]*><w:r><w:t xml:space="preserve">2<\/w:t><\/w:r><\/w:ins><w:ins w:id="(\d+)" w:author="Counsel" w:date="D"><w:r><w:t xml:space="preserve"> three<\/w:t><\/w:r><\/w:ins>/);
  const counsel = [...xml.matchAll(/<w:ins w:id="(\d+)" w:author="Counsel"/g)].map((m) => Number(m[1]));
  assert.equal(counsel.length, 2);
  assert.notEqual(counsel[0], counsel[1]);
  assert.equal((xml.match(/w:date="D"/g) ?? []).length, 2);
  assert.deepEqual(r.revisionIds, idsOf(xml));
  assert.deepEqual(r.splits, [{ fromId: 1, toId: counsel[1], author: 'Counsel' }]);
  assert.ok(docXml(acceptAllChanges(output.bytes)).includes('one </w:t></w:r><w:r><w:t xml:space="preserve">2</w:t></w:r><w:r><w:t xml:space="preserve"> three'));
});

test('rewriting an AI-inserted paragraph takes over its ids', async () => {
  const bytes = file();
  const first = await applyDocxOps(bytes, [{ op: 'insert_after', p: 1, expected: 'Party Alpha pays 10.', text: 'Added clause.' }], inspectDocx(bytes).byRef);
  const [M, B] = first.results[0].revisionIds;
  const view = inspectDocx(first.bytes);
  const [p] = [...view.byRef].find(([, r]) => r.exactText === 'Added clause.');
  const second = await applyDocxOps(first.bytes, [{ op: 'replace', p, expected: 'Added clause.', text: 'Rewritten clause.' }], view.byRef);
  const r = second.results[0];
  assert.equal(r.status, 'applied');
  assert.equal(r.revisionIds.length, 2);
  assert.equal(r.revisionIds[0], M);
  const B2 = r.revisionIds[1];
  assert.ok(B2 !== B && B2 > B);
  assert.deepEqual(r.takesOver, [M, B]);
  const xml = docXml(second.bytes);
  assert.ok(xml.includes(`<w:pPr><w:pStyle w:val="Normal"/><w:rPr><w:ins w:id="${M}" `), 'the mark keeps its id');
  assert.ok(!xml.includes(`w:id="${B}"`), 'the old body id is gone');
  assert.ok(xml.includes(`<w:ins w:id="${B2}" w:author="AKLA AI"`) && xml.includes('Rewritten clause.'));
  const third = await applyDocxOps(first.bytes, [{ op: 'delete', p, expected: 'Added clause.' }], view.byRef);
  assert.deepEqual(third.results[0].revisionIds, []);
  assert.deepEqual(third.results[0].removedIds, [M, B]);
  assert.equal(third.results[0].status, 'applied');
  assert.ok(!docXml(third.bytes).includes('Added clause.'));
});

test("the fallback engine's ids are attributed to the op", async () => {
  // A footnote mark inside the run that would be cut: the inline writer refuses, the engine takes it.
  const para = (n) => `<w:p><w:r><w:t xml:space="preserve">Clause ${n} pays within</w:t></w:r><w:r><w:t xml:space="preserve"> thirty</w:t><w:footnoteReference w:id="${n}"/></w:r><w:r><w:t xml:space="preserve"> days.</w:t></w:r></w:p>`;
  const bytes = docFrom(para(1) + para(2), {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
  });
  const view = inspectDocx(bytes);
  const ops = [...view.byRef].map(([p, r]) => ({ op: 'replace', p, expected: r.exactText, text: r.exactText.replace('thirty', 'forty') }));
  const output = await applyDocxOps(bytes, ops, view.byRef);
  const xml = docXml(output.bytes);
  assert.equal(output.applied, 2);
  for (const r of output.results) {
    assert.equal(r.status, 'applied');
    assert.equal(r.via, 'fallback');
    assert.ok(r.revisionIds.length, 'ids were read from the engine');
    for (const id of r.revisionIds) assert.ok(idsOf(xml).includes(id), `id ${id} is in the file as AKLA AI`);
  }
  const [a, b] = output.results;
  assert.ok(!a.revisionIds.some((id) => b.revisionIds.includes(id)), 'two fallback ops never share an id');
  assert.ok(xml.includes('<w:footnoteReference w:id="1"/>') && xml.includes('<w:footnoteReference w:id="2"/>'));
});

test("review suggestions report ids and the document's own words", () => {
  const body = `<w:p><w:r><w:t xml:space="preserve">The fee is thirty (30) days payable by Party Alpha.</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Existing </w:t></w:r><w:ins w:id="1" w:author="Counsel" w:date="2026-09-01T00:00:00Z"><w:r><w:t>redline</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> stays.</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Accepted wording here.</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>`;
  const bytes = docFrom(body);
  const { bytes: out, results, maxId } = applyReviewSuggestions(bytes, [
    { id: 'a', original: 'thirty (30) days payable by Party Alpha', suggested: 'forty (40) days payable by Party Beta', accepted: false },
    { id: 'b', original: 'Accepted wording<sup><a href="#f">[2]</a></sup> here.', suggested: 'Final wording here.', accepted: false },
    { id: 'c', original: 'Not in this file at all', suggested: 'Anything', accepted: false },
  ], { legacy: false });
  const xml = docXml(out);
  assert.deepEqual(results.map((r) => r.status), ['applied', 'applied', 'skipped']);
  assert.equal(results[0].original, 'thirty (30) days payable by Party Alpha');
  assert.equal(results[0].suggested, 'forty (40) days payable by Party Beta');
  // Two word hunks ("thirty (30)" and "Alpha"): a deletion and an insertion each.
  assert.equal(results[0].revisionIds.length, 4);
  // Plus suggestion b's one deletion ("Accepted"): nothing is stripped on this path.
  assert.equal((xml.match(/<w:del [^>]*w:author="AKLA AI"/g) ?? []).length, 3);
  assert.equal(results[0].part, 'word/document.xml');
  assert.equal(results[0].paragraphIndex, 1);
  assert.equal(results[1].paragraphIndex, 3);
  assert.equal(results[1].original, 'Accepted wording here.');
  assert.ok(results[1].revisionIds.length >= 2 && !results[1].revisionIds.some((id) => results[0].revisionIds.includes(id)));
  assert.equal(results[2].reason, 'not_found');
  assert.deepEqual(results[2].revisionIds, []);
  assert.equal(results[2].original, 'Not in this file at all');
  // Nothing is accepted on the write-through path: every change is a tracked change by the AI.
  for (const id of [...results[0].revisionIds, ...results[1].revisionIds]) assert.ok(idsOf(xml).includes(id), `id ${id} is an AKLA AI revision`);
  assert.ok(!xml.includes('(accepted)'));
  assert.ok(xml.includes('w:author="Counsel"') && xml.includes('<w:footnoteReference w:id="2"/>'));
  assert.equal(maxId, Math.max(...results[1].revisionIds, ...results[0].revisionIds));
});

test('a quote found twice is refused, unless the clause narrows it', () => {
  const two = docFrom('<w:p><w:r><w:t>4. The Authority shall pay.</w:t></w:r></w:p><w:p><w:r><w:t>7. The Authority shall notify.</w:t></w:r></w:p>');
  const bare = applyReviewSuggestions(two, [{ id: 'a', original: 'The Authority shall', suggested: 'The Authority must', accepted: false }]);
  assert.equal(bare.results[0].status, 'skipped');
  assert.equal(bare.results[0].reason, 'ambiguous');
  assert.deepEqual(unzipSync(bare.bytes)['word/document.xml'], unzipSync(two)['word/document.xml']);
  const narrowed = applyReviewSuggestions(two, [{ id: 'a', original: 'The Authority shall', suggested: 'The Authority must', accepted: false, clause: '7' }]);
  assert.equal(narrowed.results[0].status, 'applied');
  assert.equal(narrowed.results[0].paragraphIndex, 2);
  const xml = docXml(narrowed.bytes);
  assert.ok(xml.includes('<w:t>4. The Authority shall pay.</w:t>'), 'clause 4 is untouched');
  assert.ok(/7\. The Authority <\/w:t><\/w:r><w:del /.test(xml) && xml.includes('<w:delText xml:space="preserve">shall</w:delText>'));
  const twice = docFrom('<w:p><w:r><w:t>If the Authority shall pay, the Authority shall notify.</w:t></w:r></w:p>');
  const same = applyReviewSuggestions(twice, [{ id: 'a', original: 'the Authority shall', suggested: 'the Authority must', accepted: false }]);
  assert.equal(same.results[0].reason, 'ambiguous');
  assert.deepEqual(unzipSync(same.bytes)['word/document.xml'], unzipSync(twice)['word/document.xml']);
});

// A Word file the review can read: the fixture body plus the package parts
// mammoth and inspectPackage expect.
const reviewFixture = (body = '<w:p><w:r><w:t>4. The Authority shall pay within thirty (30) days.</w:t></w:r></w:p>') => docFrom(body, {
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
});
// A Supabase client that answers from canned replies per table or RPC and
// keeps every call, so a test can say exactly what was asked of the database.
function recordingSupabase(answers = {}, { file = null } = {}) {
  const calls = [];
  const reply = (call) => ({ data: answers[call.table]?.(call) ?? null, error: null });
  const chain = (call) => {
    calls.push(call);
    const q = {
      select: (cols) => { call.select = cols; return q; },
      eq: (k, v) => { call.eq.push([k, v]); return q; },
      maybeSingle: () => Promise.resolve(reply(call)),
      single: () => Promise.resolve(reply(call)),
      then: (ok, bad) => Promise.resolve(reply(call)).then(ok, bad),
    };
    return q;
  };
  return {
    calls,
    from: (table) => ({
      select: (cols) => chain({ table, op: 'select', select: cols, eq: [] }),
      insert: (row) => chain({ table, op: 'insert', row, eq: [] }),
      update: (patch) => chain({ table, op: 'update', patch, eq: [] }),
    }),
    rpc: (name, args) => { calls.push({ op: 'rpc', name, args }); return Promise.resolve({ data: answers[name]?.(args) ?? [], error: null }); },
    storage: { from: (bucket) => ({ download: (path) => { calls.push({ op: 'download', bucket, path }); return Promise.resolve({ data: new Blob([file]), error: null }); } }) },
  };
}
// The model and the embedding service answered locally, every request kept.
function stubFetch(answer) {
  const real = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), body });
    return answer(String(url), body);
  };
  return { requests, restore: () => { globalThis.fetch = real; } };
}
const jsonResponse = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const streamResponse = (text, stop = 'end_turn') => new Response(
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
  + `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stop } })}\n\n`,
  { status: 200 },
);

test('reviewDocument records the run on the working document and commits nothing', async () => {
  const { reviewDocument, runReview } = await import('../review.js');
  const bytes = reviewFixture();
  const finding = { clause_reference: '4', original_text: 'thirty (30) days', suggested_text: 'sixty (60) days', rationale: 'The term sheet says sixty.' };
  const model = stubFetch((url, body) => {
    if (url.includes('voyageai')) return jsonResponse({ data: [{ embedding: [0.1, 0.2] }] });
    const text = body.messages[0].content.startsWith('Run the legal clauses pass') ? JSON.stringify([finding]) : '[]';
    return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  });
  try {
    const working = recordingSupabase({ ai_review_runs: (c) => (c.op === 'insert' ? { id: 'run-1' } : null) }, { file: bytes });
    const review = await reviewDocument({ supabase: working, anthropicKey: 'k', voyageKey: 'v', bytes, fileName: 'draft.docx', title: 'Draft', run: { artifact_id: 'root' }, userId: 'u1' });
    const started = working.calls.find((c) => c.table === 'ai_review_runs' && c.op === 'insert');
    assert.equal(started.row.artifact_id, 'root');
    assert.equal(started.row.document_version_id, null);
    assert.equal(started.row.created_by, 'u1');
    assert.ok(typeof started.row.source_hash === 'string' && started.row.source_hash.length === 64);
    assert.ok(!working.calls.some((c) => c.op === 'rpc' && c.name === 'complete_ai_review'), 'nothing is committed');
    assert.ok(!working.calls.some((c) => c.op === 'download'), 'the bytes it was given are the document');
    assert.equal(review.runId, 'run-1');
    assert.deepEqual(review.tagged.map((s) => s.review_type), ['legal_clauses']);
    assert.equal(review.tagged[0].original_text, 'thirty (30) days');
    assert.ok(review.fullText.includes('thirty (30) days'));
    assert.equal(review.passes.legal_clauses.findings, 1);
    assert.equal(review.coverage.sectionsCompleted, 1);
    assert.ok(!working.calls.some((c) => c.table === 'ai_review_runs' && c.op === 'update' && c.patch.status), 'the run is left running for the caller to commit');

    // The old entry: a saved version, loaded here, committed here, four keys.
    const versioned = recordingSupabase({
      document_versions: () => ({ id: 'v1', storage_path: 'm1/d1/draft.docx', matter_document: { id: 'd1', title: 'Draft', matter_id: null, document_type_id: null, document_type: null } }),
      ai_review_runs: (c) => (c.op === 'insert' ? { id: 'run-2' } : null),
      complete_ai_review: (args) => args.p_suggestions.map((s, i) => ({ id: `s${i}`, ...s, status: 'pending' })),
    }, { file: bytes });
    const result = await runReview({ supabase: versioned, anthropicKey: 'k', voyageKey: 'v', documentVersionId: 'v1', userId: 'u1' });
    const commits = versioned.calls.filter((c) => c.op === 'rpc' && c.name === 'complete_ai_review');
    assert.equal(commits.length, 1);
    assert.deepEqual(Object.keys(commits[0].args), ['p_run_id', 'p_suggestions', 'p_passes', 'p_coverage']);
    assert.equal(commits[0].args.p_run_id, 'run-2');
    assert.equal(commits[0].args.p_suggestions[0].review_type, 'legal_clauses');
    const run = versioned.calls.find((c) => c.table === 'ai_review_runs' && c.op === 'insert');
    assert.equal(run.row.document_version_id, 'v1');
    assert.ok(!('artifact_id' in run.row), 'the version-anchored run names no artifact column');
    assert.equal(versioned.calls.find((c) => c.op === 'download').bucket, 'matter-documents');
    assert.equal(result.reviewRunId, 'run-2');
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.documentTitle, 'Draft');
    assert.ok(result.fullText.includes('thirty (30) days'));
  } finally {
    model.restore();
  }
});

test('the instruction check reads the bytes it is given and lists the existing changes', async () => {
  const { checkReviewInstruction } = await import('../review.js');
  const bytes = reviewFixture();
  const answer = '<answer>The period should be sixty days.</answer>\n<suggestions>[{"clause_reference":"4","original_text":"thirty (30) days","suggested_text":"sixty (60) days","rationale":"Term sheet"},{"clause_reference":"9","original_text":"not in the file","suggested_text":"x","rationale":"y"}]</suggestions>';
  const model = stubFetch(() => streamResponse(answer));
  try {
    const db = recordingSupabase({}, { file: bytes });
    const out = await checkReviewInstruction({
      supabase: db, anthropicKey: 'k',
      document: { bytes, fileName: 'draft.docx', title: 'Draft', typeName: 'Concession Agreement' },
      existing: [{ status: 'pending', clause_reference: '4', rationale: 'x' }],
      insert: false,
      instruction: 'Check the payment period against the term sheet.',
      userId: 'u1',
    });
    assert.ok(!db.calls.some((c) => c.table === 'document_versions'), 'no saved version is loaded');
    assert.ok(!db.calls.some((c) => c.op === 'download' || c.op === 'insert'), 'nothing downloaded, nothing inserted');
    assert.equal(model.requests.length, 1);
    const { system, stream } = model.requests[0].body;
    assert.equal(stream, true);
    assert.ok(system.includes('[pending] 4: x'));
    assert.ok(system.includes('DOCUMENT BEING REVIEWED — "Draft"') && system.includes('thirty (30) days'));
    assert.ok(system.includes('A review of the Concession Agreement below'));
    assert.deepEqual(Object.keys(out), ['reply', 'rows']);
    assert.ok(out.reply.startsWith('The period should be sixty days.'));
    assert.ok(out.reply.includes('1 proposed change was not added'), 'the unlocatable one is counted in the reply');
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].original_text, 'thirty (30) days');
    assert.equal(out.rows[0].suggested_text, 'sixty (60) days');
  } finally {
    model.restore();
  }
});

// ---- Reviewer findings: what counts as the AI's own paragraph, comment
// anchors in it, the fallback engine's ids, marks on empty run properties,
// paragraphs holding a text box, and the old preview's first-occurrence rule.

const PACKAGE = {
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
};
const withPart = (bytes, xml, part = 'word/document.xml') => { const e = unzipSync(bytes); e[part] = strToU8(xml); return zipSync(e); };
const textsOf = (bytes) => [...inspectDocx(bytes).byRef.values()].map((r) => r.exactText);

test("a paragraph the AI added is its own only until someone else writes in it", async () => {
  const base = docFrom('<w:p><w:r><w:t>Anchor.</w:t></w:r></w:p>');
  const first = await applyDocxOps(base, [{ op: 'insert_after', p: 1, expected: 'Anchor.', text: 'Added clause.' }], inspectDocx(base).byRef);
  const [M, B] = first.results[0].revisionIds;
  // Counsel types " by Counsel" at the end of the added paragraph in Word.
  const counsel = '<w:ins w:id="500" w:author="Counsel" w:date="D"><w:r><w:t xml:space="preserve"> by Counsel</w:t></w:r></w:ins>';
  const typed = withPart(first.bytes, docXml(first.bytes).replace('</w:ins></w:p>', `</w:ins>${counsel}</w:p>`));
  const view = inspectDocx(typed);
  const [p] = [...view.byRef].find(([, r]) => r.exactText === 'Added clause. by Counsel');
  // Deleting it is tracked: Counsel's words are struck through, not removed, and their revision stays.
  const del = await applyDocxOps(typed, [{ op: 'delete', p, expected: 'Added clause. by Counsel' }], view.byRef, { idFloor: first.maxId });
  const d = del.results[0];
  assert.equal(d.status, 'applied');
  assert.equal(d.removedIds, undefined);
  assert.equal(d.revisionIds.length, 3, 'a mark and one deletion per run');
  assert.ok(docXml(del.bytes).includes('w:id="500"') && docXml(del.bytes).includes('by Counsel'));
  assert.ok(docXml(del.bytes).includes(`<w:rPr><w:ins w:id="${M}" `) && /<w:ins w:id="\d+" w:author="AKLA AI"[^>]*\/><w:del w:id="\d+"/.test(docXml(del.bytes)), 'the deleted mark follows the inserted one');
  assert.deepEqual(textsOf(acceptAllChanges(del.bytes)), ['Anchor.']);
  // Rewriting it is a redline inside the paragraph, Counsel's insertion untouched.
  const rep = await applyDocxOps(typed, [{ op: 'replace', p, expected: 'Added clause. by Counsel', text: 'Added clause, amended. by Counsel' }], view.byRef, { idFloor: first.maxId });
  const r = rep.results[0];
  assert.equal(r.status, 'applied');
  assert.equal(r.takesOver, undefined);
  assert.ok(docXml(rep.bytes).includes(counsel), 'Counsel\'s insertion is byte-identical');
  assert.ok(docXml(rep.bytes).includes(`<w:ins w:id="${B}" w:author="AKLA AI"`), 'the earlier insertion keeps its id');
  assert.deepEqual(textsOf(rep.bytes), ['Anchor.', 'Added clause, amended. by Counsel']);
  const { applyDecisions } = await import('../changes.js');
  const back = applyDecisions(rep.bytes, [{ id: 'r', part: 'word/document.xml', revisionIds: r.revisionIds, decision: 'rejected' }]);
  assert.equal(back.results[0].status, 'applied');
  assert.deepEqual(textsOf(back.bytes), ['Anchor.', 'Added clause. by Counsel']);
  assert.ok(docXml(back.bytes).includes(counsel));
  // Text typed outside any insertion counts the same way.
  const plain = withPart(first.bytes, docXml(first.bytes).replace('</w:ins></w:p>', '</w:ins><w:r><w:t xml:space="preserve"> plain</w:t></w:r></w:p>'));
  const v2 = inspectDocx(plain);
  const [p2] = [...v2.byRef].find(([, r]) => r.exactText === 'Added clause. plain');
  const del2 = await applyDocxOps(plain, [{ op: 'delete', p: p2, expected: 'Added clause. plain' }], v2.byRef, { idFloor: first.maxId });
  assert.equal(del2.results[0].removedIds, undefined);
  assert.ok(docXml(del2.bytes).includes('plain'));
  // Untouched, the paragraph is still the AI's own: deleting it withdraws the earlier change.
  const v1 = inspectDocx(first.bytes);
  const [p1] = [...v1.byRef].find(([, r]) => r.exactText === 'Added clause.');
  const own = await applyDocxOps(first.bytes, [{ op: 'delete', p: p1, expected: 'Added clause.' }], v1.byRef, { idFloor: first.maxId });
  assert.deepEqual([own.results[0].revisionIds, own.results[0].removedIds], [[], [M, B]]);
  assert.deepEqual(textsOf(own.bytes), ['Anchor.']);
});

test('a comment on an AI-added paragraph survives its rewrite', async () => {
  const base = docFrom('<w:p><w:r><w:t>Anchor.</w:t></w:r></w:p>', PACKAGE);
  const first = await applyDocxOps(base, [{ op: 'insert_after', p: 1, expected: 'Anchor.', text: 'Added clause.' }], inspectDocx(base).byRef);
  const [M, B] = first.results[0].revisionIds;
  const v1 = inspectDocx(first.bytes);
  const [p] = [...v1.byRef].find(([, r]) => r.exactText === 'Added clause.');
  const noted = await applyDocxOps(first.bytes, [{ op: 'comment', p, expected: 'Added clause.', text: 'Confirm this.' }], v1.byRef, { idFloor: first.maxId });
  assert.equal(noted.results[0].status, 'applied');
  const anchored = docXml(noted.bytes);
  assert.ok(anchored.includes('<w:commentRangeStart w:id="0"/><w:ins ') && anchored.includes('</w:ins><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>'));
  const v2 = inspectDocx(noted.bytes);
  const third = await applyDocxOps(noted.bytes, [{ op: 'replace', p, expected: 'Added clause.', text: 'Rewritten clause.' }], v2.byRef, { idFloor: noted.maxId });
  const r = third.results[0];
  assert.equal(r.status, 'applied');
  assert.deepEqual(r.takesOver, [M, B], 'still the AI\'s own paragraph: the change is taken over');
  assert.equal(r.revisionIds[0], M);
  const xml = docXml(third.bytes);
  const para = xml.match(/<w:p>(?:(?!<\/w:p>)[\s\S])*Rewritten clause[\s\S]*?<\/w:p>/)[0];
  assert.ok(para.includes('<w:commentRangeStart w:id="0"/>') && para.includes('<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>'), 'the comment\'s range and reference are still there');
  assert.ok(/<w:commentRangeStart w:id="0"\/><w:ins w:id="\d+" w:author="AKLA AI"[^>]*><w:r><w:t xml:space="preserve">Rewritten clause\.<\/w:t><\/w:r><\/w:ins><w:commentRangeEnd/.test(para), 'the new insertion sits inside the range');
  assert.ok(!xml.includes('Added clause.'));
  assert.ok(strFromU8(unzipSync(third.bytes)['word/comments.xml']).includes('Confirm this.'));
  // A bookmark too.
  const marked = withPart(first.bytes, docXml(first.bytes).replace(`<w:ins w:id="${B}"`, `<w:bookmarkStart w:id="3" w:name="_Ref1"/><w:ins w:id="${B}"`).replace('</w:ins></w:p>', '</w:ins><w:bookmarkEnd w:id="3"/></w:p>'));
  const v3 = inspectDocx(marked);
  const again = await applyDocxOps(marked, [{ op: 'replace', p, expected: 'Added clause.', text: 'Rewritten clause.' }], v3.byRef, { idFloor: first.maxId });
  assert.deepEqual(again.results[0].takesOver, [M, B]);
  assert.ok(/<w:bookmarkStart w:id="3" w:name="_Ref1"\/><w:ins [^>]*><w:r><w:t xml:space="preserve">Rewritten clause\.<\/w:t><\/w:r><\/w:ins><w:bookmarkEnd w:id="3"\/><\/w:p>/.test(docXml(again.bytes)));
});

test("the fallback engine's ids are renumbered above the floor", async () => {
  const para = '<w:p><w:r><w:t xml:space="preserve">Clause 1 pays within</w:t></w:r><w:r><w:t xml:space="preserve"> thirty</w:t><w:footnoteReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> days.</w:t></w:r></w:p>';
  const earlier = '<w:p><w:ins w:id="9001" w:author="AKLA AI" w:date="D"><w:r><w:t>Earlier.</w:t></w:r></w:ins></w:p>';
  const bytes = docFrom(para + earlier, PACKAGE);
  const view = inspectDocx(bytes);
  const out = await applyDocxOps(bytes, [{ op: 'replace', p: 1, expected: 'Clause 1 pays within thirty days.', text: 'Clause 1 pays within forty days.' }], view.byRef, { idFloor: 9500 });
  const r = out.results[0];
  const xml = docXml(out.bytes);
  assert.equal(r.via, 'fallback');
  assert.equal(r.revisionIds.length, 2);
  assert.ok(r.revisionIds.every((id) => id > 9500), `ids ${r.revisionIds} are above the floor`);
  for (const id of r.revisionIds) assert.ok(idsOf(xml).includes(id), `id ${id} is in the file as AKLA AI`);
  assert.deepEqual(idsOf(xml).sort((a, b) => a - b), [9001, ...r.revisionIds].sort((a, b) => a - b), 'no other id appeared');
  assert.equal(out.maxId, Math.max(...r.revisionIds));
  assert.ok(xml.includes(earlier), 'the earlier insertion is untouched');
  assert.ok(xml.includes('<w:footnoteReference w:id="1"/>'));
  assert.ok(docXml(acceptAllChanges(out.bytes)).includes('forty'));
});

test('a paragraph mark is written whatever shape the run properties take', async () => {
  const { applyDecisions } = await import('../changes.js');
  const cases = [
    ['<w:pPr><w:pStyle w:val="Normal"/><w:rPr/></w:pPr>', '<w:rPr><w:ins w:id="9003" w:author="AKLA AI" w:date="'],
    ['<w:pPr><w:pStyle w:val="Normal"/><w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/></w:pPr>', '<w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:ins w:id="9003" w:author="AKLA AI" w:date="'],
    ['<w:pPr><w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:b/></w:rPr></w:pPr>', '<w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:ins w:id="9003" w:author="AKLA AI" w:date="'],
    ['<w:pPr/>', '<w:pPr><w:rPr><w:ins w:id="9003" w:author="AKLA AI" w:date="'],
  ];
  for (const [pPr, want] of cases) {
    const bytes = docFrom(`<w:p>${pPr}<w:r><w:t>Anchor.</w:t></w:r></w:p><w:p><w:r><w:t>Next.</w:t></w:r></w:p>`);
    const view = inspectDocx(bytes);
    const out = await applyDocxOps(bytes, [
      { op: 'insert_after', p: 1, expected: 'Anchor.', text: 'Added.' },
      { op: 'delete', p: 1, expected: 'Anchor.' },
    ], view.byRef);
    const xml = docXml(out.bytes);
    assert.equal(out.applied, 2, pPr);
    for (const r of out.results) for (const id of r.revisionIds) assert.ok(xml.includes(`w:id="${id}"`), `${pPr}: id ${id} is in the file`);
    assert.ok(xml.includes(want), `${pPr}: the added paragraph's mark is in its run properties`);
    assert.ok(!xml.includes('<w:rPr/>') && !xml.includes('<w:pPr/>') || pPr === '<w:pPr/>', pPr);
    assert.deepEqual(applyDecisions(out.bytes, out.results.map((r) => ({ id: r.kind, part: 'word/document.xml', revisionIds: r.revisionIds, decision: 'rejected' }))).results.map((r) => r.status), ['applied', 'applied'], pPr);
    assert.deepEqual(textsOf(acceptAllChanges(out.bytes)), ['Added.', 'Next.'], pPr);
  }
});

test('a paragraph holding a text box is listed but never written to', async () => {
  const box = '<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent><w:p><w:r><w:t>Inner box.</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>';
  const body = `<w:p><w:r><w:t xml:space="preserve">Outer text </w:t></w:r>${box}<w:r><w:t xml:space="preserve">and more.</w:t></w:r></w:p><w:p><w:r><w:t>Second para.</w:t></w:r></w:p>`;
  const bytes = docFrom(body, PACKAGE);
  const view = inspectDocx(bytes);
  assert.deepEqual([...view.byRef.values()].map((r) => [r.index, r.exactText]), [[1, 'Outer text and more.'], [2, 'Second para.']], 'the box\'s own paragraph is not a paragraph of the document');
  assert.ok(view.listing.includes('¶1 [text box] Outer text and more.'));
  const ops = [
    { op: 'insert_after', p: 1, expected: 'Outer text and more.', text: 'New paragraph.' },
    { op: 'replace', p: 1, expected: 'Outer text and more.', text: 'Changed text and more.' },
    { op: 'delete', p: 1, expected: 'Outer text and more.' },
    { op: 'insert_after', p: 2, expected: 'Second para.', text: 'Third para.' },
  ];
  const out = await applyDocxOps(bytes, ops, view.byRef);
  assert.deepEqual(out.results.map((r) => [r.status, r.reason ?? null]), [['skipped', 'formatting'], ['skipped', 'formatting'], ['skipped', 'formatting'], ['applied', null]]);
  const xml = docXml(out.bytes);
  assert.ok(xml.startsWith(`<w:document ${ns}><w:body><w:p><w:r><w:t xml:space="preserve">Outer text </w:t></w:r>${box}<w:r><w:t xml:space="preserve">and more.</w:t></w:r></w:p><w:p><w:r><w:t>Second para.</w:t></w:r></w:p><w:p><w:pPr><w:rPr><w:ins `), 'the text box paragraph is untouched and the new paragraph follows the second');
  assert.deepEqual(textsOf(out.bytes), ['Outer text and more.', 'Second para.', 'Third para.']);
  // The same for a drawing written as alternate content, and in a review.
  const alt = `<w:p><w:r><w:t xml:space="preserve">Lead </w:t></w:r><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>Box A</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback>${box.slice('<w:r>'.length, -'</w:r>'.length)}</mc:Fallback></mc:AlternateContent></w:r></w:p><w:p><w:r><w:t>Tail para.</w:t></w:r></w:p>`;
  const v2 = inspectDocx(docFrom(alt, PACKAGE));
  assert.deepEqual([...v2.byRef.values()].map((r) => r.exactText), ['Lead ', 'Tail para.']);
  const review = applyReviewSuggestions(docFrom(body, PACKAGE), [
    { id: 'a', original: 'Outer text and more.', suggested: 'Outer text and less.', accepted: false },
    { id: 'b', original: 'Second para.', suggested: 'Second clause.', accepted: false },
  ]);
  assert.deepEqual(review.results.map((r) => [r.status, r.reason ?? null]), [['skipped', 'formatting'], ['applied', null]]);
});

test('the old preview takes the first place a quote is found', () => {
  const two = docFrom('<w:p><w:r><w:t>4. The Authority shall pay.</w:t></w:r></w:p><w:p><w:r><w:t>7. The Authority shall notify.</w:t></w:r></w:p>');
  const change = { id: 'a', original: 'The Authority shall', suggested: 'The Authority must', accepted: false };
  assert.equal(applyReviewSuggestions(two, [change]).results[0].reason, 'ambiguous');
  const legacy = applyReviewSuggestions(two, [change], { legacy: true });
  assert.equal(legacy.results[0].status, 'applied');
  assert.equal(legacy.results[0].paragraphIndex, 1);
  const xml = docXml(legacy.bytes);
  assert.ok(/4\. The Authority <\/w:t><\/w:r><w:del /.test(xml) && xml.includes('<w:t>7. The Authority shall notify.</w:t>'));
  // The clause still narrows it first.
  assert.equal(applyReviewSuggestions(two, [{ ...change, clause: '7' }], { legacy: true }).results[0].paragraphIndex, 2);
});
