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

// What the indexing function said went wrong, in its own words where it gave
// any, rather than "Edge Function returned a non-2xx status code".
async function describeFunctionError(err: unknown): Promise<string> {
  const context = (err as { context?: Response } | null)?.context;
  if (context && typeof context.json === "function") {
    const body = await context.clone().json().catch(() => null);
    const said = body?.error ?? body?.message;
    if (typeof said === "string" && said.trim()) return `The file couldn't be read: ${said}`;
  }
  const message = (err as { message?: string } | null)?.message ?? "";
  if (/timed? ?out|504|546/i.test(message)) return "The file took too long to read. Large scanned PDFs often do; try a smaller or text-based copy.";
  return "The file couldn't be read. It may be scanned, damaged or too large.";
}

export function useUploadPrecedentDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, documentTypeId }: { file: File; documentTypeId: string }) => {
      const storagePath = `precedent/${documentTypeId}/${Date.now()}-${sanitizeStorageFilename(file.name)}`;

      const { error: uploadError } = await supabase.storage
        .from("precedent-library")
        .upload(storagePath, file);
      if (uploadError) throw new Error(`Couldn't upload the file: ${uploadError.message}`);

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
      if (processError) {
        // Leave nothing half-done behind: the stored copy and any passages
        // indexed before the failure go, so "Retry" starts clean instead of
        // adding a second copy.
        const reason = await describeFunctionError(processError);
        await supabase.from("documents").delete().eq("is_precedent", true).eq("metadata->>storage_path", storagePath);
        await supabase.storage.from("precedent-library").remove([storagePath]);
        throw new Error(reason);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["precedent-sources"] });
    },
  });
}

/** A file's SHA-256, hex — to spot the same file twice in one batch. */
export async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The key two copies of the same file share: its name (case aside) and exact size in bytes. */
export function libraryFileKey(name: string, size: number | string): string {
  return `${name.trim().toLowerCase()}|${size}`;
}

// The library stores no content hash, so a file already in it is recognised
// by name and exact size (recorded on every passage when it was indexed).
export async function fetchLibraryFileKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("documents")
      .select("metadata")
      .eq("is_precedent", true)
      .eq("metadata->>chunk_index", "0")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as { filename?: unknown; file_size?: unknown };
      if (typeof meta.filename === "string" && meta.file_size != null) keys.add(libraryFileKey(meta.filename, String(meta.file_size)));
    }
    if (rows.length < pageSize) return keys;
  }
}

export function useDeletePrecedentSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (storagePath: string) => {
      // The row first: the database lets only an administrator delete a
      // library row and says nothing when it refuses, so an empty answer
      // means nothing was removed and the file is left where it is.
      const { data, error } = await supabase
        .from("documents")
        .delete()
        .eq("metadata->>storage_path", storagePath)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("Only an administrator can remove a file from the library.");
      await supabase.storage.from("precedent-library").remove([storagePath]);
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
      if (!base) throw new Error("Clause search isn't available right now. Ask an administrator to check the AI service.");
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
