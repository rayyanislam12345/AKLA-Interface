import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { inspectDocx, applyDocxOps, acceptAllChanges } from '../docxAgent.js';
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
