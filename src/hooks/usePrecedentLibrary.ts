import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { sanitizeStorageFilename } from "@/lib/utils";

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
      const storagePath = `precedent/${documentTypeId}/${Date.now()}-${sanitizeStorageFilename(file.name)}`;

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

export interface PrecedentExcerpt { text: string; score: number; terms: string[]; chunkIndex: number | null; offset: number }
export interface PrecedentHit { storagePath: string | null; filename: string; documentTypeId: string | null; documentTypeName: string | null; excerpts: PrecedentExcerpt[]; score: number }
export interface PrecedentSearchResult { query: string; terms: string[]; results: PrecedentHit[] }

// Clause search across the library, on the chat server: the best passages
// per agreement, ranked by meaning and by the words used.
export function usePrecedentSearch(query: string, documentTypeId: string | null) {
  return useQuery({
    queryKey: ["precedent-search", query, documentTypeId],
    enabled: query.trim().length >= 2,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }): Promise<PrecedentSearchResult> => {
      const base = (import.meta.env.VITE_CHAT_API_URL as string | undefined)?.replace(/\/$/, "");
      if (!base) throw new Error("Precedent search needs the chat server (VITE_CHAT_API_URL).");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const resp = await fetch(`${base}/precedents/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), documentTypeId }),
        signal,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body.error ?? `Search failed (${resp.status})`);
      return body as PrecedentSearchResult;
    },
  });
}

/** A precedent's extracted text, its chunks in order — for viewing a file that is not a Word document. */
export async function fetchPrecedentText(storagePath: string): Promise<string> {
  const { data, error } = await supabase.from("documents").select("content, metadata").eq("is_precedent", true).eq("metadata->>storage_path", storagePath).limit(500);
  if (error) throw error;
  return (data ?? [])
    .sort((a, b) => (Number((a.metadata as any)?.chunk_index) || 0) - (Number((b.metadata as any)?.chunk_index) || 0))
    .map((r) => r.content)
    .join("\n\n");
}
