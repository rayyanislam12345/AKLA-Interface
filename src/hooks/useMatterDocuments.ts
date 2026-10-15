import { saveDraftToMatter } from "@/lib/saveDraftToMatter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Enums } from "@/integrations/supabase/types";

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
          "*, document_type:document_types(name), versions:document_versions(id, version_number, created_at, storage_path, file_name, label, is_ai_generated, uploaded_by, indexing_status)"
        )
        .eq("matter_id", matterId!)
        .order("created_at", { ascending: false })
        .order("version_number", { ascending: false, foreignTable: "document_versions" });
      if (error) throw error;
      return data;
    },
    // While any version is still being read for search (by this browser or a
    // colleague's), check every 15 seconds so its badge moves on by itself.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((d) =>
        (d.versions ?? []).some((v) => v.indexing_status === "pending" && Date.now() - new Date(v.created_at).getTime() < 10 * 60 * 1000))
        ? 15_000
        : false,
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
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
    },
  });
}

// Rename a document or change its type. A document created without a type
// can be given one later (or have it cleared), without re-uploading anything.
export function useUpdateMatterDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterDocumentId, matterId, title, documentTypeId }: {
      matterDocumentId: string; matterId: string; title?: string; documentTypeId?: string | null;
    }) => {
      const patch: { title?: string; document_type_id?: string | null } = {};
      if (title !== undefined) patch.title = title.trim();
      if (documentTypeId !== undefined) patch.document_type_id = documentTypeId;
      const { error } = await supabase.from("matter_documents").update(patch).eq("id", matterDocumentId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
    },
  });
}

// A plain upload adds the next version of the document. It reads the
// document's stored type (null included) and its latest version just before
// saving, so a type changed a moment ago, or a version a colleague added
// since the page loaded, does not make the save fail with a message about
// editing. Reading the file for search is left to the caller (the version
// shows as "Reading…" meanwhile); the result says whether the file type can
// be searched at all.
export function useUploadDocumentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, matterDocumentId, documentTypeId, file, expectedVersionId }: {
      matterId: string; matterDocumentId: string; documentTypeId: string | null; file: File; expectedVersionId: string | null;
    }) => {
      const [{ data: stored }, { data: latest }] = await Promise.all([
        supabase.from("matter_documents").select("document_type_id").eq("id", matterDocumentId).maybeSingle(),
        supabase.from("document_versions").select("id").eq("matter_document_id", matterDocumentId)
          .order("version_number", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const extension = file.name.split(".").pop()?.toLowerCase() || "bin";
      const result = await saveDraftToMatter({ matterId, matterDocumentId,
        documentTypeId: stored ? stored.document_type_id : documentTypeId, documentTypeName: file.name,
        title: file.name.replace(/\.[^.]+$/, ""), blob: file,
        expectedVersionId: stored ? (latest?.id ?? null) : expectedVersionId,
        isAiGenerated: false, extension, skipIndex: true });
      return { matterId, matterDocumentId, documentTypeId: stored ? stored.document_type_id : documentTypeId, fileType: file.type, ...result };
    },
    // Awaited, so the real version row is on screen before the
    // "uploading" placeholder goes away.
    onSuccess: async ({ matterId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] }),
        queryClient.invalidateQueries({ queryKey: ["project-search"] }),
      ]);
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

      // The row goes first: the database decides who may remove a document,
      // and a refused delete comes back empty rather than as an error. Files
      // and search passages are only removed once the row is really gone.
      const { data: removed, error: deleteError } = await supabase.from("matter_documents").delete().eq("id", matterDocumentId).select("id");
      if (deleteError) throw deleteError;
      if (!removed?.length) throw new Error("Only an administrator or the person who added this document can remove it.");

      const paths = (versions ?? []).map((v) => v.storage_path);
      if (paths.length > 0) {
        await supabase.storage.from("matter-documents").remove(paths);
        for (const path of paths) {
          await supabase.from("documents").delete().eq("metadata->>storage_path", path);
        }
      }

      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
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
      // Row first, as for a whole document: a refused delete leaves the file.
      const { data: removed, error } = await supabase.from("document_versions").delete().eq("id", versionId).select("id");
      if (error) throw error;
      if (!removed?.length) throw new Error("Only an administrator, the person who uploaded this version, or the document's creator can remove it.");

      await supabase.storage.from("matter-documents").remove([storagePath]);
      await supabase.from("documents").delete().eq("metadata->>storage_path", storagePath);

      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
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
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
    },
  });
}
