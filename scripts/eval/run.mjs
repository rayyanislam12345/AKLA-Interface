#!/usr/bin/env node
// Retrieval evaluation: runs every question in scripts/eval/gold.json through
// one search path ("adapter") and scores what comes back — recall@5,
// recall@10 and MRR, overall and per kind of question — so a change to
// search can be measured before associates see it.
//
//   node scripts/eval/run.mjs --adapter baseline            today's automatic search
//   node scripts/eval/run.mjs --adapter tools               the assistant's library tools
//   node scripts/eval/run.mjs --adapter tools --route kind  tools, with the right tool picked for each question
//   node scripts/eval/run.mjs --adapter retrieve             the one search (chat-service/retrieve.js), routed like tools
//   node scripts/eval/run.mjs --adapter retrieve --route kind  the one search, the question's kind picking the scope
//   node scripts/eval/run.mjs --adapter fake                checks the scorer itself; no network
//   node scripts/eval/run.mjs --check-gold                  checks every expected answer still exists in the index
//
// Options: --label <name>   name for the result file (default: the adapter)
//          --only S01,C03   run only these questions;  --kind precedent_clause
//          --out <dir>      where results go (default scripts/eval/results)
//          --chat-service <dir>  the chat-service code to import (default: found next to this script, else /opt/chat-service)
//          --env <file>     an env file to read keys from (default: the chat-service directory's .env)
//          --concurrency N  questions in flight at once (default 2)
//          --no-synonyms    precedent search without the Haiku synonym step (no ANTHROPIC_API_KEY needed)
//          --baseline-order similarity|server   ranking of the baseline's three searches (default similarity)
//          --verbose        print the top results of each question
//          --rerank-pool N --rerank-chars N --rewrite-wait MS   (retrieve adapter) override retrieve.js's
//                           RERANK_POOL, RERANK_CHARS and REWRITE_WAIT_MS, to compare
//          --deadline MS    (retrieve adapter) override RETRIEVE_DEADLINE_MS; 0 measures the full
//                           search however long it takes (a search that fell back is marked
//                           "fb:<scope>=<path>"; the result file's `retrieve` holds each scope's
//                           fellBack, reason, path, voyageCalls and stage timings)
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and VOYAGE_API_KEY (and
// ANTHROPIC_API_KEY for precedent synonyms) — the names chat-service/server.js
// uses — from the environment, or from the chat-service .env. Read-only: it
// calls the same RPCs and selects as the chat service and writes nothing to
// the database. Prints no keys.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoreQuestion, summarise, formatTable, matchItem, validateGold, sectionLabel, containsPhrase } from "./score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const K_MAX = 10;
const MATCH_THRESHOLD = 0.35; // chat-service/server.js MATCH_THRESHOLD

// ---------------------------------------------------------------------------
// Arguments and environment

function parseArgs(argv) {
  const out = { adapter: "baseline", route: "auto", concurrency: 2, baselineOrder: "similarity", synonyms: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--adapter") out.adapter = next();
    else if (a === "--route") out.route = next();
    else if (a === "--label") out.label = next();
    else if (a === "--only") out.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--kind") out.kind = next();
    else if (a === "--out") out.out = next();
    else if (a === "--gold") out.gold = next();
    else if (a === "--chat-service") out.chatService = next();
    else if (a === "--env") out.env = next();
    else if (a === "--concurrency") out.concurrency = Math.max(1, Number(next()) || 1);
    else if (a === "--baseline-order") out.baselineOrder = next();
    else if (a === "--no-synonyms") out.synonyms = false;
    else if (a === "--rerank-pool") out.retrieveOptions = { ...out.retrieveOptions, rerankPool: Number(next()) };
    else if (a === "--rerank-chars") out.retrieveOptions = { ...out.retrieveOptions, rerankChars: Number(next()) };
    else if (a === "--rewrite-wait") out.retrieveOptions = { ...out.retrieveOptions, rewriteWaitMs: Number(next()) };
    else if (a === "--deadline") out.retrieveOptions = { ...out.retrieveOptions, deadlineMs: Number(next()) };
    else if (a === "--check-gold") out.checkGold = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown option ${a}. Try --help.`);
  }
  return out;
}

export function findChatService(explicit) {
  const candidates = [explicit, process.env.CHAT_SERVICE_DIR, join(HERE, "../../chat-service"), join(HERE, ".."), join(HERE, "../.."), "/opt/chat-service"].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, "libraryTools.js"))) return resolve(c);
  throw new Error(`Could not find chat-service (looked in ${candidates.join(", ")}). Pass --chat-service <dir>.`);
}

export function loadEnv(files) {
  for (const file of files) {
    if (!file || !existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]]) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      if (value) process.env[m[1]] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Statutes: where a passage sits in its Act

// Every copy of an Act the library holds, rebuilt the way libraryTools.actText
// rebuilds one (but keeping each copy, not only the longest: a passage from a
// shorter copy must still be placed).
export function makeActPlacer(supabase, lib) {
  const cache = new Map();
  async function copies(actName) {
    if (cache.has(actName)) return cache.get(actName);
    const p = (async () => {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("documents").select("id, content, metadata").eq("is_statute", true).eq("metadata->>act_name", actName).order("id").range(from, from + 999);
        if (error) throw new Error(`reading ${actName}: ${error.message}`);
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      const groups = new Map();
      for (const r of rows) {
        const m = r.metadata ?? {};
        const key = m.storage_path ?? m.source_hash ?? m.pdf_url ?? m.source_url ?? "copy";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      return [...groups.values()].map((rs) => {
        const byIndex = new Map();
        for (const r of rs) { const i = Number(r.metadata?.chunk_index) || 0; if (!byIndex.has(i)) byIndex.set(i, r); }
        const text = lib.mergeChunks([...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r.content));
        return { text, index: lib.sectionIndex(text) };
      });
    })();
    cache.set(actName, p);
    return p;
  }
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  /** The sections a passage of `actName` covers, or [] when it cannot be placed. */
  return async function place(actName, text) {
    if (!actName || !text) return [];
    let list;
    try { list = await copies(actName); } catch { return []; }
    const t = norm(text);
    for (const probe of [t.slice(0, 200), t.slice(Math.max(0, Math.floor(t.length / 2) - 100), Math.floor(t.length / 2) + 100)]) {
      if (probe.length < 40) continue;
      for (const c of list) {
        const at = c.text.indexOf(probe);
        if (at < 0) continue;
        const start = probe === t.slice(0, 200) ? at : Math.max(0, at - Math.floor(t.length / 2) + 100);
        const end = start + t.length;
        const out = new Set();
        const first = lib.sectionAt(c.index, start);
        if (first) out.add(first);
        for (const e of c.index) if (e.index > start && e.index < end && e.section) out.add(e.section);
        return [...out];
      }
    }
    return [];
  };
}

// ---------------------------------------------------------------------------
// Adapters. Each is { name, retrieve(question, scope) → [passage] } where a
// passage is { kind, act_name, sections, storage_path, filename, text, id, similarity }.

async function embed(voyageKey, text) {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "voyage-law-2", input: [String(text).slice(0, 8000)], input_type: "query" }),
  });
  if (!resp.ok) throw new Error(`Voyage embeddings failed (${resp.status})`);
  return (await resp.json()).data[0].embedding;
}

const isMatter = (scope) => scope && scope !== "general";

// (a) Today's automatic search in the chat (chat-service/server.js, "retrieval:
// the same three searches rag-query runs"): one voyage-law-2 query embedding
// of the message, then match_documents for the project (6), precedents (6)
// and statutes (4, limited to the project's relevant laws when it has any),
// all at cosine ≥ 0.35. Ranked by similarity (or, with --baseline-order
// server, in the order the prompt lists them: project, precedent, statute).
export function baselineAdapter({ supabase, voyageKey, place, order }) {
  const relevantLaws = new Map();
  async function lawsFor(matterId) {
    if (!relevantLaws.has(matterId)) {
      const { data } = await supabase.from("matter_relevant_laws").select("act_name").eq("matter_id", matterId).eq("status", "available");
      relevantLaws.set(matterId, (data ?? []).map((r) => r.act_name).filter(Boolean));
    }
    return relevantLaws.get(matterId);
  }
  const rpc = async (params) => {
    let r = await supabase.rpc("match_documents", params);
    if (r.error && /statement timeout/i.test(r.error.message ?? "")) r = await supabase.rpc("match_documents", params);
    if (r.error) throw new Error(`match_documents: ${r.error.message}`);
    return r.data ?? [];
  };
  return {
    name: "baseline",
    async retrieve(question, scope) {
      const embedding = await embed(voyageKey, question);
      const statuteParams = { query_embedding: embedding, match_threshold: MATCH_THRESHOLD, match_count: 4, statute_only: true };
      if (isMatter(scope)) {
        const acts = await lawsFor(scope);
        if (acts.length) statuteParams.filter_act_names = acts;
      }
      const [m, p, s] = await Promise.all([
        isMatter(scope) ? rpc({ query_embedding: embedding, match_threshold: MATCH_THRESHOLD, match_count: 6, filter_matter_id: scope }) : [],
        rpc({ query_embedding: embedding, match_threshold: MATCH_THRESHOLD, match_count: 6, precedent_only: true }),
        rpc(statuteParams),
      ]);
      let rows = [
        ...m.map((x) => ({ ...x, scope: "matter" })),
        ...p.map((x) => ({ ...x, scope: "precedent" })),
        ...s.map((x) => ({ ...x, scope: "statute" })),
      ];
      if (order !== "server") rows = rows.map((r, i) => ({ r, i })).sort((a, b) => (b.r.similarity ?? -1) - (a.r.similarity ?? -1) || a.i - b.i).map(({ r }) => r);
      return Promise.all(rows.map(async (row) => {
        const meta = row.metadata ?? {};
        const kind = row.scope;
        return {
          kind, id: row.id, similarity: row.similarity ?? null,
          act_name: kind === "statute" ? meta.act_name ?? null : null,
          sections: kind === "statute" ? await place(meta.act_name, row.content) : [],
          storage_path: meta.storage_path ?? null, filename: meta.filename ?? null,
          text: String(row.content ?? ""),
        };
      }));
    },
  };
}

// Which law a question names, the way the assistant would fill the tools'
// `act` argument: every subject word of a held Act in the question, followed
// by "act"/"ordinance"/"rules", or its year, or its alias ("PPRA", "CPC").
export function detectAct(question, acts) {
  const q = ` ${String(question).toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const askedYears = q.match(/ (?:18|19|20)\d{2} /g)?.map((y) => y.trim()) ?? [];
  let best = null;
  for (const a of acts) {
    const bare = a.act_name.replace(/\([^)]*\)/g, " ").toLowerCase();
    const years = bare.match(/\b(?:18|19|20)\d{2}\b/g) ?? [];
    const words = bare.replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !/^\d+$/.test(w) && !["the", "of", "and", "act", "ordinance", "rules", "regulations", "order"].includes(w));
    const aliases = [...a.act_name.matchAll(/\(([A-Za-z]{2,8})\)/g)].map((m) => m[1].toLowerCase());
    if (!words.length) continue;
    const aliasHit = aliases.some((al) => q.includes(` ${al} `));
    const wordsHit = words.every((w) => q.includes(` ${w} `));
    if (!aliasHit && !wordsHit) continue;
    const last = words[words.length - 1];
    const yearHit = years.some((y) => q.includes(` ${y} `));
    // A year in the question that is not this law's year rules it out.
    if (askedYears.length && years.length && !yearHit) continue;
    const named = new RegExp(` ${last} (?:act|ordinance|rules|regulations|order) `).test(q);
    if (!aliasHit && !named && !yearHit) continue;
    const present = words.filter((w) => q.includes(` ${w} `)).length;
    const score = present + (yearHit ? 1 : 0) + (aliasHit ? 1 : 0) + (named ? 1 : 0);
    if (!best || score > best.score || (score === best.score && (a.chunk_count ?? 0) > (best.act.chunk_count ?? 0))) best = { act: a, score };
  }
  return best?.act.act_name ?? null;
}

const SECTION_RE = /\b(?:sections?|sectoin|sec\.?|s\.|s|rule|article|art\.)\s*(\d{1,4}[A-Za-z]?)\b/i;
export const LAWISH = /\b(?:act|acts|ordinance|rules?|section|sectoin|statute|statutory|law|legal|court|enforceable|void|admissible|pakistan|pakistani|prohibited|lawful|regulations?|ppra|p3a|secp)\b/i;

// (b) The assistant's library tools (chat-service/libraryTools.js), called
// the way the assistant calls them (libraryTools.makeToolRunner: the model
// for phrasings is handed to the law and project searches too, so a statute
// question is measured with its rewrite, as the chat runs it). With --route
// auto (default) the tools
// are picked from the question's words alone — read_act_section when it
// names an Act and a section, search_law_library when it sounds like law,
// search_precedents outside a project, search_project_documents inside one
// — and their lists are interleaved. With --route kind the gold's kind picks
// the tool (an upper bound: the assistant always choosing right).
export function toolsAdapter({ supabase, voyageKey, anthropicJson, lib, place, route }) {
  let actsPromise = null;
  const acts = () => (actsPromise ??= lib.listActs(supabase));
  const metaCache = new Map();
  async function projectMeta(ids) {
    const need = ids.filter((id) => !metaCache.has(id));
    if (need.length) {
      const { data, error } = await supabase.from("documents").select("id, metadata").in("id", need);
      if (error) throw new Error(`reading project passage paths: ${error.message}`);
      for (const r of data ?? []) metaCache.set(r.id, r.metadata ?? {});
    }
    return ids.map((id) => metaCache.get(id) ?? {});
  }
  const lawPassages = async (q, act) => {
    const out = await lib.searchLaw(supabase, voyageKey, { query: q, act }, { anthropicJson });
    return Promise.all(out.map(async (p) => {
      const placed = await place(p.act_name, p.text);
      return { kind: "statute", id: p.id, similarity: p.similarity ?? null, act_name: p.act_name, sections: placed.length ? placed : p.section ? [p.section] : [], storage_path: null, filename: null, text: p.text };
    }));
  };
  const sectionPassage = async (act, section) => {
    try {
      const s = await lib.readActSection(supabase, { act, section });
      return [{ kind: "statute", id: s.id, similarity: null, act_name: s.act_name, sections: [s.section], storage_path: null, filename: null, text: s.text }];
    } catch {
      return [];
    }
  };
  const precedentPassages = async (q) => {
    const out = await lib.searchPrecedentsTool(supabase, voyageKey, anthropicJson, { query: q }, {});
    return out.map((p) => {
      // The file: the tool says it (storage_path), else it is read from the
      // id, precedent:<storage path>:<row>:<paragraph>.
      const m = /^precedent:(.*):[^:]*:[^:]*$/.exec(p.id ?? "");
      const path = p.storage_path ?? (m ? m[1] : null);
      return { kind: "precedent", id: p.id, similarity: p.similarity ?? null, act_name: null, sections: [], storage_path: path && path.includes("/") ? path : null, filename: p.filename ?? null, text: p.text };
    });
  };
  const projectPassages = async (q, matterId) => {
    const out = await lib.searchProject(supabase, voyageKey, { matterId, query: q }, { anthropicJson });
    const metas = await projectMeta(out.map((p) => p.id));
    return out.map((p, i) => ({ kind: "matter", id: p.id, similarity: p.similarity ?? null, act_name: null, sections: [], storage_path: metas[i].storage_path ?? null, filename: p.filename, text: p.text }));
  };
  const interleave = (lists) => {
    const out = [];
    const seen = new Set();
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) if (l[i] && !seen.has(l[i].id)) { seen.add(l[i].id); out.push(l[i]); }
    }
    return out;
  };
  return {
    name: "tools",
    async retrieve(question, scope, gold = {}) {
      const act = detectAct(question, await acts());
      const section = SECTION_RE.exec(question)?.[1] ?? null;
      const lawish = !!act || LAWISH.test(question);
      const kind = gold.kind;
      let plan;
      if (route === "kind" && kind) {
        if (kind.startsWith("statute")) plan = ["section", "law"];
        else if (kind === "precedent_clause") plan = ["precedent"];
        else plan = isMatter(scope) ? ["project"] : ["precedent"];
      } else {
        plan = ["section"];
        if (isMatter(scope)) plan.push("project", ...(lawish ? ["law"] : []));
        else plan.push(...(lawish ? ["law", "precedent"] : ["precedent", "law"]));
      }
      const lists = await Promise.all(plan.map((step) => {
        if (step === "section") return act && section ? sectionPassage(act, section) : [];
        if (step === "law") return lawPassages(question, act);
        if (step === "precedent") return precedentPassages(question);
        if (step === "project") return isMatter(scope) ? projectPassages(question, scope) : [];
        return [];
      }));
      // read_act_section's answer leads; the searches are interleaved after it.
      const lead = plan[0] === "section" ? lists[0] : [];
      const searches = plan[0] === "section" ? lists.slice(1) : lists;
      return [...lead, ...interleave(searches).filter((p) => !lead.some((s) => s.id === p.id))];
    },
  };
}

// (d) The one search, chat-service/retrieve.js, as the tools and the chat's
// automatic search now call it: hybrid search_passages (or match_documents
// before that migration), Haiku phrasings for precedent and statute
// questions, rerank-2. Routed like the tools adapter: with --route auto the
// scopes are picked from the question's words (statute when it names an Act
// or reads like law, the project inside a project, precedents outside one)
// and their lists interleaved, a section the question names read first;
// with --route kind the gold's kind picks the scope. Each scope returns its
// best K_MAX.
//
// retrievePlan is the routing alone: the scopes searched for a question and
// the options each is searched with (scripts/eval/time-retrieve.mjs uses it).
export function retrievePlan({ question, scope, kind = null, act = null, route = "auto" }) {
  const lawish = !!act || LAWISH.test(question);
  let plan;
  if (route === "kind" && kind) {
    if (kind.startsWith("statute")) plan = ["statute"];
    else if (kind === "precedent_clause") plan = ["precedent"];
    else plan = isMatter(scope) ? ["project"] : ["precedent"];
  } else if (isMatter(scope)) plan = ["project", ...(lawish ? ["statute"] : [])];
  else plan = lawish ? ["statute", "precedent"] : ["precedent", "statute"];
  return plan.map((s) => ({
    scope: s,
    options: {
      ...(s === "project" ? { matterId: scope } : {}),
      ...(s === "statute" && act ? { actNames: [act] } : {}),
    },
  }));
}

export function retrieveAdapter({ supabase, voyageKey, anthropicJson, lib, place, route, retrieveMod, retrieveOptions = {} }) {
  let actsPromise = null;
  const acts = () => (actsPromise ??= lib.listActs(supabase));
  const kindOf = { project: "matter", precedent: "precedent", statute: "statute" };
  const run = async (question, scope, extra, timing) => {
    const t0 = Date.now();
    const got = await retrieveMod.retrieve({ supabase, voyageKey, anthropicJson, query: question, scope, k: K_MAX, ...retrieveOptions, ...extra, timings: true });
    const ms = Date.now() - t0;
    timing.searchMs = Math.max(timing.searchMs, ms);
    // An older retrieve.js returns the passages alone.
    const out = Array.isArray(got) ? got : got.passages;
    const t = got.timings ?? null;
    if (t?.fellBack) timing.fellBack = [...(timing.fellBack ?? []), scope];
    if (typeof t?.voyageCalls === "number") timing.voyageCalls = (timing.voyageCalls ?? 0) + t.voyageCalls;
    // Each scope's search as retrieve.js reported it: whether and why it
    // fell back, which path produced the passages, its Voyage calls and
    // every stage's timing — written into the result file.
    timing.scopes.push({
      scope, ms, passages: out.length,
      fellBack: !!t?.fellBack, reason: t?.reason ?? null, path: t?.path ?? null, voyageCalls: t?.voyageCalls ?? null,
      engine: t?.engine ?? null, reranked: t?.reranked ?? null, rerankSkipped: t?.rerankSkipped ?? null,
      phrasings: t?.phrasings ?? null, rewriteLate: t?.rewriteLate ?? null, deadlineMs: t?.deadlineMs ?? null,
      total: t?.total ?? null, events: t?.events ?? null,
    });
    return Promise.all(out.map(async (p) => {
      const placed = p.scope === "statute" && !p.lead ? await place(p.act_name, p.text) : [];
      return {
        kind: kindOf[p.scope], id: p.id, similarity: p.similarity ?? null, act_name: p.act_name ?? null,
        sections: placed.length ? placed : p.section ? [p.section] : [], storage_path: p.storage_path ?? null,
        filename: p.label ?? p.filename ?? null, text: p.text, lead: !!p.lead,
      };
    }));
  };
  const interleave = (lists) => {
    const out = [];
    const seen = new Set();
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) if (l[i] && !seen.has(l[i].id)) { seen.add(l[i].id); out.push(l[i]); }
    }
    return out;
  };
  return {
    name: "retrieve",
    async retrieve(question, scope, gold = {}) {
      const act = detectAct(question, await acts());
      const plan = retrievePlan({ question, scope, kind: gold.kind, act, route });
      // searchMs: the slowest scope's retrieve() alone, without the
      // evaluation's own placing of statute passages in their sections.
      const timing = { searchMs: 0, scopes: [] };
      const lists = await Promise.all(plan.map((p) => run(question, p.scope, p.options, timing)));
      // A section read whole leads, as read_act_section's answer does for the tools.
      const lead = lists.flat().filter((p) => p.lead);
      const results = [...lead, ...interleave(lists).filter((p) => !p.lead)];
      Object.defineProperty(results, "timing", { value: timing, enumerable: false });
      return results;
    },
  };
}

// (c) A fake adapter for checking the scorer without the network: for each
// question it plants an acceptable answer at a known rank (1, 3, 7 or
// nowhere) among near-misses built to fail — the wrong section, the right
// file without the phrase, the right Act's table of contents — and the run
// then checks that the scorer found each planted answer at its rank.
const PLANT = [1, 3, 7, null];
export function plantedRank(id) {
  const h = createHash("sha1").update(String(id)).digest()[0];
  return PLANT[h % PLANT.length];
}
export function fakeAdapter() {
  const decoy = (item, n) => {
    if (item.match === "act_section") {
      const label = sectionLabel(item.section);
      const other = String(Number(label.match(/^\d+/)[0]) + 101); // well clear of any other acceptable section
      return n % 2
        ? { kind: "statute", id: `decoy-${n}`, act_name: item.act, sections: [other], text: `${other}. Something else.—(1) Unrelated text ${item.contains ?? ""}` }
        : { kind: "statute", id: `decoy-${n}`, act_name: item.act, sections: [], text: `CONTENTS ${label}. Heading only ${other}. Next heading ${Number(other) + 1}. Another heading` };
    }
    if (item.match === "act_contains") return { kind: "statute", id: `decoy-${n}`, act_name: item.act, sections: [], text: "a passage of the right law without the phrase" };
    return { kind: "precedent", id: `decoy-${n}`, storage_path: item.contains ? item.value : `${item.value}.other`, text: "the right file, the wrong passage" };
  };
  const answer = (item) => {
    if (item.match === "act_section") return { kind: "statute", id: "answer", act_name: `${item.act} (library copy)`, sections: [sectionLabel(item.section)], text: `${sectionLabel(item.section)}. Heading.—(1) ${item.contains ?? "body"}` };
    if (item.match === "act_contains") return { kind: "statute", id: "answer", act_name: item.act, sections: [], text: `… ${item.contains} …` };
    return { kind: "precedent", id: "answer", storage_path: item.value, text: `… ${item.contains ?? "any passage"} …` };
  };
  return {
    name: "fake",
    async retrieve(_question, _scope, gold = {}) {
      const item = gold.expected?.[0];
      const out = [];
      for (let i = 0; i < K_MAX; i++) out.push(decoy(item, i));
      const at = plantedRank(gold.id);
      if (at) out[at - 1] = answer(item);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Gold check: every expected answer still exists in the live index.

async function checkGold(gold, { supabase, lib, place }) {
  const problems = [];
  const docsByPath = new Map();
  const docs = async (path) => {
    if (!docsByPath.has(path)) {
      const { data, error } = await supabase.from("documents").select("id, content").eq("metadata->>storage_path", path);
      if (error) throw new Error(error.message);
      docsByPath.set(path, data ?? []);
    }
    return docsByPath.get(path);
  };
  const acts = await lib.listActs(supabase);
  for (const q of gold.questions) {
    let ok = 0;
    for (const e of q.expected) {
      if (e.match === "storage_path") {
        const rows = await docs(e.value);
        if (rows.length && (!e.contains || rows.some((r) => containsPhrase(r.content, e.contains)))) ok++;
        else problems.push(`${q.id}: ${e.value}${e.contains ? ` lacks “${e.contains}”` : " is not indexed"}`);
      } else {
        const held = acts.filter((a) => a.act_name === e.act);
        if (!held.length) { problems.push(`${q.id}: the library holds no Act named “${e.act}”`); continue; }
        const doc = await lib.actText(supabase, e.act);
        if (e.match === "act_contains") {
          if (containsPhrase(doc?.text ?? "", e.contains)) ok++;
          else problems.push(`${q.id}: ${e.act} lacks “${e.contains}”`);
        } else {
          const found = doc ? lib.readSection(doc.text, sectionLabel(e.section), doc.index) : null;
          if (found && (!e.contains || containsPhrase(found.text, e.contains))) ok++;
          else problems.push(`${q.id}: ${e.act} s.${e.section} not found in the copy read_act_section reads${e.contains ? ` (or lacks “${e.contains}”)` : ""}`);
        }
      }
    }
    if (!ok) problems.push(`${q.id}: NO expected answer exists any more`);
  }
  return problems;
}

// ---------------------------------------------------------------------------

/**
 * One question's row in the result file: its score, timing (ms, searchMs),
 * the scopes that fell back, the Voyage calls, and — under `retrieve` — each
 * scope's search as retrieve.js reported it (fellBack, reason, path,
 * voyageCalls, every stage's events), when the adapter attached them.
 */
export function resultRow(q, results, { ms = null, error = null } = {}) {
  const timing = results.timing ?? null;
  const s = scoreQuestion(results, q.expected);
  return {
    id: q.id, kind: q.kind, scope: q.scope, question: q.question, ms,
    searchMs: timing?.searchMs ?? null, fellBack: timing?.fellBack ?? null, voyageCalls: timing?.voyageCalls ?? null,
    retrieve: timing?.scopes?.length ? timing.scopes : null,
    error, resultCount: results.length, ...s,
    top: results.slice(0, K_MAX).map((r, i) => ({
      rank: i + 1, kind: r.kind, act_name: r.act_name ?? null, sections: r.sections ?? [], filename: r.filename ?? null,
      storage_path: r.storage_path ?? null, similarity: r.similarity ?? null, matched: q.expected.some((e) => matchItem(r, e)),
      excerpt: String(r.text ?? "").replace(/\s+/g, " ").slice(0, 160),
    })),
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * The live services, as the chat service reaches them: { supabase, lib,
 * voyageKey, anthropicJson, place, chatDir }. Keys from the environment, the
 * --env file, the chat-service .env or /opt/chat-service/.env.
 */
export async function connect({ chatService = null, env = null, synonyms = true } = {}) {
  const chatDir = findChatService(chatService);
  loadEnv([env, join(chatDir, ".env"), "/opt/chat-service/.env"]);
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VOYAGE_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Not set: ${missing.join(", ")} (environment, --env file, or ${join(chatDir, ".env")}).`);
  const require = createRequire(join(chatDir, "package.json"));
  const supabaseMod = await import(pathToFileURL(require.resolve("@supabase/supabase-js")).href);
  const createClient = supabaseMod.createClient ?? supabaseMod.default?.createClient;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const lib = await import(pathToFileURL(join(chatDir, "libraryTools.js")).href);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicJson = synonyms && anthropicKey
    ? async (body, signal) => {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);
      return resp.json();
    }
    : null;
  return { supabase, lib, voyageKey: process.env.VOYAGE_API_KEY, anthropicJson, place: makeActPlacer(supabase, lib), chatDir };
}

const HELP = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 30).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const goldPath = resolve(args.gold ?? join(HERE, "gold.json"));
  const gold = JSON.parse(readFileSync(goldPath, "utf8"));
  const problems = validateGold(gold);
  if (problems.length) throw new Error(`gold.json is malformed:\n${problems.join("\n")}`);
  let questions = gold.questions;
  if (args.only) questions = questions.filter((q) => args.only.includes(q.id));
  if (args.kind) questions = questions.filter((q) => q.kind === args.kind);
  if (!questions.length) throw new Error("No questions selected.");

  let adapter;
  let ctx = {};
  const needsLive = args.checkGold || args.adapter !== "fake";
  if (needsLive) {
    ctx = await connect(args);
    console.log(`chat-service code: ${ctx.chatDir}${ctx.anthropicJson ? "" : "  (precedent synonyms off)"}`);
  }

  if (args.checkGold) {
    const issues = await checkGold({ questions }, ctx);
    console.log(issues.length ? `Gold check: ${issues.length} problem(s)\n${issues.join("\n")}` : `Gold check: all ${questions.length} questions have their expected answers in the live index.`);
    if (issues.some((p) => /NO expected answer/.test(p))) process.exitCode = 1;
    return;
  }

  if (args.adapter === "baseline") adapter = baselineAdapter({ ...ctx, order: args.baselineOrder });
  else if (args.adapter === "tools") adapter = toolsAdapter({ ...ctx, route: args.route });
  else if (args.adapter === "retrieve") {
    const retrieveMod = await import(pathToFileURL(join(ctx.chatDir, "retrieve.js")).href);
    adapter = retrieveAdapter({ ...ctx, route: args.route, retrieveMod, retrieveOptions: args.retrieveOptions ?? {} });
  } else if (args.adapter === "fake") adapter = fakeAdapter();
  else throw new Error(`Unknown adapter "${args.adapter}" (baseline, tools, retrieve, fake).`);

  const started = new Date();
  const rows = await pool(questions, args.concurrency, async (q) => {
    const t0 = Date.now();
    let results = [];
    let error = null;
    try {
      results = (await adapter.retrieve(q.question, q.scope, q)) ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ms = Date.now() - t0;
    const row = resultRow(q, results, { ms, error });
    const { searchMs, voyageCalls, fellBack, retrieve: scopes } = row;
    const s = row;
    const fb = fellBack ? ` fb:${fellBack.map((sc) => `${sc}=${scopes?.find((x) => x.scope === sc)?.path ?? "?"}`).join("+")}` : "";
    const mark = error ? "ERR " : s.firstRank ? `@${s.firstRank}`.padEnd(4) : "miss";
    console.log(`${q.id.padEnd(4)} ${mark} ${String(ms).padStart(6)}ms${searchMs != null ? ` (search ${String(searchMs).padStart(5)}ms)` : ""}${voyageCalls != null ? ` v${voyageCalls}` : ""}${fb}  ${q.question.slice(0, 80)}${error ? `  — ${error}` : ""}`);
    if (args.verbose) for (const t of row.top) console.log(`        ${String(t.rank).padStart(2)}${t.matched ? "*" : " "} ${t.kind ?? ""} ${t.act_name ? `${t.act_name} §${t.sections.join(",")}` : t.filename ?? t.storage_path ?? ""} ${t.similarity != null ? `(${Number(t.similarity).toFixed(3)})` : ""}`);
    return row;
  });

  const summary = summarise(rows);
  const label = args.label ?? `${adapter.name}${(args.adapter === "tools" || args.adapter === "retrieve") && args.route !== "auto" ? `-route-${args.route}` : ""}`;
  console.log(`\n${formatTable(summary, `${label} — ${rows.length} questions, ${started.toISOString()}`)}`);

  let selfCheck = null;
  if (args.adapter === "fake") {
    const wrong = rows.filter((r) => r.firstRank !== plantedRank(r.id));
    selfCheck = { agreed: rows.length - wrong.length, of: rows.length, wrong: wrong.map((r) => ({ id: r.id, planted: plantedRank(r.id), scored: r.firstRank })) };
    console.log(`\nScorer self-check: found the planted answer at its planted rank for ${selfCheck.agreed}/${selfCheck.of} questions${wrong.length ? ` — WRONG: ${wrong.map((w) => `${w.id} planted ${plantedRank(w.id)} scored ${w.firstRank}`).join("; ")}` : ""}.`);
    if (wrong.length) process.exitCode = 1;
  }

  const outDir = resolve(args.out ?? join(HERE, "results"));
  mkdirSync(outDir, { recursive: true });
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const file = join(outDir, `${label}-${stamp}.json`);
  const goldHash = createHash("sha256").update(readFileSync(goldPath)).digest("hex").slice(0, 12);
  writeFileSync(file, JSON.stringify({
    label, adapter: adapter.name, timestamp: started.toISOString(), gold: { path: goldPath, sha256_12: goldHash, questions: rows.length },
    options: { route: args.route, baselineOrder: args.baselineOrder, synonyms: !!ctx.anthropicJson, only: args.only ?? null, kind: args.kind ?? null, retrieve: args.retrieveOptions ?? null },
    summary, selfCheck, questions: rows,
  }, null, 2));
  console.log(`\nWrote ${file}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
