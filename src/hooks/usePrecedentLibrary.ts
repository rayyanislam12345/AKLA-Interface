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

// Grouped server-side (precedent_sources() RPC) rather than pulling every
// chunk row and deduping client-side — that approach silently truncated at
// PostgREST's default 1000-row response cap once total chunk count grew
// past it, which (ordered by created_at desc) could crowd whole documents
// out of the list behind a handful of large recently-ingested ones.
export function usePrecedentSources() {
  return useQuery({
    queryKey: ["precedent-sources"],
    queryFn: async (): Promise<PrecedentSource[]> => {
      const { data, error } = await supabase.rpc("precedent_sources");
      if (error) throw error;
      return data as PrecedentSource[];
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
