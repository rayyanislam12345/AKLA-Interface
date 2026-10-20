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
  {"op": "replace", "p": 12, "expected": "Exact current paragraph text", "text": "The full new text of paragraph ¶12.", "why": "one short line on why this change"},
  {"op": "insert_after", "p": 12, "expected": "Exact current anchor text", "text": "One new paragraph, placed after ¶12."},
  {"op": "delete", "p": 14, "expected": "Exact current paragraph text"},
  {"op": "comment", "p": 15, "expected": "Exact current paragraph text", "text": "The Firm notes that the concession period is not yet fixed."}
]}
\`\`\`
Rules:
- If you need a section hidden by a gap, emit {"read":[{"from":100,"to":140}]} in the JSON block instead of ops. The document reader will return those paragraphs and you can continue. Request at most 200 paragraphs at once; a longer range is served as its first 200 and you may ask for the rest afterwards.
- Every operation must include "expected": the exact current text of that paragraph, without the ¶ label. Never operate on a paragraph that was not shown.
- "replace" gives the COMPLETE new text of that one paragraph, copied from above with your change made in it. Word shows only the words that differ, so keep everything you are not changing exactly as it is — same wording, same spacing, same defined terms. One paragraph per op; never merge or split paragraphs.
- "insert_after" adds exactly one paragraph; use several ops (same "p", in reading order) for several paragraphs. The new paragraph takes the formatting and numbering of ¶p, so anchor a clause on a body paragraph and a heading on a heading. Start the text with "# ", "## " or "### " to make it a heading of that level instead; it takes the look of the document's own headings of that level, so use only a level the document's [H1]/[H2]/[H3] paragraphs show (a heading of a level it has none of is not added).
- Never type clause numbers — Word numbers headings and list items itself.
- "comment" puts a Word margin comment, titled "AKLA Comments", on that paragraph and leaves its text as it is. Outstanding matters, gaps, figures to confirm and remarks for the reader go in comments — never into the document's text, and never as an end section. A footnote is only for what the document itself cites (a "footnote" block of "write"), never for a remark to the reader. A paragraph may take a change and a comment in the same turn.
- **bold** marks a defined term; use no other markup.
When a firm pack is open, the document is shown with a "KINDS YOU CAN WRITE" line, and four more operations can be used:
\`\`\`json
{"ops": [
  {"op": "write", "after": 12, "expected": "Exact text of ¶12", "blocks": [{"kind": "h1", "text": "Termination"}, {"kind": "body", "text": "Either Party may terminate this Agreement:"}, {"kind": "limb", "text": "on thirty (30) days' notice; or"}, {"kind": "footnote", "text": "Section 4 of the Act."}, {"kind": "issues_table", "rows": [["Issue", "Comment"], ["Title", "Clear"]]}]},
  {"op": "repeat_block", "from": 20, "to": 24, "after": 24, "expected": "Exact text of ¶20"},
  {"op": "add_row", "table": 30, "like_row": 33, "expected": "Exact text of ¶33", "cells": ["First cell", "Second cell"]},
  {"op": "remove_block", "from": 40, "to": 47, "expected": "Exact text of ¶40"}
]}
\`\`\`
- "write" adds paragraphs, in order, after ¶after (after a paragraph in a table, after the whole table). Each block takes the exact look of the firm's own example of its kind; use only the kinds listed. A list kind ((a), (i)) written after something that is not the same list starts again at its first number. A "footnote" block puts a footnote on the paragraph block just before it. A table kind takes "rows" instead of "text"; its first row is the header.
- "repeat_block" copies ¶from to ¶to (whole paragraphs and whole tables) after ¶after: a party, a signature block, a schedule. Change the copy's words in a later turn, once it has its own ¶ numbers.
- "add_row" adds a row, formatted like the row holding ¶like_row, straight after that row; ¶table is any paragraph of the same table. "cells" gives each cell's text, left to right.
- "remove_block" deletes ¶from to ¶to whole: an optional section with its heading. A range that cuts through a table is refused.
- "why" is optional on any op: one short line on why this change, shown to the lawyer beside it.
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
// One fixed timestamp on every entry, so the same parts always give the same
// bytes: a hash of the file, or two runs compared, never differ by the clock.
const ZIP_MTIME = new Date(Date.UTC(2026, 0, 1));
const writeZip = (entries) => zipSync(entries, { level: 6, mtime: ZIP_MTIME });

// A paragraph element, or an empty self-closing one (<w:p w:rsidR="…"/>),
// which is matched on its own so it is never mistaken for the opening tag
// of the paragraph after it. Every paragraph-by-paragraph pass over a part
// uses this one pattern. (A paragraph holding a text box ends at the box's
// inner </w:p>; see enumerateParagraphs, which refuses such paragraphs.)
const PARAGRAPH = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

// Word requires every table cell to end with a paragraph. A cell may end in
// a nested table, so what counts is the element right before each </w:tc>.
const patchEmptyCells = (xml) =>
  xml.replace(/(<\/w:p>|<w:p(?:\s[^>]*)?\/>)?(\s*<\/w:tc>)/g, (m, prev, close) => (prev ? m : `<w:p/>${close}`));

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
// A paragraph that holds a text box (a drawing with its own paragraphs
// inside) is listed with its own words, but no change is written to it:
// its markup nests paragraphs inside runs, which nothing here can rewrite
// safely. An operation on it is refused with reason "formatting".
const NESTED_PARAGRAPHS = /<w:txbxContent[\s>]|<mc:AlternateContent[\s>]/;
const NESTED_CONTENT = /<w:txbxContent(?:\s[^>]*)?>[\s\S]*?<\/w:txbxContent>|<mc:AlternateContent(?:\s[^>]*)?>[\s\S]*?<\/mc:AlternateContent>/g;

function enumerateParagraphs(documentXml, headings) {
  const paras = [];
  let depth = 0;
  let ordinal = 0;
  const seen = new Map(); // text → count so far, to address duplicates
  // The paragraph being read: where it starts, and how many paragraphs of a
  // text box inside it are still open, so that it ends at its own </w:p>.
  let open = null;
  const push = (start, end) => {
    const tok = documentXml.slice(start, end);
    ordinal++;
    const formatting = NESTED_PARAGRAPHS.test(tok);
    const text = tok.endsWith("/>") ? "" : visibleText(formatting ? tok.replace(NESTED_CONTENT, "") : tok);
    const styleId = attr(child(child(tok, "w:pPr") ?? "", "w:pStyle") ?? "", "w:val");
    const occurrence = (seen.get(text) ?? 0) + 1;
    seen.set(text, occurrence);
    paras.push({ index: ordinal, start, end, text, styleId, headingLevel: styleId ? headings.map.get(styleId) : undefined, inTable: depth > 0, occurrence, formatting });
  };
  for (const m of documentXml.matchAll(/<w:tbl>|<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>|<\/w:p>/g)) {
    const tok = m[0];
    if (open) {
      if (tok === "</w:p>") {
        if (open.nested) { open.nested--; continue; }
        push(open.start, m.index + tok.length);
        open = null;
      } else if (tok.startsWith("<w:p") && !tok.endsWith("/>")) open.nested++;
      continue;
    }
    if (tok === "<w:tbl>") { depth++; continue; }
    if (tok === "</w:tbl>") { depth--; continue; }
    if (tok === "</w:p>") continue;
    if (tok.endsWith("/>")) { push(m.index, m.index + tok.length); continue; }
    open = { start: m.index, nested: 0 };
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
    byRef.set(p.index, { index: p.index, exactText: p.text, occurrence: p.occurrence, inTable: p.inTable, headingLevel: p.headingLevel, formatting: p.formatting });
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
    const line = `¶${p.index}${p.headingLevel ? ` [H${p.headingLevel}]` : ""}${p.inTable ? " [table]" : ""}${p.formatting ? " [text box]" : ""} ${p.text}`;
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

// The highest w:id in the XML, every kind of id counted: a revision id must
// never collide with a property change's or a comment anchor's either.
function maxIdIn(xml, floor = 0) {
  let max = floor;
  for (const m of xml.matchAll(/\bw:id="(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

// One counter for a whole call. `floor` is the caller's highest id so far —
// across every part of the file and every id ever recorded for this
// document — so an id is never handed out twice for one working document.
function revisionStamps(documentXml, floor = 9000) {
  let max = maxIdIn(documentXml, floor);
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const stamp = (author = DOCX_AUTHOR) => `w:id="${++max}" w:author="${escapeXml(author)}" w:date="${date}"`;
  stamp.max = () => max;
  // A fresh id for something that is not a revision (a copied bookmark), so
  // it never collides with one.
  stamp.next = () => ++max;
  // A fresh id for the second half of another author's insertion when ours
  // lands inside it; their name and date stay on it.
  stamp.foreign = (author, when) => `w:id="${++max}" w:author="${escapeXml(author)}" w:date="${escapeXml(when ?? date)}"`;
  return stamp;
}

// One operation's share of the stamps: every id it mints is recorded on it,
// and so is any split of another author's insertion it causes.
function stampFor(stamp, op, author = DOCX_AUTHOR) {
  const mine = () => {
    const s = stamp(author);
    (op.revisionIds ??= []).push(Number(attr(s, "w:id")));
    return s;
  };
  mine.foreign = (who, when, fromId) => {
    const s = stamp.foreign(who, when);
    (op.splits ??= []).push({ fromId: fromId ?? null, toId: Number(attr(s, "w:id")), author: who });
    return s;
  };
  return mine;
}

// The ids on the insertions of a paragraph, paragraph mark first.
const insertionIds = (pXml) => [...pXml.matchAll(/<w:ins\s[^>]*?\bw:id="(\d+)"/g)].map((m) => Number(m[1]));

// The number a paragraph opens with ("1.", "4.2", "(a)"), or the nearest
// heading above it in the same part, or nothing. For the lawyer to find
// the change by, not for the writer to place it.
const CLAUSE_LEAD = /^\s*(\d+(?:\.\d+)*\.?|\([a-z0-9]{1,4}\)|[a-z]\))\s+/i;
function clauseFor(byRef, ref) {
  const lead = CLAUSE_LEAD.exec(ref.exactText)?.[1];
  if (lead) return lead.replace(/\.$/, "");
  let heading = null;
  for (const other of byRef.values()) {
    if (other.part !== ref.part || other.index >= ref.index || !other.headingLevel) continue;
    if (!heading || other.index > heading.index) heading = other;
  }
  return heading ? heading.exactText.trim().slice(0, 80) : null;
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
  items.map((it) => (it.kind === "raw" || it.kind === "run" || it.kind === "ourIns" ? it.xml : `${it.open}${serialize(it.items)}${it.close}`)).join("");

// What Word itself does when someone types inside another author's
// insertion: theirs closes before the new text and reopens after it under a
// fresh id, so our insertion is always its own element with its own id.
// A half with nothing in it is not written.
function splitInsertion(container, items, stamp) {
  const at = items.findIndex((it) => it.kind === "ourIns");
  if (at < 0) return [{ ...container, items }];
  const before = items.slice(0, at);
  const after = items.slice(at + 1);
  if (!before.length || !after.length) return [...(before.length ? [{ ...container, items: before }] : []), items[at], ...(after.length ? [{ ...container, items: after }] : [])];
  const fromId = Number(attr(container.open, "w:id"));
  const rest = container.open.slice("<w:ins".length, -1).replace(/\s+w:(?:id|author|date)="[^"]*"/g, "");
  const open = `<w:ins ${stamp.foreign(decodeXml(attr(container.open, "w:author") ?? ""), attr(container.open, "w:date"), fromId)}${rest}>`;
  return [{ ...container, items: before }, items[at], { ...container, open, items: after }];
}

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

// Characters XML 1.0 does not allow at all (escaping cannot help): they would
// pass the parser here and make Word refuse the file as unreadable.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
/** `text` without the characters XML 1.0 forbids; the rest untouched. */
export const stripXmlIllegal = (text) => String(text ?? "").replace(XML_ILLEGAL, "");

const pieces = (text, tag) =>
  stripXmlIllegal(text)
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
  if (!pPr || /^<w:pPr(?:\s[^>]*)?\/>$/.test(pPr)) return `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`;
  const inner = pPr.replace(/^<w:pPr(?:\s[^>]*)?>/, "").replace(/<\/w:pPr>$/, "");
  const rPr = child(inner, "w:rPr");
  // The mark's own properties come before a section break or a recorded
  // formatting change, which is the order Word requires.
  if (!rPr) return `<w:pPr>${inner.replace(/(<w:(?:sectPr|pPrChange)[\s>/][\s\S]*)?$/, (tail) => `<w:rPr>${mark}</w:rPr>${tail}`)}</w:pPr>`;
  // The mark goes first in the run properties, whether they are written
  // self-closing, with attributes, or already open. A deleted mark follows
  // an inserted one, which is the order Word writes them in.
  const marked = /\/>$/.test(rPr)
    ? rPr.replace(/\s*\/>$/, `>${mark}</w:rPr>`)
    : rPr.replace(/^(<w:rPr(?:\s[^>]*)?>)((?:<w:ins\s[^>]*?\/>)?)/, (_, open, insMark) => `${open}${tag === "del" ? insMark + mark : mark + insMark}`);
  return `<w:pPr>${inner.replace(rPr, marked)}</w:pPr>`;
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
  // Our insertion is marked so that a container it lands inside can be
  // split around it; it is always its own <w:ins> with its own id.
  const insXml = (text, rPr) => ({ kind: "ourIns", xml: `<w:ins ${stamp()}>${runsFor(text, rPr)}</w:ins>` });
  const rewrite = (list) =>
    list.flatMap((it) => {
      if (it.kind === "ins" || it.kind === "hyperlink" || it.kind === "smartTag") {
        const items = rewrite(it.items);
        return it.kind === "ins" ? splitInsertion(it, items, stamp) : [{ ...it, items }];
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
          const ins = insXml(inserted, it.rPr);
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
        out.push(insXml(inserted, it.rPr));
      }
      if (after) out.push({ kind: "raw", xml: runXml(it.rPr, after) });
      return out;
    });

  const rewritten = rewrite(items);
  if (inserted && !insertionDone) {
    const last = runs[runs.length - 1];
    rewritten.push(insXml(inserted, last?.run.rPr ?? ""));
  }
  return `${/^<w:p(?:\s[^>]*)?>/.exec(pXml)?.[0] ?? "<w:p>"}${pPr}${serialize(rewritten)}</w:p>`;
}

// Strikes the whole paragraph through, its paragraph mark included — unless
// the mark ends a section (a w:sectPr in its properties): accepting the
// deletion of that mark would take the section break with it, and the
// pages before it would take on the next section's page set-up. Its words
// are struck through and the mark stays, empty, carrying the break; nothing
// moves untracked, so rejecting the deletion restores exactly what was there.
function deleteParagraph(pXml, stamp) {
  const pPr = paraPropsOf(pXml) || (child(pXml, "w:pPr") ?? "");
  const keepMark = SECTION_BREAK.test(pPr);
  const bodyXml = pXml.replace(/^<w:p(?:\s[^>]*)?>/, "").replace(/<\/w:p>$/, "").replace(pPr, "");
  const items = tokenize(bodyXml);
  const strike = (list) =>
    list.flatMap((it) => {
      if (it.kind === "ins" || it.kind === "hyperlink" || it.kind === "smartTag") return [{ ...it, items: strike(it.items) }];
      if (it.kind !== "run") return [it];
      return [{ kind: "raw", xml: strikeRun(it.xml, stamp) }];
    });
  return `${/^<w:p(?:\s[^>]*)?>/.exec(pXml)?.[0] ?? "<w:p>"}${keepMark ? pPr : markParagraphMark(pPr, "del", stamp)}${serialize(strike(items))}</w:p>`;
}

// A paragraph's own properties, whole. A recorded formatting change
// (w:pPrChange) holds a second w:pPr inside the first, so the first
// </w:pPr> in the paragraph is not necessarily the end of its own.
function paraPropsOf(pXml) {
  const open = /^<w:p(?:\s[^>]*)?>\s*/.exec(pXml);
  if (!open) return "";
  const head = /^<w:pPr(?:\s[^>]*)?(\/?)>/.exec(pXml.slice(open[0].length));
  if (!head) return "";
  if (head[1]) return head[0];
  const re = /<w:pPr(?:\s[^>]*)?(\/?)>|<\/w:pPr>/g;
  re.lastIndex = open[0].length;
  let depth = 0;
  for (let m; (m = re.exec(pXml)); ) {
    if (m[0] === "</w:pPr>") { if (--depth === 0) return pXml.slice(open[0].length, m.index + m[0].length); }
    else if (!m[1]) depth++;
  }
  return "";
}

const SECTION_BREAK = /<w:sectPr[\s>/]/;
const FORMAT_CHANGE = /<w:rPrChange\b[^>]*\/>|<w:rPrChange\b[^>]*>[\s\S]*?<\/w:rPrChange>/g;

// The properties a new paragraph copies from another. Never its section
// break: the copy would end a section of its own, with its own page set-up.
// Never a record of an earlier formatting change, and never the revision
// mark on the source's own paragraph mark: the new paragraph is ours alone.
function copiedPPr(pPr) {
  if (!pPr) return "";
  return pPr
    .replace(/<w:pPrChange\b[^>]*\/>|<w:pPrChange\b[^>]*>[\s\S]*?<\/w:pPrChange>/g, "")
    .replace(/<w:sectPrChange\b[^>]*\/>|<w:sectPrChange\b[^>]*>[\s\S]*?<\/w:sectPrChange>/g, "")
    .replace(/<w:sectPr\b[^>]*\/>|<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g, "")
    .replace(FORMAT_CHANGE, "")
    .replace(/<w:(?:ins|del|moveFrom|moveTo)\b[^>]*\/>/g, "")
    .replace(/<w:rPr><\/w:rPr>|<w:rPr\/>/g, "");
}

// The formatting of the first run a reader sees in the paragraph (the
// first that holds text or a tab), without any record of an earlier change
// to it. The run is found first and its own properties read from its
// start, so nothing beyond its </w:r> — a page break's run, a bookmark,
// a field's begin and separate — can be taken for its formatting.
function firstRunRPr(pXml) {
  const live = pXml.replace(/<w:del\b[^>]*\/>|<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, "").replace(FORMAT_CHANGE, "");
  for (const m of live.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    if (!/<w:t[\s>]|<w:tab\/>/.test(m[1])) continue;
    return /^\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(m[1])?.[1] ?? "";
  }
  return "";
}

const unbold = (rPr) => rPr.replace(/<w:b(?:Cs)?(?:\s[^>]*)?\/>/g, "").replace(/^<w:rPr><\/w:rPr>$/, "");

// A new paragraph after `anchor`, formatted like it, marked as an insertion
// — runs and paragraph mark both, so rejecting it removes the whole line.
// A heading ("# ", "## ", "### ") instead takes the paragraph and run
// formatting of the document's own heading of that level nearest the
// anchor (`exemplar`): where the firm sets Arial on every run over a Times
// New Roman Normal, the style alone would give the wrong font. A level the
// file has a heading style for but no heading of is not made up from the
// bare style (in the firm's CA that style is Cambria, on a list the
// document never uses, and the format check would refuse the whole turn):
// the result is { skip: level } and only that operation is refused. A file
// with no heading styles at all gets a paragraph like the anchor, without
// its bold. `heading` on the result says whether the paragraph is a
// heading, so the contents page can be marked out of date.
function insertAfter(anchorXml, text, headings, stamp, exemplar = () => null) {
  const anchorPPr = copiedPPr(paraPropsOf(anchorXml));
  let pPr = anchorPPr;
  let baseRPr = firstRunRPr(anchorXml);
  let body = text.trim();
  let heading = false;
  const h = /^(#{1,3})\s+([\s\S]*)$/.exec(body);
  if (h) {
    body = h[2].trim();
    const level = h[1].length;
    const styleId = headings.byLevel.get(level);
    const model = exemplar(styleId, level);
    if (model) {
      pPr = copiedPPr(paraPropsOf(model));
      baseRPr = firstRunRPr(model);
      heading = true;
    } else if (styleId) {
      return { skip: level };
    } else {
      baseRPr = unbold(baseRPr);
    }
  }
  return { xml: `<w:p>${markParagraphMark(pPr, "ins", stamp)}<w:ins ${stamp()}>${runsFor(body, baseRPr)}</w:ins></w:p>`, heading };
}

// Why a heading of a level the document has none of was not added.
function noHeadingReason(level, used) {
  const levels = used.length ? `it uses heading level${used.length === 1 ? "" : "s"} ${used.length === 1 ? used[0] : `${used.slice(0, -1).join(", ")} and ${used[used.length - 1]}`}` : "it has no headings";
  return `this document has no level-${level} heading to take the look from (${levels}), so it was not added; add it as a heading of a level the document uses, or as a clause after a paragraph of the kind wanted`;
}

// After a heading is added or removed the contents page is out of date.
// Marking its field dirty makes Word rebuild it when the file is opened;
// the field's own text is left as it is. A field's instruction can be
// split over several runs, and other fields (a PAGEREF on each entry) sit
// inside the contents field's result.
function markTocDirty(xml) {
  const toc = (instr) => /^\s*TOC\b/i.test(instr);
  const marks = [];
  const stack = [];
  for (const m of xml.matchAll(/<w:fldChar\b[^>]*>|<w:instrText\b[^>]*>([^<]*)<\/w:instrText>|<w:fldSimple\b[^>]*>/g)) {
    const tag = m[0];
    if (tag.startsWith("<w:fldSimple")) {
      if (toc(decodeXml(attr(tag, "w:instr") ?? ""))) marks.push({ at: m.index, tag });
    } else if (tag.startsWith("<w:instrText")) {
      if (stack.length) stack[stack.length - 1].instr += decodeXml(m[1]);
    } else {
      const type = attr(tag, "w:fldCharType");
      if (type === "begin") stack.push({ at: m.index, tag, instr: "" });
      else if (type === "separate" || type === "end") {
        const top = type === "end" ? stack.pop() : stack[stack.length - 1];
        if (top && !top.decided) {
          top.decided = true;
          if (toc(top.instr)) marks.push(top);
        }
      }
    }
  }
  for (const { at, tag } of marks.sort((a, b) => b.at - a.at)) {
    const dirty = /\sw:dirty="[^"]*"/.test(tag)
      ? tag.replace(/\sw:dirty="[^"]*"/, ' w:dirty="true"')
      : tag.replace(/^(<w:(?:fldChar|fldSimple))/, '$1 w:dirty="true"');
    xml = xml.slice(0, at) + dirty + xml.slice(at + tag.length);
  }
  return xml;
}

// A paragraph the AI itself added on an earlier turn and nobody has accepted
// yet. Word does not track the deletion of an unaccepted insertion — it just
// removes it — and a change to one belongs inside the same insertion rather
// than as a redline within an addition.
//
// It is the AI's own only while every insertion in it — the paragraph mark's
// and the body's — is by the AI and nothing has been struck out or typed in.
// Once anyone else has an insertion in it, or text sits outside the AI's,
// their words are in the paragraph and a change to it is tracked as a
// redline like any other. Comment anchors, bookmarks and the like are not
// words and do not count.
function isOwnInsertion(pXml) {
  if (/<w:del[\s>]/.test(pXml)) return false;
  const marks = [...pXml.matchAll(/<w:ins\s[^>]*?>/g)];
  if (!marks.length || marks.some((m) => attr(m[0], "w:author") !== DOCX_AUTHOR)) return false;
  for (const it of ownInsertionBody(pXml)) {
    if (it.kind === "raw" || it.kind === "ins") continue;
    if (it.kind === "run" && it.text === "" && it.splittable) continue;
    return false;
  }
  return true;
}

// The paragraph's body, without its opening tag and properties, in tokens.
function ownInsertionBody(pXml) {
  const pPr = child(pXml, "w:pPr") ?? "";
  return tokenize(pXml.replace(/^<w:p(?:\s[^>]*)?>/, "").replace(/<\/w:p>$/, "").replace(pPr, ""));
}

// The AI's insertions become one new insertion where the first of them
// stood; everything else in the body — a comment's range, a bookmark —
// stays where it is.
function rewriteOwnInsertion(pXml, text, stamp) {
  const baseRPr = firstRunRPr(pXml);
  const pPr = child(pXml, "w:pPr") ?? "";
  const fresh = { kind: "raw", xml: `<w:ins ${stamp()}>${runsFor(text.trim(), baseRPr)}</w:ins>` };
  let placed = false;
  const kept = ownInsertionBody(pXml).flatMap((it) => {
    if (it.kind !== "ins") return [it];
    if (placed) return [];
    placed = true;
    return [fresh];
  });
  if (!placed) kept.push(fresh);
  return `${/^<w:p(?:\s[^>]*)?>/.exec(pXml)?.[0] ?? "<w:p>"}${pPr}${serialize(kept)}</w:p>`;
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

// The highest id in any story part of the file, or the caller's floor if
// that is higher: ids recorded for this document earlier may be gone from
// the file (decided in Word) and must still never be minted again.
function idFloorOf(entries, idFloor) {
  let floor = Math.max(9000, Number(idFloor) || 0);
  for (const part of Object.keys(entries).filter((p) => STORY_PART.test(p))) floor = maxIdIn(dec.decode(entries[part]), floor);
  return floor;
}

// `signal`: an AbortSignal a caller with a deadline passes (the connector's
// fill_standard_to_project); the work stops at the next part and at the next
// fallback operation once it is aborted, throwing the signal's reason. Hub
// callers pass none.
//
// `kinds`: the open pack's kinds list ({ kinds, tables, footnote }, see
// validateKinds), which the "write" operation takes its formatting from.
// Without it "write" is refused and the other operations work as ever.
export async function applyDocxOps(bytes, ops, byRef, { idFloor, signal, kinds } = {}) {
  const entries = readZip(bytes); const original = xmlParts(entries);
  const groups = new Map(); const results = []; let applied = 0;
  for (let i = 0; i < ops.length; i++) {
    const raw = ops[i];
    // A block operation names its paragraphs by more than "p"; "expected"
    // is checked against the one it is mainly about.
    const block = BLOCK_OPS[String(raw?.op ?? '').toLowerCase()];
    const ref = byRef.get(Number(block ? raw?.[block.main] : raw?.p));
    // A refused change still says what it was aimed at, so it can be shown.
    const reject = reason => results.push({ i, kind: raw?.op, p: block ? raw?.[block.main] : raw?.p, text: raw?.text, status: 'skipped', reason, original: ref?.exactText ?? (typeof raw?.expected === 'string' ? raw.expected : null) });
    if (!ref || !ref.shown) { reject('Paragraph was not supplied to this turn; request that section first.'); continue; }
    if (typeof raw.expected !== 'string' || raw.expected !== ref.exactText) { reject('Expected paragraph text does not match the source; no change was made.'); continue; }
    if (String(raw.op).toLowerCase() === 'comment' && ref.part !== 'word/document.xml') { reject('Word does not allow comments in headers, footers or notes.'); continue; }
    const local = {};
    if (block) {
      const problem = block.refs.map((key) => {
        if (raw[key] === undefined && !block.required.includes(key)) return null;
        const other = byRef.get(Number(raw[key]));
        if (!other || !other.shown) return `¶${raw[key]} ("${key}") was not supplied to this turn; request that section first.`;
        if (other.part !== 'word/document.xml') return `${raw.op} works in the body of the document only, not in headers, footers or notes.`;
        local[key] = other.localIndex;
        return null;
      }).find(Boolean);
      if (problem) { reject(problem); continue; }
    }
    const list = groups.get(ref.part) ?? [];
    list.push({ raw: { ...raw, ...local, p: ref.localIndex, clause: clauseFor(byRef, ref) }, ref, i }); groups.set(ref.part, list);
  }
  // Which body paragraphs the turn was shown: a block is only repeated or
  // removed when every paragraph of it with words in it was seen.
  const shown = ops.some((raw) => BLOCK_OPS[String(raw?.op ?? '').toLowerCase()])
    ? new Set([...byRef.values()].filter((r) => r.shown && r.part === 'word/document.xml').map((r) => r.localIndex))
    : null;
  // One counter for the whole call, carried from part to part.
  let maxId = idFloorOf(entries, idFloor);
  for (const [part, work] of groups) {
    signal?.throwIfAborted();
    const refs = new Map(work.map(w => [w.ref.localIndex, w.ref]));
    const output = await applyPartOps(writeZip({ ...entries, 'word/document.xml': entries[part] }), work.map(w => w.raw), refs, { idFloor: maxId, signal, ...(shown ? { kinds, shown } : {}) });
    maxId = Math.max(maxId, output.maxId);
    // A block operation may also have written the numbering (a list started
    // again), the notes, and the package's lists of its parts.
    const written = readZip(output.bytes);
    for (const name of output.extra ?? []) entries[name] = written[name];
    entries[part] = written['word/document.xml'];
    if (part === 'word/document.xml') writeComments(entries, output.comments ?? []);
    for (const result of output.results) { const w = work[result.i]; results.push({ ...result, i: w.i, p: w.ref.index, part }); }
    applied += output.applied;
  }
  validateXml(entries);
  const quality = inspectPackage(xmlParts(entries));
  if (quality.errors.length) throw new Error(`Edited file failed structural checks: ${quality.errors.join('; ')}`);
  const format = compareFormat(xmlParts(entries), original);
  const output = writeZip(entries);
  return { bytes: output, applied, results: results.sort((a,b) => a.i-b.i), maxId, validation: { ...quality, format, sourceHash: createHash('sha256').update(bytes).digest('hex'), outputHash: createHash('sha256').update(output).digest('hex') } };
}

// ---------------------------------------------------------------- blocks
//
// Four operations work on whole stretches of the body rather than on one
// paragraph: write paragraphs of a named kind, repeat a block, add a table
// row, remove a block. Each is checked against the paragraph its "expected"
// text names (`main`); the others it reaches (`refs`) must have been shown.
// They work on the body only, and only on the inline path.
const BLOCK_OPS = {
  write: { main: "after", refs: ["after"], required: ["after"] },
  repeat_block: { main: "from", refs: ["from", "to", "after"], required: ["from", "to", "after"] },
  add_row: { main: "like_row", refs: ["like_row", "table"], required: ["like_row"] },
  remove_block: { main: "from", refs: ["from", "to"], required: ["from", "to"] },
};

const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NOTE_PARTS = {
  footnote: ["application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml", `${R_NS}/footnotes`],
  endnote: ["application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml", `${R_NS}/endnotes`],
};

// The kinds list a pack carries (written by the pack builder, read here):
// { kinds: { name: { pPr, rPr, styleId, numId, ilvl, label } },
//   tables: { name: { tblPr, tblGrid, header: { trPr, tcPr, pPr, rPr }, body: {…}, label } },
//   footnote: { pPr, rPr, refRPr } | null }
// One optional key beyond that: a paragraph kind with "restart": false is a
// list that runs on through the document (paragraphs numbered 1, 2, 3 across
// unnumbered headings) and is never started again by "write".
function kindOf(kinds, block) {
  const name = typeof block?.kind === "string" ? block.kind : null;
  if (!name || !kinds) return null;
  if (name === "footnote") return kinds.footnote ? { type: "footnote", spec: kinds.footnote, name } : null;
  if (kinds.kinds && Object.hasOwn(kinds.kinds, name)) return { type: "paragraph", spec: kinds.kinds[name], name };
  const table = name === "table" && typeof block.like === "string" ? block.like : name;
  if (kinds.tables && Object.hasOwn(kinds.tables, table)) return { type: "table", spec: kinds.tables[table], name: table };
  return null;
}
const kindNames = (kinds) => {
  const names = [...Object.keys(kinds?.kinds ?? {}), ...(kinds?.footnote ? ["footnote"] : []), ...Object.keys(kinds?.tables ?? {})];
  return names.length ? names.join(", ") : "none";
};

// What a block operation is, for its record: its paragraphs, and the words
// it writes, so the lawyer's change list can show them.
function blockFields(kind, raw, ref) {
  const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  if (kind === "write") {
    const blocks = Array.isArray(raw?.blocks) ? raw.blocks : null;
    const words = (b) => (typeof b?.text === "string" ? b.text : Array.isArray(b?.rows) ? b.rows.map((r) => (Array.isArray(r) ? r.join(" | ") : "")).join("\n") : "");
    return { after: num(raw.after), blocks, text: (blocks ?? []).map(words).filter(Boolean).join("\n"), original: "", anchor: ref.exactText };
  }
  if (kind === "add_row") {
    const cells = Array.isArray(raw?.cells) ? raw.cells : null;
    return { table: num(raw.table), like_row: num(raw.like_row), cells, text: (cells ?? []).map((c) => String(c ?? "")).join(" | "), original: "", anchor: ref.exactText };
  }
  if (kind === "repeat_block") return { from: num(raw.from), to: num(raw.to), after: num(raw.after), original: "", anchor: ref.exactText };
  return { from: num(raw.from), to: num(raw.to), original: ref.exactText };
}

// Why a block operation cannot be made, judged from the operation alone.
function blockProblem(op, kinds) {
  if (op.kind === "write") {
    if (!op.blocks?.length) return 'write needs "blocks": a list of {"kind": …, "text": …}';
    if (!kinds || typeof kinds !== "object") return "no kinds of paragraph are listed for this document (no firm pack is open), so nothing can be written by kind; use insert_after instead";
    let previous = null;
    for (const [n, block] of op.blocks.entries()) {
      const k = kindOf(kinds, block);
      if (!k) return `this document's pack has no kind "${block?.kind}", so nothing in this write was added; the kinds are ${kindNames(kinds)}`;
      if (k.type === "table") {
        const ok = Array.isArray(block.rows) && block.rows.length && block.rows.every((r) => Array.isArray(r) && r.length && r.every((c) => typeof c === "string"));
        if (!ok) return `the table "${block.kind}" (block ${n + 1}) needs "rows": a list of rows, each a list of cell texts`;
      } else if (typeof block.text !== "string" || !block.text.trim()) {
        return `block ${n + 1} ("${block.kind}") has no text`;
      }
      if (k.type === "footnote" && previous !== "paragraph" && previous !== "footnote") return `a footnote goes on the paragraph written just before it, and block ${n + 1} has none before it`;
      previous = k.type;
    }
    return null;
  }
  if (op.kind === "repeat_block" || op.kind === "remove_block") {
    if (!Number.isFinite(op.from) || !Number.isFinite(op.to)) return `${op.kind} needs "from" and "to"`;
    if (op.to < op.from) return `"to" (¶${op.to}) comes before "from" (¶${op.from})`;
    if (op.kind === "repeat_block" && !Number.isFinite(op.after)) return 'repeat_block needs "after"';
    return null;
  }
  if (op.kind === "add_row" && !(op.cells?.length && op.cells.every((c) => typeof c === "string"))) return 'add_row needs "cells": the text of each cell, left to right';
  return null;
}

// The elements named, at the top level of xml[from, to): nested ones (a
// table in a cell, a text box's paragraphs inside a run) are inside the
// element that holds them, never listed on their own.
function topLevel(xml, names, from = 0, to = xml.length) {
  const re = new RegExp(`<(\\/?)w:(${names.join("|")})(?=[\\s/>])[^>]*?(\\/?)>`, "g");
  re.lastIndex = from;
  const out = [];
  let depth = 0;
  let open = null;
  for (let m; (m = re.exec(xml)) && m.index < to; ) {
    if (m[1]) {
      if (--depth === 0 && open) { out.push({ name: open.name, start: open.start, end: m.index + m[0].length }); open = null; }
    } else if (m[3]) {
      if (depth === 0) out.push({ name: m[2], start: m.index, end: m.index + m[0].length });
    } else if (depth++ === 0) {
      open = { name: m[2], start: m.index };
    }
  }
  return out;
}

// Every element of one name, at any depth.
function allOf(xml, name) {
  const re = new RegExp(`<(\\/?)w:${name}(?=[\\s/>])[^>]*?(\\/?)>`, "g");
  const out = [];
  const stack = [];
  for (let m; (m = re.exec(xml)); ) {
    if (m[1]) { const start = stack.pop(); if (start !== undefined) out.push({ start, end: m.index + m[0].length }); }
    else if (m[2]) out.push({ start: m.index, end: m.index + m[0].length });
    else stack.push(m.index);
  }
  return out;
}

const PROP_CHANGES = /<w:(pPrChange|rPrChange|sectPrChange|tblPrChange|tblPrExChange|trPrChange|tcPrChange|tblGridChange|numberingChange)\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/w:\1>)/g;
// Properties copied for a new element: no record of an earlier change and
// no revision mark of anyone's.
const withoutChanges = (xml) => (xml ?? "").replace(PROP_CHANGES, "").replace(/<w:(?:ins|del|cellIns|cellDel|cellMerge)\b[^>]*\/>/g, "");

// A copy of some of the document as a reader sees it: other people's
// insertions taken in, their deletions left out, no record of formatting
// changes, no comment anchors (the copy is not what the comment was about).
function readerCopy(xml) {
  return xml
    .replace(PROP_CHANGES, "")
    .replace(/<w:(del|moveFrom)\b(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/w:\1>/g, "")
    .replace(/<w:(?:ins|del|moveFrom|moveTo|cellIns|cellDel|cellMerge)\b[^>]*\/>/g, "")
    .replace(/<\/?w:(?:ins|moveTo)\b[^>]*>/g, "")
    .replace(/<w:(?:moveFromRange|moveToRange|customXmlInsRange|customXmlDelRange|customXmlMoveFromRange|customXmlMoveToRange)(?:Start|End)\b[^>]*\/>/g, "")
    .replace(/<w:comment(?:RangeStart|RangeEnd)\b[^>]*\/>/g, "")
    .replace(/<w:r(?:\s[^>]*)?>(?:(?!<\/?w:r[\s>])[\s\S])*?<\/w:r>/g, (r) => (r.includes("<w:commentReference") ? "" : r));
}

// Runs (and run-level content controls) wrapped in our insertion, one
// insertion per stretch of them; a hyperlink or simple field is not allowed
// inside an insertion, so its own runs are wrapped inside it instead.
function wrapRuns(xml, stamp) {
  let out = "";
  let group = "";
  let hasRun = false;
  let at = 0;
  const flush = () => { out += hasRun ? `<w:ins ${stamp()}>${group}</w:ins>` : group; group = ""; hasRun = false; };
  for (const el of topLevel(xml, ["r", "sdt", "hyperlink", "smartTag", "fldSimple", "customXml"])) {
    group += xml.slice(at, el.start);
    at = el.end;
    const x = xml.slice(el.start, el.end);
    if (el.name === "r" || el.name === "sdt") { group += x; hasRun = true; continue; }
    flush();
    const open = /^<w:\w+(?:\s[^>]*)?>/.exec(x)[0];
    if (open === x) { out += x; continue; }
    const close = x.lastIndexOf("</");
    out += open + wrapRuns(x.slice(open.length, close), stamp) + x.slice(close);
  }
  group += xml.slice(at);
  flush();
  return out;
}

const expandEmpty = (pXml) => pXml.replace(/^<w:p(\s[^>]*?)?\s*\/>$/, (_, a = "") => `<w:p${a}></w:p>`);

// One paragraph of a copy, marked as inserted: paragraph mark and runs.
function insertedParagraph(pXml, stamp) {
  const p = expandEmpty(pXml);
  const open = /^<w:p(?:\s[^>]*)?>/.exec(p)[0];
  const pPr = paraPropsOf(p);
  const rest = p.slice(open.length);
  const lead = /^\s*/.exec(rest)[0];
  const content = (pPr ? rest.slice(lead.length + pPr.length) : rest).slice(0, -"</w:p>".length);
  return `${open}${markParagraphMark(copiedPPr(pPr), "ins", stamp)}${wrapRuns(content, stamp)}</w:p>`;
}

// A table row's properties with our mark added (CT_TrPr: the mark comes
// after the row's own settings).
function rowMark(trPr, mark) {
  const x = withoutChanges(trPr);
  if (!x || /^<w:trPr\s*\/>$/.test(x)) return `<w:trPr>${mark}</w:trPr>`;
  return x.replace(/<\/w:trPr>$/, `${mark}</w:trPr>`);
}
// The start of a row (<w:tr>, its exceptions, its properties) with a mark
// on the row's properties.
function markRow(head, mark) {
  const at = head.indexOf("<w:trPr");
  if (at < 0) return `${head}<w:trPr>${mark}</w:trPr>`;
  const self = /^<w:trPr\s*\/>/.exec(head.slice(at));
  const end = self ? at + self[0].length : head.lastIndexOf("</w:trPr>") + "</w:trPr>".length;
  return head.slice(0, at) + rowMark(head.slice(at, end), mark) + head.slice(end);
}
// The same, for a deletion: anyone else's marks on the row stay.
function markRowDeleted(head, mark) {
  const at = head.indexOf("<w:trPr");
  if (at < 0) return `${head}<w:trPr>${mark}</w:trPr>`;
  const self = /^<w:trPr\s*\/>/.exec(head.slice(at));
  if (self) return head.slice(0, at) + `<w:trPr>${mark}</w:trPr>` + head.slice(at + self[0].length);
  const end = head.lastIndexOf("</w:trPr>");
  const change = head.indexOf("<w:trPrChange", at);
  const into = change >= 0 && change < end ? change : end;
  return head.slice(0, into) + mark + head.slice(into);
}
const rowParts = (tr) => {
  const cells = topLevel(tr, ["tc"]);
  return { cells, headEnd: cells.length ? cells[0].start : tr.lastIndexOf("</w:tr>") };
};
const cellParts = (tc) => {
  const open = /^<w:tc(?:\s[^>]*)?>/.exec(tc)[0];
  return { open, inner: tc.slice(open.length, -"</w:tc>".length) };
};

// Paragraphs and tables (body or cell content) copied and marked inserted.
function insertedBlocks(xml, stamp) {
  let out = "";
  let at = 0;
  for (const el of topLevel(xml, ["p", "tbl"])) {
    out += readerCopy(xml.slice(at, el.start));
    at = el.end;
    const x = xml.slice(el.start, el.end);
    out += el.name === "p" ? insertedParagraph(readerCopy(x), stamp) : insertedTable(x, stamp);
  }
  return out + readerCopy(xml.slice(at));
}
function insertedTable(tbl, stamp) {
  let out = "";
  let at = 0;
  for (const row of topLevel(tbl, ["tr"])) {
    out += readerCopy(tbl.slice(at, row.start));
    at = row.end;
    const tr = tbl.slice(row.start, row.end);
    const { cells, headEnd } = rowParts(tr);
    // A row someone deleted is not part of what a reader sees.
    if (/<w:del\b/.test(tr.slice(0, headEnd).replace(PROP_CHANGES, ""))) continue;
    let o = markRow(readerCopy(tr.slice(0, headEnd)), `<w:ins ${stamp()}/>`);
    let k = headEnd;
    for (const c of cells) {
      o += readerCopy(tr.slice(k, c.start));
      k = c.end;
      const { open, inner } = cellParts(tr.slice(c.start, c.end));
      o += `${open}${insertedBlocks(inner, stamp)}</w:tc>`;
    }
    out += o + readerCopy(tr.slice(k));
  }
  return out + readerCopy(tbl.slice(at));
}

// A table struck through: each row marked deleted, each paragraph in it
// struck out with its mark.
function deletedBlocks(xml, stamp) {
  let out = "";
  let at = 0;
  for (const el of topLevel(xml, ["p", "tbl"])) {
    out += xml.slice(at, el.start);
    at = el.end;
    const x = xml.slice(el.start, el.end);
    out += el.name === "p" ? deleteParagraph(expandEmpty(x), stamp) : deletedTable(x, stamp);
  }
  return out + xml.slice(at);
}
function deletedTable(tbl, stamp) {
  let out = "";
  let at = 0;
  for (const row of topLevel(tbl, ["tr"])) {
    out += tbl.slice(at, row.start);
    at = row.end;
    const tr = tbl.slice(row.start, row.end);
    const { cells, headEnd } = rowParts(tr);
    let o = markRowDeleted(tr.slice(0, headEnd), `<w:del ${stamp()}/>`);
    let k = headEnd;
    for (const c of cells) {
      o += tr.slice(k, c.start);
      k = c.end;
      const { open, inner } = cellParts(tr.slice(c.start, c.end));
      o += `${open}${deletedBlocks(inner, stamp)}</w:tc>`;
    }
    out += o + tr.slice(k);
  }
  return out + tbl.slice(at);
}

// A new table from a table kind: the kind's table properties, its header
// row's formatting for the first row and its body row's for the rest.
function tableFromKind(spec, rows, stamp) {
  const n = Math.max(...rows.map((r) => r.length));
  const tblPr = withoutChanges(spec.tblPr || "<w:tblPr/>");
  let grid = spec.tblGrid ? withoutChanges(spec.tblGrid) : null;
  let widths = grid ? [...grid.matchAll(/<w:gridCol\b[^>]*?\bw:w="(\d+)"/g)].map((m) => Number(m[1])) : [];
  if (widths.length !== n) {
    const tblW = /<w:tblW\b[^>]*?\bw:w="(\d+)"[^>]*?\bw:type="dxa"/.exec(tblPr)?.[1];
    const total = widths.reduce((a, b) => a + b, 0) || Number(tblW) || 9026;
    widths = Array.from({ length: n }, () => Math.floor(total / n));
    grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  }
  const cellProps = (tcPr, width) => {
    const x = withoutChanges(tcPr).replace(/<w:(?:gridSpan|vMerge|hMerge)\b[^>]*\/>/g, "");
    if (!x || /^<w:tcPr\s*\/>$|^<w:tcPr><\/w:tcPr>$/.test(x)) return `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>`;
    return x.replace(/<w:tcW\b[^>]*\/>/, `<w:tcW w:w="${width}" w:type="dxa"/>`);
  };
  const cell = (s, width, text) => `<w:tc>${cellProps(s.tcPr ?? "", width)}<w:p>${markParagraphMark(copiedPPr(s.pPr ?? ""), "ins", stamp)}${text.trim() ? `<w:ins ${stamp()}>${runsFor(text.trim(), s.rPr ?? "")}</w:ins>` : ""}</w:p></w:tc>`;
  const row = (cells, s) => `<w:tr>${rowMark(s.trPr ?? "", `<w:ins ${stamp()}/>`)}${widths.map((w, k) => cell(s, w, cells[k] ?? "")).join("")}</w:tr>`;
  return `<w:tbl>${tblPr}${grid}${rows.map((cells, r) => row(cells, (r === 0 ? spec.header : spec.body) ?? {})).join("")}</w:tbl>`;
}

// A paragraph's section break, whole (a recorded change to it sits inside).
function sectionBreakOf(pXml) {
  const pPr = paraPropsOf(pXml);
  const at = pPr.indexOf("<w:sectPr");
  if (at < 0) return null;
  const self = /^<w:sectPr\b[^>]*\/>/.exec(pPr.slice(at));
  return self ? self[0] : pPr.slice(at, pPr.lastIndexOf("</w:sectPr>") + "</w:sectPr>".length);
}
// A paragraph's section break put on a paragraph that has none: in its
// properties, before any recorded formatting change (CT_PPr order).
function withSectionBreak(pXml, sect) {
  const p = expandEmpty(pXml);
  const open = /^<w:p(?:\s[^>]*)?>/.exec(p)[0];
  const pPr = paraPropsOf(p);
  if (!pPr) return `${open}<w:pPr>${sect}</w:pPr>${p.slice(open.length)}`;
  let into;
  if (/\/>$/.test(pPr)) into = `<w:pPr>${sect}</w:pPr>`;
  else {
    const change = pPr.indexOf("<w:pPrChange");
    const at = change >= 0 ? change : pPr.length - "</w:pPr>".length;
    into = pPr.slice(0, at) + sect + pPr.slice(at);
  }
  const at = p.indexOf(pPr, open.length);
  return p.slice(0, at) + into + p.slice(at + pPr.length);
}

// What the block operations need of the file: where each body element
// starts and ends, the lists and which of them number headings, the notes,
// and ids no element of the file uses yet.
function blockContext({ entries, pristineXml, headings, stamp }) {
  const text = (name) => (entries[name] ? dec.decode(entries[name]) : null);
  const open = /<w:body(?:\s[^>]*)?>/.exec(pristineXml);
  const body = open ? topLevel(pristineXml, ["p", "tbl", "sdt", "customXml"], open.index + open[0].length, pristineXml.lastIndexOf("</w:body>")) : [];
  const holderOf = (pos) => {
    let lo = 0;
    let hi = body.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pos < body[mid].start) hi = mid - 1;
      else if (pos >= body[mid].end) lo = mid + 1;
      else return body[mid];
    }
    return null;
  };
  let rows = null;
  let tables = null;
  const innermost = (name, pos) => {
    const list = name === "tr" ? (rows ??= allOf(pristineXml, "tr")) : (tables ??= allOf(pristineXml, "tbl"));
    let best = null;
    for (const x of list) if (x.start < pos && pos < x.end && (!best || x.start > best.start)) best = x;
    return best;
  };

  // Lists: which list format (abstractNum) each list (num) follows, and
  // the style each paragraph style takes its numbering from.
  let numbering = text("word/numbering.xml");
  let numberingChanged = false;
  const abstracts = new Map();
  const numAbs = new Map();
  for (const m of (numbering ?? "").matchAll(/<w:abstractNum\b[^>]*?\bw:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) abstracts.set(m[1], m[2]);
  for (const m of (numbering ?? "").matchAll(/<w:num\b[^>]*?\bw:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) numAbs.set(m[1], /<w:abstractNumId w:val="(\d+)"/.exec(m[2])?.[1] ?? null);
  const styleNum = new Map();
  const basedOn = new Map();
  for (const m of (text("word/styles.xml") ?? "").matchAll(/<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const n = /<w:numId w:val="(\d+)"/.exec(m[2])?.[1];
    if (n) styleNum.set(m[1], n);
    const b = attr(child(m[2], "w:basedOn") ?? "", "w:val");
    if (b) basedOn.set(m[1], b);
  }
  const numOfStyle = (id, seen = new Set()) => {
    if (!id || seen.has(id)) return null;
    seen.add(id);
    return styleNum.get(id) ?? numOfStyle(basedOn.get(id), seen);
  };
  const styleOf = (pPr) => attr(child(pPr ?? "", "w:pStyle") ?? "", "w:val");
  const listOf = (pPr) => {
    const own = copiedPPr(pPr ?? "");
    const direct = /<w:numId w:val="(\d+)"/.exec(own)?.[1];
    const numId = direct ?? numOfStyle(styleOf(own));
    if (!numId || numId === "0") return null;
    return { numId, abstract: numAbs.get(numId) ?? null, direct: direct !== undefined };
  };
  // A list that numbers headings runs through the whole document (clause
  // 1, 1.1, 2 …) and is never started again.
  const headingAbstracts = new Set();
  for (const id of headings.map.keys()) {
    const a = numAbs.get(numOfStyle(id));
    if (a != null) headingAbstracts.add(a);
  }
  for (const [id, x] of abstracts) for (const m of x.matchAll(/<w:pStyle w:val="([^"]+)"/g)) if (headings.map.has(m[1])) headingAbstracts.add(id);
  // A list started again: a new w:num on the same list format, starting
  // the level at the format's own first number.
  const restart = (abstract, ilvl) => {
    const id = String(Math.max(0, ...[...numAbs.keys()].map(Number)) + 1);
    const lvl = new RegExp(`<w:lvl\\b[^>]*?\\bw:ilvl="${ilvl}"[^>]*>([\\s\\S]*?)<\\/w:lvl>`).exec(abstracts.get(abstract) ?? "");
    const start = /<w:start w:val="(\d+)"/.exec(lvl?.[1] ?? "")?.[1] ?? "1";
    const xml = `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstract}"/><w:lvlOverride w:ilvl="${ilvl}"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`;
    const last = numbering.lastIndexOf("</w:num>");
    const mac = numbering.indexOf("<w:numIdMacAtCleanup");
    const at = last >= 0 ? last + "</w:num>".length : mac >= 0 ? mac : numbering.lastIndexOf("</w:numbering>");
    numbering = numbering.slice(0, at) + xml + numbering.slice(at);
    numAbs.set(id, abstract);
    numberingChanged = true;
    return id;
  };

  // Ids nothing in the file uses: paragraph ids, drawing ids, bookmark names.
  let used = null;
  const ids = () => (used ??= (() => {
    const all = Object.keys(entries).filter((n) => STORY_PART.test(n)).map((n) => (n === "word/document.xml" ? pristineXml : dec.decode(entries[n]))).join("");
    return {
      para: new Set([...all.matchAll(/\bw14:(?:paraId|textId)="([0-9A-Fa-f]{8})"/g)].map((m) => m[1].toUpperCase())),
      docPr: [...all.matchAll(/<wp:docPr\b[^>]*?\sid="(\d+)"/g)].reduce((n, m) => Math.max(n, Number(m[1])), 0),
      names: new Set([...all.matchAll(/<w:bookmarkStart\b[^>]*?\bw:name="([^"]*)"/g)].map((m) => m[1])),
      next: 0x2b000000,
    };
  })());
  const paraId = () => {
    const u = ids();
    let v;
    do v = (u.next++).toString(16).toUpperCase().padStart(8, "0"); while (u.para.has(v));
    u.para.add(v);
    return v;
  };
  const bookmarkName = (name) => {
    const u = ids();
    for (let n = 1; ; n++) {
      const c = `${name.slice(0, 33)}_${n}`;
      if (!u.names.has(c)) { u.names.add(c); return c; }
    }
  };

  // The notes parts, read when first needed and written back at the end.
  const noteParts = {};
  const notePart = (kind) => (noteParts[kind] ??= { name: `word/${kind}s.xml`, kind, xml: text(`word/${kind}s.xml`), created: false, changed: false });
  const notes = {
    add(kind, inner) {
      const part = notePart(kind);
      if (!part.xml) {
        part.xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${kind}s xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:w14="${W14_NS}"><w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}></w:${kind}s>`;
        part.created = true;
      }
      const id = [...part.xml.matchAll(new RegExp(`<w:${kind}\\b[^>]*?\\bw:id="(-?\\d+)"`, "g"))].reduce((n, m) => Math.max(n, Number(m[1])), 0) + 1;
      part.xml = part.xml.replace(new RegExp(`</w:${kind}s>\\s*$`), `<w:${kind} w:id="${id}">${inner}</w:${kind}></w:${kind}s>`);
      part.changed = true;
      return id;
    },
    // A copied paragraph's footnote is a copy of the footnote: one note is
    // never referred to twice.
    copy(kind, id, st) {
      const part = notePart(kind);
      const m = part.xml && new RegExp(`<w:${kind}\\b(?=[^>]*\\bw:id="${id}")[^>]*>([\\s\\S]*?)</w:${kind}>`).exec(part.xml);
      return m ? notes.add(kind, fresh(insertedBlocks(m[1], st), st)) : null;
    },
  };

  // A copy given ids of its own: paragraph ids, drawing ids, bookmarks (a
  // bookmark only half inside the copy is left out), and its own notes.
  function fresh(xml, st) {
    const u = ids();
    let out = xml.replace(/\bw14:(paraId|textId)="[0-9A-Fa-f]{8}"/g, (_, k) => `w14:${k}="${paraId()}"`);
    out = out.replace(/(<wp:docPr\b[^>]*?\sid=")\d+"/g, (_, head) => `${head}${++u.docPr}"`);
    const starts = new Map();
    const ends = new Set();
    for (const m of out.matchAll(/<w:bookmarkStart\b[^>]*\/>/g)) starts.set(attr(m[0], "w:id"), attr(m[0], "w:name") ?? "_Copy");
    for (const m of out.matchAll(/<w:bookmarkEnd\b[^>]*\/>/g)) ends.add(attr(m[0], "w:id"));
    const map = new Map();
    for (const [id, name] of starts) if (ends.has(id)) map.set(id, { id: stamp.next(), name: bookmarkName(name) });
    out = out.replace(/<w:bookmark(?:Start|End)\b[^>]*\/>/g, (tag) => {
      const to = map.get(attr(tag, "w:id"));
      if (!to) return "";
      const t = tag.replace(/\bw:id="[^"]*"/, `w:id="${to.id}"`);
      return tag.startsWith("<w:bookmarkStart") ? t.replace(/\bw:name="[^"]*"/, `w:name="${to.name}"`) : t;
    });
    return out.replace(/<w:(footnote|endnote)Reference\b([^>]*?)\bw:id="(-?\d+)"/g, (m, kind, pre, id) => {
      const n = notes.copy(kind, id, st);
      return n == null ? m : `<w:${kind}Reference${pre}w:id="${n}"`;
    });
  }

  const ctx = {
    body, holderOf, innermost, listOf, restart, fresh, notes,
    abstractOf: (numId) => numAbs.get(numId) ?? null,
    heading: false,
    isHeading: (pPr, spec) => headings.map.has(spec?.styleId ?? styleOf(pPr)),
    headingList: (abstract, styleId) => headingAbstracts.has(abstract) || headings.map.has(styleId),
    styleOf,
    // The parts other than the body that were written, put in the package.
    finish(target) {
      const names = [];
      if (numberingChanged) { target["word/numbering.xml"] = enc.encode(numbering); names.push("word/numbering.xml"); }
      for (const part of Object.values(noteParts)) {
        if (!part.changed) continue;
        target[part.name] = enc.encode(part.xml);
        names.push(part.name);
        if (!part.created) continue;
        const [type, rel] = NOTE_PARTS[part.kind];
        const types = dec.decode(target["[Content_Types].xml"]);
        if (!types.includes(`PartName="/${part.name}"`)) target["[Content_Types].xml"] = enc.encode(types.replace("</Types>", `<Override PartName="/${part.name}" ContentType="${type}"/></Types>`));
        const relsPath = "word/_rels/document.xml.rels";
        const rels = target[relsPath] ? dec.decode(target[relsPath]) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
        if (!rels.includes(rel)) {
          let rid = 1;
          while (rels.includes(`Id="rIdAkla${part.kind}${rid}"`)) rid++;
          target[relsPath] = enc.encode(rels.replace("</Relationships>", `<Relationship Id="rIdAkla${part.kind}${rid}" Type="${rel}" Target="${part.kind}s.xml"/></Relationships>`));
        }
        names.push("[Content_Types].xml", relsPath);
      }
      return [...new Set(names)];
    },
  };
  return ctx;
}

// Works out every block operation against the file as it arrived, as
// splices of the body (start, end, and the XML to put there, made when the
// splice is applied so its revision ids follow on from the turn's).
// `blocks(index)` says why a paragraph change cannot be made (it is inside
// a block being removed). Refusals are added to `results` as they are found.
function planBlocks({ blockOps, parsed, entries, pristineXml, paragraphs, byIndex, headings, stamp, kinds, shown, results }) {
  const ctx = blockContext({ entries, pristineXml, headings, stamp });
  const { body } = ctx;
  const splices = [];
  const removed = [];
  const refuse = (op, reason) => results.push({ ...op, status: "skipped", reason });
  const within = (box) => paragraphs.filter((p) => p.start >= box.start && p.end <= box.end);

  // ¶from to ¶to as whole body elements, or why not.
  const rangeOf = (op, removing) => {
    const a = byIndex.get(op.from);
    const b = byIndex.get(op.to);
    const first = a && ctx.holderOf(a.start);
    const last = b && ctx.holderOf(b.start);
    if (!first || !last) return { error: `¶${!first ? op.from : op.to} is not in the body of the document` };
    if (first.name === "tbl" && within(first).find((p) => p.text.trim()) !== a) return { error: `¶${op.from} is inside a table, so the range would cut through it; start at the table's first paragraph, or after the table` };
    if (last.name === "tbl" && within(last).filter((p) => p.text.trim()).pop() !== b) return { error: `¶${op.to} is inside a table, so the range would cut through it; end at the table's last paragraph, or before the table` };
    const firstIndex = body.indexOf(first);
    const elements = body.slice(firstIndex, body.indexOf(last) + 1);
    if (elements.some((e) => e.name !== "p" && e.name !== "tbl")) return { error: `¶${op.from}–¶${op.to} takes in a content control (a contents page, say), which cannot be ${removing ? "removed" : "repeated"} this way` };
    const start = first.start;
    const end = last.end;
    const paras = paragraphs.filter((p) => p.start >= start && p.end <= end);
    const unseen = shown && paras.find((p) => p.text.trim() && !shown.has(p.index));
    if (unseen) return { error: `¶${unseen.index}, inside ¶${op.from}–¶${op.to}, was not supplied to this turn; request that section first` };
    const shape = removing && paras.find((p) => p.formatting);
    if (shape) return { error: `¶${shape.index} holds a text box or shape, which cannot be removed this way` };
    const xml = pristineXml.slice(start, end);
    const count = (t) => (xml.match(new RegExp(`w:fldCharType="${t}"`, "g")) ?? []).length;
    if (count("begin") !== count("end")) return { error: `¶${op.from}–¶${op.to} cuts through a field (the contents page, say), which cannot be split` };
    return { start, end, elements, paras, firstIndex };
  };

  for (const { op } of blockOps) {
    if (op.kind !== "remove_block") continue;
    const r = rangeOf(op, true);
    if (r.error) { refuse(op, r.error); continue; }
    if (removed.some((x) => x.start < r.end && r.start < x.end)) { refuse(op, `¶${op.from}–¶${op.to} overlaps a block another change in this turn removes`); continue; }
    removed.push({ ...r, op });
  }
  const removedAt = (pos) => removed.find((x) => x.start <= pos && pos < x.end);
  const blocks = (index) => {
    const p = byIndex.get(index);
    const x = p && removedAt(p.start);
    return x ? `¶${index} is inside ¶${x.op.from}–¶${x.op.to}, which another change in this turn removes` : null;
  };

  // Paragraphs of a kind, after the anchor's element.
  const writeXml = (op, box, anchor) => {
    const st = stampFor(stamp, op);
    let prev = box.name === "p" ? ctx.listOf(paraPropsOf(pristineXml.slice(anchor.start, anchor.end))) : null;
    const out = [];
    let last = null;
    for (const block of op.blocks) {
      const k = kindOf(kinds, block);
      if (k.type === "footnote") {
        const spec = k.spec;
        const id = ctx.notes.add("footnote", `<w:p>${markParagraphMark(copiedPPr(spec.pPr ?? ""), "ins", st)}<w:ins ${st()}><w:r>${spec.refRPr ?? ""}<w:footnoteRef/></w:r><w:r>${spec.rPr ?? ""}<w:t xml:space="preserve"> </w:t></w:r>${runsFor(block.text.trim(), spec.rPr ?? "")}</w:ins></w:p>`);
        last.refs.push(`<w:r>${spec.refRPr ?? ""}<w:footnoteReference w:id="${id}"/></w:r>`);
        (op.footnotes ??= []).push(id);
        continue;
      }
      if (k.type === "table") {
        out.push(tableFromKind(k.spec, block.rows, st));
        prev = null;
        last = null;
        continue;
      }
      let pPr = copiedPPr(k.spec.pPr ?? "");
      const list = ctx.listOf(pPr);
      if (list?.direct && list.abstract != null && !ctx.headingList(list.abstract, k.spec.styleId ?? ctx.styleOf(pPr))) {
        // The same list as the block before: carry on with it. Another list,
        // or none: start this one again at its first number.
        let numId = list.numId;
        if (prev?.abstract === list.abstract) numId = prev.numId;
        else if (k.spec.restart !== false) {
          numId = ctx.restart(list.abstract, /<w:ilvl w:val="(\d+)"/.exec(pPr)?.[1] ?? k.spec.ilvl ?? "0");
          (op.restarted ??= []).push(numId);
        }
        if (numId !== list.numId) pPr = pPr.replace(/(<w:numId w:val=")\d+(")/, `$1${numId}$2`);
        prev = { abstract: list.abstract, numId };
      } else {
        prev = list;
      }
      if (ctx.isHeading(pPr, k.spec)) ctx.heading = true;
      last = { pPr, rPr: k.spec.rPr ?? "", text: block.text.trim(), refs: [] };
      out.push(last);
    }
    return out.map((x) => (typeof x === "string" ? x : `<w:p>${markParagraphMark(x.pPr, "ins", st)}<w:ins ${st()}>${runsFor(x.text, x.rPr)}${x.refs.join("")}</w:ins></w:p>`)).join("");
  };

  // The lists a pack says run on through the document (restart: false).
  const runsOn = new Set(Object.values(kinds?.kinds ?? {}).filter((k) => k?.restart === false).map((k) => ctx.listOf(k.pPr ?? "")?.abstract).filter((a) => a != null));
  const listAt = (p) => ctx.listOf(paraPropsOf(pristineXml.slice(p.start, p.end)));

  // A copy of whole paragraphs and tables, after the anchor's element. A
  // list group the copy holds from its first item ((a), (b), (c) of a
  // clause) is a group of its own in the copy and starts again at (a); a
  // copy that starts part-way through a group carries on its numbering.
  const repeatXml = (op, r) => {
    const st = stampFor(stamp, op);
    if (r.paras.some((p) => p.headingLevel)) ctx.heading = true;
    op.copied = r.paras.filter((p) => p.text.trim()).length;
    const again = new Set();
    const seen = new Set();
    for (const p of r.paras) {
      const list = listAt(p);
      if (!list?.direct || list.abstract == null || seen.has(list.numId)) continue;
      seen.add(list.numId);
      if (ctx.headingList(list.abstract, ctx.styleOf(paraPropsOf(pristineXml.slice(p.start, p.end)))) || runsOn.has(list.abstract)) continue;
      let q = p.index - 2;
      while (q >= 0 && !paragraphs[q].text.trim()) q--;
      if (q < 0 || listAt(paragraphs[q])?.abstract !== list.abstract) again.add(list.numId);
    }
    const restarted = new Map();
    const copy = insertedBlocks(pristineXml.slice(r.start, r.end), st).replace(/(<w:numPr>(?:<w:ilvl w:val="(\d)"\/>)?<w:numId w:val=")(\d+)(")/g, (m, head, ilvl, id, tail) => {
      if (!again.has(id)) return m;
      if (!restarted.has(id)) restarted.set(id, ctx.restart(ctx.abstractOf(id), ilvl ?? "0"));
      return head + restarted.get(id) + tail;
    });
    if (restarted.size) op.restarted = [...restarted.values()];
    return ctx.fresh(copy, st);
  };

  // A row like another, straight after it.
  const rowXml = (op, row) => {
    const st = stampFor(stamp, op);
    const tr = pristineXml.slice(row.start, row.end);
    const { cells, headEnd } = rowParts(tr);
    const head = markRow(readerCopy(tr.slice(0, headEnd)), `<w:ins ${st()}/>`);
    const made = cells.map((c, k) => {
      const { open, inner } = cellParts(tr.slice(c.start, c.end));
      const blocks = topLevel(inner, ["p", "tbl", "sdt", "customXml"]);
      const before = inner.slice(0, blocks[0]?.start ?? inner.length);
      const tcPr = withoutChanges(/<w:tcPr\s*\/>|<w:tcPr\b[\s\S]*<\/w:tcPr>/.exec(before)?.[0] ?? "").replace(/<w:vMerge\b[^>]*\/>/g, "");
      const ps = blocks.filter((b) => b.name === "p").map((b) => inner.slice(b.start, b.end));
      const pPr = copiedPPr(paraPropsOf(ps[0] ?? ""));
      // The look of the cell's words; an empty cell's paragraph mark says
      // what its words would look like.
      const rPr = ps.map(firstRunRPr).find(Boolean) || child(pPr, "w:rPr") || "";
      const words = (op.cells[k] ?? "").trim();
      return `${open}${tcPr}<w:p>${markParagraphMark(pPr, "ins", st)}${words ? `<w:ins ${st()}>${runsFor(words, rPr)}</w:ins>` : ""}</w:p></w:tc>`;
    });
    return ctx.fresh(`${head}${made.join("")}</w:tr>`, st);
  };

  // Whole paragraphs and tables struck through. A section break on the last
  // paragraph moves to the paragraph before the block when that one is free
  // to take it; otherwise that paragraph's mark stays, empty, with the
  // break (as "delete" does).
  const removeXml = (op, r, move) => {
    const st = stampFor(stamp, op);
    const lastEl = r.elements[r.elements.length - 1];
    let out = "";
    let at = r.start;
    for (const el of r.elements) {
      out += pristineXml.slice(at, el.start);
      at = el.end;
      let x = pristineXml.slice(el.start, el.end);
      if (el.name === "tbl") { out += deletedTable(x, st); continue; }
      x = expandEmpty(x);
      if (move && el === lastEl) {
        const sect = sectionBreakOf(x);
        const pPr = paraPropsOf(x);
        x = x.replace(pPr, pPr.replace(sect, ""));
      }
      if (isOwnInsertion(x)) { (op.removedIds ??= []).push(...insertionIds(x)); continue; }
      if (SECTION_BREAK.test(paraPropsOf(x))) op.keptSectionBreak = true;
      out += deleteParagraph(x, st);
    }
    out += pristineXml.slice(at, r.end);
    if (r.paras.some((p) => p.headingLevel)) ctx.heading = true;
    op.original = r.paras.map((p) => p.text).filter((t) => t.trim()).join("\n");
    if (!move) return out;
    op.movedSectionBreak = true;
    const sect = sectionBreakOf(pristineXml.slice(lastEl.start, lastEl.end));
    return withSectionBreak(pristineXml.slice(move.start, move.end), sect) + pristineXml.slice(move.end, r.start) + out;
  };

  for (const { op } of blockOps) {
    if (op.kind === "remove_block") continue;
    const anchorIndex = op.kind === "add_row" ? op.like_row : op.after;
    const anchor = byIndex.get(anchorIndex);
    const reason = blocks(anchorIndex) ?? (op.kind === "add_row" && Number.isFinite(op.table) ? blocks(op.table) : null);
    if (reason) { refuse(op, reason); continue; }
    const box = anchor && ctx.holderOf(anchor.start);
    if (!box) { refuse(op, `¶${anchorIndex} is not in the body of the document`); continue; }
    if (op.kind === "write") {
      splices.push({ start: box.end, end: box.end, op, make: () => writeXml(op, box, anchor) });
    } else if (op.kind === "repeat_block") {
      const r = rangeOf(op, false);
      if (r.error) { refuse(op, r.error); continue; }
      splices.push({ start: box.end, end: box.end, op, make: () => repeatXml(op, r) });
    } else if (op.kind === "add_row") {
      const row = anchor.inTable && ctx.innermost("tr", anchor.start);
      if (!row) { refuse(op, `¶${op.like_row} is not in a table`); continue; }
      const table = ctx.innermost("tbl", anchor.start);
      const named = Number.isFinite(op.table) ? byIndex.get(op.table) : anchor;
      if (!named?.inTable || ctx.innermost("tbl", named.start)?.start !== table.start) { refuse(op, `¶${op.like_row} is not in the same table as ¶${op.table}`); continue; }
      const count = rowParts(pristineXml.slice(row.start, row.end)).cells.length;
      if (op.cells.length > count) { refuse(op, `the row has ${count} cell${count === 1 ? "" : "s"}, and ${op.cells.length} were given`); continue; }
      splices.push({ start: row.end, end: row.end, op, make: () => rowXml(op, row) });
    }
  }

  const touched = new Set(parsed.map(({ op }) => op.p));
  for (const r of removed) {
    const lastEl = r.elements[r.elements.length - 1];
    let move = null;
    if (lastEl.name === "p" && SECTION_BREAK.test(paraPropsOf(pristineXml.slice(lastEl.start, lastEl.end)))) {
      const prev = body[r.firstIndex - 1];
      const prevPara = prev?.name === "p" ? paragraphs.find((p) => p.start === prev.start) : null;
      const free = prevPara
        && !touched.has(prevPara.index)
        && !removedAt(prev.start)
        && !SECTION_BREAK.test(paraPropsOf(pristineXml.slice(prev.start, prev.end)))
        && !splices.some((s) => s.start >= prev.start && s.start <= r.start);
      if (free) move = prev;
    }
    splices.push({ start: move ? move.start : r.start, end: r.end, op: r.op, make: () => removeXml(r.op, r, move) });
  }

  // Bottom upwards; at one point a removal before an insertion, and of two
  // insertions the later operation first, so they land in the order given.
  const queue = splices.sort((x, y) => y.start - x.start || y.end - x.end || y.op.i - x.op.i);
  return {
    blocks,
    headingChanged: () => ctx.heading,
    finish: (target) => ctx.finish(target),
    flush(limit, splice, made, refused) {
      while (queue.length && queue[0].start >= limit) {
        const s = queue.shift();
        let xml;
        try {
          xml = s.make();
        } catch (err) {
          refused(s.op, `this could not be written safely (${err instanceof Error ? err.message : String(err)})`);
          continue;
        }
        splice(s.start, s.end, xml);
        made(s.op);
      }
    },
  };
}

/**
 * Problems with a pack's kinds list, each as a plain sentence; none means
 * it can be used. The shape (the contract with the pack builder):
 * { kinds: { name: { pPr, rPr, styleId, numId, ilvl, label, restart? } },
 *   tables: { name: { tblPr, tblGrid, header: { trPr, tcPr, pPr, rPr }, body: { … }, label } },
 *   footnote: { pPr, rPr, refRPr } | null }
 */
export function validateKinds(obj) {
  const problems = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return ["The kinds list is not an object."];
  const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
  const fragment = (where, value, tag, { optional = true } = {}) => {
    if (value === null || value === undefined || value === "") {
      if (!optional) problems.push(`${where} is missing.`);
      return;
    }
    if (typeof value !== "string") { problems.push(`${where} is not text.`); return; }
    if (!new RegExp(`^<w:${tag}(?:\\s[^>]*)?(?:\\/>|>[\\s\\S]*<\\/w:${tag}>)$`).test(value.trim())) { problems.push(`${where} is not a single <w:${tag}> element.`); return; }
    try {
      new DOMParser({ onError: (level, message) => { if (level !== "warning") throw new Error(message); } })
        .parseFromString(`<x xmlns:w="${W_NS}" xmlns:w14="${W14_NS}" xmlns:r="${R_NS}">${value}</x>`, "application/xml");
    } catch {
      problems.push(`${where} is not well-formed XML.`);
    }
  };
  const kinds = obj.kinds;
  if (!kinds || typeof kinds !== "object" || Array.isArray(kinds) || !Object.keys(kinds).length) problems.push("It lists no paragraph kinds.");
  for (const [name, k] of Object.entries(kinds && typeof kinds === "object" ? kinds : {})) {
    if (!NAME.test(name)) problems.push(`The kind name "${name}" is not a plain name (a letter, then letters, digits, - or _).`);
    if (name === "footnote" || name === "table") problems.push(`The name "${name}" is kept for the ${name}; give the paragraph kind another name.`);
    if (!k || typeof k !== "object") { problems.push(`Kind "${name}" is not an object.`); continue; }
    fragment(`Kind "${name}"'s paragraph format (pPr)`, k.pPr, "pPr");
    fragment(`Kind "${name}"'s run format (rPr)`, k.rPr, "rPr");
    if (typeof k.pPr === "string" && /<w:sectPr\b/.test(k.pPr)) problems.push(`Kind "${name}"'s paragraph format carries a section break; take it out.`);
    if (k.styleId != null && typeof k.styleId !== "string") problems.push(`Kind "${name}"'s styleId is not text.`);
    if (k.numId != null && !/^\d+$/.test(String(k.numId))) problems.push(`Kind "${name}"'s numId is not a number.`);
    if (k.ilvl != null && !/^[0-8]$/.test(String(k.ilvl))) problems.push(`Kind "${name}"'s ilvl is not a list level from 0 to 8.`);
    const own = typeof k.pPr === "string" ? /<w:numId w:val="(\d+)"/.exec(k.pPr)?.[1] : undefined;
    if (k.numId != null && own !== undefined && own !== String(k.numId)) problems.push(`Kind "${name}" says list ${k.numId}, but its paragraph format uses list ${own}.`);
    if (k.restart !== undefined && typeof k.restart !== "boolean") problems.push(`Kind "${name}"'s restart is not true or false.`);
    if (typeof k.label !== "string" || !k.label.trim()) problems.push(`Kind "${name}" has no label.`);
  }
  const tables = obj.tables ?? {};
  if (typeof tables !== "object" || Array.isArray(tables)) problems.push("The table kinds are not an object.");
  else for (const [name, t] of Object.entries(tables)) {
    if (!NAME.test(name)) problems.push(`The table kind name "${name}" is not a plain name (a letter, then letters, digits, - or _).`);
    if (kinds && typeof kinds === "object" && Object.hasOwn(kinds, name)) problems.push(`"${name}" is both a paragraph kind and a table kind.`);
    if (name === "footnote" || name === "table") problems.push(`The name "${name}" is kept for the ${name}; give the table kind another name.`);
    if (!t || typeof t !== "object") { problems.push(`Table kind "${name}" is not an object.`); continue; }
    fragment(`Table kind "${name}"'s table format (tblPr)`, t.tblPr, "tblPr", { optional: false });
    fragment(`Table kind "${name}"'s column grid (tblGrid)`, t.tblGrid, "tblGrid");
    for (const row of ["header", "body"]) {
      const r = t[row];
      if (!r || typeof r !== "object") { problems.push(`Table kind "${name}" has no ${row} row.`); continue; }
      fragment(`Table kind "${name}"'s ${row} row format (trPr)`, r.trPr, "trPr");
      fragment(`Table kind "${name}"'s ${row} cell format (tcPr)`, r.tcPr, "tcPr");
      fragment(`Table kind "${name}"'s ${row} paragraph format (pPr)`, r.pPr, "pPr");
      fragment(`Table kind "${name}"'s ${row} run format (rPr)`, r.rPr, "rPr");
    }
    if (typeof t.label !== "string" || !t.label.trim()) problems.push(`Table kind "${name}" has no label.`);
  }
  if (obj.footnote != null) {
    const f = obj.footnote;
    if (typeof f !== "object") problems.push("The footnote is not an object.");
    else {
      fragment("The footnote's paragraph format (pPr)", f.pPr, "pPr");
      fragment("The footnote's run format (rPr)", f.rPr, "rPr");
      fragment("The footnote's reference mark format (refRPr)", f.refRPr, "rPr");
    }
  }
  return problems;
}

/** The short line a prompt or tool shows of the kinds a pack can write. */
export function kindsListing(kinds) {
  if (!kinds?.kinds) return "";
  const paragraphs = Object.entries(kinds.kinds).map(([name, k]) => `${name} (${k?.label || "paragraph"})`);
  if (kinds.footnote) paragraphs.push("footnote (a footnote on the paragraph before it)");
  const tables = Object.entries(kinds.tables ?? {}).map(([name, t]) => `${name} (${t?.label || "table"})`);
  return `KINDS YOU CAN WRITE: ${paragraphs.join(", ")}${tables.length ? `. TABLES: ${tables.join(", ")}; a table takes "rows", the first row its header` : ""}.`;
}

// ---------------------------------------------------------------- applying

/**
 * Applies the model's operations to the file. Every operation is reported
 * back — applied, or why not — so the lawyer is told about the ones that
 * could not be made rather than left to find the gap themselves.
 */
async function applyPartOps(bytes, ops, byRef, { idFloor, signal, kinds, shown } = {}) {
  const results = [];
  const parsed = [];
  // The block operations (write, repeat_block, add_row, remove_block): they
  // reach across paragraphs, so they are planned apart from the rest.
  const blockOps = [];
  ops.forEach((raw, i) => {
    const op = { i, kind: String(raw?.op ?? "").toLowerCase(), p: Number(raw?.p), text: typeof raw?.text === "string" ? raw.text : "" };
    const ref = byRef.get(op.p);
    if (!ref) return results.push({ ...op, status: "skipped", reason: `¶${raw?.p} is not a paragraph in this document` });
    // What the change is to, where it sits, and the model's reason for it:
    // the record of the change carries these, the file does not.
    op.original = op.kind === "insert_after" ? "" : ref.exactText;
    if (op.kind === "insert_after") op.anchor = ref.exactText;
    op.clause = typeof raw?.clause === "string" ? raw.clause : null;
    op.why = typeof raw?.why === "string" ? raw.why.slice(0, 300) : null;
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
    } else if (op.kind === "delete") {
      op.modified = "";
    } else if (BLOCK_OPS[op.kind]) {
      Object.assign(op, blockFields(op.kind, raw, ref));
      const problem = blockProblem(op, kinds);
      if (problem) return results.push({ ...op, status: "skipped", reason: problem });
      blockOps.push({ op, ref });
      return;
    } else {
      return results.push({ ...op, status: "skipped", reason: `unknown op "${raw?.op}"` });
    }
    parsed.push({ op, ref });
  });

  const entries = readZip(bytes);
  let applied = 0;
  const fallback = [];
  const comments = [];
  let maxId = Math.max(9000, Number(idFloor) || 0);
  const done = (op, extra = {}) => results.push({ ...op, revisionIds: op.revisionIds ?? [], via: "inline", status: "applied", ...extra });
  // Whether a heading was added or removed, so the contents page is stale.
  let headingChanged = false;

  // Parts other than the body a block operation wrote.
  let extra = [];

  if (parsed.length || blockOps.length) {
    let documentXml = dec.decode(entries["word/document.xml"]);
    const headings = headingStyles(entries["word/styles.xml"] ? dec.decode(entries["word/styles.xml"]) : "");
    const stamp = revisionStamps(documentXml, maxId);
    const pristineXml = documentXml;
    const paragraphs = enumerateParagraphs(documentXml, headings);
    const byIndex = new Map(paragraphs.map((p) => [p.index, p]));
    // The document's own heading of a level, nearest the anchor: above it
    // first, then below. A heading of that style; failing one, any heading
    // of that level. Read from the file as it arrived.
    const exemplarNear = (index) => (styleId, level) => {
      const at = paragraphs.findIndex((p) => p.index === index);
      const tiers = [(p) => styleId && p.styleId === styleId, (p) => p.headingLevel === level];
      for (const fits of tiers) {
        const ok = (p) => p && !p.inTable && !p.formatting && p.text.trim() && fits(p);
        for (let k = at; k >= 0; k--) if (ok(paragraphs[k])) return pristineXml.slice(paragraphs[k].start, paragraphs[k].end);
        for (let k = at + 1; k < paragraphs.length; k++) if (ok(paragraphs[k])) return pristineXml.slice(paragraphs[k].start, paragraphs[k].end);
      }
      return null;
    };
    // The heading levels the document's own headings use, for the reason
    // given when a heading of another level is asked for.
    const levelsUsed = [...new Set(paragraphs.filter((p) => p.headingLevel && !p.inTable && !p.formatting && p.text.trim()).map((p) => p.headingLevel))].sort((a, b) => a - b);

    // The block operations, worked out against the file as it arrived: each
    // is one splice of the body, made in the same bottom-up pass as the
    // paragraph changes below. A change aimed inside a block being removed
    // is refused (plan.blocks).
    const plan = blockOps.length
      ? planBlocks({ blockOps, parsed, entries, pristineXml, paragraphs, byIndex, headings, stamp, kinds, shown, results })
      : null;
    const live = plan ? parsed.filter(({ op }) => {
      const reason = plan.blocks(op.p);
      if (reason) results.push({ ...op, status: "skipped", reason });
      return !reason;
    }) : parsed;
    const splice = (start, end, xml) => { documentXml = documentXml.slice(0, start) + xml + documentXml.slice(end); };
    const made = (op) => { done(op); applied++; };
    const refused = (op, reason) => { delete op.revisionIds; delete op.splits; results.push({ ...op, status: "skipped", reason }); };

    // Bottom of the document upwards, so an edit never moves a paragraph
    // another operation is still to find.
    const work = new Map();
    for (const { op } of live) work.set(op.p, [...(work.get(op.p) ?? []), op]);
    for (const index of [...work.keys()].sort((a, b) => b - a)) {
      const para = byIndex.get(index);
      const group = work.get(index);
      // Block splices below the end of this paragraph go first. One that
      // lands right after it lands after its insert_after paragraphs.
      if (para && plan) plan.flush(para.end, splice, made, refused);
      if (!para) {
        group.forEach((op) => results.push({ ...op, status: "skipped", reason: `¶${index} not found` }));
        continue;
      }
      if (para.formatting) {
        group.forEach((op) => results.push({ ...op, status: "skipped", reason: "formatting" }));
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
      if (edit?.kind === "delete" && own) {
        // Word does not track the removal of an unaccepted insertion: the
        // paragraph simply goes, and the change that added it is withdrawn.
        replacement = "";
        edit.removedIds = insertionIds(paraXml);
        edit.revisionIds = [];
      } else if (edit?.kind === "delete") {
        replacement = deleteParagraph(paraXml, stampFor(stamp, edit));
        // A paragraph that ends a section keeps its (empty) mark and the break.
        if (SECTION_BREAK.test(paraPropsOf(paraXml))) edit.keptSectionBreak = true;
        else edit.markId = edit.revisionIds[0];
      } else if (edit?.kind === "replace" && own) {
        // Rewriting a paragraph the AI added earlier takes that change over:
        // the paragraph mark keeps its id, the body gets a new one, and the
        // earlier change is replaced by this one rather than left to decide.
        edit.takesOver = insertionIds(paraXml);
        const markId = insertionIds(child(paraXml, "w:pPr") ?? "")[0];
        if (markId !== undefined) { edit.markId = markId; edit.revisionIds = [markId]; }
        replacement = rewriteOwnInsertion(paraXml, edit.modified, stampFor(stamp, edit));
      } else if (edit?.kind === "replace") {
        replacement = replaceParagraph(paraXml, edit.modified, stampFor(stamp, edit));
      }

      if (edit && replacement === null) {
        // Markup this cannot safely rewrite; the redline engine gets it.
        replacement = paraXml;
        delete edit.revisionIds; delete edit.splits;
        fallback.push({
          op: edit,
          lib: edit.kind === "replace"
            ? { type: "replace", target: { exactText: para.text, occurrence: para.occurrence }, modified: edit.modified }
            : { type: "delete", target: { exactText: para.text, occurrence: para.occurrence } },
        });
      } else if (edit) {
        done(edit);
        applied++;
      }
      if (edit?.kind === "delete" && para.headingLevel) headingChanged = true;

      // A comment spans the paragraph as it now stands. Its id is a
      // placeholder here; the package allocates the real one.
      if (notes.length && replacement && /^<w:p[\s>]/.test(replacement) && replacement.endsWith("</w:p>")) {
        for (const op of notes) {
          const key = `@@AKLA_COMMENT_${comments.length}@@`;
          comments.push({ key, text: op.text.trim() });
          const open = /^<w:p(?:\s[^>]*)?>\s*/.exec(replacement)[0] + paraPropsOf(replacement);
          replacement = `${open}<w:commentRangeStart w:id="${key}"/>${replacement.slice(open.length, -"</w:p>".length)}<w:commentRangeEnd w:id="${key}"/><w:r><w:commentReference w:id="${key}"/></w:r></w:p>`;
          done(op);
          applied++;
        }
      } else {
        notes.forEach((op) => results.push({ ...op, status: "skipped", reason: replacement ? `¶${index} has no text to comment on` : `¶${index} was removed, so it cannot take a comment` }));
      }

      const refusedHeadings = new Map();
      const added = additions.map((op) => {
        const made = insertAfter(paraXml, op.text, headings, stampFor(stamp, op), exemplarNear(index));
        if (made.skip) {
          refusedHeadings.set(op, noHeadingReason(made.skip, levelsUsed));
          return "";
        }
        op.markId = op.revisionIds[0];
        if (made.heading) headingChanged = true;
        return made.xml;
      }).join("");
      documentXml = documentXml.slice(0, para.start) + replacement + added + documentXml.slice(para.end);
      additions.forEach((op) => {
        if (refusedHeadings.has(op)) return results.push({ ...op, status: "skipped", reason: refusedHeadings.get(op) });
        done(op);
        applied++;
      });
    }
    if (plan) {
      plan.flush(-1, splice, made, refused);
      if (plan.headingChanged()) headingChanged = true;
      extra = plan.finish(entries);
    }
    if (headingChanged) documentXml = markTocDirty(documentXml);
    entries["word/document.xml"] = enc.encode(patchEmptyCells(documentXml));
    maxId = stamp.max();
  }

  let out = applied ? writeZip(entries) : bytes;
  // The engine mints its own ids, counting from the highest id in this part
  // alone, which may already be recorded for another part or for a change
  // decided away, so each new id is renumbered from this call's counter.
  // Each call re-reads the whole package, and on a 400 KB agreement that
  // costs about 40 seconds whatever the number of changes, so all of them
  // go in one call and each change's ids come from its own receipt. A call
  // the engine refuses outright (no per-change result at all) is retried
  // one change at a time, so one bad change does not take the rest with it.
  const runFallback = async (batch) => {
    // Each pass re-opens the whole package: a caller whose deadline has
    // passed gets its abort here rather than minutes later.
    signal?.throwIfAborted();
    const before = revisionIdsIn(out);
    const res = await openDocx(out).applyOperations(batch.map((f) => f.lib), {
      author: DOCX_AUTHOR, atomic: false, validate: true, strictTargets: true, continueOnError: true,
    });
    const perOp = res.results ?? [];
    if (batch.length > 1 && perOp.length !== batch.length) return false;
    const written = perOp.some((r) => r?.status === "applied") && res.written;
    if (written) out = res.toBuffer();
    const fresh = written ? [...revisionIdsIn(out)].filter((id) => !before.has(id)).sort((a, b) => a - b) : [];
    const renumbered = new Map(fresh.map((id) => [id, ++maxId]));
    if (fresh.length) {
      const part = readZip(out);
      const xml = dec.decode(part["word/document.xml"]).replace(/<w:(ins|del)(\s[^>]*?)\bw:id="(\d+)"/g, (m, tag, pre, id) =>
        renumbered.has(Number(id)) ? `<w:${tag}${pre}w:id="${renumbered.get(Number(id))}"` : m);
      part["word/document.xml"] = enc.encode(xml);
      out = writeZip(part);
    }
    const appliedCount = perOp.filter((r) => r?.status === "applied").length;
    batch.forEach(({ op }, k) => {
      const r = perOp[k];
      if (r?.status === "applied") {
        const receipt = r.receipt?.revisionItems?.filter((x) => x.kind === "ins" || x.kind === "del").map((x) => Number(x.id)).filter((id) => Number.isFinite(id) && renumbered.has(id));
        // Without a receipt the new ids are this change's only when it is
        // the only change the call made.
        const ids = receipt?.length ? receipt : appliedCount === 1 ? fresh : [];
        applied++;
        results.push({ ...op, status: "applied", revisionIds: ids.map((id) => renumbered.get(id)), via: "fallback" });
      } else if (r?.status === "no_change") {
        results.push({ ...op, status: "skipped", reason: "no_change" });
      } else {
        // A change the engine refused says why; saying nothing would hide
        // it from the lawyer.
        results.push({ ...op, status: "skipped", reason: r?.error?.message ?? r?.error?.code ?? res.error?.message ?? "this paragraph's formatting could not be edited safely" });
      }
    });
    return true;
  };
  if (fallback.length && !(await runFallback(fallback))) {
    for (const one of fallback) await runFallback([one]);
  }
  if (fallback.length) maxId = maxIdIn(dec.decode(readZip(out)["word/document.xml"]), maxId);
  // The redline engine writes the part afresh; the mark must survive it.
  if (headingChanged && fallback.length) {
    const part = readZip(out);
    const xml = dec.decode(part["word/document.xml"]);
    const dirty = markTocDirty(xml);
    if (dirty !== xml) {
      part["word/document.xml"] = enc.encode(dirty);
      out = writeZip(part);
    }
  }

  results.sort((a, b) => a.i - b.i);
  adoptSplits(results);
  return { bytes: out, results, applied, comments, maxId, ...(extra.length ? { extra } : {}) };
}

// When one change of a call lands inside an insertion another change of the
// same call made, the second half of that insertion gets a fresh id; the
// earlier change still owns those words, so the id is its as well.
function adoptSplits(results) {
  for (const r of results) {
    for (const s of r.splits ?? []) {
      const owner = results.find((o) => o !== r && o.status === "applied" && (o.revisionIds ?? []).includes(Number(s.fromId)));
      if (owner && !owner.revisionIds.includes(Number(s.toId))) owner.revisionIds.push(Number(s.toId));
    }
  }
}

// Every revision id in a part, for telling the engine's new ones apart.
function revisionIdsIn(bytes) {
  const xml = dec.decode(readZip(bytes)["word/document.xml"]);
  return new Set([...xml.matchAll(/<w:(?:ins|del)\s[^>]*?\bw:id="(\d+)"/g)].map((m) => Number(m[1])));
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
  xml = acceptRows(xml, (trPr) => /<w:del\b/.test(trPr), /<w:ins\b[^>]*\/>/g);
  // A struck-through paragraph mark joins the paragraph to the next one;
  // dropping the paragraph is what Word shows and what the lawyer means.
  // The mark is the w:del inside the paragraph properties' own w:rPr — a
  // deletion anywhere else in the paragraph is ordinary struck-out text.
  xml = xml.replace(PARAGRAPH, (p) => {
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
  entries[part] = enc.encode(patchEmptyCells(xml));
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
  // `next` is where to look from for a further occurrence.
  return { start: map[at], end, next: at + 1 };
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

// Every place the quoted paragraphs occur, a second occurrence inside one
// paragraph included. Each candidate is the list of paragraph slices the
// quote covers. The caller decides what more than one means.
function locateQuote(paras, before) {
  const found = [];
  const slice = (para, hit) => ({ para, start: hit.start, end: hit.end });
  for (let k = 0; k < paras.length; k++) {
    let from = 0;
    for (let first = findLoose(paras[k].text, before[0]); first; first = findLoose(paras[k].text, before[0], from)) {
      from = first.next;
      if (before.length === 1) { found.push([slice(paras[k], first)]); continue; }
      // A quote that runs on must start at the end of this paragraph.
      if (paras[k].text.slice(first.end).trim()) break;
      const list = [slice(paras[k], first)];
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
        list.push(slice(para, hit));
      }
      if (ok) found.push(list);
      break;
    }
  }
  return found;
}

// Does the clause the suggestion names point at this spot? The spot's own
// number, or the nearest numbered or heading paragraph above it, has to
// carry the clause's number or one of its words.
const CLAUSE_NOISE = new Set(["clause", "clauses", "section", "article", "para", "paragraph", "item", "sub", "the", "and", "of"]);
function clauseMatches(paras, hitIndex, clause) {
  const tokens = String(clause).toLowerCase().match(/\d+(?:\.\d+)*|[a-z]{3,}/g) ?? [];
  const numbers = tokens.filter((t) => /^\d/.test(t));
  const words = tokens.filter((t) => !/^\d/.test(t) && !CLAUSE_NOISE.has(t));
  if (!numbers.length && !words.length) return true;
  let anchor = null;
  for (let k = hitIndex; k >= 0 && !anchor; k--) {
    if (CLAUSE_LEAD.test(paras[k].text) || paras[k].headingLevel) anchor = paras[k];
  }
  if (!anchor) return false;
  const text = anchor.text.toLowerCase();
  const lead = CLAUSE_LEAD.exec(anchor.text)?.[1]?.replace(/[().]/g, "").toLowerCase();
  return numbers.some((n) => n === lead || new RegExp(`(^|[^\\d.])${n.replace(/\./g, "\\.")}(?![\\d.])`).test(text))
    || words.some((w) => new RegExp(`\\b${w}\\b`).test(text));
}

/**
 * Writes review suggestions into the Word file as tracked changes by the
 * AI. Revisions already in the file are left as they are — the lawyer's own
 * redline stays visible alongside. A quote found in more than one place is
 * refused rather than guessed at, unless the clause named narrows it to one.
 *
 * changes: [{ id, original, suggested, accepted, clause? }]
 * Each result says which part and paragraph it landed in, the document's
 * own words before and after, and the revision ids it minted.
 *
 * `legacy: true` is the old preview path only: an `accepted` suggestion is
 * written under a transient author and then accepted, so the page shows
 * the new wording plainly.
 */
export function applyReviewSuggestions(bytes, changes, { idFloor, legacy = false } = {}) {
  const entries = readZip(bytes);
  const headings = headingStyles(entries["word/styles.xml"] ? dec.decode(entries["word/styles.xml"]) : "");
  // The body first, then notes, headers and footers: a suggestion about a
  // footnote quotes the footnote.
  const partNames = Object.keys(entries)
    .filter((name) => STORY_PART.test(name))
    .sort((x, y) => (x === "word/document.xml" ? -1 : y === "word/document.xml" ? 1 : x.localeCompare(y)));
  const parts = new Map(partNames.map((name) => [name, dec.decode(entries[name])]));
  const pristine = new Map([...parts].map(([name, xml]) => [name, enumerateParagraphs(xml, headings)]));
  // Paragraphs are numbered on from one part to the next, as the listing
  // the Edit path shows numbers them.
  const offsets = new Map();
  let count = 0;
  for (const [name, paras] of pristine) {
    offsets.set(name, count);
    const last = paras.filter((p) => p.text.trim()).pop();
    if (last) count += last.index;
  }
  const stamp = revisionStamps("", idFloorOf(entries, idFloor));
  const results = [];

  for (const change of changes) {
    const record = { id: change.id, part: null, paragraphIndex: null, clause: change.clause ?? null, original: null, suggested: null, revisionIds: [] };
    const skip = (reason) => results.push({ ...record, status: "skipped", reason });
    let before = suggestionParagraphs(change.original);
    let after = suggestionParagraphs(change.suggested);
    record.original = before.join("\n");
    record.suggested = after.join("\n");
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

    let candidates = [];
    for (const [name, xml] of parts) {
      const paras = enumerateParagraphs(xml, headings);
      for (const edits of locateQuote(paras, before)) candidates.push({ name, paras, edits });
    }
    if (!candidates.length) {
      // Present in the file as it arrived, gone now: an earlier suggestion
      // already rewrote these words.
      const overlaps = [...pristine.values()].some((paras) => locateQuote(paras, before).length);
      skip(overlaps ? "overlaps_another_suggestion" : "not_found");
      continue;
    }
    if (candidates.length > 1 && change.clause) candidates = candidates.filter((c) => clauseMatches(c.paras, c.edits[0].para.index - 1, change.clause));
    // The old preview took the first place a quote was found; it still does.
    if (candidates.length > 1 && legacy) candidates = [candidates[0]];
    if (candidates.length !== 1) { skip("ambiguous"); continue; }
    const found = candidates[0];
    record.part = found.name;
    record.paragraphIndex = offsets.get(found.name) + found.edits[0].para.index;
    record.original = found.edits.map((e) => e.para.text.slice(e.start, e.end)).join("\n");
    record.suggested = after.join("\n");

    const mark = stampFor(stamp, record, legacy && change.accepted ? REVIEW_ACCEPTED_AUTHOR : DOCX_AUTHOR);
    let xml = parts.get(found.name);
    const rewrites = [];
    let failed = false;
    found.edits.forEach((e, n) => {
      if (failed) return;
      const newText = e.para.text.slice(0, e.start) + (after[n] ?? "") + e.para.text.slice(e.end);
      if (newText === e.para.text) return;
      if (e.para.formatting) { failed = true; return; }
      let pXml = xml.slice(e.para.start, e.para.end);
      if (isOwnInsertion(pXml)) {
        // A paragraph the AI added earlier: this change takes it over, the
        // paragraph mark keeping its id and the body getting a new one.
        (record.takesOver ??= []).push(...insertionIds(pXml));
        const markId = insertionIds(child(pXml, "w:pPr") ?? "")[0];
        if (markId !== undefined) record.revisionIds.push(markId);
        pXml = rewriteOwnInsertion(pXml, newText, mark);
      } else {
        // Right to left, so each change leaves the offsets of the ones
        // before it where they were.
        for (const h of wordHunks(e.para.text, newText).reverse()) {
          const current = visibleText(pXml);
          const next = replaceParagraph(pXml, current.slice(0, h.start) + h.inserted + current.slice(h.end), mark);
          if (next === null) { failed = true; return; }
          pXml = next;
        }
      }
      rewrites.push({ para: e.para, out: pXml });
    });
    if (failed) { record.revisionIds = []; delete record.splits; delete record.takesOver; skip("formatting"); continue; }
    if (!rewrites.length) { skip("no_change"); continue; }
    for (const r of rewrites.sort((x, y) => y.para.start - x.para.start)) {
      xml = xml.slice(0, r.para.start) + r.out + xml.slice(r.para.end);
    }
    parts.set(found.name, xml);
    results.push({ ...record, status: "applied" });
  }
  for (const name of partNames) adoptSplits(results.filter((r) => r.part === name));

  // The old preview only: accepted suggestions keep the new words, drop the
  // old, and leave no markup.
  const author = escapeRegExp(escapeXml(REVIEW_ACCEPTED_AUTHOR));
  for (const [name, xml] of parts) {
    const clean = !legacy ? xml : xml
      .replace(new RegExp(`<w:del\\b[^>]*w:author="${author}"[^>]*>[\\s\\S]*?<\\/w:del>`, "g"), "")
      .replace(new RegExp(`<w:ins\\b[^>]*w:author="${author}"[^>]*>([\\s\\S]*?)<\\/w:ins>`, "g"), "$1");
    entries[name] = enc.encode(clean);
  }
  validateXml(entries);
  const quality = inspectPackage(xmlParts(entries));
  if (quality.errors.length) throw new Error(`Redlined file failed structural checks: ${quality.errors.join("; ")}`);
  return { bytes: writeZip(entries), results, maxId: stamp.max() };
}

// A table row's own mark accepted: a row whose properties carry a deletion
// mark (as `deleted` judges it) is removed whole, an insertion mark
// (`insMark`) is dropped, and a table left with no rows goes as well. A part
// with no marked row comes back exactly as it was.
function acceptRows(xml, deleted, insMark) {
  if (!/<w:trPr\b[^>]*>(?:(?!<\/w:trPr>)[\s\S])*?<w:(?:ins|del)\b/.test(xml)) return xml;
  const own = (tr) => /^<w:tr\b[^>]*>\s*(?:<w:tblPrEx\b[^>]*?(?:\/>|>[\s\S]*?<\/w:tblPrEx>)\s*)?(<w:trPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:trPr>))/.exec(tr)?.[1];
  const drop = [];
  for (const r of allOf(xml, "tr").sort((a, b) => a.start - b.start)) {
    if (drop.length && r.start < drop[drop.length - 1].end) continue;
    const trPr = own(xml.slice(r.start, r.end));
    if (trPr && deleted(trPr.replace(PROP_CHANGES, ""))) drop.push(r);
  }
  for (const r of drop.reverse()) xml = xml.slice(0, r.start) + xml.slice(r.end);
  xml = xml.replace(/<w:trPr>(?:(?!<\/w:trPr>)[\s\S])*?<\/w:trPr>/g, (t) => {
    const s = t.replace(insMark, "");
    return s !== t && s === "<w:trPr></w:trPr>" ? "" : s;
  });
  for (let gone = drop.length > 0; gone; ) {
    gone = false;
    for (const t of allOf(xml, "tbl")) {
      if (/<w:tr[\s>]/.test(xml.slice(t.start, t.end))) continue;
      xml = xml.slice(0, t.start) + xml.slice(t.end);
      gone = true;
      break;
    }
  }
  return xml;
}

// The AI's own tracked changes accepted, and nothing else: revisions already
// in the file by anyone else stay as they are, and comments stay. A draft
// filled in from the firm's standard is a new document, so its fills are
// written in rather than left for someone to approve one by one.
export function acceptChangesBy(bytes, author = DOCX_AUTHOR) {
  const entries = readZip(bytes);
  const who = escapeRegExp(escapeXml(author));
  const insMark = new RegExp(`<w:ins\\b[^>]*w:author="${who}"[^>]*\\/>`, "g");
  const delMark = new RegExp(`<w:del\\b[^>]*w:author="${who}"[^>]*\\/>`);
  for (const part of Object.keys(entries).filter((p) => STORY_PART.test(p))) {
    let xml = dec.decode(entries[part]);
    if (!xml.includes(`w:author="${escapeXml(author)}"`)) continue;
    // Table rows first: a row this author deleted goes whole, with its
    // cells; one this author inserted loses its mark.
    xml = acceptRows(xml, (trPr) => delMark.test(trPr), insMark);
    // Paragraph marks first: a paragraph this author deleted goes, one this
    // author inserted simply stays.
    xml = xml.replace(PARAGRAPH, (p) => {
      const pPr = child(p, "w:pPr");
      const rPr = pPr && child(pPr, "w:rPr");
      if (rPr && delMark.test(rPr)) {
        const remaining = p.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "");
        return /<w:t(?:\s[^>]*)?>[^<]/.test(remaining) ? p.replace(delMark, "") : "";
      }
      return p.replace(insMark, "");
    });
    xml = xml
      .replace(new RegExp(`<w:del\\b[^>]*w:author="${who}"[^>]*>[\\s\\S]*?<\\/w:del>`, "g"), "")
      .replace(new RegExp(`<w:ins\\b[^>]*w:author="${who}"[^>]*>([\\s\\S]*?)<\\/w:ins>`, "g"), "$1");
    entries[part] = enc.encode(patchEmptyCells(xml));
  }
  validateXml(entries);
  return writeZip(entries);
}

// One line per operation, for the reply and the artifact's change list.
export function describeResults(results) {
  const verb = { replace: "Changed", insert_after: "Added after", delete: "Deleted", comment: "Commented on", write: "Wrote after", repeat_block: "Repeated", add_row: "Added a row after", remove_block: "Removed" };
  return results.map((r) => ({
    op: r.kind,
    paragraph: r.p,
    status: r.status,
    summary: `${verb[r.kind] ?? r.kind} ¶${r.p}${r.text ? `: ${r.text.slice(0, 90)}${r.text.length > 90 ? "…" : ""}` : ""}`,
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}

// The pieces other modules build on: reading and writing the package,
// walking its XML, and the words a review suggestion quotes.
export { readZip, writeZip, validateXml, child, attr, STORY_PART, PARAGRAPH, patchEmptyCells, visibleText, suggestionParagraphs, xmlParts };
