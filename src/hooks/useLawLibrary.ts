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
// act_name is the natural equivalent here.
export function useStatuteSources() {
  return useQuery({
    queryKey: ["statute-sources"],
    queryFn: async (): Promise<StatuteSource[]> => {
      const { data, error } = await supabase
        .from("documents")
        .select("metadata, created_at")
        .eq("is_statute", true)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const byAct = new Map<string, StatuteSource>();
      for (const row of data) {
        const meta = row.metadata as Record<string, any>;
        const actName = meta?.act_name as string | undefined;
        if (!actName) continue;
        const existing = byAct.get(actName);
        if (existing) {
          existing.chunk_count += 1;
        } else {
          byAct.set(actName, {
            act_name: actName,
            source: meta?.source ?? null,
            source_url: meta?.source_url ?? null,
            chunk_count: 1,
            scraped_at: meta?.scraped_at ?? row.created_at,
          });
        }
      }
      return Array.from(byAct.values());
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
