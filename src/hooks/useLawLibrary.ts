import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { sanitizeStorageFilename } from "@/lib/utils";

export interface StatuteSource {
  act_name: string;
  source: string | null;
  source_url: string | null;
  chunk_count: number;
  scraped_at: string | null;
}

// Statutes are scraped/ingested by scripts/law_library/ (not uploaded by a
// lawyer through this page), so there's no source file in Storage to key
// off the way usePrecedentLibrary.ts does with storage_path — grouping by
// act_name is the natural equivalent here. Grouped server-side
// (statute_sources() RPC) for the same reason usePrecedentSources() is —
// pulling every chunk row client-side silently truncated at PostgREST's
// default 1000-row response cap once total chunk count grew past it.
export function useStatuteSources() {
  return useQuery({
    queryKey: ["statute-sources"],
    queryFn: async (): Promise<StatuteSource[]> => {
      const { data, error } = await supabase.rpc("statute_sources");
      if (error) throw error;
      return data as StatuteSource[];
    },
  });
}

export function useDeleteStatuteSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (actName: string) => {
      const { error } = await supabase
        .from("documents")
        .delete()
        .eq("is_statute", true)
        .eq("metadata->>act_name", actName);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["statute-sources"] });
    },
  });
}

export type FindLawResult =
  | { status: "available"; actName: string; alreadyInLibrary?: boolean; sourceUrl?: string; via?: string }
  | { status: "not_found"; reason: string };

// Finds an Act on official sources and adds it to the library. Runs on the
// chat server (chat-service /laws/find): the government sites only answer
// through its download relay, and the PDF is checked before it is indexed.
export function useFindLawOnline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ actName }: { actName: string }): Promise<FindLawResult> => {
      const base = (import.meta.env.VITE_CHAT_API_URL as string | undefined)?.replace(/\/$/, "");
      if (!base) throw new Error("Finding laws online needs the chat server (VITE_CHAT_API_URL). Upload the Act instead.");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const resp = await fetch(`${base}/laws/find`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ actName }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body.error ?? `Request failed (${resp.status})`);
      return body as FindLawResult;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["statute-sources"] }),
  });
}

// An Act the associate has as a file goes straight into the library under
// the name they give it — the same path a project's "Needs upload" row uses.
export function useUploadLawToLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ actName, file }: { actName: string; file: File }) => {
      const storagePath = `statutes/${actName.replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}-${sanitizeStorageFilename(file.name)}`;
      const { error: uploadError } = await supabase.storage.from("law-library").upload(storagePath, file);
      if (uploadError) throw uploadError;
      const { error: processError } = await supabase.functions.invoke("process-document", {
        body: { filePath: storagePath, fileName: file.name, fileType: file.type, bucket: "law-library", matterId: null, documentTypeId: null, isStatute: true, isPrecedent: false, actName },
      });
      if (processError) throw processError;
      return actName;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["statute-sources"] }),
  });
}
