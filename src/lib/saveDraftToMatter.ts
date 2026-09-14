import { supabase } from "@/integrations/supabase/client";
import { sanitizeStorageFilename } from "@/lib/utils";

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
}

// Uploads use a unique path, then the database atomically checks the base
// version and allocates a number. Indexing failure must not undo a saved file.
export async function saveDraftToMatter({ matterId, documentTypeId, documentTypeName, blob, matterDocumentId, title, expectedVersionId, isAiGenerated = true, extension = "docx" }: SaveDraftInput) {
  const docId = matterDocumentId ?? crypto.randomUUID();
  const stem = sanitizeStorageFilename((title ?? documentTypeName).replace(/[^\w\s-]+/g, " ").trim().replace(/[\s-]+/g, "-")).slice(0, 180) || "Document";
  const storagePath = `${matterId}/${docId}/${crypto.randomUUID()}-${stem}.${extension}`;
  const { error: uploadError } = await supabase.storage.from("matter-documents").upload(storagePath, blob, { contentType: blob.type || "application/octet-stream" });
  if (uploadError) throw uploadError;
  const args = {
    p_matter_id: matterId, p_document_type_id: documentTypeId, p_document_id: docId,
    p_create_new: !matterDocumentId, p_expected_version_id: expectedVersionId ?? null,
    p_title: title ?? `${documentTypeName} (AI draft)`, p_storage_path: storagePath, p_file_stem: stem, p_is_ai_generated: isAiGenerated, p_extension: extension,
  };
  let { data, error } = await supabase.rpc("save_document_version", args);
  if (error && !error.code) ({ data, error } = await supabase.rpc("save_document_version", args));
  if (error) {
    // Retain the staged upload: a lost response may follow a committed transaction.
    throw error;
  }
  const result = data as { matterDocumentId: string; versionId: string; versionNumber: number; fileName: string };
  if (!["pdf", "docx", "xlsx", "xls", "pptx", "txt"].includes(extension.toLowerCase())) {
    await supabase.from("document_versions").update({ indexing_status: "unsupported" }).eq("id", result.versionId);
    return { ...result, indexed: false };
  }
  const indexed = await indexStoredVersion({ versionId: result.versionId, matterId, documentTypeId, storagePath, fileName: result.fileName, fileType: blob.type }).catch(() => false);
  return { ...result, indexed };
}

export async function indexStoredVersion({ versionId, matterId, documentTypeId, storagePath, fileName, fileType }: {
  versionId: string; matterId: string; documentTypeId: string | null; storagePath: string; fileName: string; fileType?: string;
}) {
  const { data: processData, error: processError } = await supabase.functions.invoke("process-document", {
    body: { filePath: storagePath, fileName, fileType, bucket: "matter-documents", matterId, documentTypeId, isPrecedent: false },
  });
  // A response can be lost after indexing completed; preserve the server's result.
  const { data: state } = await supabase.from("document_versions").select("indexing_status").eq("id", versionId).maybeSingle();
  const indexed = (!processError && processData?.success === true) || state?.indexing_status === "indexed";
  const { error } = await supabase.from("document_versions").update({ indexing_status: indexed ? "indexed" : "failed" }).eq("id", versionId);
  return indexed && !error;
}
