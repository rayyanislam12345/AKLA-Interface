// Structure-aware chunking for the index.
//
// The old ingest cut every file into 1,000-word windows joined by single
// spaces: paragraphs, clause numbers and page breaks were gone, and a passage
// could start half-way through one clause and end half-way through the next.
// Here a file is a list of paragraphs ("blocks") with their clause numbers
// and headings; passages are built from whole paragraphs under one clause:
//   - agreements and Word files: paragraphs grouped under their numbered
//     clause or heading, 400-800 tokens, small neighbouring clauses merged,
//     a long clause split at paragraph breaks with a one-paragraph overlap
//     that never crosses into another clause;
//   - PDFs: one passage per page, a long page split at paragraph breaks;
//   - every passage knows its heading path ("Article 14 Termination ›
//     14.2 Termination for convenience"), page, and exact character range in
//     the document text, so content === text.slice(char_start, char_end).
import { createHash } from "node:crypto";

export const TARGET_MIN_TOKENS = 400;
export const TARGET_MAX_TOKENS = 800;
export const OVERLAP_MAX_TOKENS = 120;
const SEPARATOR = "\n\n";
const PATH_SEPARATOR = " › ";
const MAX_ENTRY_CHARS = 90;

/** Rough token count (voyage-law-2 averages ~4 characters a token on English legal text). */
export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

export const textHash = (text) => createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

const capitalise = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

// After a label, a heading or clause text starts with a capital, a quote or a
// bracket — "Schedule A attached hereto" is a sentence, not a heading.
const startsLikeHeading = (rest) => rest === "" || /^[\s.:\-–—―⸺⸻]*["'“‘(\[A-Z0-9]/.test(rest);

/**
 * Recognises a clause number or a structural heading at the start of a paragraph.
 * @returns {null | { kind: 'part'|'article'|'clause'|'sub', depth: number, label: string, rest: string }}
 */
export function parseLabel(text) {
  const t = String(text ?? "").trim();
  let m = /^(PART|Part|CHAPTER|Chapter|SCHEDULE|Schedule|ANNEX(?:URE)?|Annex(?:ure)?|APPENDIX|Appendix|EXHIBIT|Exhibit)(?:\s+|\s*[-–]\s*)([A-Z]{1,3}|[IVXLC]{1,7}|\d{1,3}[A-Z]?)\b(?![.]\d)([\s\S]*)$/.exec(t);
  if (m && t.length <= 200 && startsLikeHeading(m[3])) {
    // Schedule > Part > Chapter > Article: a Part inside a Schedule nests
    // under it, and a statute's Part I holds its Chapters.
    const word = m[1].toLowerCase();
    const depth = word === "part" ? 0.3 : word === "chapter" ? 0.6 : 0;
    return { kind: "part", depth, label: `${capitalise(m[1])} ${m[2]}`, rest: m[3].replace(/^[\s.:\-–—―⸺⸻]+/, "") };
  }
  m = /^(ARTICLE|Article|SECTION|Section|CLAUSE|Clause)\s+(\d{1,4}[A-Z]?(?:\.\d{1,3}){0,3}|[IVXLC]{1,7})\b([\s\S]*)$/.exec(t);
  if (m && (t.length <= 200 || /^\s*[.:\-–—]/.test(m[3])) && startsLikeHeading(m[3])) {
    const dots = (m[2].match(/\./g) ?? []).length;
    return { kind: "article", depth: 1 + dots, label: `${capitalise(m[1])} ${m[2]}`, rest: m[3].replace(/^[\s.:\-–—]+/, "") };
  }
  // "14." / "14.2" / "14.2.3" / "73." followed by text. A bare "14" with no
  // dot is a page number or a figure, not a clause.
  m = /^(\d{1,4}(?:\.\d{1,3}){0,4})(\.?)([ \t]+)([\s\S]*)$/.exec(t);
  if (m) {
    const parts = m[1].split(".");
    const single = parts.length === 1;
    if ((!single || m[2] === ".") && /^["'“‘(\[A-Z]/.test(m[4])) {
      return { kind: "clause", depth: parts.length, label: single ? `${m[1]}.` : m[1], rest: m[4] };
    }
  }
  if (/^\d{1,4}(?:\.\d{1,3}){0,4}\.?$/.test(t) && /\./.test(t)) {
    // A number alone on its line ("14." then the title on the next line).
    const parts = t.replace(/\.$/, "").split(".");
    return { kind: "clause", depth: parts.length, label: parts.length === 1 ? `${parts[0]}.` : parts.join("."), rest: "" };
  }
  m = /^\(([a-z]{1,3}|[ivxlc]{1,6}|\d{1,3}|[A-Z]{1,2})\)([ \t]+[\s\S]*|$)/.exec(t);
  if (m) return { kind: "sub", depth: 9, label: `(${m[1]})`, rest: m[2].trim() };
  return null;
}

/** An unnumbered heading line: short, mostly capitals, no closing punctuation. */
export function isCapsHeading(text) {
  const t = String(text ?? "").trim();
  // Two spaces in a row is a table row laid out in columns, not a heading.
  if (t.length < 4 || t.length > 80 || /[.;,:]$/.test(t) || /\n/.test(t) || / {2,}|\t/.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.85;
}

const looksLikeTitle = (text) => {
  const t = String(text ?? "").trim();
  return t.length > 0 && t.length <= 100 && !/[;,]$/.test(t) && !/\.$/.test(t.replace(/\b(?:etc|Ltd|Co|Inc|No)\.$/, "")) && !/\n/.test(t) && !parseLabel(t);
};

// The title a clause is cited by: a short paragraph is all title; a long one
// may open with a short heading sentence ("Termination for convenience. The
// Agency may…") or a statute's marginal note ("Compensation for loss.—When…").
function titleOf(rest, isHeadingStyle) {
  const t = String(rest ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (isHeadingStyle && t.length <= 200) return t;
  // Statutes' marginal notes: "Compensation for loss.—When…" (also ⸻ and ―).
  const dash = /^(.{3,100}?)(?:\.\s*[—–―⸺⸻-]|\s*[—–―⸺⸻]\s*|:-)/.exec(t);
  if (dash) return dash[1].trim();
  if (t.length <= 100 && !/[;,]$/.test(t) && !/[.:]$/.test(t)) return t;
  const sentence = /^(.{3,60}?)\.\s+[A-Z“"(]/.exec(t);
  if (sentence && sentence[1].split(/\s+/).length <= 8) return sentence[1].trim();
  return "";
}

const entryOf = (label, title) => {
  const entry = [label, title].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return entry.length > MAX_ENTRY_CHARS ? `${entry.slice(0, MAX_ENTRY_CHARS - 1).trimEnd()}…` : entry;
};

/**
 * Lays the blocks out as one text and records each block's range in it.
 * @param {Array<{ text: string, page?: number }>} blocks
 */
export function layout(blocks) {
  let text = "";
  const placed = [];
  for (const block of blocks) {
    const body = String(block.text ?? "").trim();
    if (!body) continue;
    if (text) text += SEPARATOR;
    const start = text.length;
    text += body;
    placed.push({ ...block, text: body, start, end: text.length });
  }
  return { text, blocks: placed };
}

/**
 * Marks clause and heading starts and gives every block its heading path.
 * A block may carry: headingLevel (Word heading style, 0 = Title),
 * heading ({ depth, entry } forced, e.g. "[Slide 3]").
 */
export function assignSections(blocks) {
  const stack = [];
  const out = [];
  const top = () => stack.filter((s) => s.depth <= 1).map((s) => s.entry).join("|");
  let absorbNext = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (absorbNext) {
      // The title line of a label that stood alone ("ARTICLE 14" / "TERMINATION").
      absorbNext = false;
      const owner = out[out.length - 1];
      out.push({ ...block, sectionStart: false, path: owner.path, leaf: owner.leaf, top: owner.top });
      continue;
    }
    let start = null;
    if (block.heading) {
      start = { depth: block.heading.depth, entry: entryOf(block.heading.entry, "") };
    } else {
      const info = parseLabel(block.text);
      const styled = block.headingLevel !== null && block.headingLevel !== undefined;
      if (info && info.kind !== "sub") {
        let title = titleOf(info.rest, styled);
        const next = blocks[i + 1];
        if (!title && !info.rest && next && !next.heading && looksLikeTitle(next.text)) {
          title = next.text.trim();
          absorbNext = true;
        }
        start = { depth: info.depth, entry: entryOf(info.label, title) };
      } else if (styled && !info && block.text.length <= 200) {
        start = { depth: block.headingLevel, entry: entryOf(block.text, "") };
      } else if (!info && isCapsHeading(block.text)) {
        start = { depth: 1, entry: entryOf(block.text.replace(/\s+/g, " ").trim(), "") };
      }
    }
    if (start) {
      const cut = stack.findIndex((s) => s.depth >= start.depth);
      if (cut !== -1) stack.splice(cut);
      stack.push({ ...start, index: out.length });
      out.push({ ...block, sectionStart: true, depth: start.depth, path: stack.map((s) => s.entry), leaf: out.length, top: top() });
    } else {
      out.push({ ...block, sectionStart: false, path: stack.map((s) => s.entry), leaf: stack.length ? stack[stack.length - 1].index : -1, top: top() });
    }
  }
  return out;
}

// Splits one over-long paragraph at sentence ends (then spaces) into ranges.
function splitParagraph(text, start, end) {
  const maxChars = TARGET_MAX_TOKENS * 4;
  const pieces = [];
  let from = start;
  while (end - from > maxChars) {
    const window = text.slice(from, from + maxChars);
    let cut = -1;
    const sentenceEnd = /[.;:?!]["')\]]?\s+/g;
    let m;
    while ((m = sentenceEnd.exec(window)) !== null) {
      if (m.index + m[0].length >= maxChars * 0.5) cut = m.index + m[0].length;
    }
    if (cut === -1) {
      const space = window.lastIndexOf(" ", maxChars - 1);
      cut = space > maxChars * 0.5 ? space + 1 : maxChars;
    }
    let pieceEnd = from + cut;
    while (pieceEnd > from && /\s/.test(text[pieceEnd - 1])) pieceEnd--;
    pieces.push([from, pieceEnd]);
    from = from + cut;
    while (from < end && /\s/.test(text[from])) from++;
  }
  if (from < end) pieces.push([from, end]);
  return pieces;
}

// Groups the blocks of ONE clause (or one page) into passages: whole
// paragraphs up to the target size; the last short paragraph of a passage
// opens the next one (overlap stays inside the clause).
function splitUnit(text, unitBlocks) {
  const ranges = [];
  const atoms = [];
  for (const b of unitBlocks) {
    if (estimateTokens(text.slice(b.start, b.end)) > TARGET_MAX_TOKENS) {
      for (const [s, e] of splitParagraph(text, b.start, b.end)) atoms.push({ ...b, start: s, end: e, split: true });
    } else atoms.push(b);
  }
  let i = 0;
  while (i < atoms.length) {
    let j = i;
    let endAt = atoms[i].end;
    while (j + 1 < atoms.length && estimateTokens(text.slice(atoms[i].start, atoms[j + 1].end)) <= TARGET_MAX_TOKENS) {
      j++;
      endAt = atoms[j].end;
    }
    ranges.push({ start: atoms[i].start, end: endAt, first: atoms[i], last: atoms[j] });
    if (j + 1 >= atoms.length) break;
    const tail = atoms[j];
    const overlap = j > i && !tail.split && estimateTokens(text.slice(tail.start, tail.end)) <= OVERLAP_MAX_TOKENS;
    i = overlap ? j : j + 1;
  }
  // A last piece of a few words joins the one before it.
  if (ranges.length > 1) {
    const tail = ranges[ranges.length - 1];
    const prev = ranges[ranges.length - 2];
    if (estimateTokens(text.slice(tail.start, tail.end)) < 60 && estimateTokens(text.slice(prev.start, tail.end)) <= TARGET_MAX_TOKENS * 1.15) {
      ranges.splice(-2, 2, { start: prev.start, end: tail.end, first: prev.first, last: tail.last });
    }
  }
  return ranges;
}

const commonPrefix = (a, b) => {
  const out = [];
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) out.push(a[i]);
  return out;
};

const shortLabel = (entry) => (/^(?:\(?[\w.]+\)?|(?:Article|Section|Clause|Schedule|Part|Chapter|Annex(?:ure)?|Appendix|Exhibit) [\w.]+)/.exec(entry)?.[0] ?? entry);

// The heading path of a passage. One clause: its path. Several: the shared
// path, then the first and last clause ("Art 14 › 14.1 Notice – 14.3").
function pathOf(rangeBlocks) {
  if (!rangeBlocks.length) return "";
  const first = rangeBlocks[0];
  const last = rangeBlocks[rangeBlocks.length - 1];
  if (rangeBlocks.every((b) => b.leaf === first.leaf)) return first.path.join(PATH_SEPARATOR);
  // Headings leading into one clause ("2. Termination", "2.1 …", then 2.1.1's text): that clause's path.
  const deepest = rangeBlocks.reduce((d, b) => (b.path.length > d.path.length ? b : d), first);
  const isPrefix = (p, of) => p.length <= of.length && p.every((e, k) => e === of[k]);
  if (rangeBlocks.every((b) => isPrefix(b.path, deepest.path))) return deepest.path.join(PATH_SEPARATOR);
  const shared = rangeBlocks.reduce((acc, b) => commonPrefix(acc, b.path), first.path);
  const opener = rangeBlocks.find((b) => b.path.length > shared.length);
  const a = opener?.path[shared.length];
  const b = last.path.length > shared.length ? last.path[last.path.length - 1] : null;
  const tail = a && b && a !== b ? `${a} – ${shortLabel(b)}` : (a ?? b ?? "");
  return [...shared, tail].filter(Boolean).join(PATH_SEPARATOR);
}

// Passages never merge across an Article, a top-level clause or a Schedule (depth <= 1).
const topKey = (block) => block.top ?? "";

/**
 * Builds the passages for a document.
 * @param {Array<{ text: string, page?: number, headingLevel?: number|null, heading?: { depth: number, entry: string } }>} rawBlocks
 * @param {{ mode?: 'structure'|'page' }} [options] page = one passage per page (PDFs)
 * @returns {{ text: string, chunks: Array<{ index: number, content: string, start: number, end: number, page: number|null, pageEnd: number|null, headingPath: string|null, tokens: number }> }}
 */
export function chunkDocument(rawBlocks, { mode = "structure" } = {}) {
  const { text, blocks: placed } = layout(rawBlocks);
  const blocks = assignSections(placed);
  const units = [];
  for (const b of blocks) {
    const key = mode === "page" ? `p${b.page ?? 0}` : `s${b.leaf}`;
    const last = units[units.length - 1];
    if (last && last.key === key) last.blocks.push(b);
    else units.push({ key, blocks: [b] });
  }

  const ranges = [];
  let pending = null; // small units waiting to be merged with the next
  const flush = () => {
    if (pending) ranges.push({ start: pending.start, end: pending.end, first: pending.first, last: pending.last });
    pending = null;
  };
  const tokensOf = (a, b) => estimateTokens(text.slice(a, b));
  for (const unit of units) {
    let unitBlocks = unit.blocks;
    const first = unitBlocks[0];
    const sameTop = pending && (mode === "page" || topKey(pending.first) === topKey(first));
    const end = unitBlocks[unitBlocks.length - 1].end;
    if (tokensOf(first.start, end) > TARGET_MAX_TOKENS) {
      // A heading standing alone ("1.2 Construction") opens the long clause
      // that follows it rather than becoming a passage of four words.
      if (pending && sameTop && tokensOf(pending.start, pending.end) <= OVERLAP_MAX_TOKENS) {
        unitBlocks = [...pending.blocks, ...unitBlocks];
        pending = null;
      }
      flush();
      for (const r of splitUnit(text, unitBlocks)) ranges.push(r);
      continue;
    }
    const last = unitBlocks[unitBlocks.length - 1];
    const pendingTokens = pending ? tokensOf(pending.start, pending.end) : 0;
    const small = mode === "page" ? pendingTokens < 60 : pendingTokens < TARGET_MIN_TOKENS;
    if (pending && sameTop && small && tokensOf(pending.start, end) <= TARGET_MAX_TOKENS) {
      pending = { ...pending, end, last, blocks: [...pending.blocks, ...unitBlocks] };
    } else {
      flush();
      pending = { start: first.start, end, first, last, blocks: unitBlocks };
    }
  }
  flush();

  const chunks = ranges.map((r, index) => {
    const content = text.slice(r.start, r.end);
    const headingPath = pathOf(blocks.filter((b) => b.end > r.start && b.start < r.end));
    return {
      index,
      content,
      start: r.start,
      end: r.end,
      page: r.first.page ?? null,
      pageEnd: r.last.page ?? r.first.page ?? null,
      headingPath: headingPath || null,
      tokens: estimateTokens(content),
    };
  });
  return { text, chunks, outline: blocks.filter((b) => b.sectionStart).map((b) => ({ depth: b.depth, entry: b.path[b.path.length - 1], page: b.page ?? null })) };
}

/**
 * The line prepended to a passage before it is embedded (never stored in
 * content): it tells the embedding which document, version, type, project and
 * clause the words belong to.
 */
export function contextualHeader({ title, versionNumber, typeName, projectName, headingPath, page }) {
  const about = [typeName, projectName].filter(Boolean).join(", ");
  let header = `Document: ${title || "Untitled"}${versionNumber ? ` v${versionNumber}` : ""}${about ? ` (${about})` : ""}`;
  if (headingPath) header += `${PATH_SEPARATOR}${headingPath}`;
  if (page) header += `${PATH_SEPARATOR}p. ${page}`;
  return header;
}

export const embeddingInput = (header, content) => `${header}\n\n${content}`;
