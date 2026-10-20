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

// ---------------------------------------------------------------- format gate
// The firm's file for a kind of document is the standard; a draft is filed
// only if its look is the firm's look. formatGate compares a draft with that
// file and says, in sentences a lawyer can act on, what differs. Inputs are
// part maps ({ 'word/document.xml': xml, … }) or profiles from formatProfile
// (formatFingerprint.js caches the base's profile by its bytes).
// Normalised away before any comparison: rsids, w14:paraId/textId, the
// tracked-change records (w:ins/w:del marks, w:rPrChange and kin), the TOC
// field's w:dirty flag, and — for run formats only — the <w:b/><w:bCs/> pair
// the engine adds to bold a defined term.
const TRACKED_PROPS = /<w:(rPrChange|pPrChange|sectPrChange|tblPrChange|trPrChange|tcPrChange|tblGridChange|numberingChange)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1>)/g;
const normalise = xml => clean(xml).replace(TRACKED_PROPS, '').replace(/\s(?:w14:paraId|w14:textId|w:dirty)="[^"]*"/g, '').replace(/<w:(?:moveFrom|moveTo)\b[^>]*\/>/g, '').replace(/\s+(\/?>)/g, '$1').replace(/ {2,}/g, ' ');
const DEFINED_TERM_BOLD = /<w:b\/><w:bCs\/>/g;
const SHAPES = [/<mc:AlternateContent\b(?:(?!<mc:AlternateContent\b)[\s\S])*?<\/mc:AlternateContent>/g, /<w:pict\b[\s\S]*?<\/w:pict>/g, /<w:drawing\b[\s\S]*?<\/w:drawing>/g, /<w:object\b[\s\S]*?<\/w:object>/g];
// Text in shapes (cover boxes, signature lines) is not body text; nested
// AlternateContent is removed from the inside out.
const withoutShapes = xml => {
  let x = xml, prev;
  do { prev = x; x = x.replace(SHAPES[0], ''); } while (x !== prev);
  for (const re of SHAPES.slice(1)) x = x.replace(re, '');
  return x;
};
const PARAGRAPH = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const attr = (xml, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(xml ?? '')?.[1];
const decodeLength = s => s.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, '_').length;
const textOf = p => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map(m => m[1] === undefined ? '\t' : m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")).join('');
const cm = twips => `${(Number(twips) / 566.929).toFixed(2)} cm`;
const pct = n => `${(n * 100).toFixed(1).replace(/\.0$/, '')}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function relsOf(parts) {
  const map = new Map();
  for (const m of (parts['word/_rels/document.xml.rels'] ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'); const target = attr(m[0], 'Target');
    if (id && target) map.set(id, target.startsWith('/') ? target.slice(1) : `word/${target}`);
  }
  return map;
}

// Fonts and sizes as Word resolves them: run → character style → paragraph
// style (basedOn chain) → table style → document defaults → theme.
function styleContext(parts) {
  const stylesXml = (parts['word/styles.xml'] ?? '').replace(TRACKED_PROPS, '');
  const theme = parts['word/theme/theme1.xml'] ?? '';
  const minor = /<a:minorFont>[\s\S]*?<a:latin\b[^>]*typeface="([^"]*)"/.exec(theme)?.[1] || undefined;
  const major = /<a:majorFont>[\s\S]*?<a:latin\b[^>]*typeface="([^"]*)"/.exec(theme)?.[1] || undefined;
  const fontOf = rPr => {
    const f = /<w:rFonts\b[^>]*>/.exec(rPr ?? '')?.[0];
    if (!f) return undefined;
    const t = attr(f, 'w:asciiTheme');
    return (t ? (t.startsWith('major') ? major : minor) : undefined) ?? attr(f, 'w:ascii');
  };
  const sizeOf = rPr => { const v = /<w:sz w:val="(\d+)"/.exec(rPr ?? '')?.[1]; return v ? Number(v) : undefined; };
  const defaultsRPr = /<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/.exec(stylesXml)?.[0] ?? '';
  const defaults = { font: fontOf(defaultsRPr) ?? 'Times New Roman', size: sizeOf(defaultsRPr) ?? 20 };
  const styles = new Map();
  let defaultParagraph = null;
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)) {
    const open = /^<w:style\b[^>]*>/.exec(m[0])[0];
    const id = attr(open, 'w:styleId'); const type = attr(open, 'w:type');
    if (!id) continue;
    const own = m[0].replace(/<w:tblStylePr\b[\s\S]*?<\/w:tblStylePr>/g, '').replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '');
    const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(own)?.[0];
    styles.set(id, {
      id, type,
      name: attr(/<w:name\b[^>]*>/.exec(m[0])?.[0], 'w:val') ?? id,
      basedOn: attr(/<w:basedOn\b[^>]*>/.exec(m[0])?.[0], 'w:val'),
      outline: attr(/<w:outlineLvl\b[^>]*>/.exec(m[0])?.[0], 'w:val'),
      font: fontOf(rPr), size: sizeOf(rPr),
    });
    if (type === 'paragraph' && /\sw:default="(?:1|true|on)"/.test(open)) defaultParagraph = id;
  }
  const memo = new Map();
  const resolve = (id, seen = new Set()) => {
    if (!id || !styles.has(id) || seen.has(id)) return {};
    if (memo.has(id)) return memo.get(id);
    seen.add(id);
    const s = styles.get(id); const parent = resolve(s.basedOn, seen);
    const out = { font: s.font ?? parent.font, size: s.size ?? parent.size };
    memo.set(id, out);
    return out;
  };
  return { styles, resolve, fontOf, sizeOf, defaults, defaultParagraph };
}

// A typed clause number: "1.", "4.2", "4.2.1", "(a)", "(iv)" at the start of
// a paragraph. A number is one only when the word after it reads like a
// clause ("1.1 The Concessionaire", "2. Each Party"): a time ("10.30 a.m."),
// a measure ("2.5 km"), an amount ("1.5 million") or a figure followed by a
// lower-case word is a fill, not a clause number. Table cells are not
// looked at: a cell holding "10.30" or "1." is a value.
const TYPED_NUMBER = /^\s*(\d{1,2}(?:\.\d{1,2}){1,4}\.?|\d{1,2}\.|\((?:[a-z]{1,2}|[ivxlc]{1,6})\))(?=[\s\u00a0])/;
const NOT_A_CLAUSE = /^[\s\u00a0]*(?:[ap]\.?\s?m\b|noon\b|midnight\b|hours?\b|hrs?\b|o['’]clock|pst\b|pkt\b|gmt\b|utc\b|km\b|kms\b|m\b|mm\b|cm\b|kg\b|mw\b|kw\b|mva\b|kv\b|mtpa\b|tons?\b|tonnes?\b|%|per\s?cent|percent|per\b|million|billion|trillion|crores?\b|lakhs?\b|thousand|times\b|x\b|years?\b|months?\b|weeks?\b|days?\b|metres?\b|meters?\b|acres?\b|hectares?\b|kanals?\b|marlas?\b|sq\b|square\b|usd\b|pkr\b|rs\b)/i;
function typedNumberOf(text) {
  const m = TYPED_NUMBER.exec(text);
  if (!m) return null;
  if (m[1].startsWith('(')) return m[1];
  const rest = text.slice(m[0].length);
  if (NOT_A_CLAUSE.test(rest)) return null;
  return /^[\s\u00a0]+[A-Z(\[“"‘']/.test(rest) ? m[1] : null;
}

// One walk over the body: characters per resolved font and size, per
// paragraph too, styles in use, typed clause numbers, list ids.
function measureBody(parts, ctx) {
  const doc = withoutShapes(parts['word/document.xml'] ?? '').replace(TRACKED_PROPS, '');
  const fonts = new Map(); const sizes = new Map(); const paragraphs = [];
  const styleUse = new Map(); const tableStyles = new Map(); const numIds = new Set(); const typed = new Map(); const typedExamples = new Map();
  const placeholders = new Map();
  const tables = [];
  let chars = 0;
  const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
  for (const m of doc.matchAll(/<w:tbl>|<w:tbl\s[^>]*>|<\/w:tbl>|<w:tblStyle w:val="([^"]*)"|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const t = m[0];
    if (t.startsWith('<w:tbl>') || t.startsWith('<w:tbl ')) { tables.push(null); continue; }
    if (t === '</w:tbl>') { tables.pop(); continue; }
    if (m[1] !== undefined) { if (tables.length) tables[tables.length - 1] = m[1]; bump(tableStyles, m[1]); continue; }
    const head = /^<w:p(?:\s[^>]*)?>(<w:pPr>[\s\S]*?<\/w:pPr>)?/.exec(t);
    const pPr = head?.[1] ?? '';
    const pStyle = attr(/<w:pStyle\b[^>]*>/.exec(pPr)?.[0], 'w:val') ?? ctx.defaultParagraph;
    const numId = attr(/<w:numId\b[^>]*>/.exec(pPr)?.[0], 'w:val');
    if (numId && numId !== '0') numIds.add(numId);
    const text = textOf(t);
    for (const ph of text.matchAll(/\[(?:[●•▪■◼]|\s*|_+|\.{3,}|…)\]/g)) bump(placeholders, ph[0]);
    if (!text.trim()) continue;
    bump(styleUse, pStyle ?? '');
    if (!/^TOC/i.test(pStyle ?? '') && !tables.length) {
      const typedNo = typedNumberOf(text);
      if (typedNo) { bump(typed, typedNo); if (!typedExamples.has(typedNo)) typedExamples.set(typedNo, text.trim().slice(0, 60)); }
    }
    const para = ctx.resolve(pStyle);
    const table = tables.length ? ctx.resolve(tables[tables.length - 1]) : {};
    // Where the paragraph sits, for the font and size rule: its style, and
    // the table (by its style) it is in, if any.
    const style = pStyle ?? '';
    const context = `${style}\u0000${tables.length ? `table:${tables[tables.length - 1] ?? ''}` : ''}`;
    const own = { fonts: new Map(), sizes: new Map(), chars: 0 };
    for (const r of t.slice(head?.[0].length ?? 0).matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
      let n = 0;
      for (const x of r[1].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) n += decodeLength(x[1]);
      if (!n) continue;
      const rPr = /^<w:rPr>[\s\S]*?<\/w:rPr>/.exec(r[1])?.[0];
      const cs = ctx.resolve(attr(/<w:rStyle\b[^>]*>/.exec(rPr ?? '')?.[0], 'w:val'));
      const font = ctx.fontOf(rPr) ?? cs.font ?? para.font ?? table.font ?? ctx.defaults.font;
      const size = ctx.sizeOf(rPr) ?? cs.size ?? para.size ?? table.size ?? ctx.defaults.size;
      bump(own.fonts, font, n); bump(own.sizes, size, n); own.chars += n;
    }
    if (!own.chars) continue;
    for (const [k, v] of own.fonts) bump(fonts, k, v);
    for (const [k, v] of own.sizes) bump(sizes, k, v);
    chars += own.chars;
    paragraphs.push({ fonts: own.fonts, sizes: own.sizes, chars: own.chars, text: text.trim().slice(0, 60), style, context });
  }
  // The fonts and sizes the file uses for each kind of paragraph (style and
  // table), for each style anywhere, and anywhere at all.
  const kinds = { contexts: new Map(), styles: new Map(), all: { fonts: new Set(), sizes: new Set() } };
  const into = (map, key) => { if (!map.has(key)) map.set(key, { fonts: new Set(), sizes: new Set() }); return map.get(key); };
  for (const p of paragraphs) {
    for (const set of [into(kinds.contexts, p.context), into(kinds.styles, p.style), kinds.all]) {
      for (const f of p.fonts.keys()) set.fonts.add(f);
      for (const z of p.sizes.keys()) set.sizes.add(z);
    }
  }
  const top = map => [...map].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const [font, fontChars] = top(fonts); const [size, sizeChars] = top(sizes);
  return {
    chars, fonts, sizes, paragraphs, kinds, styleUse, tableStyles, numIds, typed, typedExamples, placeholders,
    font, fontShare: chars ? fontChars / chars : 1, sizeHalfPts: size, sizeShare: chars ? sizeChars / chars : 1,
  };
}

const PAGE_SIZES = [['A4', 11906, 16838], ['US Letter', 12240, 15840], ['US Legal', 12240, 20160], ['A3', 16838, 23811], ['A5', 8391, 11906]];
const pageName = ({ w, h, orient }) => {
  const [a, b] = [Number(w), Number(h)].sort((x, y) => x - y);
  const named = PAGE_SIZES.find(([, x, y]) => Math.abs(x - a) <= 30 && Math.abs(y - b) <= 30)?.[0] ?? `${cm(a)} × ${cm(b)}`;
  return `${named} ${orient === 'landscape' || Number(w) > Number(h) ? 'landscape' : 'portrait'}`;
};
const MARGINS = [['top', 'top'], ['bottom', 'bottom'], ['left', 'left'], ['right', 'right'], ['header', 'header distance'], ['footer', 'footer distance'], ['gutter', 'gutter']];

function sectionsOf(parts, rels) {
  const doc = (parts['word/document.xml'] ?? '').replace(TRACKED_PROPS, '');
  return [...doc.matchAll(/<w:sectPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:sectPr>)/g)].map(m => {
    const x = m[0];
    const pgSz = /<w:pgSz\b[^>]*>/.exec(x)?.[0]; const pgMar = /<w:pgMar\b[^>]*>/.exec(x)?.[0];
    const refs = kind => [...x.matchAll(new RegExp(`<w:${kind}Reference\\b[^>]*>`, 'g'))].map(r => ({ type: attr(r[0], 'w:type') ?? 'default', part: rels.get(attr(r[0], 'r:id')) ?? attr(r[0], 'r:id') }));
    const sz = pgSz ? { w: Number(attr(pgSz, 'w:w')), h: Number(attr(pgSz, 'w:h')), code: attr(pgSz, 'w:code') ?? null } : null;
    const orient = attr(pgSz, 'w:orient') ?? (sz && sz.w > sz.h ? 'landscape' : 'portrait');
    return {
      pgSz: sz && { ...sz, name: pageName({ ...sz, orient }) },
      pgMar: pgMar ? Object.fromEntries(MARGINS.map(([k]) => [k, attr(pgMar, `w:${k}`) == null ? null : Number(attr(pgMar, `w:${k}`))])) : null,
      orient,
      titlePg: /<w:titlePg(?:\/>|\s(?![^>]*w:val="(?:0|false|off)")[^>]*\/>)/.test(x),
      headerRefs: refs('header'), footerRefs: refs('footer'),
      xml: normalise(x).replace(/\sr:id="([^"]*)"/g, (_, id) => ` r:id="${rels.get(id) ?? id}"`),
    };
  });
}

function numberingOf(xml) {
  const x = normalise(xml ?? '');
  const abstracts = new Map(); const nums = new Map();
  for (const m of x.matchAll(/<w:abstractNum\b[^>]*>[\s\S]*?<\/w:abstractNum>/g)) abstracts.set(attr(m[0], 'w:abstractNumId'), m[0]);
  for (const m of x.matchAll(/<w:num\b[^>]*>([\s\S]*?)<\/w:num>/g)) nums.set(attr(m[0], 'w:numId'), { xml: m[0], inner: m[1] });
  const rest = x.replace(/<w:abstractNum\b[^>]*>[\s\S]*?<\/w:abstractNum>/g, '').replace(/<w:num\b[^>]*>[\s\S]*?<\/w:num>/g, '');
  return { abstracts, nums, rest };
}

const formatKey = (xml, name) => {
  let k = xml;
  if (name === 'pPr') k = k.replace(/<w:sectPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:sectPr>)/g, '');
  else k = k.replace(DEFINED_TERM_BOLD, '');
  k = k.replace(/<w:rPr><\/w:rPr>|<w:rPr\/>/g, '');
  return /^<w:(?:pPr|rPr)(?:\s[^>]*)?(?:\/>|><\/w:(?:pPr|rPr)>)$/.test(k) ? '' : k;
};
const formatsIn = (xml, name) => [...xml.matchAll(new RegExp(`<w:${name}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</w:${name}>)`, 'g'))].map(m => formatKey(m[0], name));

function describeRun(k) {
  const bits = [];
  const f = /<w:rFonts\b[^>]*>/.exec(k)?.[0];
  if (f) bits.push(attr(f, 'w:ascii') ?? attr(f, 'w:hAnsi') ?? attr(f, 'w:asciiTheme') ?? 'another font');
  const sz = /<w:sz w:val="(\d+)"/.exec(k)?.[1]; if (sz) bits.push(`${Number(sz) / 2} pt`);
  for (const [tag, word] of [['b', 'bold'], ['i', 'italic'], ['u', 'underlined'], ['caps', 'capitals'], ['smallCaps', 'small capitals'], ['strike', 'struck through'], ['highlight', 'highlighted'], ['color', 'coloured'], ['vertAlign', 'raised or lowered'], ['rStyle', 'a character style']]) {
    if (new RegExp(`<w:${tag}(?:\\s(?![^>]*w:val="(?:0|false|none)")[^>]*)?/>`).test(k)) bits.push(word);
  }
  return bits.length ? bits.join(', ') : 'other text settings';
}
function describeParagraph(k) {
  const bits = [];
  const st = attr(/<w:pStyle\b[^>]*>/.exec(k)?.[0], 'w:val'); bits.push(st ? `style ${st}` : 'no style');
  for (const [tag, word] of [['numPr', 'numbered'], ['ind', 'indent'], ['spacing', 'spacing'], ['jc', 'alignment'], ['keepNext', 'keep with next'], ['tabs', 'tab stops'], ['rPr', 'paragraph mark format']]) if (k.includes(`<w:${tag}`)) bits.push(word);
  return bits.join(', ');
}

// A header or footer line that is filled in for each document: one holding
// a blank ([●], [Project Name], a run of underscores or dots: the footer's
// initials row) or a date. The title line is variable only when a change
// was asked of it (the fill paths pass that paragraph).
const VARIABLE_LINE = /\[[^\]\n]{0,120}\]|_{3,}|…{2,}|\.{3,}/;
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\b\\.?';
const DATE_LINE = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH},?\\s+\\d{4}\\b|\\b${MONTH}\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?\\d{4}\\b|\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b`, 'i');
const isVariableLine = text => VARIABLE_LINE.test(text) || DATE_LINE.test(text);

function headerFooterOf(parts, sections) {
  const labels = new Map();
  sections.forEach((s, i) => {
    for (const [refs, kind] of [[s.headerRefs, 'header'], [s.footerRefs, 'footer']]) for (const r of refs) {
      if (!labels.has(r.part)) labels.set(r.part, `the ${r.type === 'first' ? 'first-page ' : r.type === 'even' ? 'even-page ' : ''}${kind} of section ${i + 1}`);
    }
  });
  const out = {};
  for (const name of Object.keys(parts).filter(p => /^word\/(header|footer)\d+\.xml$/.test(p)).sort()) {
    const xml = normalise(parts[name]);
    const paragraphs = xml.match(PARAGRAPH) ?? [];
    out[name] = { label: labels.get(name) ?? `the ${name.includes('header') ? 'header' : 'footer'} (${name.slice(5, -4)})`, xml, paragraphs, variable: paragraphs.map(p => isVariableLine(textOf(p))) };
  }
  return out;
}

/** Everything the gate needs from one file; formatFingerprint.js caches it. */
export function formatProfile(parts) {
  const rels = relsOf(parts);
  const ctx = styleContext(parts);
  const sections = sectionsOf(parts, rels);
  const runFormats = new Set(); const paragraphFormats = new Set();
  const storyFormats = {};
  for (const [name, xml] of Object.entries(parts)) {
    if (!story.test(name)) continue;
    const n = normalise(xml);
    storyFormats[name] = { rPr: formatsIn(n, 'rPr'), pPr: formatsIn(n, 'pPr') };
    for (const k of storyFormats[name].rPr) runFormats.add(k);
    for (const k of storyFormats[name].pPr) paragraphFormats.add(k);
  }
  const headingStyles = {};
  const body = measureBody(parts, ctx);
  for (const s of ctx.styles.values()) {
    if (s.type !== 'paragraph') continue;
    const level = Number(/^heading (\d)$/i.exec(s.name)?.[1] ?? (s.outline != null ? Number(s.outline) + 1 : NaN));
    if (!(level >= 1 && level <= 9)) continue;
    const cur = headingStyles[level];
    const use = id => body.styleUse.get(id) ?? 0;
    if (!cur || use(s.id) > use(cur) || (use(s.id) === use(cur) && /^heading \d$/i.test(s.name) && !/^heading \d$/i.test(ctx.styles.get(cur)?.name ?? ''))) headingStyles[level] = s.id;
  }
  return {
    formatProfile: true,
    definitions: { styles: normalise(parts['word/styles.xml']), theme: normalise(parts['word/theme/theme1.xml']), fontTable: normalise(parts['word/fontTable.xml']) },
    numbering: numberingOf(parts['word/numbering.xml']),
    sections, headerFooter: headerFooterOf(parts, sections), runFormats, paragraphFormats, storyFormats, body, headingStyles,
  };
}

const profileOf = x => (x?.formatProfile ? x : formatProfile(x ?? {}));
const DEFINITION_WORDS = { styles: 'the style definitions changed', theme: 'the theme (its colours and fonts) changed', fontTable: 'the font list changed' };

function isVariable(rules, part, index, text) {
  return (rules ?? []).some(r => {
    const rule = typeof r === 'string' || r instanceof RegExp ? { text: r } : r;
    if (rule.part && rule.part !== part && !part.includes(rule.part)) return false;
    if (rule.index != null && rule.index !== index) return false;
    if (rule.text == null) return rule.part != null || rule.index != null;
    return rule.text instanceof RegExp ? rule.text.test(text) : text.includes(rule.text);
  });
}

/**
 * Compare a draft with the firm's file for its kind.
 * @param out   part map or formatProfile of the draft
 * @param base  part map or formatProfile of the firm's file
 * @param opts  { base: file name, variableParagraphs: [{ part?, index?, text? } | string | RegExp], minFontShare?, reference? }
 *   A header or footer line of the base holding a blank or a date is always
 *   variable; variableParagraphs adds others (the lines a fill was asked to
 *   change). `reference` is how the findings name the file compared with
 *   ("the firm's file"; an edit says "the version it was made from").
 * @returns {{ status: 'matches'|'drift', base: string|null, findings: string[], details: Array<{check:string, finding:string}>, notes: string[] }}
 *   notes never change the status: observations below the refusal thresholds.
 */
export function formatGate(out, base, opts = {}) {
  const o = profileOf(out); const b = profileOf(base);
  const ref = opts.reference ?? "the firm's file";
  const details = [];
  const add = (check, finding) => details.push({ check, finding });
  const notes = [];

  for (const key of ['styles', 'theme', 'fontTable']) if (o.definitions[key] !== b.definitions[key]) add('definitions', DEFINITION_WORDS[key]);

  const on = o.numbering; const bn = b.numbering;
  const changedAbstracts = [...bn.abstracts].filter(([id, x]) => on.abstracts.get(id) !== x).length;
  const newAbstracts = [...on.abstracts.keys()].filter(id => !bn.abstracts.has(id)).length;
  const changedNums = [...bn.nums].filter(([id, x]) => on.nums.get(id)?.xml !== x.xml).length;
  if (changedAbstracts || changedNums || on.rest !== bn.rest) add('numbering', 'the numbering definitions changed');
  if (newAbstracts) add('numbering', `${plural(newAbstracts, 'new list format was', 'new list formats were')} added that ${ref} does not have`);
  const badNums = [...on.nums].filter(([id, x]) => {
    if (bn.nums.has(id)) return false;
    const m = /^<w:abstractNumId w:val="(\d+)"\/>((?:<w:lvlOverride w:ilvl="\d"><w:startOverride w:val="\d+"\/><\/w:lvlOverride>)*)$/.exec(x.inner);
    return !m || !bn.abstracts.has(m[1]);
  }).length;
  if (badNums) add('numbering', `${plural(badNums, 'numbered list does', 'numbered lists do')} not follow one of the firm's list formats`);

  if (o.sections.length !== b.sections.length) {
    add('page_setup', `the number of sections changed (${ref} has ${b.sections.length}, this draft has ${o.sections.length}): a section break was added or removed`);
  } else {
    const grouped = new Map();
    const note = (kind, text, i) => { const key = `${kind}\u0000${text}`; grouped.set(key, [...(grouped.get(key) ?? []), i + 1]); };
    b.sections.forEach((bs, i) => {
      const os = o.sections[i];
      if (os.xml === bs.xml) return;
      let explained = false;
      const margins = MARGINS.filter(([k]) => os.pgMar?.[k] !== bs.pgMar?.[k]).map(([k, word]) => `${word} ${bs.pgMar?.[k] == null ? 'none' : cm(bs.pgMar[k])} → ${os.pgMar?.[k] == null ? 'none' : cm(os.pgMar[k])}`);
      if (margins.length) { note('page margin changed', margins.join(', '), i); explained = true; }
      if (bs.pgSz?.w !== os.pgSz?.w || bs.pgSz?.h !== os.pgSz?.h || bs.orient !== os.orient) { note('page size changed', `${bs.pgSz?.name ?? 'none'} → ${os.pgSz?.name ?? 'none'}`, i); explained = true; }
      if (bs.titlePg !== os.titlePg) { note('the different first-page header setting changed', '', i); explained = true; }
      if (JSON.stringify([bs.headerRefs, bs.footerRefs]) !== JSON.stringify([os.headerRefs, os.footerRefs])) { note('the headers or footers it uses changed', '', i); explained = true; }
      if (!explained) note('the page set-up changed', '', i);
    });
    for (const [key, nums] of grouped) {
      const [kind, text] = key.split('\u0000');
      const where = `${nums.length > 1 ? 'sections' : 'section'} ${nums.join(', ')}`;
      add('page_setup', kind.startsWith('page ') ? `${kind} (${where}${text ? `: ${text}` : ''})` : `${where}: ${kind}`);
    }
  }

  for (const [name, bh] of Object.entries(b.headerFooter)) {
    const oh = o.headerFooter[name];
    if (!oh) { add('header_footer', `${bh.label} was removed`); continue; }
    if (oh.xml === bh.xml) continue;
    const rules = opts.variableParagraphs ?? [];
    const variableAt = (i, text) => !!bh.variable?.[i] || isVariable(rules, name, i, text);
    let ok = (rules.length > 0 || !!bh.variable?.some(Boolean)) && oh.paragraphs.length === bh.paragraphs.length && oh.xml.replace(PARAGRAPH, '') === bh.xml.replace(PARAGRAPH, '');
    if (ok) {
      ok = bh.paragraphs.every((bp, i) => {
        const op = oh.paragraphs[i];
        if (op === bp) return true;
        if (!variableAt(i, textOf(bp))) return false;
        const pPr = x => formatKey(/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(x)?.[0] ?? '', 'pPr');
        const runs = new Set(formatsIn(bp, 'rPr'));
        return pPr(op) === pPr(bp) && formatsIn(op, 'rPr').every(k => !k || runs.has(k));
      });
    }
    if (!ok) add('header_footer', `${bh.label} changed`);
  }
  const extra = Object.keys(o.headerFooter).filter(n => !b.headerFooter[n]);
  if (extra.length) add('header_footer', `${plural(extra.length, 'header or footer was', 'headers or footers were')} added that ${ref} does not have`);

  // A paragraph on another list of the same list format as the base
  // paragraph it copies (a restart, allowed above, or another of the base's
  // own lists of that format) has that paragraph's format: only which list
  // it is on differs.
  const listOf = (n, id) => /<w:abstractNumId w:val="(\d+)"\/>/.exec(n.nums.get(id)?.inner ?? '')?.[1];
  const onList = (k, n) => k.replace(/<w:numId w:val="(\d+)"\/>/g, (m, id) => { const a = listOf(n, id); return a == null ? m : `<w:numId w:list="${a}"/>`; });
  let baseOnLists = null;
  const sameList = k => k.includes('<w:numId ') && (baseOnLists ??= new Set([...b.paragraphFormats].map(x => onList(x, bn)))).has(onList(k, on));
  let novelRuns = 0, novelParagraphs = 0, runExample = null, paragraphExample = null;
  for (const f of Object.values(o.storyFormats)) {
    for (const k of f.rPr) if (k && !b.runFormats.has(k)) { novelRuns++; runExample ??= k; }
    for (const k of f.pPr) if (k && !b.paragraphFormats.has(k) && !sameList(k)) { novelParagraphs++; paragraphExample ??= k; }
  }
  if (novelRuns) add('run_format', `${plural(novelRuns, 'piece of text uses', 'pieces of text use')} formatting ${ref} does not have (for example ${describeRun(runExample)})`);
  if (novelParagraphs) add('paragraph_format', `${plural(novelParagraphs, 'paragraph uses', 'paragraphs use')} a paragraph format ${ref} does not have (for example ${describeParagraph(paragraphExample)})`);

  // Fonts and sizes, paragraph by paragraph: each paragraph's text may use
  // only a font and a size the base uses for paragraphs of the same kind
  // (the same style, in or out of the same kind of table; failing any such
  // paragraph, the same style anywhere; failing that, anything the base
  // uses). A fill that only moves the proportions between formats the base
  // already has (long addresses in 10 pt table cells, a deleted 11 pt
  // section) refuses nothing: the share of the main font and size is a
  // note.
  const ob = o.body; const bb = b.body;
  if (ob.chars && bb.kinds) {
    const allowed = p => bb.kinds.contexts.get(p.context) ?? bb.kinds.styles.get(p.style) ?? bb.kinds.all;
    const offFont = new Map(); const offSize = new Map();
    for (const p of ob.paragraphs) {
      const a = allowed(p);
      for (const f of p.fonts.keys()) if (!a.fonts.has(f)) { offFont.set(f, [...(offFont.get(f) ?? []), p]); break; }
      for (const z of p.sizes.keys()) if (!a.sizes.has(z)) { offSize.set(z, [...(offSize.get(z) ?? []), p]); break; }
    }
    for (const [f, ps] of offFont) add('body_font', `${plural(ps.length, 'paragraph is', 'paragraphs are')} in ${f ?? 'a font Word chooses'}, which ${ref} never uses for text of that kind (for example "${ps[0].text}")`);
    for (const [z, ps] of offSize) add('body_size', `${plural(ps.length, 'paragraph is', 'paragraphs are')} in ${z / 2} pt, which ${ref} never uses for text of that kind (for example "${ps[0].text}")`);
  }
  if (ob.chars && bb.font) {
    const share = (ob.fonts.get(bb.font) ?? 0) / ob.chars;
    const need = opts.minFontShare ?? Math.min(0.99, bb.fontShare - 0.01);
    if (share < need) notes.push(`${pct(share)} of the text is in ${bb.font} (${ref} has ${pct(bb.fontShare)})`);
    const offCount = body => body.paragraphs.filter(p => [...p.fonts.keys()].some(f => f !== bb.font)).length;
    const added = offCount(ob) - offCount(bb);
    if (added > 0) notes.push(`${plural(added, 'more paragraph is', 'more paragraphs are')} not in ${bb.font} than in ${ref}`);
    const sizeShare = (ob.sizes.get(bb.sizeHalfPts) ?? 0) / ob.chars;
    if (sizeShare < bb.sizeShare - 0.01) notes.push(`${pct(sizeShare)} of the text is in ${bb.sizeHalfPts / 2} pt (${ref} has ${pct(bb.sizeShare)})`);
  }

  const typed = [...ob.typed].filter(([k, n]) => n > (bb.typed.get(k) ?? 0));
  if (typed.length) {
    const n = typed.reduce((s, [k, c]) => s + c - (bb.typed.get(k) ?? 0), 0);
    add('typed_numbers', `${plural(n, 'paragraph starts', 'paragraphs start')} with a typed clause number instead of Word's numbering (for example "${ob.typedExamples.get(typed[0][0])}")`);
  }

  return { status: details.length ? 'drift' : 'matches', base: opts.base ?? null, findings: details.map(d => d.finding), details, notes, checks: ['definitions', 'numbering', 'page_setup', 'header_footer', 'run_format', 'paragraph_format', 'body_font', 'body_size', 'typed_numbers'] };
}
