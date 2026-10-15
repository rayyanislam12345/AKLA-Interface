// Pure helpers behind the clickable [Source n] citations in the chat: finding
// the citations in reply text, numbering a thread's sources, laying statute
// text out in readable paragraphs, and finding the words a reply quoted.
// No React or app imports, so they can be exercised on their own.

export interface CitableSource {
  n?: number | null;
  id: string;
  scope: string;
  label?: string | null;
  act_name?: string | null;
  section?: string | null;
  filename?: string | null;
}

// ------------------------------------------------------------ citations

export type CitationPart = { type: "text"; text: string } | { type: "cite"; raw: string; nums: number[] };

// "[Source 12]", "[Source 3, 5]", "[Sources 3 and 5]", "[Sources 3, 5 and 7]",
// "[Source 3; Source 5]", "[Sources 3-5]", "[source 2 & 4]". Brackets are
// required: "Source 2" in running prose is left alone.
const SEP = String.raw`\s*(?:,|;|&|\band\b|\bor\b|-|–|—|\bto\b)\s*(?:sources?\s*)?`;
export const CITATION_RE = new RegExp(String.raw`\[\s*sources?\s*#?\s*(\d{1,4}(?:${SEP}\d{1,4})*)\s*\]`, "gi");

export function citationNumbers(inner: string): number[] {
  const out: number[] = [];
  // Ranges first ("3-5", "3 – 5", "3 to 5"), kept small so a typo can't
  // explode into hundreds of chips.
  const tokens = inner.split(/\s*(?:,|;|&|\band\b|\bor\b)\s*/i);
  for (const t of tokens) {
    const range = t.match(/(\d+)\s*(?:-|–|—|\bto\b)\s*(?:sources?\s*)?(\d+)/i);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b >= a && b - a <= 20) {
        for (let i = a; i <= b; i++) out.push(i);
        continue;
      }
      out.push(a, b);
      continue;
    }
    for (const d of t.match(/\d+/g) ?? []) out.push(Number(d));
  }
  return [...new Set(out.filter((x) => x > 0))];
}

export function parseCitations(text: string): CitationPart[] {
  const parts: CitationPart[] = [];
  let last = 0;
  for (const m of text.matchAll(CITATION_RE)) {
    const nums = citationNumbers(m[1]);
    if (!nums.length) continue;
    if (m.index! > last) parts.push({ type: "text", text: text.slice(last, m.index) });
    parts.push({ type: "cite", raw: m[0], nums });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

// ------------------------------------------------------------ numbering

export interface ThreadSourceEntry<S> {
  source: S;
  messageId: string;
}

// Chat-wide numbering: every message's sources that carry `n`, later
// registrations of the same number winning.
export function buildThreadSourceMap<S extends CitableSource>(
  items: Array<{ messageId: string; sources: S[] | null | undefined }>,
): Map<number, ThreadSourceEntry<S>> {
  const map = new Map<number, ThreadSourceEntry<S>>();
  for (const it of items) {
    for (const s of it.sources ?? []) {
      if (typeof s?.n === "number" && s.n > 0) map.set(s.n, { source: s, messageId: it.messageId });
    }
  }
  return map;
}

// Older replies carry no `n`: their own sources are numbered 1..k and their
// citations resolve against that message only.
export function isLegacySources(sources: CitableSource[] | null | undefined): boolean {
  return !!sources?.length && !sources.some((s) => typeof s?.n === "number");
}

export function resolveCitation<S extends CitableSource>(
  n: number,
  ownSources: S[] | null | undefined,
  threadMap: Map<number, ThreadSourceEntry<S>>,
): S | null {
  if (isLegacySources(ownSources)) return ownSources![n - 1] ?? null;
  return (ownSources ?? []).find((s) => s.n === n) ?? threadMap.get(n)?.source ?? null;
}

// ------------------------------------------------------------ labels

export function sectionLabel(section: string | null | undefined): string | null {
  const s = (section ?? "").trim().replace(/^(?:sections?|secs?\.?|ss?\.|§+)\s*/i, "").trim();
  return s ? `§${s}` : null;
}

// "§199 Companies Act" when the Act and section are known.
export function chipLabel(source: CitableSource | null, n: number): string {
  if (source?.scope === "statute" && source.act_name && sectionLabel(source.section)) {
    return `${sectionLabel(source.section)} ${shortActName(source.act_name)}`;
  }
  return `Source ${n}`;
}

export function shortActName(act: string): string {
  return act.replace(/\s*,?\s*\(?(?:[IVXLC]+\s+of\s+)?\d{4}\)?\s*$/i, "").replace(/\s+/g, " ").trim() || act;
}

// ------------------------------------------------------------ statute text

// Statute text arrives as one long line. Break before numbered sub-sections
// "(1)" and lettered or roman clauses "(a)", "(ii)" — but only where they
// start a provision (after ".", ":", ";", "—", or "; and"), so a reference
// like "sub-section (1) of section 3" stays in its sentence. Existing line
// breaks are kept.
export function normaliseStatuteText(text: string): string {
  if (!text) return "";
  let t = text.replace(/\r\n?/g, "\n");
  const opener = String.raw`\((?:\d{1,3}[A-Z]?|[a-z]{1,2}|[ivxl]{1,5}|[A-Z])\)`;
  const after = String.raw`(?:[.:;]|[-–—]|[.:;,]\s*(?:and|or)|\bprovided(?:\s+further)?\s+that\s*[:,—–-]?)`;
  t = t.replace(new RegExp(String.raw`(${after})[ \t]+(?=${opener}\s)`, "g"), "$1\n");
  // "Explanation.—" and "Provided that" start their own paragraphs too.
  t = t.replace(/([.:;])[ \t]+(?=(?:Explanation|Provided(?: further)? that|Illustrations?)\b)/g, "$1\n");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

export function paragraphIndent(paragraph: string): 0 | 1 | 2 {
  const m = paragraph.match(/^\((\w+)\)/);
  if (!m) return 0;
  if (/^\d/.test(m[1])) return 0;
  if (/^(?:i{1,3}|iv|v|vi{1,3}|ix|x)$/.test(m[1]) && m[1] !== "i" && m[1] !== "v" && m[1] !== "x") return 2;
  return 1;
}

// ------------------------------------------------------------ quotations

// Words the reply put in double quotes — the ones worth finding in a passage.
// Short quoted terms ("Company") would light up everywhere, so they are skipped.
export function quotedPhrases(reply: string, minLength = 12): string[] {
  const out = new Set<string>();
  const re = /"([^"\n]{4,800})"|“([^”\n]{4,800})”/g;
  for (const m of reply.matchAll(re)) {
    const q = (m[1] ?? m[2] ?? "").trim();
    // A quote with an ellipsis is several verbatim fragments.
    for (const frag of q.split(/\s*(?:\.\.\.|…|\[\.\.\.\]|\[…\])\s*/)) {
      const f = frag.trim().replace(/^[\s,;:]+|[\s,;:.]+$/g, "");
      if (f.length >= minLength) out.add(f);
    }
  }
  return [...out];
}

function phrasePattern(phrase: string): string {
  return phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['’‘]/g, "['’‘]").replace(/["“”]/g, "[\"“”]"))
    .join(String.raw`\s+`);
}

// Ranges in `text` that match one of the phrases verbatim, whitespace and
// apostrophe style aside. Overlaps are merged.
export function highlightRanges(text: string, phrases: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const p of phrases) {
    const pat = phrasePattern(p);
    if (!pat) continue;
    const re = new RegExp(pat, "gi");
    for (const m of text.matchAll(re)) {
      if (m[0].length) ranges.push([m.index!, m.index! + m[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
