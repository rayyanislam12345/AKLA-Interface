import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Enums } from "@/integrations/supabase/types";
import { sanitizeStorageFilename } from "@/lib/utils";

export type DocumentStatus = Enums<"document_status">;

export interface DocumentType {
  id: string;
  name: string;
  category: string;
}

export function useDocumentTypes() {
  return useQuery({
    queryKey: ["document-types"],
    queryFn: async (): Promise<DocumentType[]> => {
      const { data, error } = await supabase
        .from("document_types")
        .select("id, name, category")
        .order("category")
        .order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; category: string }) => {
      const { error } = await supabase.from("document_types").insert(input);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
    },
  });
}

export function useUpdateDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name, category }: { id: string; name: string; category: string }) => {
      const { error } = await supabase.from("document_types").update({ name, category }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
    },
  });
}

export function useDeleteDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("document_types").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
    },
  });
}

export function useMatterDocuments(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-documents", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_documents")
        .select(
          "*, document_type:document_types(name), versions:document_versions(id, version_number, created_at, storage_path, file_name, label, is_ai_generated, uploaded_by)"
        )
        .eq("matter_id", matterId!)
        .order("created_at", { ascending: false })
        .order("version_number", { ascending: false, foreignTable: "document_versions" });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateMatterDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { matter_id: string; title: string; document_type_id?: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("matter_documents")
        .insert({
          matter_id: input.matter_id,
          title: input.title,
          document_type_id: input.document_type_id || null,
          created_by: userData.user?.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", variables.matter_id] });
    },
  });
}

export function useSetMatterDocumentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      matterDocumentId,
      status,
      matterId,
    }: {
      matterDocumentId: string;
      status: DocumentStatus;
      matterId: string;
    }) => {
      const { error } = await supabase
        .from("matter_documents")
        .update({ status })
        .eq("id", matterDocumentId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
    },
  });
}

export function useUploadDocumentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      matterId,
      matterDocumentId,
      documentTypeId,
      file,
      nextVersionNumber,
    }: {
      matterId: string;
      matterDocumentId: string;
      documentTypeId: string | null;
      file: File;
      nextVersionNumber: number;
    }) => {
      const { data: userData } = await supabase.auth.getUser();
      const storagePath = `${matterId}/${matterDocumentId}/v${nextVersionNumber}-${sanitizeStorageFilename(file.name)}`;

      const { error: uploadError } = await supabase.storage
        .from("matter-documents")
        .upload(storagePath, file);
      if (uploadError) throw uploadError;

      const { error: versionError } = await supabase.from("document_versions").insert({
        matter_document_id: matterDocumentId,
        version_number: nextVersionNumber,
        storage_path: storagePath,
        file_name: file.name,
        is_ai_generated: false,
        uploaded_by: userData.user?.id,
      });
      if (versionError) throw versionError;

      // Extract text + embed for the precedent/matter RAG index. Best-effort:
      // unsupported file types (e.g. plain .txt) or extraction failures shouldn't
      // block the upload itself, since the version is already saved.
      const extension = file.name.toLowerCase().split(".").pop();
      if (["pdf", "docx", "xlsx", "xls"].includes(extension || "")) {
        const { error: processError } = await supabase.functions.invoke("process-document", {
          body: {
            filePath: storagePath,
            fileName: file.name,
            fileType: file.type,
            bucket: "matter-documents",
            matterId,
            documentTypeId,
            isPrecedent: false,
          },
        });
        if (processError) {
          console.error("Document uploaded but RAG ingestion failed:", processError);
        }
      }

      return { matterId, matterDocumentId };
    },
    onSuccess: ({ matterId }) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
    },
  });
}

export function useDeleteMatterDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterDocumentId, matterId }: { matterDocumentId: string; matterId: string }) => {
      const { data: versions, error: versionsError } = await supabase
        .from("document_versions")
        .select("storage_path")
        .eq("matter_document_id", matterDocumentId);
      if (versionsError) throw versionsError;

      const paths = (versions ?? []).map((v) => v.storage_path);
      if (paths.length > 0) {
        await supabase.storage.from("matter-documents").remove(paths);
        for (const path of paths) {
          await supabase.from("documents").delete().eq("metadata->>storage_path", path);
        }
      }

      const { error: deleteError } = await supabase.from("matter_documents").delete().eq("id", matterDocumentId);
      if (deleteError) throw deleteError;

      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
    },
  });
}

export function useDeleteDocumentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      versionId,
      storagePath,
      matterId,
    }: {
      versionId: string;
      storagePath: string;
      matterId: string;
    }) => {
      await supabase.storage.from("matter-documents").remove([storagePath]);
      await supabase.from("documents").delete().eq("metadata->>storage_path", storagePath);

      const { error } = await supabase.from("document_versions").delete().eq("id", versionId);
      if (error) throw error;

      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
    },
  });
}

export function useUpdateVersionLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      versionId,
      label,
      matterId,
    }: {
      versionId: string;
      label: string;
      matterId: string;
    }) => {
      const { error } = await supabase
        .from("document_versions")
        .update({ label: label.trim() || null })
        .eq("id", versionId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
    },
  });
}
