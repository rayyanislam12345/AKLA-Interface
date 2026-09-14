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
