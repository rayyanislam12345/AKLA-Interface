import { supabase } from "@/integrations/supabase/client";
import { sanitizeStorageFilename } from "@/lib/utils";

interface SaveDraftInput {
  matterId: string;
  documentTypeId: string;
  documentTypeName: string;
  blob: Blob;
  // Save onto this existing document (as its next version) instead of the
  // first document of the type on the matter.
  matterDocumentId?: string;
  title?: string;
  expectedVersionId?: string;
}

// Saves an AI-produced .docx onto the matter the same way the Documents card
// would: a matter_documents row (found or created), the next document_versions
// row, and process-document so the text is embedded and its statutes detected.
// Extracted from the old Draft tab so the chat's "Save to matter" is the same
// code path.
export async function saveDraftToMatter({ matterId, documentTypeId, documentTypeName, blob, matterDocumentId, title, expectedVersionId }: SaveDraftInput) {
  const docId = matterDocumentId ?? crypto.randomUUID();
  const stem = sanitizeStorageFilename((title ?? documentTypeName).replace(/[^\w\s-]+/g, " ").trim().replace(/[\s-]+/g, "-")) || "Document";
  const storagePath = `${matterId}/${docId}/${crypto.randomUUID()}-${stem}.docx`;
  const { error: uploadError } = await supabase.storage.from("matter-documents").upload(storagePath, blob, { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  if (uploadError) throw uploadError;
  const { data, error } = await supabase.rpc("save_ai_document", {
    p_matter_id: matterId, p_document_type_id: documentTypeId, p_document_id: docId,
    p_create_new: !matterDocumentId, p_expected_version_id: expectedVersionId ?? null,
    p_title: title ?? `${documentTypeName} (AI draft)`, p_storage_path: storagePath, p_file_stem: stem,
  });
  if (error) {
    // Retain the staged upload: a lost response may follow a committed transaction.
    throw error;
  }
  const result = data as { matterDocumentId: string; versionId: string; versionNumber: number; fileName: string };
  const { error: processError } = await supabase.functions.invoke("process-document", {
    body: { filePath: storagePath, fileName: result.fileName, fileType: blob.type, bucket: "matter-documents", matterId, documentTypeId, isPrecedent: false },
  });
  return { ...result, indexed: !processError };
}
