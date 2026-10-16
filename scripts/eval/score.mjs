// Scoring for the retrieval gold set (scripts/eval/gold.json). Pure: no
// network, no Supabase, so the fake adapter can check it anywhere.
//
// A retrieved passage, as every adapter hands it back:
//   { kind: "statute" | "precedent" | "matter", act_name, sections: ["199", ...],
//     storage_path, filename, text, id, similarity }
// `sections` lists every section of the Act the passage covers (the
// adapter places it in the rebuilt Act); when it is empty the passage's own
// text is searched for the section's heading instead.
//
// A question's `expected` list holds ACCEPTABLE answers: any one of them in
// the top k is a hit. Several entries mean several places that each answer
// the question (copies of the same precedent, the same clause in two
// agreements), not several things that must all be found.

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&apos;": "'" };

/** Lower case, tags dropped, quotes and dashes made plain, whitespace collapsed. */
export function normText(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp|apos);/g, (m) => ENTITIES[m])
    .replace(/[‘’‛′`]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―⸺⸻−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Whether `phrase` occurs in `text`, ignoring case and whitespace. PDFs in
 * the library sometimes lose the spaces between words ("facilitythroughup"),
 * so a phrase also matches with every space removed from both sides.
 */
export function containsPhrase(text, phrase) {
  const t = normText(text);
  const p = normText(phrase);
  if (!p) return true;
  if (t.includes(p)) return true;
  return t.replace(/ /g, "").includes(p.replace(/ /g, ""));
}

const GENERIC = new Set(["the", "of", "and", "act", "acts", "ordinance", "rules", "rule", "regulations", "regulation", "order", "code"]);

/**
 * The words and years that identify a law, from a loose name: "Companies
 * Act, 2017", "Income Tax Ordinance, 2001 (Same as on the official website
 * …)", "Public Private Partnership Authority Act, 2017." all reduce to their
 * subject words and year. Parentheticals are dropped, except a short alias
 * like "(PPRA)", which is kept as an alias.
 */
export function lawKey(name) {
  const raw = String(name ?? "");
  const aliases = [...raw.matchAll(/\(([A-Za-z]{2,8})\)/g)].map((m) => m[1].toLowerCase());
  const bare = raw.replace(/\([^)]*\)/g, " ").toLowerCase();
  const years = [...new Set(bare.match(/\b(?:18|19|20)\d{2}\b/g) ?? [])];
  const words = bare.replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !/^\d+$/.test(w) && !GENERIC.has(w));
  return { words, years, aliases };
}

/** Whether a passage's act name is the law the gold names (every subject word present, the year agreeing). */
export function sameAct(resultAct, expectedAct) {
  if (!resultAct || !expectedAct) return false;
  const want = lawKey(expectedAct);
  const have = lawKey(resultAct);
  if (!want.words.length) return false;
  if (want.years.length && !want.years.some((y) => have.years.includes(y))) return false;
  const pool = new Set([...have.words, ...have.aliases]);
  return want.words.every((w) => pool.has(w));
}

/** "s.199", "Section 83A", "rule 36" → "199", "83A", "36". */
export function sectionLabel(section) {
  const m = /(\d{1,4})\s*([A-Za-z]{0,3})(?![A-Za-z])/.exec(String(section ?? "").replace(/^\s*(?:sections?|s|art(?:icle)?|rules?|reg(?:ulation)?)\.?\s*/i, ""));
  return m ? `${m[1]}${m[2].toUpperCase()}` : null;
}

const DASH = /[—–⸺⸻]|_{2,}|\.-\s|:-/;

/**
 * Whether the passage's own text holds the BODY of the section — its
 * heading ("208. Related party transactions.—(1) …") — and not just a
 * contents line or a cross-reference. Used when the adapter could not place
 * the passage in the Act.
 */
export function textHasSectionHeading(text, section) {
  const label = sectionLabel(section);
  if (!label || !text) return false;
  const num = label.match(/^\d+/)[0];
  const suffix = label.slice(num.length);
  const re = new RegExp(`(?<![\\w.(\\/,-])(?<!\\b(?:[Ss]ections?|[Ss]\\.|[Cc]lauses?|[Rr]ules?|[Aa]rticles?|No\\.|[Oo]f|[Aa]nd|[Tt]o|[Oo]r|[Uu]nder|[Ii]n)\\s)${num}${suffix}\\.\\s+(?=[A-Z\\[“"‘'])`, "g");
  const s = String(text);
  let m;
  while ((m = re.exec(s)) !== null) {
    const after = s.slice(m.index, m.index + 320);
    // A body heading ends in a dash within a line or two; a contents entry
    // is followed by the next entry ("209. …") within a short run.
    if (DASH.test(after)) return true;
    const next = /\s\d{1,4}[A-Z]{0,3}\.\s+[A-Z]/.exec(after.slice(m[0].length));
    if (!next || next.index > 250) return true;
  }
  return false;
}

/** Whether one retrieved passage satisfies one expected item. */
export function matchItem(result, item) {
  if (!result || !item) return false;
  const text = result.text ?? "";
  if (item.contains && !containsPhrase(text, item.contains)) return false;
  switch (item.match) {
    case "act_section": {
      if (!sameAct(result.act_name, item.act)) return false;
      const want = sectionLabel(item.section);
      if (!want) return false;
      const sections = (result.sections ?? []).map(sectionLabel).filter(Boolean);
      if (sections.length) return sections.includes(want);
      if (result.section && sectionLabel(result.section) === want) return true;
      return textHasSectionHeading(text, want);
    }
    case "act_contains":
      return sameAct(result.act_name, item.act) && containsPhrase(text, item.contains);
    case "storage_path":
      return !!result.storage_path && result.storage_path === item.value;
    default:
      return false;
  }
}

/** The 1-based rank of the first passage that answers the question, or null. */
export function firstHit(results, expected) {
  for (let i = 0; i < (results ?? []).length; i++) {
    if ((expected ?? []).some((item) => matchItem(results[i], item))) return i + 1;
  }
  return null;
}

/** Per-question score: { firstRank, hit5, hit10, rr }. */
export function scoreQuestion(results, expected) {
  const firstRank = firstHit(results, expected);
  return {
    firstRank,
    hit5: firstRank !== null && firstRank <= 5,
    hit10: firstRank !== null && firstRank <= 10,
    rr: firstRank ? 1 / firstRank : 0,
  };
}

/**
 * Totals over scored questions, overall and per kind:
 * { n, recall5, recall10, mrr, answered } where recall@k is the share of
 * questions with an acceptable answer in the top k.
 */
export function summarise(rows) {
  const agg = (list) => {
    const n = list.length;
    if (!n) return { n: 0, recall5: 0, recall10: 0, mrr: 0, answered: 0, errors: 0 };
    const sum = (f) => list.reduce((a, r) => a + f(r), 0);
    return {
      n,
      recall5: sum((r) => (r.hit5 ? 1 : 0)) / n,
      recall10: sum((r) => (r.hit10 ? 1 : 0)) / n,
      mrr: sum((r) => r.rr) / n,
      answered: sum((r) => (r.resultCount > 0 ? 1 : 0)),
      errors: sum((r) => (r.error ? 1 : 0)),
    };
  };
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  return { overall: agg(rows), perKind: Object.fromEntries(kinds.map((k) => [k, agg(rows.filter((r) => r.kind === k))])) };
}

/** A plain-text table of a summary. */
export function formatTable(summary, title = "") {
  const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
  const line = (name, s) => `${name.padEnd(18)} ${String(s.n).padStart(4)} ${pct(s.recall5)} ${pct(s.recall10)} ${s.mrr.toFixed(3).padStart(7)} ${String(s.errors).padStart(6)}`;
  const out = [];
  if (title) out.push(title);
  out.push(`${"kind".padEnd(18)} ${"n".padStart(4)} ${"R@5".padStart(7)} ${"R@10".padStart(7)} ${"MRR".padStart(7)} ${"errors".padStart(6)}`);
  out.push("-".repeat(54));
  for (const [k, s] of Object.entries(summary.perKind)) out.push(line(k, s));
  out.push("-".repeat(54));
  out.push(line("ALL", summary.overall));
  return out.join("\n");
}

/** Checks a gold file's shape; returns a list of problems (empty when sound). */
export function validateGold(gold) {
  const problems = [];
  const KINDS = new Set(["statute_section", "statute_concept", "precedent_clause", "project_fact", "which_document"]);
  const ids = new Set();
  for (const q of gold?.questions ?? []) {
    const at = q?.id ?? "(no id)";
    if (!q?.id) problems.push(`${at}: no id`);
    else if (ids.has(q.id)) problems.push(`${at}: duplicate id`);
    ids.add(q?.id);
    if (!KINDS.has(q?.kind)) problems.push(`${at}: unknown kind ${q?.kind}`);
    if (!q?.question?.trim()) problems.push(`${at}: no question`);
    if (q?.scope !== "general" && !/^[0-9a-f-]{36}$/.test(String(q?.scope))) problems.push(`${at}: scope must be "general" or a matter id`);
    if (!Array.isArray(q?.expected) || !q.expected.length) problems.push(`${at}: no expected answers`);
    for (const e of q?.expected ?? []) {
      if (e.match === "act_section" && (!e.act || !sectionLabel(e.section))) problems.push(`${at}: act_section needs act and section`);
      else if (e.match === "storage_path" && !e.value) problems.push(`${at}: storage_path needs value`);
      else if (e.match === "act_contains" && (!e.act || !e.contains)) problems.push(`${at}: act_contains needs act and contains`);
      else if (!["act_section", "storage_path", "act_contains"].includes(e.match)) problems.push(`${at}: unknown match ${e.match}`);
    }
  }
  return problems;
}
