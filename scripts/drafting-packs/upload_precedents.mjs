#!/usr/bin/env node
// Add the firm's chosen precedents to the Hub's precedent library under
// their document type, so the clause bank (chat-service/clauseBank.js) and
// precedent search have the firm's own versions of each clause
// (docs/drafting-fidelity-plan-2026-10-19.md, "Decisions taken": "the chosen
// precedents are copied into the Hub's precedent library under their type").
//
//   node scripts/drafting-packs/upload_precedents.mjs --type "Escrow Agreement" <file.docx | folder>… --dry-run
//   node scripts/drafting-packs/upload_precedents.mjs --type "Escrow Agreement" <file.docx | folder>… [--recursive] [--by <user uuid>]
//
// How a precedent enters the library today: the admin page
// (src/hooks/usePrecedentLibrary.ts useUploadPrecedentDocument) puts the file
// in the precedent-library bucket at precedent/<typeId>/<ms>-<name> and calls
// the process-document edge function, which calls ingest-documents. Both
// functions check the caller with auth.getUser, so they need a signed-in
// lawyer's JWT, not the service role; and ingest-documents stores the text
// as 1,000-word windows joined by single spaces, with no paragraphs or
// headings, which the clause bank cannot read clauses out of. The index
// worker (chat-service/indexWorker.js) reads files properly but does not take
// library files yet ("Library files are not read by this worker yet").
//
// So this script does, with the service role, what the index worker does for
// a project file, for a precedent: the worker's own reader
// (indexing/extract.js extractForIndex), chunker (indexing/chunk.js
// chunkDocument: whole paragraphs under one clause, each passage with its
// heading path) and embedder (indexing/embed.js, voyage-law-2, with the same
// contextual header), and it writes the documents rows the admin page's
// upload would (is_precedent, document_type_id, metadata storage_path /
// filename / file_size / chunk_index) plus the worker's columns
// (heading_path, page, char_start, char_end, text_hash). The database trigger
// then cuts the precedent's paragraphs into precedent_passages, each with its
// heading, number and family (20261021090000_clause_bank.sql), exactly as for
// any precedent. The file is stored where the admin page stores it, so the
// Precedent Library page lists, opens and deletes it as its own.
//
// Idempotent by file hash: a file whose SHA-256 is already in the library
// (metadata.file_sha256), or that the library holds under the same name and
// size (the site's own duplicate rule), is skipped. --dry-run reads every file
// and checks the database, and writes nothing and calls no Voyage; without
// credentials it reads the files alone. A failed file is taken back (its rows
// and its stored copy) and the next file goes on.
//
// Credentials: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and VOYAGE_API_KEY from
// the environment, else from chat-service/.env. On Voyage's free tier set
// VOYAGE_MIN_INTERVAL_MS=21000 (three requests a minute); a 100-page
// agreement is one or two requests. --no-embeddings stores the passages
// without vectors (found by words and by the clause bank, not by meaning).
// Node 20+, ESM; runs from any checkout with chat-service's packages.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractForIndex } from "../../chat-service/indexing/extract.js";
import { chunkDocument, contextualHeader, embeddingInput, textHash } from "../../chat-service/indexing/chunk.js";
import { embedDocuments } from "../../chat-service/indexing/embed.js";
import { sanitizeStorageFilename, DOCX_MIME, BUCKET } from "./upload_packs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_SERVICE = join(HERE, "..", "..", "chat-service");
export const INSERT_BATCH = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The command line: { paths, type, dryRun, recursive, by, embed, help }. */
export function parseArgs(argv) {
  const out = { paths: [], type: null, dryRun: false, recursive: false, by: null, embed: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--recursive" || a === "-r") out.recursive = true;
    else if (a === "--no-embeddings") out.embed = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--type") out.type = argv[++i] ?? null;
    else if (a.startsWith("--type=")) out.type = a.slice(7);
    else if (a === "--by") out.by = argv[++i] ?? null;
    else if (a.startsWith("--by=")) out.by = a.slice(5);
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}.`);
    else out.paths.push(a);
  }
  return out;
}

/** The .docx files named or inside the folders named (sub-folders with --recursive); Word's "~$" lock files left out. */
export function listDocx(paths, { recursive = false } = {}) {
  const files = [];
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { if (recursive) walk(full, depth + 1); continue; }
      if (/\.docx$/i.test(name) && !name.startsWith("~$") && !name.startsWith(".")) files.push(full);
    }
  };
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`There is no file or folder at ${p}.`);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, 0);
    else if (/\.docx$/i.test(p) && !basename(p).startsWith("~$")) files.push(p);
    else throw new Error(`${p} is not a Word file (.docx).`);
  }
  return [...new Set(files.map((f) => resolve(f)))];
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A file read for the library: its passages (the index reader's), or why it cannot be. */
export async function readPrecedent(bytes, fileName) {
  const read = await extractForIndex(bytes, "file.docx");
  const { text, chunks } = chunkDocument(read.blocks, { mode: read.mode });
  if (!chunks.length || text.replace(/\s+/g, "").length < 20) throw new Error("no readable text was found in it");
  return { read, chunks, headings: chunks.filter((c) => c.headingPath).length, fileName };
}

/** The documents rows for one precedent, as the admin upload and the index worker would write them together. */
export function precedentRows({ chunks, read, vectors = null, fileName, storagePath, fileSize, hash, typeId, by = null, uploadedAt }) {
  return chunks.map((c, i) => ({
    content: c.content,
    ...(vectors ? { embedding: vectors[i] } : {}),
    metadata: {
      filename: fileName,
      file_type: DOCX_MIME,
      upload_date: uploadedAt,
      storage_path: storagePath,
      storage_bucket: BUCKET,
      file_size: fileSize,
      original_format: "docx",
      extractor: read.extractor ?? null,
      chunk_index: c.index,
      chunk_total: chunks.length,
      heading_path: c.headingPath,
      file_sha256: hash,
      source: "upload_precedents",
    },
    matter_id: null,
    document_type_id: typeId,
    is_precedent: true,
    is_statute: false,
    created_by: by,
    heading_path: c.headingPath,
    page: c.page,
    char_start: c.start,
    char_end: c.end,
    text_hash: textHash(c.content),
  }));
}

/** The document type named (exact name, any case, either apostrophe) or given by id. */
export async function findType(supabase, want) {
  const w = String(want ?? "").trim();
  if (!w) throw new Error("--type is needed: the document type's name (as in pack-types.json) or id.");
  if (UUID.test(w)) {
    const { data, error } = await supabase.from("document_types").select("id, name").eq("id", w).maybeSingle();
    if (error) throw new Error(`Could not read the document type: ${error.message}`);
    if (!data) throw new Error(`There is no document type with id ${w}.`);
    return data;
  }
  const { data, error } = await supabase.from("document_types").select("id, name");
  if (error) throw new Error(`Could not read the document types: ${error.message}`);
  const norm = (s) => String(s).replace(/[’‘]/g, "'").trim().toLowerCase();
  const type = (data ?? []).find((t) => norm(t.name) === norm(w));
  if (!type) throw new Error(`There is no document type named "${w}". The types: ${(data ?? []).map((t) => t.name).sort().join("; ")}.`);
  return type;
}

/** Is this file in the library already? By hash first, then by the site's rule (same name and size). */
async function already(supabase, { hash, fileName, size }) {
  const byHash = await supabase.from("documents").select("document_type_id, metadata").eq("is_precedent", true).eq("metadata->>file_sha256", hash).limit(1);
  if (byHash.error) throw new Error(`Could not check the library: ${byHash.error.message}`);
  if (byHash.data?.length) return { how: "the same file (by its hash)", row: byHash.data[0] };
  const byName = await supabase.from("documents").select("document_type_id, metadata").eq("is_precedent", true).ilike("metadata->>filename", fileName.replace(/[%_\\]/g, "\\$&")).eq("metadata->>file_size", String(size)).limit(1);
  if (byName.error) throw new Error(`Could not check the library: ${byName.error.message}`);
  if (byName.data?.length) return { how: "a file of the same name and size", row: byName.data[0] };
  return null;
}

/**
 * Adds (or, with dryRun, checks) each file. One row per file:
 * { file, passages, headings, action, detail }; action: added | would add |
 * already in library | refused. `supabase` may be null for an offline dry run.
 */
export async function uploadPrecedents({ supabase, files, type: typeWanted, dryRun = false, embed = true, by = null, voyageKey = null, now = () => Date.now(), embedder = embedDocuments, log = () => {} }) {
  if (!supabase && !dryRun) throw new Error("Adding precedents needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; a --dry-run without them reads the files alone.");
  if (by != null && !UUID.test(String(by))) throw new Error("--by must be a user id (a UUID).");
  if (!dryRun && embed && !voyageKey) throw new Error("VOYAGE_API_KEY is needed for the passages' vectors (or pass --no-embeddings).");
  const type = supabase ? await findType(supabase, typeWanted) : { id: null, name: String(typeWanted ?? "") };
  const rows = [];
  for (const path of files) {
    const fileName = basename(path);
    const row = { file: fileName, passages: "-", headings: "-", action: "refused", detail: "" };
    rows.push(row);
    let storagePath = null;
    let inserted = false;
    try {
      const bytes = new Uint8Array(await readFile(path));
      const hash = sha256(bytes);
      const doc = await readPrecedent(bytes, fileName);
      row.passages = String(doc.chunks.length);
      row.headings = String(doc.headings);
      if (supabase) {
        const found = await already(supabase, { hash, fileName, size: bytes.byteLength });
        if (found) {
          row.action = "already in library";
          row.detail = `${found.how}${found.row.document_type_id && found.row.document_type_id !== type.id ? ", under another type" : ""}: ${found.row.metadata?.storage_path ?? ""}`;
          continue;
        }
      }
      if (dryRun) { row.action = "would add"; row.detail = supabase ? `as ${type.name}` : `offline: file read, database not checked (${type.name})`; continue; }

      storagePath = `precedent/${type.id}/${now()}-${sanitizeStorageFilename(fileName)}`;
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, { contentType: DOCX_MIME, upsert: false });
      if (uploadError) { storagePath = null; throw new Error(`could not store the file: ${uploadError.message}`); }
      let vectors = null;
      if (embed) {
        const title = fileName.replace(/\.docx$/i, "");
        const inputs = doc.chunks.map((c) => embeddingInput(contextualHeader({ title, typeName: type.name, headingPath: c.headingPath, page: c.page }), c.content));
        vectors = await embedder(inputs, { apiKey: voyageKey, log });
      }
      const records = precedentRows({ chunks: doc.chunks, read: doc.read, vectors, fileName, storagePath, fileSize: bytes.byteLength, hash, typeId: type.id, by, uploadedAt: new Date(now()).toISOString() });
      for (let i = 0; i < records.length; i += INSERT_BATCH) {
        inserted = true;
        const { error } = await supabase.from("documents").insert(records.slice(i, i + INSERT_BATCH));
        if (error) throw new Error(`could not save its passages: ${error.message}`);
      }
      row.action = "added";
      row.detail = `${type.name}; ${storagePath}${embed ? "" : "; no vectors"}`;
    } catch (err) {
      row.action = "refused";
      row.detail = String(err?.message ?? err);
      // Take back what was written, so a second run starts clean.
      if (supabase && storagePath) {
        if (inserted) await supabase.from("documents").delete().eq("is_precedent", true).eq("metadata->>storage_path", storagePath).then(() => undefined, () => undefined);
        await supabase.storage.from(BUCKET).remove([storagePath]).then(() => undefined, () => undefined);
      }
    }
  }
  return rows;
}

/** The rows as a plain table for the terminal. */
export function table(rows) {
  const cols = ["file", "passages", "headings", "action", "detail"];
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))]));
  width.file = Math.min(width.file, 70);
  width.detail = Math.min(width.detail, 90);
  const line = (r) => cols.map((c) => String(r[c] ?? "").slice(0, width[c]).padEnd(width[c])).join("  ").trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))), cols.map((c) => "-".repeat(width[c])).join("  "), ...rows.map(line)].join("\n");
}

function credentials() {
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY: process.env.VOYAGE_API_KEY };
  const file = join(CHAT_SERVICE, ".env");
  if (Object.values(env).some((v) => !v) && existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
      if (m && m[1] in env && !env[m[1]]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return env;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  if (args.help || !args.paths.length || !args.type) {
    console.log("Usage: node scripts/drafting-packs/upload_precedents.mjs --type \"<document type>\" <file.docx | folder>… [--dry-run] [--recursive] [--no-embeddings] [--by <user uuid>]\nEnv: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY (or chat-service/.env); VOYAGE_MIN_INTERVAL_MS=21000 on Voyage's free tier.");
    process.exit(args.help ? 0 : 2);
  }
  let files;
  try { files = listDocx(args.paths, { recursive: args.recursive }); } catch (err) { console.error(err.message); process.exit(2); }
  if (!files.length) { console.error("No Word files (.docx) there."); process.exit(2); }
  const env = credentials();
  let supabase = null;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createClient } = createRequire(join(CHAT_SERVICE, "package.json"))("@supabase/supabase-js");
    supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  } else if (!args.dryRun) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed to add precedents (or put them in chat-service/.env). --dry-run without them reads the files alone.");
    process.exit(2);
  }
  let rows;
  try {
    rows = await uploadPrecedents({
      supabase, files, type: args.type, dryRun: args.dryRun, embed: args.embed,
      by: args.by ?? process.env.PRECEDENTS_UPLOADED_BY ?? null, voyageKey: env.VOYAGE_API_KEY ?? null, log: (l) => console.error(l),
    });
  } catch (err) { console.error(err.message); process.exit(2); }
  console.log(`${args.dryRun ? "DRY RUN — nothing written" : "UPLOAD"}${supabase ? "" : " (offline: database not read)"}\n`);
  console.log(table(rows));
  const refused = rows.filter((r) => r.action === "refused").length;
  console.log(`\n${rows.length} file${rows.length === 1 ? "" : "s"}: ${["added", "would add", "already in library", "refused"].map((a) => [a, rows.filter((r) => r.action === a).length]).filter(([, n]) => n).map(([a, n]) => `${n} ${a}`).join(", ")}.`);
  process.exit(refused ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err?.stack ?? err); process.exit(1); });
}
