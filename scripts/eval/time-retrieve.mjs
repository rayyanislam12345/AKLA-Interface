#!/usr/bin/env node
// Where the time goes in one search: runs a few questions from gold.json
// through chat-service/retrieve.js exactly as `run.mjs --adapter retrieve`
// routes them (the same scopes, at once), with retrieve's `timings: true`,
// and prints when each stage started and how long it took — the rewrite, the
// embeddings, each search_passages call, the windows and labels, the
// reranker, the statute Acts read to place passages in their sections, and a
// section the question names.
//
//   node scripts/eval/time-retrieve.mjs --chat-service /opt/chat-service
//
// Two rounds by default. Round 1 is a fresh process: nothing is cached (the
// law library's list, the rebuilt Acts). Round 2 asks the same questions
// again with the rewrite and embedding caches cleared but the law library's
// list and the rebuilt Acts kept, as a running chat service would have them.
//
// Options: --only C02,S04     the questions (default: two precedent, two
//                             statute concept, one project, one which-document)
//          --rounds N         (default 2)
//          --route auto|kind  as run.mjs (default auto)
//          --chat-service <dir>  --env <file>  --no-synonyms   as run.mjs
//          --rerank-pool N --rerank-chars N --rewrite-wait MS  override retrieve.js's defaults
//          --deadline MS      override RETRIEVE_DEADLINE_MS (0: no deadline)
//          --json <file>      also write every event to a file
//
// Read-only, like run.mjs: the same RPCs and selects as the chat service.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, detectAct, retrievePlan } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// C02, C17: precedent questions (searched in precedents and statutes);
// S04, S07: statute concept questions naming no Act (statutes and
// precedents); P01: a project fact; W01: which document.
const DEFAULT_IDS = ["C02", "C17", "S04", "S07", "P01", "W01"];
const K = 10; // as run.mjs

function parseArgs(argv) {
  const out = { only: DEFAULT_IDS, rounds: 2, route: "auto", synonyms: true, retrieveOptions: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--only") out.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--rounds") out.rounds = Math.max(1, Number(next()) || 1);
    else if (a === "--route") out.route = next();
    else if (a === "--chat-service") out.chatService = next();
    else if (a === "--env") out.env = next();
    else if (a === "--no-synonyms") out.synonyms = false;
    else if (a === "--rerank-pool") out.retrieveOptions.rerankPool = Number(next());
    else if (a === "--rerank-chars") out.retrieveOptions.rerankChars = Number(next());
    else if (a === "--rewrite-wait") out.retrieveOptions.rewriteWaitMs = Number(next());
    else if (a === "--deadline") out.retrieveOptions.deadlineMs = Number(next());
    else if (a === "--json") out.json = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown option ${a}. Try --help.`);
  }
  return out;
}

const pad = (v, n) => String(v).padStart(n);
const detailOf = (e) => Object.entries(e)
  .filter(([key]) => !["stage", "start", "ms"].includes(key))
  .map(([key, v]) => `${key}=${typeof v === "string" && v.length > 50 ? `${v.slice(0, 47)}…` : v}`)
  .join(" ");

function printScope(scope, wallMs, t) {
  console.log(`    ${scope}: ${wallMs} ms  (engine ${t.engine ?? "-"}, ${t.phrasings} phrasing${t.phrasings === 1 ? "" : "s"}${t.rewriteLate ? ", rewrite not waited for" : ""}, ${t.reranked ? "reranked" : t.rerankSkipped ? `rerank skipped: ${t.rerankSkipped}` : "not reranked"}${t.voyageCalls != null ? `, ${t.voyageCalls} Voyage call${t.voyageCalls === 1 ? "" : "s"}` : ""})`);
  if (t.fellBack) console.log(`      FELL BACK: ${t.reason}`);
  console.log(`      ${"start".padStart(6)} ${"ms".padStart(6)}  stage`);
  for (const e of t.events) console.log(`      ${pad(e.start, 6)} ${pad(e.ms, 6)}  ${e.stage.padEnd(22)} ${detailOf(e)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 26).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const gold = JSON.parse(readFileSync(join(HERE, "gold.json"), "utf8"));
  const questions = args.only.map((id) => gold.questions.find((q) => q.id === id) ?? (() => { throw new Error(`No question ${id} in gold.json`); })());

  const ctx = await connect({ chatService: args.chatService, env: args.env, synonyms: args.synonyms });
  const retrieveMod = await import(pathToFileURL(join(ctx.chatDir, "retrieve.js")).href);
  console.log(`chat-service code: ${ctx.chatDir}${ctx.anthropicJson ? "" : "  (rewrite off: no ANTHROPIC_API_KEY or --no-synonyms)"}`);
  console.log(`retrieve.js defaults: rerank pool ${retrieveMod.RERANK_POOL ?? "?"}, rerank chars ${retrieveMod.RERANK_CHARS ?? "(whole)"}, rewrite wait ${retrieveMod.REWRITE_WAIT_MS ?? "(none)"} ms, deadline ${retrieveMod.RETRIEVE_DEADLINE_MS ?? "(none)"} ms${Object.keys(args.retrieveOptions).length ? `; overridden: ${JSON.stringify(args.retrieveOptions)}` : ""}`);

  const records = [];
  for (let round = 1; round <= args.rounds; round++) {
    if (round > 1) retrieveMod.clearRetrieveCaches?.();
    console.log(`\n=== Round ${round}${round === 1 ? ": fresh process, nothing cached" : ": law list and rebuilt Acts kept; rewrites and embeddings not"} ===`);
    // As run.mjs: the law library's list is read once (detectAct needs it).
    const tActs = Date.now();
    const acts = await ctx.lib.listActs(ctx.supabase);
    if (round === 1) console.log(`(law library list read in ${Date.now() - tActs} ms, before the questions, as run.mjs does)`);
    for (const q of questions) {
      const act = detectAct(q.question, acts);
      const plan = retrievePlan({ question: q.question, scope: q.scope, kind: q.kind, act, route: args.route });
      console.log(`\n${q.id} [${q.kind}] ${q.question.slice(0, 90)}`);
      console.log(`  scopes: ${plan.map((p) => p.scope + (p.options.actNames ? ` (${p.options.actNames.join("; ")})` : "")).join(" + ")}, searched at once`);
      const t0 = Date.now();
      const results = await Promise.all(plan.map(async (p) => {
        const s0 = Date.now();
        try {
          const r = await retrieveMod.retrieve({
            supabase: ctx.supabase, voyageKey: ctx.voyageKey, anthropicJson: ctx.anthropicJson,
            query: q.question, scope: p.scope, k: K, ...args.retrieveOptions, ...p.options, timings: true,
          });
          return { scope: p.scope, wallMs: Date.now() - s0, passages: r.passages?.length ?? 0, timings: r.timings ?? null };
        } catch (err) {
          return { scope: p.scope, wallMs: Date.now() - s0, error: err.message };
        }
      }));
      const wall = Date.now() - t0;
      console.log(`  question: ${wall} ms (slowest scope)`);
      for (const r of results) {
        if (r.error) console.log(`    ${r.scope}: FAILED after ${r.wallMs} ms — ${r.error}`);
        else if (!r.timings) console.log(`    ${r.scope}: ${r.wallMs} ms (this retrieve.js reports no timings)`);
        else printScope(r.scope, r.wallMs, r.timings);
      }
      records.push({ round, id: q.id, kind: q.kind, wallMs: wall, scopes: results });
    }
  }

  // Summary: each question's time per round, and each stage's average.
  console.log("\n=== Summary ===");
  console.log(`${"id".padEnd(5)}${"kind".padEnd(18)}${Array.from({ length: args.rounds }, (_, i) => `round ${i + 1}`.padStart(10)).join("")}`);
  for (const q of questions) {
    const times = records.filter((r) => r.id === q.id).map((r) => `${r.wallMs} ms`.padStart(10));
    console.log(`${q.id.padEnd(5)}${q.kind.padEnd(18)}${times.join("")}`);
  }
  for (let round = 1; round <= args.rounds; round++) {
    const byStage = new Map();
    for (const rec of records.filter((r) => r.round === round)) {
      for (const s of rec.scopes) {
        for (const e of s.timings?.events ?? []) {
          const key = `${s.scope} · ${e.stage}`;
          const have = byStage.get(key) ?? { n: 0, total: 0, max: 0 };
          have.n++; have.total += e.ms; have.max = Math.max(have.max, e.ms);
          byStage.set(key, have);
        }
      }
    }
    console.log(`\nRound ${round}, per stage (calls, average ms, longest ms):`);
    for (const [key, v] of [...byStage].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${key.padEnd(40)} ${pad(v.n, 4)} ${pad(Math.round(v.total / v.n), 7)} ${pad(v.max, 7)}`);
    }
  }
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ at: new Date().toISOString(), options: args, records }, null, 2));
    console.log(`\nWrote ${args.json}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
