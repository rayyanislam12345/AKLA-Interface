// A Word reader for the index: paragraphs in order, each with the clause
// number Word would show, its style, and its heading level.
//
// mammoth (what the chat path uses) drops Word's automatic numbering, and in
// the firm's agreements that numbering IS the clause number: the concession
// master's "Definitions & Interpretation" heading is Heading 1 numbered by
// its style ("1."), its sub-clauses "%1.%2", its lists "(a)". Without it a
// passage cannot be cited as "cl. 14.2". So this reads document.xml directly
// and computes the numbers from numbering.xml and styles.xml.
//
// Tracked changes: the index sees the document as if every revision were
// accepted (insertions kept, deletions and moved-from text dropped), and the
// result says whether the file carries revisions so the card can say so.
// Headers, footers, comments and footnotes are read into side fields, not
// into the body text.
import { unzipSync, strFromU8 } from "fflate";

const decodeEntities = (value) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, "&");

const attr = (attrs, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs ?? "");
  return m ? decodeEntities(m[1]) : undefined;
};

// Elements whose contents are not part of the accepted text, or duplicate it.
const SKIP = new Set([
  "w:del", "w:moveFrom", "w:delText", "w:instrText", "w:delInstrText",
  "mc:Fallback", "w:pPrChange", "w:rPrChange", "w:sectPrChange", "w:tblPrChange",
  "w:trPrChange", "w:tcPrChange", "w:numberingChange", "w:footnoteReference",
  "w:endnoteReference", "w:commentReference",
]);

/**
 * Walks WordprocessingML and returns its paragraphs.
 * @param {string} xml
 * @returns {{ paragraphs: Array<{ text: string, styleId?: string, numId?: string, ilvl?: number, outlineLvl?: number, inTable: boolean }>, revisions: number }}
 */
export function readParagraphs(xml) {
  const paragraphs = [];
  const stack = []; // open paragraphs (text boxes nest a paragraph in a run)
  let skipDepth = 0;
  let inT = false;
  let pPrDepth = 0;
  let tableDepth = 0;
  let revisions = 0;
  const re = /<(\/?)([A-Za-z][\w.-]*:[\w.-]+|[A-Za-z][\w.-]*)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, closing, name, attrs, selfClosing, text] = m;
    if (text !== undefined) {
      if (inT && skipDepth === 0 && stack.length) stack[stack.length - 1].parts.push(decodeEntities(text));
      continue;
    }
    if (name === "w:ins" || name === "w:del" || name === "w:moveTo" || name === "w:moveFrom") {
      if (!closing) revisions++;
    }
    if (SKIP.has(name)) {
      if (selfClosing) continue;
      skipDepth += closing ? -1 : 1;
      if (skipDepth < 0) skipDepth = 0;
      continue;
    }
    if (skipDepth > 0) continue;
    const current = stack[stack.length - 1];
    switch (name) {
      case "w:p":
        if (selfClosing) {
          paragraphs.push({ text: "", inTable: tableDepth > 0 });
        } else if (!closing) {
          stack.push({ parts: [], inTable: tableDepth > 0 });
        } else {
          const done = stack.pop();
          if (done) {
            paragraphs.push({
              text: done.parts.join("").replace(/[  ]+/g, " ").replace(/ *\n */g, "\n").trim(),
              styleId: done.styleId, numId: done.numId, ilvl: done.ilvl, outlineLvl: done.outlineLvl, inTable: done.inTable,
            });
          }
        }
        break;
      case "w:pPr":
        if (!selfClosing) pPrDepth += closing ? -1 : 1;
        break;
      case "w:pStyle":
        if (current && pPrDepth > 0) current.styleId = attr(attrs, "w:val");
        break;
      case "w:numId":
        if (current && pPrDepth > 0) current.numId = attr(attrs, "w:val");
        break;
      case "w:ilvl":
        if (current && pPrDepth > 0) current.ilvl = Number(attr(attrs, "w:val") ?? 0);
        break;
      case "w:outlineLvl":
        if (current && pPrDepth > 0) current.outlineLvl = Number(attr(attrs, "w:val"));
        break;
      case "w:t":
        inT = !closing && !selfClosing;
        break;
      case "w:tab":
        if (current && pPrDepth === 0 && !closing) current.parts.push("\t");
        break;
      case "w:br":
      case "w:cr":
        if (current && !closing) current.parts.push("\n");
        break;
      case "w:noBreakHyphen":
        if (current && !closing) current.parts.push("-");
        break;
      case "w:tbl":
        if (!selfClosing) tableDepth += closing ? -1 : 1;
        break;
      case "w:tc":
        // Cells of a row read left to right on one line in the paragraph text.
        break;
      default:
        break;
    }
  }
  return { paragraphs, revisions };
}

/** styles.xml -> styleId -> { name, basedOn, numId, ilvl, outlineLvl } */
export function readStyles(xml) {
  const styles = new Map();
  for (const m of String(xml ?? "").matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(m[1], "w:styleId");
    if (!id) continue;
    const body = m[2];
    const numPr = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(body)?.[1] ?? "";
    styles.set(id, {
      type: attr(m[1], "w:type"),
      name: attr(/<w:name\b([^>]*)\/>/.exec(body)?.[1], "w:val") ?? id,
      basedOn: attr(/<w:basedOn\b([^>]*)\/>/.exec(body)?.[1], "w:val"),
      numId: attr(/<w:numId\b([^>]*)\/>/.exec(numPr)?.[1], "w:val"),
      ilvl: (() => { const v = attr(/<w:ilvl\b([^>]*)\/>/.exec(numPr)?.[1], "w:val"); return v === undefined ? undefined : Number(v); })(),
      outlineLvl: (() => { const v = attr(/<w:outlineLvl\b([^>]*)\/>/.exec(body)?.[1], "w:val"); return v === undefined ? undefined : Number(v); })(),
    });
  }
  return styles;
}

function readLevels(xml) {
  const levels = {};
  for (const m of xml.matchAll(/<w:lvl\b([^>]*)>([\s\S]*?)<\/w:lvl>/g)) {
    const ilvl = Number(attr(m[1], "w:ilvl") ?? 0);
    const body = m[2];
    levels[ilvl] = {
      start: Number(attr(/<w:start\b([^>]*)\/>/.exec(body)?.[1], "w:val") ?? 1),
      numFmt: attr(/<w:numFmt\b([^>]*)\/>/.exec(body)?.[1], "w:val") ?? "decimal",
      lvlText: attr(/<w:lvlText\b([^>]*)\/>/.exec(body)?.[1], "w:val") ?? "",
      pStyle: attr(/<w:pStyle\b([^>]*)\/>/.exec(body)?.[1], "w:val"),
      isLgl: /<w:isLgl\b(?![^>]*w:val="(?:0|false)")/.test(body),
    };
  }
  return levels;
}

/** numbering.xml -> { abstracts, nums } */
export function readNumbering(xml) {
  const abstracts = new Map();
  const nums = new Map();
  const src = String(xml ?? "");
  for (const m of src.matchAll(/<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g)) {
    const id = attr(m[1], "w:abstractNumId");
    abstracts.set(id, {
      levels: readLevels(m[2]),
      numStyleLink: attr(/<w:numStyleLink\b([^>]*)\/>/.exec(m[2])?.[1], "w:val"),
    });
  }
  for (const m of src.matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g)) {
    const id = attr(m[1], "w:numId");
    const overrides = {};
    for (const o of m[2].matchAll(/<w:lvlOverride\b([^>]*)>([\s\S]*?)<\/w:lvlOverride>/g)) {
      const ilvl = Number(attr(o[1], "w:ilvl") ?? 0);
      const start = attr(/<w:startOverride\b([^>]*)\/>/.exec(o[2])?.[1], "w:val");
      const lvl = readLevels(o[2])[ilvl];
      overrides[ilvl] = { startOverride: start === undefined ? undefined : Number(start), lvl };
    }
    nums.set(id, { abstractNumId: attr(/<w:abstractNumId\b([^>]*)\/>/.exec(m[2])?.[1], "w:val"), overrides });
  }
  return { abstracts, nums };
}

const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
function roman(n) {
  let out = "";
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}
function letters(n) {
  // Word's letter numbering repeats the letter: a..z, aa..zz, aaa...
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}
export function formatNumber(n, fmt) {
  switch (fmt) {
    case "lowerLetter": return letters(n);
    case "upperLetter": return letters(n).toUpperCase();
    case "lowerRoman": return roman(n);
    case "upperRoman": return roman(n).toUpperCase();
    case "decimalZero": return n < 10 ? `0${n}` : String(n);
    case "ordinal": return `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] ?? "th"}`;
    case "bullet":
    case "none":
      return "";
    default: return String(n);
  }
}

/**
 * Computes the number Word shows for each paragraph.
 * Counters are kept per abstract list (Word continues a list across w:num
 * instances that share one), restarted by a startOverride the first time a
 * num instance is used, and deeper levels reset when a shallower one moves.
 */
export function makeNumberer(numbering, styles) {
  const counters = new Map(); // abstractId -> number[]
  const seenNum = new Set();

  const styleChain = (styleId) => {
    const chain = [];
    let id = styleId;
    for (let i = 0; id && i < 10; i++) {
      const s = styles.get(id);
      if (!s) break;
      chain.push(s);
      id = s.basedOn;
    }
    return chain;
  };

  const resolveAbstract = (numId) => {
    const num = numbering.nums.get(numId);
    if (!num) return null;
    let abstractId = num.abstractNumId;
    let abstract = numbering.abstracts.get(abstractId);
    // A list defined by a numbering style points at that style's own list.
    for (let hops = 0; abstract?.numStyleLink && hops < 3; hops++) {
      const linked = styles.get(abstract.numStyleLink);
      const linkedNum = linked?.numId ? numbering.nums.get(linked.numId) : null;
      if (!linkedNum) break;
      abstractId = linkedNum.abstractNumId;
      abstract = numbering.abstracts.get(abstractId);
    }
    return abstract ? { num, abstractId, abstract } : null;
  };

  return function numberFor(paragraph) {
    let numId = paragraph.numId;
    let ilvl = paragraph.ilvl;
    if (numId === undefined) {
      for (const s of styleChain(paragraph.styleId)) {
        if (s.numId !== undefined) { numId = s.numId; if (ilvl === undefined) ilvl = s.ilvl; break; }
      }
    }
    if (numId === undefined || numId === "0") return "";
    const found = resolveAbstract(numId);
    if (!found) return "";
    const { num, abstractId, abstract } = found;
    if (ilvl === undefined) {
      const byStyle = Object.entries(abstract.levels).find(([, l]) => l.pStyle && l.pStyle === paragraph.styleId);
      ilvl = byStyle ? Number(byStyle[0]) : 0;
    }
    const levelDef = (i) => num.overrides[i]?.lvl ?? abstract.levels[i];
    const def = levelDef(ilvl);
    if (!def) return "";
    const values = counters.get(abstractId) ?? [];
    const key = `${numId}:${ilvl}`;
    const override = num.overrides[ilvl]?.startOverride;
    if (override !== undefined && !seenNum.has(key)) values[ilvl] = override;
    else values[ilvl] = values[ilvl] === undefined ? def.start : values[ilvl] + 1;
    seenNum.add(key);
    values.length = ilvl + 1; // deeper levels start again
    counters.set(abstractId, values);
    if (def.numFmt === "bullet" || def.numFmt === "none") return "";
    return def.lvlText.replace(/%(\d)/g, (_, d) => {
      const i = Number(d) - 1;
      const ld = levelDef(i);
      const n = values[i] ?? ld?.start ?? 1;
      return formatNumber(n, def.isLgl ? "decimal" : (ld?.numFmt ?? "decimal"));
    }).trim();
  };
}

function headingLevelOf(paragraph, styles) {
  let id = paragraph.styleId;
  if (paragraph.outlineLvl !== undefined && paragraph.outlineLvl < 9) return paragraph.outlineLvl + 1;
  for (let i = 0; id && i < 10; i++) {
    const s = styles.get(id);
    if (!s) break;
    const name = String(s.name ?? "").toLowerCase();
    if (name === "title") return 0;
    const h = /^heading\s*(\d)$/.exec(name);
    if (h) return Number(h[1]);
    if (s.outlineLvl !== undefined && s.outlineLvl < 9) return s.outlineLvl + 1;
    id = s.basedOn;
  }
  return null;
}

function styleName(paragraph, styles) {
  return styles.get(paragraph.styleId)?.name ?? paragraph.styleId ?? "";
}

function sideText(xml) {
  return readParagraphs(xml).paragraphs.map((p) => p.text).filter(Boolean).join("\n");
}

/**
 * Reads a .docx for the index.
 * @param {Uint8Array} bytes
 * @returns {{ blocks: Array<{ text: string, label: string, headingLevel: number|null, style: string, listLevel: number|null }>, side: { headers: string[], footers: string[], comments: Array<{ author: string, text: string }>, footnotes: string[] }, hasTrackedChanges: boolean, revisionCount: number }}
 */
export function readDocx(bytes) {
  const wanted = /^word\/(document\.xml|styles\.xml|numbering\.xml|comments\.xml|footnotes\.xml|endnotes\.xml|header\d*\.xml|footer\d*\.xml)$/;
  let entries;
  try {
    entries = unzipSync(bytes, { filter: (f) => wanted.test(f.name) });
  } catch {
    const err = new Error("This Word file is damaged or is not really a .docx (it may be an old .doc renamed, or password-protected).");
    err.permanent = true;
    throw err;
  }
  const part = (name) => (entries[name] ? strFromU8(entries[name]) : "");
  const documentXml = part("word/document.xml");
  if (!documentXml) {
    const err = new Error("This Word file has no document body. It may be password-protected or damaged.");
    err.permanent = true;
    throw err;
  }
  const styles = readStyles(part("word/styles.xml"));
  const numbering = readNumbering(part("word/numbering.xml"));
  const numberFor = makeNumberer(numbering, styles);
  const { paragraphs, revisions } = readParagraphs(documentXml);

  const blocks = [];
  for (const p of paragraphs) {
    const style = styleName(p, styles);
    // The contents page repeats every heading; it is navigation, not text.
    if (/^toc\s*\d|^table of contents/i.test(style) || /^TOC\d/.test(p.styleId ?? "")) continue;
    const label = p.text ? numberFor(p) : "";
    if (!p.text) continue;
    const headingLevel = headingLevelOf(p, styles);
    blocks.push({
      text: label ? `${label} ${p.text}` : p.text,
      label,
      headingLevel,
      style,
      listLevel: label && headingLevel === null ? (p.ilvl ?? 0) : null,
      inTable: p.inTable,
    });
  }

  const names = Object.keys(entries);
  const comments = [];
  for (const m of part("word/comments.xml").matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const text = sideText(m[2]);
    if (text) comments.push({ author: attr(m[1], "w:author") ?? "", text });
  }
  const unique = (list) => [...new Set(list.filter(Boolean))];
  const footnotes = [];
  for (const file of ["word/footnotes.xml", "word/endnotes.xml"]) {
    for (const m of part(file).matchAll(/<w:(?:footnote|endnote)\b([^>]*)>([\s\S]*?)<\/w:(?:footnote|endnote)>/g)) {
      if (/w:type="(?:separator|continuationSeparator|continuationNotice)"/.test(m[1])) continue;
      const text = sideText(m[2]);
      if (text) footnotes.push(text);
    }
  }
  return {
    blocks,
    side: {
      headers: unique(names.filter((n) => /^word\/header\d*\.xml$/.test(n)).sort().map((n) => sideText(part(n)))),
      footers: unique(names.filter((n) => /^word\/footer\d*\.xml$/.test(n)).sort().map((n) => sideText(part(n)))),
      comments,
      footnotes,
    },
    hasTrackedChanges: revisions > 0,
    revisionCount: revisions,
  };
}
