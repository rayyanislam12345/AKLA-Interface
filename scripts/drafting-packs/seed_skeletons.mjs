#!/usr/bin/env node
// Write each kind of document's clause list and drafting decisions into its
// document_types row (docs/drafting-fidelity-plan-2026-10-19.md, slice 4):
// chat-service/skeletons/<key>.json → document_types.skeleton and
// chat-service/decisions/<key>.json → document_types.decisions (columns
// added by supabase/migrations/20261021100000_skeletons_and_decisions.sql).
//
//   node scripts/drafting-packs/seed_skeletons.mjs --dry-run
//   node scripts/drafting-packs/seed_skeletons.mjs [--only escrow,letters]
//
// Which row each file belongs to: pack-types.json (beside this script) for
// the wave-1 packs, and by name for the Concession Agreement and the RFP
// ("Request for Proposal (RFP)"; an RFP row found by its questionnaire key
// rfp_federal_ppp is taken too, whatever it is called). A file's decisions
// are the decisions file with the same typeName.
//
// Every file is checked first (skeletonCheck.js validateSkeleton,
// decisions.js validateDecisions); a file with a problem is refused and
// nothing of it is written. Idempotent: a row that already holds the same
// JSON is left alone. --dry-run reads and checks everything and writes
// nothing; without credentials it checks the files alone.
//
// Credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
// environment, else from chat-service/.env (as upload_packs.mjs). Node 20+.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skeletonFiles, validateSkeleton } from "../../chat-service/skeletonCheck.js";
import { decisionFiles, validateDecisions } from "../../chat-service/decisions.js";
import { loadPackTypes, canonical } from "./upload_packs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_SERVICE = join(HERE, "..", "..", "chat-service");

/** The rows the two firm standards that are not packs live in. */
export const NAMED_TYPES = Object.freeze({
  "concession-agreement": "Concession Agreement",
  rfp: "Request for Proposal (RFP)",
});

/** The command line: { dryRun, only, help }. */
export function parseArgs(argv) {
  const out = { dryRun: false, only: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--only") out.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--only=")) out.only = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`Unknown argument ${a}.`);
  }
  return out;
}

const lower = (s) => String(s ?? "").trim().toLowerCase();

/**
 * What would be written: [{ key, typeName, skeleton, decisions, problems }]
 * from the files, one per skeleton file, its decisions paired by typeName.
 */
export function plan({ skeletons = skeletonFiles(), decisions = decisionFiles(), packTypes = loadPackTypes(), only = null } = {}) {
  const names = { ...packTypes, ...NAMED_TYPES };
  const out = [];
  for (const [key, skeleton] of Object.entries(skeletons)) {
    if (only && !only.includes(key)) continue;
    const typeName = names[key] ?? null;
    const problems = [];
    if (!typeName) problems.push(`no document type is named for "${key}" (pack-types.json or NAMED_TYPES)`);
    else if (lower(skeleton.typeName) !== lower(typeName)) problems.push(`the file says typeName "${skeleton.typeName}", pack-types.json says "${typeName}"`);
    const dec = Object.values(decisions).find((d) => lower(d.typeName) === lower(skeleton.typeName)) ?? null;
    if (dec) problems.push(...validateDecisions(dec).map((p) => `decisions: ${p}`));
    problems.push(...validateSkeleton(skeleton, dec).map((p) => `clause list: ${p}`));
    out.push({ key, typeName, skeleton, decisions: dec, problems });
  }
  for (const k of only ?? []) if (!out.some((r) => r.key === k)) out.push({ key: k, typeName: names[k] ?? null, skeleton: null, decisions: null, problems: [`no skeleton file chat-service/skeletons/${k}.json`] });
  return out;
}

/**
 * Seeds the rows. Returns [{ key, type, action, note }] where action is
 * written, would write, unchanged, skipped (no row) or refused.
 */
export async function seedSkeletons({ supabase = null, dryRun = false, only = null, log = () => {}, ...files } = {}) {
  const rows = [];
  const planned = plan({ ...files, only });
  let types = null;
  if (supabase) {
    const { data, error } = await supabase.from("document_types").select("id, name, questionnaire, skeleton, decisions");
    if (error) {
      const hint = /skeleton|decisions|does not exist|schema cache/i.test(error.message) ? " Apply supabase/migrations/20261021100000_skeletons_and_decisions.sql first." : "";
      throw new Error(`Could not read document_types: ${error.message}.${hint}`);
    }
    types = data ?? [];
  }
  for (const p of planned) {
    if (p.problems.length) {
      rows.push({ key: p.key, type: p.typeName ?? "—", action: "refused", note: p.problems.join("; ") });
      continue;
    }
    const n = p.decisions?.questions.length ?? 0;
    const counts = `${p.skeleton.items.length} clause list items, ${n ? `${n} decision${n === 1 ? "" : "s"}` : "no decisions"}`;
    if (!types) {
      rows.push({ key: p.key, type: p.typeName, action: dryRun ? "checked" : "skipped", note: `${counts}; database not read` });
      continue;
    }
    const matches = types.filter((t) => lower(t.name) === lower(p.typeName) || (p.decisions?.key && t.questionnaire === p.decisions.key));
    if (!matches.length) {
      rows.push({ key: p.key, type: p.typeName, action: "skipped", note: `no document type named "${p.typeName}"` });
      continue;
    }
    for (const t of matches) {
      const same = canonical(t.skeleton ?? null) === canonical(p.skeleton) && canonical(t.decisions ?? null) === canonical(p.decisions ?? null);
      if (same) { rows.push({ key: p.key, type: t.name, action: "unchanged", note: counts }); continue; }
      if (dryRun) { rows.push({ key: p.key, type: t.name, action: "would write", note: counts }); continue; }
      const { error } = await supabase.from("document_types").update({ skeleton: p.skeleton, decisions: p.decisions ?? null }).eq("id", t.id);
      if (error) { rows.push({ key: p.key, type: t.name, action: "refused", note: `the write failed: ${error.message}` }); continue; }
      log(`${t.name}: clause list and decisions written`);
      rows.push({ key: p.key, type: t.name, action: "written", note: counts });
    }
  }
  return rows;
}

/** The rows as a plain table: KEY, TYPE, ACTION, NOTE. */
export function table(rows) {
  const cols = ["key", "type", "action", "note"];
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))]));
  width.note = Math.min(width.note, 100);
  const line = (r) => cols.map((c) => String(r[c] ?? "").slice(0, width[c]).padEnd(width[c])).join("  ").trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))), cols.map((c) => "-".repeat(width[c])).join("  "), ...rows.map(line)].join("\n");
}

function credentials() {
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const file = join(CHAT_SERVICE, ".env");
  if ((!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) && existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
      if (m && m[1] in env && !env[m[1]]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? env : null;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  if (args.help) {
    console.log("Usage: node scripts/drafting-packs/seed_skeletons.mjs [--dry-run] [--only key,…]\nEnv: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or chat-service/.env).");
    process.exit(0);
  }
  const creds = credentials();
  let supabase = null;
  if (creds) {
    const { createClient } = createRequire(join(CHAT_SERVICE, "package.json"))("@supabase/supabase-js");
    supabase = createClient(creds.SUPABASE_URL, creds.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  } else if (!args.dryRun) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed to write (or put them in chat-service/.env). --dry-run without them checks the files alone.");
    process.exit(2);
  }
  const rows = await seedSkeletons({ supabase, dryRun: args.dryRun, only: args.only, log: (l) => console.error(l) });
  console.log(`${args.dryRun ? "DRY RUN — nothing written" : "SEED"}${supabase ? "" : " (offline: database not read)"}\n`);
  console.log(table(rows));
  const refused = rows.filter((r) => r.action === "refused").length;
  process.exit(refused ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err?.stack ?? err); process.exit(1); });
}
