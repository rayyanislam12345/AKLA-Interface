// Dependency-free checks, shared by Node drafting and Deno review. These are
// explicit structural/profile checks, not a claim of rendered Word fidelity.
const story = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;
const clean = xml => (xml ?? '').replace(/<w:(?:ins|del)\b[^>]*\/>/g, '').replace(/w:rsid\w+="[^"]*"/g, '').replace(/>\s+</g, '><').trim();
const properties = (xml, name) => [...(xml ?? '').matchAll(new RegExp(`<w:${name}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</w:${name}>)`, 'g'))].map(m => clean(m[0]));
export function inspectPackage(parts) {
  const placeholders = [];
  const errors = [];
  for (const [name, xml] of Object.entries(parts)) {
    if (!story.test(name)) continue;
    const visible = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
    let paragraph = 0;
    for (const p of visible.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
      paragraph++;
      const text = [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
      for (const m of text.matchAll(/\[[^\]\n]{0,120}\]|_{3,}/g)) placeholders.push({ part: name, paragraph, text: m[0] });
    }
    for (const cell of xml.matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)) {
      if (!/<w:p(?:\s|>|\/)/.test(cell[0])) errors.push(`${name}: a table cell has no paragraph`);
    }
  }
  return { placeholders, errors };
}
export function compareFormat(parts, standard) {
  const findings = [];
  for (const part of ['word/styles.xml', 'word/numbering.xml', 'word/theme/theme1.xml', 'word/fontTable.xml']) {
    if (clean(parts[part]) !== clean(standard[part])) findings.push({ check: 'style_definitions', part, detail: 'Style, numbering, font, or theme definitions differ from the reference.' });
  }
  const allowedRuns = new Set(Object.entries(standard).filter(([p]) => story.test(p)).flatMap(([,x]) => properties(x, 'rPr')));
  const allowedParagraphs = new Set(Object.entries(standard).filter(([p]) => story.test(p)).flatMap(([,x]) => properties(x, 'pPr')));
  for (const [part, xml] of Object.entries(parts)) {
    if (!story.test(part)) continue;
    if (JSON.stringify(properties(xml, 'sectPr')) !== JSON.stringify(properties(standard[part], 'sectPr'))) findings.push({ check: 'page_setup', part, detail: 'Section properties, page setup, or header/footer references differ.' });
    for (const [name, allowed] of [['rPr', allowedRuns], ['pPr', allowedParagraphs]]) {
      const novel = [...new Set(properties(xml, name))].filter(p => p && !allowed.has(p));
      if (novel.length) findings.push({ check: name === 'rPr' ? 'run_format' : 'paragraph_format', part, detail: `${novel.length} formatting definition(s) are not present in the reference and require review.` });
    }
  }
  for (const part of Object.keys(standard).filter(p => /^word\/(header|footer)\d+\.xml$/.test(p))) {
    if (!parts[part]) findings.push({ check: 'missing_part', part, detail: 'A reference header/footer is missing.' });
  }
  return { status: findings.length ? 'needs_review' : 'checked', checks: ['style_definitions', 'page_setup', 'run_format', 'paragraph_format', 'header_footer_presence'], findings, limitation: 'Structural comparison only. Pagination, visual layout, and legal completeness require review.' };
}
