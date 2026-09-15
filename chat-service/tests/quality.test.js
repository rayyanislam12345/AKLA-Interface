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
  ]);
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
