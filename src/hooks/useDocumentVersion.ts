import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { PreviewVersion } from "@/components/documents/previewVersions";

// One stored version by id, with the document it belongs to, that
// document's other versions and the project's name: everything the AI
// workspace's document window and full-page view need from one address.

export interface DocumentVersionDetail {
  version: PreviewVersion & { matter_document_id: string; indexing_status: string; is_ai_generated: boolean };
  document: { id: string; title: string; matter_id: string; document_type_id: string | null };
  matter: { id: string; name: string } | null;
  /** Every version of the document, newest first. */
  versions: PreviewVersion[];
}

const SELECT =
  "id, version_number, storage_path, file_name, label, created_at, matter_document_id, indexing_status, is_ai_generated, " +
  "document:matter_documents(id, title, matter_id, document_type_id, matter:matters(id, name), versions:document_versions(id, version_number, storage_path, file_name, label, created_at))";

type Row = {
  id: string;
  version_number: number;
  storage_path: string;
  file_name: string | null;
  label: string | null;
  created_at: string;
  matter_document_id: string;
  indexing_status: string;
  is_ai_generated: boolean;
  document: {
    id: string;
    title: string;
    matter_id: string;
    document_type_id: string | null;
    matter: { id: string; name: string } | null;
    versions: PreviewVersion[] | null;
  } | null;
};

export function useDocumentVersion(versionId: string | undefined) {
  return useQuery({
    queryKey: ["document-version", versionId],
    enabled: !!versionId,
    queryFn: async (): Promise<DocumentVersionDetail | null> => {
      // maybeSingle: a deleted version, or one this user cannot see, is a
      // normal outcome the page says so about, not an error to retry.
      const { data, error } = await supabase.from("document_versions").select(SELECT).eq("id", versionId!).maybeSingle();
      if (error) throw error;
      const row = data as unknown as Row | null;
      if (!row || !row.document) return null;
      const { document, ...version } = row;
      return {
        version,
        document: { id: document.id, title: document.title, matter_id: document.matter_id, document_type_id: document.document_type_id },
        matter: document.matter,
        versions: [...(document.versions ?? [])].sort((a, b) => b.version_number - a.version_number),
      };
    },
  });
}

/** The attachment a chat is handed for this version. */
export function attachmentOf(detail: DocumentVersionDetail) {
  return {
    bucket: "matter-documents",
    path: detail.version.storage_path,
    name: detail.version.file_name || `${detail.document.title} v${detail.version.version_number}`,
    matterDocumentId: detail.document.id,
    versionId: detail.version.id,
  };
}

/** The version as the Edit flow wants it. */
export function editTargetOf(detail: DocumentVersionDetail) {
  return {
    matterDocumentId: detail.document.id,
    documentTypeId: detail.document.document_type_id,
    title: detail.document.title,
    versionId: detail.version.id,
    versionNumber: detail.version.version_number,
    fileName: detail.version.file_name || `${detail.document.title} v${detail.version.version_number}`,
    storagePath: detail.version.storage_path,
  };
}
