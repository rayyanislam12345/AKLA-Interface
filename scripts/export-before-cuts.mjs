#!/usr/bin/env node
// Export before the cuts (docs/site-simplification-2026-10-18.md, row 1).
//
// Reads every row of the tables slated to go and writes each table as a
// JSON file to exports/<date>/ (gitignored) and to the private
// 'admin-exports' bucket (created here if missing, public=false; the
// migration 20261020110000_safety_precondition.sql also creates it and
// gives admins read access). Read-only against the tables: the only writes
// are the local files and the bucket objects.
//
// Credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, read from
// chat-service/.env when that file exists, otherwise from the environment.
//
//   node scripts/export-before-cuts.mjs              export and upload
//   node scripts/export-before-cuts.mjs --no-upload  local files only
//
// Node 20+, ESM. Uses @supabase/supabase-js from the repository root.

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = "admin-exports";
const PAGE = 1000;
const UPLOAD = !process.argv.includes("--no-upload");

// The tables row 1 lists, in the order they appear there. `file` is the
// export name when it differs from the table; `filter` narrows a shared
// table to the rows that are going; `order` is the key the pages walk.
const EXPORTS = [
  { table: "redline_suggestions", order: ["id"] },
  { table: "support_requests", order: ["id"] },
  { table: "matter_law_update_acks", order: ["id"] },
  { table: "matter_notes", order: ["id"] },
  { table: "matter_parties", order: ["id"] },
  { table: "matter_context", order: ["id"] },
  { table: "whatsapp_account_links", order: ["id"] },
  { table: "whatsapp_documents", order: ["id"] },
  { table: "whatsapp_matters", order: ["id"] },
  // The legacy precedent index: the whole-agreement rows in documents that
  // precedent_passages superseded (review rows 29 and "Keep"). Exported
  // with their embeddings so the index can be put back as it was.
  {
    table: "documents",
    file: "legacy_precedent_index",
    filter: (q) => q.eq("is_precedent", true),
    order: ["id"],
  },
  // The word-search chunks behind search_project_content (ProjectSearchPage),
  // the page review row 19 folds away. The review does not name its second
  // legacy index; this is the closest match and is cheap to keep.
  { table: "document_search_chunks", file: "legacy_search_chunks", order: ["source_document_id", "chunk_index"] },
];

async function readEnv() {
  const fromFile = {};
  const envPath = join(ROOT, "chat-service", ".env");
  if (existsSync(envPath)) {
    for (const raw of (await readFile(envPath, "utf8")).split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      fromFile[key] = value;
    }
  }
  const url = fromFile.SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = fromFile.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed, in chat-service/.env or the environment.",
    );
  }
  return { url, key, source: existsSync(envPath) ? "chat-service/.env" : "environment" };
}

async function countRows(db, spec) {
  let q = db.from(spec.table).select("*", { count: "exact", head: true });
  if (spec.filter) q = spec.filter(q);
  const { count, error } = await q;
  if (error) throw new Error(`${spec.table}: count failed: ${error.message}`);
  return count ?? 0;
}

async function readAllRows(db, spec) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from(spec.table).select("*");
    if (spec.filter) q = spec.filter(q);
    for (const col of spec.order) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${spec.table}: read failed at row ${from}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function ensureBucket(db) {
  const { data, error } = await db.storage.getBucket(BUCKET);
  if (data) return "existing";
  if (error && !/not found/i.test(error.message)) {
    throw new Error(`Could not check the ${BUCKET} bucket: ${error.message}`);
  }
  const { error: createError } = await db.storage.createBucket(BUCKET, { public: false });
  if (createError && !/already exists/i.test(createError.message)) {
    throw new Error(`Could not create the ${BUCKET} bucket: ${createError.message}`);
  }
  return createError ? "existing" : "created";
}

async function upload(db, objectPath, body) {
  const { error } = await db.storage
    .from(BUCKET)
    .upload(objectPath, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`upload of ${objectPath} failed: ${error.message}`);
  return `${BUCKET}/${objectPath}`;
}

async function main() {
  const { url, key, source } = await readEnv();
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(ROOT, "exports", date);
  await mkdir(outDir, { recursive: true });
  console.log(`Credentials from ${source}. Writing to ${outDir}${UPLOAD ? ` and ${BUCKET}/${date}/` : " (no upload)"}.`);

  if (UPLOAD) console.log(`Bucket ${BUCKET}: ${await ensureBucket(db)}.`);

  const manifest = { exported_at: new Date().toISOString(), supabase_url: url, bucket: UPLOAD ? BUCKET : null, tables: [] };
  let failed = 0;

  for (const spec of EXPORTS) {
    const name = spec.file ?? spec.table;
    try {
      const expected = await countRows(db, spec);
      const rows = await readAllRows(db, spec);
      if (rows.length !== expected) {
        throw new Error(`read ${rows.length} rows but the table reports ${expected}; rows changed during the export, run it again`);
      }
      const body = JSON.stringify(rows, null, 1);
      const localPath = join(outDir, `${name}.json`);
      await writeFile(localPath, body);
      const entry = {
        name,
        table: spec.table,
        filter: spec.filter ? "is_precedent = true" : null,
        rows: rows.length,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
        local: localPath,
        uploaded: null,
      };
      if (UPLOAD) entry.uploaded = await upload(db, `${date}/${name}.json`, body);
      manifest.tables.push(entry);
      console.log(`${name}: ${rows.length} rows, ${entry.bytes} bytes${entry.uploaded ? `, uploaded` : ""}`);
    } catch (err) {
      failed++;
      manifest.tables.push({ name, table: spec.table, error: err.message });
      console.error(`${name}: FAILED: ${err.message}`);
    }
  }

  const manifestBody = JSON.stringify(manifest, null, 2);
  await writeFile(join(outDir, "manifest.json"), manifestBody);
  if (UPLOAD) await upload(db, `${date}/manifest.json`, manifestBody);

  const ok = manifest.tables.filter((t) => !t.error);
  console.log(`\n${ok.length} of ${EXPORTS.length} exports written, ${ok.reduce((n, t) => n + t.rows, 0)} rows in all.`);
  if (failed) {
    console.error(`${failed} export(s) failed; see manifest.json.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
