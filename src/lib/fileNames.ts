// Reads the firm's file names. Two thirds of the firm's 26,785 files follow
// one grammar, left to right:
//
//   [<ordinal>. ]<CODE><n>[.<m>] - <Title> [<Holder>][<Stage>][<Month DD, YYYY>]
//     [vN] [- Clean | - Track | - Compared | (tracked changes)] [(1) | (2)]
//
// e.g. "KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026].docx".
// parseFileName pulls that apart so an upload can be titled, labelled and
// filed as a new version of the right document without anyone typing. It is
// forgiving of the drift seen in practice: "[AKLA}", a missing bracket,
// "30May, 2025", double spaces, four spellings of circulation, and the
// "(1)" a browser adds to a second download of the same file.
//
// No imports and only erasable TypeScript, so tests/fileNames.test.js can
// load this file directly with Node.

export type Stage =
  | "Working draft"
  | "AI markup"
  | "For partner review"
  | "Circulated"
  | "Received"
  | "Compared"
  | "Client comments"
  | "Final"
  | "Execution";

export type Rendition = "clean" | "tracked" | "compared";

export interface ParsedFileName {
  /** The name as given. */
  original: string;
  /** Lower-case extension without the dot, or null. */
  extension: string | null;
  /** The human title: code, tags, date, rendition and duplicate markers removed. */
  title: string;
  /** Project code, e.g. "KPT". */
  code: string | null;
  /** Running number after the code, e.g. "5.7" or "3A". */
  seq: string | null;
  /** Bracket tags in the order they appear, dates and rendition words removed. */
  tags: string[];
  /** Where the document is in its life, from a fixed list. */
  stage: Stage | null;
  /** The version's as-of date from the name (never the file's own date), YYYY-MM-DD. */
  date: string | null;
  rendition: Rendition | null;
  /** A "v2" / "v.2" suffix, if any. */
  version: number | null;
  /** The name carries a browser or Explorer duplicate marker: "(1)", "- Copy". */
  duplicate: boolean;
  /** Lower-cased, punctuation-free title, for matching versions of one document. */
  familyKey: string;
}

// Later in a document's life wins when a name carries more than one stage tag.
const STAGE_ORDER: Stage[] = [
  "Working draft",
  "AI markup",
  "For partner review",
  "Circulated",
  "Received",
  "Compared",
  "Client comments",
  "Final",
  "Execution",
];

// One tag, first rule that matches. Order matters: "Final Circ Version" is a
// circulation, "Pre-Execution Version" is execution, "Claude Markup" is AI,
// "Compared against AKLA First Circulated Draft" is a comparison.
const STAGE_RULES: Array<[RegExp, Stage]> = [
  [/\b(claude|chat\s?gpt|gpt|ai\s+(?:\d+(?:st|nd|rd|th)\s+)?mark-?up|ai\s+review|ai\s+draft)\b/i, "AI markup"],
  [/\b(pre-?\s?execution|execution|executed|signing|signed)\b/i, "Execution"],
  [/\bcompar(e|ed|ison)\b/i, "Compared"],
  [/\b(cir|circ|circul\w*|curcul\w*|circl\w*|cirulat\w*)\b/i, "Circulated"],
  [/\b(rec|recd|rcvd|received|receipt|recieved)\b/i, "Received"],
  [/\b(client|consolidated|counterparty)\s+comments?\b|^comments$/i, "Client comments"],
  [/\bfor\s+[\w.]+(\s+[\w.]+)?\s+review\b|\b(boss|partner|senior)\s+review\b|\bto\s+print\s+and\s+read\b/i, "For partner review"],
  [/\b(final|print\s+version)\b/i, "Final"],
  [/\b(wd|wip|working\s+draft|draft|revised|revision|fur(ther)?\s+edits|mark-?up)\b/i, "Working draft"],
];

export function stageFromTag(tag: string): Stage | null {
  for (const [re, stage] of STAGE_RULES) if (re.test(tag)) return stage;
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?(?![a-z])";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const DATE_PATTERNS: Array<{ re: RegExp; order: "mdy" | "dmy" | "ymd" | "dmyNum" }> = [
  { re: new RegExp(`(?<![a-z])${MONTH}\\s*${DAY}\\s*,?\\s*(\\d{4})(?!\\d)`, "i"), order: "mdy" },
  { re: new RegExp(`(?<!\\d)${DAY}\\s*-?\\s*${MONTH}\\s*,?\\s*(\\d{4})(?!\\d)`, "i"), order: "dmy" },
  { re: /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/, order: "ymd" },
  { re: /(?<![\d.])(\d{1,2})[-.](\d{1,2})[-.](\d{4}|\d{2})(?![\d.])/, order: "dmyNum" },
];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The first date written in the text, in any of the firm's styles. */
export function findDate(text: string): { iso: string; index: number; length: number } | null {
  let best: { iso: string; index: number; length: number } | null = null;
  for (const { re, order } of DATE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    let iso: string | null = null;
    if (order === "mdy") iso = isoDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    else if (order === "dmy") iso = isoDate(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
    else if (order === "ymd") iso = isoDate(+m[1], +m[2], +m[3]);
    else iso = isoDate(+m[3], +m[2], +m[1]);
    if (iso && (!best || m.index < best.index)) best = { iso, index: m.index, length: m[0].length };
  }
  return best;
}

const RENDITION_WORD = "clean(?:ed)?|track(?:ed)?(?:\\s+changes)?|redline(?:d)?|compared|comparison";
const RENDITION_SUFFIX = new RegExp(`\\s*(?:[-–—]\\s*(${RENDITION_WORD})|\\(\\s*(${RENDITION_WORD})\\s*\\))$`, "i");
const RENDITION_PREFIX = new RegExp(`^(${RENDITION_WORD})\\s*[-–—:]\\s*`, "i");
const RENDITION_ONLY = new RegExp(`^(?:${RENDITION_WORD})$`, "i");

function renditionOf(word: string): Rendition {
  const w = word.toLowerCase();
  if (w.startsWith("clean")) return "clean";
  if (w.startsWith("compar")) return "compared";
  return "tracked";
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/^[\s\-–—_,.;:]+|[\s\-–—_,;:]+$/g, "")
    .trim();
}

interface Collected {
  duplicate: boolean;
  stages: Stage[];
  renditions: Rendition[];
  versions: number[];
  dates: string[];
}

// Peels markers off the end of the text until none is left: "(1)",
// "- Copy", "- Clean", "(tracked changes)", "v2", a date without brackets.
function stripTrailing(input: string, out: Collected): string {
  let s = input;
  for (let guard = 0; guard < 20; guard++) {
    s = s.replace(/[\s_]+$/, "");
    let m = s.match(/\s*\(\s*\d{1,3}\s*\)$/);
    if (m) { out.duplicate = true; s = s.slice(0, m.index); continue; }
    m = s.match(/\s*[-–—]\s*copy(?:\s*\(?\d{1,3}\)?)?$/i);
    if (m) { out.duplicate = true; s = s.slice(0, m.index); continue; }
    m = s.match(RENDITION_SUFFIX);
    if (m) { out.renditions.push(renditionOf(m[1] ?? m[2])); s = s.slice(0, m.index); continue; }
    m = s.match(/\s*[-–—]?\s*\bv(?:er(?:sion)?)?\.?\s?(\d{1,3})$/i);
    if (m) { out.versions.push(+m[1]); s = s.slice(0, m.index); continue; }
    const d = findDate(s);
    if (d && s.slice(d.index + d.length).trim() === "" && d.index > 0) {
      out.dates.push(d.iso);
      s = s.slice(0, d.index).replace(/[\s,\-–—]+$/, "");
      continue;
    }
    break;
  }
  return s;
}

/** A lower-case, punctuation-free key for matching versions of one document. */
export function familyKeyOf(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function parseFileName(name: string): ParsedFileName {
  const original = name;
  // Only the last path part, if a folder path came with it.
  let s = name.split(/[\\/]/).pop() ?? name;
  let extension: string | null = null;
  const ext = s.match(/\.([a-z][a-z0-9]{0,5})$/i);
  if (ext) { extension = ext[1].toLowerCase(); s = s.slice(0, ext.index); }

  s = s
    .replace(/_/g, " ")
    .replace(/[{}]/g, (c) => (c === "{" ? "[" : "]"))
    .replace(/\s+/g, " ")
    .trim();

  // Emailed copies sometimes carry a UUID; numbered folders a "5. " ordinal.
  s = s.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\s\-_]*/i, "");
  const collected: Collected = { duplicate: false, stages: [], renditions: [], versions: [], dates: [] };
  if (/^copy of\s+/i.test(s)) { collected.duplicate = true; s = s.replace(/^copy of\s+/i, ""); }
  s = s.replace(/^\d{1,3}\.\s+/, "");

  s = stripTrailing(s, collected);

  // The title is what comes before the first bracket; every bracketed (or
  // stray) piece after it is a tag.
  const firstBracket = s.search(/[[\]]/);
  let head = firstBracket === -1 ? s : s.slice(0, firstBracket);
  const rest = firstBracket === -1 ? "" : s.slice(firstBracket);

  let code: string | null = null;
  let seq: string | null = null;
  const codeMatch = head.match(/^([A-Z]{1,8})\s?(\d{1,4}(?:\.\d{1,3})?[A-Z]?)(?:\s*[-–—]+\s*|\s*$)/);
  if (codeMatch) {
    code = codeMatch[1];
    seq = codeMatch[2];
    head = head.slice(codeMatch[0].length);
  }
  // "Revised v7 - JVA": a family whose convention broke mid-way.
  const revised = head.match(/^(?:(revised|draft)\s+)?v\.?\s?(\d{1,3})\s*[-–—]\s+/i);
  if (revised) {
    collected.versions.push(+revised[2]);
    if (revised[1]) collected.stages.push("Working draft");
    head = head.slice(revised[0].length);
  }
  const prefix = head.match(RENDITION_PREFIX);
  if (prefix) { collected.renditions.push(renditionOf(prefix[1])); head = head.slice(prefix[0].length); }
  head = stripTrailing(head, collected);

  const tags: string[] = [];
  const stages: Stage[] = collected.stages;
  for (const raw of rest.split(/[[\]]+/)) {
    let t = tidy(raw);
    if (!t) continue;
    const d = findDate(t);
    if (d) {
      collected.dates.push(d.iso);
      t = tidy(`${t.slice(0, d.index)} ${t.slice(d.index + d.length)}`);
      if (!t) continue;
    }
    t = stripTrailing(t, collected);
    t = tidy(t);
    if (!t) continue;
    if (RENDITION_ONLY.test(t)) {
      const r = renditionOf(t);
      collected.renditions.push(r);
      if (r === "compared") stages.push("Compared");
      continue;
    }
    const v = t.match(/^v\.?\s?(\d{1,3})$/i);
    if (v) { collected.versions.push(+v[1]); continue; }
    tags.push(t);
    const stage = stageFromTag(t);
    if (stage) stages.push(stage);
    if (stage === "Compared") collected.renditions.push("compared");
  }

  let title = tidy(head);
  if (!title) title = tags.find((t) => !stageFromTag(t)) ?? tidy(s.replace(/[[\]]/g, " ")) ?? "";
  if (!title) title = tidy(original.replace(/\.[^.]+$/, "")) || "Untitled document";

  const stage = stages.length
    ? stages.reduce((a, b) => (STAGE_ORDER.indexOf(b) > STAGE_ORDER.indexOf(a) ? b : a))
    : null;

  return {
    original,
    extension,
    title,
    code,
    seq,
    tags,
    stage,
    date: collected.dates.length ? collected.dates[collected.dates.length - 1] : null,
    rendition: collected.renditions.length ? collected.renditions[0] : null,
    version: collected.versions.length ? collected.versions[0] : null,
    duplicate: collected.duplicate,
    familyKey: familyKeyOf(title),
  };
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-26" → "26 Sep 2026". */
export function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

const RENDITION_LABEL: Record<Rendition, string> = { clean: "Clean", tracked: "Tracked", compared: "Compared" };

/** A short version label, e.g. "For partner review · 26 Sep 2026". Empty when the name says nothing. */
export function versionLabel(p: Pick<ParsedFileName, "stage" | "date" | "rendition" | "version">): string {
  const parts: string[] = [];
  if (p.stage) parts.push(p.stage);
  if (p.date) parts.push(formatShortDate(p.date));
  if (p.rendition && !(p.rendition === "compared" && p.stage === "Compared")) parts.push(RENDITION_LABEL[p.rendition]);
  if (p.version != null) parts.push(`v${p.version}`);
  return parts.join(" · ");
}

// ---- matching an incoming file to a document already in the project ----

const STOPWORDS = new Set(["the", "of", "and", "a", "an", "to", "for", "in", "on", "with", "by", "re"]);
const ROMAN = /^(?=[ivx])(x{0,3})(ix|iv|v?i{0,3})$/;

function tokens(key: string): string[] {
  return [...new Set(key.split(" ").filter((t) => t && !STOPWORDS.has(t)))];
}

/** How alike two family keys are, 0..1 (Dice coefficient on words). Numbers must agree. */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const isNumber = (t: string) => /^\d+[a-z]?$/.test(t) || ROMAN.test(t);
  const na = ta.filter(isNumber).sort().join(" ");
  const nb = tb.filter(isNumber).sort().join(" ");
  // "Schedule 4" is not a version of "Schedule 5"; "Volume III" not of "Volume II".
  if (na !== nb) return 0;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t)).length;
  return (2 * shared) / (ta.length + tb.length);
}

export const CLOSE_MATCH_THRESHOLD = 0.75;

/**
 * The project document an incoming file most likely belongs to: an exact
 * match on the family key first, then the closest title on shared words.
 */
export function findMatchingDocument<T extends { title: string }>(
  familyKey: string,
  documents: T[],
): { document: T; exact: boolean } | null {
  if (!familyKey) return null;
  const keyed = documents.map((d) => ({ d, key: parseFileName(d.title).familyKey, raw: familyKeyOf(d.title) }));
  const exact = keyed.find((k) => k.key === familyKey || k.raw === familyKey);
  if (exact) return { document: exact.d, exact: true };
  let best: { d: T; score: number } | null = null;
  for (const k of keyed) {
    if (tokens(k.key).length < 2 && tokens(familyKey).length < 2) continue;
    const score = titleSimilarity(familyKey, k.key);
    if (score >= CLOSE_MATCH_THRESHOLD && (!best || score > best.score)) best = { d: k.d, score };
  }
  return best ? { document: best.d, exact: false } : null;
}

/**
 * Orders versions of one document: the date in the name first, then the
 * running number after the code, then the file's own modified time.
 */
export function compareVersionOrder(
  a: { parsed: Pick<ParsedFileName, "date" | "seq">; lastModified: number },
  b: { parsed: Pick<ParsedFileName, "date" | "seq">; lastModified: number },
): number {
  const day = (x: typeof a) => (x.parsed.date ? Date.parse(`${x.parsed.date}T00:00:00Z`) : Math.floor(x.lastModified / 86_400_000) * 86_400_000);
  const byDate = day(a) - day(b);
  if (byDate) return byDate;
  const seqNum = (x: typeof a) => (x.parsed.seq ? parseFloat(x.parsed.seq) : NaN);
  const sa = seqNum(a);
  const sb = seqNum(b);
  if (!Number.isNaN(sa) && !Number.isNaN(sb) && sa !== sb) return sa - sb;
  return a.lastModified - b.lastModified;
}

/** A name that is safe to save on Windows and macOS. */
export function safeDownloadName(name: string, maxLength = 150): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const base = (ext ? name.slice(0, dot) : name)
    .split("")
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return `${(base || "Document").slice(0, maxLength - ext.length).trim()}${ext}`;
}
