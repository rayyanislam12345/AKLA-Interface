// The firm's style sheets as data: how the firm writes, for every draft
// prompt (firmRules.js styleSheetText) and the wording check
// (proofCheck.js runWordingCheck). docs/drafting-fidelity-plan-2026-10-19.md,
// "How it will work: the wording" item 1 and Appendix E; the owner's
// decisions of 20 October 2026 override the files where they differ
// (British -ise everywhere; arbitration always asked; no government or
// province named; the government party is "Government").
//
// core.json is firm-wide; each family file (one per drafting pack, plus the
// Concession Agreement and the RFP) holds only what differs, and is laid
// over the core by mergeSheets. Every rule says in "source" which of the
// firm's files (or which decision) it came from. The files are read once,
// when this module is first imported.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

/** The family style sheets, by key (the drafting packs' names, plus the two skills' documents). */
export const FAMILY_KEYS = Object.freeze([
  "letters", "memo", "opinion", "proposal", "minutes", "consent", "board-resolution",
  "amendment", "escrow", "ie-agreement", "ia-agreement", "framework",
  "concession-agreement", "rfp",
]);

const read = (key) => JSON.parse(readFileSync(join(DIR, `${key}.json`), "utf8"));

export const CORE = Object.freeze(read("core"));
export const FAMILY_SHEETS = Object.freeze(Object.fromEntries(FAMILY_KEYS.map((k) => [k, Object.freeze(read(k))])));

/**
 * Document type name → style-sheet key, from each family file's "types".
 * The migration's public.clause_bank_family is the same list (a test checks).
 */
export const TYPE_STYLE_SHEETS = Object.freeze(Object.fromEntries(
  FAMILY_KEYS.flatMap((k) => (FAMILY_SHEETS[k].types ?? []).map((t) => [t, k])),
));

const norm = (s) => String(s ?? "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
const TYPE_INDEX = new Map(Object.entries(TYPE_STYLE_SHEETS).map(([t, k]) => [norm(t), k]));

/**
 * The style-sheet key for a family key, a pack name or a document type
 * name ("Escrow Agreement", "Independent Engineer’s Agreement", "RFP
 * Volume I"); null for a kind of document that has no style sheet of its own
 * (it is drafted to the core).
 */
export function styleSheetKeyFor(kindOrTypeName) {
  const n = norm(kindOrTypeName);
  if (!n) return null;
  if (FAMILY_KEYS.includes(n)) return n;
  if (TYPE_INDEX.has(n)) return TYPE_INDEX.get(n);
  for (const k of FAMILY_KEYS) if ((FAMILY_SHEETS[k].packs ?? []).map(norm).includes(n)) return k;
  if (/\b(?:rfp|request for proposals?)\b/.test(n)) return "rfp";
  return null;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Lists that add up rather than replace: a family's banned phrasings and
// tells come on top of the core's (an entry with the same id replaces it).
const ADDITIVE = new Set(["banned", "tells_of_counterparty", "source", "examples", "variants"]);

function mergeList(a, b) {
  const out = [...(a ?? [])];
  for (const item of b ?? []) {
    const id = isObject(item) ? item.id : null;
    const at = id ? out.findIndex((x) => isObject(x) && x.id === id) : out.indexOf(item);
    if (at === -1) out.push(item);
    else out[at] = item;
  }
  return out;
}

/** A family sheet laid over the core: objects merge, the family's scalars win, the additive lists add up. */
export function mergeSheets(core, family) {
  if (!family) return structuredClone(core);
  const out = structuredClone(core);
  const walk = (target, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (ADDITIVE.has(k) && Array.isArray(v)) target[k] = mergeList(target[k], v);
      else if (isObject(v) && isObject(target[k])) walk(target[k], v);
      else target[k] = structuredClone(v);
    }
  };
  walk(out, family);
  // A family can drop a core rule outright ("off": ["voice_we"]).
  if (Array.isArray(family.off)) out.banned = (out.banned ?? []).filter((b) => !family.off.includes(b.id));
  return out;
}

const MERGED = new Map();

/** The whole style sheet for a kind of document (core plus its family), or the core alone. */
export function styleSheetFor(kindOrTypeName) {
  const key = styleSheetKeyFor(kindOrTypeName) ?? "core";
  if (!MERGED.has(key)) {
    const sheet = key === "core" ? structuredClone(CORE) : mergeSheets(CORE, FAMILY_SHEETS[key]);
    sheet.key = key;
    MERGED.set(key, Object.freeze(sheet));
  }
  return MERGED.get(key);
}
