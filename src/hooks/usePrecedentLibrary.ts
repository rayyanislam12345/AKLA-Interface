import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PrecedentSource {
  storage_path: string;
  filename: string;
  document_type_id: string | null;
  document_type_name: string | null;
  chunk_count: number;
  created_at: string;
}

export function usePrecedentSources() {
  return useQuery({
    queryKey: ["precedent-sources"],
    queryFn: async (): Promise<PrecedentSource[]> => {
      const { data, error } = await supabase
        .from("documents")
        .select("metadata, document_type_id, created_at, document_type:document_types(name)")
        .eq("is_precedent", true)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const bySource = new Map<string, PrecedentSource>();
      for (const row of data) {
        const meta = row.metadata as Record<string, any>;
        const path = meta?.storage_path as string | undefined;
        if (!path) continue;
        const existing = bySource.get(path);
        if (existing) {
          existing.chunk_count += 1;
        } else {
          bySource.set(path, {
            storage_path: path,
            filename: meta?.filename ?? path.split("/").pop() ?? path,
            document_type_id: row.document_type_id,
            document_type_name: (row as any).document_type?.name ?? null,
            chunk_count: 1,
            created_at: row.created_at,
          });
        }
      }
      return Array.from(bySource.values());
    },
  });
}

export function useUploadPrecedentDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, documentTypeId }: { file: File; documentTypeId: string }) => {
      const storagePath = `precedent/${documentTypeId}/${Date.now()}-${file.name}`;

      const { error: uploadError } = await supabase.storage
        .from("precedent-library")
        .upload(storagePath, file);
      if (uploadError) throw uploadError;

      const { error: processError } = await supabase.functions.invoke("process-document", {
        body: {
          filePath: storagePath,
          fileName: file.name,
          fileType: file.type,
          bucket: "precedent-library",
          matterId: null,
          documentTypeId,
          isPrecedent: true,
        },
      });
      if (processError) throw processError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["precedent-sources"] });
    },
  });
}

export function useDeletePrecedentSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (storagePath: string) => {
      await supabase.storage.from("precedent-library").remove([storagePath]);
      const { error } = await supabase
        .from("documents")
        .delete()
        .eq("metadata->>storage_path", storagePath);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["precedent-sources"] });
    },
  });
}
