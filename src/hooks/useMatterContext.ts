import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useMatterContext(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-context", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_context")
        .select("content, updated_at, updated_by:profiles(full_name)")
        .eq("matter_id", matterId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useUpsertMatterContext() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, content }: { matterId: string; content: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from("matter_context").upsert(
        {
          matter_id: matterId,
          content,
          updated_by: userData.user?.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "matter_id" }
      );
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-context", variables.matterId] });
    },
  });
}
