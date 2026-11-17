// Pure helpers for reading Pakistan Law Site: turning a citation into the
// site's citation-search fields, reading its result table, choosing the right
// row, and turning a judgment page into text. No network here, so all of it is
// unit-tested (pls.test.js).

// Journals the site's citation search accepts, keyed by the journal name with
// dots and spaces removed and upper-cased. The value is the site's own code.
const BOOKS = {
  SCMR: "SCMR", PLD: "PLD", CLC: "CLC", CLCN: "CLCN", CLD: "CLD", GBLR: "GBLR", MLD: "MLD",
  PCRLJ: "PCRLJ", PCRLJN: "PCRLJN", PLC: "PLC", PLCN: "PLC N", "PLC(CS)": "PLC(CS)", "PLC(CS)N": "PLC(CS)N",
  PTD: "PTD", YLR: "YLR", YLRN: "YLRN",
};

// "2018 SCMR 365", "2014 PLD Supreme Court 47", "PLD 2016 Supreme Court 692",
// "2019 P Cr. L J 582", "2002 PLC (C.S.) 1019", "2020 CLC Note 12" →
// { year, book, page, courtHint }. Null for a journal the site does not carry
// (PLJ, P.S.C., neutral citations and so on).
export function parseCitation(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  let year, middle, page;
  let m = s.match(/^(\d{4})\s+(.+?)\s+(\d+)$/);
  if (m) [, year, middle, page] = m;
  else if ((m = s.match(/^(P\s?\.?\s?L\s?\.?\s?D\s?\.?)\s+(\d{4})\s+(.*?)\s*(\d+)$/i))) {
    year = m[2]; middle = `PLD ${m[3]}`; page = m[4];
  } else return null;

  const compact = middle.toUpperCase().replace(/[.\s]/g, "").replace(/NOTE$/, "N");
  let book = null, courtHint = null;
  if (compact.startsWith("PLD")) {
    book = "PLD";
    courtHint = middle.replace(/^\s*P\s?\.?\s?L\s?\.?\s?D\s?\.?\s*/i, "").trim() || null;
  } else {
    book = BOOKS[compact] ?? null;
  }
  if (!book) return null;
  return { year: Number(year), book, page: Number(page), courtHint };
}

// A coarse court label so "Supreme Court of Pakistan", "SUPREME-COURT" and the
// "Supreme Court" inside a PLD citation compare equal.
export function courtKey(text) {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/azad|aj\s?&\s?k|ajk/.test(t)) return /supreme/.test(t) ? "ajk-sc" : "ajk";
  if (/shariat/.test(t)) return "fsc";
  if (/supreme|\bsc\b/.test(t)) return "sc";
  if (/lahore/.test(t)) return "lahore";
  if (/karachi|sindh/.test(t)) return "sindh";
  if (/peshawar/.test(t)) return "peshawar";
  if (/quetta|balochistan|baluchistan/.test(t)) return "balochistan";
  if (/islamabad/.test(t)) return "islamabad";
  if (/gilgit/.test(t)) return "gilgit";
  return null;
}

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

// Strip a page (the site serves judgments as Word-exported HTML) to plain text,
// keeping paragraph breaks.
export function htmlToText(html) {
  const text = String(html ?? "")
    .replace(/<(style|script|xml|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The citation-search reply is a table: # | Citation | Title (+ judge, lawyer)
// | Court | a Read button carrying the site's id for the judgment.
export function parseCitationRows(html) {
  const rows = [];
  for (const m of String(html ?? "").matchAll(/<tr\b[^>]*class="caseType"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    const caseName = m[1].match(/casetypeid="([^"]+)"/i)?.[1];
    if (cells.length < 4 || !caseName) continue;
    rows.push({
      citation: htmlToText(cells[1]),
      title: htmlToText(cells[2].split(/<br\s*\/?>/i)[0]).replace(/\s+/g, " "),
      court: htmlToText(cells[3]),
      caseName,
    });
  }
  return rows;
}

// Words that say nothing about which case this is.
const COMMON = new Set(["versus", "others", "another", "through", "state", "pakistan", "government", "federation", "province", "secretary", "limited", "private", "company", "messrs", "commissioner", "province", "matter", "cases", "case"]);
export function titleTokens(title) {
  return [...new Set(String(title ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter((w) => !COMMON.has(w));
}
function overlap(a, b) {
  const other = new Set(titleTokens(b));
  return titleTokens(a).filter((w) => other.has(w)).length;
}

// Choose the row for one judgment. A page number repeats across the courts'
// sections of PLD, so several rows can come back: the court decides, then the
// parties' names. Returns null rather than guess.
export function pickRow(rows, { courtHint = null, court = null, title = null } = {}) {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  const want = courtKey(courtHint) ?? courtKey(court);
  let pool = rows;
  if (want) {
    const byCourt = rows.filter((r) => courtKey(r.court) === want);
    if (byCourt.length === 1) return byCourt[0];
    if (byCourt.length > 1) pool = byCourt;
  }
  const scored = pool.map((r) => ({ r, score: overlap(title, r.title) })).sort((a, b) => b.score - a.score);
  if (scored[0].score >= 2 && scored[0].score > (scored[1]?.score ?? 0)) return scored[0].r;
  return null;
}

// Does this judgment text really belong to the citation and the case asked
// for? Its opening lines print the citation (letter-spaced: "2012 S C M R 773",
// "P L D 2026 Supreme Court 91"), then the parties.
export function matchesCitation(text, { year, page }, title = null) {
  const head = String(text ?? "").slice(0, 400);
  const number = (n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(head);
  if (!number(year) || !number(page)) return false;
  const tokens = titleTokens(title);
  if (tokens.length === 0) return true;
  const opening = String(text).slice(0, 2500).toLowerCase();
  return tokens.some((w) => opening.includes(w));
}
