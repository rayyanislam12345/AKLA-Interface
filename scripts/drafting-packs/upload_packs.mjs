#!/usr/bin/env node
// Upload the approved drafting packs as their types' Word standards
// (docs/drafting-fidelity-plan-2026-10-19.md, slice 2; Appendix G's last
// step, done in bulk instead of one file at a time in the admin page).
//
//   node scripts/drafting-packs/upload_packs.mjs <packs-dir> --dry-run
//   node scripts/drafting-packs/upload_packs.mjs <packs-dir> [--only letters,memo] [--by <user uuid>]
//
// <packs-dir> is the folder build_pack.py wrote ("5 Packs to check"): its
// packs-config.json names each pack's folder, kind, mode and title, and each
// folder holds <kind>-pack.docx and kinds.json. pack-types.json (beside this
// script) says which document type each pack is the standard for.
//
// For each pack, the same row the admin "Word standard" upload writes
// (src/hooks/useDocumentTypeTemplates.ts), built on the server side:
// - the kinds list is checked (docxAgent.js validateKinds); a pack with a
//   problem is refused and nothing of it is written;
// - the .docx goes to precedent-library at standards/<typeId>/<ms>-<file>;
// - content_html is the text extracted the way every ingestion path does
//   (chat-service/extractText.js, the code the extract-document-text edge
//   function shares); format_rules is a sentence from the pack's format
//   fingerprint (formatFingerprint.js; draftingPacks.js packFormatRules);
// - document_type_templates is upserted with storage_path, filename
//   "<Title> [AKLA standard].docx", content_html, format_rules, kinds,
//   fingerprint, pack_mode and updated_at, and the filing of that file in
//   document_template_versions carries the same.
// Idempotent: a type whose stored standard has the same bytes as the pack is
// left alone (its kinds and mode are brought up to date if they differ).
// The Concession Agreement and RFP standards are never touched. --dry-run
// reads and checks everything and writes nothing; without credentials it
// checks the packs alone.
//
// Credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
// environment, else from chat-service/.env. Runs from any checkout of the
// repository (the Mac or the VM): every path is relative to this file, and
// the chat-service modules and their packages are used as they are.
// Node 20+, ESM.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateKinds } from "../../chat-service/docxAgent.js";
import { fingerprint } from "../../chat-service/formatFingerprint.js";
import { extractTextFromFile } from "../../chat-service/extractText.js";
import { packFormatRules, PACK_MODES } from "../../chat-service/draftingPacks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_SERVICE = join(HERE, "..", "..", "chat-service");
export const BUCKET = "precedent-library";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Types whose standards this script never touches. */
export const PROTECTED = /\bconcession agreement\b|\brfp\b/i;

/** pack-types.json: pack name → document type name. */
export function loadPackTypes(file = join(HERE, "pack-types.json")) {
  return JSON.parse(readFileSync(file, "utf8")).packs;
}

/** The command line: { packsDir, dryRun, only, by, help }. */
export function parseArgs(argv) {
  const out = { packsDir: null, dryRun: false, only: null, by: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--only") out.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--only=")) out.only = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--by") out.by = argv[++i] ?? null;
    else if (a.startsWith("--by=")) out.by = a.slice(5);
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}.`);
    else if (!out.packsDir) out.packsDir = a;
    else throw new Error(`One packs folder only (got "${out.packsDir}" and "${a}").`);
  }
  return out;
}

/** The admin upload's file-name rule (src/lib/utils.ts sanitizeStorageFilename). */
export function sanitizeStorageFilename(name) {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : "";
  const safeBase = base.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (safeBase || "file") + ext.replace(/[^\w.]+/g, "");
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** JSON with its keys sorted at every level: jsonb does not keep key order. */
export const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
/** What the standard is called on the Hub. "Letter / notice" → "Letter - notice [AKLA standard].docx". */
export const standardFileName = (title) => `${String(title).replace(/\s*[\\/]\s*/g, " - ").replace(/[:*?"<>|]+/g, "").replace(/\s+/g, " ").trim()} [AKLA standard].docx`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One pack read from its folder: the file, the kinds, and anything wrong with them. */
export async function readPack(packsDir, name, cfg) {
  const problems = [];
  const mode = cfg?.mode;
  if (!PACK_MODES.includes(mode)) problems.push(`mode "${mode}" is neither form nor shell`);
  const folder = join(packsDir, String(cfg?.folder ?? ""));
  const docxPath = join(folder, `${cfg?.kind}-pack.docx`);
  const kindsPath = join(folder, "kinds.json");
  let bytes = null;
  let kinds = null;
  if (!cfg?.folder || !cfg?.kind) problems.push("packs-config.json gives no folder or kind");
  else if (!existsSync(docxPath)) problems.push(`no ${cfg.kind}-pack.docx in "${cfg.folder}"`);
  else bytes = new Uint8Array(await readFile(docxPath));
  if (cfg?.folder) {
    if (!existsSync(kindsPath)) problems.push(`no kinds.json in "${cfg.folder}"`);
    else {
      try { kinds = JSON.parse(await readFile(kindsPath, "utf8")); } catch (err) { problems.push(`kinds.json is not JSON (${err.message})`); }
    }
  }
  if (kinds) problems.push(...validateKinds(kinds).map((p) => `kinds: ${p}`));
  // A shell pack's example kinds (packs-config.json), stored with the kinds
  // so the drafting prompt can say which blank paragraphs are examples to
  // remove once the body is written (draftingPacks.js packMap).
  if (kinds?.kinds && mode === "shell") {
    const names = [...Object.values(cfg?.shell?.examples ?? {}), ...Object.values(cfg?.shell?.example_tables ?? {})];
    const known = names.filter((n) => Object.hasOwn(kinds.kinds, n) || Object.hasOwn(kinds.tables ?? {}, n));
    if (known.length) kinds.examples = [...new Set(known)];
  }
  let fp = null;
  if (bytes) {
    try { fp = fingerprint(bytes); } catch (err) { problems.push(`the pack could not be read as a Word file (${err.message})`); }
  }
  return { name, mode, title: cfg?.title ?? name, folder: cfg?.folder ?? null, bytes, kinds, fingerprint: fp, problems };
}

/**
 * Uploads (or, with dryRun, checks) every pack in packs-config.json, or the
 * ones `only` names. Returns one row per pack: { pack, type, mode, kinds,
 * action, detail }. `supabase` may be null for an offline dry run.
 * action: uploaded | would upload | kinds updated | would update kinds |
 * unchanged | refused | skipped.
 */
export async function uploadPacks({ supabase, packsDir, dryRun = false, only = null, by = null, now = () => Date.now(), packTypes = loadPackTypes(), log = () => {} }) {
  if (!supabase && !dryRun) throw new Error("Uploading needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; a --dry-run without them checks the packs alone.");
  if (by != null && !UUID.test(String(by))) throw new Error("--by must be a user id (a UUID).");
  const configPath = join(packsDir, "packs-config.json");
  if (!existsSync(configPath)) throw new Error(`There is no packs-config.json in ${packsDir}.`);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const names = only?.length ? only : Object.keys(config.packs ?? {});
  const rows = [];
  for (const name of names) {
    const cfg = config.packs?.[name];
    const typeName = packTypes[name] ?? null;
    const row = { pack: name, type: typeName ?? "-", mode: cfg?.mode ?? "-", kinds: "-", action: "refused", detail: "" };
    rows.push(row);
    try {
      if (!cfg) { row.action = "skipped"; row.detail = "not in packs-config.json"; continue; }
      if (!typeName) { row.action = "skipped"; row.detail = "no type for it in pack-types.json"; continue; }
      if (PROTECTED.test(typeName)) { row.detail = "the Concession Agreement and RFP standards are never touched"; continue; }
      const pack = await readPack(packsDir, name, cfg);
      row.kinds = pack.kinds?.kinds ? String(Object.keys(pack.kinds.kinds).length + Object.keys(pack.kinds.tables ?? {}).length + (pack.kinds.footnote ? 1 : 0)) : "-";
      if (pack.problems.length) { row.detail = pack.problems.slice(0, 3).join("; ") + (pack.problems.length > 3 ? `; and ${pack.problems.length - 3} more` : ""); continue; }
      const fileName = standardFileName(pack.title);
      const hash = sha256(pack.bytes);
      // The text the drafting prompt and the connector's read_standard read,
      // extracted as every other upload is.
      const { text } = await extractTextFromFile(new Blob([pack.bytes]), fileName);
      if (!String(text ?? "").trim()) { row.detail = "no text could be extracted from the pack"; continue; }
      const formatRules = packFormatRules(pack.fingerprint, pack.kinds, pack.mode);
      if (!supabase) { row.action = "would upload"; row.detail = `offline: packs checked, database not read (${fileName})`; continue; }

      const { data: type, error: typeError } = await supabase.from("document_types").select("id, name").eq("name", typeName).maybeSingle();
      if (typeError) throw new Error(`could not read the document type: ${typeError.message}`);
      if (!type) { row.detail = `there is no document type named "${typeName}" (apply 20261020140000_drafting_packs.sql first)`; continue; }
      const { data: existing, error: existingError } = await supabase.from("document_type_templates").select("storage_path, filename, kinds, pack_mode").eq("document_type_id", type.id).maybeSingle();
      if (existingError) throw new Error(/kinds|pack_mode|does not exist|schema cache/i.test(existingError.message ?? "") ? "the pack columns are missing: apply 20261020140000_drafting_packs.sql first" : `could not read the current standard: ${existingError.message}`);
      const packFields = { kinds: pack.kinds, fingerprint: pack.fingerprint, pack_mode: pack.mode };

      // The same file is already the standard: nothing to upload.
      if (existing?.storage_path && /\.docx$/i.test(existing.storage_path)) {
        const { data: blob, error: downloadError } = await supabase.storage.from(BUCKET).download(existing.storage_path);
        if (downloadError || !blob) throw new Error(`could not read the current standard's file (${downloadError?.message ?? "download failed"})`);
        const storedHash = sha256(new Uint8Array(await blob.arrayBuffer()));
        if (storedHash === hash) {
          if (canonical(existing.kinds) === canonical(pack.kinds) && existing.pack_mode === pack.mode) { row.action = "unchanged"; row.detail = existing.filename ?? existing.storage_path; continue; }
          if (dryRun) { row.action = "would update kinds"; row.detail = `same file; kinds or mode differ (${existing.filename ?? existing.storage_path})`; continue; }
          const { error: updateError } = await supabase.from("document_type_templates").update({ ...packFields, format_rules: formatRules }).eq("document_type_id", type.id);
          if (updateError) throw new Error(`could not update the standard: ${updateError.message}`);
          const { error: versionError } = await supabase.from("document_template_versions").update({ ...packFields, format_rules: formatRules }).eq("storage_path", existing.storage_path);
          if (versionError) throw new Error(`could not update the standard's filing: ${versionError.message}`);
          row.action = "kinds updated"; row.detail = existing.filename ?? existing.storage_path;
          continue;
        }
      }

      const storagePath = `standards/${type.id}/${now()}-${sanitizeStorageFilename(fileName)}`;
      const replaces = existing?.storage_path ? `replaces ${existing.filename ?? existing.storage_path}` : "the type's first standard";
      if (dryRun) { row.action = "would upload"; row.detail = `${fileName}; ${replaces}`; continue; }
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, pack.bytes, { contentType: DOCX_MIME, upsert: false });
      if (uploadError) throw new Error(`could not upload the file: ${uploadError.message}`);
      const at = new Date(now()).toISOString();
      const record = { document_type_id: type.id, storage_path: storagePath, filename: fileName, content_html: text, format_rules: formatRules, ...packFields };
      const { error: upsertError } = await supabase.from("document_type_templates").upsert({ ...record, updated_by: by, updated_at: at }, { onConflict: "document_type_id" });
      if (upsertError) {
        await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => undefined);
        throw new Error(`could not set the standard (the upload was taken back): ${upsertError.message}`);
      }
      // The snapshot trigger has filed the file already; the filing gets the
      // pack columns too (and is made here if the trigger is an older one).
      const { error: versionError } = await supabase.from("document_template_versions").upsert({ ...record, created_by: by }, { onConflict: "storage_path" });
      if (versionError) log(`${name}: the standard is set, but its filing could not be written: ${versionError.message}`);
      row.action = "uploaded"; row.detail = `${fileName}; ${replaces}${versionError ? "; filing not written" : ""}`;
    } catch (err) {
      row.action = "refused";
      row.detail = String(err?.message ?? err);
    }
  }
  return rows;
}

/** The rows as a plain table for the terminal. */
export function table(rows) {
  const cols = ["pack", "type", "mode", "kinds", "action", "detail"];
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))]));
  width.detail = Math.min(width.detail, 90);
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
  if (args.help || !args.packsDir) {
    console.log("Usage: node scripts/drafting-packs/upload_packs.mjs <packs-dir> [--dry-run] [--only name,…] [--by <user uuid>]\nEnv: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or chat-service/.env).");
    process.exit(args.help ? 0 : 2);
  }
  const creds = credentials();
  let supabase = null;
  if (creds) {
    // The client from chat-service's own packages, so the script needs no
    // install of its own on the VM.
    const { createClient } = createRequire(join(CHAT_SERVICE, "package.json"))("@supabase/supabase-js");
    supabase = createClient(creds.SUPABASE_URL, creds.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  } else if (!args.dryRun) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed to upload (or put them in chat-service/.env). --dry-run without them checks the packs alone.");
    process.exit(2);
  }
  const rows = await uploadPacks({
    supabase, packsDir: resolve(args.packsDir), dryRun: args.dryRun, only: args.only,
    by: args.by ?? process.env.PACKS_UPLOADED_BY ?? null, log: (l) => console.error(l),
  });
  console.log(`${args.dryRun ? "DRY RUN — nothing written" : "UPLOAD"}${supabase ? "" : " (offline: database not read)"}\n`);
  console.log(table(rows));
  const refused = rows.filter((r) => r.action === "refused").length;
  console.log(`\n${rows.length} pack${rows.length === 1 ? "" : "s"}: ${["uploaded", "would upload", "kinds updated", "would update kinds", "unchanged", "skipped", "refused"].map((a) => [a, rows.filter((r) => r.action === a).length]).filter(([, n]) => n).map(([a, n]) => `${n} ${a}`).join(", ")}.`);
  process.exit(refused ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err?.stack ?? err); process.exit(1); });
}
