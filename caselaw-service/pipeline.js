// The full "brain" for one question, minus the written answer: retrieve a wide
// pool, shortlist it cheaply, read the shortlist's summaries, grade them, and
// rank. The answer composer (next stage) takes this ranked list and writes the
// reply; this file is everything that decides WHICH judgments the attorney is
// shown.
//
//   retrieve        ~300 candidates (recall)
//   shortlist       top N by a pre-grade signal, so we don't read/grade 300
//   fetchSummaries  MCP get_case section=summary for the shortlist
//   grade           LLM relevance 0-3 on the summaries (precision)
//   rank            relevance × recency × authority, keep >=2, cap 15
//
// Shortlisting is the one lossy step before grading, so its signal is chosen to
// protect recall: frequency (how many query variants found it) + a recency
// nudge + graph cited-by count. A case that many angles surfaced, or that many
// later judgments cite, earns a grade even if it isn't freshly dated.

import { retrieve } from "./retrieve.js";
import { gradeRelevance, rankCandidates, recencyWeight, signalsFromEdges, DEFAULT_WEIGHTS } from "./rank.js";
import { parseCase } from "./parse.js";

const SHORTLIST_SIZE = Number(process.env.CASELAW_SHORTLIST ?? 45);
const SUMMARY_CONCURRENCY = 6;

// Pre-grade score for shortlisting — deliberately recall-biased and cheap (no
// LLM). frequency dominates; recency and graph cited-by break ties.
function preGradeScore(record, citedByCount, weights) {
  const freq = record.frequency ?? 1;
  const rec = recencyWeight(record.year, weights);
  const cited = citedByCount.get(record.caseId) ?? 0;
  return freq * 2 + cited * 0.5 + rec;
}

export function shortlist(pool, edges, size = SHORTLIST_SIZE, weights = DEFAULT_WEIGHTS) {
  const { citedByCount } = signalsFromEdges(edges);
  return [...pool]
    .filter((r) => r.caseId != null)
    .sort((a, b) => preGradeScore(b, citedByCount, weights) - preGradeScore(a, citedByCount, weights))
    .slice(0, size);
}

// Fetch each shortlisted judgment's summary (metadata + headnote) via the MCP,
// a few at a time so we stay friendly to the rate limit while not serialising
// completely. Enriches each record in place with court/summary/outcome.
export async function fetchSummaries({ client, records, signal }) {
  const queue = [...records];
  const failures = [];
  async function worker() {
    while (queue.length) {
      if (signal?.aborted) return;
      const r = queue.shift();
      try {
        const md = await client.getCase(r.caseId, "summary");
        const parsed = parseCase(md);
        r.summary = parsed.body;
        r.court = parsed.court ?? r.court ?? null;
        r.outcome = r.outcome ?? parsed.outcome;
        if (parsed.citations.length) r.citations = [...new Set([...r.citations, ...parsed.citations])];
      } catch (err) {
        failures.push({ caseId: r.caseId, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: SUMMARY_CONCURRENCY }, worker));
  return { records, failures };
}

// Run the whole pipeline for one question. `notice` (optional) is called with
// short progress strings so the server can stream them to the attorney.
export async function researchQuestion({ client, question, weights = DEFAULT_WEIGHTS, signal, notice = () => {} }) {
  notice("Planning the search…");
  const { plan, pool, edges, coverage } = await retrieve({ client, question, signal });

  notice(`Found ${pool.length} candidate judgments; shortlisting the strongest ${Math.min(SHORTLIST_SIZE, pool.length)}…`);
  const short = shortlist(pool, edges, SHORTLIST_SIZE, weights);

  notice("Reading the shortlisted judgments…");
  const { failures: summaryFailures } = await fetchSummaries({ client, records: short, signal });

  notice("Grading relevance…");
  const grades = await gradeRelevance({ question, candidates: short, signal });

  // On-point judgments (graded 2-3) are what the attorney wants. But some
  // questions sit in a sparse or new area of law where nothing is squarely on
  // point — unsolicited PPP proposals, say, where the enabling Acts are barely
  // a decade old. Returning nothing there is wrong: the attorney still needs
  // the closest authority, clearly labelled as analogous. So we fall back to
  // the best "tangential" judgments (graded 1) and mark the result tier, which
  // the answer composer turns into an honest "no judgment is directly on point;
  // the nearest authorities are…".
  let tier = "on_point";
  let ranked = rankCandidates({ candidates: short, grades, edges, weights, minScore: 2 });
  if (ranked.length === 0) {
    tier = "related";
    ranked = rankCandidates({ candidates: short, grades, edges, weights, minScore: 1 });
  }

  return {
    plan,
    ranked,
    tier,
    coverage: {
      ...coverage,
      shortlisted: short.length,
      graded: grades.size,
      ungraded: (grades.ungraded ?? []).length,
      onPoint: ranked.filter((r) => r.relevance >= 2).length,
      kept: ranked.length,
      summaryFailures,
    },
  };
}
