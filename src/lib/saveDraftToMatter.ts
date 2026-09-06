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
}

// Saves an AI-produced .docx onto the matter the same way the Documents card
// would: a matter_documents row (found or created), the next document_versions
// row, and process-document so the text is embedded and its statutes detected.
// Extracted from the old Draft tab so the chat's "Save to matter" is the same
// code path.
export async function saveDraftToMatter({ matterId, documentTypeId, documentTypeName, blob, matterDocumentId, title }: SaveDraftInput) {
  const { data: userData } = await supabase.auth.getUser();

  let docId = matterDocumentId;
  if (!docId) {
    const { data: existing } = await supabase
      .from("matter_documents")
      .select("id")
      .eq("matter_id", matterId)
      .eq("document_type_id", documentTypeId)
      .limit(1)
      .maybeSingle();
    docId = existing?.id;
  }
  if (!docId) {
    const { data: created, error: createError } = await supabase
      .from("matter_documents")
      .insert({
        matter_id: matterId,
        document_type_id: documentTypeId,
        title: title ?? `${documentTypeName} (AI draft)`,
        status: "drafting",
        created_by: userData.user?.id,
      })
      .select("id")
      .single();
    if (createError) throw createError;
    docId = created.id;
  }

  const { count } = await supabase
    .from("document_versions")
    .select("id", { count: "exact", head: true })
    .eq("matter_document_id", docId);
  const nextVersion = (count ?? 0) + 1;

  // Plain ASCII words joined by hyphens — an em dash or a curly quote in a
  // title otherwise ends up in the file name the lawyer downloads.
  const stem = (title ?? documentTypeName).replace(/[^\w\s-]+/g, " ").trim().replace(/[\s-]+/g, "-") || documentTypeName.replace(/\s+/g, "-");
  const fileName = `${stem}-v${nextVersion}.docx`;
  const storagePath = `${matterId}/${docId}/v${nextVersion}-${sanitizeStorageFilename(fileName)}`;

  const { error: uploadError } = await supabase.storage.from("matter-documents").upload(storagePath, blob, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  if (uploadError) throw uploadError;

  const { error: versionError } = await supabase.from("document_versions").insert({
    matter_document_id: docId,
    version_number: nextVersion,
    storage_path: storagePath,
    file_name: fileName,
    is_ai_generated: true,
    uploaded_by: userData.user?.id,
  });
  if (versionError) throw versionError;

  const { error: processError } = await supabase.functions.invoke("process-document", {
    body: { filePath: storagePath, fileName, fileType: blob.type, bucket: "matter-documents", matterId, documentTypeId, isPrecedent: false },
  });
  if (processError) console.error("Draft saved but RAG ingestion failed:", processError);

  return { matterDocumentId: docId, versionNumber: nextVersion, fileName };
}
