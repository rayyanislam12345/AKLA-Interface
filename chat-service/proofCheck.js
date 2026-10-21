// The proof check: a careful junior's read of a draft for the mechanical
// slips that survive into circulated versions. Deterministic, no model.
//
//   placeholders        [●], [ ], [insert …], [Agency/Concessionaire], drafting
//                       notes, "TBD", blank lines left to fill by hand
//   undefined_terms     a capitalised phrase used as a defined term would be
//                       but never defined, or a near-miss of a defined term
//   unused_definitions  a term defined but never used again
//   broken_references   "Clause 14.9" / "Schedule 4" when there is none
//   number_words        "thirty (31)", "PKR 1,000,000 (Pakistani Rupees Ten
//                       Thousand only)"
//   numbering           1.1 then 1.3 with no 1.2; (a), (b), (d); a number used twice
//
// The input is the index worker's reading of a file (indexing/extract.js):
// paragraphs ("blocks") with Word's own clause numbers already in the text.
// The rules are ported from firm-skills/concession-agreement/scripts/
// check_agreement.py (bracket classes, definition heads, reference checks,
// number-word agreement), widened from the concession master to any draft.
// Every rule leans towards silence: a check a lawyer learns to ignore is
// worse than no check.
//
// The wording check (runWordingCheck, at the end) is a second pass over the
// same reading against the firm's style sheet for the kind of document
// (styleSheets/): defined-term form, numbers and money in words and figures,
// dates, the [●] placeholder, cross-references with their headings, -ise
// spelling, banned phrasings and a named government or province. Its
// findings never block saving.
import { assignSections, isCapsHeading, layout, parseLabel } from "./indexing/chunk.js";
import { styleSheetFor } from "./styleSheets/index.js";
import { headingNorm } from "./clauseBank.js";

export const CATEGORIES = ["placeholders", "undefined_terms", "unused_definitions", "broken_references", "number_words", "numbering"];
export const MAX_ITEMS_PER_CATEGORY = 100;
const MAX_TEXT = 160;
const MAX_FIND = 60;

// ------------------------------------------------------------ paragraphs

const CONTAINER_WORDS = /^(Part|Chapter|Schedule|Annex(?:ure)?|Appendix|Exhibit)\s+([A-Za-z0-9.]+)/i;
const CLAUSE_WORDS = /^(Article|Section|Clause)\s+([A-Za-z0-9.]+)/i;
const capitalise = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const isAllCaps = (s) => /[A-Z]/.test(s) && !/[a-z]/.test(s);
const titleCase = (s) => s.toLowerCase().replace(/(^|\s)([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** A contents line: a heading followed by a page number. */
export function isTocLine(line) {
  const t = String(line ?? "").trim();
  if (t.length < 4 || t.length > 160 || !/[A-Za-z]/.test(t)) return false;
  if (/(?:\.{4,}|…{2,}|(?:\. ){3,}|·{3,}|_{4,})\s*(?:\d{1,3}|[ivxlc]{1,6})$/i.test(t)) return true;
  if (/\.{8,}\s*$/.test(t)) return true; // the page number fell onto the next line
  const spaced = /^(.*\S)(?:\t+| {2,})(\d{1,3})$/.exec(t);
  if (!spaced) return false;
  const head = spaced[1].trim();
  return Boolean(parseLabel(head)) || isCapsHeading(head) || /^(?:schedule|annex(?:ure)?|appendix|exhibit|part|article|section)\b/i.test(head);
}

/** A contents paragraph: its heading ("CONTENTS") or contents lines. */
export function isTocParagraph(text) {
  const t = String(text ?? "").trim();
  if (/^(?:table of contents|contents|index|list of schedules|list of annex(?:ure)?s|list of appendices)$/i.test(t)) return true;
  const lines = t.split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  const toc = lines.filter(isTocLine).length;
  return lines.length === 1 ? toc === 1 : toc / lines.length >= 0.6;
}

/** A page number standing alone: "3", "- 3 -", "Page 3 of 40". */
export const isPageNumber = (text) => /^(?:page\s*)?[-–(]?\s*\d{1,4}\s*[-–)]?(?:\s*of\s*\d{1,4})?$/i.test(String(text ?? "").trim());

function shortRef(entry) {
  const e = String(entry ?? "").trim();
  let m = CONTAINER_WORDS.exec(e);
  if (m) return { kind: "container", text: `${capitalise(m[1])} ${m[2].replace(/\.$/, "")}` };
  m = CLAUSE_WORDS.exec(e);
  if (m) return { kind: "clause", text: `${capitalise(m[1])} ${m[2].replace(/\.$/, "")}` };
  m = /^(\d{1,4}(?:\.\d{1,3})*)\.?(?:\s|$)/.exec(e);
  if (m) return { kind: "clause", text: `Clause ${m[1]}` };
  const heading = isAllCaps(e) ? titleCase(e) : e;
  return { kind: "heading", text: heading.length > 50 ? `${heading.slice(0, 49).trimEnd()}…` : heading };
}

function whereOf(path, own, page, index) {
  let container = null;
  let clause = null;
  let heading = null;
  for (const entry of path ?? []) {
    const s = shortRef(entry);
    if (s.kind === "container") { container = s.text; clause = null; heading = null; } else if (s.kind === "clause") { clause = s.text; heading = null; } else heading = s.text;
  }
  let where = [container, clause].filter(Boolean).join(", ");
  if (own?.kind === "sub" && clause) where += own.label;
  if (!where && heading) where = `“${heading}”`;
  if (page) where = where ? `${where}, p. ${page}` : `Page ${page}`;
  return where || `Paragraph ${index + 1}`;
}

/** The normalised key of a label: "14.2", "Article 14", "Schedule 3", "(a)". */
export function labelKey(info) {
  if (!info) return null;
  if (info.kind === "clause") return info.label.replace(/\.$/, "");
  if (info.kind === "sub") return info.label;
  const [word, id] = info.label.split(/\s+/);
  return `${capitalise(word.replace(/^annexure$/i, "Annex"))} ${String(id ?? "").toUpperCase()}`;
}

// "Termination for convenience", not "The Agency shall pay the sum of PKR".
const looksLikeTitle = (body) => {
  const t = body.trim();
  return t.length <= 100 && !/[.;:,]$/.test(t) && t.split(/\s+/).length <= 8 && !/\b(?:shall|will|may|must|is|are|has|have)\b/.test(t);
};

const ENDS_SENTENCE = /[.:;!?)\]”"’]\s*$/;

/**
 * The reader's blocks as paragraphs with their place in the document.
 * @param {{ blocks: Array<object> } | Array<object>} input
 */
export function toParagraphs(input) {
  const blocks = (Array.isArray(input) ? input : Array.isArray(input?.blocks) ? input.blocks : [])
    .filter((b) => b && typeof b.text === "string");
  const { text: fullText, blocks: placed } = layout(blocks);
  const sections = assignSections(placed);
  const paragraphs = [];
  let prev = null;
  sections.forEach((b, index) => {
    const text = b.text;
    let info = parseLabel(text);
    // A typed number at the start of a wrapped PDF line ("2.5 Million …")
    // is not a clause: a real label follows a finished sentence, a heading
    // or a title. Word's own numbering is always a label.
    if (info && !b.label && prev && !(ENDS_SENTENCE.test(prev.text) || prev.isHeading || isCapsHeading(prev.text) || (b.page && prev.page !== b.page))) info = null;
    const body = info ? info.rest : text;
    const bodyOffset = text.endsWith(body) ? text.length - body.length : 0;
    const p = {
      index,
      text,
      body,
      bodyOffset,
      start: b.start,
      end: b.end,
      page: b.page ?? null,
      inTable: Boolean(b.inTable),
      headingLevel: b.headingLevel ?? null,
      // A clause that opens with its title, not a clause of running text.
      isHeading: Boolean(b.sectionStart) && (!body.trim() || (b.headingLevel != null && body.length <= 200) || isCapsHeading(body) || looksLikeTitle(body)),
      path: b.path ?? [],
      info,
      key: labelKey(info),
      toc: isTocParagraph(text),
      pageNumber: isPageNumber(text),
    };
    p.where = whereOf(p.path, info, p.page, index);
    paragraphs.push(p);
    prev = p;
  });
  return { text: fullText, paragraphs };
}

// ------------------------------------------------------------ helpers

function excerpt(text, at = 0, length = 0, max = MAX_TEXT) {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  const room = Math.max(0, max - length);
  let start = Math.max(0, at - Math.floor(room / 2));
  if (start + max > t.length) start = Math.max(0, t.length - max);
  let out = t.slice(start, start + max);
  if (start > 0) out = `…${out.slice(1)}`;
  if (start + max < t.length) out = `${out.slice(0, -1)}…`;
  return out;
}

// A short exact piece of the paragraph's own words (no clause number, which
// the Word preview draws itself) to find it again in the rendered page.
function findText(p, at = p.bodyOffset) {
  const from = Math.max(p.bodyOffset, at - Math.floor(MAX_FIND / 2));
  let piece = p.text.slice(from, from + MAX_FIND);
  if (from > p.bodyOffset) piece = piece.replace(/^\S*\s/, "");
  if (from + MAX_FIND < p.text.length) piece = piece.replace(/\s\S*$/, "");
  return piece.replace(/\s+/g, " ").trim() || p.text.slice(0, MAX_FIND);
}

function item(category, severity, p, note, at = p.bodyOffset, length = 0) {
  return { category, severity, where: p.where, text: excerpt(p.text, at, length), note, find: findText(p, at) };
}

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString("en-US") : String(n));

// ------------------------------------------------------------ placeholders

const BRACKET = /\[[^[\]\n]{0,200}\]/g;
const NOT_PLACEHOLDER = /^(?:\d{1,4}|[a-wyzA-WYZ]|image|sic|emphasis (?:added|supplied|ours)|reserved|deleted|not used|omitted|redacted|signature pages? (?:follows?|to follow)|.*\bintentionally\b.*\bblank\b.*|this space (?:is )?intentionally left blank)$/i;

const PLACEHOLDER_KINDS = {
  blank: { severity: "medium", note: "A blank still to be filled in." },
  fill_in: { severity: "medium", note: "A bracketed field still to be filled in." },
  choice: { severity: "medium", note: "An open choice: pick one option and remove the brackets." },
  optional: { severity: "low", note: "Bracketed optional text: keep it (and remove the brackets) or delete it." },
  drafting_note: { severity: "high", note: "A drafting note or instruction. It must come out before the draft is circulated." },
  attachment: { severity: "low", note: "Waiting for an attachment." },
  hand_blank: { severity: "low", note: "A blank line to be completed by hand." },
};

/** check_agreement.py's bracket classes, widened: blank, fill_in, choice, optional, drafting_note, attachment; null = not a placeholder. */
export function classifyBracket(token, before = "") {
  const inner = token.slice(1, -1);
  const t = inner.trim();
  if (/^[\s●•○◦▪■_.…\-–—]*$/.test(inner) || /^[xX]{1,4}$/.test(t)) return "blank";
  if (/^(?:s|es|ies)$/i.test(t) && /[A-Za-z]$/.test(before)) return "choice";
  if (NOT_PLACEHOLDER.test(t)) return null;
  // Figures in a table, a formula, an OCR'd scrap: not a placeholder.
  if (/^[\d.,%\s]+(?:\/[\d.,%\s]+)+$/.test(t)) return "choice"; // [30/60]
  if (!/[A-Za-z]{2}/.test(t) || /[{}*=|^<>+]/.test(t)) return null;
  if (/^(?:[kMGT]?W[hp]?|kV|MVA|MVAr|USD|PKR|Rs|hrs?|hours|days|months|years|km|mm|kg|MT|m3|°C|nos?)$/i.test(t)) return null; // a unit in a table heading
  if (/^(?:drafting note|note to (?:draft|client|akla)|ntd\b|n\.?b\.?\b|note\b|akla (?:note|comment)|comment\b|internal note|tbd\b|tbc\b|tba\b|confirm\b|check\b|please\b|client to\b|query\b|q:|option\b|include only if|conditional amendment)/i.test(t)
    || /\bto be (?:populated|prepared|inserted|completed|updated|drafted|finali[sz]ed|reviewed|confirmed|discussed|agreed|decided|checked)\b/i.test(t)) return "drafting_note";
  if (/^(?:to be attached|list to be added|attached separately|to be annexed|to be provided)/i.test(t)) return "attachment";
  if (/^(?:insert|add|specify|state|enter|name of|details of|amount of|date of|address of)\b/i.test(t)) return "fill_in";
  const words = t.split(/\s+/).length;
  if ((t.includes("/") || /\bor\b/i.test(t)) && words <= 12) return "choice";
  if (/[;.]$/.test(t) || words > 6) return "optional";
  // [Date], [Name of Concessionaire], [1 July] are fields; [the DBFOMT] is optional wording.
  if (/^[a-z]/.test(t) && !/^(?:date|name|amount|address|number|month|year|location|place|party|sum|figure|value|percentage|days?)\b/i.test(t)) return "optional";
  return "fill_in";
}

const SIGNATURE_LINE = /(?:^|\s)(?:Name|Title|Designation|Signature|Signed|By|Witness(?:es)?|CNIC|Date|Place|Address|Seal|Stamp)\s*:|for and on behalf of/i;

const FIELD_WORD = /^(?:date|name|amount|address|number|month|year|location|place|party|sum|figure|value|percentage|days?|insert)\b/i;

function placeholderItems(paragraphs, notes) {
  const out = [];
  // A bracketed word the document uses over and over as a label of its own
  // ("[Inferred]", "[Law Silent]" in a memo's legend) is not a blank.
  const uses = new Map();
  for (const p of paragraphs) for (const m of p.text.matchAll(BRACKET)) uses.set(m[0], (uses.get(m[0]) ?? 0) + 1);
  const labels = new Set();
  for (const p of paragraphs) {
    if (p.toc || p.pageNumber) continue;
    const text = p.text;
    const spans = [];
    for (const m of text.matchAll(BRACKET)) {
      const kind = classifyBracket(m[0], text.slice(0, m.index));
      spans.push([m.index, m.index + m[0].length]);
      if (!kind) continue;
      if (kind === "fill_in" && (uses.get(m[0]) ?? 0) >= 4 && m[0].split(/\s+/).length <= 3 && !FIELD_WORD.test(m[0].slice(1).trim())) {
        labels.add(m[0]);
        continue;
      }
      const k = PLACEHOLDER_KINDS[kind];
      out.push({ ...item("placeholders", k.severity, p, k.note, m.index, m[0].length), kind });
    }
    const inBracket = (i) => spans.some(([s, e]) => i >= s && i < e);
    for (const m of text.matchAll(/●/g)) {
      if (inBracket(m.index)) continue;
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      if (!text.slice(lineStart, m.index).trim()) continue; // a bullet
      out.push({ ...item("placeholders", "medium", p, PLACEHOLDER_KINDS.blank.note, m.index, 1), kind: "blank" });
    }
    for (const m of text.matchAll(/\b(?:TBD|TBC|TBA)\b/g)) {
      if (inBracket(m.index)) continue;
      out.push({ ...item("placeholders", "high", p, PLACEHOLDER_KINDS.drafting_note.note, m.index, m[0].length), kind: "drafting_note" });
    }
    for (const m of text.matchAll(/(?:\b(?:PKR|Rs\.?|USD|US\$)|\$)\s*X{2,}\b|\bX{2,}\s*(?:%|percent\b|per cent\b|days\b|months\b|years\b|weeks\b)/gi)) {
      if (inBracket(m.index) || /\b(?:article|part|chapter|schedule|section)\s*$/i.test(text.slice(0, m.index))) continue;
      out.push({ ...item("placeholders", "medium", p, PLACEHOLDER_KINDS.blank.note, m.index, m[0].length), kind: "blank" });
    }
    const letters = text.replace(/[^A-Za-z]/g, "").length;
    if (text.length > 20 && letters >= 8 && !SIGNATURE_LINE.test(text)) {
      for (const m of text.matchAll(/_{4,}/g)) {
        if (inBracket(m.index)) continue;
        out.push({ ...item("placeholders", "low", p, PLACEHOLDER_KINDS.hand_blank.note, m.index, m[0].length), kind: "hand_blank" });
      }
    }
  }
  if (labels.size) notes.push(`Bracketed words the document uses throughout as labels (${[...labels].slice(0, 4).join(", ")}) were not counted as blanks.`);
  return out;
}

// ------------------------------------------------------------ definitions

const QUOTED = /[“"]([A-Z0-9][^“”"\n]{0,79}?)[”"]|‘([A-Z0-9][^‘’\n]{0,79}?)’(?![A-Za-z])/g;
const DEFINER = /^\s*(?:shall\s+)?(?:means?\b|mean\b|includes?\b|has the meaning|have the meaning|shall have the meaning|shall bear the meaning|bears the meaning|is defined|are defined|refers? to\b|:)/i;
const UNQUOTED_HEAD = /^([A-Z][A-Za-z0-9’'&/-]*(?:\s+(?:[A-Z][A-Za-z0-9’'&/-]*|of|and|for|the|to|in|on|or|by|under|&)){0,7})\s+(?:means|shall mean|shall have the meaning|shall bear the meaning|has the meaning)\b/;
const NOT_A_TERM_START = /^(?:The|This|That|It|Such|Each|Any|A|An|These|Those|All|No|Where|If|In|For)$/;

const cleanTerm = (t) => t.replace(/\(s\)$/, "").replace(/\s+/g, " ").trim();

function definitionSites(paragraphs) {
  const sites = [];
  for (const p of paragraphs) {
    if (p.toc) continue;
    const text = p.text;
    const add = (term, at) => {
      const clean = cleanTerm(term);
      if (clean.length >= 2 && /[A-Za-z]/.test(clean)) sites.push({ term: clean, p, at, end: at + term.length });
    };
    // "Term" means … / "Term" or "Other" means … at the head of the paragraph.
    const head = p.body.replace(/^\s*\(?[a-z0-9]{1,4}\)\s*/i, "");
    const headOffset = p.bodyOffset + (p.body.length - head.length);
    let rest = head;
    let pos = headOffset;
    const heads = [];
    for (;;) {
      const m = /^\s*(?:[“"]([^“”"\n]{1,80}?)[”"]|‘([^‘’\n]{1,80}?)’)/.exec(rest);
      if (!m) break;
      heads.push({ term: m[1] ?? m[2], at: pos + m[0].indexOf(m[1] ?? m[2]) });
      pos += m[0].length;
      rest = rest.slice(m[0].length);
      const joiner = /^\s*(?:,|or|and|\/)\s*/.exec(rest);
      if (joiner && /^\s*[“"‘]/.test(rest.slice(joiner[0].length))) {
        pos += joiner[0].length;
        rest = rest.slice(joiner[0].length);
      } else break;
    }
    if (heads.length && DEFINER.test(rest)) for (const h of heads) if (/^[A-Z0-9]/.test(h.term)) add(h.term, h.at);
    if (!heads.length) {
      const m = UNQUOTED_HEAD.exec(head);
      if (m && !NOT_A_TERM_START.test(m[1].split(/\s+/)[0]) && /[A-Z]/.test(m[1].split(/\s+/).pop()[0])) add(m[1], headOffset);
    }
    // (the "Agency"), (each a "Party" and together the "Parties").
    for (const paren of text.matchAll(/\(([^()]{1,240})\)/g)) {
      for (const q of paren[1].matchAll(QUOTED)) {
        const term = q[1] ?? q[2];
        add(term, paren.index + 1 + q.index + 1);
      }
    }
    // (the Signing Date), (together, the CP Period): term sheets define
    // without quote marks.
    for (const paren of text.matchAll(/\((?:the|each|together,? the|collectively,? the|hereinafter(?: referred to as)?(?: the)?|[^()]{0,60}?\b(?:referred to|called|known|defined)\b[^()]{0,40}?\bas(?: the)?)\s+([A-Z][\w'’-]*(?:\s+(?:of|and|for|to|in|on|the|[A-Z][\w'’-]*)){0,6})\)/g)) {
      const term = paren[1];
      if (/[A-Z]/.test(term.split(/\s+/).pop()[0])) add(term, paren.index + paren[0].indexOf(term));
    }
    // hereinafter referred to as the "Concessionaire" (no brackets).
    for (const m of text.matchAll(/(?:referred to as|hereinafter called|called|known as|defined as)\s+(?:the\s+)?[“"‘]([A-Z0-9][^“”"‘’\n]{0,79}?)[”"’]/g)) {
      const at = m.index + m[0].lastIndexOf(m[1]);
      if (!sites.some((s) => s.p === p && s.at === at)) add(m[1], at);
    }
  }
  return sites;
}

function variantsOf(term) {
  const v = new Set([term]);
  if (/[^aeiou]y$/.test(term)) v.add(`${term.slice(0, -1)}ies`);
  if (/ies$/.test(term)) v.add(`${term.slice(0, -3)}y`);
  else if (/[^s]s$/.test(term)) v.add(term.slice(0, -1));
  return [...v];
}

const isWordChar = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);

/** Positions where a term (or its plural/singular) is used in the text. */
function usesOf(fullText, term) {
  const found = [];
  for (const v of variantsOf(term)) {
    let i = fullText.indexOf(v);
    while (i !== -1) {
      const after = fullText.slice(i + v.length, i + v.length + 3);
      const suffix = /^(?:'s|’s|es|s)?/.exec(after)[0];
      if (!isWordChar(fullText[i - 1]) && !isWordChar(fullText[i + v.length + suffix.length])) found.push(i);
      i = fullText.indexOf(v, i + 1);
    }
  }
  return found;
}

function unusedDefinitionItems(fullText, sites) {
  const out = [];
  const siteRanges = sites.map((s) => [s.p.start + s.at, s.p.start + s.end]);
  const inSite = (pos) => siteRanges.some(([a, b]) => pos >= a && pos < b);
  const seen = new Set();
  for (const s of sites) {
    if (seen.has(s.term)) continue;
    seen.add(s.term);
    const uses = usesOf(fullText, s.term).filter((pos) => !inSite(pos));
    if (uses.length === 0) {
      out.push(item("unused_definitions", "low", s.p, `“${s.term}” is defined but not used anywhere else in this document.`, s.at, s.term.length));
    }
  }
  return out;
}

// ------------------------------------------------------------ undefined terms

const INCORPORATES = /(?:capitali[sz]ed|defined)\s+(?:terms?|expressions?|words?)\s+(?:and expressions\s+)?(?:used\s+)?(?:(?:herein|in this \w+)\s+)?(?:but\s+)?(?:which\s+are\s+)?not\s+(?:otherwise\s+)?defined|(?:terms|expressions)\s+(?:used\s+)?(?:but\s+)?not\s+(?:otherwise\s+)?defined\s+(?:herein|in this)/i;
const CONNECTORS = new Set(["of", "and", "for", "the", "to", "in", "on", "under", "&"]);
const NOT_TERM_WORDS = new Set(("Government Province Provincial Federal Federation Pakistan Pakistani Sindh Punjab Balochistan Khyber Pakhtunkhwa Islamabad Karachi Lahore Hyderabad Sukkur Quetta Peshawar Gwadar Republic Islamic Court Courts Supreme High Tribunal Ministry Division Department Secretary Act Acts Ordinance Rules Regulations Constitution Code Gazette Order Bank State Limited Ltd Pvt Private Corporation Inc LLP LLC Authority Commission Board Council Assembly Parliament Cabinet University Institute Chamber Messrs Mr Mrs Ms Dr Sir Honourable Hon'ble Justice "
  + "January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday "
  + "Article Articles Clause Clauses Section Sections Schedule Schedules Annex Annexure Appendix Exhibit Part Chapter Volume Table Figure Page Note Notes Paragraph "
  + "Road Motorway Highway River Port Island Street Avenue District City Town Tower Floor Block Sea Ocean Asia China Chinese United Kingdom States America English Urdu Islam Allah").split(/\s+/));
const HEAD_NOUNS = new Set(("date dates period account accounts agreement agreements event events notice notices plan plans fee fees cost costs amount amounts payment payments price prices works site sites facility facilities services documents document certificate certificates approval approvals consent consents law laws standards specifications requirements programme program report reports tariff rate rates revenue revenues guarantee guarantees security securities bond bonds default obligations rights assets lenders lender financing value charges charge toll tolls fund funds representative engineer expert contractor contractors operator consultant milestone milestones term year area corridor compensation damages loss losses liability liabilities insurance insurances permits permit licence license variation instruction instructions dispute disputes procedure procedures mechanism test tests completion commencement").split(/\s+/));

const CAP_WORD = /^[A-Z][A-Za-z0-9'’-]*$/;
const DETERMINER = /\b(?:the|a|an|any|each|such|that|this|every|all|no|its|their|relevant|applicable|said)\s+$/;

function capitalisedRuns(text) {
  const runs = [];
  const re = /[A-Za-z0-9&'’-]+/g;
  let run = null;
  let m;
  const close = () => {
    if (run) {
      while (run.words.length && CONNECTORS.has(run.words[run.words.length - 1])) run.words.pop();
      if (run.words.filter((w) => CAP_WORD.test(w)).length >= 2) runs.push(run);
    }
    run = null;
  };
  while ((m = re.exec(text)) !== null) {
    const w = m[0];
    const between = run ? text.slice(run.lastEnd, m.index) : "";
    if (run && !/^ +$/.test(between)) close();
    if (CAP_WORD.test(w)) {
      if (!run) run = { start: m.index, words: [] };
      run.words.push(w);
      run.lastEnd = m.index + w.length;
    } else if (run && CONNECTORS.has(w) && run.words.length && !CONNECTORS.has(run.words[run.words.length - 1])) {
      run.words.push(w);
      run.lastEnd = m.index + w.length;
    } else close();
  }
  close();
  return runs.map((r) => ({ start: r.start, words: r.words, phrase: r.words.join(" ") }));
}

const levenshtein = (a, b) => {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};

const pluralOf = (x, y) => y === `${x}s` || y === `${x}es` || (/y$/.test(x) && y === `${x.slice(0, -1)}ies`);

// 0: the same word (or its plural); 1: a near-miss ("Operation" for
// "Operations" is a plural, "Operation" for "Operational" is a near-miss);
// 9: a different word.
const wordDistance = (a, b) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y || pluralOf(x, y) || pluralOf(y, x)) return 0;
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k]) k++;
  if (k >= 5 && Math.min(x.length, y.length) - k <= 2 && Math.abs(x.length - y.length) <= 3) return 1;
  if (Math.min(x.length, y.length) >= 5 && levenshtein(x, y) <= 1) return 1;
  return 9;
};

function undefinedTermItems(paragraphs, sites, notes) {
  const terms = [...new Set(sites.map((s) => s.term))];
  if (terms.length < 5) return [];
  if (paragraphs.some((p) => INCORPORATES.test(p.text))) {
    notes.push("Undefined terms were not checked: the document says terms not defined in it take their meaning from another document.");
    return [];
  }
  const defined = new Set();
  for (const t of terms) for (const v of variantsOf(t)) defined.add(v);
  const multiWord = terms.filter((t) => t.split(" ").length >= 2).map((t) => ({ term: t, words: t.split(" ") }));
  // "Used like a defined term" means something only where terms are defined
  // in a clause of their own; a memo's capitals are just capitals.
  const definitionsClause = paragraphs.some((p) => p.isHeading && /\bdefinitions?\b/i.test(p.body)) || sites.filter((s) => DEFINER.test(s.p.text.slice(s.end + 1, s.end + 40))).length >= 10;
  const headingText = paragraphs.filter((p) => p.isHeading).map((p) => p.body.toLowerCase());

  // Can the phrase be read as defined terms joined by connectors?
  const composed = (words) => {
    const ok = new Array(words.length + 1).fill(false);
    ok[0] = true;
    for (let i = 0; i < words.length; i++) {
      if (!ok[i]) continue;
      if (CONNECTORS.has(words[i]) || NOT_TERM_WORDS.has(words[i]) || /^[A-Z0-9&-]{2,}$/.test(words[i])) ok[i + 1] = true;
      for (let j = i + 1; j <= words.length; j++) {
        const piece = words.slice(i, j).join(" ").replace(/(?:'s|’s)$/, "");
        if (defined.has(piece) || defined.has(piece.replace(/s$/, ""))) ok[j] = true;
      }
    }
    return ok[words.length];
  };

  const candidates = new Map();
  for (const p of paragraphs) {
    if (p.toc || p.isHeading || p.pageNumber) continue;
    const quoted = [...p.text.matchAll(/[“"‘][^“”"‘’\n]{1,80}[”"’]/g)].map((m) => [m.index, m.index + m[0].length]);
    for (const run of capitalisedRuns(p.text)) {
      if (run.start < p.bodyOffset || quoted.some(([a, b]) => run.start >= a && run.start < b)) continue;
      const before = p.text.slice(Math.max(0, run.start - 30), run.start);
      const midSentence = /[a-z,]\s+$/.test(before);
      if (!midSentence) continue;
      const words = run.words.map((w) => w.replace(/(?:'s|’s|'|’)$/, ""));
      if (words.every((w) => CONNECTORS.has(w) || /^[A-Z0-9&-]+$/.test(w))) continue;

      // (a) A near-miss of a defined term: "Commercial Operation Date" for
      // "Commercial Operations Date".
      for (const d of multiWord) {
        const n = d.words.length;
        for (let s = 0; s + n <= words.length; s++) {
          const window = words.slice(s, s + n);
          const phrase = window.join(" ");
          if (defined.has(phrase) || !CAP_WORD.test(window[0]) || !CAP_WORD.test(window[n - 1])) continue;
          // Only a term's head noun takes a plural ("Events of Default",
          // "Project Agreements"); an extra "s" anywhere else is a near-miss.
          const diffs = window.map((w, i) => {
            const head = i === n - 1 || d.words[i + 1] === "of";
            const dist = wordDistance(w, d.words[i]);
            return dist === 0 && !head && w.toLowerCase() !== d.words[i].toLowerCase() ? 1 : dist;
          }).reduce((a, b) => a + b, 0);
          if (diffs !== 1) continue;
          const key = `near:${phrase}`;
          const c = candidates.get(key) ?? { kind: "near", phrase, term: d.term, p, at: run.start, count: 0 };
          c.count++;
          candidates.set(key, c);
        }
      }

      // (b) Used as a defined term would be ("the Escrow Account", again and
      // again) but never defined.
      if (!definitionsClause) continue;
      const phrase = words.join(" ");
      if (defined.has(phrase) || composed(words)) continue;
      if (words.some((w) => NOT_TERM_WORDS.has(w))) continue;
      const last = words[words.length - 1];
      if (!HEAD_NOUNS.has(last.toLowerCase()) || !CAP_WORD.test(last)) continue;
      if (headingText.some((h) => h.includes(phrase.toLowerCase()))) continue;
      const key = `undef:${phrase}`;
      const c = candidates.get(key) ?? { kind: "undefined", phrase, p, at: run.start, count: 0, determined: 0 };
      c.count++;
      if (DETERMINER.test(before)) c.determined++;
      candidates.set(key, c);
    }
  }
  const out = [];
  for (const c of candidates.values()) {
    if (c.kind === "near") {
      out.push(item("undefined_terms", "medium", c.p, `“${c.phrase}” looks like the defined term “${c.term}” but is spelt differently${c.count > 1 ? ` (${c.count} times)` : ""}.`, c.at, c.phrase.length));
    } else if (c.count >= 2 && c.determined >= 1 && !candidates.has(`near:${c.phrase}`)) {
      out.push(item("undefined_terms", "low", c.p, `“${c.phrase}” is used ${c.count} times with capitals, as a defined term would be, but is not defined.`, c.at, c.phrase.length));
    }
  }
  return out;
}

// ------------------------------------------------------------ cross-references

// Case matters for the number ("Schedule A", never "Schedule to"), so the
// words are spelt in each case rather than matched with the i flag.
const REF_WORD = "([Cc]lauses?|[Ss]ub-?[Cc]lauses?|[Aa]rticles?|[Ss]ections?|[Ss]chedules?|[Aa]nnex(?:ure)?s?|[Aa]nnexes|[Aa]ppendi(?:x|ces)|[Ee]xhibits?|[Pp]arts?|CLAUSES?|SUB-?CLAUSES?|ARTICLES?|SECTIONS?|SCHEDULES?|ANNEX(?:URE)?S?|ANNEXES|APPENDI(?:X|CES)|EXHIBITS?|PARTS?)";
const REF_ID = "(?:\\d{1,3}(?:\\.\\d{1,3}){0,4}|[A-Z]{1,2}|[IVXLC]{1,6})(?:\\s*\\([a-zA-Z0-9]{1,4}\\))*";
const REF = new RegExp(`\\b${REF_WORD}\\s+(${REF_ID}(?:\\s*(?:,|and|or|to|through|-|–)\\s*${REF_ID})*)(?![A-Za-z0-9])`, "g");
const EXTERNAL_AFTER = /^\s*(?:\([a-zA-Z0-9]{1,4}\)\s*)*(?:of|to|in|under)\s+(?:the\s+)?(?:said\s+)?(?:[A-Z][\w'’&.,-]*\s+){0,8}?(?:Agreement|Act|Ordinance|Rules|Regulations|Constitution|Code|Contract|Deed|Policy|Order|Law|Guidelines|Framework|Convention|Treaty|Memorandum|Articles of Association|Letter|Bill|Instrument|RFP|Request for Proposals?|Bid|Proposal|Instructions|Term Sheet)\b/;
const OF_CONTAINER = /^\s*(?:\([a-zA-Z0-9]{1,4}\)\s*)*(?:of|to|in|under)\s+(?:the\s+)?(?:said\s+)?(Schedule|Annex(?:ure)?|Appendix|Exhibit|Part)\s+([A-Z0-9]{1,3}|[IVXLC]{1,6})\b/i;

const romanToInt = (s) => {
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const t = String(s).toLowerCase();
  if (!/^[ivxlcdm]+$/.test(t)) return null;
  let n = 0;
  for (let i = 0; i < t.length; i++) n += v[t[i]] < (v[t[i + 1]] ?? 0) ? -v[t[i]] : v[t[i]];
  return n;
};

function refFamily(word) {
  const w = word.toLowerCase().replace(/-/g, "");
  if (/^(?:sub)?clauses?$/.test(w)) return "Clause";
  if (/^articles?$/.test(w)) return "Article";
  if (/^sections?$/.test(w)) return "Section";
  if (/^schedules?$/.test(w)) return "Schedule";
  if (/^anne(?:x|xure|xes|xures)$/.test(w)) return "Annex";
  if (/^appendi(?:x|ces)$/.test(w)) return "Appendix";
  if (/^exhibits?$/.test(w)) return "Exhibit";
  if (/^parts?$/.test(w)) return "Part";
  return null;
}

function referenceTargets(paragraphs) {
  const numbers = new Set(); // clause numbers: "14", "14.2"
  const named = new Map(); // "Article" -> Set("14"), "Schedule" -> Set("3", "A")
  const subs = new Map(); // "14.2" -> Set("(a)")
  let clauseCount = 0;
  let currentClause = null;
  const addNamed = (word, id) => {
    if (!named.has(word)) named.set(word, new Set());
    named.get(word).add(String(id).toUpperCase());
    const r = /^[IVXLC]+$/i.test(id) ? romanToInt(id) : null;
    if (r) named.get(word).add(String(r));
  };
  // Every line that starts with a number counts, even one the paragraph
  // reading did not take for a clause (a PDF heading after a table): a
  // reference called broken that is not is worse than one missed.
  const labelsOf = (p) => {
    const found = p.info ? [p.info] : [];
    for (const line of p.text.split("\n").slice(p.info ? 1 : 0)) {
      const info = parseLabel(line.trim());
      if (info && info.kind !== "sub") found.push(info);
    }
    return found;
  };
  for (const p of paragraphs) {
    if (p.toc) continue;
    for (const info of labelsOf(p)) addLabel(info);
  }
  return { numbers, named, subs, clauseCount };

  function addLabel({ kind, label }) {
    if (kind === "clause") {
      const parts = label.replace(/\.$/, "").split(".");
      for (let i = 1; i <= parts.length; i++) numbers.add(parts.slice(0, i).join("."));
      clauseCount++;
      currentClause = parts.join(".");
    } else if (kind === "article") {
      const [word, id] = label.split(/\s+/);
      const family = refFamily(word);
      addNamed(family, id);
      const parts = id.split(".");
      for (let i = 1; i <= parts.length; i++) numbers.add(parts.slice(0, i).join("."));
      if (/^[IVXLC]+$/i.test(id)) numbers.add(String(romanToInt(id)));
      clauseCount++;
      currentClause = id;
    } else if (kind === "part") {
      const [word, id] = label.split(/\s+/);
      addNamed(refFamily(word), id);
      currentClause = null;
    } else if (kind === "sub" && currentClause) {
      if (!subs.has(currentClause)) subs.set(currentClause, new Set());
      subs.get(currentClause).add(label.toLowerCase());
    }
  }
}

function brokenReferenceItems(paragraphs, definesItself) {
  const { numbers, named, subs, clauseCount } = referenceTargets(paragraphs);
  const out = [];
  for (const p of paragraphs) {
    if (p.toc || p.pageNumber) continue;
    const text = p.text;
    const reported = new Set();
    const tocLines = [];
    let at = 0;
    for (const line of text.split("\n")) {
      if (isTocLine(line)) tocLines.push([at, at + line.length]);
      at += line.length + 1;
    }
    for (const m of text.matchAll(REF)) {
      if (m.index < p.bodyOffset || tocLines.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const family = refFamily(m[1]);
      if (!family) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 120);
      if (EXTERNAL_AFTER.test(after)) {
        const ext = EXTERNAL_AFTER.exec(after)[0];
        const internal = /\bthis\b/i.test(ext) || (definesItself && /\bthe\s+(?:Agreement|Contract)\s*$/i.test(ext));
        if (!internal) continue;
      }
      const ofContainer = OF_CONTAINER.exec(after);
      // "paragraph 2 of Schedule 3": numbering restarts inside a schedule.
      if (ofContainer && (family === "Clause" || family === "Section")) continue;
      const ids = m[2].split(/\s*(?:,|and|or|to|through|-|–)\s*/).map((s) => s.trim()).filter(Boolean);
      for (const raw of ids) {
        const idMain = raw.replace(/\s*\(.*$/, "");
        const sub = /\(([a-zA-Z0-9]{1,4})\)/.exec(raw)?.[0]?.toLowerCase() ?? null;
        let missing = false;
        if (family === "Clause") {
          if (clauseCount < 3 || !/^\d/.test(idMain)) continue;
          if (!numbers.has(idMain)) missing = true;
          else if (sub && subs.get(idMain)?.size && !subs.get(idMain).has(sub)) missing = true;
        } else {
          const known = named.get(family);
          if (!known || !known.size) continue; // the document has no numbered ones of its own
          if (!known.has(idMain.toUpperCase()) && !(family === "Article" && numbers.has(idMain))) missing = true;
        }
        if (!missing) continue;
        const shown = `${family} ${raw.replace(/\s+/g, "")}`;
        if (reported.has(shown)) continue;
        reported.add(shown);
        out.push(item("broken_references", "high", p, `Refers to ${shown}, but this document has no ${shown}.`, m.index, m[0].length));
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ numbers in words

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, million: 1e6, crore: 1e7, crores: 1e7, billion: 1e9 };
const ORDINALS = { first: "one", second: "two", third: "three", fourth: "four", fifth: "five", sixth: "six", seventh: "seven", eighth: "eight", ninth: "nine", tenth: "ten", eleventh: "eleven", twelfth: "twelve", thirteenth: "thirteen", fourteenth: "fourteen", fifteenth: "fifteen", sixteenth: "sixteen", seventeenth: "seventeen", eighteenth: "eighteen", nineteenth: "nineteen", twentieth: "twenty", thirtieth: "thirty", fortieth: "forty", fiftieth: "fifty", sixtieth: "sixty", seventieth: "seventy", eightieth: "eighty", ninetieth: "ninety", hundredth: "hundred", thousandth: "thousand" };
const NUMBER_WORD = new Set([...Object.keys(ONES), ...Object.keys(TENS), ...Object.keys(SCALES), ...Object.keys(ORDINALS), "hundred", "and"]);
const CURRENCY_WORDS = new Set(["pakistani", "pak", "rupees", "rupee", "rs", "pkr", "united", "states", "us", "dollars", "dollar", "usd", "euros", "euro", "pounds", "sterling", "only", "percent", "per", "cent", "centum"]);

/** Number words to a number, strictly ("one hundred and twenty", "Two Million Five Hundred Thousand"); null if they are not one number. */
export function parseNumberWords(input) {
  const tokens = (Array.isArray(input) ? input : String(input).split(/[\s-]+/)).map((t) => t.toLowerCase().replace(/[,.]/g, "")).filter(Boolean);
  if (!tokens.length) return null;
  const last = tokens[tokens.length - 1];
  if (ORDINALS[last]) tokens[tokens.length - 1] = ORDINALS[last];
  let i = 0;
  let total = 0;
  let lastScale = Infinity;
  for (;;) {
    let group = 0;
    let consumed = false;
    if (ONES[tokens[i]] >= 1 && ONES[tokens[i]] <= 9 && tokens[i + 1] === "hundred") {
      group = ONES[tokens[i]] * 100;
      i += 2;
      consumed = true;
      if (tokens[i] === "and" && (TENS[tokens[i + 1]] !== undefined || ONES[tokens[i + 1]] !== undefined)) i++;
    }
    if (TENS[tokens[i]] !== undefined) {
      group += TENS[tokens[i]];
      i++;
      consumed = true;
      if (ONES[tokens[i]] >= 1 && ONES[tokens[i]] <= 9) { group += ONES[tokens[i]]; i++; }
    } else if (ONES[tokens[i]] !== undefined && !(consumed && ONES[tokens[i]] === 0)) {
      group += ONES[tokens[i]];
      i++;
      consumed = true;
    }
    if (!consumed) return null;
    const scale = SCALES[tokens[i]];
    if (scale) {
      if (scale >= lastScale) return null;
      total += group * scale;
      lastScale = scale;
      i++;
      if (i === tokens.length) return total;
      if (tokens[i] === "and") i++;
      continue;
    }
    if (i !== tokens.length) return null;
    return total + group;
  }
}

function longestNumberSuffix(words) {
  const ws = [...words];
  while (ws.length && CURRENCY_WORDS.has(ws[ws.length - 1].toLowerCase())) ws.pop();
  for (let s = 0; s < ws.length; s++) {
    if (!NUMBER_WORD.has(ws[s].toLowerCase()) || ws[s].toLowerCase() === "and") continue;
    const value = parseNumberWords(ws.slice(s));
    if (value !== null) return { value, words: ws.slice(s).join(" ") };
  }
  return null;
}

const toNumber = (digits, multiplier) => {
  const n = Number(String(digits).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const scale = multiplier ? SCALES[multiplier.toLowerCase()] ?? 1 : 1;
  return Math.round(n * scale * 100) / 100;
};

// thirty (30) · fifty percent (50%) · One Million Rupees (PKR 1,000,000)
const WORDS_THEN_FIGURE = /((?:[A-Za-z]+[\s-]+){0,11}[A-Za-z]+)\s*\(\s*(?:(?:PKR|Rs\.?|USD|US\$|\$)\s*)?(\d[\d,]*(?:\.\d+)?)(?:\/-)?\s*(?:st|nd|rd|th)?\s*(?:%|percent|per cent)?\s*\)/g;
// 30 (thirty) · PKR 1,000,000/- (Pakistani Rupees One Million only) · 2.5 million (two million five hundred thousand)
const FIGURE_THEN_WORDS = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)(?:\/-)?\s*(million|billion|thousand|lakh|lac|crore)?\s*(?:%|percent|per cent)?\s*\(\s*([A-Za-z][A-Za-z\s,-]*?)\s*\)/gi;

function numberWordItems(paragraphs) {
  const out = [];
  for (const p of paragraphs) {
    if (p.toc || p.pageNumber) continue;
    const text = p.text;
    for (const m of text.matchAll(WORDS_THEN_FIGURE)) {
      const found = longestNumberSuffix(m[1].split(/[\s-]+/).filter(Boolean));
      if (!found) continue;
      const figure = toNumber(m[2]);
      if (figure === null || figure === found.value) continue;
      const paren = m.index + m[0].indexOf("(", m[1].length);
      const at = Math.max(m.index, paren - found.words.length - 1);
      out.push(item("number_words", "high", p, `The words say ${fmt(found.value)} but the figure says ${fmt(figure)}.`, at, m.index + m[0].length - at));
    }
    for (const m of text.matchAll(FIGURE_THEN_WORDS)) {
      const words = m[3].split(/[\s,-]+/).filter(Boolean);
      while (words.length && CURRENCY_WORDS.has(words[0].toLowerCase())) words.shift();
      while (words.length && CURRENCY_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
      if (!words.length || !words.some((w) => NUMBER_WORD.has(w.toLowerCase()) && w.toLowerCase() !== "and")) continue;
      const value = parseNumberWords(words);
      if (value === null) continue;
      const figure = toNumber(m[1], m[2]);
      if (figure === null || figure === value) continue;
      out.push(item("number_words", "high", p, `The figure says ${fmt(figure)} but the words say ${fmt(value)}.`, m.index, m[0].length));
    }
  }
  return out;
}

// ------------------------------------------------------------ numbering

const LETTER = (s) => (/^([a-z])\1*$/i.test(s) ? (s.toLowerCase().charCodeAt(0) - 96) + 26 * (s.length - 1) : null);
const clauseName = (parts) => (parts.length === 1 ? `Clause ${parts[0]}` : `Clause ${parts.join(".")}`);

function subOf(inner, stack) {
  if (/^\d+$/.test(inner)) return { type: "num", value: Number(inner) };
  const lower = inner === inner.toLowerCase();
  const roman = /^[ivxlcdm]+$/i.test(inner) ? romanToInt(inner) : null;
  const letter = LETTER(inner);
  const rType = lower ? "roman" : "ROMAN";
  const lType = lower ? "letter" : "LETTER";
  const last = (type) => stack.find((s) => s.type === type)?.value ?? null;
  if (roman && letter) {
    // (i) after (h) is a letter; (ii), (iii) are always roman; (v) is roman
    // only inside a roman list.
    if (last(rType) !== null && roman === last(rType) + 1) return { type: rType, value: roman };
    if (last(lType) !== null && letter === last(lType) + 1) return { type: lType, value: letter };
    if (inner.length > 1) return { type: rType, value: roman };
    if (inner.toLowerCase() === "i") return { type: rType, value: 1 };
    return { type: lType, value: letter };
  }
  if (roman && /^[ivxlcdm]{2,}$/i.test(inner) && !letter) return { type: rType, value: roman };
  if (letter) return { type: lType, value: letter };
  return null;
}

const subLabel = (type, value) => {
  if (type === "num") return `(${value})`;
  if (type === "letter" || type === "LETTER") {
    const s = String.fromCharCode(97 + ((value - 1) % 26)).repeat(Math.floor((value - 1) / 26) + 1);
    return `(${type === "LETTER" ? s.toUpperCase() : s})`;
  }
  const r = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let n = value;
  let s = "";
  for (const [v, t] of r) while (n >= v) { s += t; n -= v; }
  return `(${type === "ROMAN" ? s.toUpperCase() : s})`;
};

// The missing number written inline in the paragraphs in between ("(a) …;
// (b) …; and" on one line, then "(c)" on its own) is not a gap.
const writtenBetween = (paragraphs, from, to, label) => {
  const re = new RegExp(`(?<![\\w.])${label.replace(/[.()]/g, "\\$&")}(?![\\w])`);
  for (let i = from; i < to; i++) if (re.test(paragraphs[i].text)) return true;
  return false;
};

function numberingItems(paragraphs) {
  const out = [];
  // Page-read files (PDFs, scans) lose and reorder numbers in OCR and
  // layout: only gaps are reported there, quietly.
  const paged = paragraphs.some((p) => p.page);
  let levels = []; // levels[d] = { parent, n, at }
  let subs = []; // stack of { type, value, at }
  for (const p of paragraphs) {
    if (p.toc || p.inTable || p.pageNumber || !p.info) continue;
    const { kind, label } = p.info;
    if (kind === "part") { levels = []; subs = []; continue; }
    if (kind === "sub") {
      const inner = label.slice(1, -1);
      const s = subOf(inner, subs);
      if (!s) continue;
      const at = subs.findIndex((x) => x.type === s.type);
      const prev = at === -1 ? null : subs[at].value;
      const prevAt = at === -1 ? p.index : subs[at].at;
      if (at === -1) subs.push({ type: s.type, value: s.value, at: p.index });
      else { subs.length = at + 1; subs[at].value = s.value; subs[at].at = p.index; }
      if (prev === null) continue;
      if (s.value > prev + 1 && s.value - prev <= 4 && !writtenBetween(paragraphs, prevAt, p.index, subLabel(s.type, prev + 1))) {
        const missing = s.value - prev === 2 ? `there is no ${subLabel(s.type, prev + 1)}` : `${subLabel(s.type, prev + 1)} to ${subLabel(s.type, s.value - 1)} are missing`;
        out.push(item("numbering", "low", p, `${label} follows ${subLabel(s.type, prev)}; ${missing}.`, 0, label.length));
      } else if (s.value === prev && !paged) {
        out.push(item("numbering", "low", p, `${label} is used twice in a row.`, 0, label.length));
      }
      continue;
    }
    subs = [];
    let parts;
    if (kind === "clause") parts = label.replace(/\.$/, "").split(".").map(Number);
    else {
      const id = label.split(/\s+/)[1] ?? "";
      const n = /^\d+$/.test(id) ? Number(id) : /^[IVXLC]+$/i.test(id) ? romanToInt(id) : null;
      if (n === null || !/^(?:article|clause)$/i.test(label.split(/\s+/)[0])) continue;
      parts = [n];
    }
    if (parts.some((n) => !Number.isFinite(n))) continue;
    const d = parts.length;
    const parent = parts.slice(0, -1).join(".");
    const n = parts[d - 1];
    const prev = levels[d];
    const name = kind === "clause" ? clauseName(parts) : label;
    const missingLabel = [...parts.slice(0, -1), (prev?.n ?? 0) + 1].join(".");
    if (prev && prev.parent === parent) {
      if (n > prev.n + 1 && n - prev.n <= 6 && !writtenBetween(paragraphs, prev.at, p.index, missingLabel)) {
        const missing = n - prev.n === 2 ? `there is no ${clauseName([...parts.slice(0, -1), prev.n + 1])}` : `${clauseName([...parts.slice(0, -1), prev.n + 1])} to ${clauseName([...parts.slice(0, -1), n - 1])} are missing`;
        out.push(item("numbering", paged ? "low" : "medium", p, `${name} follows ${clauseName([...parts.slice(0, -1), prev.n])}; ${missing}.`, 0, label.length));
      } else if (n === prev.n && !paged) {
        out.push(item("numbering", "medium", p, `${name} is numbered twice.`, 0, label.length));
      } else if (n < prev.n && n !== 1 && !paged) {
        out.push(item("numbering", "low", p, `${name} comes after ${clauseName([...parts.slice(0, -1), prev.n])}.`, 0, label.length));
      }
    } else if (d > 1 && n > 1 && (!prev || prev.parent !== parent)) {
      const parentSeen = levels[d - 1] && [levels[d - 1].parent, levels[d - 1].n].filter((x) => x !== "").join(".") === parent;
      if (parentSeen && !writtenBetween(paragraphs, levels[d - 1].at ?? p.index, p.index, [...parts.slice(0, -1), 1].join("."))) {
        const first = clauseName([...parts.slice(0, -1), 1]);
        out.push(item("numbering", paged ? "low" : "medium", p, `${name} is the first in its list; there is no ${n === 2 ? first : `${first} to ${clauseName([...parts.slice(0, -1), n - 1])}`}.`, 0, label.length));
      }
    }
    levels[d] = { parent, n, at: p.index };
    levels.length = d + 1;
  }
  return out;
}

// ------------------------------------------------------------ the check

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const AMENDS = /\b(?:is|are|shall be|stands?) hereby (?:amended|deleted|replaced|substituted|inserted|modified)\b|\b(?:supplemental|supplementary|amendment|amending|novation|variation) (?:agreement|deed)\b|\b(?:principal|original|main) (?:agreement|contract)\b/i;

/** The first clause or article number in the body: { n: 14, label: "Section 14.4" }. */
function firstNumber(paragraphs) {
  for (const p of paragraphs) {
    if (p.toc || !p.info) continue;
    if (p.info.kind === "clause") return { n: Number(p.info.label.split(".")[0]), label: p.info.label.replace(/\.$/, "") };
    if (p.info.kind === "article") {
      const id = p.info.label.split(/\s+/)[1] ?? "";
      const n = /^\d/.test(id) ? Number(id.split(".")[0]) : romanToInt(id);
      if (n) return { n, label: p.info.label };
    }
  }
  return null;
}

/**
 * Runs every check on one reading of a document.
 * @param {{ blocks: Array<object> } | Array<object>} structuredText the reader's output (extractForIndex) or its blocks
 * @returns {{ version: number, checked_at: string, paragraphs: number, counts: Record<string, number>, total: number, items: Array<{ category: string, severity: 'high'|'medium'|'low', where: string, text: string, note: string, find: string, kind?: string }>, omitted: Record<string, number>, notes: string[] }}
 */
export function runProofCheck(structuredText) {
  const { text: fullText, paragraphs } = toParagraphs(structuredText);
  const notes = [];
  const sites = definitionSites(paragraphs);
  const definesItself = sites.some((s) => /^(?:Agreement|Contract)$/.test(s.term)) || /\bthis (?:Agreement|Contract)\b/.test(fullText);
  // Pages 93-138 of an agreement: its references and terms point outside the file.
  const start = firstNumber(paragraphs);
  const extract = start !== null && start.n > 3;
  if (extract) notes.push(`This file looks like part of a longer document (its numbering starts at ${start.label}), so cross-references and defined terms were not checked.`);
  // A supplemental or amending agreement cites the clauses and schedules of the one it amends.
  const amends = !extract && AMENDS.test(fullText);
  if (amends) notes.push("This document amends or supplements another, so its references to clauses, schedules and exhibits were not checked.");
  const found = {
    placeholders: placeholderItems(paragraphs, notes),
    undefined_terms: extract ? [] : undefinedTermItems(paragraphs, sites, notes),
    unused_definitions: extract ? [] : unusedDefinitionItems(fullText, sites),
    broken_references: extract || amends ? [] : brokenReferenceItems(paragraphs, definesItself),
    number_words: numberWordItems(paragraphs),
    numbering: numberingItems(paragraphs),
  };
  const counts = {};
  const omitted = {};
  const items = [];
  for (const category of CATEGORIES) {
    const list = found[category];
    counts[category] = list.length;
    if (list.length > MAX_ITEMS_PER_CATEGORY) omitted[category] = list.length - MAX_ITEMS_PER_CATEGORY;
    // Within a category the serious ones first, then document order.
    const ordered = list.map((x, i) => ({ x, i })).sort((a, b) => (SEVERITY_ORDER[a.x.severity] - SEVERITY_ORDER[b.x.severity]) || (a.i - b.i)).map((o) => o.x);
    for (const x of ordered.slice(0, MAX_ITEMS_PER_CATEGORY)) items.push(x);
  }
  return {
    version: 1,
    checked_at: new Date().toISOString(),
    paragraphs: paragraphs.length,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    items,
    omitted,
    notes,
  };
}

// ------------------------------------------------------------ the wording check
//
// runWordingCheck(blocks, { styleSheet }) reads a draft against the firm's
// style sheet for its kind of document (styleSheets/; a key, a document type
// name or a merged sheet) and returns findings in the proof check's shape.
// Wording findings never block saving: a lawyer may want an exception.

export const WORDING_CATEGORIES = ["defined_term_form", "number_words", "date_format", "placeholder_style", "cross_ref_heading", "spelling_convention", "banned_phrase", "government_named"];

const SMALL_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS_WORDS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function below1000(n, and) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h) parts.push(`${SMALL_WORDS[h]} hundred`);
  if (r) {
    const words = r < 20 ? SMALL_WORDS[r] : `${TENS_WORDS[Math.floor(r / 10)]}${r % 10 ? ` ${SMALL_WORDS[r % 10]}` : ""}`;
    parts.push(h && and ? `and ${words}` : words);
  }
  return parts.join(" ");
}

/** An integer in the firm's words: "one hundred and twenty five" (counts), or without "and" for money. Null outside 0 to 999,999,999,999. */
export function numberToWords(n, { and = true } = {}) {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) return null;
  if (n === 0) return "zero";
  const out = [];
  let r = n;
  for (const [v, w] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) {
    if (r >= v) { out.push(`${below1000(Math.floor(r / v), and)} ${w}`); r %= v; }
  }
  if (r) out.push(`${and && out.length && r < 100 ? "and " : ""}${below1000(r, and)}`);
  return out.join(" ");
}

const titleWords = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const pad2 = (d) => String(d).padStart(2, "0");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTHS_RE = MONTH_NAMES.join("|");
const CURRENCY_NAMES = { PKR: "Pakistani Rupees", USD: "United States Dollars", EUR: "Euros", GBP: "Pounds Sterling" };

const quotedSpans = (text) => [...text.matchAll(/[“"][^“”"\n]{0,400}[”"]/g)].map((m) => [m.index, m.index + m[0].length]);
const within = (spans, i) => spans.some(([a, b]) => i >= a && i < b);

// Compiled once per style sheet.
const COMPILED = new Map();
function compile(sheet) {
  const key = sheet;
  if (COMPILED.has(key)) return COMPILED.get(key);
  const units = [...new Set(sheet.numbers?.units ?? [])].sort((a, b) => b.length - a.length).map(escapeRe);
  const spellingWords = Object.keys(sheet.spelling?.words ?? {});
  const c = {
    period: units.length ? new RegExp(`(?<![\\w(.,/\\-–])(\\d{1,4})(?![\\d,.]\\d)(?!\\))\\s+(?:(?:calendar|clear|consecutive)\\s+)?(${units.join("|")})\\b`, "g") : null,
    spellingMap: spellingWords.length ? new RegExp(`\\b(${spellingWords.map(escapeRe).join("|")})\\b`, "gi") : null,
    banned: (sheet.banned ?? []).filter((b) => b.pattern).map((b) => ({ ...b, re: new RegExp(b.pattern, `${(b.flags ?? "").replace(/g/g, "")}g`) })),
    government: (sheet.government?.patterns ?? []).map((p) => new RegExp(p, "g")),
  };
  COMPILED.set(key, c);
  return c;
}

// --- defined terms in the firm's form: (the **Term**), no quotation marks
const DEFINITION_HEAD_QUOTED = /^\s*(?:\(?[a-z0-9]{1,4}\)\s*)?[“"]([^“”"\n]{1,80})[”"]\s*(?:,\s*)?(?:shall\s+)?(?:means?\b|includes?\b|has the meaning|shall have the meaning|shall bear the meaning|bears the meaning)/i;

function definedTermFormItems(paragraphs, sheet, tells) {
  if (sheet.defined_terms?.form !== "bold-parenthesis-no-quotes") return [];
  const out = [];
  for (const p of paragraphs) {
    const head = DEFINITION_HEAD_QUOTED.exec(p.body);
    if (head) {
      tells.quoted++;
      const at = p.bodyOffset + head.index + head[0].indexOf(head[1]) - 1;
      out.push(item("defined_term_form", "low", p, `In the definitions the term is bold without quotation marks: **${head[1].trim()}** means …`, at, head[1].length + 2));
    }
    for (const paren of p.text.matchAll(/\(([^()]{1,240})\)/g)) {
      for (const q of paren[1].matchAll(QUOTED)) {
        const term = (q[1] ?? q[2]).trim();
        // A quoted phrase in brackets that is not a definition ("(the words “in writing”)") stays.
        const before = paren[1].slice(0, q.index);
        if (before.trim() && !/(?:^|\b)(?:the|each|a|an|together|collectively|jointly|individually|both|hereinafter(?: referred to as)?(?: the)?|referred to as(?: the)?|and together the|and collectively the|or)\s*,?\s*$/i.test(before)) continue;
        tells.quoted++;
        out.push(item("defined_term_form", "low", p, `Defined terms are bold in brackets without quotation marks: (the **${term}**).`, paren.index + 1 + q.index, q[0].length));
      }
    }
  }
  return out;
}

// --- numbers and money in words and figures
const MONEY = /(PKR|Rs\.?|Rupees|USD|US\$|\$|EUR|GBP)\s?(\d[\d,]*(?:\.\d+)?)(\s*\/-)?(?:\s*(million|billion|thousand|lakh|lac|crore)\b)?/g;
const BEFORE_IS_REFERENCE = /(?:section|clause|article|schedule|annex(?:ure)?|appendix|paragraph|para|rule|regulation|page|no\.?|item|part|chapter|form|table|figure|exhibit)\s*$/i;

function numberFormItems(paragraphs, sheet, compiled) {
  const out = [];
  if (compiled.period) {
    for (const p of paragraphs) {
      if (p.inTable) continue;
      for (const m of p.text.matchAll(compiled.period)) {
        if (m.index < p.bodyOffset || BEFORE_IS_REFERENCE.test(p.text.slice(Math.max(0, m.index - 14), m.index))) continue;
        const n = Number(m[1]);
        const words = numberToWords(n);
        if (!words) continue;
        out.push(item("number_words", "low", p, `Write it in words and figures: ${words} (${n}) ${m[2]}.`, m.index, m[0].length));
      }
      for (const m of p.text.matchAll(/(?<![\w(.,/\-–])(\d{1,3}(?:\.\d+)?)\s*(%|percent\b|per cent\b)(?!\))/g)) {
        if (m.index < p.bodyOffset) continue;
        const n = Number(m[1]);
        const words = Number.isInteger(n) ? numberToWords(n) : null;
        out.push(item("number_words", "low", p, words ? `Write it in words and figures: ${words} percent (${n}%).` : "Write a percentage in words and figures, as in fifty percent (50%).", m.index, m[0].length));
      }
    }
  }
  // Money: every amount once in words (its first mention), and in PKR, not Rs.
  const codes = sheet.money?.currency_codes ?? ["PKR", "USD"];
  const seen = [];
  const worded = new Set();
  for (const p of paragraphs) {
    if (p.inTable) continue;
    for (const m of p.text.matchAll(MONEY)) {
      const prev = p.text[m.index - 1];
      if (prev && /[\w]/.test(prev)) continue;
      const value = toNumber(m[2], m[4]);
      if (value === null) continue;
      const after = p.text.slice(m.index + m[0].length, m.index + m[0].length + 240);
      const before = p.text.slice(Math.max(0, m.index - 240), m.index);
      const hasWords = /^\s*\([^()]{0,220}?(?:Rupees|Dollars|Euros?|Pounds)/i.test(after) || (prev === "(" && /(?:Rupees|Dollars|Euros?|Pounds)\b[^()]{0,220}$/i.test(before.slice(0, -1)));
      if (hasWords) worded.add(value);
      seen.push({ p, m, value, hasWords });
    }
  }
  const reported = new Set();
  for (const { p, m, value, hasWords } of seen) {
    const raw = m[1].replace(/\.$/, "");
    const code = /^(?:Rs|Rupees)$/i.test(raw) ? "PKR" : /^(?:US\$|\$)$/.test(raw) ? "USD" : raw;
    const figure = Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
    if (!codes.includes(raw)) {
      out.push(item("number_words", "low", p, `The firm writes the currency as ${code}: ${code} ${figure}/-.`, m.index, m[0].length));
    }
    if (hasWords || worded.has(value) || reported.has(value)) continue;
    reported.add(value);
    const words = Number.isInteger(value) ? numberToWords(value, { and: false }) : null;
    const name = CURRENCY_NAMES[code] ?? code;
    out.push(item("number_words", "low", p, words ? `Write the amount in figures and words where it first appears: ${code} ${figure}/- (${name} ${titleWords(words)} Only).` : `Write the amount in figures and words where it first appears, as in PKR 1,000,000/- (Pakistani Rupees One Million Only).`, m.index, m[0].length));
  }
  return out;
}

// --- dates: October 19, 2026
function dateFormatItems(paragraphs, sheet, tells) {
  const out = [];
  const pad = sheet.dates?.zero_pad !== false;
  const say = (month, day, year) => `${MONTH_NAMES[month]} ${pad ? pad2(day) : day}, ${year}`;
  const note = (s) => `Write dates as ${s} (month, day, year).`;
  const DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(day\\s+of\\s+)?(${MONTHS_RE})\\s*,?\\s+(\\d{4})\\b`, "g");
  const MDY = new RegExp(`\\b(${MONTHS_RE})\\s+(\\d{1,2})(st|nd|rd|th)?(,?)\\s+(\\d{4})\\b`, "g");
  const ABBR_MDY = /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
  const ABBR_DMY = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?,?\s+(\d{4})\b/g;
  const NUMERIC = /(?<![\d.\/-])(\d{1,2})([\/.-])(\d{1,2})\2(\d{4})(?![\d\/.-])/g;
  const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  const monthOf = (name) => MONTH_NAMES.findIndex((m) => m.toLowerCase() === name.toLowerCase());
  for (const p of paragraphs) {
    const t = p.text;
    for (const m of t.matchAll(DMY)) {
      if (m[2]) continue; // "on this 19th day of October, 2026": the preamble's own formula
      tells.dates++;
      out.push(item("date_format", "low", p, note(say(monthOf(m[3]), Number(m[1]), m[4])), m.index, m[0].length));
    }
    for (const m of t.matchAll(MDY)) {
      const day = Number(m[2]);
      if (!m[3] && m[4] && !(pad && m[2].length === 1)) continue;
      if (m[3]) tells.dates++;
      out.push(item("date_format", "low", p, note(say(monthOf(m[1]), day, m[5])), m.index, m[0].length));
    }
    for (const m of t.matchAll(ABBR_MDY)) out.push(item("date_format", "low", p, note(say(MONTH_ABBR[m[1].toLowerCase()], Number(m[2]), m[3])), m.index, m[0].length));
    for (const m of t.matchAll(ABBR_DMY)) out.push(item("date_format", "low", p, note(say(MONTH_ABBR[m[2].toLowerCase()], Number(m[1]), m[3])), m.index, m[0].length));
    for (const m of t.matchAll(NUMERIC)) {
      let day = Number(m[1]);
      let month = Number(m[3]);
      if (month > 12 && day <= 12) [day, month] = [month, day];
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      out.push(item("date_format", "low", p, note(say(month - 1, day, m[4])), m.index, m[0].length));
    }
    for (const m of t.matchAll(ISO)) {
      const month = Number(m[2]);
      if (month < 1 || month > 12) continue;
      out.push(item("date_format", "low", p, note(say(month - 1, Number(m[3]), m[1])), m.index, m[0].length));
    }
  }
  return out;
}

// --- the placeholder: [●]
function placeholderStyleItems(paragraphs, sheet) {
  const token = sheet.placeholder?.token ?? "[●]";
  const out = [];
  const say = `The firm's placeholder is ${token}.`;
  for (const p of paragraphs) {
    const text = p.text;
    const spans = [];
    for (const m of text.matchAll(BRACKET)) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0] === token || classifyBracket(m[0], text.slice(0, m.index)) !== "blank") continue;
      out.push(item("placeholder_style", "low", p, say, m.index, m[0].length));
    }
    for (const m of text.matchAll(/[●•]/g)) {
      if (within(spans, m.index)) continue;
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      if (!text.slice(lineStart, m.index).trim()) continue; // a bullet
      out.push(item("placeholder_style", "low", p, say, m.index, 1));
    }
    const letters = text.replace(/[^A-Za-z]/g, "").length;
    if (text.length > 20 && letters >= 8 && !SIGNATURE_LINE.test(text)) {
      for (const m of text.matchAll(/_{4,}/g)) if (!within(spans, m.index)) out.push(item("placeholder_style", "low", p, say, m.index, m[0].length));
    }
  }
  return out;
}

// --- cross-references: Section 2.1 (The Appointment), pointing at something that exists
function headingTitles(paragraphs) {
  const titles = new Map();
  paragraphs.forEach((p, i) => {
    if (!p.key || p.toc) return;
    let title = p.isHeading ? p.body.trim() : "";
    if (!title && !p.body.trim()) {
      const next = paragraphs[i + 1];
      if (next && !next.info && looksLikeTitle(next.text)) title = next.text.trim();
    }
    if (!title && p.info?.kind !== "sub") {
      // A run-in heading: "14.2 Dispute Resolution. Any dispute …"
      const m = /^([A-Z][^.:;]{1,70}?)[.:]\s+\S/.exec(p.body.trim());
      if (m && looksLikeTitle(m[1]) && m[1].split(/\s+/).length <= 8) title = m[1];
    }
    title = title.replace(/[\s.–—-]+$/, "");
    // A clause's opening words are not its heading.
    if (!title || title.length > 120 || /[;:,]$/.test(title) || /\b(?:shall|will|may|must|is|are|has|have|hereby)\b/.test(title)) return;
    if (!titles.has(p.key)) titles.set(p.key, isAllCaps(title) ? titleCase(title) : title);
  });
  return titles;
}

function crossRefItems(paragraphs, sheet, { amends, extract, definesItself }) {
  const targets = referenceTargets(paragraphs);
  if (targets.clauseCount < 3 || extract) return [];
  const titles = headingTitles(paragraphs);
  const words = Array.isArray(sheet.cross_refs?.words) ? sheet.cross_refs.words : null;
  const titleFor = (family, id) => {
    const up = id.toUpperCase();
    if (family === "Clause" || family === "Section") return titles.get(id) ?? titles.get(`Section ${id}`) ?? titles.get(`Clause ${id}`) ?? titles.get(`Article ${id}`) ?? null;
    if (family === "Article") return titles.get(`Article ${up}`) ?? titles.get(id) ?? null;
    return titles.get(`${family} ${up}`) ?? null;
  };
  const maxTop = Math.max(0, ...[...targets.numbers].map((n) => Number(n.split(".")[0])).filter(Number.isFinite));
  const exists = (family, idMain) => {
    if (family === "Part") return true; // Parts restart inside each Schedule
    // "Section 301" in an agreement of thirty Articles is a statute's section.
    if (/^\d/.test(idMain) && Number(idMain.split(".")[0]) > maxTop) return true;
    if (family === "Clause" || family === "Section") return !/^\d/.test(idMain) || targets.numbers.has(idMain) || (targets.named.get("Section")?.has(idMain.toUpperCase()) ?? false);
    const known = targets.named.get(family);
    if (!known || !known.size) return true; // the document numbers none of its own
    return known.has(idMain.toUpperCase()) || (family === "Article" && targets.numbers.has(idMain));
  };
  const usedWords = new Set();
  const wrongWord = [];
  const out = [];
  for (const p of paragraphs) {
    if (p.toc || p.pageNumber) continue;
    const text = p.text;
    const mentioned = new Set();
    for (const m of text.matchAll(REF)) {
      if (m.index < p.bodyOffset) continue;
      const family = refFamily(m[1]);
      if (!family) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 160);
      if (EXTERNAL_AFTER.test(after)) {
        const ext = EXTERNAL_AFTER.exec(after)[0];
        if (!(/\bthis\b/i.test(ext) || (definesItself && /\bthe\s+(?:Agreement|Contract)\s*$/i.test(ext)))) continue;
      }
      if (OF_CONTAINER.test(after) && (family === "Clause" || family === "Section")) continue;
      const ids = m[2].split(/\s*(?:,|and|or|to|through|-|–)\s*/).map((s) => s.trim()).filter(Boolean);
      if (["Clause", "Section", "Article"].includes(family) && ids.some((x) => /^\d/.test(x))) {
        usedWords.add(family);
        if (words && !words.includes(family)) wrongWord.push({ p, m, family, id: ids[0] });
      }
      for (const raw of ids) {
        // "Section 5 (Fees)": a four-letter heading read as a sub-clause letter.
        const subHeading = /\s*\(([A-Z][a-z]{2,3})\)$/.exec(raw);
        const rawId = subHeading ? raw.slice(0, subHeading.index) : raw;
        const idMain = rawId.replace(/\s*\(.*$/, "");
        const shown = `${family} ${rawId.replace(/\s+/g, "")}`;
        if (!amends && !exists(family, idMain)) {
          out.push(item("cross_ref_heading", "high", p, `${shown} is referred to, but this document has no ${shown}.`, m.index, m[0].length));
          continue;
        }
        if (ids.length !== 1 || rawId !== idMain) continue; // a range, or a limb: no heading expected
        const title = titleFor(family, idMain);
        if (!title) continue;
        const given = subHeading ? subHeading[1] : /^\s*\(([^()]{2,120})\)/.exec(after)?.[1] ?? null;
        if (given) {
          const g = headingNorm(given);
          const t = headingNorm(title);
          if (g && t && !g.includes(t) && !t.includes(g)) {
            out.push(item("cross_ref_heading", "medium", p, `The heading in brackets, “${given.trim()}”, is not the heading of ${shown}, which is “${title}”.`, m.index, m[0].length));
          }
        } else if (sheet.cross_refs?.heading_required && !mentioned.has(shown)) {
          out.push(item("cross_ref_heading", "low", p, `Give the heading with the reference: ${shown} (${title}).`, m.index, m[0].length));
        }
        mentioned.add(shown);
      }
    }
  }
  // "Clause 4.2" in a document that otherwise says "Section": only a mix is reported.
  if (words && wrongWord.length && words.some((w) => usedWords.has(w))) {
    const preferred = words.find((w) => usedWords.has(w)) ?? words[0];
    for (const { p, m, family, id } of wrongWord) {
      out.push(item("cross_ref_heading", "low", p, `This document calls its provisions “${preferred}”: “${family} ${id}” should read “${preferred} ${id}”.`, m.index, m[0].length));
    }
  }
  return out;
}

// --- spelling: British -ise
const IZE_WORD = /\b[A-Za-z]*?(?:iz(?:e|es|ed|ing|ation|ations|ational|er|ers|able)|yz(?:e|es|ed|ing|er|ers))\b/g;
const IZE_KEEP = /(?:size|sized|sizes|sizing|seize|seized|seizes|seizing|seizure|prize|prizes|prized|maize|baize|assize|assizes|citizen\w*|denizen\w*|wizard\w*|blizzard\w*)$/;

const matchCase = (model, word) => (model === model.toUpperCase() && model.length > 1 ? word.toUpperCase() : /^[A-Z]/.test(model) ? word.charAt(0).toUpperCase() + word.slice(1) : word);

function spellingItems(paragraphs, sheet, compiled, tells) {
  if (sheet.spelling?.convention !== "ise") return [];
  const keep = new Set((sheet.spelling.keep ?? []).map((w) => w.toLowerCase()));
  const keepAfter = sheet.spelling.keep_after ?? {};
  const map = sheet.spelling.words ?? {};
  const found = new Map(); // lower-case word -> { p, at, word, suggest, count }
  const note = (p, at, word, suggest) => {
    const k = word.toLowerCase();
    const f = found.get(k);
    if (f) f.count++;
    else found.set(k, { p, at, word, suggest, count: 1 });
  };
  for (const p of paragraphs) {
    const text = p.text;
    for (const m of text.matchAll(IZE_WORD)) {
      const w = m[0];
      const lower = w.toLowerCase();
      if (lower.length < 5 || keep.has(lower) || IZE_KEEP.test(lower)) continue;
      // "World Health Organization": a name keeps its own spelling.
      if (/^organization/.test(lower) && /^[A-Z]/.test(w)) {
        const before = text.slice(Math.max(0, m.index - 30), m.index);
        const after = text.slice(m.index + w.length, m.index + w.length + 30);
        if (/[A-Z][\w&-]*\s+$/.test(before) || /^\s+(?:for|of)\s+[A-Z]/.test(after)) continue;
      }
      const suggest = lower.replace(/iz(e|es|ed|ing|ation|ations|ational|er|ers|able)$/, "is$1").replace(/yz(e|es|ed|ing|er|ers)$/, "ys$1");
      if (suggest === lower) continue;
      note(p, m.index, w, matchCase(w, suggest));
    }
    if (compiled.spellingMap) {
      for (const m of text.matchAll(compiled.spellingMap)) {
        const w = m[0];
        const lower = w.toLowerCase();
        const prevWord = /([A-Za-z]+)\s+$/.exec(text.slice(Math.max(0, m.index - 20), m.index))?.[1]?.toLowerCase();
        if (prevWord && (keepAfter[lower] ?? []).includes(prevWord)) continue;
        note(p, m.index, w, matchCase(w, map[lower] ?? map[Object.keys(map).find((k) => k.toLowerCase() === lower)]));
      }
    }
  }
  tells.american = [...found.keys()].length;
  return [...found.values()].map((f) => item("spelling_convention", "low", f.p, `British spelling: “${f.suggest}”, not “${f.word}”${f.count > 1 ? ` (${f.count} times)` : ""}.`, f.at, f.word.length));
}

// --- banned phrasings
const WE_WORDS = /\b(?:we|We|WE|our|Our|OUR|ours|us)\b/g;
const WILL_OBLIGATION = /\b((?:[A-Z][\w’'-]*\s+){0,3}[A-Z][\w’'-]*)\s+will\s+(?!be\s+deemed\b|have\s+the\s+meaning\b)([a-z]{3,})/g;
const NOT_A_PARTY = /^(?:It|This|That|There|These|Those|Which|What|If|When|Where|Who|He|She|They|You|I)$/;
const isRecital = (p) => /^\s*(?:WHEREAS|Whereas|RECITALS?)\b/.test(p.text) || p.path.some((e) => /recital|background|whereas/i.test(e));

function bannedItems(paragraphs, sheet, compiled, tells) {
  const out = [];
  for (const b of compiled.banned) {
    for (const p of paragraphs) {
      for (const m of p.text.matchAll(b.re)) {
        if (b.id === "hereinafter") tells.hereinafter++;
        if (b.id === "witnesseth") tells.witnesseth++;
        out.push(item("banned_phrase", b.severity ?? "low", p, b.reason, m.index, m[0].length));
      }
    }
  }
  const checks = new Map((sheet.banned ?? []).filter((b) => b.check).map((b) => [b.check, b]));
  const voice = checks.get("voice");
  if (voice && sheet.voice?.we_allowed === false) {
    for (const p of paragraphs) {
      const quotes = quotedSpans(p.text);
      const hits = [...p.text.matchAll(WE_WORDS)].filter((m) => !within(quotes, m.index) && !/^US$/.test(m[0]));
      if (!hits.length) continue;
      out.push(item("banned_phrase", voice.severity ?? "medium", p, `${voice.reason}${hits.length > 1 ? ` (${hits.length} times in this paragraph)` : ""}`, hits[0].index, hits[0][0].length));
    }
  }
  const will = checks.get("will_obligation");
  if (will && (!will.kinds || will.kinds.includes(sheet.kind))) {
    for (const p of paragraphs) {
      if (isRecital(p) || p.isHeading) continue;
      const quotes = quotedSpans(p.text);
      for (const m of p.text.matchAll(WILL_OBLIGATION)) {
        const subject = m[1].split(/\s+/);
        if (NOT_A_PARTY.test(subject[subject.length - 1]) || within(quotes, m.index)) continue;
        tells.will++;
        const at = m.index + m[0].indexOf(" will ") + 1;
        out.push(item("banned_phrase", will.severity ?? "low", p, will.reason, at, 4));
      }
    }
  }
  return out;
}

// --- a named government or province
const DEFINES_GOVERNMENT = /\bGovernment[”"’*]*\s+(?:means|shall mean)\b|\(\s*(?:the\s+)?[“"‘*]*Government[”"’*]*\s*\)/;
const LAW_END = /\b(?:Act|Ordinance|Rules|Regulations)$/;

function governmentItems(paragraphs, sheet, compiled) {
  if (!compiled.government.length) return [];
  const out = [];
  for (const p of paragraphs) {
    if (DEFINES_GOVERNMENT.test(p.text)) continue; // where the deal's Government is named, once
    const seen = new Set();
    for (const re of compiled.government) {
      for (const m of p.text.matchAll(re)) {
        if (seen.has(m.index)) continue;
        seen.add(m.index);
        const law = LAW_END.test(m[0]);
        out.push(item("government_named", "medium", p, law
          ? `“${m[0]}” is a province-specific or federal-only law: write [applicable PPP law] (or [●]) so the document fits any government.`
          : `“${m[0]}” names a government, province or provincial body: use the defined term Government (named once, where it is defined), or [●] or a neutral description in brackets.`, m.index, m[0].length));
      }
    }
  }
  return out;
}

/**
 * The wording check: a draft read against the firm's style sheet.
 * @param {{ blocks: Array<object> } | Array<object>} blocks the reader's output (extractForIndex) or its blocks
 * @param {{ styleSheet?: string|object|null }} [options] a style-sheet key or document type name, or a merged sheet (styleSheets/index.js styleSheetFor); the firm-wide core when absent
 * @returns {{ version: number, kind: 'wording', style_sheet: string, blocking: false, checked_at: string, paragraphs: number, counts: Record<string, number>, total: number, items: Array<object>, omitted: Record<string, number>, notes: string[], ms: number }}
 */
export function runWordingCheck(blocks, { styleSheet = null } = {}) {
  const started = Date.now();
  const sheet = styleSheet && typeof styleSheet === "object" ? styleSheet : styleSheetFor(styleSheet ?? "core");
  const compiled = compile(sheet);
  const { text: fullText, paragraphs: all } = toParagraphs(blocks);
  const paragraphs = all.filter((p) => !p.toc && !p.pageNumber);
  const notes = [];
  if ((sheet.key ?? "core") === "core") notes.push("No style sheet for this kind of document: the firm-wide rules were applied.");
  const sites = definitionSites(all);
  const definesItself = sites.some((s) => /^(?:Agreement|Contract)$/.test(s.term)) || /\bthis (?:Agreement|Contract)\b/.test(fullText);
  const start = firstNumber(all);
  const extract = start !== null && start.n > 3;
  const amends = !extract && AMENDS.test(fullText);
  const tells = { quoted: 0, hereinafter: 0, witnesseth: 0, american: 0, will: 0, dates: 0 };
  const found = {
    defined_term_form: definedTermFormItems(paragraphs, sheet, tells),
    number_words: numberFormItems(paragraphs, sheet, compiled),
    date_format: dateFormatItems(paragraphs, sheet, tells),
    placeholder_style: placeholderStyleItems(paragraphs, sheet),
    cross_ref_heading: crossRefItems(all, sheet, { amends, extract, definesItself }),
    spelling_convention: spellingItems(paragraphs, sheet, compiled, tells),
    banned_phrase: bannedItems(paragraphs, sheet, compiled, tells),
    government_named: governmentItems(paragraphs, sheet, compiled),
  };
  if (extract) notes.push(`This file looks like part of a longer document (its numbering starts at ${start.label}), so cross-references were not checked.`);
  else if (amends) notes.push("This document amends another, so whether its cross-references exist was not checked.");
  // The marks of another firm's draft.
  const marks = [
    tells.quoted >= 3 && "defined terms in quotation marks",
    tells.hereinafter >= 1 && "\"hereinafter referred to as\"",
    tells.witnesseth >= 1 && "\"WITNESSETH\"",
    tells.american >= 3 && "American -ize spelling",
    tells.will >= 3 && "\"will\" for obligations",
    tells.dates >= 2 && "dates written day-month",
  ].filter(Boolean);
  if (marks.length >= 2) notes.push(`This reads like another firm's draft (${marks.join(", ")}). If it is the counterparty's, these are its conventions, not slips; if it is to become the firm's draft, bring it to the firm's form.`);
  const counts = {};
  const omitted = {};
  const items = [];
  for (const category of WORDING_CATEGORIES) {
    const list = found[category];
    counts[category] = list.length;
    if (list.length > MAX_ITEMS_PER_CATEGORY) omitted[category] = list.length - MAX_ITEMS_PER_CATEGORY;
    const ordered = list.map((x, i) => ({ x, i })).sort((a, b) => (SEVERITY_ORDER[a.x.severity] - SEVERITY_ORDER[b.x.severity]) || (a.i - b.i)).map((o) => o.x);
    for (const x of ordered.slice(0, MAX_ITEMS_PER_CATEGORY)) items.push(x);
  }
  return {
    version: 1,
    kind: "wording",
    style_sheet: sheet.key ?? "core",
    blocking: false,
    checked_at: new Date().toISOString(),
    paragraphs: all.length,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    items,
    omitted,
    notes,
    ms: Date.now() - started,
  };
}

/** One line for a reply: "Wording: 3 points to look at (2 dates, 1 defined term) — none stops the draft being filed." */
export function wordingSummary(result) {
  if (!result) return "";
  const names = { defined_term_form: "defined term", number_words: "number or amount", date_format: "date", placeholder_style: "placeholder", cross_ref_heading: "cross-reference", spelling_convention: "spelling", banned_phrase: "phrasing", government_named: "named government" };
  const parts = WORDING_CATEGORIES.filter((c) => result.counts?.[c]).map((c) => `${result.counts[c]} ${names[c]}${result.counts[c] === 1 ? "" : "s"}`);
  if (!parts.length) return "Wording: nothing to report against the firm's style sheet.";
  return `Wording: ${result.total} point${result.total === 1 ? "" : "s"} to look at against the firm's style sheet (${parts.join(", ")}); none stops the draft being filed.`;
}
