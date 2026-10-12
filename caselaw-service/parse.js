// Turns the Pakistan Case Law MCP's markdown into structured judgment records
// the ranking layer can score. The MCP answers in markdown by default; rather
// than ask for JSON on every call (the search tools don't offer it), we parse
// the two shapes we actually consume.
//
// Search / listing shape (caselaw_search, caselaw_search_questions, lookups):
//
//   Found 24 (showing 20, offset 0).
//   Filters applied - years: 2015-.
//
//   - **TITLE** — 2026 PLC(CS) 386, 2026 SCMR 1 (2026) · **Petition allowed**
//     https://pakistancaselaw.com/case/234019
//       - Optional sub-bullet (a settled legal question, from search_questions)
//
// Single-case shape (caselaw_get_case):
//
//   # TITLE
//   *2026 PLC(CS) 386* — Islamabad High Court (2026)
//   **Outcome: Petition allowed**
//   https://pakistancaselaw.com/case/234019
//
//   ## Summary
//   ...body...

const CASE_URL = /https?:\/\/[^\s)]*\/case\/(\d+)/;

// A listing line is "**TITLE** — <citations> (<year>) · **<outcome>**", where
// <citations> is one or more comma-separated citations (e.g.
// "2026 PLC(CS) 386, 2026 SCMR 1"). We take the whole span, drop the trailing
// "(year)" the site appends, and split on commas. Citations are kept verbatim
// — they are for display and the official-text lookup, not normalised here.
function splitCitations(span) {
  return span
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/, "") // trailing "(2026)"
    .split(/,\s*/)
    .map((c) => c.trim())
    .filter(Boolean);
}

// Parse a search / listing result into { total, shown, offset, records[] }.
// Each record: { caseId, title, citations[], year, outcome, questions[], url }.
export function parseListing(markdown) {
  const header = markdown.match(/Found\s+(\d+)\s*\(showing\s+(\d+),\s*offset\s+(\d+)\)/i);
  const total = header ? Number(header[1]) : null;
  const shown = header ? Number(header[2]) : null;
  const offset = header ? Number(header[3]) : 0;

  const records = [];
  const lines = markdown.split("\n");
  let current = null;

  for (const line of lines) {
    const bullet = line.match(/^\s*-\s+\*\*(.+?)\*\*\s*(.*)$/);
    if (bullet) {
      if (current) records.push(current);
      const title = bullet[1].trim();
      const rest = bullet[2];
      // Split the "<citations> (<year>) · **<outcome>**" tail into its parts.
      const outcome = rest.match(/·\s*\*\*(.+?)\*\*/);
      const citationSpan = rest.replace(/·\s*\*\*.+?\*\*\s*$/, "").replace(/^\s*—\s*/, "");
      const year = citationSpan.match(/\((\d{4})\)\s*$/);
      current = {
        caseId: null,
        title,
        citations: splitCitations(citationSpan),
        year: year ? Number(year[1]) : null,
        outcome: outcome ? outcome[1].trim() : null,
        questions: [],
        url: null,
      };
      continue;
    }
    if (!current) continue;

    const url = line.match(CASE_URL);
    if (url) {
      current.url = url[0];
      current.caseId = Number(url[1]);
      continue;
    }
    // Sub-bullets on a question search are the settled legal questions.
    const sub = line.match(/^\s{2,}-\s+(.*\S)\s*$/);
    if (sub) current.questions.push(sub[1].trim());
  }
  if (current) records.push(current);

  return { total, shown, offset, records };
}

// Parse a single caselaw_get_case result into a record plus its text. With
// section="summary" the body is the headnote; with "full" it also carries the
// judgment text under later headings, which we keep whole in `body`.
export function parseCase(markdown) {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const citationLine = markdown.match(/^\*(.+?)\*\s*—\s*(.+?)\s*\((\d{4})\)/m);
  const url = markdown.match(CASE_URL);
  const outcome = markdown.match(/\*\*Outcome:\s*(.+?)\*\*/)?.[1]?.trim() ?? null;

  const summaryStart = markdown.search(/^##\s+Summary/m);
  const body = summaryStart === -1 ? "" : markdown.slice(summaryStart).trim();

  return {
    caseId: url ? Number(url[1]) : null,
    title,
    citations: citationLine ? citationLine[1].split(/,\s*/).map((c) => c.trim()) : [],
    court: citationLine ? citationLine[2].trim() : null,
    year: citationLine ? Number(citationLine[3]) : null,
    outcome,
    url: url ? url[0] : null,
    body,
  };
}

// Merge records for the same judgment that arrived from different query
// variants, keeping the richest fields and the union of citations/questions.
// `frequency` sums how many listings surfaced the judgment — a cheap recall
// signal (a case found by many query variants is more likely on point) used to
// shortlist the pool for grading.
export function dedupeByCase(records) {
  const byId = new Map();
  for (const r of records) {
    if (r.caseId == null) continue;
    const existing = byId.get(r.caseId);
    if (!existing) {
      byId.set(r.caseId, { ...r, citations: [...r.citations], questions: [...r.questions], frequency: r.frequency ?? 1 });
      continue;
    }
    existing.title ||= r.title;
    existing.year ??= r.year;
    existing.outcome ||= r.outcome;
    existing.url ||= r.url;
    existing.citations = [...new Set([...existing.citations, ...r.citations])];
    existing.questions = [...new Set([...existing.questions, ...r.questions])];
    existing.frequency += r.frequency ?? 1;
  }
  return [...byId.values()];
}
