// One-shot validation runner: question in, plan + ranked judgments + coverage
// out. Needs ANTHROPIC_API_KEY in the environment (planner + grader).
import { CaseLawMcpClient } from "./mcpClient.js";
import { researchQuestion } from "./pipeline.js";

const question = process.argv.slice(2).join(" ") ||
  "Have there been any judgments on unsolicited proposals in public-private partnership projects since 2015?";

const client = new CaseLawMcpClient();
const t0 = Date.now();
const { plan, ranked, tier, coverage } = await researchQuestion({
  client, question,
  notice: (m) => console.error(`  … ${m} (${((Date.now()-t0)/1000).toFixed(1)}s)`),
});

console.log("\n=== QUESTION ===\n" + question);
console.log("\n=== PLAN ===");
console.log("issue   :", plan.issue);
console.log("statutes:", plan.statutes.join(" | ") || "(none)");
console.log("years   :", plan.yearFrom ?? "any", "->", plan.yearTo ?? "any", "| courts:", plan.courts.join(", ") || "any");
console.log("variants:", plan.variants.join(" / "));
console.log("\n=== COVERAGE ===");
console.log(`variants ${coverage.variants} | direct ${coverage.directHits} | graph +${coverage.graphHits} | pool ${coverage.poolSize} | shortlisted ${coverage.shortlisted} | graded ${coverage.graded} | kept ${coverage.kept}`);
console.log("\ntier:", tier, "| on-point:", coverage.onPoint, "of", coverage.kept, "kept");
console.log("\n=== RANKED JUDGMENTS ===");
for (const r of ranked) {
  console.log(`\n[${r.finalScore}] ${r.citations[0] ?? r.title}  (${r.year ?? "?"}, ${r.court ?? "?"})`);
  console.log(`      rel ${r.relevance} × rec ${r.recency} × auth ${r.authority}${r.overruled ? "  ⚠ OVERRULED" : ""}${r.citedByCount ? `  · cited by ${r.citedByCount}` : ""}`);
  console.log(`      ${r.title}`);
  console.log(`      why: ${r.why}`);
  console.log(`      ${r.url}`);
}
console.log(`\ntotal: ${((Date.now()-t0)/1000).toFixed(1)}s`);
