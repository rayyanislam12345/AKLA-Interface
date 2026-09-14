// Editing a Word file as a Word file.
//
// The AI never rebuilds a document from text. It reads the paragraphs of the
// real .docx, says which ones to change, and those changes are written into
// that same file as Word tracked changes — so styles, numbering, tables,
// headers and footers, footnotes, fonts and every paragraph the model did
// not touch come out exactly as they went in. What the lawyer opens in Word
// is their own document with a redline on it.
//
// The changes are made directly in the document's XML: a replacement becomes
// a <w:del> of the words that differ and a <w:ins> of the new ones, keeping
// the run properties of the text around them; a new paragraph is a <w:p>
// cloned from its anchor and marked inserted; a deletion strikes the
// paragraph's runs through and marks its paragraph mark deleted.
// @ansonlai/docx-redline-js is kept only as a fallback for a paragraph whose
// markup this cannot safely account for: it re-parses and re-serialises the
// whole document per operation, which on the firm's standard Concession
// Agreement (4,101 paragraphs) took ten minutes for thirteen changes.
//
// The model speaks a small protocol (OPS_PROTOCOL): every paragraph is shown
// as "¶<n>" — its position in the file — and it answers with operations
// against those numbers.
import { DOMParser } from "@xmldom/xmldom";
import { createHash } from "node:crypto";
import { inspectPackage, compareFormat } from "./docxChecks.js";
import { unzipSync, zipSync } from "fflate";
import { openDocx } from "@ansonlai/docx-redline-js/node";

export const DOCX_AUTHOR = "AKLA AI";
// Remarks for the reader go in the margin under this name, never in the text.
export const COMMENT_AUTHOR = "AKLA Comments";
// How much of a document is shown at once. Beyond this the listing is
// focused on what the turn is actually about (see focusParagraphs).
export const MAX_LISTING_CHARS = 120_000;

export const OPS_PROTOCOL = `HOW TO CHANGE THE DOCUMENT. The document is a real Word file and every change you make is applied to that file as a tracked change; nothing is retyped or reformatted. Each paragraph above is numbered ¶n. When you are ready to change it, end your reply with ONE fenced block:
\`\`\`json
{"ops": [
  {"op": "replace", "p": 12, "expected": "Exact current paragraph text", "text": "The full new text of paragraph ¶12."},
  {"op": "insert_after", "p": 12, "expected": "Exact current anchor text", "text": "One new paragraph, placed after ¶12."},
  {"op": "delete", "p": 14, "expected": "Exact current paragraph text"},
  {"op": "comment", "p": 15, "expected": "Exact current paragraph text", "text": "The Firm notes that the concession period is not yet fixed."}
]}
\`\`\`
Rules:
- If you need a section hidden by a gap, emit {"read":[{"from":100,"to":140}]} in the JSON block instead of ops. The document reader will return those paragraphs and you can continue. Request at most 200 paragraphs at once.
- Every operation must include "expected": the exact current text of that paragraph, without the ¶ label. Never operate on a paragraph that was not shown.
- "replace" gives the COMPLETE new text of that one paragraph, copied from above with your change made in it. Word shows only the words that differ, so keep everything you are not changing exactly as it is — same wording, same spacing, same defined terms. One paragraph per op; never merge or split paragraphs.
- "insert_after" adds exactly one paragraph; use several ops (same "p", in reading order) for several paragraphs. The new paragraph takes the formatting and numbering of ¶p, so anchor a clause on a body paragraph and a heading on a heading. Start the text with "# ", "## " or "### " to make it a heading of that level instead.
- Never type clause numbers — Word numbers headings and list items itself.
- "comment" puts a Word margin comment, titled "AKLA Comments", on that paragraph and leaves its text as it is. Outstanding matters, gaps, figures to confirm and remarks for the reader go in comments — never into the document's text, and never as footnotes or an end section. A paragraph may take a change and a comment in the same turn.
- **bold** marks a defined term; use no other markup.
- Change only what the instruction requires. Everything not listed stays exactly as it is.
- Before the block, write two or three sentences for the lawyer saying what you changed and anything you could not do. If you need more information first, ask, and send no block.`;

const dec = new TextDecoder();
const enc = new TextEncoder();
const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decodeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
const child = (xml, tag) => new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`).exec(xml)?.[0];
const attr = (xml, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];

function readZip(bytes) {
  const entries = unzipSync(bytes);
  if (!entries["word/document.xml"]) throw new Error("Not a Word file (no word/document.xml)");
  return entries;
}
const writeZip = (entries) => zipSync(entries, { level: 6 });

// Every w:t in the paragraph that a reader would see: what is inside a
// tracked deletion is struck through and does not count.
function visibleText(pXml) {
  const inner = pXml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "");
  let out = "";
  for (const m of inner.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
    out += m[0] === "<w:tab/>" ? "\t" : m[0] === "<w:br/>" ? "\n" : decodeXml(m[1]);
  }
  return out;
}

// styleId → heading level (from the style's name, "heading 1", or its
// outline level), plus the style to use for each level when adding one.
function headingStyles(stylesXml) {
  const map = new Map();
  const byLevel = new Map();
  for (const m of (stylesXml ?? "").matchAll(/<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = attr(child(m[2], "w:name") ?? "", "w:val") ?? "";
    const named = /^heading (\d)$/i.exec(name)?.[1];
    const outline = attr(child(m[2], "w:outlineLvl") ?? "", "w:val");
    const level = named ? Number(named) : outline !== undefined ? Number(outline) + 1 : null;
    if (!level) continue;
    map.set(m[1], level);
    if (named || !byLevel.has(level)) byLevel.set(level, m[1]);
  }
  return { map, byLevel };
}

// Every paragraph of the body in document order, with the number the model
// uses, whether it sits in a table, and its heading level.
function enumerateParagraphs(documentXml, headings) {
  const paras = [];
  let depth = 0;
  let ordinal = 0;
  const seen = new Map(); // text → count so far, to address duplicates
  for (const m of documentXml.matchAll(/<w:tbl>|<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const tok = m[0];
    if (tok === "<w:tbl>") { depth++; continue; }
    if (tok === "</w:tbl>") { depth--; continue; }
    ordinal++;
    const text = tok.endsWith("/>") ? "" : visibleText(tok);
    const styleId = attr(child(child(tok, "w:pPr") ?? "", "w:pStyle") ?? "", "w:val");
    const occurrence = (seen.get(text) ?? 0) + 1;
    seen.set(text, occurrence);
    paras.push({ index: ordinal, start: m.index, end: m.index + tok.length, text, styleId, headingLevel: styleId ? headings.map.get(styleId) : undefined, inTable: depth > 0, occurrence });
  }
  return paras;
}

// A blank waiting to be filled: the firm's [●] and [•], anything in square
// brackets, and a run of underscores.
const PLACEHOLDER = /\[[^\]\n]{0,120}\]|_{3,}/;

// Which paragraphs to show when the whole document will not fit, or when the
// job only concerns part of it. Headings always go in, so the model can see
// the shape of the document; around each paragraph that matters its
// neighbours go in too, so a clause is never shown out of context.
function focusParagraphs(paras, { placeholders, query, budget }) {
  const keep = new Set();
  const words = new Set((query ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 4));
  const hits = [];
  paras.forEach((p, i) => {
    if (!p.text.trim()) return;
    if (p.headingLevel) keep.add(i);
    const matches = placeholders
      ? PLACEHOLDER.test(p.text)
      : words.size > 0 && [...words].some((w) => p.text.toLowerCase().includes(w));
    if (matches) hits.push(i);
  });
  for (const i of hits) for (let k = Math.max(0, i - 1); k <= Math.min(paras.length - 1, i + 1); k++) keep.add(k);
  // Spend what is left of the budget on the paragraphs nearest the ones that
  // matter, so a document only a little over the line is still shown whole.
  let chars = [...keep].reduce((n, i) => n + paras[i].text.length + 8, 0);
  for (let ring = 2; ring < 40 && chars < budget; ring++) {
    for (const i of hits) {
      for (const k of [i - ring, i + ring]) {
        if (k < 0 || k >= paras.length || keep.has(k) || !paras[k].text.trim()) continue;
        if (chars + paras[k].text.length > budget) continue;
        keep.add(k);
        chars += paras[k].text.length + 8;
      }
    }
  }
  return keep;
}

/**
 * Reads the file's paragraphs. `listing` is what the model sees; `byRef` is
 * what its operations resolve against — always every paragraph, even when
 * the listing shows only part of the document.
 */
function inspectPart(bytes, opts = {}) {
  const entries = readZip(bytes);
  const documentXml = dec.decode(entries["word/document.xml"]);
  const headings = headingStyles(entries["word/styles.xml"] ? dec.decode(entries["word/styles.xml"]) : "");
  const paras = enumerateParagraphs(documentXml, headings);
  const byRef = new Map();
  for (const p of paras) {
    if (!p.text.trim()) continue;
    byRef.set(p.index, { index: p.index, exactText: p.text, occurrence: p.occurrence, inTable: p.inTable, headingLevel: p.headingLevel });
  }

  const budget = opts.budget ?? MAX_LISTING_CHARS;
  const full = [...byRef.values()].reduce((n, p) => n + p.exactText.length + 8, 0);
  const focused = opts.placeholders || (full > budget && opts.query)
    ? focusParagraphs(paras, { placeholders: opts.placeholders, query: opts.query, budget })
    : null;

  const lines = [];
  let shown = 0;
  let hidden = 0;
  let chars = 0;
  paras.forEach((p, i) => {
    if (!p.text.trim()) return;
    if ((focused && !focused.has(i)) || chars + p.text.length + 40 > budget) {
      hidden++;
      return;
    }
    if (hidden) {
      lines.push(`   … ${hidden} paragraph${hidden === 1 ? "" : "s"} not shown …`);
      hidden = 0;
    }
    const line = `¶${p.index}${p.headingLevel ? ` [H${p.headingLevel}]` : ""}${p.inTable ? " [table]" : ""} ${p.text}`;
    lines.push(line);
    chars += line.length + 1;
    byRef.get(p.index).shown = true;
    shown++;
  });
  if (hidden) lines.push(`   … ${hidden} paragraph${hidden === 1 ? "" : "s"} not shown …`);

  return { listing: lines.join("\n"), byRef, paragraphCount: byRef.size, shown, partial: shown < byRef.size };
}

// Pulls the model's operations out of its reply. The last fenced json block
// wins; the prose before it is what the lawyer reads.
export function extractOps(reply) {
  const blocks = [...reply.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return { prose: reply.trim(), ops: null };
  const last = blocks[blocks.length - 1];
  let parsed;
  try {
    parsed = JSON.parse(last[1]);
  } catch {
    return { prose: reply.replace(last[0], "").trim(), ops: null, parseError: true };
  }
  const ops = Array.isArray(parsed?.ops) ? parsed.ops : Array.isArray(parsed) ? parsed : null;
  const reads = Array.isArray(parsed?.read) ? parsed.read : null;
  return { prose: reply.replace(last[0], "").trim(), ops, reads, parseError: !ops && !reads };
}

// ---------------------------------------------------------------- markup

function revisionStamps(documentXml) {
  let max = 9000;
  for (const m of documentXml.matchAll(/<w:(?:ins|del|moveFrom|moveTo)\s[^>]*w:id="(\d+)"/g)) max = Math.max(max, Number(m[1]));
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return (author = DOCX_AUTHOR) => `w:id="${++max}" w:author="${escapeXml(author)}" w:date="${date}"`;
}

// The children of a paragraph, in order: its runs (with their formatting and
// their text), the revision and hyperlink containers whose own children are
// runs, and everything else — bookmarks, comment anchors, spell-check marks
// — carried through untouched.
function tokenize(xml) {
  const items = [];
  const re = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>|<w:(ins|del|hyperlink|smartTag)(\s[^>]*)?>([\s\S]*?)<\/w:\1>|<w:r(?:\s[^>]*)?\/>/g;
  let at = 0;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m.index > at) items.push({ kind: "raw", xml: xml.slice(at, m.index) });
    at = m.index + m[0].length;
    if (m[1]) {
      items.push({ kind: m[1], open: `<w:${m[1]}${m[2] ?? ""}>`, close: `</w:${m[1]}>`, items: tokenize(m[3]) });
    } else if (m[0].endsWith("/>")) {
      items.push({ kind: "raw", xml: m[0] });
    } else {
      const rPr = child(m[0], "w:rPr") ?? "";
      let text = "";
      // Tabs and breaks read as text and are put back as themselves when a
      // run is split. Anything else — a footnote mark, a symbol, a field, a
      // picture — has no text this can slice around, so a run carrying one
      // can be moved or struck out whole but never cut in half.
      let splittable = true;
      for (const t of m[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:(drawing|pict|object|fldChar|instrText|footnoteReference|endnoteReference|noBreakHyphen|sym|softHyphen)\b/g)) {
        if (t[0] === "<w:tab/>") text += "\t";
        else if (t[0] === "<w:br/>") text += "\n";
        else if (t[2]) splittable = false;
        else text += decodeXml(t[1]);
      }
      items.push({ kind: "run", xml: m[0], rPr, text, splittable });
    }
  }
  if (at < xml.length) items.push({ kind: "raw", xml: xml.slice(at) });
  return items;
}

const serialize = (items) =>
  items.map((it) => (it.kind === "raw" || it.kind === "run" ? it.xml : `${it.open}${serialize(it.items)}${it.close}`)).join("");

// The runs a reader sees, flattened in order, each knowing whether it sits
// inside one of our insertions (where a deletion has to nest).
function liveRuns(items, insideIns = false, out = []) {
  for (const it of items) {
    if (it.kind === "run") out.push({ run: it, insideIns });
    else if (it.kind === "del") continue; // already struck through
    else if (it.kind === "ins") liveRuns(it.items, true, out);
    else if (it.kind === "hyperlink" || it.kind === "smartTag") liveRuns(it.items, insideIns, out);
  }
  return out;
}

const pieces = (text, tag) =>
  text
    .split(/(\t|\n)/)
    .filter((part) => part !== "")
    .map((part) => (part === "\t" ? "<w:tab/>" : part === "\n" ? "<w:br/>" : `<${tag} xml:space="preserve">${escapeXml(part)}</${tag}>`))
    .join("");
const runXml = (rPr, text) => `<w:r>${rPr}${pieces(text, "w:t")}</w:r>`;
const delXml = (rPr, text, stamp) => `<w:del ${stamp()}><w:r>${rPr}${pieces(text, "w:delText")}</w:r></w:del>`;
// A run struck out whole keeps everything it carries — its footnote mark, its
// symbol — with only its text elements turned into deleted text.
const strikeRun = (runXmlText, stamp) =>
  `<w:del ${stamp()}>${runXmlText.replace(/<w:t(\s[^>]*)?>/g, "<w:delText$1>").replace(/<\/w:t>/g, "</w:delText>")}</w:del>`;

// Where two versions of a paragraph differ, as a range of the old text and
// the replacement for it — whole words at both ends, so Word shows
// "thirty (30)" struck and "twenty-five (25)" inserted rather than a letter
// here and a letter there.
function diffRange(oldText, newText) {
  const tokens = (s) => s.match(/\s+|\S+/g) ?? [];
  const a = tokens(oldText);
  const b = tokens(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const len = (arr, from, to) => arr.slice(from, to).join("").length;
  const start = len(a, 0, pre);
  const end = oldText.length - len(a, a.length - suf, a.length);
  const inserted = newText.slice(start, newText.length - len(b, b.length - suf, b.length));
  return { start, end, inserted };
}

// Marks a paragraph's own paragraph mark as inserted or deleted, so that
// accepting or rejecting the change adds or removes the whole paragraph
// rather than leaving an empty line behind.
function markParagraphMark(pPr, tag, stamp) {
  const mark = `<w:${tag} ${stamp()}/>`;
  if (!pPr) return `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`;
  const inner = pPr.replace(/^<w:pPr(?:\s[^>]*)?>/, "").replace(/<\/w:pPr>$/, "");
  const rPr = child(inner, "w:rPr");
  return rPr
    ? `<w:pPr>${inner.replace(rPr, rPr.replace(/^<w:rPr>/, `<w:rPr>${mark}`))}</w:pPr>`
    : `<w:pPr>${inner}<w:rPr>${mark}</w:rPr></w:pPr>`;
}

// Runs for new text: **bold** spans take w:b on top of the surrounding run's
// formatting, everything else copies it as it is.
function runsFor(text, baseRPr) {
  const bolded = (rPr) => {
    if (!rPr) return "<w:rPr><w:b/><w:bCs/></w:rPr>";
    if (/<w:b(?:\s|\/)/.test(rPr)) return rPr;
    const m = /^(<w:rPr>(?:<w:rStyle[^>]*\/>)?(?:<w:rFonts[^>]*\/>)?)/.exec(rPr);
    return m ? rPr.slice(0, m[1].length) + "<w:b/><w:bCs/>" + rPr.slice(m[1].length) : rPr;
  };
  let xml = "";
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    const bold = part.startsWith("**") && part.endsWith("**");
    xml += runXml(bold ? bolded(baseRPr) : baseRPr, bold ? part.slice(2, -2) : part);
  }
  return xml;
}

// ---------------------------------------------------------------- editing

// Rewrites a paragraph so the words that differ are struck through and the
// new ones marked inserted. Returns null when the paragraph's markup is not
// something this can safely account for, so the caller can fall back.
function replaceParagraph(pXml, newText, stamp) {
  const pPr = child(pXml, "w:pPr") ?? "";
  const bodyXml = pXml.replace(/^<w:p(?:\s[^>]*)?>/, "").replace(/<\/w:p>$/, "").replace(pPr, "");
  const items = tokenize(bodyXml);
  const runs = liveRuns(items);
  const oldText = runs.map((r) => r.run.text).join("");
  // Text this did not account for means every offset below would be wrong.
  if (oldText !== visibleText(pXml)) return null;
  const { start, end, inserted } = diffRange(oldText, newText);
  if (start === end && !inserted) return pXml;
  let at = 0;
  for (const { run } of runs) {
    const s = at;
    at += run.text.length;
    const partial = s < end && at > start && (s < start || at > end);
    if (partial && !run.splittable) return null;
  }

  let offset = 0;
  let insertionDone = false;
  // New text goes where the removed text ended — which is the insertion
  // point itself when nothing was removed.
  const insertAt = end;
  const insXml = (text, rPr, insideIns) =>
    insideIns ? runsFor(text, rPr) : `<w:ins ${stamp()}>${runsFor(text, rPr)}</w:ins>`;
  const rewrite = (list, insideIns) =>
    list.flatMap((it) => {
      if (it.kind === "ins" || it.kind === "hyperlink" || it.kind === "smartTag") {
        return [{ ...it, items: rewrite(it.items, insideIns || it.kind === "ins") }];
      }
      if (it.kind !== "run") return [it];
      const s = offset;
      const e = offset + it.text.length;
      offset = e;
      if (e <= start || s >= end) {
        // Untouched — unless the new text belongs at this run's edge, which
        // is where it lands when nothing was removed and the insertion point
        // falls between two runs (text added at the start of a paragraph,
        // say, or between two differently formatted spans).
        if (!insertionDone && inserted && (insertAt === s || insertAt === e)) {
          insertionDone = true;
          const ins = { kind: "raw", xml: insXml(inserted, it.rPr, insideIns) };
          return insertAt === s ? [ins, it] : [it, ins];
        }
        return [it];
      }
      // Clamped at both ends: an offset before this run is 0, one past it is
      // the run's length. Left unclamped, a negative index counts back from
      // the end of the string and silently duplicates the text.
      const clamp = (n) => Math.max(0, Math.min(it.text.length, n));
      const cut = (from, to) => it.text.slice(clamp(from - s), clamp(to - s));
      const whole = s >= start && e <= end;
      const before = whole ? "" : cut(s, start);
      const middle = cut(Math.max(s, start), Math.min(e, end));
      const after = whole ? "" : cut(end, e);
      const out = [];
      if (before) out.push({ kind: "raw", xml: runXml(it.rPr, before) });
      // Struck out whole where it can be, so a footnote mark or symbol inside
      // the removed text is carried into the deletion rather than dropped.
      if (whole) out.push({ kind: "raw", xml: strikeRun(it.xml, stamp) });
      else if (middle) out.push({ kind: "raw", xml: delXml(it.rPr, middle, stamp) });
      if (!insertionDone && inserted && end <= e) {
        insertionDone = true;
        out.push({ kind: "raw", xml: insXml(inserted, it.rPr, insideIns) });
      }
      if (after) out.push({ kind: "raw", xml: runXml(it.rPr, after) });
      return out;
    });

  const rewritten = rewrite(items, false);
  if (inserted && !insertionDone) {
    const last = runs[runs.length - 1];
    rewritten.push({ kind: "raw", xml: insXml(inserted, last?.run.rPr ?? "", false) });
  }
  return `${/^<w:p(?:\s[^>]*)?>/.exec(pXml)?.[0] ?? "<w:p>"}${pPr}${serialize(rewritten)}</w:p>`;
}

// Strikes the whole paragraph through, its paragraph mark included.
function deleteParagraph(pXml, stamp) {
  const pPr = child(pXml, "w:pPr") ?? "";
  const bodyXml = pXml.replace(/^<w:p(?:\s[^>]*)?>/, "").replace(/<\/w:p>$/, "").replace(pPr, "");
  const items = tokenize(bodyXml);
  const strike = (list) =>
    list.flatMap((it) => {
      if (it.kind === "ins" || it.kind === "hyperlink" || it.kind === "smartTag") return [{ ...it, items: strike(it.items) }];
      if (it.kind !== "run") return [it];
      return [{ kind: "raw", xml: strikeRun(it.xml, stamp) }];
    });
  return `${/^<w:p(?:\s[^>]*)?>/.exec(pXml)?.[0] ?? "<w:p>"}${markParagraphMark(pPr, "del", stamp)}${serialize(strike(items))}</w:p>`;
}

// A new paragraph after `anchor`, formatted like it (or as a heading of the
// level asked for), marked as an insertion — runs and paragraph mark both,
// so rejecting it removes the whole line.
function insertAfter(anchorXml, text, headings, stamp) {
  let pPr = child(anchorXml, "w:pPr") ?? "";
  let body = text.trim();
  const h = /^(#{1,3})\s+([\s\S]*)$/.exec(body);
  if (h) {
    body = h[2].trim();
    const styleId = headings.byLevel.get(h[1].length);
    // A heading takes its style's own numbering and look, not the anchor's.
    if (styleId) pPr = `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`;
  }
  const live = anchorXml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "");
  const baseRPr = h ? "" : /<w:r(?:\s[^>]*)?>(<w:rPr>[\s\S]*?<\/w:rPr>)?(?:(?!<\/w:r>)[\s\S])*?<w:t/.exec(live)?.[1] ?? "";
  return `<w:p>${markParagraphMark(pPr, "ins", stamp)}<w:ins ${stamp()}>${runsFor(body, baseRPr)}</w:ins></w:p>`;
}

// A paragraph the AI itself added on an earlier turn and nobody has accepted
// yet. Word does not track the deletion of an unaccepted insertion — it just
// removes it — and a change to one belongs inside the same insertion rather
// than as a redline within an addition.
function isOwnInsertion(pXml) {
  if (!pXml.includes("<w:ins ") || !pXml.includes(`w:author="${DOCX_AUTHOR}"`)) return false;
  if (/<w:del[\s>]/.test(pXml)) return false;
  const outside = pXml.replace(/<w:ins\s[^>]*>[\s\S]*?<\/w:ins>/g, "");
  return !/<w:t(?:\s[^>]*)?>[^<]/.test(outside);
}

function rewriteOwnInsertion(pXml, text, stamp) {
  const baseRPr = /<w:r(?:\s[^>]*)?>(<w:rPr>[\s\S]*?<\/w:rPr>)?(?:(?!<\/w:r>)[\s\S])*?<w:t/.exec(pXml)?.[1] ?? "";
  const pPr = child(pXml, "w:pPr") ?? "";
  return `${/^<w:p(?:\s[^>]*)?>/.exec(pXml)?.[0] ?? "<w:p>"}${pPr}<w:ins ${stamp()}>${runsFor(text.trim(), baseRPr)}</w:ins></w:p>`;
}

// Global paragraph references span the body, headers, footers and notes.
const STORY_PART = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;
const xmlParts = entries => Object.fromEntries(Object.entries(entries).filter(([p]) => p.endsWith('.xml')).map(([p,b]) => [p, dec.decode(b)]));
function validateXml(entries) {
  for (const [part, bytes] of Object.entries(entries)) {
    if (!part.endsWith('.xml') && !part.endsWith('.rels')) continue;
    const xml = dec.decode(bytes);
    if (/<!DOCTYPE/i.test(xml)) throw new Error(`Unsupported document declaration in ${part}`);
    new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(`${part}: ${message}`); } }).parseFromString(xml, 'application/xml');
  }
}
export function inspectDocx(bytes, opts = {}) {
  const entries = readZip(bytes);
  validateXml(entries);
  const byRef = new Map(); const lines = [];
  let count = 0; let shown = 0; let remaining = opts.budget ?? MAX_LISTING_CHARS;
  for (const part of Object.keys(entries).filter(p => STORY_PART.test(p)).sort((a,b) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b))) {
    const view = inspectPart(writeZip({ ...entries, 'word/document.xml': entries[part] }), { ...opts, budget: Math.max(0, remaining) });
    const offset = count;
    for (const [local, ref] of view.byRef) {
      const id = offset + local;
      byRef.set(id, { ...ref, index: id, localIndex: local, part });
    }
    count = Math.max(count, ...[...byRef.keys()]);
    const listing = view.listing.replace(/¶(\d+)/g, (_, n) => `¶${offset + Number(n)}`);
    if (view.shown) lines.push(`PART: ${part}\n${listing}`);
    remaining -= listing.length + part.length + 10;
    shown += view.shown;
  }
  return { listing: lines.join('\n\n'), byRef, paragraphCount: byRef.size, shown, partial: shown < byRef.size, hash: createHash('sha256').update(bytes).digest('hex'), quality: inspectPackage(xmlParts(entries)) };
}

export async function applyDocxOps(bytes, ops, byRef) {
  const entries = readZip(bytes); const original = xmlParts(entries);
  const groups = new Map(); const results = []; let applied = 0;
  for (let i = 0; i < ops.length; i++) {
    const raw = ops[i]; const ref = byRef.get(Number(raw?.p));
    const reject = reason => results.push({ i, kind: raw?.op, p: raw?.p, text: raw?.text, status: 'skipped', reason });
    if (!ref || !ref.shown) { reject('Paragraph was not supplied to this turn; request that section first.'); continue; }
    if (typeof raw.expected !== 'string' || raw.expected !== ref.exactText) { reject('Expected paragraph text does not match the source; no change was made.'); continue; }
    if (String(raw.op).toLowerCase() === 'comment' && ref.part !== 'word/document.xml') { reject('Word does not allow comments in headers, footers or notes.'); continue; }
    const list = groups.get(ref.part) ?? [];
    list.push({ raw: { ...raw, p: ref.localIndex }, ref, i }); groups.set(ref.part, list);
  }
  for (const [part, work] of groups) {
    const refs = new Map(work.map(w => [w.ref.localIndex, w.ref]));
    const output = await applyPartOps(writeZip({ ...entries, 'word/document.xml': entries[part] }), work.map(w => w.raw), refs);
    entries[part] = readZip(output.bytes)['word/document.xml'];
    if (part === 'word/document.xml') writeComments(entries, output.comments ?? []);
    for (const result of output.results) { const w = work[result.i]; results.push({ ...result, i: w.i, p: w.ref.index, part }); }
    applied += output.applied;
  }
  validateXml(entries);
  const quality = inspectPackage(xmlParts(entries));
  if (quality.errors.length) throw new Error(`Edited file failed structural checks: ${quality.errors.join('; ')}`);
  const format = compareFormat(xmlParts(entries), original);
  return { bytes: writeZip(entries), applied, results: results.sort((a,b) => a.i-b.i), validation: { ...quality, format, sourceHash: createHash('sha256').update(bytes).digest('hex'), outputHash: createHash('sha256').update(writeZip(entries)).digest('hex') } };
}

// ---------------------------------------------------------------- applying

/**
 * Applies the model's operations to the file. Every operation is reported
 * back — applied, or why not — so the lawyer is told about the ones that
 * could not be made rather than left to find the gap themselves.
 */
async function applyPartOps(bytes, ops, byRef) {
  const results = [];
  const parsed = [];
  ops.forEach((raw, i) => {
    const op = { i, kind: String(raw?.op ?? "").toLowerCase(), p: Number(raw?.p), text: typeof raw?.text === "string" ? raw.text : "" };
    const ref = byRef.get(op.p);
    if (!ref) return results.push({ ...op, status: "skipped", reason: `¶${raw?.p} is not a paragraph in this document` });
    if (op.kind === "replace") {
      if (!op.text.trim()) return results.push({ ...op, status: "skipped", reason: "replace needs text (use delete to remove a paragraph)" });
      // The space a paragraph starts or ends with is formatting, not
      // wording: the model never means to change it, and striking it out
      // would put a redline on thin air. Keep what the paragraph had.
      op.modified =
        /^\s*/.exec(ref.exactText)[0] +
        op.text.replace(/\s*\n\s*/g, " ").trim() +
        /\s*$/.exec(ref.exactText)[0];
      if (op.modified === ref.exactText) return results.push({ ...op, status: "skipped", reason: "no change" });
    } else if (op.kind === "insert_after") {
      if (!op.text.trim()) return results.push({ ...op, status: "skipped", reason: "insert_after needs text" });
    } else if (op.kind === "comment") {
      if (!op.text.trim()) return results.push({ ...op, status: "skipped", reason: "comment needs text" });
    } else if (op.kind !== "delete") {
      return results.push({ ...op, status: "skipped", reason: `unknown op "${raw?.op}"` });
    }
    parsed.push({ op, ref });
  });

  const entries = readZip(bytes);
  let applied = 0;
  const fallback = [];
  const comments = [];

  if (parsed.length) {
    let documentXml = dec.decode(entries["word/document.xml"]);
    const headings = headingStyles(entries["word/styles.xml"] ? dec.decode(entries["word/styles.xml"]) : "");
    const stamp = revisionStamps(documentXml);
    const byIndex = new Map(enumerateParagraphs(documentXml, headings).map((p) => [p.index, p]));

    // Bottom of the document upwards, so an edit never moves a paragraph
    // another operation is still to find.
    const work = new Map();
    for (const { op } of parsed) work.set(op.p, [...(work.get(op.p) ?? []), op]);
    for (const index of [...work.keys()].sort((a, b) => b - a)) {
      const para = byIndex.get(index);
      const group = work.get(index);
      if (!para) {
        group.forEach((op) => results.push({ ...op, status: "skipped", reason: `¶${index} not found` }));
        continue;
      }
      const paraXml = documentXml.slice(para.start, para.end);
      const own = isOwnInsertion(paraXml);
      const additions = group.filter((op) => op.kind === "insert_after");
      const notes = group.filter((op) => op.kind === "comment");
      const edits = group.filter((op) => op.kind !== "insert_after" && op.kind !== "comment");
      const edit = edits[0];
      // One paragraph, one change to it: a second would be written against
      // text the first has already changed. Say so rather than drop it.
      edits.slice(1).forEach((op) =>
        results.push({ ...op, status: "skipped", reason: `another change to ¶${index} was made instead` }),
      );

      let replacement = paraXml;
      if (edit?.kind === "delete") replacement = own ? "" : deleteParagraph(paraXml, stamp);
      else if (edit?.kind === "replace") replacement = own ? rewriteOwnInsertion(paraXml, edit.modified, stamp) : replaceParagraph(paraXml, edit.modified, stamp);

      if (edit && replacement === null) {
        // Markup this cannot safely rewrite; the redline engine gets it.
        replacement = paraXml;
        fallback.push({
          op: edit,
          lib: edit.kind === "replace"
            ? { type: "replace", target: { exactText: para.text, occurrence: para.occurrence }, modified: edit.modified }
            : { type: "delete", target: { exactText: para.text, occurrence: para.occurrence } },
        });
      } else if (edit) {
        results.push({ ...edit, status: "applied" });
        applied++;
      }

      // A comment spans the paragraph as it now stands. Its id is a
      // placeholder here; the package allocates the real one.
      if (notes.length && replacement && /^<w:p[\s>]/.test(replacement) && replacement.endsWith("</w:p>")) {
        for (const op of notes) {
          const key = `@@AKLA_COMMENT_${comments.length}@@`;
          comments.push({ key, text: op.text.trim() });
          const open = /^<w:p(?:\s[^>]*)?>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?/.exec(replacement)[0];
          replacement = `${open}<w:commentRangeStart w:id="${key}"/>${replacement.slice(open.length, -"</w:p>".length)}<w:commentRangeEnd w:id="${key}"/><w:r><w:commentReference w:id="${key}"/></w:r></w:p>`;
          results.push({ ...op, status: "applied" });
          applied++;
        }
      } else {
        notes.forEach((op) => results.push({ ...op, status: "skipped", reason: replacement ? `¶${index} has no text to comment on` : `¶${index} was removed, so it cannot take a comment` }));
      }

      const added = additions.map((op) => insertAfter(paraXml, op.text, headings, stamp)).join("");
      documentXml = documentXml.slice(0, para.start) + replacement + added + documentXml.slice(para.end);
      additions.forEach((op) => {
        results.push({ ...op, status: "applied" });
        applied++;
      });
    }
    entries["word/document.xml"] = enc.encode(documentXml);
  }

  let out = applied ? writeZip(entries) : bytes;
  if (fallback.length) {
    const res = await openDocx(out).applyOperations(fallback.map((x) => x.lib), {
      author: DOCX_AUTHOR, atomic: false, validate: true, strictTargets: true, continueOnError: true,
    });
    fallback.forEach(({ op }, k) => {
      const r = (res.results ?? [])[k];
      if (r && (r.status === "applied" || r.status === "ok")) {
        applied++;
        results.push({ ...op, status: "applied" });
      } else {
        // A batch the engine refuses outright comes back with no per-operation
        // result at all; saying nothing would hide the change from the lawyer.
        results.push({ ...op, status: "skipped", reason: r?.error?.message ?? r?.error?.code ?? res.error?.message ?? "this paragraph's formatting could not be edited safely" });
      }
    });
    if (res.written) out = res.toBuffer();
  }

  results.sort((a, b) => a.i - b.i);
  return { bytes: out, results, applied, comments };
}

const COMMENTS_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const COMMENTS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// Writes comments into the package's comments part, creating the part, its
// content type and its relationship when the document has none yet, and puts
// the real ids in place of the placeholders in the body.
function writeComments(entries, pending) {
  if (!pending.length) return;
  let body = dec.decode(entries["word/document.xml"]);
  let part = entries["word/comments.xml"] ? dec.decode(entries["word/comments.xml"]) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}"></w:comments>`;
  let next = 0;
  for (const m of `${part}${body}`.matchAll(/<w:(?:comment|commentRangeStart|commentRangeEnd|commentReference)\b[^>]*w:id="(\d+)"/g)) next = Math.max(next, Number(m[1]) + 1);
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let xml = "";
  for (const c of pending) {
    const id = next++;
    body = body.split(c.key).join(String(id));
    const paragraphs = c.text.split(/\n+/).map((line) => `<w:p><w:r><w:annotationRef/></w:r><w:r>${pieces(line, "w:t")}</w:r></w:p>`).join("");
    xml += `<w:comment w:id="${id}" w:author="${escapeXml(COMMENT_AUTHOR)}" w:date="${date}" w:initials="AKLA">${paragraphs}</w:comment>`;
  }
  part = part.replace(/<\/w:comments>\s*$/, `${xml}</w:comments>`);
  entries["word/document.xml"] = enc.encode(body);
  const existed = !!entries["word/comments.xml"];
  entries["word/comments.xml"] = enc.encode(part);
  if (existed) return;
  const types = dec.decode(entries["[Content_Types].xml"]);
  if (!types.includes('PartName="/word/comments.xml"')) {
    entries["[Content_Types].xml"] = enc.encode(types.replace("</Types>", `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_TYPE}"/></Types>`));
  }
  const relsPath = "word/_rels/document.xml.rels";
  const rels = entries[relsPath] ? dec.decode(entries[relsPath]) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (!rels.includes(COMMENTS_REL)) {
    let rid = 1;
    while (rels.includes(`Id="rIdAklaComments${rid}"`)) rid++;
    entries[relsPath] = enc.encode(rels.replace("</Relationships>", `<Relationship Id="rIdAklaComments${rid}" Type="${COMMENTS_REL}" Target="comments.xml"/></Relationships>`));
  }
}

// The same file with every tracked change accepted — a clean copy.
export function acceptAllChanges(bytes) {
  const entries = readZip(bytes);
  for (const part of Object.keys(entries).filter(p => STORY_PART.test(p))) {
  let xml = dec.decode(entries[part]);
  if (/<w:(?:moveFrom|moveTo|pPrChange|rPrChange|tblPrChange|sectPrChange)\b/.test(xml)) throw new Error("This file contains revision types that must be accepted in Word.");
  // A struck-through paragraph mark joins the paragraph to the next one;
  // dropping the paragraph is what Word shows and what the lawyer means.
  // The mark is the w:del inside the paragraph properties' own w:rPr — a
  // deletion anywhere else in the paragraph is ordinary struck-out text.
  xml = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
    const pPr = child(p, "w:pPr");
    const rPr = pPr && child(pPr, "w:rPr");
    if (rPr && /<w:del[\s/>]/.test(rPr)) {
      if (/<w:t(?:\s[^>]*)?>[^<]/.test(p.replace(/<w:del\b[\s\S]*?<\/w:del>/g, ""))) throw new Error("Paragraph merge must be accepted in Word.");
      return "";
    }
    return p;
  });
  xml = xml
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
    .replace(/<w:ins\s[^>]*\/>/g, "")
    .replace(/<w:ins\s[^>]*>([\s\S]*?)<\/w:ins>/g, "$1");
  xml = xml.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, cell => /<w:p(?:\s|>|\/)/.test(cell) ? cell : cell.replace('</w:tc>', '<w:p/></w:tc>'));
  entries[part] = enc.encode(xml);
  }
  validateXml(entries);
  return writeZip(entries);
}

// ------------------------------------------------------- review suggestions

// A review suggestion quotes the document as mammoth read it: HTML, with a
// footnote marker written as <sup>[9]</sup> and paragraphs as <p>. The Word
// file has no text for the marker and a paragraph break for each <p>, so
// both are put into those terms before anything is looked for.
function suggestionParagraphs(html) {
  return String(html ?? "")
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|td|th|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Finds needle in hay with runs of whitespace treated as one space, and
// returns where it sits in hay itself, so the replacement lands on the
// document's own characters.
function findLoose(hay, needle, from = 0) {
  const map = [];
  let loose = "";
  let space = false;
  for (let i = 0; i < hay.length; i++) {
    if (/\s/.test(hay[i])) {
      if (!space) { loose += " "; map.push(i); }
      space = true;
    } else {
      loose += hay[i]; map.push(i); space = false;
    }
  }
  const want = needle.replace(/\s+/g, " ").trim();
  if (!want) return null;
  const at = loose.indexOf(want, from);
  if (at < 0) return null;
  const endLoose = at + want.length - 1;
  let end = map[endLoose] + 1;
  return { start: map[at], end };
}

const REVIEW_ACCEPTED_AUTHOR = "AKLA AI (accepted)";
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The places two versions of a paragraph differ, word by word. Changing a
// figure at the start of a clause and a party at the end should strike two
// words and insert two, not strike and retype the whole sentence between.
function wordHunks(oldText, newText) {
  const a = oldText.match(/\s+|\S+/g) ?? [];
  const b = newText.match(/\s+|\S+/g) ?? [];
  // Very long paragraphs fall back to one change rather than a huge table.
  if (a.length * b.length > 4_000_000) {
    const { start, end, inserted } = diffRange(oldText, newText);
    return [{ start, end, inserted }];
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0, pos = 0, open = null;
  const close = () => { if (open) { hunks.push(open); open = null; } };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close(); pos += a[i].length; i++; j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open ??= { start: pos, end: pos, inserted: "" };
      open.inserted += b[j]; j++;
    } else {
      open ??= { start: pos, end: pos, inserted: "" };
      pos += a[i].length; open.end = pos; i++;
    }
  }
  close();
  // A lone space kept between two changes reads as noise; join them.
  const merged = [];
  for (const h of hunks) {
    const prev = merged[merged.length - 1];
    const gap = prev ? oldText.slice(prev.end, h.start) : null;
    if (prev && gap !== null && /^\s*$/.test(gap)) {
      prev.inserted += gap + h.inserted;
      prev.end = h.end;
    } else merged.push({ ...h });
  }
  return merged;
}

function locateQuote(paras, before) {
  for (let k = 0; k < paras.length; k++) {
    const first = findLoose(paras[k].text, before[0]);
    if (!first) continue;
    if (before.length === 1) return [{ para: paras[k], ...first }];
    if (paras[k].text.slice(first.end).trim()) continue;
    const list = [{ para: paras[k], ...first }];
    let q = k;
    let ok = true;
    for (let j = 1; j < before.length; j++) {
      // Empty paragraphs between the quoted ones are not in the quote.
      q++;
      while (paras[q] && !paras[q].text.trim()) q++;
      const para = paras[q];
      const hit = para && findLoose(para.text, before[j]);
      const whole = para && para.text.trim().replace(/\s+/g, " ") === before[j].replace(/\s+/g, " ");
      const lastStartsHere = hit && j === before.length - 1 && !para.text.slice(0, hit.start).trim();
      if (!hit || !(whole || lastStartsHere)) { ok = false; break; }
      list.push({ para, ...hit });
    }
    if (ok) return list;
  }
  return null;
}

/**
 * Writes review suggestions into the Word file. A pending suggestion becomes
 * a tracked change; an accepted one is written in and its revision accepted,
 * so the page shows the new wording plainly. Revisions already in the file
 * are left as they are — the lawyer's own redline stays visible alongside.
 *
 * changes: [{ id, original, suggested, accepted }]
 */
export function applyReviewSuggestions(bytes, changes) {
  const entries = readZip(bytes);
  const headings = headingStyles(entries["word/styles.xml"] ? dec.decode(entries["word/styles.xml"]) : "");
  // The body first, then notes, headers and footers: a suggestion about a
  // footnote quotes the footnote.
  const partNames = Object.keys(entries)
    .filter((name) => STORY_PART.test(name))
    .sort((x, y) => (x === "word/document.xml" ? -1 : y === "word/document.xml" ? 1 : x.localeCompare(y)));
  const parts = new Map(partNames.map((name) => [name, dec.decode(entries[name])]));
  const pristine = new Map([...parts].map(([name, xml]) => [name, enumerateParagraphs(xml, headings)]));
  let maxId = 9000;
  for (const xml of parts.values()) for (const m of xml.matchAll(/<w:(?:ins|del|moveFrom|moveTo)\s[^>]*w:id="(\d+)"/g)) maxId = Math.max(maxId, Number(m[1]));
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const stampAs = (author) => () => `w:id="${++maxId}" w:author="${escapeXml(author)}" w:date="${date}"`;
  const results = [];

  for (const change of changes) {
    const skip = (reason) => results.push({ id: change.id, status: "skipped", reason });
    let before = suggestionParagraphs(change.original);
    let after = suggestionParagraphs(change.suggested);
    if (!before.length) { skip("missing_text"); continue; }
    if (before.length !== after.length) {
      if (after.length <= 1) {
        // Several paragraphs rewritten as one: the new wording goes where the
        // quote begins and the rest of the quoted paragraphs are struck out.
        after = [after[0] ?? "", ...before.slice(1).map(() => "")];
      } else if (before.length === 1) {
        after = [after.join(" ")];
      } else { skip("paragraph_structure"); continue; }
    }
    if (before.join("\n").replace(/\s+/g, " ") === after.join("\n").replace(/\s+/g, " ")) { skip("formatting_only"); continue; }

    let found = null;
    for (const [name, xml] of parts) {
      const edits = locateQuote(enumerateParagraphs(xml, headings), before);
      if (edits) { found = { name, edits }; break; }
    }
    if (!found) {
      // Present in the file as it arrived, gone now: an earlier suggestion
      // already rewrote these words.
      const overlaps = [...pristine.values()].some((paras) => locateQuote(paras, before));
      skip(overlaps ? "overlaps_another_suggestion" : "not_found");
      continue;
    }

    const stamp = change.accepted ? stampAs(REVIEW_ACCEPTED_AUTHOR) : stampAs(DOCX_AUTHOR);
    let xml = parts.get(found.name);
    const rewrites = [];
    let failed = false;
    found.edits.forEach((e, n) => {
      if (failed) return;
      const newText = e.para.text.slice(0, e.start) + (after[n] ?? "") + e.para.text.slice(e.end);
      if (newText === e.para.text) return;
      let pXml = xml.slice(e.para.start, e.para.end);
      if (isOwnInsertion(pXml)) {
        pXml = rewriteOwnInsertion(pXml, newText, stamp);
      } else {
        // Right to left, so each change leaves the offsets of the ones
        // before it where they were.
        for (const h of wordHunks(e.para.text, newText).reverse()) {
          const current = visibleText(pXml);
          const next = replaceParagraph(pXml, current.slice(0, h.start) + h.inserted + current.slice(h.end), stamp);
          if (next === null) { failed = true; return; }
          pXml = next;
        }
      }
      rewrites.push({ para: e.para, out: pXml });
    });
    if (failed) { skip("formatting"); continue; }
    if (!rewrites.length) { skip("no_change"); continue; }
    for (const r of rewrites.sort((x, y) => y.para.start - x.para.start)) {
      xml = xml.slice(0, r.para.start) + r.out + xml.slice(r.para.end);
    }
    parts.set(found.name, xml);
    results.push({ id: change.id, status: "applied" });
  }

  // Accepted suggestions: keep the new words, drop the old, no markup.
  const author = escapeRegExp(escapeXml(REVIEW_ACCEPTED_AUTHOR));
  for (const [name, xml] of parts) {
    const clean = xml
      .replace(new RegExp(`<w:del\\b[^>]*w:author="${author}"[^>]*>[\\s\\S]*?<\\/w:del>`, "g"), "")
      .replace(new RegExp(`<w:ins\\b[^>]*w:author="${author}"[^>]*>([\\s\\S]*?)<\\/w:ins>`, "g"), "$1");
    entries[name] = enc.encode(clean);
  }
  validateXml(entries);
  const quality = inspectPackage(xmlParts(entries));
  if (quality.errors.length) throw new Error(`Redlined file failed structural checks: ${quality.errors.join("; ")}`);
  return { bytes: writeZip(entries), results };
}

// One line per operation, for the reply and the artifact's change list.
export function describeResults(results) {
  const verb = { replace: "Changed", insert_after: "Added after", delete: "Deleted", comment: "Commented on" };
  return results.map((r) => ({
    op: r.kind,
    paragraph: r.p,
    status: r.status,
    summary: `${verb[r.kind] ?? r.kind} ¶${r.p}${r.text ? `: ${r.text.slice(0, 90)}${r.text.length > 90 ? "…" : ""}` : ""}`,
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}
