import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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
