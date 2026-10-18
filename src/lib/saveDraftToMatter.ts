import { supabase } from "@/integrations/supabase/client";
import { sanitizeStorageFilename } from "@/lib/utils";
import { plainSaveError } from "@/lib/documentSaveRules";

export { plainSaveError };

// A failed save, worded for the lawyer. The database's own error stays on
// `cause` (and its code on `code`) for anyone who needs to tell cases apart.
function saveError(raw: unknown): Error {
  const code = (raw as { code?: unknown } | null)?.code;
  return Object.assign(new Error(plainSaveError(raw)), { cause: raw }, code !== undefined ? { code } : {});
}

interface SaveDraftInput {
  matterId: string;
  documentTypeId: string | null;
  documentTypeName: string;
  blob: Blob;
  // An explicit existing target; omitting it always creates a new document.
  matterDocumentId?: string;
  title?: string;
  expectedVersionId?: string | null;
  isAiGenerated?: boolean;
  extension?: string;
  // Return as soon as the version is saved and leave reading it for search to
  // the caller, so a plain upload can show the new version straight away.
  skipIndex?: boolean;
  // What the stored file is named after, when that differs from the title:
  // a bulk upload titles the document "USP Memorandum" but keeps the firm's
  // full file name ("KPT5.7 - USP Memorandum [For Boss Review]...") on the file.
  fileStem?: string;
}

// The file-name stem a saved version is stored under (the database adds
// "-v<n>.<ext>"). Exported so a bulk upload can recognise a file already saved.
export function storageStem(text: string): string {
  return sanitizeStorageFilename(text.replace(/[^\w\s-]+/g, " ").trim().replace(/[\s-]+/g, "-")).slice(0, 180) || "Document";
}

// The file types the index worker reads (chat-service/indexing/extract.js and
// index_supported_extension() in 20261017090000_indexing_pipeline.sql).
export const SEARCHABLE_EXTENSIONS = ["pdf", "docx", "xlsx", "xls", "pptx", "txt", "md", "csv"];

// Uploads use a unique path, then the database atomically checks the base
// version and allocates a number. Indexing failure must not undo a saved file.
// `indexed` is true once the file is searchable or queued for the server's
// index worker (`queued`); reading it no longer happens inside this request.
export async function saveDraftToMatter({ matterId, documentTypeId, documentTypeName, blob, matterDocumentId, title, expectedVersionId, isAiGenerated = true, extension = "docx", skipIndex = false, fileStem }: SaveDraftInput) {
  const docId = matterDocumentId ?? crypto.randomUUID();
  const stem = storageStem(fileStem ?? title ?? documentTypeName);
  const storagePath = `${matterId}/${docId}/${crypto.randomUUID()}-${stem}.${extension}`;
  const { error: uploadError } = await supabase.storage.from("matter-documents").upload(storagePath, blob, { contentType: blob.type || "application/octet-stream" });
  if (uploadError) throw saveError(uploadError);
  const args = {
    p_matter_id: matterId, p_document_type_id: documentTypeId, p_document_id: docId,
    p_create_new: !matterDocumentId, p_expected_version_id: expectedVersionId ?? null,
    p_title: title ?? `${documentTypeName} (AI draft)`, p_storage_path: storagePath, p_file_stem: stem, p_is_ai_generated: isAiGenerated, p_extension: extension,
  };
  let { data, error } = await supabase.rpc("save_document_version", args);
  if (error && !error.code) ({ data, error } = await supabase.rpc("save_document_version", args));
  if (error) {
    // Retain the staged upload: a lost response may follow a committed transaction.
    throw saveError(error);
  }
  const result = data as { matterDocumentId: string; versionId: string; versionNumber: number; fileName: string };
  if (!SEARCHABLE_EXTENSIONS.includes(extension.toLowerCase())) {
    await supabase.from("document_versions").update({ indexing_status: "unsupported" }).eq("id", result.versionId);
    return { ...result, storagePath, indexed: false, queued: false, unsupported: true };
  }
  if (skipIndex) return { ...result, storagePath, indexed: false, queued: false, unsupported: false };
  // Saving the version queued it for the index worker (a trigger on
  // document_versions). Confirming the job is enough: the file is read on the
  // server, and if that fails the project page shows why and offers Try again.
  const queued = await requestIndexing(result.versionId).catch(() => "error" as const);
  if (queued === "queued") return { ...result, storagePath, indexed: true, queued: true, unsupported: false };
  if (queued === "unsupported") return { ...result, storagePath, indexed: false, queued: false, unsupported: true };
  // The queue exists but could not be confirmed (a dropped connection): the
  // trigger has queued the file already, so do not read it a second way.
  if (queued === "error") return { ...result, storagePath, indexed: false, queued: false, unsupported: false };
  const indexed = await indexViaEdgeFunction({ versionId: result.versionId, matterId, documentTypeId, storagePath, fileName: result.fileName, fileType: blob.type }).catch(() => false);
  return { ...result, storagePath, indexed, queued: false, unsupported: false };
}

type IndexArgs = { versionId: string; matterId: string; documentTypeId: string | null; storagePath: string; fileName: string; fileType?: string };

// PostgREST's answer when a function is not in the schema (the indexing
// migration has not been applied yet).
function isMissingFunction(error: { code?: string; message?: string } | null) {
  return !!error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? ""));
}

/**
 * Asks the index worker to (re)read a saved version: "Try again", or a file
 * saved before the queue existed. A job already waiting or running is left
 * alone. "missing" means the queue is not installed yet; use the old path.
 */
export async function requestIndexing(versionId: string): Promise<"queued" | "unsupported" | "missing"> {
  // Not in the generated types until the migration is applied.
  const rpc = supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: { state?: string } | null; error: { code?: string; message?: string } | null }>;
  const { data, error } = await rpc("enqueue_index_job", { p_version_id: versionId });
  if (isMissingFunction(error)) return "missing";
  if (error) throw error;
  return data?.state === "unsupported" ? "unsupported" : "queued";
}

const WAIT_POLL_MS = 3_000;
const WAIT_LIMIT_MS = 150_000;

/**
 * Reads a saved version for search and says whether it is searchable.
 * With the index worker: queue it, then wait (up to about two and a half
 * minutes, as the old in-request path took) for the server's answer. A long
 * scanned PDF can take longer; it is still being read, and the project page
 * shows its progress. Without the worker: the old process-document call.
 */
export async function indexStoredVersion(args: IndexArgs, { wait = true }: { wait?: boolean } = {}) {
  const queued = await requestIndexing(args.versionId).catch(() => "missing" as const);
  if (queued === "missing") return indexViaEdgeFunction(args);
  if (queued === "unsupported" || !wait) return false;
  const until = Date.now() + WAIT_LIMIT_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    const { data } = await supabase.from("document_versions").select("indexing_status").eq("id", args.versionId).maybeSingle();
    if (data?.indexing_status === "indexed") return true;
    if (data?.indexing_status === "failed" || !data) return false;
  }
  return false;
}

/** The pre-queue path: the process-document edge function, inside this request. */
export async function indexViaEdgeFunction({ versionId, matterId, documentTypeId, storagePath, fileName, fileType }: IndexArgs) {
  const { data: processData, error: processError } = await supabase.functions.invoke("process-document", {
    body: { filePath: storagePath, fileName, fileType, bucket: "matter-documents", matterId, documentTypeId, isPrecedent: false },
  });
  // A response can be lost after indexing completed; preserve the server's result.
  const { data: state } = await supabase.from("document_versions").select("indexing_status").eq("id", versionId).maybeSingle();
  const indexed = (!processError && processData?.success === true) || state?.indexing_status === "indexed";
  const { error } = await supabase.from("document_versions").update({ indexing_status: indexed ? "indexed" : "failed" }).eq("id", versionId);
  return indexed && !error;
}
