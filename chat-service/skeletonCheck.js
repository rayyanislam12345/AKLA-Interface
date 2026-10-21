// The completeness check (docs/drafting-fidelity-plan-2026-10-19.md, "How it
// will work: the clauses" and Appendix F): every clause the firm expects in
// a kind of document, in the firm's order, before a draft is filed.
//
// A clause list ("skeleton") is data, one per kind of document
// (chat-service/skeletons/<key>.json, copied into document_types.skeleton
// by scripts/drafting-packs/seed_skeletons.mjs). It is an ordered list of
// items, each:
//   { id, heading, level, presence: "always" | "optional" | "decision",
//     decision?, when?, match: "heading" | "slot", slot?, pattern?,
//     synonyms?, not_used_form?, scan? }
// - a "heading" item is found by its heading text (normalised, numbers and
//   [●] tolerated, or one of its synonyms);
// - a "slot" item is a fixed part of a shell pack (Ref, Dated, To, Subject,
//   salutation, signature…) that has no heading: it is found by its kind
//   (the paragraph's format matched to the pack's kinds list, the way
//   draftingPacks.js packMap reads a shell) or by its pattern (a regular
//   expression over its text), taking the first such paragraph after the
//   item before it;
// - "decision" items depend on an answer of the type's decisions
//   (decisions/<key>.json): `when` lists the options that make the item
//   required, `absentWhen` the options that leave it out or "Not Used".
// The file is { key, typeName, source, completeLevels, headingKinds, items }
// (a bare array of items is read as the items).
//
// checkSkeleton maps the document to the list and reports, in plain
// sentences: "always" items missing (blocking, unless the lawyer confirmed
// the omission), items out of the firm's order, optional items neither
// present nor marked "Not Used", and headings that match no item (new
// clauses, which carry the AKLA comment "New clause — not in the firm's
// precedents: …"). uncommentedNewClauses reads a turn's ops for headings
// written that match no item and lack that comment, and gives the comment
// op to add (on the paragraph the clause was written after: a paragraph
// written in a turn cannot be commented in the same turn).
//
// Nothing here writes to the document or the database.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip, child, attr, enumerateParagraphs, headingStyles } from "./docxAgent.js";
import { NEW_CLAUSE_COMMENT } from "./draftingPacks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKELETON_DIR = join(HERE, "skeletons");

/** The words a new-clause comment opens with ("New clause — not in the firm's precedents:"). */
export const NEW_CLAUSE_PREFIX = NEW_CLAUSE_COMMENT.replace(/\s*<why>\s*$/, "");
export const PRESENCES = Object.freeze(["always", "optional", "decision"]);
export const MATCHES = Object.freeze(["heading", "slot"]);

const dec = new TextDecoder();

// ---------------------------------------------------------------- the lists

/** The items of a skeleton, whether it is the file's object or a bare array. */
export const itemsOf = (skeleton) => (Array.isArray(skeleton) ? skeleton : Array.isArray(skeleton?.items) ? skeleton.items : []);

let fileCache = null;
/** Every skeleton file, by key: { key → skeleton }. */
export function skeletonFiles(dir = SKELETON_DIR) {
  if (dir === SKELETON_DIR && fileCache) return fileCache;
  const out = {};
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      out[s.key ?? f.replace(/\.json$/, "")] = s;
    }
  }
  if (dir === SKELETON_DIR) fileCache = out;
  return out;
}

/** The skeleton file of a key, or null. */
export const loadSkeleton = (key) => skeletonFiles()[key] ?? null;

const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * The clause list for a document_types row: the row's own `skeleton` when
 * it has one (the seed script writes it; an admin may refine it), else the
 * data file whose typeName is the type's name. null when there is none.
 */
export function skeletonFor(type) {
  const own = type?.skeleton;
  if (own && itemsOf(own).length) return own;
  if (!type?.name) return null;
  return Object.values(skeletonFiles()).find((s) => sameName(s.typeName, type.name) || (s.aliases ?? []).some((a) => sameName(a, type.name))) ?? null;
}

/**
 * Problems with a skeleton, as sentences ([] when it is sound): unique ids,
 * known presences and matches, a slot or pattern for every slot item, and
 * (when the decisions are given) every decision an item names exists and
 * every option it names is one of that decision's.
 */
export function validateSkeleton(skeleton, decisions = null) {
  const problems = [];
  const items = itemsOf(skeleton);
  if (!items.length) problems.push("The clause list has no items.");
  const ids = new Set();
  const questions = new Map((decisions ? (Array.isArray(decisions) ? decisions : decisions.questions ?? []) : []).map((q) => [q.id, q]));
  for (const [i, it] of items.entries()) {
    const where = `Item ${i + 1}${it?.id ? ` (${it.id})` : ""}`;
    if (!it?.id || typeof it.id !== "string") { problems.push(`${where} has no id.`); continue; }
    if (ids.has(it.id)) problems.push(`${where}: the id is used twice.`);
    ids.add(it.id);
    if (!it.heading) problems.push(`${where} has no heading.`);
    if (!Number.isInteger(it.level) || it.level < 0 || it.level > 4) problems.push(`${where}: level must be 0 to 4.`);
    if (!PRESENCES.includes(it.presence)) problems.push(`${where}: presence must be always, optional or decision.`);
    const match = it.match ?? "heading";
    if (!MATCHES.includes(match)) problems.push(`${where}: match must be heading or slot.`);
    if (match === "slot" && !it.slot && !it.pattern) problems.push(`${where}: a slot item needs its kind (slot) or a pattern.`);
    if (it.pattern) { try { new RegExp(it.pattern, "iu"); } catch { problems.push(`${where}: the pattern is not a valid regular expression.`); } }
    if (it.presence === "decision") {
      if (!it.decision) problems.push(`${where}: a decision item names no decision.`);
      else if (decisions) {
        const q = questions.get(it.decision);
        if (!q) problems.push(`${where}: decision "${it.decision}" is not in the type's decisions.`);
        else for (const o of [...(it.when ?? []), ...(it.absentWhen ?? [])]) if (!q.options.some((x) => x.id === o)) problems.push(`${where}: option "${o}" is not an option of decision "${it.decision}".`);
      }
    } else if (it.decision) problems.push(`${where}: only a decision item names a decision.`);
  }
  return problems;
}

// ---------------------------------------------------------------- headings

const PLACEHOLDER = /\[[^\]\n]{0,80}\]|_{3,}/g;
const WILD = "\u0001";

/**
 * A heading as compared: lower case, numbers and "Article 5 —" prefixes
 * gone, "&" read as "and", quotes and dashes as spaces, every blank
 * ([●], [Party X], ____) one wildcard.
 */
export function normaliseHeading(text) {
  let s = String(text ?? "").normalize("NFKC").trim();
  // Typed numbering: "1.", "4.2", "(a)", "iv.", "Article 5 –", "Section 2.1", "Clause 3:".
  s = s.replace(/^(?:(?:article|section|clause|part|chapter)\s+(?:\d+[a-z]?(?:\.\d+)*|[ivxlc]+)\.?|\d+(?:\.\d+)*\.?|\((?:[a-z]{1,2}|[ivxlc]{1,6})\)|[ivxlc]{1,6}\.)\s*(?:[-–—:.]\s*)?(?=\S)/i, "");
  s = s.replace(PLACEHOLDER, ` ${WILD} `).toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[‐-―\-:;,.()/\\|*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wildRe = (norm) => new RegExp(`^${norm.split(WILD).map((p) => escapeRe(p.trim())).join("\\s*.*?\\s*")}$`);
const hasWild = (s) => s.includes(WILD);

/** Whether a normalised text and a normalised heading are the same heading, a blank on either side matching anything. */
const literal = (s) => s.replaceAll(WILD, " ").replace(/\s+/g, " ").trim();
function sameHeading(text, heading) {
  if (!text || !heading || !literal(text) || !literal(heading)) return false;
  if (text === heading) return true;
  if (hasWild(heading) && wildRe(heading).test(text.replaceAll(WILD, "x"))) return true;
  if (hasWild(text) && wildRe(text).test(heading.replaceAll(WILD, "x"))) return true;
  return false;
}

const NOT_USED = /^(?:\[\s*)?not\s+used(?:\s*\])?$/;
/** "Not Used", "[Not Used]", "Financing Matters – Not Used", "Financing Matters (Not Used)": { rest } or null. */
function notUsedOf(norm) {
  if (!norm) return null;
  if (NOT_USED.test(norm.replace(/[[\]]/g, "").trim())) return { rest: "" };
  const m = /^(.*\S)\s+not\s+used$/.exec(norm) ?? /^not\s+used\s+(.*\S)$/.exec(norm);
  return m ? { rest: m[1].trim() } : null;
}

const headingNames = (it) => [it.heading, ...(it.synonyms ?? [])].map(normaliseHeading).filter(Boolean);

// ---------------------------------------------------------------- the document

// Paragraph and run formats compared the way draftingPacks.js packMap
// compares them with a pack's kinds: no namespaces, revision ids or marks.
const sameXml = (xml) => String(xml ?? "")
  .replace(/\s+xmlns(?::\w+)?="[^"]*"/g, "")
  .replace(/\s+w:rsid\w*="[^"]*"/g, "")
  .replace(/<w:(?:pPrChange|rPrChange|ins|del)\b[^>]*\/>/g, "")
  .replace(/>\s+</g, "><")
  .trim();
const textRuns = (pXml) => [...pXml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)].map((m) => m[1]).filter((r) => /<w:t[\s>]/.test(r));
// A run's own bold: true, false (turned off) or null (not said, so the
// paragraph style decides).
const runBold = (r) => {
  const b = child(child(r, "w:rPr") ?? "", "w:b");
  return b ? !/w:val="(?:0|false)"/.test(b) : null;
};
// The paragraph styles that make their text bold, following basedOn.
function boldStyles(stylesXml) {
  const own = new Map();
  for (const m of String(stylesXml ?? "").matchAll(/<w:style\s[^>]*w:type="paragraph"[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const b = child(child(m[2], "w:rPr") ?? "", "w:b");
    own.set(m[1], { bold: b ? !/w:val="(?:0|false)"/.test(b) : null, basedOn: attr(child(m[2], "w:basedOn") ?? "", "w:val") ?? null });
  }
  const resolve = (id, depth = 0) => {
    const st = own.get(id);
    if (!st || depth > 20) return false;
    return st.bold ?? (st.basedOn ? resolve(st.basedOn, depth + 1) : false);
  };
  return (id) => (id ? resolve(id) : false);
}
const runText = (r) => [...r.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

function kindMatcher(kinds) {
  const list = Object.entries(kinds?.kinds ?? {}).map(([name, k]) => ({ name, pPr: sameXml(k?.pPr), rPr: sameXml(k?.rPr) }));
  if (!list.length) return null;
  return (pXml, runs) => {
    const pPr = sameXml(child(pXml, "w:pPr") ?? "");
    let found = list.filter((k) => k.pPr === pPr);
    if (found.length > 1) {
      const rPr = sameXml(runs.length ? child(runs[0], "w:rPr") ?? "" : "");
      const narrowed = found.filter((k) => k.rPr === rPr);
      if (narrowed.length) found = narrowed;
    }
    return found.map((k) => k.name);
  };
}

/**
 * The body paragraphs of a Word file as the check reads them:
 * [{ index, text, styleId, styleLevel, inTable, numId, ilvl, bold, kinds, sig }].
 * `index` is the ¶ number inspectDocx gives the paragraph; `kinds` the
 * pack kinds whose format it has (when a kinds list is given); `sig` its
 * heading signature (its list and level, or its style and format).
 */
export function documentParagraphs(bytes, { kinds = null } = {}) {
  const entries = readZip(bytes);
  const xml = dec.decode(entries["word/document.xml"]);
  const stylesXml = entries["word/styles.xml"] ? dec.decode(entries["word/styles.xml"]) : "";
  const headings = headingStyles(stylesXml);
  const styleBold = boldStyles(stylesXml);
  const match = kindMatcher(kinds);
  return enumerateParagraphs(xml, headings).map((p) => {
    const pXml = xml.slice(p.start, p.end);
    const pPr = child(pXml, "w:pPr") ?? "";
    const numPr = child(pPr, "w:numPr");
    const numId = numPr ? attr(child(numPr, "w:numId") ?? "", "w:val") ?? null : null;
    const ilvl = numPr ? Number(attr(child(numPr, "w:ilvl") ?? "", "w:val") ?? 0) : null;
    const runs = textRuns(pXml);
    const visible = runs.filter((r) => runText(r).trim());
    const bare = sameXml(pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, ""));
    return {
      index: p.index,
      text: p.text,
      styleId: p.styleId ?? null,
      styleLevel: p.headingLevel ?? null,
      inTable: p.inTable,
      toc: /^toc/i.test(p.styleId ?? "") || /\t\s*\d+\s*$/.test(p.text),
      numId: numId && numId !== "0" ? numId : null,
      ilvl,
      bold: visible.length > 0 && visible.every((r) => runBold(r) ?? styleBold(p.styleId)),
      kinds: match ? match(pXml, runs) : [],
      sig: numId && numId !== "0" ? `n${numId}:${ilvl}` : `p${p.styleId ?? ""}:${bare}`,
      // The same look on another list: every article of some firm files
      // numbers its sections with a list of its own.
      fsig: numId && numId !== "0" ? `f${p.styleId ?? ""}:${ilvl}:${bare.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, "")}` : null,
    };
  });
}

// Paragraphs given by a caller ({ text, kind?, kinds?, headingLevel?, … })
// take the same shape, numbered from 1 when they carry no index.
function fromCaller(paragraphs) {
  return paragraphs.map((p, i) => ({
    index: p.index ?? i + 1,
    text: String(p.text ?? ""),
    styleId: p.styleId ?? null,
    styleLevel: p.styleLevel ?? p.headingLevel ?? null,
    inTable: !!p.inTable,
    numId: p.numId ?? null,
    ilvl: p.ilvl ?? null,
    bold: p.bold ?? null,
    kinds: Array.isArray(p.kinds) ? p.kinds : p.kind ? [p.kind] : [],
    // A caller's paragraph has a signature only when it says something of
    // its format; plain text teaches nothing about headings.
    sig: p.sig ?? (p.kind ? `k${p.kind}` : p.numId ? `n${p.numId}:${p.ilvl ?? 0}` : p.styleId ? `p${p.styleId}` : (p.level ?? p.headingLevel) ? `L${p.level ?? p.headingLevel}` : null),
    fsig: p.fsig ?? null,
    level: p.level ?? null,
  }));
}

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const ONLY_BLANKS = /^(?:\s*(?:\[[^\]\n]{0,120}\]|_{3,})\s*)+$/;
/** Short enough, and ending as a heading ends, to be a heading. */
/** Short enough to be a heading or a fixed line ("Recitals:", "Schedule A – Notices"). */
const shortLine = (p) => !p.inTable && !p.toc && !!p.text.trim() && words(p.text) <= 16;
/** The same, in a table too (a proposal's boxed headings, a minutes title box). */
const shortAny = (p) => !p.toc && !!p.text.trim() && words(p.text) <= 16;
/**
 * Formatted as a heading may be: bold, a heading style or a heading kind
 * (or read from a caller who gave no format), and not ending as a clause or
 * limb ends ("Change in Law." in a list of events is not the article).
 */
const headingLike = (p) => (p.bold !== false || !!p.styleLevel || !!p.level || p.kinds.some((k) => /^h\d|heading|title/.test(k)))
  && !/[;,]\s*$/.test(p.text.trim()) && !(/\.\s*$/.test(p.text.trim()) && !/not\s+used\.?\s*$/i.test(p.text.trim()));
/** A short line ending as a heading ends (not "Government:" or "the Termination Date; or"). */
const headingShaped = (p) => shortLine(p) && !/[;,:]\s*$/.test(p.text.trim());

function headingKindLevel(kindsOf, headingKinds) {
  for (const k of kindsOf) {
    if (headingKinds && Object.hasOwn(headingKinds, k)) return headingKinds[k];
    if (!headingKinds) { const m = /^h([1-4])$/.exec(k); if (m) return Number(m[1]); }
  }
  return null;
}

// ---------------------------------------------------------------- the check

const label = (it) => it.label ?? it.heading;
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) && !/^(Ref|Subject|Dated|Copy|Attachments)\b/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const sentenceStart = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** How a finding names an item: "The Subject line", "Governing Law", "The Government's funding accounts article". */
const article = (it) => (it.match === "slot" ? `The ${lowerFirst(label(it))}` : sentenceStart(label(it)));

/** The answer of a decision ({ optionIds } or a bare option id or list), as a list of option ids. */
const answerIds = (answers, id) => {
  const a = answers?.[id];
  if (!a || a.skipped) return [];
  if (Array.isArray(a)) return a.map(String);
  if (typeof a === "string") return [a];
  return Array.isArray(a.optionIds) ? a.optionIds.map(String) : [];
};

/** How an item stands given the decisions: "always", "optional" or "absent" (the answer leaves it out). */
function effectivePresence(it, answers) {
  if (it.presence !== "decision") return it.presence;
  const chosen = answerIds(answers, it.decision);
  if (!chosen.length) return "open";
  if ((it.when ?? []).some((o) => chosen.includes(o))) return "always";
  if ((it.absentWhen ?? []).some((o) => chosen.includes(o))) return "absent";
  return "optional";
}

// The longest increasing run of positions: the items in the firm's order;
// every other matched item is out of order.
function inOrder(positions) {
  const n = positions.length;
  const len = Array(n).fill(1);
  const prev = Array(n).fill(-1);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (positions[j] < positions[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
  let best = -1;
  for (let i = 0; i < n; i++) if (best < 0 || len[i] > len[best]) best = i;
  const keep = new Set();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/**
 * Checks a document against a clause list.
 * @param {object} input
 * @param {Uint8Array} [input.bytes] the Word file, or
 * @param {Array} [input.paragraphs] its paragraphs ({ text, kind?, headingLevel?, level?, inTable? })
 * @param input.skeleton the clause list (the file's object or an array of items)
 * @param [input.kinds] the pack's kinds list, to read fixed parts by their format
 * @param [input.answers] the type's decision answers ({ id: { optionIds } }), for decision items
 * @param [input.confirmedOmissions] ids of items the lawyer confirmed may be left out
 * @returns {{ status: "complete"|"incomplete"|"blocked", blocking: boolean, missing, outOfOrder, unexpected, optionalUnmarked, decisionOpen, newClauses, notUsed, confirmed, present, unchecked, findings, summary }}
 */
export function checkSkeleton({ bytes, paragraphs, skeleton, kinds = null, answers = null, confirmedOmissions = [] } = {}) {
  const items = itemsOf(skeleton);
  const meta = Array.isArray(skeleton) ? {} : skeleton ?? {};
  const paras = bytes ? documentParagraphs(bytes, { kinds }) : fromCaller(paragraphs ?? []);
  const confirmedSet = new Set(confirmedOmissions ?? []);
  // A fixed part known only by its kind cannot be looked for in a document
  // read without the pack's kinds: it is reported as unchecked, not missing.
  const kindsKnown = paras.some((p) => p.kinds.length);
  const unchecked = items.filter((it) => (it.match ?? "heading") === "slot" && !it.pattern && !kindsKnown).map((it) => it.id);
  const skip = new Set(unchecked);
  const norms = paras.map((p) => (shortAny(p) || p.level ? normaliseHeading(p.text) : ""));
  const used = new Set();
  const found = new Map(); // item id → { pos, notUsed }
  let last = -1;

  const candidatesFor = (it) => {
    const out = [];
    if ((it.match ?? "heading") === "slot") {
      // By kind and, when the item has one, its pattern; a paragraph whose
      // format matches no kind (reformatted, or read without the kinds) is
      // judged by the pattern alone.
      const re = it.pattern ? new RegExp(it.pattern, "iu") : null;
      const slots = [].concat(it.slot ?? []);
      paras.forEach((p, pos) => {
        if (!p.text.trim() || (p.inTable && !it.inTable)) return;
        const byKind = slots.length && slots.some((s) => p.kinds.includes(s));
        const ok = re ? re.test(p.text.trim()) && (byKind || !slots.length || !p.kinds.length) : byKind;
        if (ok) out.push(pos);
      });
      return out;
    }
    const names = headingNames(it);
    norms.forEach((n, pos) => {
      if (!n || (paras[pos].inTable && !it.inTable) || !headingLike(paras[pos])) return;
      if (names.some((h) => sameHeading(n, h))) out.push({ pos, notUsed: false });
      else {
        const nu = notUsedOf(n);
        if (nu?.rest && names.some((h) => sameHeading(nu.rest, h))) out.push({ pos, notUsed: true });
      }
    });
    return out;
  };

  // The level a paragraph's own format gives it: a caller's level, a
  // heading kind, or a heading style (its list level when it is numbered).
  const formatLevel = (p) => p.level ?? headingKindLevel(p.kinds, meta.headingKinds) ?? (p.styleLevel ? (p.numId && p.ilvl !== null ? p.ilvl + 1 : p.styleLevel) : null);

  // First pass: each item to the first unused paragraph after the item
  // before it; failing that, the first unused anywhere (out of order).
  for (const it of items) {
    const cands = candidatesFor(it).map((c) => (typeof c === "number" ? { pos: c, notUsed: false } : c)).filter((c) => !used.has(c.pos));
    if (!cands.length) continue;
    // A heading whose own format says it is of another level (a "Change in
    // Law" section under Force Majeure is not the Change in Law article) is
    // not taken for the item.
    const fits = (c) => { const l = formatLevel(paras[c.pos]); return !l || !it.level || l === it.level; };
    const ok = (it.match ?? "heading") === "heading" ? cands.filter(fits) : cands;
    if (!ok.length) continue;
    const pick = ok.find((c) => c.pos > last) ?? ok[0];
    used.add(pick.pos);
    found.set(it.id, pick);
    if (pick.pos > last) last = pick.pos;
  }

  // Heading signatures learned from the items found: a paragraph formatted
  // like a matched heading is a heading of that level.
  const learned = new Map();
  for (const it of items) {
    const f = found.get(it.id);
    if (!f || (it.match ?? "heading") !== "heading" || !it.level) continue;
    for (const sig of [paras[f.pos].sig, paras[f.pos].fsig]) {
      if (!sig) continue;
      if (!learned.has(sig)) learned.set(sig, it.level);
      else if (learned.get(sig) !== it.level) learned.set(sig, null);
    }
  }
  const levelOf = (p) => {
    if (p.level) return p.level;
    const k = headingKindLevel(p.kinds, meta.headingKinds);
    if (k) return k;
    if (learned.get(p.sig)) return learned.get(p.sig);
    if (p.fsig && learned.get(p.fsig) && p.bold !== false) return learned.get(p.fsig);
    if (p.styleLevel) return p.numId && p.ilvl !== null ? p.ilvl + 1 : p.styleLevel;
    return null;
  };

  // "Not Used" headings standing where an unmatched item belongs.
  const notUsedAt = norms.map((n, pos) => (n && !paras[pos].inTable && notUsedOf(n)?.rest === "" && !used.has(pos) ? pos : -1)).filter((x) => x >= 0);
  const order = items.map((it, i) => ({ it, i }));
  for (const pos of notUsedAt) {
    // The unmatched item between the nearest matched items around this paragraph, at its level.
    const lvl = levelOf(paras[pos]);
    let before = -1;
    let after = items.length;
    for (const { it, i } of order) {
      const f = found.get(it.id);
      if (!f) continue;
      if (f.pos < pos) before = Math.max(before, i);
      else if (f.pos > pos && i < after) after = i;
    }
    const gap = order.filter(({ it, i }) => i > before && i < after && !found.has(it.id) && (it.match ?? "heading") === "heading" && (!lvl || it.level === lvl));
    const target = gap.find(({ it }) => it.presence !== "always" && it.not_used_form) ?? gap.find(({ it }) => it.presence !== "always") ?? gap[0];
    if (!target) continue;
    used.add(pos);
    found.set(target.it.id, { pos, notUsed: true });
  }

  // The firm's order.
  const matched = items.filter((it) => found.has(it.id));
  const keep = inOrder(matched.map((it) => found.get(it.id).pos));
  const outOfOrder = [];
  matched.forEach((it, k) => {
    if (keep.has(k)) return;
    const i = items.indexOf(it);
    const prevItem = items.slice(0, i).reverse().find((x) => found.has(x.id) && keep.has(matched.indexOf(x)));
    outOfOrder.push({ id: it.id, heading: it.heading, paragraph: paras[found.get(it.id).pos].index, sentence: prevItem ? `${article(it)} is out of the firm's order: it belongs after ${prevItem.heading}.` : `${article(it)} is out of the firm's order: it belongs nearer the start.` });
  });

  const missing = [];
  const optionalUnmarked = [];
  const decisionOpen = [];
  const confirmed = [];
  const notUsed = [];
  const present = [];
  const unexpected = [];
  for (const it of items) {
    if (skip.has(it.id)) continue;
    const f = found.get(it.id);
    const presence = effectivePresence(it, answers);
    if (f) {
      if (f.notUsed) notUsed.push(it.id);
      else present.push({ id: it.id, paragraph: paras[f.pos].index });
      if (f.notUsed && presence === "always") {
        if (confirmedSet.has(it.id)) confirmed.push(it.id);
        else missing.push({ id: it.id, heading: it.heading, sentence: `${article(it)} is marked "Not Used", but the firm's ${meta.typeName ?? "document"} always has it${it.presence === "decision" ? " given the answer to the drafting decision" : ""}.` });
      }
      if (!f.notUsed && presence === "absent") unexpected.push({ id: it.id, heading: it.heading, sentence: `${article(it)} is in the draft, but the answer to the drafting decision leaves it out${it.not_used_form ? ` or marks it "${it.not_used_form}"` : ""}.` });
      continue;
    }
    if (presence === "always") {
      if (confirmedSet.has(it.id)) confirmed.push(it.id);
      else missing.push({ id: it.id, heading: it.heading, sentence: `${article(it)} is missing${it.gap ? ` (${it.gap})` : ""}.` });
    } else if (presence === "optional") {
      if (it.not_used_form && !confirmedSet.has(it.id)) optionalUnmarked.push({ id: it.id, heading: it.heading, sentence: `${article(it)} is neither in the draft nor marked "${it.not_used_form}".` });
    } else if (presence === "open") {
      decisionOpen.push({ id: it.id, heading: it.heading, decision: it.decision, sentence: `${article(it)} is not in the draft, and the drafting decision it depends on (${it.decision}) has not been answered${it.gap ? ` (${it.gap})` : ""}${it.not_used_form ? `; if it is left out, mark it "${it.not_used_form}"` : ""}.` });
    }
  }

  // New clauses: heading-shaped paragraphs of a level the list covers in
  // full that match no item, inside the operative part (from the first
  // item found) and outside the items whose content is not scanned.
  const complete = new Set(meta.completeLevels ?? [...new Set(items.filter((it) => (it.match ?? "heading") === "heading" && it.level > 0).map((it) => it.level))]);
  const newClauses = [];
  const foundSorted = items.filter((it) => found.has(it.id)).map((it) => ({ it, pos: found.get(it.id).pos })).sort((a, b) => a.pos - b.pos);
  const regionOf = (pos) => { let r = null; for (const x of foundSorted) { if (x.pos <= pos) r = x; else break; } return r; };
  const firstOperative = foundSorted.find((x) => x.it.level >= 1);
  if (complete.size && firstOperative) {
    paras.forEach((p, pos) => {
      if (used.has(pos) || pos < firstOperative.pos || !headingShaped(p) || ONLY_BLANKS.test(p.text)) return;
      const lvl = levelOf(p);
      if (!lvl || !complete.has(lvl)) return;
      const region = regionOf(pos);
      if (region && region.it.scan === false) return;
      if (notUsedOf(norms[pos])) return;
      newClauses.push({ paragraph: p.index, heading: p.text.trim(), level: lvl, sentence: `"${p.text.trim()}" is not one of the firm's clauses for this document: it needs the AKLA comment "${NEW_CLAUSE_PREFIX} <why>".` });
    });
  }

  const blocking = missing.length > 0;
  const findings = [
    ...missing.map((m) => m.sentence),
    ...outOfOrder.map((m) => m.sentence),
    ...unexpected.map((m) => m.sentence),
    ...optionalUnmarked.map((m) => m.sentence),
    ...decisionOpen.map((m) => m.sentence),
    ...newClauses.map((m) => m.sentence),
  ];
  const status = blocking ? "blocked" : findings.length ? "incomplete" : "complete";
  const summary = blocking
    ? `Clause list: not filed — ${missing.length} of the firm's required parts ${missing.length === 1 ? "is" : "are"} missing (${missing.map((m) => m.heading).join(", ")}). Add ${missing.length === 1 ? "it" : "them"}, or confirm the omission.`
    : findings.length
      ? `Clause list: every required part is present; ${findings.length} ${findings.length === 1 ? "point" : "points"} to look at.`
      : `Clause list: every part the firm expects is present, in the firm's order.`;
  return { status, blocking, missing, outOfOrder, unexpected, optionalUnmarked, decisionOpen, newClauses, notUsed, confirmed, present, unchecked, findings, summary };
}

/**
 * The new clauses of a check, each with the comment it needs:
 * [{ paragraph, heading, sentence, comment }]. `paragraph` is the ¶ of the
 * heading itself (a heading already in the file can carry its comment).
 */
export function newClauseFindings(result) {
  return (result?.newClauses ?? []).map((n) => ({
    paragraph: n.paragraph,
    heading: n.heading,
    sentence: n.sentence,
    comment: newClauseComment(n.heading),
  }));
}

/** The comment a new clause carries. */
export function newClauseComment(heading, why = null) {
  return `${NEW_CLAUSE_PREFIX} ${why ?? `"${heading}" was added on the lawyer's instruction and follows none of the firm's precedents for this document; check its wording and its place.`}`;
}

/**
 * The headings a turn's ops write that match no item of the clause list and
 * carry no new-clause comment: [{ anchor, heading, level, op }], where `op`
 * is the comment op to add — on the paragraph the heading was written after
 * (the engine cannot comment a paragraph written in the same turn). A
 * heading is a "write" block of a heading kind (the list's headingKinds, or
 * h1…h4) or an insert_after text starting "# ".
 * @param {object} input
 * @param {Array} input.ops the turn's ops, as extractOps gives them
 * @param input.skeleton the clause list
 */
export function uncommentedNewClauses({ ops, skeleton }) {
  const items = itemsOf(skeleton);
  const meta = Array.isArray(skeleton) ? {} : skeleton ?? {};
  const complete = new Set(meta.completeLevels ?? [...new Set(items.filter((it) => (it.match ?? "heading") === "heading" && it.level > 0).map((it) => it.level))]);
  const names = items.filter((it) => (it.match ?? "heading") === "heading").flatMap(headingNames);
  const commented = new Map(); // anchor → comment texts
  for (const op of ops ?? []) {
    if ((op?.op ?? op?.kind) === "comment" && Number.isInteger(Number(op.p))) {
      const k = Number(op.p);
      commented.set(k, [...(commented.get(k) ?? []), String(op.text ?? "")]);
    }
  }
  const out = [];
  for (const op of ops ?? []) {
    const kind = op?.op ?? op?.kind;
    const written = [];
    if (kind === "write" && Array.isArray(op.blocks)) {
      for (const b of op.blocks) {
        const lvl = headingKindLevel([String(b?.kind ?? "")], meta.headingKinds);
        if (lvl && b.text) written.push({ heading: String(b.text).trim(), level: lvl, anchor: Number(op.after), expected: op.expected });
      }
    } else if (kind === "insert_after" && typeof op.text === "string") {
      const m = /^(#{1,4})\s+(.+)$/.exec(op.text.trim());
      if (m) written.push({ heading: m[2].trim(), level: m[1].length, anchor: Number(op.p), expected: op.expected });
    }
    for (const w of written) {
      if (!complete.has(w.level)) continue;
      const n = normaliseHeading(w.heading);
      if (!n || notUsedOf(n) || names.some((h) => sameHeading(n, h))) continue;
      const notes = commented.get(w.anchor) ?? [];
      if (notes.some((t) => t.trim().startsWith(NEW_CLAUSE_PREFIX))) continue;
      out.push({
        anchor: w.anchor,
        heading: w.heading,
        level: w.level,
        op: { op: "comment", p: w.anchor, expected: w.expected, text: newClauseComment(w.heading) },
      });
    }
  }
  return out;
}

/**
 * The clause list as a few lines for a drafting prompt or the connector:
 * the items in order with how each stands. Short: headings only.
 */
export function skeletonText(skeleton) {
  const items = itemsOf(skeleton);
  if (!items.length) return "";
  const mark = (it) => (it.presence === "always" ? "always" : it.presence === "optional" ? `optional${it.not_used_form ? `, else "${it.not_used_form}"` : ""}` : `depends on decision ${it.decision}${it.not_used_form ? `, else "${it.not_used_form}"` : ""}`);
  const lines = items.filter((it) => it.level <= 1 || it.presence !== "optional").map((it) => `${"  ".repeat(Math.max(0, it.level - 1))}- ${label(it)} (${mark(it)})`);
  return `THE FIRM'S CLAUSE LIST for this document, in order (a clause the lawyer asks for that is not on it goes where its subject belongs and carries the comment "${NEW_CLAUSE_PREFIX} <why>"; an "always" part is never dropped without the lawyer's confirmation):\n${lines.join("\n")}`;
}
