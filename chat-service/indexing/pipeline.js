// One index job, start to finish:
//   load the version and its project -> download the file -> read it
//   (extract.js) -> passages (chunk.js) -> embeddings (embed.js) -> insert the
//   passages under this run's id -> card (card.js) -> publish_index_run, which
//   swaps the old passages for the new ones in one transaction.
// Any failure goes to fail_index_job with a sentence a lawyer can act on;
// passages half-written by this run are removed there.
import { buildCard } from "./card.js";
import { chunkDocument, contextualHeader, embeddingInput, textHash } from "./chunk.js";
import { embedDocuments } from "./embed.js";
import { extensionOf, extractForIndex, PermanentError, StopRequested } from "./extract.js";

const MAX_FILE_BYTES = Number(process.env.INDEX_MAX_FILE_MB ?? 150) * 1024 * 1024;
const INSERT_BATCH = 50;

/** The sentence stored on the version when reading fails for good. */
export function plainError(err) {
  if (err?.permanent) return err.message;
  if (err?.missingTool) return "The server that reads files is missing a tool it needs. The team has been told; try again later.";
  if (err?.name === "HttpError" && /voyage/i.test(err.message)) return "The search service did not respond. It will be tried again automatically.";
  return "Something went wrong while reading this file. It will be tried again automatically.";
}

const FORMAT_NAMES = { pdf: "pdf", docx: "docx", xlsx: "excel", xls: "excel", pptx: "pptx", txt: "txt", md: "md", csv: "csv" };

async function loadVersion(db, versionId) {
  const { data, error } = await db
    .from("document_versions")
    .select("id, version_number, storage_path, file_name, is_ai_generated, uploaded_by, created_at, matter_document_id, matter_document:matter_documents(id, title, matter_id, document_type_id, document_type:document_types(name), matter:matters(name))")
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function download(db, bucket, path) {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) {
    const status = error?.statusCode ?? error?.status;
    if (String(status) === "404" || /not found|does not exist/i.test(error?.message ?? "")) {
      throw new PermanentError("The file is missing from storage. Upload it again.");
    }
    throw new Error(`Download failed: ${error?.message ?? "no data"}`);
  }
  if (data.size > MAX_FILE_BYTES) {
    throw new PermanentError(`The file is ${Math.round(data.size / 1024 / 1024)} MB, over the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB the reader takes. Split it into smaller files.`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

// Statutes the card found: add them to the project's Relevant Laws, as the
// old upload path did (process-document's detectRelevantLaws). Best effort.
async function noteRelevantLaws(db, matterId, names, log) {
  for (const name of names ?? []) {
    try {
      const { data: match } = await db.from("documents").select("metadata").eq("is_statute", true).ilike("metadata->>act_name", name).limit(1);
      const found = Array.isArray(match) && match.length > 0;
      const actName = found ? match[0].metadata?.act_name ?? name : name;
      await db.from("matter_relevant_laws").upsert(
        { matter_id: matterId, act_name: actName, status: found ? "available" : "needs_upload", source: "auto_detected" },
        { onConflict: "matter_id,act_name", ignoreDuplicates: true },
      );
    } catch (err) {
      log(`relevant law "${name}" not recorded: ${err?.message ?? err}`);
    }
  }
}

/**
 * @param {object} job a document_index_jobs row (state running, with run_id)
 * @param {{ db: any, voyageKey: string, anthropicKey?: string, log: (m: string) => void, checkStop: () => void, heartbeat: () => Promise<void> }} ctx
 * @returns {Promise<{ passages: number, pages: number|null, ocrPages: number, format: string, fileName: string }>}
 */
export async function processJob(job, ctx) {
  const { db, log, checkStop, heartbeat } = ctx;
  if (job.kind !== "project" || !job.document_version_id) {
    throw new PermanentError("Library files are not read by this worker yet.");
  }
  const version = await loadVersion(db, job.document_version_id);
  if (!version) throw new StopRequested("the version was deleted");
  const doc = version.matter_document ?? {};
  const fileName = version.file_name ?? job.storage_path.split("/").pop();
  const ext = extensionOf(job.storage_path) || extensionOf(fileName);

  checkStop();
  const bytes = await download(db, job.bucket, job.storage_path);
  await heartbeat();

  checkStop();
  const read = await extractForIndex(bytes, `file.${ext}`, {
    checkStop,
    onProgress: () => heartbeat(),
  });
  await heartbeat();

  const { text, chunks, outline } = chunkDocument(read.blocks, { mode: read.mode });
  if (!chunks.length || text.replace(/\s+/g, "").length < 20) {
    throw new PermanentError(read.format === "pdf" ? "No readable text, even after OCR." : "No readable text was found in this file.");
  }

  const header = {
    title: doc.title ?? fileName,
    versionNumber: version.version_number,
    typeName: doc.document_type?.name ?? null,
    projectName: doc.matter?.name ?? null,
  };
  const inputs = chunks.map((c) => embeddingInput(contextualHeader({ ...header, headingPath: c.headingPath, page: c.page }), c.content));
  checkStop();
  const vectors = await embedDocuments(inputs, { apiKey: ctx.voyageKey, log, checkStop });
  await heartbeat();

  const baseMetadata = {
    filename: fileName,
    file_type: null,
    upload_date: version.created_at,
    storage_path: job.storage_path,
    storage_bucket: job.bucket,
    file_size: bytes.byteLength,
    original_format: FORMAT_NAMES[ext] ?? ext,
    extractor: read.extractor,
    ...(read.pageCount ? { page_count: read.pageCount } : {}),
    ...(read.ocrPages?.length ? { ocr: true } : {}),
  };
  const rows = chunks.map((c, i) => ({
    content: c.content,
    embedding: vectors[i],
    metadata: {
      ...baseMetadata,
      chunk_index: c.index,
      chunk_total: chunks.length,
      heading_path: c.headingPath,
      page: c.page,
      page_end: c.pageEnd,
      ...(read.ocrPages?.includes(c.page) ? { ocr_page: true } : {}),
    },
    matter_id: doc.matter_id ?? null,
    document_type_id: doc.document_type_id ?? null,
    is_precedent: false,
    is_statute: false,
    created_by: version.uploaded_by ?? null,
    document_version_id: version.id,
    matter_document_id: version.matter_document_id,
    version_number: version.version_number,
    ingest_run_id: job.run_id,
    is_ai_generated: version.is_ai_generated ?? false,
    heading_path: c.headingPath,
    page: c.page,
    char_start: c.start,
    char_end: c.end,
    text_hash: textHash(c.content),
  }));
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    checkStop();
    const { error } = await db.from("documents").insert(rows.slice(i, i + INSERT_BATCH));
    if (error) throw new Error(`Saving passages failed: ${error.message}`);
  }
  await heartbeat();

  // The card: best effort, never fails the job.
  let documentTypes = [];
  try {
    const { data } = await db.from("document_types").select("id, name, category").order("name");
    documentTypes = data ?? [];
  } catch { /* the card goes without a type suggestion */ }
  const card = await buildCard({
    apiKey: ctx.anthropicKey,
    log,
    title: doc.title,
    fileName,
    text,
    outline,
    documentTypes,
    side: read.side,
    pageCount: read.pageCount,
    facts: {
      has_tracked_changes: read.hasTrackedChanges ?? false,
      tracked_change_count: read.revisionCount ?? 0,
      page_count: read.pageCount ?? null,
      pages_read: read.pagesRead ?? null,
      pages_not_read: read.truncatedPages || 0,
      ocr_pages: read.ocrPages ?? [],
      passages: chunks.length,
      characters: text.length,
      outline: outline.slice(0, 200).map((o) => ({ depth: o.depth, entry: o.entry, ...(o.page ? { page: o.page } : {}) })),
      reader: read.extractor,
    },
  });

  checkStop();
  const { error: publishError } = await db.rpc("publish_index_run", {
    p_job_id: job.id,
    p_run_id: job.run_id,
    p_page_count: read.pageCount ?? null,
    p_card: card,
  });
  if (publishError) throw new Error(`Publishing failed: ${publishError.message}`);

  if (doc.matter_id && card.statutes_mentioned?.length) {
    await noteRelevantLaws(db, doc.matter_id, card.statutes_mentioned, log);
  }
  return { passages: chunks.length, pages: read.pageCount ?? null, ocrPages: read.ocrPages?.length ?? 0, format: read.format, fileName };
}
